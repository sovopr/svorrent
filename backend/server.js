import express from 'express';
import cors from 'cors';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { exec } from 'node:child_process';
import TorrentSearchApi from 'torrent-search-api';
import WebTorrent from 'webtorrent';
import peerid from 'bittorrent-peerid';

const app = express();
const port = process.env.PORT || 3001;

// Default download folder on user's Mac: ~/Downloads/Svorrent
const DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads', 'Svorrent');
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// Initialize WebTorrent with secure: 0 for Node 24 OpenSSL compatibility
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

// Helper to get or add torrent
async function getOrAddTorrent(magnetURI, opts = {}) {
  let torrent = await client.get(magnetURI);
  if (!torrent) {
    torrent = client.add(magnetURI, {
      path: opts.path || DOWNLOAD_DIR,
    });
    torrent.on('error', (err) => {
      console.error('Torrent runtime error:', err.message);
    });
  }
  return torrent;
}

// Start download to local disk
app.post('/api/torrent/download', async (req, res) => {
  let { magnet, provider, desc, link } = req.body;

  if (!magnet && provider && (desc || link)) {
    try {
      magnet = await TorrentSearchApi.getMagnet({ provider, desc, link });
    } catch (err) {
      return res.status(400).json({ error: 'Failed to resolve magnet: ' + err.message });
    }
  }

  if (!magnet) {
    return res.status(400).json({ error: 'Magnet URI is required' });
  }

  try {
    const torrent = await getOrAddTorrent(magnet, { path: DOWNLOAD_DIR });
    res.json({
      success: true,
      infoHash: torrent.infoHash,
      name: torrent.name || 'Starting download...',
      downloadDir: DOWNLOAD_DIR,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to start download: ' + err.message });
  }
});

// List all active torrents
app.get('/api/torrents', (req, res) => {
  const list = client.torrents.map((t) => {
    const largestFile = t.files && t.files.length > 0
      ? t.files.reduce((a, b) => (a.length > b.length ? a : b))
      : null;

    return {
      infoHash: t.infoHash,
      magnet: t.magnetURI,
      name: t.name || 'Loading metadata...',
      ready: !!t.ready,
      paused: !!t.paused,
      done: !!t.done,
      progress: t.progress || 0,
      downloadSpeed: t.downloadSpeed || 0,
      uploadSpeed: t.uploadSpeed || 0,
      numPeers: t.numPeers || 0,
      downloaded: t.downloaded || 0,
      length: t.length || (largestFile ? largestFile.length : 0),
      path: t.path || DOWNLOAD_DIR,
      timeRemaining: t.timeRemaining || 0,
      fileName: largestFile ? largestFile.name : null,
      filesCount: t.files ? t.files.length : 0,
    };
  });
  res.json(list);
});

// Deep "Nerd Stats" Inspector endpoint
app.get('/api/torrent/:id/nerd-stats', async (req, res) => {
  const id = req.params.id;
  const torrent = await client.get(id);

  if (!torrent) {
    return res.status(404).json({ error: 'Torrent not found' });
  }

  // 1. Peer wires breakdown
  const peers = (torrent.wires || []).map((wire) => {
    let clientName = 'Unknown Client';
    if (wire.peerExtendedHandshake && wire.peerExtendedHandshake.v) {
      clientName = wire.peerExtendedHandshake.v;
    } else if (wire.peerId) {
      try {
        const parsed = peerid(wire.peerId);
        if (parsed && parsed.client) {
          clientName = `${parsed.client} ${parsed.version || ''}`.trim();
        }
      } catch (e) {}
    }

    let peerProgress = 0;
    if (wire.peerPieces && torrent.pieces && torrent.pieces.length > 0) {
      let piecesHave = 0;
      for (let i = 0; i < torrent.pieces.length; i++) {
        if (wire.peerPieces.get(i)) piecesHave++;
      }
      peerProgress = Math.round((piecesHave / torrent.pieces.length) * 100);
    }

    return {
      ip: wire.remoteAddress || '127.0.0.1',
      port: wire.remotePort || 0,
      client: clientName,
      type: wire.type || 'tcp',
      downloadSpeed: typeof wire.downloadSpeed === 'function' ? wire.downloadSpeed() : 0,
      uploadSpeed: typeof wire.uploadSpeed === 'function' ? wire.uploadSpeed() : 0,
      downloaded: wire.downloaded || 0,
      uploaded: wire.uploaded || 0,
      choked: !!wire.peerChoking,
      interested: !!wire.peerInterested,
      amChoking: !!wire.amChoking,
      amInterested: !!wire.amInterested,
      progress: peerProgress,
    };
  });

  // 2. Piece Map / Bitfield stats
  let pieceStats = {
    total: torrent.pieces ? torrent.pieces.length : 0,
    pieceLength: torrent.pieceLength || 0,
    verified: 0,
    grid: [],
  };

  if (torrent.pieces && torrent.bitfield) {
    const total = torrent.pieces.length;
    let verifiedCount = 0;
    for (let i = 0; i < total; i++) {
      if (torrent.bitfield.get(i)) verifiedCount++;
    }

    // Sample up to 240 blocks for visual piece grid display
    const blocksCount = Math.min(total, 240);
    const step = total / blocksCount;
    const grid = [];
    for (let i = 0; i < blocksCount; i++) {
      const pieceIdx = Math.floor(i * step);
      const isDone = torrent.bitfield.get(pieceIdx);
      const isDownloading = !isDone && torrent.pieces[pieceIdx] && torrent.pieces[pieceIdx].missing < torrent.pieces[pieceIdx].length;
      grid.push(isDone ? 2 : isDownloading ? 1 : 0);
    }

    pieceStats = {
      total,
      pieceLength: torrent.pieceLength,
      verified: verifiedCount,
      grid,
    };
  }

  // 3. Trackers
  const announceUrls = torrent.announce || [];
  const trackerList = announceUrls.map((url) => ({
    url,
    status: 'Announced',
    seeds: torrent.numPeers || 0,
    peers: torrent.wires ? torrent.wires.length : 0,
  }));

  // 4. DHT nodes count
  const dhtNodes = client.dht?._rpc?.nodes?.toArray?.()?.length ?? client.dht?._rpc?.nodes?.length ?? 0;

  // 5. Files list with full details
  const files = (torrent.files || []).map((f) => ({
    name: f.name,
    path: f.path,
    absolutePath: path.join(torrent.path || DOWNLOAD_DIR, f.path),
    length: f.length,
    downloaded: f.downloaded || 0,
    progress: f.progress || 0,
  }));

  res.json({
    infoHash: torrent.infoHash,
    name: torrent.name,
    ready: !!torrent.ready,
    done: !!torrent.done,
    paused: !!torrent.paused,
    progress: torrent.progress || 0,
    downloadSpeed: torrent.downloadSpeed || 0,
    uploadSpeed: torrent.uploadSpeed || 0,
    numPeers: torrent.numPeers || 0,
    downloaded: torrent.downloaded || 0,
    length: torrent.length || 0,
    downloadDir: torrent.path || DOWNLOAD_DIR,
    timeRemaining: torrent.timeRemaining || 0,
    peers,
    pieces: pieceStats,
    trackers: trackerList,
    dhtNodes,
    files,
  });
});

// Pause torrent
app.post('/api/torrent/:id/pause', async (req, res) => {
  const torrent = await client.get(req.params.id);
  if (!torrent) return res.status(404).json({ error: 'Torrent not found' });
  torrent.pause();
  res.json({ success: true, paused: true });
});

// Resume torrent
app.post('/api/torrent/:id/resume', async (req, res) => {
  const torrent = await client.get(req.params.id);
  if (!torrent) return res.status(404).json({ error: 'Torrent not found' });
  torrent.resume();
  res.json({ success: true, paused: false });
});

// Delete torrent
app.post('/api/torrent/:id/delete', async (req, res) => {
  const torrent = await client.get(req.params.id);
  if (!torrent) return res.status(404).json({ error: 'Torrent not found' });
  const { deleteFiles } = req.body;
  torrent.destroy({ destroyStore: !!deleteFiles }, () => {
    res.json({ success: true, deleted: true });
  });
});

// Reveal in macOS Finder
app.post('/api/torrent/:id/open-finder', async (req, res) => {
  const torrent = await client.get(req.params.id);
  const targetPath = torrent ? torrent.path : DOWNLOAD_DIR;
  exec(`open "${targetPath}"`, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, path: targetPath });
  });
});

// Open File in native player (IINA / VLC / QuickTime)
app.post('/api/torrent/:id/play-native', async (req, res) => {
  const torrent = await client.get(req.params.id);
  if (!torrent || !torrent.files || torrent.files.length === 0) {
    return res.status(404).json({ error: 'No files ready to open' });
  }

  const largestFile = torrent.files.reduce((a, b) => (a.length > b.length ? a : b));
  const fullPath = path.join(torrent.path || DOWNLOAD_DIR, largestFile.path);

  exec(`open "${fullPath}"`, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, file: fullPath });
  });
});

// Real-time quick status endpoint for streaming drawer
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

  let torrent = await getOrAddTorrent(magnetURI, { path: DOWNLOAD_DIR });

  const files = torrent.files ? torrent.files.map((f) => ({ name: f.name, length: f.length })) : [];
  const largestFile = torrent.files && torrent.files.length > 0
    ? torrent.files.reduce((a, b) => (a.length > b.length ? a : b))
    : null;

  return res.json({
    infoHash: torrent.infoHash,
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

  const isHtmlNavigation = req.headers.accept && req.headers.accept.includes('text/html') && req.query.raw !== 'true';
  if (isHtmlNavigation) {
    const streamTarget = new URLSearchParams();
    streamTarget.set('streamMagnet', magnetURI);
    return res.redirect(`http://localhost:5173/?${streamTarget.toString()}`);
  }

  let torrent = await getOrAddTorrent(magnetURI, { path: DOWNLOAD_DIR });

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
  console.log(`Native downloads directory: ${DOWNLOAD_DIR}`);
});
