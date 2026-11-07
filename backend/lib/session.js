// Download session persistence.
//
// Saves every permanent download (with its .torrent metadata and verified
// piece bitfield) so that after a restart downloads resume instantly:
//   - no waiting for metadata from the swarm (the info dict is stored)
//   - no full re-hash of existing data (the bitfield is trusted, with
//     WebTorrent spot-checking a couple of pieces per file)

import fs from 'node:fs';
import path from 'node:path';

export function createSession(dataDir) {
  const file = path.join(dataDir, 'session.json');
  fs.mkdirSync(dataDir, { recursive: true });

  const load = () => {
    try {
      const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(entries) ? entries.filter((entry) => entry && typeof entry === 'object') : null;
    } catch {
      return null;
    }
  };

  const save = (torrents) => {
    const existingMap = new Map();
    try {
      const currentOnDisk = load() || [];
      for (const e of currentOnDisk) {
        if (typeof e.infoHash === 'string') existingMap.set(e.infoHash.toLowerCase(), e);
      }
    } catch {}

    const entries = torrents
      .filter((t) => t._isPermanentDownload && !t.destroyed)
      .map((t) => {
        const hashKey = (t.infoHash || '').toLowerCase();
        const existing = existingMap.get(hashKey);

        let bitfieldStr = null;
        if (t.ready && t.bitfield) {
          bitfieldStr = Buffer.from(t.bitfield.buffer.buffer, t.bitfield.buffer.byteOffset, t.bitfield.buffer.byteLength).toString('base64');
        } else if (t._savedBitfield) {
          bitfieldStr = t._savedBitfield;
        } else if (existing?.bitfield) {
          bitfieldStr = existing.bitfield;
        }

        let torrentFileStr = null;
        if (t.torrentFile) {
          torrentFileStr = Buffer.from(t.torrentFile).toString('base64');
        } else if (t._savedTorrentFile) {
          torrentFileStr = t._savedTorrentFile;
        } else if (existing?.torrentFile) {
          torrentFileStr = existing.torrentFile;
        }

        return {
          infoHash: t.infoHash,
          magnet: t.magnetURI || existing?.magnet,
          name: t.name || existing?.name,
          path: t.path || existing?.path,
          paused: !!t._pausedManually,
          addedAt: t._addedAt || existing?.addedAt || Date.now(),
          torrentFile: torrentFileStr,
          bitfield: bitfieldStr,
          knownPeers: t._knownPeers ? Array.from(t._knownPeers).slice(-100) : (existing?.knownPeers || []),
          adoptedFromBrowser: t._adoptedFromBrowser || existing?.adoptedFromBrowser || null,
        };
      });

    // Write atomically so a crash mid-write never corrupts the session.
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(entries));
      fs.renameSync(tmp, file);
    } catch (err) {
      console.warn('[session] save failed:', err.message);
    }
  };

  return { load, save };
}
