// Persistent Downloaded Torrents History Engine
// Tracks all torrents that have been fully downloaded in Svorrent.
// Persists indefinitely across app restarts and torrent deletions so that
// search results can accurately indicate when a torrent was previously downloaded,
// allowing the user to 1-click "Download again".

import fs from 'node:fs';
import path from 'node:path';
import { normalizeTitleForDedup, parseSizeToBytes } from './indexer.js';

const isInfoHash = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value.trim());

function writeAtomic(filePath, data) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

export class DownloadHistory {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.historyFile = path.join(dataDir, 'download-history.json');
    this.records = new Map(); // infoHash (lowercase) -> record
    this.titleKeys = new Map(); // titleKey -> infoHash
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.historyFile)) {
        const raw = fs.readFileSync(this.historyFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && isInfoHash(item.infoHash)) {
              const hash = item.infoHash.trim().toLowerCase();
              this.records.set(hash, {
                infoHash: hash,
                name: String(item.name || 'Unknown'),
                magnetURI: typeof item.magnetURI === 'string' ? item.magnetURI : '',
                length: Number(item.length) || 0,
                completedAt: Number(item.completedAt) || Date.now(),
                lastSeenAt: Number(item.lastSeenAt) || Date.now(),
              });
              this._indexTitle(item.name, item.length, hash);
            }
          }
        }
      }
    } catch (err) {
      console.warn('[history] Failed to load download history:', err.message);
    }
  }

  _indexTitle(title, size, hash) {
    if (!title || typeof title !== 'string' || !hash) return;
    const norm = normalizeTitleForDedup(title);
    const rawNorm = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    let sizeMb = 0;
    if (typeof size === 'number' && Number.isFinite(size) && size > 0) {
      sizeMb = Math.round(size / (1024 * 1024));
    } else if (typeof size === 'string') {
      sizeMb = Math.round(parseSizeToBytes(size) / (1024 * 1024));
    }
    for (const key of [norm, rawNorm]) {
      if (!key) continue;
      if (sizeMb > 0) {
        this.titleKeys.set(`${key}|${sizeMb}`, hash);
      }
      if (!this.titleKeys.has(key)) {
        this.titleKeys.set(key, hash);
      }
    }
  }

  save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const list = Array.from(this.records.values());
      writeAtomic(this.historyFile, JSON.stringify(list, null, 2));
    } catch (err) {
      console.warn('[history] Failed to save download history:', err.message);
    }
  }

  record(torrentOrMeta) {
    if (!torrentOrMeta || typeof torrentOrMeta !== 'object') return false;
    const rawHash = torrentOrMeta.infoHash;
    if (!isInfoHash(rawHash)) return false;

    const hash = rawHash.trim().toLowerCase();
    const existing = this.records.get(hash);
    const now = Date.now();

    const record = {
      infoHash: hash,
      name: String(torrentOrMeta.name || torrentOrMeta.title || existing?.name || 'Unknown'),
      magnetURI: torrentOrMeta.magnetURI || torrentOrMeta.magnet || existing?.magnetURI || '',
      length: Number(torrentOrMeta.length || torrentOrMeta.sizeBytes) || existing?.length || 0,
      completedAt: existing?.completedAt || now,
      lastSeenAt: now,
    };

    this.records.set(hash, record);
    this._indexTitle(record.name, record.length, hash);
    this.save();
    return true;
  }

  has(infoHash, title, size) {
    if (infoHash && typeof infoHash === 'string') {
      const cleanHash = infoHash.trim().toLowerCase();
      if (this.records.has(cleanHash)) return true;
    }

    if (title && typeof title === 'string') {
      const norm = normalizeTitleForDedup(title);
      const rawNorm = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      let sizeMb = 0;
      if (typeof size === 'number' && Number.isFinite(size) && size > 0) {
        sizeMb = Math.round(size / (1024 * 1024));
      } else if (typeof size === 'string') {
        sizeMb = Math.round(parseSizeToBytes(size) / (1024 * 1024));
      }

      for (const key of [norm, rawNorm]) {
        if (!key) continue;
        if (sizeMb > 0 && this.titleKeys.has(`${key}|${sizeMb}`)) {
          return true;
        }
      }
    }

    return false;
  }

  get(infoHash) {
    if (!infoHash || typeof infoHash !== 'string') return null;
    return this.records.get(infoHash.trim().toLowerCase()) || null;
  }

  getAll() {
    return Array.from(this.records.values()).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
  }

  getHashes() {
    return Array.from(this.records.keys());
  }

  delete(infoHash) {
    if (!infoHash || typeof infoHash !== 'string') return false;
    const hash = infoHash.trim().toLowerCase();
    if (this.records.delete(hash)) {
      this.save();
      return true;
    }
    return false;
  }

  clear() {
    this.records.clear();
    this.titleKeys.clear();
    try {
      if (fs.existsSync(this.historyFile)) {
        fs.unlinkSync(this.historyFile);
      }
    } catch {}
  }

  seedFromArchive(archive) {
    if (!archive || typeof archive.getAll !== 'function') return;
    try {
      const archived = archive.getAll();
      let added = false;
      for (const item of archived) {
        if (item && isInfoHash(item.infoHash)) {
          const hash = item.infoHash.trim().toLowerCase();
          if (!this.records.has(hash)) {
            this.records.set(hash, {
              infoHash: hash,
              name: String(item.name || 'Unknown'),
              magnetURI: typeof item.magnetURI === 'string' ? item.magnetURI : '',
              length: Number(item.length) || 0,
              completedAt: Number(item.savedAt) || Date.now(),
              lastSeenAt: Date.now(),
            });
            this._indexTitle(item.name, item.length, hash);
            added = true;
          }
        }
      }
      if (added) {
        this.save();
      }
    } catch (err) {
      console.warn('[history] Seed from archive warning:', err.message);
    }
  }

  seedFromTorrents(torrents) {
    if (!Array.isArray(torrents)) return;
    let added = false;
    for (const t of torrents) {
      if (!t || !isInfoHash(t.infoHash)) continue;
      if (t.done || t.progress === 1) {
        const hash = t.infoHash.trim().toLowerCase();
        if (!this.records.has(hash)) {
          this.records.set(hash, {
            infoHash: hash,
            name: String(t.name || 'Unknown'),
            magnetURI: typeof t.magnetURI === 'string' ? t.magnetURI : '',
            length: Number(t.length) || 0,
            completedAt: Date.now(),
            lastSeenAt: Date.now(),
          });
          this._indexTitle(t.name, t.length, hash);
          added = true;
        }
      }
    }
    if (added) {
      this.save();
    }
  }
}
