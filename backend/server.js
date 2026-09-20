import express from 'express';
import cors from 'cors';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { exec, spawn } from 'node:child_process';
import zlib from 'node:zlib';
import TorrentSearchApi from 'torrent-search-api';
import WebTorrent from 'webtorrent';
import peerid from 'bittorrent-peerid';
import MemoryChunkStore from 'memory-chunk-store';

const app = express();
const port = process.env.PORT || 3001;

// Path to FFmpeg binary
const FFMPEG_BIN = process.env.FFMPEG_PATH || (fs.existsSync('/Users/soveet/miniforge3/bin/ffmpeg') ? '/Users/soveet/miniforge3/bin/ffmpeg' : 'ffmpeg');

// Default download folder on user's Mac: ~/Downloads/Svorrent
const DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads', 'Svorrent');
function ensureDownloadDir() {
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }
}

// Temporary streaming buffer cache — lives in macOS /tmp, auto-wiped on boot
const STREAM_CACHE_DIR = path.join(os.tmpdir(), 'svorrent-cache');

// Some search providers still return magnets containing only retired trackers.
// Keep the original trackers, but add a small fallback set so metadata and
// peers can still be discovered when one provider's tracker list is stale.
const FALLBACK_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.coppersurfer.tk:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://tracker.cyberia.is:6969/announce',
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
];

function withFallbackTrackers(magnetURI) {
  if (!magnetURI || !magnetURI.startsWith('magnet:?')) return magnetURI;

  const existing = new Set();
  for (const match of magnetURI.matchAll(/(?:^|&)tr=([^&]*)/g)) {
    try {
      existing.add(decodeURIComponent(match[1]));
    } catch (e) {
      existing.add(match[1]);
    }
  }

  const additions = FALLBACK_TRACKERS
    .filter((tracker) => !existing.has(tracker))
    .map((tracker) => `tr=${encodeURIComponent(tracker)}`);

  return additions.length > 0 ? `${magnetURI}&${additions.join('&')}` : magnetURI;
}

// Dynamic Sliding Window Prefetch Engine
// Focuses swarm bandwidth immediately ahead of the current playback position.
// Prioritizes a 50-piece forward runway:
//  - Pieces 0..5 ahead: Critical priority (7)
//  - Pieces 6..25 ahead: High buffer priority (6)
//  - Pieces 26..50 ahead: Medium queue priority (5)
//  - Older pieces (< currentPiece - 10): Deselected to avoid bandwidth waste
//  - End pieces: Retained for container index / moov / cues
function updatePrefetchWindow(torrent, file, byteOffset = 0) {
  if (!torrent || !file || typeof torrent.select !== 'function') return;
  const pieceLength = torrent.pieceLength;
  if (!pieceLength || pieceLength <= 0) return;

  const startPiece = file._startPiece;
  const endPiece = file._endPiece;
  if (typeof startPiece !== 'number' || typeof endPiece !== 'number') return;

  const absoluteByte = Math.min(file.length - 1, Math.max(0, byteOffset)) + (file.offset || 0);
  const currentPiece = Math.floor(absoluteByte / pieceLength);

  const p0 = Math.max(startPiece, currentPiece);
  const pCriticalEnd = Math.min(endPiece, p0 + 5);
  const pRunwayEnd = Math.min(endPiece, p0 + 25);
  const pHorizonEnd = Math.min(endPiece, p0 + 50);

  try {
    // Deselect old pieces already consumed behind playback cursor (leave first 2 pieces for container headers)
    if (currentPiece > startPiece + 12 && typeof torrent.deselect === 'function') {
      const deselectStart = startPiece + 2;
      const deselectEnd = currentPiece - 8;
      if (deselectEnd > deselectStart) {
        torrent.deselect(deselectStart, deselectEnd);
      }
    }

    // Tier 1: Urgent immediate playback buffer (pieces 0..5 ahead)
    torrent.select(p0, pCriticalEnd, 7);

    // Tier 2: Safety buffer runway (pieces 6..25 ahead)
    if (pRunwayEnd > pCriticalEnd) {
      torrent.select(pCriticalEnd, pRunwayEnd, 6);
    }

    // Tier 3: Background swarm saturation (pieces 26..50 ahead)
    if (pHorizonEnd > pRunwayEnd) {
      torrent.select(pRunwayEnd, pHorizonEnd, 5);
    }

    // Always preserve the last 2 pieces of the file (MP4 moov atom / MKV cues / index tables)
    if (endPiece > startPiece + 2) {
      torrent.select(Math.max(startPiece, endPiece - 2), endPiece, 7);
    }
  } catch (err) {
    // Non-fatal if piece selection fails
  }
}

// Clean old cache on startup (best-effort — locked files are skipped)
function cleanStreamCache() {
  try {
    if (fs.existsSync(STREAM_CACHE_DIR)) {
      fs.rmSync(STREAM_CACHE_DIR, { recursive: true, force: true });
    }
  } catch (e) {
    // Directory may be locked; will be cleaned on next server restart
  }
  try {
    fs.mkdirSync(STREAM_CACHE_DIR, { recursive: true });
  } catch (e) {}
}
cleanStreamCache();

// Initialize WebTorrent with secure: 0 for Node 24 OpenSSL compatibility and tuned connection limits
const client = new WebTorrent({
  secure: 0,
  maxConns: 120,
  dht: true,
});

// Guard against unhandled torrent errors crashing the server process
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

// Graceful shutdown: destroy all torrents and wipe stream cache
async function shutdownCleanup() {
  console.log('\nSvorrent shutting down — wiping stream cache...');
  try {
    await new Promise((resolve) => client.destroy(resolve));
  } catch (e) {}
  cleanStreamCache();
  process.exit(0);
}
process.on('SIGINT', shutdownCleanup);
process.on('SIGTERM', shutdownCleanup);

// Periodic cleanup: remove stream-only torrents that have been seeding > 2h
// (Keeps memory + disk from accumulating during a long session)
setInterval(() => {
  const now = Date.now();
  client.torrents.forEach((t) => {
    if (t._isStreamOnly && t._addedAt && (now - t._addedAt) > 2 * 60 * 60 * 1000) {
      console.log(`Auto-removing stale stream torrent: ${t.name}`);
      t.destroy({ destroyStore: true }, () => {});
    }
  });
}, 30 * 60 * 1000); // Check every 30 minutes

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
  magnetURI = withFallbackTrackers(magnetURI);
  let torrent = await client.get(magnetURI);

  // A stream torrent uses MemoryChunkStore and cannot be converted into a
  // disk download by changing flags later. Recreate it with WebTorrent's
  // filesystem store when the user explicitly asks to download the file.
  if (torrent && opts.isPermanentDownload) {
    const materializedFile = torrent.files?.some((file) => {
      const filePath = path.join(DOWNLOAD_DIR, file.path || '');
      return fs.existsSync(filePath);
    });
    const needsDiskStore = torrent._isStreamOnly ||
      torrent._diskBacked !== true ||
      torrent.path !== DOWNLOAD_DIR;
    if (needsDiskStore && !materializedFile) {
      await new Promise((resolve) => {
        try {
          client.remove(torrent, { destroyStore: false }, resolve);
        } catch (err) {
          console.warn('Could not release in-memory stream torrent:', err.message);
          resolve();
        }
      });
      torrent = null;
    }
  }

  if (!torrent) {
    const isPermanent = opts.isPermanentDownload === true || (!opts.isStreamOnly && opts.path === DOWNLOAD_DIR);

    // Stream-only torrents use in-memory storage (zero disk footprint, like Netflix).
    // Permanent downloads use ~/Downloads/Svorrent on disk as expected.
    if (isPermanent) ensureDownloadDir();
    const addOpts = isPermanent
      ? { path: opts.path || DOWNLOAD_DIR }
      : { store: MemoryChunkStore };

    torrent = client.add(magnetURI, addOpts);

    torrent._isPermanentDownload = isPermanent;
    torrent._isStreamOnly = !isPermanent;
    torrent._diskBacked = isPermanent;
    torrent._addedAt = Date.now();
    torrent.on('error', (err) => {
      console.error('Torrent runtime error:', err.message);
    });
    torrent.once('ready', () => {
      if (torrent.files && torrent.files.length > 0) {
        const largestFile = torrent.files.reduce((a, b) => (a.length > b.length ? a : b));
        if (torrent._isStreamOnly) {
          torrent.files.forEach((f) => {
            if (f !== largestFile && typeof f.deselect === 'function') f.deselect();
          });
          if (typeof largestFile.select === 'function') largestFile.select();
        }

        // Keep an immediately visible, genuinely downloaded partial file in
        // Finder while the filesystem chunk store is still filling pieces.
        // The normal WebTorrent store remains the source of truth; this sidecar
        // is renamed when the sequential file stream reaches EOF.
        if (torrent._isPermanentDownload && !torrent._materializerStarted) {
          torrent._materializerStarted = true;
          const partialPath = path.join(DOWNLOAD_DIR, `${largestFile.path}.svorrent-partial`);
          const finalPath = path.join(DOWNLOAD_DIR, largestFile.path);
          fs.mkdirSync(path.dirname(partialPath), { recursive: true });
          const output = fs.createWriteStream(partialPath);
          const input = largestFile.createReadStream();
          input.on('error', (err) => {
            console.warn('Partial download materializer stopped:', err.message);
            output.destroy();
          });
          output.on('error', (err) => {
            console.warn('Partial download file error:', err.message);
            input.destroy();
          });
          input.on('end', () => {
            if (fs.existsSync(finalPath)) {
              try { fs.unlinkSync(partialPath); } catch (e) {}
            } else {
              try { fs.renameSync(partialPath, finalPath); } catch (e) {}
            }
          });
          input.pipe(output);
        }

        if (typeof torrent.select === 'function' && typeof largestFile._startPiece === 'number') {
          updatePrefetchWindow(torrent, largestFile, 0);
        }
      }
    });
  } else if (opts.isPermanentDownload) {
    torrent._isPermanentDownload = true;
    torrent._isStreamOnly = false;
    torrent._diskBacked = true;
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
    const torrent = await getOrAddTorrent(magnet, { path: DOWNLOAD_DIR, isPermanentDownload: true });
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

// List all active user downloads (strictly excludes temporary stream cache buffers)
app.get('/api/torrents', (req, res) => {
  const includeStreams = req.query.includeStreams === 'true';
  const targetTorrents = includeStreams
    ? client.torrents
    : client.torrents.filter((t) => !!t._isPermanentDownload);

  const list = targetTorrents.map((t) => {
    const largestFile = t.files && t.files.length > 0
      ? t.files.reduce((a, b) => (a.length > b.length ? a : b))
      : null;

    const isPaused = !!(t.paused || t._pausedManually);

    return {
      infoHash: t.infoHash,
      magnet: t.magnetURI,
      name: t.name || 'Loading metadata...',
      ready: !!t.ready,
      paused: isPaused,
      done: !!t.done,
      progress: t.progress || 0,
      downloadSpeed: isPaused ? 0 : (t.downloadSpeed || 0),
      uploadSpeed: isPaused ? 0 : (t.uploadSpeed || 0),
      numPeers: isPaused ? 0 : (t.numPeers || 0),
      downloaded: t.downloaded || 0,
      length: t.length || (largestFile ? largestFile.length : 0),
      path: t.path || DOWNLOAD_DIR,
      timeRemaining: isPaused ? Infinity : (t.timeRemaining || 0),
      fileName: largestFile ? largestFile.name : null,
      filesCount: t.files ? t.files.length : 0,
      isPermanentDownload: !!t._isPermanentDownload,
      isStreamOnly: !!t._isStreamOnly,
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
      const v = wire.peerExtendedHandshake.v;
      if (typeof v === 'string') {
        clientName = v;
      } else if (Buffer.isBuffer(v)) {
        clientName = v.toString('utf8');
      } else if (typeof v === 'object') {
        try {
          clientName = Buffer.from(Object.values(v)).toString('utf8');
        } catch (e) {
          clientName = 'Unknown Client';
        }
      }
    } else if (wire.peerId) {
      try {
        const parsed = peerid(wire.peerId);
        if (parsed && parsed.client) {
          clientName = `${parsed.client} ${parsed.version || ''}`.trim();
        }
      } catch (e) {}
    }
    if (typeof clientName !== 'string') {
      clientName = String(clientName);
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

  const isPaused = !!(torrent.paused || torrent._pausedManually);
  res.json({
    infoHash: torrent.infoHash,
    name: torrent.name || 'Resolving metadata from swarm...',
    ready: !!torrent.ready,
    done: !!torrent.done,
    paused: isPaused,
    progress: torrent.progress || 0,
    downloadSpeed: isPaused ? 0 : (torrent.downloadSpeed || 0),
    uploadSpeed: isPaused ? 0 : (torrent.uploadSpeed || 0),
    numPeers: isPaused ? 0 : (torrent.numPeers || 0),
    downloaded: torrent.downloaded || 0,
    length: torrent.length || 0,
    downloadDir: torrent.path || DOWNLOAD_DIR,
    timeRemaining: isPaused ? Infinity : (torrent.timeRemaining || 0),
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
  
  torrent.paused = true;
  torrent._pausedManually = true;

  try {
    if (torrent.pieces && torrent.pieces.length > 0) {
      torrent.deselect(0, torrent.pieces.length - 1, false);
    }
    if (torrent.files) {
      torrent.files.forEach((f) => {
        try { f.deselect(); } catch (e) {}
      });
    }
  } catch (e) {}

  if (torrent.wires) {
    torrent.wires.forEach((wire) => {
      try { wire.choke(); } catch (e) {}
      try { wire.uninterested(); } catch (e) {}
    });
  }

  res.json({ success: true, paused: true });
});

// Resume torrent
app.post('/api/torrent/:id/resume', async (req, res) => {
  const torrent = await client.get(req.params.id);
  if (!torrent) return res.status(404).json({ error: 'Torrent not found' });

  torrent.paused = false;
  torrent._pausedManually = false;

  try {
    if (torrent.files) {
      torrent.files.forEach((f) => {
        try { f.select(); } catch (e) {}
      });
    }
    if (torrent.pieces && torrent.pieces.length > 0) {
      torrent.select(0, torrent.pieces.length - 1, false);
    }
  } catch (e) {}

  if (torrent.wires) {
    torrent.wires.forEach((wire) => {
      try { wire.unchoke(); } catch (e) {}
      try { wire.interested(); } catch (e) {}
    });
  }
  try { torrent._drain(); } catch (e) {}

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

// Reveal in macOS Finder / Windows File Explorer
app.post('/api/torrent/:id/open-finder', async (req, res) => {
  const torrent = await client.get(req.params.id);
  ensureDownloadDir();

  // Permanent downloads belong in DOWNLOAD_DIR. Stream-only torrents may
  // point at a temporary in-memory/cache location, so never reveal that path.
  const configuredPath = torrent && torrent._isPermanentDownload && torrent.path
    ? torrent.path
    : DOWNLOAD_DIR;
  const basePath = fs.existsSync(configuredPath) ? configuredPath : DOWNLOAD_DIR;
  const largestFile = torrent?.files?.length
    ? torrent.files.reduce((a, b) => (a.length > b.length ? a : b))
    : null;
  const candidateFile = largestFile?.path ? path.join(basePath, largestFile.path) : null;
  const targetFile = candidateFile && fs.existsSync(candidateFile) ? candidateFile : null;

  const onOpen = (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, path: targetFile || basePath });
  };

  if (process.platform === 'darwin') {
    // Reveal the actual partial file when available; otherwise open the
    // configured folder so Finder still lands somewhere useful.
    return spawn('open', targetFile ? ['-R', targetFile] : [basePath]).on('error', onOpen).on('close', (code) => {
      if (code !== 0) return onOpen(new Error('Finder could not open the download location'));
      onOpen(null);
    });
  }

  const cmd = process.platform === 'win32'
    ? `explorer.exe "${basePath}"`
    : `xdg-open "${basePath}"`;
  exec(cmd, onOpen);
});

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

// Dedicated clean direct stream endpoint for VLC / IINA / native players
app.get('/api/torrent/:id/stream', async (req, res) => {
  let magnetURI = req.query.magnet;
  let torrent = await client.get(req.params.id);

  if (!torrent && magnetURI) {
    torrent = await getOrAddTorrent(magnetURI, { isStreamOnly: true });
  }
  if (!torrent) {
    torrent = client.torrents.find((t) => t.infoHash === req.params.id || (magnetURI && t.magnetURI === magnetURI));
  }
  if (!torrent) {
    return res.status(404).send('Torrent not found in swarm');
  }

  const swarmTimeout = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).send('Swarm timeout waiting for metadata');
    }
  }, 35000);

  if (torrent.ready) {
    startServingStream();
  } else {
    torrent.once('ready', startServingStream);
  }

  function startServingStream() {
    clearTimeout(swarmTimeout);
    if (res.headersSent) return;

    if (!torrent.files || torrent.files.length === 0) {
      return res.status(404).send('No files found in torrent');
    }

    const file = torrent.files.reduce((a, b) => (a.length > b.length ? a : b));
    const mimeType = getMimeType(file.name);

    // Focus bandwidth on this file & sliding window
    try {
      torrent.files.forEach((f) => {
        if (f !== file && typeof f.deselect === 'function') f.deselect();
      });
      if (typeof file.select === 'function') file.select();
    } catch (e) {}

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range, Content-Type, Accept',
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
    };

    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : file.length - 1;
      const chunksize = end - start + 1;

      // Update sliding-window prefetcher to pull 50 pieces ahead of this byte offset
      updatePrefetchWindow(torrent, file, start);

      const head = {
        'Content-Range': `bytes ${start}-${end}/${file.length}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': mimeType,
        ...corsHeaders,
      };

      res.writeHead(206, head);
      if (req.method === 'HEAD') return res.end();
      const stream = file.createReadStream({ start, end });
      stream.on('error', () => {});
      stream.pipe(res);
      req.on('close', () => { try { stream.destroy(); } catch (e) {} });
    } else {
      updatePrefetchWindow(torrent, file, 0);
      const head = {
        'Content-Length': file.length,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `inline; filename="${encodeURIComponent(file.name)}"`,
        ...corsHeaders,
      };
      res.writeHead(200, head);
      if (req.method === 'HEAD') return res.end();
      const stream = file.createReadStream();
      stream.on('error', () => {});
      stream.pipe(res);
      req.on('close', () => { try { stream.destroy(); } catch (e) {} });
    }
  }
});

// Open File or Live Stream in native player (VLC / IINA / Windows Media Player / MPC-HC)
app.post('/api/torrent/:id/play-native', async (req, res) => {
  let magnetURI = req.body?.magnet || req.query?.magnet;
  let torrent = await client.get(req.params.id);

  if (!torrent && magnetURI) {
    torrent = await getOrAddTorrent(magnetURI, { isStreamOnly: true });
  }

  if (!torrent) {
    torrent = client.torrents.find(
      (t) => t.infoHash === req.params.id || (magnetURI && t.magnetURI === magnetURI)
    );
  }

  if (!torrent) {
    return res.status(404).json({ error: 'Torrent not found in swarm' });
  }

  const mediaFiles = torrent.files
    ? torrent.files.filter((f) => /\.(mp4|m4v|webm|mkv|avi|mov|ts|m2ts)$/i.test(f.name))
    : [];
  const largestFile = mediaFiles.length > 0
    ? mediaFiles.reduce((a, b) => (a.length > b.length ? a : b))
    : torrent.files && torrent.files.length > 0
      ? torrent.files.reduce((a, b) => (a.length > b.length ? a : b))
      : null;

  // Stream-only torrents live in RAM. Never derive a native-player path from
  // torrent.path: stale cache paths make VLC try to open deleted files.
  const fullPath = !torrent._isStreamOnly && largestFile
    ? path.join(torrent.path || DOWNLOAD_DIR, largestFile.path)
    : null;
  const fileExistsOnDisk = fullPath && fs.existsSync(fullPath) && fs.statSync(fullPath).size > 1048576;

  let targetUrlOrPath = '';
  let streamModeUsed = false;

  if (fileExistsOnDisk) {
    targetUrlOrPath = fullPath;
  } else {
    streamModeUsed = true;
    // The torrent is already registered above, so VLC only needs the short
    // stream URL. Avoid embedding the full magnet (and its encoded trackers)
    // in the MRL; some VLC builds reject that very long URL.
    targetUrlOrPath = `http://localhost:3001/api/torrent/${torrent.infoHash}/stream`;
  }

  // Build platform-specific launcher with VLC / IINA auto-activation & instant play
  let cmd = '';
  let playerName = 'Default Media Player';

  if (process.platform === 'darwin') {
    if (fs.existsSync('/Applications/IINA.app')) {
      cmd = `open -a "/Applications/IINA.app" "${targetUrlOrPath}"`;
      playerName = 'IINA';
    } else if (fs.existsSync('/Applications/VLC.app')) {
      // VLC's OpenURL AppleScript verb is unreliable and can turn a local
      // HTTP URL into a bogus :554 MRL. Let macOS pass the URL directly to
      // VLC, which handles HTTP range requests correctly.
      // Launch VLC's executable directly so the URL is opened and played,
      // instead of being merely queued by an already-running VLC instance.
      cmd = `"/Applications/VLC.app/Contents/MacOS/VLC" "${targetUrlOrPath}" >/dev/null 2>&1 &`;
      playerName = 'VLC Media Player';
    } else {
      cmd = `open -a VLC "${targetUrlOrPath}" 2>/dev/null || open "${targetUrlOrPath}"`;
      playerName = 'VLC / Default Player';
    }
  } else if (process.platform === 'win32') {
    const vlc64 = 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe';
    const vlc32 = 'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe';
    if (fs.existsSync(vlc64)) {
      cmd = `"${vlc64}" "${targetUrlOrPath}"`;
      playerName = 'VLC Media Player';
    } else if (fs.existsSync(vlc32)) {
      cmd = `"${vlc32}" "${targetUrlOrPath}"`;
      playerName = 'VLC Media Player';
    } else {
      cmd = `start "" "${targetUrlOrPath}"`;
      playerName = 'Default Windows Player';
    }
  } else {
    cmd = `vlc "${targetUrlOrPath}" 2>/dev/null || xdg-open "${targetUrlOrPath}"`;
    playerName = 'VLC';
  }

  exec(cmd, (err) => {
    if (err) {
      console.error('Play native error:', err);
      const fallbackCmd = process.platform === 'darwin' ? `open "${targetUrlOrPath}"` : `xdg-open "${targetUrlOrPath}"`;
      exec(fallbackCmd, (fbErr) => {
        if (fbErr) {
          return res.status(500).json({ error: `Could not launch player: ${err.message}` });
        }
        res.json({ success: true, target: targetUrlOrPath, player: playerName, streamMode: streamModeUsed });
      });
      return;
    }
    res.json({ success: true, target: targetUrlOrPath, player: playerName, streamMode: streamModeUsed });
  });
});

// Downloadable M3U stream playlist for any desktop player
app.get('/api/torrent/:id/playlist.m3u', async (req, res) => {
  let magnetURI = req.query.magnet;
  let torrent = await client.get(req.params.id);
  if (!torrent && magnetURI) {
    torrent = await getOrAddTorrent(magnetURI, { isStreamOnly: true });
  }

  const effectiveMagnet = torrent?.magnetURI || magnetURI;
  if (!effectiveMagnet) return res.status(400).send('Magnet required');

  const title = cleanMovieTitle(torrent?.name || req.query.title || 'Svorrent Stream');
  const streamUrl = `http://localhost:3001/api/torrent/${torrent?.infoHash || req.params.id}/stream`;
  const m3u = `#EXTM3U\n#EXTINF:-1,${title} [Svorrent Stream]\n${streamUrl}\n`;

  res.setHeader('Content-Type', 'audio/x-mpegurl');
  res.setHeader('Content-Disposition', `attachment; filename="${title.replace(/[^a-zA-Z0-9_-]/g, '_')}.m3u"`);
  res.send(m3u);
});

function cleanMovieTitle(raw) {
  if (!raw) return '';
  let name = raw.replace(/\.(mkv|mp4|avi|webm)$/i, '');
  name = name.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '');
  const match = name.match(/^(.*?)(?:[.\s_-]+(?:(?:19|20)\d{2}|480p|720p|1080p|2160p|4k|uhd|remux|bluray|web-?dl|hdr|dts))/i);
  let cleaned = match ? match[1] : name;
  cleaned = cleaned.replace(/[._]/g, ' ').trim();
  return cleaned || name;
}

// Quick status endpoint for cinema player with piece buffer telemetry
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

  let torrent = await getOrAddTorrent(magnetURI, { isStreamOnly: true });

  const files = torrent.files ? torrent.files.map((f) => ({ name: f.name, length: f.length })) : [];
  const mediaFiles = torrent.files
    ? torrent.files.filter((f) => /\.(mp4|m4v|webm|mkv|avi|mov|ts|m2ts)$/i.test(f.name))
    : [];
  const largestFile = mediaFiles.length > 0
    ? mediaFiles.reduce((a, b) => (a.length > b.length ? a : b))
    : torrent.files && torrent.files.length > 0
      ? torrent.files.reduce((a, b) => (a.length > b.length ? a : b))
      : null;

  const subtitleFiles = torrent.files
    ? torrent.files
        .map((f, idx) => ({ index: idx, name: f.name, length: f.length }))
        .filter((f) => /\.(srt|vtt|sub|ass)$/i.test(f.name))
    : [];

  const pieceLength = torrent.pieceLength || 0;
  const startPiece = largestFile ? largestFile._startPiece : 0;

  // hasFirstPiece means that the bytes needed to start the selected media file
  // are actually available. `torrent.ready` only means that metadata arrived;
  // treating it as playable makes the browser request an empty stream when the
  // swarm has not supplied any data yet.
  let hasFirstPiece = false;
  if (torrent.bitfield && typeof torrent.bitfield.get === 'function') {
    hasFirstPiece = !!torrent.bitfield.get(startPiece);
  }
  if (!hasFirstPiece && pieceLength > 0 && (torrent.downloaded || 0) >= pieceLength) {
    hasFirstPiece = true; // downloaded >= 1 piece → piece 0 must be in memory
  }

  let firstPieceDownloaded = 0;
  if (hasFirstPiece) {
    firstPieceDownloaded = pieceLength;
  } else if (pieceLength > 0) {
    firstPieceDownloaded = Math.min(pieceLength, torrent.downloaded || 0);
  }

  const firstPieceProgress = pieceLength > 0 ? Math.min(100, Math.round((firstPieceDownloaded / pieceLength) * 100)) : 0;
  const etaSeconds = firstPieceProgress < 100 && (torrent.downloadSpeed || 0) > 0
    ? Math.ceil((pieceLength - firstPieceDownloaded) / torrent.downloadSpeed)
    : null;
  const isNativeCompatible = largestFile ? /\.(mp4|m4v|webm)$/i.test(largestFile.name) : false;

  // Calculate contiguous buffer runway from startPiece forward
  let runwayPiecesReady = 0;
  if (largestFile && pieceLength > 0) {
    const endP = largestFile._endPiece || startPiece;
    const maxCheck = Math.min(endP, startPiece + 35);
    for (let p = startPiece; p <= maxCheck; p++) {
      let pieceDone = false;
      if (torrent.bitfield && typeof torrent.bitfield.get === 'function') {
        pieceDone = !!torrent.bitfield.get(p);
      }
      if (!pieceDone && (torrent.downloaded || 0) >= (p - startPiece + 1) * pieceLength) {
        pieceDone = true;
      }
      if (pieceDone) {
        runwayPiecesReady++;
      } else {
        break;
      }
    }
  }

  const isFastSwarm = (torrent.downloadSpeed || 0) > 1800000;
  const targetRunwayPieces = isFastSwarm ? 3 : 6;
  const runwayBytesReady = runwayPiecesReady * pieceLength;
  const isRunwaySafe = runwayPiecesReady >= targetRunwayPieces || (hasFirstPiece && isFastSwarm);
  const runwayProgress = Math.min(100, Math.round((runwayPiecesReady / targetRunwayPieces) * 100));

  const estimatedDurationSec = 7200;
  const requiredBitrateBytesPerSec = largestFile && largestFile.length > 0
    ? Math.round(largestFile.length / estimatedDurationSec)
    : 0;
  const isBandwidthConstrained = (torrent.downloadSpeed || 0) > 0 &&
    requiredBitrateBytesPerSec > 0 &&
    (torrent.downloadSpeed || 0) < requiredBitrateBytesPerSec * 0.9;
  const speedDeficitRatio = isBandwidthConstrained && torrent.downloadSpeed > 0
    ? Number((requiredBitrateBytesPerSec / torrent.downloadSpeed).toFixed(1))
    : 1.0;

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
    subtitleFiles,
    pieceLength,
    hasFirstPiece,
    firstPieceDownloaded,
    firstPieceProgress,
    runwayPiecesReady,
    targetRunwayPieces,
    runwayBytesReady,
    isRunwaySafe,
    runwayProgress,
    requiredBitrateBytesPerSec,
    isBandwidthConstrained,
    speedDeficitRatio,
    etaSeconds,
    isNativeCompatible,
    recommendedMode: isNativeCompatible ? 'direct' : 'remux',
    sourceContainer: largestFile ? (largestFile.name.split('.').pop() || '').toLowerCase() : null,
    sourceIsRemuxRelease: /(?:remux|bluray[ ._-]*remux)/i.test(largestFile?.name || ''),
    streamUrl: `http://localhost:3001/api/stream?raw=true&magnet=${encodeURIComponent(magnetURI)}`,
    directStreamUrl: `http://localhost:3001/api/torrent/${torrent.infoHash}/stream`,
    remuxStreamUrl: `http://localhost:3001/api/stream/remux?mode=copy&magnet=${encodeURIComponent(magnetURI)}`,
    transcodeStreamUrl: `http://localhost:3001/api/stream/remux?mode=transcode&magnet=${encodeURIComponent(magnetURI)}`,
  });
});

// Auto-Search Subtitles across online databases by movie title
app.get('/api/subtitles/search', async (req, res) => {
  const query = req.query.query;
  const lang = (req.query.lang || 'eng').toLowerCase();

  if (!query) {
    return res.status(400).json({ error: 'Search query is required' });
  }

  const cleaned = cleanMovieTitle(query);
  const searchSlug = encodeURIComponent(cleaned.toLowerCase().trim());

  try {
    const url = `https://rest.opensubtitles.org/search/query-${searchSlug}/sublanguageid-${encodeURIComponent(lang)}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'TemporaryUserAgent',
        'Host': 'rest.opensubtitles.org',
      },
    });

    if (!response.ok) {
      return res.json({ query: cleaned, results: [] });
    }

    const data = await response.json();
    if (!Array.isArray(data)) {
      return res.json({ query: cleaned, results: [] });
    }

    const results = data.slice(0, 16).map((item) => ({
      id: `os-${item.IDSubtitleFile}`,
      fileName: item.SubFileName,
      language: item.LanguageName || 'English',
      langCode: item.SubLanguageID || 'en',
      downloadUrl: item.SubDownloadLink,
      downloads: parseInt(item.SubDownloadsCnt, 10) || 0,
      isHearingImpaired: item.SubHearingImpaired === '1',
      format: item.SubFormat || 'srt',
      rating: item.SubRating || '0.0',
      source: 'OpenSubtitles',
    }));

    res.json({ query: cleaned, results });
  } catch (err) {
    console.error('Subtitle search error:', err.message);
    res.json({ query: cleaned, results: [] });
  }
});

// Download and convert online subtitle to WebVTT
app.get('/api/subtitles/download', async (req, res) => {
  const dlUrl = req.query.url;
  if (!dlUrl) {
    return res.status(400).send('Download URL is required');
  }

  try {
    const response = await fetch(dlUrl, {
      headers: {
        'User-Agent': 'TemporaryUserAgent',
      },
    });

    if (!response.ok) {
      return res.status(500).send('Failed to fetch subtitle file');
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    zlib.gunzip(buffer, (err, unzipped) => {
      let content = '';
      if (err) {
        content = buffer.toString('utf8');
      } else {
        content = unzipped.toString('utf8');
      }

      let vtt = content;
      if (!content.trim().startsWith('WEBVTT')) {
        const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        // Clean OpenSubtitles promotional text cues
        const cleanedLines = normalized
          .split('\n')
          .filter((line) => !/(opensubtitles|advertise your product|vip member|osdb\.link)/i.test(line));
        
        vtt = 'WEBVTT\n\n' + cleanedLines.join('\n').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
      }

      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(vtt);
    });
  } catch (err) {
    res.status(500).send('Error downloading subtitle: ' + err.message);
  }
});

// Serve torrent subtitle as WebVTT for HTML5 video
app.get('/api/torrent/:id/subtitle/:fileIndex', async (req, res) => {
  const torrent = await client.get(req.params.id);
  if (!torrent) return res.status(404).send('Torrent not found');
  const idx = parseInt(req.params.fileIndex, 10);
  const file = torrent.files && torrent.files[idx];
  if (!file) return res.status(404).send('Subtitle file not found');

  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');

  file.getBuffer((err, buffer) => {
    if (err) return res.status(500).send('Error reading subtitle: ' + err.message);
    const content = buffer.toString('utf8');
    if (content.startsWith('WEBVTT')) {
      return res.send(content);
    }
    const vtt = 'WEBVTT\n\n' + content
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    return res.send(vtt);
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

  let torrent = await getOrAddTorrent(magnetURI, { isStreamOnly: true });

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


  function streamFile() {
    clearTimeout(swarmTimeout);
    if (res.headersSent) return;

    if (!torrent.files || torrent.files.length === 0) {
      return res.status(404).send('No files found in torrent');
    }

    const file = torrent.files.reduce((a, b) => (a.length > b.length ? a : b));
    const mimeType = getMimeType(file.name);

    // Focus bandwidth on this file & sliding window
    try {
      torrent.files.forEach((f) => {
        if (f !== file && typeof f.deselect === 'function') f.deselect();
      });
      if (typeof file.select === 'function') file.select();
    } catch (e) {}

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range, Content-Type, Accept',
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
    };

    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : file.length - 1;
      const chunksize = end - start + 1;

      // Update sliding-window prefetcher to pull 50 pieces ahead of this byte offset
      updatePrefetchWindow(torrent, file, start);

      const head = {
        'Content-Range': `bytes ${start}-${end}/${file.length}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': mimeType,
        ...corsHeaders,
      };

      res.writeHead(206, head);
      if (req.method === 'HEAD') return res.end();
      const stream = file.createReadStream({ start, end });
      stream.on('error', () => {});
      stream.pipe(res);
      req.on('close', () => { try { stream.destroy(); } catch (e) {} });
    } else {
      updatePrefetchWindow(torrent, file, 0);
      const head = {
        'Content-Length': file.length,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `inline; filename="${encodeURIComponent(file.name)}"`,
        ...corsHeaders,
      };
      res.writeHead(200, head);
      if (req.method === 'HEAD') return res.end();
      const stream = file.createReadStream();
      stream.on('error', () => {});
      stream.pipe(res);
      req.on('close', () => { try { stream.destroy(); } catch (e) {} });
    }
  }
});

// Lossless on-the-fly Remux streaming endpoint for browser (MKV, TrueHD, DTS -> fMP4 / AAC with -c:v copy)
app.get('/api/stream/remux', async (req, res) => {
  let magnetURI = req.query.magnet;
  const { provider, desc, link, mode } = req.query;

  if (!magnetURI && provider && (desc || link)) {
    try {
      magnetURI = await TorrentSearchApi.getMagnet({ provider, desc, link });
    } catch (err) {
      return res.status(400).send('Could not fetch magnet URI: ' + err.message);
    }
  }

  if (!magnetURI) {
    return res.status(400).send('Magnet URI is required');
  }

  let torrent = await getOrAddTorrent(magnetURI, { isStreamOnly: true });

  const swarmTimeout = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).send('Swarm timeout: waiting for peers to begin streaming remux.');
    }
  }, 35000);

  if (torrent.ready) {
    startRemuxStream();
  } else {
    torrent.once('ready', startRemuxStream);
  }

  function startRemuxStream() {
    clearTimeout(swarmTimeout);
    if (res.headersSent) return;

    if (!torrent.files || torrent.files.length === 0) {
      return res.status(404).send('No files found in torrent');
    }

    const file = torrent.files.reduce((a, b) => (a.length > b.length ? a : b));

    // Focus bandwidth on this file & sliding window
    try {
      torrent.files.forEach((f) => {
        if (f !== file && typeof f.deselect === 'function') {
          f.deselect();
        }
      });
      if (typeof file.select === 'function') {
        file.select();
      }
      updatePrefetchWindow(torrent, file, 0);
    } catch (e) {}

    const isNativeMp4 = /\.(mp4|m4v|webm)$/i.test(file.name);
    // If the file is already native browser-compatible (MP4/WebM) and no transcoding is requested:
    // Bypass FFmpeg entirely and serve native seekable HTTP 206 Partial Content Range stream.
    // Works flawlessly and with zero CPU across Chrome, Edge, and Safari.
    if (isNativeMp4 && (mode === 'copy' || !mode || mode === 'direct' || mode === 'safari')) {
      const mimeType = getMimeType(file.name);
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Range, Content-Type, Accept',
        'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
      };

      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : file.length - 1;
        const chunksize = end - start + 1;

        updatePrefetchWindow(torrent, file, start);

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${file.length}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': mimeType,
          ...corsHeaders,
        });

        if (req.method === 'HEAD') return res.end();
        const stream = file.createReadStream({ start, end });
        stream.on('error', () => {});
        stream.pipe(res);
        req.on('close', () => { try { stream.destroy(); } catch (e) {} });
        return;
      } else {
        updatePrefetchWindow(torrent, file, 0);
        res.writeHead(200, {
          'Content-Length': file.length,
          'Content-Type': mimeType,
          'Accept-Ranges': 'bytes',
          'Content-Disposition': `inline; filename="${encodeURIComponent(file.name)}"`,
          ...corsHeaders,
        });

        if (req.method === 'HEAD') return res.end();
        const stream = file.createReadStream();
        stream.on('error', () => {});
        stream.pipe(res);
        req.on('close', () => { try { stream.destroy(); } catch (e) {} });
        return;
      }
    }

    // Video codec handling for MKV or requested transcode:
    let vCodecArgs = ['-c:v', 'copy'];
    const isDarwin = process.platform === 'darwin';

    if (mode === 'browser4k') {
      vCodecArgs = isDarwin
        ? ['-c:v', 'h264_videotoolbox', '-b:v', '14M', '-maxrate', '18M', '-bufsize', '24M', '-vf', 'scale=-2:2160', '-pix_fmt', 'yuv420p']
        : ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', 'main', '-level', '5.1', '-b:v', '14M', '-vf', 'scale=-2:2160', '-pix_fmt', 'yuv420p', '-bf', '0'];
    } else if (mode === 'transcode' || mode === '1080p') {
      vCodecArgs = isDarwin
        ? ['-c:v', 'h264_videotoolbox', '-b:v', '4.5M', '-maxrate', '6M', '-bufsize', '8M', '-vf', 'scale=-2:1080', '-pix_fmt', 'yuv420p']
        : ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', 'main', '-level', '4.2', '-b:v', '4.5M', '-vf', 'scale=-2:1080', '-pix_fmt', 'yuv420p', '-bf', '0'];
    } else if (mode === '720p') {
      vCodecArgs = isDarwin
        ? ['-c:v', 'h264_videotoolbox', '-b:v', '2.5M', '-maxrate', '3.5M', '-bufsize', '5M', '-vf', 'scale=-2:720', '-pix_fmt', 'yuv420p']
        : ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', 'baseline', '-level', '3.1', '-b:v', '2.5M', '-vf', 'scale=-2:720', '-pix_fmt', 'yuv420p', '-bf', '0'];
    } else if (mode === '480p') {
      vCodecArgs = isDarwin
        ? ['-c:v', 'h264_videotoolbox', '-b:v', '1.2M', '-maxrate', '1.8M', '-bufsize', '2.5M', '-vf', 'scale=-2:480', '-pix_fmt', 'yuv420p']
        : ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', 'baseline', '-level', '3.0', '-b:v', '1.2M', '-vf', 'scale=-2:480', '-pix_fmt', 'yuv420p', '-bf', '0'];
    }

    // Safari identifies copied HEVC in MP4 by the hvc1 sample entry. Many
    // remuxes arrive tagged hev1, which can produce a silent black player.
    const hevcTagArgs = mode === 'copy' && /(?:hevc|h\.265|x265)/i.test(file.name)
      ? ['-tag:v', 'hvc1']
      : [];

    // For transcode modes, force IDR keyframes every 2s so the browser can seek/start cleanly
    const gopArgs = (mode === 'copy' || mode === 'remux')
      ? []  // copy mode: no transcoding, no forced GOP
      : ['-g', '48', '-keyint_min', '24'];  // ~2s keyframe interval at 24fps

    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-fflags', '+discardcorrupt+genpts+igndts',
      '-probesize', mode === 'browser4k' ? '2M' : '8M',
      '-analyzeduration', mode === 'browser4k' ? '500k' : '1500k',
      '-i', 'pipe:0',
      '-avoid_negative_ts', 'make_zero',
      '-map', '0:v:0?',
      '-map', '0:a:0?',
      '-sn',
      '-dn',
      ...vCodecArgs,
      ...hevcTagArgs,
      ...gopArgs,
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ac', '2',
      '-ar', '48000',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-brand', 'mp42',
      '-max_interleave_delta', '0',
      '-flush_packets', '1',
      '-f', 'mp4',
      'pipe:1',
    ];

    const ff = spawn(FFMPEG_BIN, ffmpegArgs);
    const readStream = file.createReadStream();

    readStream.on('error', () => {});
    ff.stdin.on('error', () => {});
    ff.stdout.on('error', () => {});

    // Dynamic Sliding Window Prefetch tracking for FFmpeg pipeline
    let bytesRead = 0;
    let lastPrefetchByte = 0;
    const pieceSize = torrent.pieceLength || 2097152;
    readStream.on('data', (chunk) => {
      bytesRead += chunk.length;
      if (bytesRead - lastPrefetchByte > 3 * pieceSize) {
        lastPrefetchByte = bytesRead;
        updatePrefetchWindow(torrent, file, bytesRead);
      }
    });

    readStream.pipe(ff.stdin);
    let responseStarted = false;
    let initBuffer = Buffer.alloc(0);

    const writeResponseHeaders = () => {
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache, no-store',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Range, Content-Type, Accept',
      });
    };

    // Safari is strict about fragmented MP4 initialization. Do not send a
    // partial ftyp/moov box as the first HTTP chunk; hold only the small init
    // segment until the complete moov box is present.
    const hasCompleteInit = (buffer) => {
      const moovMarker = Buffer.from('moov');
      const markerAt = buffer.indexOf(moovMarker);
      if (markerAt < 4) return false;
      const boxStart = markerAt - 4;
      const boxSize = buffer.readUInt32BE(boxStart);
      return boxSize >= 8 && buffer.length >= boxStart + boxSize;
    };

    ff.stdout.on('data', (chunk) => {
      if (!responseStarted) {
        initBuffer = Buffer.concat([initBuffer, chunk]);
        if (!hasCompleteInit(initBuffer) && initBuffer.length < 2 * 1024 * 1024) return;
        responseStarted = true;
        writeResponseHeaders();
        res.write(initBuffer);
        return;
      }
      res.write(chunk);
    });
    ff.stdout.on('end', () => {
      if (!res.writableEnded) res.end();
    });

    ff.stderr.on('data', (data) => {
      console.error('FFmpeg stderr:', data.toString());
    });

    const cleanup = () => {
      try { readStream.destroy(); } catch (e) {}
      try { ff.kill('SIGKILL'); } catch (e) {}
    };

    req.on('close', cleanup);
    res.on('finish', cleanup);
    ff.on('error', (err) => {
      cleanup();
    });
  }
});

app.listen(port, () => {
  console.log(`Svorrent API running on http://localhost:${port}`);
  console.log(`Native downloads directory: ${DOWNLOAD_DIR}`);
});
