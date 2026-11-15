export const API = '/api';

async function request(path, init, { signal, timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let timedOut = false;
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const res = await fetch(`${API}${path}`, { ...init, signal: controller.signal });
    let data;
    try {
      data = res.status === 204 ? {} : await res.json();
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new Error(res.ok ? 'The server returned an invalid response.' : `Request failed (${res.status})`);
    }
    controller.signal.throwIfAborted();
    if (!res.ok) {
      throw new Error(typeof data?.error === 'string' ? data.error : `Request failed (${res.status})`);
    }
    if (!data || typeof data !== 'object') throw new Error('The server returned an invalid response.');
    if (typeof data.error === 'string' && data.error) throw new Error(data.error);
    if (data.success === false) throw new Error('The server could not complete the request.');
    return data;
  } catch (error) {
    if (timedOut) throw new Error('The request timed out. Please try again.');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export function apiGet(path, options) {
  return request(path, {}, options);
}

export function apiPost(path, body, options) {
  return request(path, {
    method: 'POST',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }, options);
}


export function formatBytes(bytes) {
  bytes = Number(bytes);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1));
  const value = bytes / Math.pow(1024, i);
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function formatSpeed(bytes) {
  if (!Number.isFinite(Number(bytes)) || Number(bytes) <= 0) return '—';
  return `${formatBytes(bytes)}/s`;
}

export function progressPercent(value) {
  const progress = Number(value);
  if (!Number.isFinite(progress)) return 0;
  return Math.round(Math.max(0, Math.min(1, progress)) * 100);
}

export function formatEta(ms) {
  if (!Number.isFinite(Number(ms)) || Number(ms) <= 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

// Converts strings like "1.4 GB" / "700 MiB" into bytes for sorting.
export function parseSize(str) {
  if (!str) return 0;
  const match = String(str).replace(/,/g, '').match(/([\d.]+)\s*([KMGT]?)i?B/i);
  if (!match) return 0;
  const power = { '': 0, K: 1, M: 2, G: 3, T: 4 }[match[2].toUpperCase()] ?? 0;
  const bytes = Number(match[1]) * Math.pow(1024, power);
  return Number.isFinite(bytes) ? bytes : 0;
}

export function formatDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '—';
  const now = new Date();
  const diffDays = Math.floor((now - d) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) {
    return `Today, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  if (diffDays === 1) {
    return `Yesterday, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

export function formatPeerAddress(ip, port) {
  if (!ip) return '—';
  const str = String(ip).trim();
  const formattedIp = str.includes(':') && !str.startsWith('[') ? `[${str}]` : str;
  return port ? `${formattedIp}:${port}` : formattedIp;
}

export function getPageNumbers(currentPage, totalPages) {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  if (currentPage <= 4) {
    return [1, 2, 3, 4, 5, '...', totalPages];
  }
  if (currentPage >= totalPages - 3) {
    return [1, '...', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  }
  return [1, '...', currentPage - 1, currentPage, currentPage + 1, '...', totalPages];
}

export const SEARCH_QUALITY_FILTERS = [
  { id: 'all', label: 'All', test: null },
  { id: '4k', label: '4K', test: (title) => /(?:^|[^a-z0-9])(2160p|4k|uhd)(?:$|[^a-z0-9])/i.test(title) },
  { id: '1080p', label: '1080p', test: (title) => /(?:^|[^a-z0-9])(1080[pi]|full[\s._-]?hd|fhd)(?:$|[^a-z0-9])/i.test(title) },
  { id: '720p', label: '720p', test: (title) => /(?:^|[^a-z0-9])720p(?:$|[^a-z0-9])/i.test(title) },
  { id: 'sd', label: 'SD', test: (title) => /(?:^|[^a-z0-9])(480p|576p|360p|dvdrip|dvdscr|xvid|divx|camrip|hdcam|telesync|hdts)(?:$|[^a-z0-9])/i.test(title) },
];

export const SEARCH_TAG_FILTERS = [
  { id: 'remux', label: 'Remux', test: (item) => /(?:^|[^a-z0-9])(remux|bdremux|uhd[\s._-]*remux)(?:$|[^a-z0-9])/i.test(item.title || '') },
  { id: 'bluray', label: 'BluRay', test: (item) => /(?:^|[^a-z0-9])(blu[\s._-]*ray|bdrip|brrip|bdremux)(?:$|[^a-z0-9])/i.test(item.title || '') },
  { id: 'webdl', label: 'WEB-DL', test: (item) => /(?:^|[^a-z0-9])(web[\s._-]*dl|webrip|amzn|nf|dsnp|atvp|hmax)(?:$|[^a-z0-9])/i.test(item.title || '') },
  { id: 'hdr', label: 'HDR', test: (item) => /(?:^|[^a-z0-9])(hdr|hdr10|hdr10\+|hlg)(?:$|[^a-z0-9])/i.test(item.title || '') },
  { id: 'dv', label: 'Dolby Vision', test: (item) => /(?:^|[^a-z0-9])(dolby[\s._-]*vision|dovi|dv)(?:$|[^a-z0-9])/i.test(item.title || '') },
  { id: 'hevc', label: 'HEVC', test: (item) => /(?:^|[^a-z0-9])(hevc|x265|h[\s._-]*265)(?:$|[^a-z0-9])/i.test(item.title || '') },
];

const QUALITY_FILTER_MAP = new Map(SEARCH_QUALITY_FILTERS.map((f) => [f.id, f]));
const TAG_FILTER_MAP = new Map(SEARCH_TAG_FILTERS.map((f) => [f.id, f]));

export function matchesSearchFilters(item, { source = 'all', quality = 'all', tags = [] } = {}) {
  if (source !== 'all' && item.provider !== source) return false;
  const title = String(item.title || '');

  const qualityDef = QUALITY_FILTER_MAP.get(quality);
  if (qualityDef?.test && !qualityDef.test(title)) return false;

  if (Array.isArray(tags) && tags.length > 0) {
    for (const tagId of tags) {
      const tagDef = TAG_FILTER_MAP.get(tagId);
      if (tagDef && !tagDef.test(item)) return false;
    }
  }
  return true;
}

export function getSearchFilterCounts(results, { source = 'all', quality = 'all', tags = [] } = {}) {
  const qualityCounts = Object.fromEntries(SEARCH_QUALITY_FILTERS.map((f) => [f.id, 0]));
  const availableQualities = Object.fromEntries(SEARCH_QUALITY_FILTERS.map((f) => [f.id, false]));
  const tagCounts = Object.fromEntries(SEARCH_TAG_FILTERS.map((f) => [f.id, 0]));

  if (!Array.isArray(results) || results.length === 0) {
    return { qualityCounts, availableQualities, tagCounts };
  }

  availableQualities.all = true;
  const activeTags = Array.isArray(tags) ? tags : [];

  for (const item of results) {
    const title = String(item.title || '');
    for (const qf of SEARCH_QUALITY_FILTERS) {
      if (qf.test && qf.test(title)) availableQualities[qf.id] = true;
    }

    if (matchesSearchFilters(item, { source, quality: 'all', tags: activeTags })) {
      qualityCounts.all += 1;
      for (const qf of SEARCH_QUALITY_FILTERS) {
        if (qf.test && qf.test(title)) qualityCounts[qf.id] += 1;
      }
    }

    if (matchesSearchFilters(item, { source, quality, tags: activeTags })) {
      for (const tf of SEARCH_TAG_FILTERS) {
        if (tf.test(item)) tagCounts[tf.id] += 1;
      }
    }
  }

  return { qualityCounts, availableQualities, tagCounts };
}

export function filterSearchResults(results, filters) {
  if (!Array.isArray(results)) return [];
  return results.filter((item) => matchesSearchFilters(item, filters));
}

export function seedClass(seeds) {
  if (seeds >= 50) return 'seeds-good';
  if (seeds >= 5) return 'seeds-ok';
  return 'seeds-low';
}

export function safeLink(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

export function validMagnet(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'magnet:' && !!url.searchParams.get('xt');
  } catch {
    return false;
  }
}

export function formatSwarmCount(val) {
  if (!Number.isFinite(val) || val <= 0) return 0;
  if (val > 500000) {
    const masked = val >>> 0;
    return masked > 500000 ? 0 : masked;
  }
  return val;
}

export function getCompletedHashSet(downloads) {
  const set = new Set();
  if (Array.isArray(downloads)) {
    for (const d of downloads) {
      if (d && d.infoHash && (d.done || d.progress === 1)) {
        set.add(d.infoHash.toLowerCase());
      }
    }
  }
  return set;
}

export function normalizeTorrentItems(data, generationId) {
  const parseCount = (value) => {
    const num = Number(typeof value === 'string' ? value.replace(/,/g, '') : value);
    return Number.isFinite(num) ? Math.max(0, num) : 0;
  };
  return data
    .filter((r) => {
      if (!r || typeof r.title !== 'string') return false;
      const lower = r.title.trim().toLowerCase();
      return lower !== 'no results returned' && lower !== 'no results found';
    })
    .map((r, index) => ({
      ...r,
      _id: `${generationId}:${index}`,
      _generation: generationId,
      size: typeof r.size === 'string' ? r.size : '',
      seeds: parseCount(r.seeds),
      peers: parseCount(r.peers),
      magnet: validMagnet(r.magnet) ? r.magnet : '',
      desc: typeof r.desc === 'string' ? r.desc : '',
      link: safeLink(r.link),
    }));
}

export function nextSortState(prev, key, resetKey = 'relevance') {
  const defaultDir = key === 'title' || key === 'provider' ? 'asc' : 'desc';
  if (prev.key !== key) return { key, dir: defaultDir };
  if (prev.dir === defaultDir) return { key, dir: defaultDir === 'asc' ? 'desc' : 'asc' };
  return { key: resetKey, dir: 'desc' };
}

export function sortTorrentRows(items, sort, resetKey = 'relevance') {
  const list = items.map((r) => ({ ...r, _bytes: parseSize(r.size) }));
  if (!sort || sort.key === resetKey) return list;

  const dir = sort.dir === 'asc' ? 1 : -1;
  list.sort((a, b) => {
    if (sort.key === 'size') return (a._bytes - b._bytes) * dir;
    if (sort.key === 'seeds' || sort.key === 'peers') return ((a[sort.key] || 0) - (b[sort.key] || 0)) * dir;
    return String(a[sort.key] || '').localeCompare(String(b[sort.key] || '')) * dir;
  });
  return list;
}

export function cleanReleaseSearchQuery(title) {
  if (!title || typeof title !== 'string') return '';
  let clean = title
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\.(?=[a-z0-9])/gi, ' ')
    .replace(/[()_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Keep leading title + optional year / S01E01 marker, trim technical scene metadata
  const techCut = clean.search(/\b(2160p|1080[pi]|720p|480p|540p|4k|uhd|hdr\d*|bluray|blu-ray|bdrip|brrip|web-dl|webrip|web|dvdrip|dvdscr|hdrip|hdts|tsrip|camrip|x264|x265|hevc|h264|h265|avc|10bit|remux|aac|ddp?\d|dts|repack)\b/i);
  if (techCut > 2) {
    clean = clean.slice(0, techCut).trim();
  }
  return clean.replace(/[-:.,\s]+$/, '').trim() || title.trim();
}

const DISCOVER_CLIENT_TTL_MS = 5 * 60 * 1000;
const discoverClientCache = new Map();
const discoverClientInFlight = new Map();
const spotlightClientCache = new Map();
const preloadedPosterUrls = new Set();

export function resolveDiscoverPosterUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  if (raw.startsWith('/api/discover/poster?')) return raw;
  return safeLink(raw);
}

export function preloadDiscoverPosters(cards) {
  if (typeof Image === 'undefined' || !Array.isArray(cards)) return;
  for (const card of cards) {
    const src = resolveDiscoverPosterUrl(card?.poster);
    if (!src || preloadedPosterUrls.has(src)) continue;
    preloadedPosterUrls.add(src);
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
  }
}

export function getCachedDiscoverEntry(cat, winValue) {
  const cached = discoverClientCache.get(`${cat}|${winValue}`);
  if (!cached || Date.now() - cached.timestampMs >= DISCOVER_CLIENT_TTL_MS) return null;
  return cached;
}

export function getCachedDiscoverSpotlight(cat, winValue = '7D') {
  return spotlightClientCache.get(`${cat}|${winValue}`) || null;
}

export async function prefetchDiscoverFeed(cat = 'movies', winValue = '7D', { forceRefresh = false, signal } = {}) {
  const key = `${cat}|${winValue}`;
  if (!forceRefresh) {
    const cached = getCachedDiscoverEntry(cat, winValue);
    if (cached) {
      preloadDiscoverPosters(cached.cards);
      return cached;
    }
    if (discoverClientInFlight.has(key)) {
      return discoverClientInFlight.get(key);
    }
  }

  const refreshParam = forceRefresh ? '&refresh=1' : '';
  const task = (async () => {
    const data = await apiGet(
      `/discover?category=${encodeURIComponent(cat)}&window=${encodeURIComponent(winValue)}${refreshParam}`,
      { signal, timeoutMs: 12000 },
    );
    const entry = {
      timestampMs: Date.now(),
      cards: Array.isArray(data?.spotlight) ? data.spotlight : [],
      rawTorrents: Array.isArray(data?.torrents) ? data.torrents : [],
    };
    if (entry.cards.length > 0) {
      spotlightClientCache.set(key, entry.cards);
      preloadDiscoverPosters(entry.cards);
    }
    if (entry.rawTorrents.length > 0) {
      discoverClientCache.set(key, entry);
    }
    return entry;
  })().finally(() => {
    discoverClientInFlight.delete(key);
  });

  if (!forceRefresh) {
    discoverClientInFlight.set(key, task);
  }
  return task;
}
