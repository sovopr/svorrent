import fs from 'fs';
import path from 'path';
import { reopenTorrentStore } from './browser-adoption.js';

/**
 * Checks whether a serialized or live WebTorrent bitfield contains at least one
 * verified piece. Supports base64 strings, Buffers/Uint8Arrays, WebTorrent BitField
 * objects ({ buffer } or { length, get }), and boolean/number arrays.
 */
export function bitfieldHasVerifiedPieces(bitfield) {
  if (!bitfield) return false;

  if (typeof bitfield === 'string') {
    const trimmed = bitfield.trim();
    if (!trimmed) return false;
    const buf = Buffer.from(trimmed, 'base64');
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== 0) return true;
    }
    return false;
  }

  if (ArrayBuffer.isView(bitfield)) {
    for (let i = 0; i < bitfield.length; i++) {
      if (bitfield[i] !== 0) return true;
    }
    return false;
  }

  if (bitfield.buffer && ArrayBuffer.isView(bitfield.buffer)) {
    const buf = bitfield.buffer;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== 0) return true;
    }
    return false;
  }

  if (typeof bitfield.get === 'function' && typeof bitfield.length === 'number') {
    for (let i = 0; i < bitfield.length; i++) {
      if (bitfield.get(i)) return true;
    }
    return false;
  }

  if (Array.isArray(bitfield)) {
    return bitfield.some(Boolean);
  }

  return false;
}

/**
 * Resolves a relative (or already contained) target path strictly inside basePath,
 * returning null if basePath is missing or the path would escape basePath.
 */
export function resolveWithinBase(basePath, relPath) {
  if (!basePath || typeof relPath !== 'string') return null;
  const trimmed = relPath.trim();
  if (!trimmed) return null;

  const resolvedBase = path.resolve(basePath);
  const candidate = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(resolvedBase, trimmed);

  if (candidate === resolvedBase) return null;
  if (!candidate.startsWith(resolvedBase + path.sep)) return null;
  return candidate;
}

/**
 * Extracts all expected disk target paths for an active torrent, session entry,
 * or archive entry relative to its download directory.
 */
export function getTorrentDiskPaths(entryOrTorrent, defaultDownloadDir, archiveRecord = null) {
  const basePath = entryOrTorrent?.path || archiveRecord?.path || defaultDownloadDir;
  if (!basePath) return { basePath: null, targetPaths: [] };

  const targets = new Set();
  const addRelative = (rel) => {
    const resolved = resolveWithinBase(basePath, rel);
    if (resolved) targets.add(resolved);
  };

  if (Array.isArray(entryOrTorrent?.files) && entryOrTorrent.files.length > 0) {
    for (const file of entryOrTorrent.files) {
      addRelative(typeof file === 'string' ? file : (file?.path || file?.name));
    }
  }

  if (targets.size === 0 && Array.isArray(entryOrTorrent?.filePaths) && entryOrTorrent.filePaths.length > 0) {
    for (const rel of entryOrTorrent.filePaths) {
      addRelative(rel);
    }
  }

  if (targets.size === 0 && Array.isArray(archiveRecord?.files) && archiveRecord.files.length > 0) {
    for (const file of archiveRecord.files) {
      addRelative(typeof file === 'string' ? file : (file?.path || file?.name));
    }
  }

  if (targets.size === 0) {
    const fallbackName = entryOrTorrent?.name || archiveRecord?.name;
    if (fallbackName) {
      addRelative(fallbackName);
    }
  }

  return {
    basePath: path.resolve(basePath),
    targetPaths: Array.from(targets),
  };
}

/**
 * Checks whether the torrent's base directory and at least one of its target files
 * currently exist on disk.
 */
export function checkTorrentFilesOnDisk(
  entryOrTorrent,
  defaultDownloadDir,
  existsSyncFn = fs.existsSync,
  archiveRecord = null,
) {
  const { basePath, targetPaths } = getTorrentDiskPaths(entryOrTorrent, defaultDownloadDir, archiveRecord);
  if (!basePath) {
    return { basePath: null, basePresent: false, anyPresent: false, targetPaths: [] };
  }

  let basePresent = false;
  try {
    basePresent = Boolean(existsSyncFn(basePath));
  } catch {
    basePresent = false;
  }

  if (!basePresent || targetPaths.length === 0) {
    return { basePath, basePresent, anyPresent: false, targetPaths };
  }

  let anyPresent = false;
  for (const targetPath of targetPaths) {
    try {
      if (existsSyncFn(targetPath)) {
        anyPresent = true;
        break;
      }
    } catch {
      // Ignore transient filesystem stat failures on individual paths
    }
  }

  return { basePath, basePresent, anyPresent, targetPaths };
}

/**
 * Marks an active torrent as having had files observed on disk if at least one of its
 * target paths currently exists.
 */
export function markTorrentHadFilesIfPresent(
  torrent,
  defaultDownloadDir,
  existsSyncFn = fs.existsSync,
) {
  if (!torrent || torrent.destroyed) return false;
  const { anyPresent } = checkTorrentFilesOnDisk(torrent, defaultDownloadDir, existsSyncFn);
  if (anyPresent) {
    torrent._hadFilesOnDisk = true;
  }
  return anyPresent;
}

/**
 * Returns true when persisted or runtime flags indicate that at least part of the
 * torrent's payload previously existed on disk (distinct from unverified wire RAM bytes).
 */
export function hasTorrentDataEverExisted(entryOrTorrent, archiveRecord = null) {
  if (!entryOrTorrent) return false;
  return Boolean(
    entryOrTorrent._hadFilesOnDisk
    || entryOrTorrent._restoredHadFilesOnDisk
    || entryOrTorrent._restoredDone
    || entryOrTorrent.hadFilesOnDisk
    || entryOrTorrent.done
    || bitfieldHasVerifiedPieces(entryOrTorrent.bitfield)
    || bitfieldHasVerifiedPieces(entryOrTorrent._savedBitfield)
    || archiveRecord?.hadFilesOnDisk
    || archiveRecord?.done
  );
}

/**
 * Determines during session/archive restore whether an entry's files were manually
 * deleted on disk and should therefore not be re-added or re-downloaded.
 */
export function shouldSkipRestoredEntry(
  entry,
  archiveRecord,
  defaultDownloadDir,
  { fromArchive = false, existsSyncFn = fs.existsSync } = {},
) {
  if (!entry) return false;

  const { basePresent, anyPresent, targetPaths } = checkTorrentFilesOnDisk(
    entry,
    defaultDownloadDir,
    existsSyncFn,
    archiveRecord,
  );

  // Protect downloads stored on disconnected/unmounted external drives
  if (!basePresent || targetPaths.length === 0) return false;
  if (anyPresent) return false;

  // Previously completed or partially downloaded entries missing from disk were deleted manually
  if (hasTorrentDataEverExisted(entry, archiveRecord)) {
    return true;
  }

  // If falling back to archive records that have no bitfield, still preserve records
  // unless we have proof data existed on disk.
  if (fromArchive && (archiveRecord?.hadFilesOnDisk || archiveRecord?.done)) {
    return true;
  }

  return false;
}

/**
 * Determines whether an active in-memory torrent has had all of its previously existing
 * disk files manually deleted and should be stopped and removed cleanly.
 */
export function shouldRemoveActiveTorrentForMissingFiles(
  torrent,
  defaultDownloadDir,
  existsSyncFn = fs.existsSync,
) {
  if (!torrent || torrent.destroyed || torrent._deleting || torrent._adoptingBrowser) {
    return false;
  }

  const { basePresent, anyPresent, targetPaths } = checkTorrentFilesOnDisk(
    torrent,
    defaultDownloadDir,
    existsSyncFn,
  );

  if (anyPresent) {
    torrent._hadFilesOnDisk = true;
    return false;
  }

  // Do not delete torrents on an unmounted/missing parent drive or before metadata resolves paths
  if (!basePresent || targetPaths.length === 0) {
    return false;
  }

  // For active torrents, only treat missing files as manual deletion if we know files
  // were previously written to disk (never trigger on unstarted magnets or pre-piece wire RAM).
  return Boolean(
    torrent._hadFilesOnDisk
    || torrent._restoredHadFilesOnDisk
    || torrent._restoredDone
    || torrent.done
  );
}

/**
 * Finds the innermost chunk store behind wrappers like ImmediateChunkStore / CacheChunkStore.
 */
function getLeafStore(store) {
  let current = store;
  const seen = new Set();
  while (current && current.store && !seen.has(current)) {
    seen.add(current);
    current = current.store;
  }
  return current;
}

/**
 * Releases OS file descriptors held by FSChunkStore / random-access-file for paused or idle
 * torrents so users on macOS/Windows/Linux can delete/move/empty-trash files freely without EBUSY,
 * while swapping in a fresh lazy FSChunkStore to avoid "Storage is closed" errors.
 */
export function releaseStoreFileHandles(torrent, reopenStoreFn = reopenTorrentStore, onClosed = null) {
  if (!torrent || !torrent.store || torrent.destroyed || !torrent.ready || !torrent.pieceLength || typeof reopenStoreFn !== 'function') {
    if (typeof onClosed === 'function') onClosed(false);
    return false;
  }

  const leaf = getLeafStore(torrent.store);
  // Skip non-FS stores (e.g. MemoryChunkStore) or unit-test mocks without FS file handles
  if (!leaf || !Array.isArray(leaf.files) || !torrent._store) {
    if (typeof onClosed === 'function') onClosed(false);
    return false;
  }

  const oldStore = torrent.store;
  reopenStoreFn(torrent);
  torrent._storeMayHaveOpenHandles = false;
  const swapped = Boolean(oldStore && torrent.store !== oldStore);

  if (oldStore && oldStore !== torrent.store && typeof oldStore.close === 'function') {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (typeof onClosed === 'function') onClosed(swapped);
    };
    try {
      oldStore.close(finish);
    } catch {
      // Ignore close errors during teardown
      finish();
    }
  } else if (typeof onClosed === 'function') {
    onClosed(swapped);
  }

  return swapped;
}

/**
 * Promise variant of releaseStoreFileHandles that resolves once oldStore.close() finishes
 * flushing and closing OS descriptors (useful before HTTP pause/delete responses on Windows).
 */
export function releaseStoreFileHandlesAsync(torrent, reopenStoreFn = reopenTorrentStore) {
  return new Promise((resolve) => {
    releaseStoreFileHandles(torrent, reopenStoreFn, resolve);
  });
}
