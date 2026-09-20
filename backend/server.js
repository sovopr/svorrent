import express from 'express';
import cors from 'cors';
import TorrentSearchApi from 'torrent-search-api';
import WebTorrent from 'webtorrent';

const app = express();
const port = process.env.PORT || 3001;

// Initialize WebTorrent with secure: 0 to prevent Node 24 OpenSSL 3.x Diffie-Hellman MSE keylength incompatibility
const client = new WebTorrent({
  secure: 0,
});

// Guard against unhandled torrent errors crashing the server process
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

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

// Real-time torrent status & progress endpoint
app.get('/api/torrent/status', async (req, res) => {
  let magnetURI = req.query.magnet;
  const { provider, desc, link } = req.query;

  if (!magnetURI && provider && (desc || link)) {
    try {
      magnetURI = await TorrentSearchApi.getMagnet({ provider, desc, link });
    } catch (err) {
      return res.status(400).json({ error: 'Could not resolve magnet: ' + err.message });
    }
  }

  if (!magnetURI) {
    return res.status(400).json({ error: 'Magnet URI or provider details required' });
  }

  let torrent = await client.get(magnetURI);
  if (!torrent) {
    try {
      torrent = client.add(magnetURI);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to add torrent: ' + err.message });
    }

    torrent.on('error', (err) => {
      console.error('Torrent status client error:', err.message);
    });
  }

  const files = torrent.files ? torrent.files.map((f) => ({ name: f.name, length: f.length })) : [];
  const largestFile = torrent.files && torrent.files.length > 0
    ? torrent.files.reduce((a, b) => (a.length > b.length ? a : b))
    : null;

  return res.json({
    magnet: magnetURI,
    name: torrent.name || 'Resolving metadata from swarm...',
    ready: !!torrent.ready,
    progress: torrent.progress || 0,
    downloadSpeed: torrent.downloadSpeed || 0,
    uploadSpeed: torrent.uploadSpeed || 0,
    numPeers: torrent.numPeers || 0,
    downloaded: torrent.downloaded || 0,
    length: torrent.length || (largestFile ? largestFile.length : 0),
    fileName: largestFile ? largestFile.name : null,
    files,
    streamUrl: `http://localhost:3001/api/stream?raw=true&magnet=${encodeURIComponent(magnetURI)}`,
  });
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

  // If request comes from a direct browser navigation (Accept: text/html) and raw != true,
  // redirect to the frontend player so the user sees the real-time progress loader instead of a blank screen
  const isHtmlNavigation = req.headers.accept && req.headers.accept.includes('text/html') && req.query.raw !== 'true';
  if (isHtmlNavigation) {
    const streamTarget = new URLSearchParams();
    streamTarget.set('streamMagnet', magnetURI);
    return res.redirect(`http://localhost:5173/?${streamTarget.toString()}`);
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
      console.error('Torrent stream client error:', err);
      if (!res.headersSent) {
        res.status(500).send('Torrent stream error: ' + err.message);
      }
    });
  }

  // Safety timeout: if swarm doesn't respond within 35 seconds
  const swarmTimeout = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).send(
        'Swarm timeout: No active peers found to stream directly in the browser. Please use the "Magnet" button to download using your desktop client.'
      );
    }
  }, 35000);

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
      const stream = file.createReadStream({ start, end });
      stream.pipe(res);
      req.on('close', () => stream.destroy());
    } else {
      const head = {
        'Content-Length': file.length,
        'Content-Type': mimeType,
        'Content-Disposition': `inline; filename="${encodeURIComponent(file.name)}"`,
      };
      res.writeHead(200, head);
      const stream = file.createReadStream();
      stream.pipe(res);
      req.on('close', () => stream.destroy());
    }
  }
});

app.listen(port, () => {
  console.log(`Svorrent API running on http://localhost:${port}`);
});
