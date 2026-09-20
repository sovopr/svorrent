const express = require('express');
const cors = require('cors');
const TorrentSearchApi = require('torrent-search-api');
const WebTorrent = require('webtorrent');

const app = express();
const port = process.env.PORT || 3001;
const client = new WebTorrent();

app.use(cors());
app.use(express.json());

// Enable active public providers for search
TorrentSearchApi.enablePublicProviders();

app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'Search query is required' });
  }

  try {
    // Search up to 20 results across all categories
    const torrents = await TorrentSearchApi.search(query, 'All', 20);
    
    // Some indexers don't return magnets directly, but the API usually tries.
    // We will return everything, but prioritize those with magnets.
    res.json(torrents);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Failed to search torrents' });
  }
});

app.get('/api/stream', async (req, res) => {
  let magnetURI = req.query.magnet;
  
  if (!magnetURI) {
    // Some providers might need us to fetch the magnet explicitly if it wasn't returned in the search list
    const torrentDesc = req.query.desc; // We can pass a description URL if magnet is missing
    if (torrentDesc) {
      try {
        magnetURI = await TorrentSearchApi.getMagnet({ desc: torrentDesc });
      } catch (err) {
        return res.status(400).send('Could not fetch magnet URI from description');
      }
    }
    
    if (!magnetURI) {
        return res.status(400).send('Magnet URI or description link is required');
    }
  }

  // Check if already downloading this magnet
  let torrent = client.get(magnetURI);

  if (!torrent) {
    torrent = client.add(magnetURI);
    
    torrent.on('error', (err) => {
      console.error('Torrent error:', err);
      if (!res.headersSent) {
          res.status(500).send('Torrent stream error');
      }
    });
  }

  if (torrent.ready) {
    streamFile();
  } else {
    torrent.on('ready', streamFile);
  }

  function streamFile() {
    // Find the largest file in the torrent (usually the main video)
    const file = torrent.files.reduce((a, b) => (a.length > b.length ? a : b));

    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : file.length - 1;
      const chunksize = (end - start) + 1;
      
      const head = {
        'Content-Range': `bytes ${start}-${end}/${file.length}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4', // Default to mp4 for video streaming
      };
      
      res.writeHead(206, head);
      file.createReadStream({ start, end }).pipe(res);
    } else {
      const head = {
        'Content-Length': file.length,
        'Content-Type': 'application/octet-stream', // Fallback for raw download
        'Content-Disposition': `attachment; filename="${file.name}"`
      };
      res.writeHead(200, head);
      file.createReadStream().pipe(res);
    }
  }
});

app.listen(port, () => {
  console.log(`Svorrent API running on http://localhost:${port}`);
});
