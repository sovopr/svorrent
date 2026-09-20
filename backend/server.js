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

const app = express();
const port = process.env.PORT || 3001;

// Path to FFmpeg binary
const FFMPEG_BIN = process.env.FFMPEG_PATH || (fs.existsSync('/Users/soveet/miniforge3/bin/ffmpeg') ? '/Users/soveet/miniforge3/bin/ffmpeg' : 'ffmpeg');

// Default download folder on user's Mac: ~/Downloads/Svorrent
const DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads', 'Svorrent');
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// Temporary streaming buffer cache (does NOT clutter ~/Downloads/Svorrent)
const STREAM_CACHE_DIR = path.join(os.tmpdir(), 'svorrent-cache');
if (fs.existsSync(STREAM_CACHE_DIR)) {
  try {
    fs.rmSync(STREAM_CACHE_DIR, { recursive: true, force: true });
  } catch (e) {}
}
fs.mkdirSync(STREAM_CACHE_DIR, { recursive: true });

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
    const isPermanent = opts.isPermanentDownload === true || (!opts.isStreamOnly && opts.path === DOWNLOAD_DIR);
    const savePath = opts.path || (isPermanent ? DOWNLOAD_DIR : STREAM_CACHE_DIR);
    torrent = client.add(magnetURI, {
      path: savePath,
    });
    torrent._isPermanentDownload = isPermanent;
    torrent._isStreamOnly = !isPermanent;
    torrent.on('error', (err) => {
      console.error('Torrent runtime error:', err.message);
    });
  } else if (opts.isPermanentDownload) {
    torrent._isPermanentDownload = true;
    torrent._isStreamOnly = false;
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
  const targetPath = torrent ? torrent.path : DOWNLOAD_DIR;
  const cmd = process.platform === 'win32'
    ? `explorer.exe "${targetPath}"`
    : process.platform === 'darwin'
    ? `open "${targetPath}"`
    : `xdg-open "${targetPath}"`;

  exec(cmd, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, path: targetPath });
  });
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

  const effectiveMagnet = torrent.magnetURI || magnetURI;
  const largestFile = torrent.files && torrent.files.length > 0
    ? torrent.files.reduce((a, b) => (a.length > b.length ? a : b))
    : null;

  const fullPath = largestFile ? path.join(torrent.path || DOWNLOAD_DIR, largestFile.path) : null;
  const fileExistsOnDisk = fullPath && fs.existsSync(fullPath) && fs.statSync(fullPath).size > 1048576;

  let targetPath = '';
  let streamModeUsed = false;

  if (fileExistsOnDisk) {
    targetPath = fullPath;
  } else {
    streamModeUsed = true;
    // Generate streaming M3U playlist file with direct sequential stream URL for VLC/IINA
    const cleanName = cleanMovieTitle(largestFile ? largestFile.name : torrent.name || 'stream');
    const m3uDir = path.join(os.tmpdir(), 'svorrent-playlists');
    if (!fs.existsSync(m3uDir)) fs.mkdirSync(m3uDir, { recursive: true });
    const m3uPath = path.join(m3uDir, `${torrent.infoHash || 'stream'}.m3u`);
    const streamUrl = `http://localhost:3001/api/stream?raw=true&magnet=${encodeURIComponent(effectiveMagnet)}`;
    const m3uContent = `#EXTM3U\n#EXTINF:-1,${cleanName} [Svorrent Stream]\n${streamUrl}\n`;
    fs.writeFileSync(m3uPath, m3uContent, 'utf8');
    targetPath = m3uPath;
  }

  // Build platform-specific launcher with VLC / IINA auto-detection
  let cmd = '';
  let playerName = 'Default Media Player';

  if (process.platform === 'darwin') {
    if (fs.existsSync('/Applications/IINA.app')) {
      cmd = `open -a "/Applications/IINA.app" "${targetPath}"`;
      playerName = 'IINA';
    } else if (fs.existsSync('/Applications/VLC.app')) {
      cmd = `open -a "/Applications/VLC.app" "${targetPath}"`;
      playerName = 'VLC Media Player';
    } else {
      cmd = `open -a VLC "${targetPath}" 2>/dev/null || open "${targetPath}"`;
      playerName = 'VLC / Default Player';
    }
  } else if (process.platform === 'win32') {
    const vlc64 = 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe';
    const vlc32 = 'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe';
    if (fs.existsSync(vlc64)) {
      cmd = `"${vlc64}" "${targetPath}"`;
      playerName = 'VLC Media Player';
    } else if (fs.existsSync(vlc32)) {
      cmd = `"${vlc32}" "${targetPath}"`;
      playerName = 'VLC Media Player';
    } else {
      cmd = `start "" "${targetPath}"`;
      playerName = 'Default Windows Player';
    }
  } else {
    cmd = `vlc "${targetPath}" 2>/dev/null || xdg-open "${targetPath}"`;
    playerName = 'VLC';
  }

  exec(cmd, (err) => {
    if (err) {
      console.error('Play native error:', err);
      const fallbackCmd = process.platform === 'darwin' ? `open "${targetPath}"` : `xdg-open "${targetPath}"`;
      exec(fallbackCmd, (fbErr) => {
        if (fbErr) {
          return res.status(500).json({ error: `Could not launch player: ${err.message}` });
        }
        res.json({ success: true, target: targetPath, player: playerName, streamMode: streamModeUsed });
      });
      return;
    }
    res.json({ success: true, target: targetPath, player: playerName, streamMode: streamModeUsed });
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
  const streamUrl = `http://localhost:3001/api/stream?raw=true&magnet=${encodeURIComponent(effectiveMagnet)}`;
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
  const largestFile = torrent.files && torrent.files.length > 0
    ? torrent.files.reduce((a, b) => (a.length > b.length ? a : b))
    : null;

  const subtitleFiles = torrent.files
    ? torrent.files
        .map((f, idx) => ({ index: idx, name: f.name, length: f.length }))
        .filter((f) => /\.(srt|vtt|sub|ass)$/i.test(f.name))
    : [];

  const pieceLength = torrent.pieceLength || 0;
  const startPiece = largestFile ? largestFile._startPiece : 0;
  const hasFirstPiece = torrent.bitfield && typeof torrent.bitfield.get === 'function' ? !!torrent.bitfield.get(startPiece) : false;

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
    etaSeconds,
    streamUrl: `http://localhost:3001/api/stream?raw=true&magnet=${encodeURIComponent(magnetURI)}`,
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

    // Focus 100% bandwidth on the streaming file and aggressively prioritize initial pieces
    try {
      torrent.files.forEach((f) => {
        if (f !== file && typeof f.deselect === 'function') {
          f.deselect();
        }
      });
      if (typeof file.select === 'function') {
        file.select();
      }
      // Prioritize the first 3 pieces needed for immediate header & playback
      if (typeof torrent.select === 'function' && typeof file._startPiece === 'number') {
        torrent.select(file._startPiece, file._startPiece + 2, 7);
      }
    } catch (e) {}

    // Video codec handling:
    // 'copy' = 100% untouched bit-for-bit native quality (preserves 4K UHD, HDR, HEVC/AVC without any re-encoding loss)
    // '1080p' / 'transcode' = Hardware-accelerated 1080p transcode (Apple Silicon VideoToolbox / Windows NVENC / QuickSync)
    // '720p' = Fast 720p transcode (5 Mbps)
    // '480p' = Efficient 480p transcode (2 Mbps)
    let vCodecArgs = ['-c:v', 'copy'];
    const isDarwin = process.platform === 'darwin';

    if (mode === 'transcode' || mode === '1080p') {
      vCodecArgs = isDarwin
        ? ['-c:v', 'h264_videotoolbox', '-b:v', '12M', '-vf', 'scale=-2:1080', '-pix_fmt', 'yuv420p']
        : ['-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '10M', '-vf', 'scale=-2:1080', '-pix_fmt', 'yuv420p'];
    } else if (mode === '720p') {
      vCodecArgs = isDarwin
        ? ['-c:v', 'h264_videotoolbox', '-b:v', '5M', '-vf', 'scale=-2:720', '-pix_fmt', 'yuv420p']
        : ['-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '5M', '-vf', 'scale=-2:720', '-pix_fmt', 'yuv420p'];
    } else if (mode === '480p') {
      vCodecArgs = isDarwin
        ? ['-c:v', 'h264_videotoolbox', '-b:v', '2M', '-vf', 'scale=-2:480', '-pix_fmt', 'yuv420p']
        : ['-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '2M', '-vf', 'scale=-2:480', '-pix_fmt', 'yuv420p'];
    }

    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel', 'error',
      '-probesize', '1048576',
      '-analyzeduration', '1000000',
      '-fflags', '+nobuffer+fastseek',
      '-flush_packets', '1',
      '-i', 'pipe:0',
      '-map', '0:v:0',
      '-map', '0:a:0?',
      ...vCodecArgs,
      '-c:a', 'aac',
      '-b:a', '384k',
      '-ac', '2',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1',
    ];

    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'none',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
    });

    const ff = spawn(FFMPEG_BIN, ffmpegArgs);
    const readStream = file.createReadStream();

    readStream.pipe(ff.stdin);
    ff.stdout.pipe(res);

    ff.stderr.on('data', (data) => {
      console.error('FFmpeg stderr:', data.toString());
    });

    torrent._activeStreamListeners = (torrent._activeStreamListeners || 0) + 1;

    const cleanup = () => {
      try { readStream.destroy(); } catch (e) {}
      try { ff.kill('SIGKILL'); } catch (e) {}

      // If stream-only, decrement active listeners and purge temp cache from disk when idle
      if (torrent._isStreamOnly && !torrent._isPermanentDownload) {
        torrent._activeStreamListeners = Math.max(0, (torrent._activeStreamListeners || 1) - 1);
        if (torrent._activeStreamListeners === 0) {
          setTimeout(() => {
            if (torrent._isStreamOnly && !torrent._isPermanentDownload && (!torrent._activeStreamListeners || torrent._activeStreamListeners === 0)) {
              torrent.destroy({ destroyStore: true }, () => {
                console.log(`Auto-purged temporary stream cache for: ${torrent.infoHash}`);
              });
            }
          }, 15000);
        }
      }
    };

    req.on('close', cleanup);
    res.on('finish', cleanup);
    ff.on('error', (err) => {
      console.error('FFmpeg process error:', err.message);
      cleanup();
    });
  }
});

app.listen(port, () => {
  console.log(`Svorrent API running on http://localhost:${port}`);
  console.log(`Native downloads directory: ${DOWNLOAD_DIR}`);
});
