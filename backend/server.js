import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import net from 'node:net';
import dgram from 'node:dgram';
import { spawn, execFile } from 'node:child_process';
import TorrentSearchApi from 'torrent-search-api';
import WebTorrent from 'webtorrent';
import Wire from 'bittorrent-protocol';
import peerid from 'bittorrent-peerid';
import { createTrackerList } from './lib/trackers.js';
import { createSession } from './lib/session.js';
import { NetworkManager } from './lib/networks.js';
import { TorrentArchive } from './lib/archive.js';
import { FolderScanner } from './lib/scanner.js';
import { resolveDoH } from './lib/doh.js';
import {
  cleanMagnet,
  extractInfoHash,
  waitForInfoHash,
  setTorrentPaused,
  installSwarmPipelineAccelerator,
  updateCriticalFrontier,
} from './lib/torrents.js';
import { createSettingsManager } from './lib/settings.js';
import { localAccess } from './lib/local-access.js';
import { childPath, hasSafeParent } from './lib/safe-path.js';
import geoip from 'geoip-lite';
import {
  assessTorrentPlayability,
  assessFolderItemPlayability,
  findPrimaryVideoInTorrent,
  findPrimaryVideoInFolder,
  launchMediaPlayer,
} from './lib/playability.js';
import { AutoUpdater } from './lib/updater.js';

function parseClientString(v) {
  if (!v) return 'Unknown';
  if (typeof v === 'string') return v.trim() || 'Unknown';
  if (Buffer.isBuffer(v)) return v.toString('utf8').trim() || 'Unknown';
  if (Array.isArray(v)) return Buffer.from(v).toString('utf8').trim() || 'Unknown';
  if (typeof v === 'object') {
    const vals = Object.values(v);
    if (vals.length > 0 && vals.every((n) => typeof n === 'number')) {
      return Buffer.from(vals).toString('utf8').trim() || 'Unknown';
    }
  }
  return String(v).trim() || 'Unknown';
}

// Pre-computed 8-bit popcount table for ultra-fast bitfield progress calculation
const BIT_COUNT_TABLE = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let count = 0;
  let n = i;
  while (n > 0) {
    count += n & 1;
    n >>= 1;
  }
  BIT_COUNT_TABLE[i] = count;
}

function computeWireProgress(wire, totalPieces) {
  if (!wire?.peerPieces || !totalPieces || totalPieces <= 0) return 0;

  // Ultra-fast path: read raw bitfield buffer using precomputed popcount table
  const buf = wire.peerPieces.buffer;
  if (buf && Buffer.isBuffer(buf)) {
    let count = 0;
    const len = buf.length;
    for (let i = 0; i < len; i++) {
      count += BIT_COUNT_TABLE[buf[i]];
    }
    return Math.min(100, Math.round((count / totalPieces) * 100));
  }

  // Fast sampling fallback for very large swarms
  if (totalPieces > 500) {
    const samples = 250;
    const step = totalPieces / samples;
    let have = 0;
    for (let i = 0; i < samples; i++) {
      if (wire.peerPieces.get(Math.floor(i * step))) have++;
    }
    return Math.round((have / samples) * 100);
  }

  let have = 0;
  for (let i = 0; i < totalPieces; i++) {
    if (wire.peerPieces.get(i)) have++;
  }
  return Math.round((have / totalPieces) * 100);
}

function getWireClientName(wire) {
  let rawClient = 'Unknown';
  if (wire?.peerExtendedHandshake?.v) {
    rawClient = wire.peerExtendedHandshake.v;
  } else if (wire?.peerId) {
    try {
      const parsed = peerid(wire.peerId);
      if (parsed?.client) {
        rawClient = `${parsed.client} ${parsed.version || ''}`.trim();
      }
    } catch {}
  }
  return parseClientString(rawClient);
}

function getPeerGeo(remoteIp) {
  if (!remoteIp || remoteIp === '127.0.0.1' || remoteIp.startsWith('10.') || remoteIp.startsWith('192.168.') || remoteIp.startsWith('172.16.')) {
    return { country: 'unknown', countryCode: '??', city: '', region: '', ll: null };
  }
  try {
    const lookup = geoip.lookup(remoteIp);
    if (lookup) {
      return {
        country: lookup.country ? lookup.country.toLowerCase() : 'unknown',
        countryCode: lookup.country || '??',
        city: lookup.city || '',
        region: lookup.region || '',
        ll: lookup.ll || null,
      };
    }
  } catch {}
  return { country: 'unknown', countryCode: '??', city: '', region: '', ll: null };
}

const app = express();
const port = process.env.PORT || 3001;
const host = '127.0.0.1';

// Default download folder: ~/Downloads/Svorrent
const DOWNLOAD_DIR = path.resolve(process.env.SVORRENT_DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads', 'Svorrent'));
function ensureDownloadDir() {
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }
}

// App data (session, tracker cache) lives in ~/.svorrent
const DATA_DIR = path.resolve(process.env.SVORRENT_DATA_DIR || path.join(os.homedir(), '.svorrent'));
const disablePublicDiscovery = process.env.SVORRENT_DISABLE_PUBLIC_DISCOVERY === '1';
const TRACKERS = disablePublicDiscovery ? [] : createTrackerList(DATA_DIR);

// ---------------------------------------------------------------------------
// BitTorrent Engine Configuration
// ---------------------------------------------------------------------------

function isPortFree(testPort) {
  const tcp = new Promise((resolve) => {
    const srv = net.createServer().once('error', () => resolve(false));
    srv.listen(testPort, () => srv.close(() => resolve(true)));
  });
  const udp = new Promise((resolve) => {
    const sock = dgram.createSocket('udp4').once('error', () => resolve(false));
    sock.bind(testPort, () => sock.close(() => resolve(true)));
  });
  return Promise.all([tcp, udp]).then(([a, b]) => a && b);
}

async function pickPort(preferred) {
  for (let p = preferred; p < preferred + 10; p += 2) {
    if ((await isPortFree(p)) && (await isPortFree(p + 1))) return p;
  }
  return 0;
}

const TORRENT_PORT = await pickPort(Number(process.env.TORRENT_PORT) || 51413);
const limit = (v) => (v ? Number(v) * 1024 : -1);

const BASE_MAX_CONNS = Number(process.env.MAX_CONNS) || 120;

const client = new WebTorrent({
  secure: 1, // Protocol Encryption (PE) with plaintext fallback
  maxConns: BASE_MAX_CONNS,
  torrentPort: TORRENT_PORT,
  dhtPort: TORRENT_PORT ? TORRENT_PORT + 1 : 0,
  dht: !disablePublicDiscovery,
  // Plexo architecture patterns for multi-interface bonding:
  utp: false, // Must be false: uTP UDP sockets bypass TCP localAddress binding; TCP guarantees per-interface routing
  webSeeds: false, // Disable web seeds so HTTP doesn't bypass multi-interface socket striping
  lsd: false, // Disable local peer discovery to avoid unrouted broadcast swarms
  natUpnp: false, // Disable UPnP port mapping
  natPmp: false, // Disable NAT-PMP port mapping
  downloadLimit: limit(process.env.DOWNLOAD_LIMIT_KB),
  uploadLimit: limit(process.env.UPLOAD_LIMIT_KB),
  tracker: { announce: TRACKERS, wrtc: false }, // Disable WebRTC so all peers go through TCP connect hook
});

client.on('error', (err) => console.error('[engine] client error:', err.message));
client.on('listening', () => {
  console.log(`[engine] listening on port ${client.torrentPort} (TCP/uTP), DHT on ${client.dhtPort}`);
});
if (!Wire.nativeRC4) {
  console.warn('[engine] Native RC4 unavailable; start with `npm start` (--openssl-legacy-provider) for max speed.');
}

const networkManager = new NetworkManager(() => client);
const archive = new TorrentArchive(DATA_DIR);
const settingsManager = createSettingsManager(DATA_DIR);
const folderScanner = new FolderScanner(DOWNLOAD_DIR, () => client, () => archive);

// ---------------------------------------------------------------------------
// Session Persistence & Archive
// ---------------------------------------------------------------------------

const session = createSession(DATA_DIR);
let shuttingDown = false;
let restoringSession = true;
const saveSession = () => {
  if (shuttingDown || restoringSession) return;
  session.save(client.torrents);
  if (client.torrents) {
    for (const t of client.torrents) {
      if (t.ready && t._isPermanentDownload) {
        archive.save(t);
      }
    }
  }
};

let saveSessionTimer = null;
const scheduleSaveSession = (delay = 2000) => {
  if (shuttingDown || saveSessionTimer) return;
  saveSessionTimer = setTimeout(() => {
    saveSessionTimer = null;
    saveSession();
  }, delay);
};

const sessionInterval = setInterval(() => {
  saveSession();
}, 5 * 1000).unref();

async function restoreSession() {
  let entries = session.load();
  if (entries === null) {
    const archived = archive.getAll();
    if (archived && archived.length > 0) {
      console.log(`[session] Restoring ${archived.length} torrent(s) from persistent archive...`);
      entries = archived.map((a) => ({
        infoHash: a.infoHash,
        magnet: a.magnetURI,
        name: a.name,
        path: a.path || DOWNLOAD_DIR,
        paused: false,
        addedAt: a.savedAt,
        torrentFile: archive.get(a.infoHash)?.torrentBuffer?.toString('base64'),
      }));
    }
  }
  if (!entries || !entries.length) return;
  console.log(`[session] Restoring ${entries.length} torrent(s) from persistent state...`);

  for (const entry of entries) {
    if (shuttingDown) break;
    try {
      const source = entry.torrentFile
        ? Buffer.from(entry.torrentFile, 'base64')
        : (entry.magnet ? enrichMagnetWithTrackers(entry.magnet) : null);

      if (!source) continue;

      const addOpts = {
        path: entry.path || DOWNLOAD_DIR,
        paused: !!entry.paused,
      };
      if (entry.bitfield) {
        try {
          addOpts.bitfield = Buffer.from(entry.bitfield, 'base64');
        } catch {}
      }

      if (await client.get(source)) continue;
      const torrent = client.add(source, addOpts);
      if (torrent) {
        torrent._isPermanentDownload = true;
        torrent._addedAt = entry.addedAt || Date.now();
        if (entry.bitfield) torrent._savedBitfield = entry.bitfield;
        if (entry.torrentFile) torrent._savedTorrentFile = entry.torrentFile;
        if (entry.paused) {
          torrent._pausedManually = true;
        }
        if (Array.isArray(entry.knownPeers) && entry.knownPeers.length > 0) {
          torrent._knownPeers = new Set(entry.knownPeers);
        }
        setupTorrentHooks(torrent);
      }
    } catch (err) {
      console.warn(`[session] Failed to restore ${entry.name || entry.infoHash}:`, err.message);
    }
  }
}

// Process lifecycle guards
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err.message));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

async function shutdownCleanup() {
  if (shuttingDown) return;
  console.log('\nSvorrent shutting down — saving session state...');
  saveSession();
  shuttingDown = true;
  clearInterval(sessionInterval);
  clearTimeout(saveSessionTimer);
  networkManager.destroy();
  httpServer.close();
  const deadline = setTimeout(() => process.exit(1), 10000);
  deadline.unref();
  try {
    await new Promise((resolve) => client.destroy(resolve));
  } catch {}
  process.exit(process.exitCode || 0);
}
process.on('SIGINT', () => {
  console.log('[server] received SIGINT');
  shutdownCleanup();
});
process.on('SIGTERM', () => {
  console.log('[server] received SIGTERM');
  shutdownCleanup();
});

// This daemon can read and delete local files. Do not expose it to the LAN or
// permit an arbitrary website to call its unauthenticated API through a browser.
app.use(localAccess);
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ app: 'svorrent', status: 'ok' });
});

app.get('/api/config', (_req, res) => {
  const home = os.homedir();
  const downloadDir = DOWNLOAD_DIR.startsWith(`${home}${path.sep}`)
    ? `~${DOWNLOAD_DIR.slice(home.length)}`
    : DOWNLOAD_DIR;
  res.json({ downloadDir, settings: settingsManager.get() });
});

app.get('/api/settings', (_req, res) => {
  res.json(settingsManager.get());
});

app.post('/api/settings', (req, res) => {
  const { autoStopSeeding } = req.body || {};
  const updated = settingsManager.update({
    ...(typeof autoStopSeeding === 'boolean' ? { autoStopSeeding } : {}),
  });

  if (updated.autoStopSeeding && client?.torrents) {
    for (const t of client.torrents) {
      if (t.done && !t.destroyed && !t._pausedManually) {
        setTorrentPaused(t, true);
      }
    }
    saveSession();
  }

  res.json(updated);
});

app.post('/api/torrents/stop-all-seeding', (_req, res) => {
  let count = 0;
  if (client?.torrents) {
    for (const t of client.torrents) {
      if (t.done && !t.destroyed && !t._pausedManually) {
        setTorrentPaused(t, true);
        count++;
      }
    }
    saveSession();
  }
  res.json({ success: true, count });
});

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pkg = require('./package.json');
const currentVersion = pkg.version || '1.0.5';
let currentCommit = null;
try {
  currentCommit = JSON.parse(fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8')).commit;
  if (!/^[0-9a-f]{40}$/i.test(currentCommit)) currentCommit = null;
} catch {}
if (!currentCommit) {
  try {
    const { execFileSync } = require('node:child_process');
    const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname, encoding: 'utf8', timeout: 2000 }).trim();
    if (/^[0-9a-f]{40}$/i.test(gitSha)) currentCommit = gitSha.toLowerCase();
  } catch {}
}

const autoUpdater = new AutoUpdater({
  currentVersion,
  currentCommit,
  repo: 'sovopr/svorrent',
});
if (!disablePublicDiscovery) {
  autoUpdater.start();
}

app.get('/api/updater/status', (_req, res) => {
  res.json(autoUpdater.getStatus());
});

app.post('/api/updater/check', async (_req, res) => {
  const status = await autoUpdater.checkForUpdates();
  res.json(status);
});

app.post('/api/updater/restart', async (_req, res) => {
  try {
    const result = await autoUpdater.applyUpdate();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Keep the configured provider explicit so unavailable indexes do not delay search.
TorrentSearchApi.disableAllProviders();
TorrentSearchApi.enableProvider('ThePirateBay');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function enrichMagnetWithTrackers(magnetURI) {
  if (typeof magnetURI !== 'string' || !magnetURI.startsWith('magnet:?')) return magnetURI;
  const existing = new Set();
  for (const match of magnetURI.matchAll(/(?:^|&)tr=([^&]*)/g)) {
    try {
      existing.add(decodeURIComponent(match[1]));
    } catch {
      existing.add(match[1]);
    }
  }
  const additions = TRACKERS
    .filter((tr) => !existing.has(tr))
    .slice(0, 12)
    .map((tr) => `tr=${encodeURIComponent(tr)}`);
  return additions.length > 0 ? `${magnetURI}&${additions.join('&')}` : magnetURI;
}

function setupTorrentHooks(torrent) {
  if (!torrent || torrent._hooksConfigured) return;
  torrent._hooksConfigured = true;

  installSwarmPipelineAccelerator(torrent);

  torrent.on('error', (err) => {
    console.error(`[torrent error] [${torrent.name || torrent.infoHash}]:`, err.message);
  });

  // Fast Ramp-Up: immediately unchoke and signal interest on connection
  torrent.on('wire', (wire) => {
    networkManager.trackWire(torrent, wire);
    if (torrent._pausedManually || torrent.paused) {
      wire.destroy();
      return;
    }
    if (wire.remoteAddress && wire.remotePort) {
      if (!torrent._knownPeers) torrent._knownPeers = new Set();
      if (torrent._knownPeers.size < 150) {
        torrent._knownPeers.add(`${wire.remoteAddress}:${wire.remotePort}`);
      }
    }
    try {
      if (typeof wire.unchoke === 'function') wire.unchoke();
      if (typeof wire.interested === 'function') wire.interested();
    } catch {}
  });

  const recordDiscoveredPeers = () => {
    if (torrent.discovery) {
      torrent.discovery.on('peer', (peer) => {
        if (typeof peer === 'string' && peer.includes(':')) {
          if (!torrent._knownPeers) torrent._knownPeers = new Set();
          if (torrent._knownPeers.size < 150) {
            torrent._knownPeers.add(peer);
          }
        }
      });
    }
  };
  if (torrent.discovery) recordDiscoveredPeers();
  else torrent.once('infoHash', recordDiscoveredPeers);

  const applyPriorities = () => {
    if (!torrent.pieces || torrent.pieces.length === 0) return;
    const lastPiece = torrent.pieces.length - 1;
    const primary = findPrimaryVideoInTorrent(torrent, torrent.path || DOWNLOAD_DIR);

    // 1. Full torrent sequential download baseline
    torrent.select(0, lastPiece, 0);

    let fileStart = 0;
    let fileEnd = lastPiece;
    if (primary?.file && typeof primary.file._startPiece === 'number') {
      fileStart = primary.file._startPiece;
      fileEnd = primary.file._endPiece;
    }
    torrent._primaryStartPiece = fileStart;
    torrent._primaryEndPiece = fileEnd;

    const headCount = Math.min(20, fileEnd - fileStart);
    const tailCount = Math.min(15, fileEnd - fileStart);
    const tailStart = Math.max(fileStart, fileEnd - tailCount);

    // 2. High-priority stream selections: bypass sequential order so MP4 moov atom downloads immediately
    if (typeof torrent._select === 'function') {
      torrent._select(tailStart, fileEnd, 5, null, true);
      torrent._select(fileStart, fileStart + headCount, 4, null, true);
    }

    if (typeof torrent.critical === 'function') {
      torrent.critical(tailStart, fileEnd);
      torrent.critical(fileStart, fileStart + headCount);
    }

    updateCriticalFrontier(torrent);
  };
  torrent._applyPriorities = applyPriorities;

  const onReady = () => {
    // Sequential Strategy: commits pieces to disk and bitfield in order so restarts/failures resume seamlessly
    torrent.strategy = 'sequential';
    if (torrent.done) {
      torrent.maxConns = 15;
    }
    if (torrent._pausedManually || torrent.paused) {
      setTorrentPaused(torrent, true);
      saveSession();
      return;
    }
    applyPriorities();
    if (torrent.wires) {
      torrent.wires.forEach((w) => {
        try {
          w.unchoke();
          w.interested();
        } catch {}
      });
    }
    archive.save(torrent);
    saveSession();
  };

  if (torrent.ready) {
    onReady();
  } else {
    torrent.once('ready', onReady);
  }

  torrent.on('verified', () => {
    updateCriticalFrontier(torrent);
    scheduleSaveSession();
  });

  torrent.on('done', () => {
    console.log(`[torrent done] Download completed: ${torrent.name || torrent.infoHash}`);
    archive.save(torrent);
    if (settingsManager.get().autoStopSeeding) {
      console.log(`[torrent done] autoStopSeeding enabled - stopping seeding for: ${torrent.name || torrent.infoHash}`);
      setTorrentPaused(torrent, true);
    } else {
      torrent.maxConns = 15;
    }
    saveSession();
  });
}

let addQueue = Promise.resolve();
function getOrAddTorrent(source, opts = {}) {
  // Serialise lookup + initialization: infoHash is assigned asynchronously,
  // so concurrent requests could otherwise create a doomed duplicate torrent.
  const pending = addQueue.then(() => addTorrent(source, opts));
  addQueue = pending.catch(() => {});
  return pending;
}

async function addTorrent(magnetURI, opts = {}) {
  if (shuttingDown) throw new Error('Server is shutting down');
  magnetURI = cleanMagnet(magnetURI);
  const targetInfoHash = extractInfoHash(magnetURI);
  magnetURI = enrichMagnetWithTrackers(magnetURI);
  let torrent = targetInfoHash ? await client.get(targetInfoHash) : await client.get(magnetURI);

  if (!torrent) {
    ensureDownloadDir();
    const addOpts = { path: opts.path || DOWNLOAD_DIR };

    if (opts.bitfield) {
      addOpts.bitfield = opts.bitfield;
    } else if (targetInfoHash) {
      try {
        const savedEntries = session.load() || [];
        const existing = savedEntries.find((e) => e.infoHash?.toLowerCase() === targetInfoHash.toLowerCase());
        if (existing?.bitfield) {
          addOpts.bitfield = Buffer.from(existing.bitfield, 'base64');
        }
      } catch {}
    }

    try {
      torrent = client.add(magnetURI, addOpts);
    } catch (addErr) {
      console.warn('client.add error:', addErr.message);
      if (targetInfoHash) torrent = await client.get(targetInfoHash);
    }

    if (!torrent && targetInfoHash) {
      torrent = await client.get(targetInfoHash);
    }

    if (torrent) {
      torrent._isPermanentDownload = true;
      torrent._addedAt = Date.now();
      if (addOpts.bitfield) {
        torrent._savedBitfield = Buffer.isBuffer(addOpts.bitfield) ? addOpts.bitfield.toString('base64') : addOpts.bitfield;
      }
      setupTorrentHooks(torrent);
      await waitForInfoHash(torrent);
    }
  } else {
    torrent._isPermanentDownload = true;
    setupTorrentHooks(torrent);
  }
  if (!torrent) throw new Error('Failed to add torrent');
  saveSession();
  folderScanner.invalidateCache();
  return torrent;
}

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------

// 1. Search enabled indexers with bounded provider timeouts
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'Search query is required' });
  }

  try {
    const activeProviders = TorrentSearchApi.getActiveProviders();
    const searchPromises = activeProviders.map(async (provider) => {
      try {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Provider timeout')), 2500)
        );
        const searchPromise = TorrentSearchApi.search([provider.name], query, 'All', 40);
        const results = await Promise.race([searchPromise, timeoutPromise]);
        return Array.isArray(results) ? results : [];
      } catch (err) {
        console.warn(`[search] Provider ${provider.name} timed out or failed:`, err.message);
        return [];
      }
    });

    const resultsByProvider = await Promise.all(searchPromises);
    const flattened = resultsByProvider.flat();

    // Deduplicate by title + size
    const seen = new Set();
    const deduplicated = [];
    for (const item of flattened) {
      const key = `${item.title || ''}|${item.size || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduplicated.push(item);
    }

    const sorted = deduplicated.sort((a, b) => (parseInt(b.seeds, 10) || 0) - (parseInt(a.seeds, 10) || 0));
    res.json(sorted);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Failed to search torrents' });
  }
});

app.get('/api/search/doh-check', async (req, res) => {
  const testHost = req.query.host || 'thepiratebay.org';
  const ip = await resolveDoH(testHost);
  res.json({
    host: testHost,
    resolvedIp: ip,
    dohActive: !!ip,
  });
});

// 2. Resolve magnet link
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

// 3. Add & start download to disk
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

// 4. List all downloads (active torrents + files directly in the downloads folder)
app.get('/api/torrents', (req, res) => {
  const activeHashes = new Set();
  const list = client.torrents.map((t) => {
    activeHashes.add(t.infoHash);
    const largestFile = t.files && t.files.length > 0
      ? t.files.reduce((a, b) => (a.length > b.length ? a : b))
      : null;

    const isPaused = !!(t.paused || t._pausedManually);
    const playability = assessTorrentPlayability(t, DOWNLOAD_DIR);

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
      uploaded: t.uploaded || 0,
      length: t.length || (largestFile ? largestFile.length : 0),
      path: t.path || DOWNLOAD_DIR,
      timeRemaining: isPaused ? Infinity : (t.timeRemaining || 0),
      fileName: largestFile ? largestFile.name : null,
      filesCount: t.files ? t.files.length : 0,
      isFolderFile: false,
      playability,
    };
  });

  // Directly include files present in the download folder if not already active
  try {
    const folderInfo = folderScanner.scan();
    const orphanItems = (folderInfo.items || []).filter((item) => item.status !== 'active');

    for (const item of orphanItems) {
      const isRecoverable = item.status === 'recoverable';
      const id = isRecoverable && item.recoverable?.infoHash
        ? item.recoverable.infoHash
        : `local-${Buffer.from(item.name).toString('hex')}`;

      if (activeHashes.has(id)) continue;

      const totalLen = isRecoverable && item.recoverable?.totalLength
        ? item.recoverable.totalLength
        : item.sizeOnDisk;
      const progress = isRecoverable && item.recoverable
        ? (item.recoverable.estimatedProgress / 100)
        : 1;

      const playability = assessFolderItemPlayability(item);

      list.push({
        infoHash: id,
        magnet: isRecoverable ? item.recoverable.magnetURI : null,
        name: item.name,
        ready: true,
        paused: isRecoverable, // Incomplete items appear paused/ready-to-resume
        done: !isRecoverable,  // Fully present items appear completed
        progress,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 0,
        downloaded: item.sizeOnDisk,
        length: totalLen,
        path: item.absolutePath,
        timeRemaining: 0,
        fileName: item.name,
        filesCount: item.innerFileCount || 1,
        isFolderFile: true,
        isRecoverable,
        folderItemName: item.name,
        recoverable: item.recoverable || null,
        mtime: item.mtime,
        playability,
      });
    }
  } catch (e) {
    console.warn('[server] Error scanning local folder for /api/torrents:', e.message);
  }

  res.json(list);
});

// 5. Details inspector (files, peers, piece map, trackers)
app.get('/api/torrent/:id/nerd-stats', async (req, res) => {
  const torrent = await client.get(req.params.id);
  if (!torrent) {
    return res.status(404).json({ error: 'Torrent not found' });
  }

  const peers = (torrent.wires || []).map((wire) => {
    const clientName = getWireClientName(wire);
    const peerProgress = computeWireProgress(wire, torrent.pieces?.length || 0);
    const iface = networkManager.getWireInterface(wire);
    const remoteIp = wire.remoteAddress || '127.0.0.1';
    const geo = getPeerGeo(remoteIp);

    return {
      ip: remoteIp,
      port: wire.remotePort || 0,
      client: clientName,
      type: wire.type || 'tcp',
      downloadSpeed: typeof wire.downloadSpeed === 'function' ? wire.downloadSpeed() : 0,
      uploadSpeed: typeof wire.uploadSpeed === 'function' ? wire.uploadSpeed() : 0,
      downloaded: wire.downloaded || 0,
      uploaded: wire.uploaded || 0,
      choked: !!wire.peerChoking,
      interested: !!wire.peerInterested,
      progress: peerProgress,
      networkInterface: iface ? iface.name : null,
      networkDevice: iface ? iface.device : null,
      geo,
    };
  });

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

    const blocksCount = Math.min(total, 240);
    const step = total / blocksCount;
    const grid = [];
    for (let i = 0; i < blocksCount; i++) {
      const pieceIdx = Math.floor(i * step);
      const isDone = torrent.bitfield.get(pieceIdx);
      const isDownloading = !isDone && torrent.pieces[pieceIdx] && torrent.pieces[pieceIdx].missing < torrent.pieces[pieceIdx].length;
      grid.push(isDone ? 2 : isDownloading ? 1 : 0);
    }

    const tailPiecesStatus = [];
    if (torrent.bitfield && total > 0) {
      for (let p = Math.max(0, total - 15); p < total; p++) {
        tailPiecesStatus.push({ piece: p, verified: !!torrent.bitfield.get(p) });
      }
    }

    pieceStats = {
      total,
      pieceLength: torrent.pieceLength,
      verified: verifiedCount,
      tailPieces: tailPiecesStatus,
      selections: (torrent._selections?._items || []).map((s) => ({ from: s.from, to: s.to, priority: s.priority, isStream: !!s.isStreamSelection })),
      grid,
    };
  }

  const announceUrls = torrent.announce || [];
  const trackerList = announceUrls.map((url) => ({
    url,
    status: 'Announced',
    seeds: torrent.numPeers || 0,
    peers: torrent.wires ? torrent.wires.length : 0,
  }));

  const dhtNodes = client.dht?._rpc?.nodes?.toArray?.()?.length ?? client.dht?._rpc?.nodes?.length ?? 0;

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
    name: torrent.name || 'Resolving metadata...',
    ready: !!torrent.ready,
    done: !!torrent.done,
    paused: isPaused,
    progress: torrent.progress || 0,
    downloadSpeed: isPaused ? 0 : (torrent.downloadSpeed || 0),
    uploadSpeed: isPaused ? 0 : (torrent.uploadSpeed || 0),
    numPeers: isPaused ? 0 : (torrent.numPeers || 0),
    downloaded: torrent.downloaded || 0,
    uploaded: torrent.uploaded || 0,
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

// 5b. Swarm intelligence & peer geolocation map aggregation
app.get('/api/swarm', (req, res) => {
  const { id } = req.query;
  let torrents = client.torrents || [];
  if (id) {
    torrents = torrents.filter((t) => t.infoHash === id.toLowerCase());
  }

  const allPeers = [];
  const countryMap = new Map();
  const interfaceMap = new Map();

  for (const t of torrents) {
    if (!t.wires) continue;
    for (const wire of t.wires) {
      const remoteIp = wire.remoteAddress || '127.0.0.1';
      const geo = getPeerGeo(remoteIp);
      const iface = networkManager.getWireInterface(wire);
      const ifaceName = iface ? iface.name : 'Default';
      const ifaceDevice = iface ? iface.device : 'en0';
      const ifaceType = iface ? iface.type : 'wifi';

      const clientStr = getWireClientName(wire);
      const downSpeed = typeof wire.downloadSpeed === 'function' ? wire.downloadSpeed() : 0;
      const upSpeed = typeof wire.uploadSpeed === 'function' ? wire.uploadSpeed() : 0;
      const peerProgress = computeWireProgress(wire, t.pieces?.length || 0);

      const peerItem = {
        ip: remoteIp,
        port: wire.remotePort || 0,
        client: clientStr,
        protocol: wire._utp ? 'uTP' : (wire.type === 'webrtc' ? 'WebRTC' : 'TCP'),
        geo,
        networkInterface: ifaceName,
        networkDevice: ifaceDevice,
        networkType: ifaceType,
        downloadSpeed: downSpeed,
        uploadSpeed: upSpeed,
        downloaded: wire.downloaded || 0,
        uploaded: wire.uploaded || 0,
        progress: peerProgress,
        choked: !!wire.peerChoking,
        interested: !!wire.peerInterested,
        torrentHash: t.infoHash,
        torrentName: t.name || 'Unknown',
      };

      allPeers.push(peerItem);

      // Aggregate country
      const cCode = geo.countryCode;
      if (cCode && cCode !== '??') {
        if (!countryMap.has(cCode)) {
          countryMap.set(cCode, {
            code: cCode,
            iso: geo.country,
            city: geo.city,
            count: 0,
            downSpeed: 0,
            upSpeed: 0,
          });
        }
        const c = countryMap.get(cCode);
        c.count++;
        c.downSpeed += downSpeed;
        c.upSpeed += upSpeed;
      }

      // Aggregate interface
      if (!interfaceMap.has(ifaceDevice)) {
        interfaceMap.set(ifaceDevice, {
          device: ifaceDevice,
          name: ifaceName,
          type: ifaceType,
          count: 0,
          downSpeed: 0,
        });
      }
      const im = interfaceMap.get(ifaceDevice);
      im.count++;
      im.downSpeed += downSpeed;
    }
  }

  const countries = Array.from(countryMap.values()).sort((a, b) => b.count - a.count);
  const interfaces = Array.from(interfaceMap.values());

  // Piece completion and swarm availability telemetry
  let pieceTelemetry = null;
  const targetTorrent = id ? torrents.find((t) => t.infoHash === id.toLowerCase()) : (torrents[0] || null);
  if (targetTorrent && targetTorrent.pieces && targetTorrent.bitfield) {
    const totalPieces = targetTorrent.pieces.length;
    let verifiedCount = 0;
    for (let i = 0; i < totalPieces; i++) {
      if (targetTorrent.bitfield.get(i)) verifiedCount++;
    }

    const blocksCount = Math.min(totalPieces, 140);
    const step = totalPieces / blocksCount;
    const piecesGrid = [];
    const availability = [];
    const numWires = targetTorrent.wires ? targetTorrent.wires.length : 0;

    for (let i = 0; i < blocksCount; i++) {
      const pieceIdx = Math.floor(i * step);
      const isDone = targetTorrent.bitfield.get(pieceIdx);
      const isDownloading = !isDone && targetTorrent.pieces[pieceIdx] && targetTorrent.pieces[pieceIdx].missing < targetTorrent.pieces[pieceIdx].length;
      piecesGrid.push(isDone ? 2 : isDownloading ? 1 : 0);

      let peersWithPiece = 0;
      if (targetTorrent.wires) {
        for (const w of targetTorrent.wires) {
          if (w.peerPieces?.get(pieceIdx)) peersWithPiece++;
        }
      }
      availability.push(numWires > 0 ? Math.min(100, Math.round((peersWithPiece / numWires) * 100)) : 0);
    }

    let streamingCursor = totalPieces;
    for (let i = 0; i < totalPieces; i++) {
      if (!targetTorrent.bitfield.get(i)) {
        streamingCursor = i;
        break;
      }
    }

    pieceTelemetry = {
      totalPieces,
      pieceLength: targetTorrent.pieceLength || 0,
      verifiedPieces: verifiedCount,
      progressPercent: Math.min(100, Math.round((verifiedCount / totalPieces) * 100)),
      streamingCursorPiece: streamingCursor,
      streamingCursorPercent: totalPieces > 0 ? Math.round((streamingCursor / totalPieces) * 100) : 0,
      piecesGrid,
      availability,
    };
  }

  res.json({
    peers: allPeers,
    summary: {
      totalPeers: allPeers.length,
      countriesCount: countries.length,
      countries,
      interfaces,
    },
    pieceTelemetry,
  });
});

// 6. Pause torrent
app.post('/api/torrent/:id/pause', async (req, res) => {
  const torrent = await client.get(req.params.id);
  if (!torrent) return res.status(404).json({ error: 'Torrent not found' });

  setTorrentPaused(torrent, true);

  saveSession();
  res.json({ success: true, paused: true });
});

// 7. Resume torrent
app.post('/api/torrent/:id/resume', async (req, res) => {
  const torrent = await client.get(req.params.id);
  if (!torrent) return res.status(404).json({ error: 'Torrent not found' });

  setTorrentPaused(torrent, false);

  saveSession();
  res.json({ success: true, paused: false });
});

// 8. Delete torrent
app.post('/api/torrent/:id/delete', async (req, res) => {
  const torrent = await client.get(req.params.id);
  if (!torrent) return res.status(404).json({ error: 'Torrent not found' });
  const { deleteFiles } = req.body;

  const torrentName = torrent.name;
  const basePath = torrent.path ? torrent.path : DOWNLOAD_DIR;
  const targetPath = torrentName ? childPath(basePath, torrentName) : null;
  const filePaths = (torrent.files || []).map((f) => childPath(basePath, f.path));

  if (deleteFiles && ((torrentName && !targetPath) ||
      (!targetPath && filePaths.length === 0) || filePaths.some((fp) => !fp))) {
    return res.status(400).json({ error: 'Torrent contains an unsafe file path' });
  }
  if (deleteFiles && [targetPath, ...filePaths].some((fp) => fp && fs.existsSync(fp) &&
      !hasSafeParent(basePath, fp))) {
    return res.status(400).json({ error: 'Torrent file resolves outside its download folder' });
  }

  if (deleteFiles) {
    archive.remove(req.params.id);
  }

  torrent.destroy({ destroyStore: false }, () => {
    if (deleteFiles) {
      try {
        if (targetPath && fs.existsSync(targetPath)) {
          fs.rmSync(targetPath, { recursive: true, force: true });
        } else {
          for (const fp of filePaths) {
            if (fs.existsSync(fp)) {
              fs.rmSync(fp, { recursive: true, force: true });
            }
          }
        }
      } catch (err) {
        console.warn('[delete] Failed to remove files from disk:', err.message);
      }
      folderScanner.invalidateCache();
    }
    saveSession();
    res.json({ success: true, deleted: true, filesDeleted: !!deleteFiles });
  });
});

// 9. Reveal in Finder / File Explorer
app.post('/api/torrent/:id/open-finder', async (req, res) => {
  const torrent = await client.get(req.params.id);
  ensureDownloadDir();

  let targetFile = null;
  let basePath = DOWNLOAD_DIR;

  if (torrent) {
    const configuredPath = torrent.path ? torrent.path : DOWNLOAD_DIR;
    basePath = fs.existsSync(configuredPath) ? configuredPath : DOWNLOAD_DIR;
    const largestFile = torrent.files?.length
      ? torrent.files.reduce((a, b) => (a.length > b.length ? a : b))
      : null;
    const candidateFile = largestFile?.path ? childPath(basePath, largestFile.path) : null;
    targetFile = candidateFile && fs.existsSync(candidateFile) ? candidateFile : null;
  } else if (req.params.id && req.params.id !== 'root') {
    const candidate = childPath(DOWNLOAD_DIR, req.params.id);
    if (candidate && fs.existsSync(candidate)) {
      targetFile = candidate;
    }
  }

  let openSettled = false;
  const onOpen = (err) => {
    if (openSettled) return;
    openSettled = true;
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, path: targetFile || basePath });
  };

  if (process.platform === 'darwin') {
    return spawn('open', targetFile ? ['-R', targetFile] : [basePath]).on('error', onOpen).on('close', (code) => {
      if (code !== 0) return onOpen(new Error('Finder could not open the download location'));
      onOpen(null);
    });
  }
  if (process.platform === 'win32') {
    const explorerArgs = targetFile ? [`/select,${targetFile}`] : [basePath];
    return execFile('explorer.exe', explorerArgs, onOpen);
  }

  execFile('xdg-open', [basePath], onOpen);
});

// 10. Play Video in VLC / Default Media Player
app.post('/api/torrent/:id/play', async (req, res) => {
  try {
    const torrent = await client.get(req.params.id);
    let targetPath = null;
    let targetName = null;

    if (torrent) {
      const primary = findPrimaryVideoInTorrent(torrent, DOWNLOAD_DIR);
      if (primary?.fullPath && fs.existsSync(primary.fullPath)) {
        targetPath = primary.fullPath;
        targetName = primary.name;
      }
    } else {
      const folderInfo = folderScanner.scan();
      const item = (folderInfo.items || []).find((it) => {
        const isRec = it.status === 'recoverable';
        const itId = isRec && it.recoverable?.infoHash
          ? it.recoverable.infoHash
          : `local-${Buffer.from(it.name).toString('hex')}`;
        return itId === req.params.id || it.name === req.params.id;
      });

      if (item) {
        const primary = findPrimaryVideoInFolder(item);
        if (primary?.fullPath && fs.existsSync(primary.fullPath)) {
          targetPath = primary.fullPath;
          targetName = primary.name;
        }
      }
    }

    if (!targetPath) {
      return res.status(404).json({ error: 'Playable media file not found on disk' });
    }

    launchMediaPlayer(targetPath, (err, player) => {
      if (err) {
        console.error('[server] Error launching media player:', err.message);
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true, player, file: targetName, path: targetPath });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Network Aggregation & Multi-Interface Bonding (Inspired by Plexo)
// ---------------------------------------------------------------------------

app.get('/api/networks', async (req, res) => {
  if (req.query.rescan) {
    const snap = await networkManager.rescan();
    return res.json(snap);
  }
  res.json(networkManager.getSnapshot());
});

app.post('/api/networks/:id/toggle', (req, res) => {
  const { id } = req.params;
  const { enabled } = req.body;
  networkManager.toggleInterface(id, !!enabled);
  res.json({ success: true, ...networkManager.getSnapshot() });
});

// ---------------------------------------------------------------------------
// Local Download Folder Inspection & Halfway Download Recovery
// ---------------------------------------------------------------------------

// 1. Get on-disk folder files & halfway downloads status
app.get('/api/folder-files', (req, res) => {
  res.json(folderScanner.scan());
});

// 2. Resume halfway or untracked download
app.post('/api/folder-files/resume', async (req, res) => {
  const { infoHash, magnet } = req.body;

  try {
    let source = magnet;
    let targetPath = DOWNLOAD_DIR;

    if (infoHash) {
      const archived = archive.get(infoHash);
      if (archived) {
        source = archived.torrentBuffer || archived.magnetURI || `magnet:?xt=urn:btih:${infoHash}`;
        if (archived.path) targetPath = archived.path;
      } else {
        source = `magnet:?xt=urn:btih:${infoHash}`;
      }
    }

    if (!source) {
      return res.status(400).json({ error: 'infoHash or magnet is required to resume download' });
    }

    const torrent = await getOrAddTorrent(source, { path: targetPath });
    if (!torrent) {
      return res.status(500).json({ error: 'Failed to add torrent to client' });
    }

    torrent._isPermanentDownload = true;
    setTorrentPaused(torrent, false);

    // Trigger local files verification if already ready
    if (torrent.ready && typeof torrent.rescanFiles === 'function') {
      try { torrent.rescanFiles(); } catch {}
    }

    saveSession();
    res.json({
      success: true,
      resumed: true,
      infoHash: torrent.infoHash,
      name: torrent.name || 'Resolving metadata...',
    });
  } catch (err) {
    console.error('[resume error]:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 3. Delete unwanted file or directory from DOWNLOAD_DIR
app.post('/api/folder-files/delete', (req, res) => {
  const { name } = req.body;
  try {
    const result = folderScanner.deleteItem(name);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 4. Force recheck existing torrent files on disk
app.post('/api/torrent/:id/recheck', async (req, res) => {
  const torrent = await client.get(req.params.id);
  if (!torrent) return res.status(404).json({ error: 'Torrent not found' });

  if (typeof torrent.rescanFiles === 'function') {
    torrent.rescanFiles((err) => {
      if (err) return res.status(500).json({ error: err.message });
      saveSession();
      res.json({
        success: true,
        progress: torrent.progress || 0,
        downloaded: torrent.downloaded || 0,
      });
    });
  } else {
    res.json({ success: true, progress: torrent.progress || 0 });
  }
});

// ---------------------------------------------------------------------------
// Static Web App Serving
// ---------------------------------------------------------------------------
const frontendDistCandidates = [
  path.resolve(__dirname, '../frontend/dist'),
  path.resolve(__dirname, 'frontend/dist'),
  path.resolve(__dirname, '../dist'),
  path.resolve(__dirname, './dist')
];
const frontendDist = frontendDistCandidates.find((d) => fs.existsSync(d));
if (frontendDist) {
  app.use(express.static(frontendDist));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) {
      return res.sendFile(path.join(frontendDist, 'index.html'));
    }
    next();
  });
}

// ---------------------------------------------------------------------------
// Server Initialization
// ---------------------------------------------------------------------------

const httpServer = app.listen(port, host, () => {
  console.log(`Svorrent API running on http://localhost:${port}`);
  console.log(`Native downloads directory: ${DOWNLOAD_DIR}`);
  restoreSession().catch((err) => console.error('[session] restore error:', err.message)).finally(() => {
    restoringSession = false;
    saveSession();
  });
});
httpServer.on('error', (err) => {
  console.error('[server] HTTP listener failed:', err.message);
  process.exitCode = 1;
  shutdownCleanup();
});
