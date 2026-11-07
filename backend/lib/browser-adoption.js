import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';

const KNOWN_BROWSER_SUFFIXES = ['.crdownload', '.part', '.download', '.fdownload', '.tmp'];

export function normalizeMediaName(name = '') {
  if (!name || typeof name !== 'string') return '';
  let clean = name.trim();
  for (const suffix of KNOWN_BROWSER_SUFFIXES) {
    if (clean.toLowerCase().endsWith(suffix)) {
      clean = clean.slice(0, -suffix.length);
      break;
    }
  }
  // Remove trailing browser duplicate suffixes like " (1)"
  clean = clean.replace(/\s*\(\d+\)$/, '');
  // Remove file extension
  const ext = path.extname(clean);
  if (ext) clean = clean.slice(0, -ext.length);
  // Normalize delimiters to single spaces
  return clean
    .toLowerCase()
    .replace(/[\.\-_\s\[\]\(\)\+]+/g, ' ')
    .trim();
}

export function getSystemDownloadsDir() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Downloads') : path.join(home, 'Downloads');
  }
  return path.join(home, 'Downloads');
}

export function findBrowserCandidates(targetFileName, targetFileSize, options = {}) {
  const candidates = [];
  if (!targetFileName || typeof targetFileName !== 'string') return candidates;

  const candidateDirs = new Set();
  const sysDownloads = getSystemDownloadsDir();
  if (sysDownloads && fs.existsSync(sysDownloads)) candidateDirs.add(sysDownloads);

  if (options.downloadDir && fs.existsSync(options.downloadDir)) {
    candidateDirs.add(options.downloadDir);
    const parent = path.dirname(options.downloadDir);
    if (fs.existsSync(parent)) candidateDirs.add(parent);
  }

  if (options.searchDirs && Array.isArray(options.searchDirs)) {
    for (const d of options.searchDirs) {
      if (d && fs.existsSync(d)) candidateDirs.add(d);
    }
  }

  const normTarget = normalizeMediaName(targetFileName);
  const targetExt = path.extname(targetFileName).toLowerCase();

  for (const baseDir of candidateDirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(baseDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(baseDir, entry.name);
      if (options.excludePath && path.resolve(fullPath) === path.resolve(options.excludePath)) continue;

      // 1. Safari (.download bundle directory)
      if (entry.isDirectory() && entry.name.toLowerCase().endsWith('.download')) {
        const rawBase = entry.name.slice(0, -9);
        const normBase = normalizeMediaName(rawBase);
        if (normBase && (normBase === normTarget || normBase.includes(normTarget) || normTarget.includes(normBase))) {
          try {
            const innerFiles = fs.readdirSync(fullPath);
            for (const inner of innerFiles) {
              if (inner === 'Info.plist' || inner.startsWith('.')) continue;
              const innerPath = path.join(fullPath, inner);
              const stat = fs.statSync(innerPath);
              if (stat.isFile() && stat.size > 1024 * 1024) {
                candidates.push({
                  browser: 'Safari',
                  type: 'safari-bundle',
                  name: inner,
                  path: innerPath,
                  bundleDir: fullPath,
                  size: stat.size,
                  mtime: stat.mtimeMs,
                  percent: targetFileSize > 0 ? Math.min(100, Math.round((stat.size / targetFileSize) * 1000) / 10) : 0,
                });
              }
            }
          } catch {}
        }
        continue;
      }

      // 2. Chromium / Chrome / Edge / Brave / Opera (.crdownload)
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.crdownload')) {
        const normBase = normalizeMediaName(entry.name);
        if (normBase && (normBase === normTarget || normBase.includes(normTarget) || normTarget.includes(normBase))) {
          try {
            const stat = fs.statSync(fullPath);
            if (stat.size > 1024 * 1024) {
              candidates.push({
                browser: 'Chrome / Edge',
                type: 'crdownload',
                name: entry.name,
                path: fullPath,
                size: stat.size,
                mtime: stat.mtimeMs,
                percent: targetFileSize > 0 ? Math.min(100, Math.round((stat.size / targetFileSize) * 1000) / 10) : 0,
              });
            }
          } catch {}
        }
        continue;
      }

      // 3. Mozilla Firefox (.part)
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.part')) {
        const normBase = normalizeMediaName(entry.name);
        if (normBase && (normBase === normTarget || normBase.includes(normTarget) || normTarget.includes(normBase))) {
          try {
            const stat = fs.statSync(fullPath);
            if (stat.size > 1024 * 1024) {
              candidates.push({
                browser: 'Firefox',
                type: 'firefox-part',
                name: entry.name,
                path: fullPath,
                size: stat.size,
                mtime: stat.mtimeMs,
                percent: targetFileSize > 0 ? Math.min(100, Math.round((stat.size / targetFileSize) * 1000) / 10) : 0,
              });
            }
          } catch {}
        }
        continue;
      }

      // 4. Direct / Completed or Stalled File in parent Downloads folder
      if (entry.isFile() && !entry.name.startsWith('.')) {
        const entryExt = path.extname(entry.name).toLowerCase();
        const normBase = normalizeMediaName(entry.name);
        if (normBase && (normBase === normTarget) && (!targetExt || !entryExt || entryExt === targetExt)) {
          try {
            const stat = fs.statSync(fullPath);
            if (stat.size > 1024 * 1024) {
              candidates.push({
                browser: 'Downloads folder',
                type: 'direct-file',
                name: entry.name,
                path: fullPath,
                size: stat.size,
                mtime: stat.mtimeMs,
                percent: targetFileSize > 0 ? Math.min(100, Math.round((stat.size / targetFileSize) * 1000) / 10) : 0,
              });
            }
          } catch {}
        }
      }
    }
  }

  // Sort by size descending (prefer candidate with the most downloaded data)
  return candidates.sort((a, b) => b.size - a.size);
}

export function findBestCandidateForTorrent(torrent, options = {}) {
  if (!torrent || torrent.done || torrent._adoptedFromBrowser || torrent._adoptingBrowser) return null;
  const files = Array.isArray(torrent.files) && torrent.files.length > 0
    ? torrent.files
    : [{ name: torrent.name, path: torrent.name, length: torrent.length || 0 }];

  // Find largest file in torrent
  const primaryFile = files.reduce((max, f) => (f.length > (max.length || 0) ? f : max), files[0]);
  if (!primaryFile || !primaryFile.name) return null;

  const targetPath = path.resolve(torrent.path || options.downloadDir || '', primaryFile.path || primaryFile.name);
  const candidates = findBrowserCandidates(primaryFile.name, primaryFile.length || torrent.length || 0, {
    ...options,
    excludePath: targetPath,
  });

  if (candidates.length === 0) return null;
  const best = candidates[0];

  // Only return if candidate has significantly more data than Svorrent currently has verified
  const currentDownloaded = Number(torrent.downloaded) || 0;
  if (best.size <= currentDownloaded + 1024 * 1024) {
    return null;
  }

  return {
    ...best,
    targetFile: primaryFile.name,
    targetPath,
    targetLength: primaryFile.length || torrent.length || 0,
  };
}

export function closeStoreFiles(torrent) {
  if (!torrent || !torrent.store) return Promise.resolve();
  return new Promise((resolve) => {
    let s = torrent.store;
    while (s && s.store) {
      s = s.store;
    }
    if (s && Array.isArray(s.files) && s.files.length > 0) {
      let pending = s.files.length;
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const timer = setTimeout(finish, 1000);
      for (const f of s.files) {
        if (typeof f.open === 'function') {
          f.open((err, raf) => {
            if (!err && raf && typeof raf.close === 'function') {
              raf.close(() => {
                pending--;
                if (pending <= 0) {
                  clearTimeout(timer);
                  finish();
                }
              });
            } else {
              pending--;
              if (pending <= 0) {
                clearTimeout(timer);
                finish();
              }
            }
          });
        } else {
          pending--;
          if (pending <= 0) {
            clearTimeout(timer);
            finish();
          }
        }
      }
    } else {
      resolve();
    }
  });
}

export function reopenTorrentStore(torrent) {
  if (!torrent || !torrent.store || !torrent._store) return;
  const ImmediateCtor = torrent.store.constructor;
  const CacheCtor = torrent.store.store ? torrent.store.store.constructor : null;
  const RawCtor = torrent._store;

  try {
    let rawStore = new RawCtor(torrent.pieceLength, {
      ...torrent.storeOpts,
      torrent: torrent,
      path: torrent.path,
      files: torrent.files,
      length: torrent.length,
      name: torrent.name + ' - ' + torrent.infoHash.slice(0, 8),
      addUID: torrent.addUID,
      rootDir: torrent.rootDir,
      max: torrent._storeCacheSlots || 20,
    });

    if (CacheCtor && (torrent._storeCacheSlots || 20) > 0) {
      rawStore = new CacheCtor(rawStore, { max: torrent._storeCacheSlots || 20 });
    }

    torrent.store = new ImmediateCtor(rawStore);
  } catch (err) {
    console.warn('[browser-adoption] Reopening store warning:', err.message);
  }
}

export async function stitchSplitDownload(sourcePath, targetPath, torrent, targetLength) {
  if (!fs.existsSync(sourcePath)) return null;
  const stat = fs.statSync(sourcePath);
  if (stat.size >= targetLength || !torrent.pieceLength || !torrent._hashes) return null;

  const pieceLen = torrent.pieceLength;
  const numPieces = torrent.pieces ? torrent.pieces.length : Math.ceil(targetLength / pieceLen);
  const lastPieceIndex = numPieces - 1;
  const lastPieceExpectedLen = torrent.lastPieceLength || (targetLength - lastPieceIndex * pieceLen);
  const lastPieceExpectedHash = torrent._hashes[lastPieceIndex];
  if (!lastPieceExpectedHash) return null;

  // Check if last piece of sourcePath matches the torrent's last piece
  const fdSrc = fs.openSync(sourcePath, 'r');
  try {
    const tailBuf = Buffer.alloc(lastPieceExpectedLen);
    const readBytes = fs.readSync(fdSrc, tailBuf, 0, lastPieceExpectedLen, stat.size - lastPieceExpectedLen);
    if (readBytes !== lastPieceExpectedLen) return null;
    const tailHash = crypto.createHash('sha1').update(tailBuf).digest('hex').toLowerCase();
    if (tailHash !== lastPieceExpectedHash.toLowerCase()) {
      return null; // Not a tail-matching split download
    }

    const missingMiddle = targetLength - stat.size;

    // Binary search head matching pieces
    let low = 0;
    let high = Math.min(numPieces - 1, Math.floor(stat.size / pieceLen));
    let headValid = 0;
    const testBuf = Buffer.alloc(pieceLen);

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      fs.readSync(fdSrc, testBuf, 0, pieceLen, mid * pieceLen);
      const h = crypto.createHash('sha1').update(testBuf).digest('hex').toLowerCase();
      if (h === torrent._hashes[mid].toLowerCase()) {
        headValid = mid + 1;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    // Binary search tail matching pieces
    low = headValid;
    high = numPieces - 1;
    let tailStart = numPieces;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const torrentOff = mid * pieceLen;
      const dlOff = torrentOff - missingMiddle;
      if (dlOff < 0) {
        low = mid + 1;
        continue;
      }
      const curLen = Math.min(pieceLen, targetLength - torrentOff);
      fs.readSync(fdSrc, testBuf, 0, curLen, dlOff);
      const slice = curLen === pieceLen ? testBuf : testBuf.subarray(0, curLen);
      const h = crypto.createHash('sha1').update(slice).digest('hex').toLowerCase();
      if (h === torrent._hashes[mid].toLowerCase()) {
        tailStart = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    const tailValid = numPieces - tailStart;
    if (tailValid <= 0) return null;

    console.log(`[browser-adoption] Split download detected! Head: ${headValid} pieces, Tail: ${tailValid} pieces (missing middle: ${(missingMiddle / (1024*1024*1024)).toFixed(2)} GB). Stitching...`);

    // Clone source to target first (provides head instantly via APFS clone)
    if (process.platform === 'darwin') {
      try {
        execFileSync('cp', ['-c', '-f', sourcePath, targetPath]);
      } catch {
        fs.copyFileSync(sourcePath, targetPath);
      }
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }

    const headEndOffset = headValid * pieceLen;
    const tailSrcOffset = tailStart * pieceLen - missingMiddle;
    const tailDstOffset = tailStart * pieceLen;
    const tailBytes = targetLength - tailDstOffset;

    // 1. Truncate target to headEndOffset to discard old tail immediately in 0ms
    // 2. Expand target to targetLength creating a sparse hole for the middle gap in 0ms
    fs.truncateSync(targetPath, headEndOffset);
    fs.truncateSync(targetPath, targetLength);

    // 3. Asynchronously stream the tail pieces without blocking the event loop
    const readStream = fs.createReadStream(sourcePath, {
      start: tailSrcOffset,
      end: tailSrcOffset + tailBytes - 1,
      highWaterMark: 16 * 1024 * 1024,
    });
    const writeStream = fs.createWriteStream(targetPath, {
      start: tailDstOffset,
      flags: 'r+',
      highWaterMark: 16 * 1024 * 1024,
    });

    await pipeline(readStream, writeStream);

    return {
      stitched: true,
      headPieces: headValid,
      tailPieces: tailValid,
      totalValidPieces: headValid + tailValid,
    };
  } finally {
    fs.closeSync(fdSrc);
  }
}

export function cleanupCandidateSource(candidate, targetPath) {
  if (!candidate || !candidate.path) return;
  const resolvedSrc = path.resolve(candidate.path);
  const resolvedDst = targetPath ? path.resolve(targetPath) : null;

  // Never delete if the source path happens to be the same file as target
  if (resolvedDst && resolvedSrc === resolvedDst) return;

  try {
    if (fs.existsSync(resolvedSrc)) {
      fs.unlinkSync(resolvedSrc);
      console.log(`[browser-adoption] Cleaned up adopted browser source file: ${resolvedSrc}`);
    }
  } catch (err) {
    console.warn(`[browser-adoption] Could not remove candidate file ${resolvedSrc}:`, err.message);
  }

  // If candidate was inside a Safari bundle, remove bundle directory if empty or completed
  if (candidate.bundleDir) {
    const resolvedBundle = path.resolve(candidate.bundleDir);
    if (resolvedDst && (resolvedBundle === path.dirname(resolvedDst) || resolvedBundle === resolvedDst)) return;
    try {
      if (fs.existsSync(resolvedBundle)) {
        fs.rmSync(resolvedBundle, { recursive: true, force: true });
        console.log(`[browser-adoption] Cleaned up adopted Safari bundle directory: ${resolvedBundle}`);
      }
    } catch (err) {
      console.warn(`[browser-adoption] Could not remove bundle dir ${resolvedBundle}:`, err.message);
    }
  }
}

export function transferCandidateFile(sourcePath, targetPath, options = {}) {
  const mode = options.mode || 'auto'; // 'auto', 'clone', 'move', 'copy'

  // 1. Instant Copy-on-Write clone on macOS APFS (takes < 15ms, 0 extra disk space, keeps source untouched)
  if (mode !== 'move' && process.platform === 'darwin') {
    try {
      execFileSync('cp', ['-c', '-f', sourcePath, targetPath]);
      return 'clone';
    } catch {}
  }

  // 2. Instant reflink clone on Linux (btrfs / xfs / zfs)
  if (mode !== 'move' && process.platform === 'linux') {
    try {
      execFileSync('cp', ['--reflink=always', '-f', sourcePath, targetPath]);
      return 'reflink';
    } catch {}
  }

  // 3. Instant atomic rename/move if requested or clone unsupported
  if (mode !== 'copy') {
    try {
      if (fs.existsSync(targetPath)) {
        try { fs.unlinkSync(targetPath); } catch {}
      }
      fs.renameSync(sourcePath, targetPath);
      return 'move';
    } catch {}
  }

  // 4. Fallback to copy
  try {
    fs.copyFileSync(sourcePath, targetPath);
    return 'copy';
  } catch (err) {
    throw new Error(`Failed to transfer download candidate: ${err.message}`);
  }
}

export async function adoptBrowserDownload(torrent, candidate, options = {}) {
  if (!torrent || !candidate || !candidate.path) {
    throw new Error('Valid torrent and candidate file path are required for adoption');
  }

  const targetPath = candidate.targetPath || (
    torrent.files?.[0]
      ? path.resolve(torrent.path || options.downloadDir || '', torrent.files[0].path)
      : path.resolve(torrent.path || options.downloadDir || '', torrent.name)
  );

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  // 1. Temporarily pause chunk requests while adopting
  const wasPaused = !!torrent.paused;
  if (!wasPaused && typeof torrent.pause === 'function') {
    try { torrent.pause(); } catch {}
  }

  // 2. Close open store file handles so RAF will reopen targetPath fresh
  await closeStoreFiles(torrent);

  // 3. Transfer file into Svorrent target location
  let transferMethod = 'clone';
  const targetLength = candidate.targetLength || torrent.length || 0;
  let splitResult = null;
  if (candidate.size < targetLength && torrent.pieceLength && torrent._hashes) {
    try {
      splitResult = await stitchSplitDownload(candidate.path, targetPath, torrent, targetLength);
      if (splitResult) {
        transferMethod = 'stitch';
      }
    } catch (e) {
      console.warn('[browser-adoption] Split stitching fallback:', e.message);
    }
  }

  if (!splitResult) {
    transferMethod = transferCandidateFile(candidate.path, targetPath, options);
  }

  // 4. Reopen chunk store with fresh file descriptors on the newly adopted file
  reopenTorrentStore(torrent);

  // 5. Rescan and verify piece SHA-1 hashes
  return new Promise((resolve, reject) => {
    const handleSuccess = () => {
      if (options.cleanupSource !== false) {
        cleanupCandidateSource(candidate, targetPath);
      }
      resolve({
        success: true,
        method: transferMethod,
        bytesAdopted: candidate.size,
        progress: torrent.progress || 0,
        downloaded: torrent.downloaded || 0,
        browser: candidate.browser,
      });
    };

    if (typeof torrent.rescanFiles === 'function') {
      torrent.rescanFiles((err) => {
        if (!wasPaused && typeof torrent.resume === 'function') {
          try { torrent.resume(); } catch {}
        }
        if (err) return reject(err);
        handleSuccess();
      });
    } else {
      if (!wasPaused && typeof torrent.resume === 'function') {
        try { torrent.resume(); } catch {}
      }
      handleSuccess();
    }
  });
}
