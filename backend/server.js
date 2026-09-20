import express from 'express';
import cors from 'cors';
import TorrentSearchApi from 'torrent-search-api';
import WebTorrent from 'webtorrent';

const app = express();
const port = process.env.PORT || 3001;
const client = new WebTorrent();

app.use(cors());
app.use(express.json());

// Enable working public providers
TorrentSearchApi.disableAllProviders();
TorrentSearchApi.enableProvider('ThePirateBay');
TorrentSearchApi.enableProvider('Limetorrents');
TorrentSearchApi.enableProvider('TorrentProject');

// Search endpoint
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'Search query is required' });
  }

  try {
    const torrents = await TorrentSearchApi.search(query, 'All', 30);
    // Sort by seeds descending
    const sorted = (torrents || []).sort((a, b) => (parseInt(b.seeds) || 0) - (parseInt(a.seeds) || 0));
    res.json(sorted);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Failed to search torrents' });
  }
});

// Resolve Magnet endpoint
app.get('/api/magnet', async (req, res) => {
  const { provider, desc, link, magnet } = req.query;

  if (magnet) {
    return res.json({ magnet });
  }

  if (!provider) {
    return res.status(400).json({ error: 'Provider is required to resolve magnet' });
  }

  try {
    const resolvedMagnet = await TorrentSearchApi.getMagnet({ provider, desc, link });
    if (!resolvedMagnet) {
      return res.status(404).json({ error: 'Magnet link could not be found' });
    }
    res.json({ magnet: resolvedMagnet });
  } catch (err) {
    console.error('Magnet resolution error:', err);
    res.status(500).json({ error: 'Failed to resolve magnet: ' + err.message });
  }
});

// Stream / Direct download endpoint
app.get('/api/stream', async (req, res) => {
  let magnetURI = req.query.magnet;
  const { provider, desc, link } = req.query;

  if (!magnetURI && provider && (desc || link)) {
    try {
      magnetURI = await TorrentSearchApi.getMagnet({ provider, desc, link });
    } catch (err) {
      console.error('Stream getMagnet error:', err);
      return res.status(400).send('Could not fetch magnet URI: ' + err.message);
    }
  }

  if (!magnetURI) {
    return res.status(400).send('Magnet URI or provider/desc parameters required');
  }

  // Check if torrent already exists in client
  let torrent = await client.get(magnetURI);

  if (!torrent) {
    try {
      torrent = client.add(magnetURI);
    } catch (err) {
      return res.status(500).send('Error adding torrent: ' + err.message);
    }

    torrent.on('error', (err) => {
      console.error('Torrent client error:', err);
      if (!res.headersSent) {
        res.status(500).send('Torrent stream error: ' + err.message);
      }
    });
  }

  // Safety timeout: if swarm doesn't respond within 25 seconds
  const swarmTimeout = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).send(
        'Swarm timeout: No active peers found to stream directly in the browser. Please use the "Magnet" button to download using your desktop client.'
      );
    }
  }, 25000);

  if (torrent.ready) {
    streamFile();
  } else {
    torrent.once('ready', streamFile);
  }

  function getMimeType(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const mimeTypes = {
      mp4: 'video/mp4',
      m4v: 'video/mp4',
      mkv: 'video/x-matroska',
      webm: 'video/webm',
      avi: 'video/x-msvideo',
      mov: 'video/quicktime',
      mp3: 'audio/mpeg',
      flac: 'audio/flac',
      wav: 'audio/wav',
      iso: 'application/x-iso9660-image',
      zip: 'application/zip',
      tar: 'application/x-tar',
      gz: 'application/gzip',
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  function streamFile() {
    clearTimeout(swarmTimeout);
    if (res.headersSent) return;

    if (!torrent.files || torrent.files.length === 0) {
      return res.status(404).send('No files found in torrent');
    }

    // Find the largest file (typically the primary movie, ISO, or archive)
    const file = torrent.files.reduce((a, b) => (a.length > b.length ? a : b));
    const mimeType = getMimeType(file.name);

    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : file.length - 1;
      const chunksize = end - start + 1;

      const head = {
        'Content-Range': `bytes ${start}-${end}/${file.length}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': mimeType,
      };

      res.writeHead(206, head);
      file.createReadStream({ start, end }).pipe(res);
    } else {
      const head = {
        'Content-Length': file.length,
        'Content-Type': mimeType,
        'Content-Disposition': `inline; filename="${encodeURIComponent(file.name)}"`,
      };
      res.writeHead(200, head);
      file.createReadStream().pipe(res);
    }
  }
});

app.listen(port, () => {
  console.log(`Svorrent API running on http://localhost:${port}`);
});
