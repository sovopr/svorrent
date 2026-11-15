// Federated Multi-Source Indexer Engine for Svorrent
// Replaces torrent-search-api with modern native fetch() scrapers across multiple
// public indexers (ThePirateBay, BitSearch, Torrents.csv, Nyaa, Knaben, TheRARBG).
// Eliminates npm audit CVEs, un-caps 100-result limits, and aggregates hundreds
// of deduplicated torrents across providers.

import crypto from 'node:crypto';

export const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.bittorrent.com:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.cyberia.is:6969/announce',
];

const HTML_ENTITY_MAP = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#039;': "'",
  '&#39;': "'",
  '&#x27;': "'",
  '&#x3d;': '=',
};

export function decodeHtmlEntities(str) {
  if (!str || typeof str !== 'string') return '';
  return str.replace(/&(?:amp|lt|gt|quot|#(?:0*39|x27|x3[dD]));/gi, (match) => {
    const key = match.toLowerCase();
    return HTML_ENTITY_MAP[key] || match;
  });
}

export function stripHtmlTags(str) {
  if (!str || typeof str !== 'string') return '';
  let prev;
  let clean = str;
  do {
    prev = clean;
    clean = clean.replace(/<[^>]*>/g, '');
  } while (clean !== prev);
  return clean.trim();
}

export function sanitizeSwarmCount(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // BitSearch and certain scrapers occasionally emit raw 64-bit values where high bit 32
  // is set as an internal tracking flag (0x100000000), producing values like 4294967301 (2^32 + 5).
  // Unsigned 32-bit truncation restores the true swarm count.
  const masked = n >>> 0;
  if (masked > 500000) return 0;
  return masked;
}

/**
 * Formats an epoch millisecond timestamp into a compact relative age string.
 * @param {number} timestampMs
 * @param {number} [nowMs]
 * @returns {string}
 */
export function formatRelativeAgeFromMs(timestampMs, nowMs = Date.now()) {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return '';
  const diffSec = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
  if (diffSec < 60) return 'just now';
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

export function extractInfoHash(magnetOrHash) {
  if (!magnetOrHash || typeof magnetOrHash !== 'string') return '';
  const trimmed = magnetOrHash.trim();
  if (/^[a-fA-F0-9]{40}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  const match = trimmed.match(/xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
  if (match) {
    return match[1].toLowerCase();
  }
  return '';
}

export function formatMagnetUri(infoHash, name, customTrackers = DEFAULT_TRACKERS) {
  if (!infoHash) return '';
  const cleanHash = extractInfoHash(infoHash) || infoHash.toLowerCase();
  const cleanName = name ? encodeURIComponent(name) : 'Torrent';
  const trackersQuery = customTrackers.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
  return `magnet:?xt=urn:btih:${cleanHash}&dn=${cleanName}${trackersQuery}`;
}

export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const val = n / Math.pow(1024, i);
  return `${val >= 100 || i === 0 ? Math.round(val) : val.toFixed(1)} ${units[i]}`;
}

export function parseSizeToBytes(str) {
  if (!str || typeof str !== 'string') return 0;
  const match = str.trim().match(/^([\d.]+)\s*([KMGT]?i?B)$/i);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  if (!Number.isFinite(val)) return 0;
  const unit = match[2].toUpperCase();
  const mult = unit.startsWith('T')
    ? 1024 ** 4
    : unit.startsWith('G')
      ? 1024 ** 3
      : unit.startsWith('M')
        ? 1024 ** 2
        : unit.startsWith('K')
          ? 1024
          : 1;
  return Math.round(val * mult);
}

export function normalizeTitleForDedup(title) {
  if (!title || typeof title !== 'string') return '';
  return title
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^\)]*\)/g, ' ')
    .replace(/\{[^\}]*\}/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const HIGH_RES_VIDEO_RE = /\b(2160p|1080p|4k|uhd|remux|bluray|blu-ray)\b/i;
const STD_VIDEO_RE = /\b(720p|480p|web-dl|webrip|hdrip|bdrip|dvdrip|dvd|brrip|hdtv)\b/i;
const VIDEO_CODEC_RE = /\b(x264|x265|hevc|h264|h265|avc|truehd|atmos|dts|ac3|eac3|ddp5\.1|aac|yts|rarbg|yify|swtyblz|galaxyrg|proper|extended)\b/i;
const RELEASE_YEAR_RE = /\b(19\d\d|20\d\d)\b/;
const GAME_OR_SOFTWARE_RE = /\b(fitgirl|dodi|codex|skidrow|flt|plaza|cpass|telltale|dlc|switch|nsp|xci|rom|emulator|crack|keygen|patch|trainer|mod|apk|setup\.exe)\b/i;
const REPACK_WORD_RE = /\brepack\b/i;

const FEDERATED_CACHE_TTL_MS = 90_000;
const FEDERATED_CACHE_MAX_SIZE = 40;
const federatedCache = new Map();

function withProviderTimeout(signal, timeoutMs = 3500) {
  const timerSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timerSignal]) : timerSignal;
}

const SEARCH_STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'this', 'that']);

function extractQueryTokens(lowerQuery) {
  if (!lowerQuery) return [];
  const raw = lowerQuery.split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
  const significant = raw.filter((t) => !SEARCH_STOP_WORDS.has(t));
  return significant.length > 0 ? significant : raw;
}

export function scoreSearchResult(item, query = '') {
  if (!item || !item.title) return 0;
  const lowerQuery = (query || '').trim().toLowerCase();
  const queryTokens = extractQueryTokens(lowerQuery);
  return scoreSearchResultWithTokens(item, lowerQuery, queryTokens);
}

function scoreSearchResultWithTokens(item, lowerQuery, queryTokens) {
  if (!item || !item.title) return 0;
  let score = 0;
  const title = item.title.trim();
  const lowerTitle = title.toLowerCase();
  const spacedTitle = lowerTitle.replace(/[._-]+/g, ' ');

  // 1. Query matching (dot-separated scene names should score equally on phrase match)
  if (lowerQuery && (lowerTitle.includes(lowerQuery) || spacedTitle.includes(lowerQuery))) {
    score += 4000;
  }
  if (lowerQuery && (lowerTitle.startsWith(lowerQuery) || spacedTitle.startsWith(lowerQuery))) {
    score += 1500;
  }
  if (queryTokens.length > 0) {
    let matchedCount = 0;
    for (let i = 0; i < queryTokens.length; i++) {
      if (lowerTitle.includes(queryTokens[i])) matchedCount++;
    }
    score += (matchedCount / queryTokens.length) * 2000;
    if (queryTokens.length >= 2) {
      if (matchedCount === queryTokens.length) {
        score += 3000;
      } else {
        score -= 3500;
      }
    }
  }

  // 2. Video & Movie Indicators (1080p/4K preferred over 720p/SD)
  const isHighResVideo = HIGH_RES_VIDEO_RE.test(lowerTitle);
  const isStdVideo = !isHighResVideo && STD_VIDEO_RE.test(lowerTitle);
  const hasVideoRes = isHighResVideo || isStdVideo;
  if (isHighResVideo) {
    score += 4800;
  } else if (isStdVideo) {
    score += 4200;
  }

  if (VIDEO_CODEC_RE.test(lowerTitle)) score += 2500;
  if (RELEASE_YEAR_RE.test(lowerTitle)) score += 2000;

  // 3. File Size heuristics for Movies vs Tiny patches / cracks
  const sizeBytes = parseSizeToBytes(item.size);
  if (sizeBytes >= 700 * 1024 * 1024 && sizeBytes <= 90 * 1024 * 1024 * 1024) {
    score += 3000;
    if (sizeBytes >= 1.2 * 1024 * 1024 * 1024 && sizeBytes <= 35 * 1024 * 1024 * 1024) {
      score += 1500;
    }
  } else if (sizeBytes > 0 && sizeBytes < 60 * 1024 * 1024) {
    score -= 6000;
  }

  // 4. Non-movie / Game / Software penalties (do not penalize scene 1080p/BluRay REPACK movies)
  const isGameOrSoftware = GAME_OR_SOFTWARE_RE.test(lowerTitle) || (!hasVideoRes && REPACK_WORD_RE.test(lowerTitle));
  if (isGameOrSoftware) {
    score -= 7000;
  }

  // 5. Penalize fragmented / bracket-only titles
  if (title.startsWith('(') && title.endsWith(')')) {
    score -= 8000;
  }

  // 6. Seed health & capped swarm bonus so dead 0-seeder noise ranks below healthy swarms
  const seeds = Math.max(0, item.seeds || 0);
  const peers = Math.max(0, item.peers || 0);
  if (seeds === 0) {
    score -= peers > 0 ? 11500 : 13000;
  } else {
    score += Math.min(seeds, 2500) + Math.round(Math.log10(seeds + 1) * 900);
  }

  return score;
}

// ---------------------------------------------------------------------------
// 1. ThePirateBay (apibay.org JSON API)
// ---------------------------------------------------------------------------
function parseApibayItems(data, limit) {
  if (!Array.isArray(data)) return [];
  const results = [];
  for (const item of data) {
    if (!item || !item.name) continue;
    if (item.id === '0' || item.name.toLowerCase() === 'no results returned') continue;

    const rawSize = parseInt(item.size, 10);
    const sizeStr = Number.isFinite(rawSize) && rawSize > 0 ? formatBytes(rawSize) : '';
    const infoHash = item.info_hash ? String(item.info_hash).trim().toLowerCase() : '';
    const seeds = sanitizeSwarmCount(item.seeders);
    const peers = sanitizeSwarmCount(item.leechers);
    const title = decodeHtmlEntities(stripHtmlTags(String(item.name || '')));
    if (!title) continue;
    const addedSec = parseInt(item.added, 10);
    const age = Number.isFinite(addedSec) && addedSec > 1000000000 ? formatRelativeAgeFromMs(addedSec * 1000) : '';

    results.push({
      provider: 'ThePirateBay',
      id: String(item.id),
      title,
      size: sizeStr,
      ...(age ? { age } : {}),
      seeds,
      peers,
      infoHash,
      magnet: infoHash ? formatMagnetUri(infoHash, item.name) : '',
      desc: `https://thepiratebay.org/description.php?id=${item.id}`,
      link: `https://apibay.org/t.php?id=${item.id}`,
    });

    if (limit && results.length >= limit) break;
  }
  return results;
}

export async function searchThePirateBay(query, { category = '', limit, signal } = {}) {
  if (!query || typeof query !== 'string' || !query.trim()) return [];

  const url = `https://apibay.org/q.php?q=${encodeURIComponent(query.trim())}&cat=${encodeURIComponent(category)}`;
  const res = await fetch(url, {
    signal,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Svorrent/1.0',
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`ThePirateBay (apibay) responded with HTTP ${res.status}`);
  }

  return parseApibayItems(await res.json(), limit);
}

// ---------------------------------------------------------------------------
// 2. BitSearch (HTML Multi-page Scraper)
// ---------------------------------------------------------------------------
export async function scrapeBitSearchPage(query, page = 1, { signal } = {}) {
  const url = `https://bitsearch.eu/search?q=${encodeURIComponent(query.trim())}&page=${page}`;
  const res = await fetch(url, {
    signal,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (!res.ok) {
    throw new Error(`BitSearch page ${page} responded with HTTP ${res.status}`);
  }

  const html = await res.text();
  const chunks = html.split(/torrent-result-card/i);
  if (chunks.length <= 1) return [];
  const results = [];

  for (let i = 1; i < chunks.length; i++) {
    const card = chunks[i].slice(0, 12288);

    // Title
    const titleMatch = card.match(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
    const rawTitle = titleMatch ? stripHtmlTags(titleMatch[1]) : '';
    const title = decodeHtmlEntities(rawTitle);
    if (!title) continue;

    // Magnet URI
    const magnetMatch = card.match(/href="(magnet:\?[^"]+)"/i);
    let magnet = magnetMatch ? magnetMatch[1].replace(/&#x3D;/gi, '=').replace(/&amp;/g, '&') : '';

    const infoHash = extractInfoHash(magnet);
    if (!magnet && infoHash) {
      magnet = formatMagnetUri(infoHash, title);
    }

    // Swarm stats with overflow and underflow sanitization
    const seedMatch = card.match(/text-green-600[\s\S]*?<span class="font-medium">(\d+)<\/span>/i);
    const seeds = sanitizeSwarmCount(seedMatch ? seedMatch[1] : 0);

    const leechMatch = card.match(/text-red-600[\s\S]*?<span class="font-medium">(\d+)<\/span>/i);
    const peers = sanitizeSwarmCount(leechMatch ? leechMatch[1] : 0);

    // Size
    const sizeMatch = card.match(/fa-download[^>]*><\/i>[\s\S]*?<span>([\d.]+\s*[KMGT]?i?B)<\/span>/i);
    const size = sizeMatch ? sizeMatch[1].trim() : '';

    results.push({
      provider: 'BitSearch',
      title,
      size,
      seeds,
      peers,
      infoHash,
      magnet,
    });
  }

  return results;
}

export async function scrapeBitSearch(query, { maxPages = 3, signal } = {}) {
  if (!query || typeof query !== 'string' || !query.trim()) return [];

  const pagePromises = [];
  for (let p = 1; p <= maxPages; p++) {
    pagePromises.push(
      scrapeBitSearchPage(query, p, { signal }).catch(() => {
        return [];
      })
    );
  }

  const pages = await Promise.all(pagePromises);
  return pages.flat();
}

// ---------------------------------------------------------------------------
// 3. Torrents.csv (Open JSON Torrent Index)
// ---------------------------------------------------------------------------
export async function searchTorrentsCsv(query, { signal } = {}) {
  if (!query || typeof query !== 'string' || !query.trim()) return [];

  const url = `https://torrents-csv.com/service/search?q=${encodeURIComponent(query.trim())}`;
  const res = await fetch(url, {
    signal,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Svorrent/1.0',
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`Torrents.csv responded with HTTP ${res.status}`);
  }

  const data = await res.json();
  const list = Array.isArray(data?.torrents) ? data.torrents : [];
  const results = [];

  for (const item of list) {
    if (!item || !item.name) continue;

    const infoHash = item.infohash ? String(item.infohash).trim().toLowerCase() : '';
    const sizeStr = item.size_bytes ? formatBytes(item.size_bytes) : '';
    const seeds = sanitizeSwarmCount(item.seeders);
    const peers = sanitizeSwarmCount(item.leechers);
    const title = decodeHtmlEntities(stripHtmlTags(String(item.name || '')));

    results.push({
      provider: 'Torrents.csv',
      id: String(item.id || ''),
      title,
      size: sizeStr,
      seeds,
      peers,
      infoHash,
      magnet: infoHash ? formatMagnetUri(infoHash, item.name) : '',
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// 4. Nyaa (Anime & Media RSS XML Feed)
// ---------------------------------------------------------------------------
export function parseNyaaRssXml(xml, limit = 100) {
  if (!xml || typeof xml !== 'string') return [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  const results = [];
  let m;

  while ((m = itemRegex.exec(xml)) !== null) {
    const item = m[1];

    const titleMatch = item.match(/<title>([\s\S]*?)<\/title>/i);
    const rawTitle = titleMatch ? stripHtmlTags(titleMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')) : '';
    const title = decodeHtmlEntities(rawTitle);
    if (!title) continue;

    const seedMatch = item.match(/<nyaa:seeders>(\d+)<\/nyaa:seeders>/i);
    const seeds = sanitizeSwarmCount(seedMatch ? seedMatch[1] : 0);

    const leechMatch = item.match(/<nyaa:leechers>(\d+)<\/nyaa:leechers>/i);
    const peers = sanitizeSwarmCount(leechMatch ? leechMatch[1] : 0);

    const hashMatch = item.match(/<nyaa:infoHash>([a-fA-F0-9]{40})<\/nyaa:infoHash>/i);
    const infoHash = hashMatch ? hashMatch[1].toLowerCase() : '';

    const sizeMatch = item.match(/<nyaa:size>([\s\S]*?)<\/nyaa:size>/i);
    const size = sizeMatch ? sizeMatch[1].trim() : '';

    const guidMatch = item.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i);
    const desc = guidMatch ? guidMatch[1].trim() : '';

    const pubDateMatch = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
    const parsedDate = pubDateMatch ? Date.parse(pubDateMatch[1].trim()) : NaN;
    const age = Number.isFinite(parsedDate) ? formatRelativeAgeFromMs(parsedDate) : '';

    results.push({
      provider: 'Nyaa',
      title,
      size,
      ...(age ? { age } : {}),
      seeds,
      peers,
      infoHash,
      magnet: infoHash ? formatMagnetUri(infoHash, title) : '',
      desc,
    });

    if (limit && results.length >= limit) break;
  }

  return results;
}

export async function searchNyaa(query, { signal } = {}) {
  if (!query || typeof query !== 'string' || !query.trim()) return [];

  const url = `https://nyaa.si/?page=rss&q=${encodeURIComponent(query.trim())}`;
  const res = await fetch(url, {
    signal,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Svorrent/1.0',
      Accept: 'application/rss+xml, application/xml, text/xml',
    },
  });

  if (!res.ok) {
    throw new Error(`Nyaa responded with HTTP ${res.status}`);
  }

  return parseNyaaRssXml(await res.text());
}

// ---------------------------------------------------------------------------
// 5. Knaben (Multi-Tracker JSON Meta-Search: 1337x, RuTracker, YTS, TPB, Nyaa)
// ---------------------------------------------------------------------------
const KNABEN_API_URL = 'https://api.knaben.org/v1';
const KNABEN_TRACKER_LABELS = {
  thepiratebay: 'ThePirateBay',
  '1337x': '1337x',
  rutracker: 'RuTracker',
  yts: 'YTS',
  nyaasi: 'Nyaa',
  sukebeinyaasi: 'Sukebei',
  limetorrents: 'LimeTorrents',
  tokyotosho: 'TokyoTosho',
};

/**
 * Normalizes a single torrent hit into Svorrent's shared search result shape.
 * @param {object} fields
 * @returns {object|null}
 */
function buildNormalizedResult({
  provider,
  id = '',
  title,
  sizeBytes = 0,
  size = '',
  age = '',
  seeds = 0,
  peers = 0,
  infoHash = '',
  magnet = '',
  desc = '',
}) {
  const cleanTitle = decodeHtmlEntities(stripHtmlTags(String(title || ''))).replace(/\u00a0/g, ' ').trim();
  if (!cleanTitle) return null;

  const cleanHash = extractInfoHash(infoHash || magnet);
  const decodedMagnet = magnet ? decodeHtmlEntities(String(magnet)).trim() : '';
  const finalMagnet = decodedMagnet.startsWith('magnet:?xt=urn:btih:')
    ? decodedMagnet
    : cleanHash
      ? formatMagnetUri(cleanHash, cleanTitle)
      : '';

  if (!cleanHash && !finalMagnet) return null;

  const cleanSize = size
    ? String(size).replace(/\u00a0/g, ' ').trim()
    : Number.isFinite(Number(sizeBytes)) && Number(sizeBytes) > 0
      ? formatBytes(Number(sizeBytes))
      : '';

  return {
    provider,
    id: id ? String(id).trim() : '',
    title: cleanTitle,
    size: cleanSize,
    ...(age ? { age } : {}),
    seeds: sanitizeSwarmCount(seeds),
    peers: sanitizeSwarmCount(peers),
    infoHash: cleanHash,
    magnet: finalMagnet,
    ...(desc ? { desc } : {}),
  };
}

/**
 * Parses hits from Knaben's `/v1` JSON search response.
 * @param {object} data
 * @param {{ categoryFilter?: RegExp }} [opts]
 * @returns {Array<object>}
 */
export function parseKnabenHits(data, { categoryFilter } = {}) {
  const hits = Array.isArray(data?.hits) ? data.hits : [];
  const results = [];

  for (const hit of hits) {
    if (!hit || !hit.title) continue;
    if (categoryFilter && !categoryFilter.test(String(hit.category || ''))) continue;

    const trackerKey = String(hit.trackerId || '').trim().toLowerCase();
    const provider = KNABEN_TRACKER_LABELS[trackerKey] || String(hit.tracker || 'Knaben').trim() || 'Knaben';
    const seeds = Math.max(sanitizeSwarmCount(hit.liveSeeders), sanitizeSwarmCount(hit.seeders));
    const peers = Math.max(sanitizeSwarmCount(hit.livePeers), sanitizeSwarmCount(hit.peers));
    const parsedDate = hit.date ? Date.parse(String(hit.date)) : NaN;
    const age = Number.isFinite(parsedDate) ? formatRelativeAgeFromMs(parsedDate) : '';

    const entry = buildNormalizedResult({
      provider,
      id: hit.id,
      title: hit.title,
      sizeBytes: hit.bytes,
      age,
      seeds,
      peers,
      infoHash: hit.hash,
      magnet: hit.magnetUrl || hit.link || '',
      desc: typeof hit.details === 'string' ? hit.details : '',
    });
    if (entry) results.push(entry);
  }

  return results;
}

async function queryKnabenRaw(body, { signal } = {}) {
  const res = await fetch(KNABEN_API_URL, {
    method: 'POST',
    signal,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Svorrent/1.0',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Knaben API responded with HTTP ${res.status}`);
  }

  return res.json();
}

/**
 * Queries Knaben's JSON API across aggregated public trackers.
 * @param {string} query
 * @param {{ size?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function searchKnaben(query, { size = 100, signal } = {}) {
  if (!query || typeof query !== 'string' || !query.trim()) return [];

  const data = await queryKnabenRaw({
    search_field: 'title',
    query: query.trim(),
    order_by: 'seeders',
    order_direction: 'desc',
    from: 0,
    size: Math.min(Math.max(1, size), 150),
    hide_unsafe: false,
    hide_xxx: false,
  }, { signal });

  return parseKnabenHits(data);
}

// ---------------------------------------------------------------------------
// 6. TheRARBG (JSON API + Browse Fallback)
// ---------------------------------------------------------------------------
const THERARBG_PRIMARY_BASE = 'https://extto.org';
const THERARBG_FALLBACK_BASE = 'https://therarbg.to';
const THERARBG_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Svorrent/1.0',
};

function resolveTheRarbgProvider(baseUrl) {
  return String(baseUrl || '').includes('therarbg') ? 'TheRARBG' : 'extto.org';
}

/**
 * Parses `/get-posts/?format=json` payloads from TheRARBG / extto.org mirrors.
 * @param {object} data
 * @param {string} [baseUrl]
 * @returns {Array<object>}
 */
export function parseTheRarbgJson(data, baseUrl = THERARBG_PRIMARY_BASE) {
  const list = Array.isArray(data?.results) ? data.results : [];
  const provider = resolveTheRarbgProvider(baseUrl);
  const results = [];

  for (const item of list) {
    if (!item || !item.n) continue;
    const cleanId = item.pk ? String(item.pk).trim() : '';
    const entry = buildNormalizedResult({
      provider,
      id: cleanId,
      title: item.n,
      sizeBytes: item.s,
      seeds: item.se,
      peers: item.le,
      infoHash: item.h,
      desc: cleanId ? `${baseUrl}/post-detail/${encodeURIComponent(cleanId)}/` : '',
    });
    if (entry) results.push(entry);
  }

  return results;
}

/**
 * Parses `/browse/` HTML rows from the primary TheRARBG mirror.
 * @param {string} html
 * @param {string} [baseUrl]
 * @returns {Array<object>}
 */
export function parseTheRarbgBrowseHtml(html, baseUrl = THERARBG_PRIMARY_BASE) {
  if (!html || typeof html !== 'string') return [];
  const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) return [];

  const provider = resolveTheRarbgProvider(baseUrl);
  const rows = tbodyMatch[1].split(/<tr[^>]*>/i).slice(1);
  const results = [];

  for (const row of rows) {
    const linkMatch = row.match(/<a\s+href="([^"]*\/post-detail\/([^/"]+)\/[^"]*)"[^>]*class="torrent-title-link"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const magnetMatch = row.match(/href="(magnet:\?[^"]+)"/i);
    const sizeMatch = row.match(/<span class="add-block">Size<\/span>\s*<span[^>]*>([^<]+)<\/span>/i);
    const seedMatch = row.match(/<span class="add-block">Seeds<\/span>\s*<span[^>]*>([\d,]+)<\/span>/i);
    const leechMatch = row.match(/<span class="add-block">Leechs<\/span>\s*<span[^>]*>([\d,]+)<\/span>/i);
    const cleanId = linkMatch[2].trim();

    const entry = buildNormalizedResult({
      provider,
      id: cleanId,
      title: linkMatch[3],
      size: sizeMatch ? sizeMatch[1] : '',
      seeds: seedMatch ? seedMatch[1].replace(/,/g, '') : 0,
      peers: leechMatch ? leechMatch[1].replace(/,/g, '') : 0,
      magnet: magnetMatch ? magnetMatch[1] : '',
      desc: cleanId ? `${baseUrl}/post-detail/${encodeURIComponent(cleanId)}/` : '',
    });
    if (entry) results.push(entry);
  }

  return results;
}

async function fetchTheRarbgJsonPage(baseUrl, query, page, signal) {
  const url = `${baseUrl}/get-posts/?keywords=${encodeURIComponent(query)}&format=json&page=${page}`;
  const res = await fetch(url, {
    signal,
    headers: { ...THERARBG_HEADERS, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`TheRARBG (${baseUrl}) JSON page ${page} responded with HTTP ${res.status}`);
  }
  return parseTheRarbgJson(await res.json(), baseUrl);
}

async function fetchTheRarbgBrowsePage(baseUrl, query, page, signal) {
  const url = `${baseUrl}/browse/?q=${encodeURIComponent(query)}&page=${page}`;
  const res = await fetch(url, {
    signal,
    headers: {
      ...THERARBG_HEADERS,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  if (!res.ok) {
    throw new Error(`TheRARBG (${baseUrl}) browse page ${page} responded with HTTP ${res.status}`);
  }
  return parseTheRarbgBrowseHtml(await res.text(), baseUrl);
}

/**
 * Searches TheRARBG across seed-sorted JSON pages and newest browse rows.
 * Falls back to `therarbg.to` if `extto.org` fails completely.
 * @param {string} query
 * @param {{ maxJsonPages?: number, includeBrowseNewest?: boolean, signal?: AbortSignal }} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function searchTheRarbg(query, { maxJsonPages = 2, includeBrowseNewest = true, signal } = {}) {
  if (!query || typeof query !== 'string' || !query.trim()) return [];
  const cleanQuery = query.trim();

  const jsonTasks = [];
  for (let p = 1; p <= maxJsonPages; p++) {
    jsonTasks.push(fetchTheRarbgJsonPage(THERARBG_PRIMARY_BASE, cleanQuery, p, signal));
  }
  const browseTask = includeBrowseNewest
    ? fetchTheRarbgBrowsePage(THERARBG_PRIMARY_BASE, cleanQuery, 1, signal).catch(() => [])
    : Promise.resolve([]);

  const jsonSettled = await Promise.allSettled(jsonTasks);
  const browseRows = await browseTask;
  const primaryJsonRows = jsonSettled
    .filter((entry) => entry.status === 'fulfilled')
    .flatMap((entry) => entry.value);

  if (primaryJsonRows.length > 0 || browseRows.length > 0) {
    return [...primaryJsonRows, ...browseRows];
  }

  const anyFulfilled = jsonSettled.some((entry) => entry.status === 'fulfilled');
  if (anyFulfilled) return [];

  return fetchTheRarbgJsonPage(THERARBG_FALLBACK_BASE, cleanQuery, 1, signal);
}

// ---------------------------------------------------------------------------
// 7. Federated Search Aggregator & Deduplication
// ---------------------------------------------------------------------------
export async function searchFederated(
  query,
  {
    limit,
    providers = ['ThePirateBay', 'BitSearch', 'Torrents.csv', 'Nyaa', 'Knaben', 'TheRARBG'],
    bitSearchPages = 2,
    signal,
  } = {}
) {
  if (!query || typeof query !== 'string' || !query.trim()) return [];
  const cleanQuery = query.trim();
  const lowerQuery = cleanQuery.toLowerCase();
  const cacheKey = `${lowerQuery}|${providers.join(',')}|${bitSearchPages}`;
  const now = Date.now();

  const cached = federatedCache.get(cacheKey);
  if (cached && now - cached.timestampMs < FEDERATED_CACHE_TTL_MS && cached.items.length > 0) {
    const cloned = cached.items.map((it) => ({ ...it }));
    return limit && Number.isInteger(limit) && limit > 0 ? cloned.slice(0, limit) : cloned;
  }

  const tasks = [];

  if (providers.includes('ThePirateBay')) {
    tasks.push(
      searchThePirateBay(cleanQuery, { signal: withProviderTimeout(signal, 3500) }).catch((err) => {
        console.warn('[search:ThePirateBay] Scraper error:', err.message);
        return [];
      })
    );
  }

  if (providers.includes('BitSearch')) {
    tasks.push(
      scrapeBitSearch(cleanQuery, { maxPages: bitSearchPages, signal: withProviderTimeout(signal, 3500) }).catch((err) => {
        console.warn('[search:BitSearch] Scraper error:', err.message);
        return [];
      })
    );
  }

  if (providers.includes('Torrents.csv')) {
    tasks.push(
      searchTorrentsCsv(cleanQuery, { signal: withProviderTimeout(signal, 3500) }).catch((err) => {
        console.warn('[search:Torrents.csv] Scraper error:', err.message);
        return [];
      })
    );
  }

  if (providers.includes('Nyaa')) {
    tasks.push(
      searchNyaa(cleanQuery, { signal: withProviderTimeout(signal, 3500) }).catch((err) => {
        console.warn('[search:Nyaa] Scraper error:', err.message);
        return [];
      })
    );
  }

  if (providers.includes('Knaben')) {
    tasks.push(
      searchKnaben(cleanQuery, { signal: withProviderTimeout(signal, 3500) }).catch((err) => {
        console.warn('[search:Knaben] Scraper error:', err.message);
        return [];
      })
    );
  }

  if (providers.includes('TheRARBG')) {
    tasks.push(
      searchTheRarbg(cleanQuery, { signal: withProviderTimeout(signal, 3500) }).catch((err) => {
        console.warn('[search:TheRARBG] Scraper error:', err.message);
        return [];
      })
    );
  }

  const resultsNested = await Promise.all(tasks);
  const rawResults = resultsNested.flat();

  // Deduplicate across indexers using both infoHash and normalized title + size
  const seenByHash = new Map();
  const seenByTitle = new Map();
  const tokens = extractQueryTokens(lowerQuery);

  for (const item of rawResults) {
    if (!item || typeof item.title !== 'string') continue;
    const title = item.title.trim();
    const lowerTitle = title.toLowerCase();

    // Skip empty placeholder rows or broken scrapes
    if (!title || lowerTitle === 'no results returned' || lowerTitle === 'no results found') continue;
    if (title.length < 3 || (title.startsWith('(') && title.endsWith(')'))) continue;
    if (tokens.length > 0 && !tokens.some((tok) => lowerTitle.includes(tok))) continue;
    if (item.id === '0' && (item.size === '0 B' || !item.size)) continue;

    const infoHash = (item.infoHash || extractInfoHash(item.magnet) || '').toLowerCase();
    item.infoHash = infoHash;
    const normTitle = normalizeTitleForDedup(title);
    const sizeBytes = parseSizeToBytes(item.size);
    const sizeMb = Math.round(sizeBytes / (1024 * 1024));
    const titleKey = normTitle ? `${normTitle}|${sizeMb}` : '';

    let existing = null;
    if (infoHash && seenByHash.has(infoHash)) {
      existing = seenByHash.get(infoHash);
    } else if (titleKey && seenByTitle.has(titleKey)) {
      existing = seenByTitle.get(titleKey);
    }

    if (existing) {
      if ((item.seeds || 0) > (existing.seeds || 0)) {
        if (!item.magnet && existing.magnet) item.magnet = existing.magnet;
        if (!item.infoHash && existing.infoHash) item.infoHash = existing.infoHash;
        if (infoHash) seenByHash.set(infoHash, item);
        if (titleKey) seenByTitle.set(titleKey, item);
      } else {
        if (!existing.magnet && item.magnet) existing.magnet = item.magnet;
        if (!existing.infoHash && item.infoHash) existing.infoHash = item.infoHash;
      }
      continue;
    }

    if (infoHash) seenByHash.set(infoHash, item);
    if (titleKey) seenByTitle.set(titleKey, item);
  }

  const deduped = Array.from(new Set([...seenByHash.values(), ...seenByTitle.values()]));

  // Drop loose single-token OR matches from broad indexers when multi-token hits exist
  let candidates = deduped;
  if (tokens.length >= 2) {
    const fullMatches = deduped.filter((item) => {
      const lowerTitle = item.title.toLowerCase();
      return tokens.every((tok) => lowerTitle.includes(tok));
    });
    if (fullMatches.length >= 3) {
      candidates = fullMatches;
    }
  }

  // Precompute scores once in O(N), then sort descending with seeds/peers tiebreakers
  const scored = candidates.map((item) => ({
    item,
    score: scoreSearchResultWithTokens(item, lowerQuery, tokens),
  }));

  scored.sort((a, b) => {
    const diff = b.score - a.score;
    if (diff !== 0) return diff;
    const sDiff = (b.item.seeds || 0) - (a.item.seeds || 0);
    if (sDiff !== 0) return sDiff;
    return (b.item.peers || 0) - (a.item.peers || 0);
  });

  const ranked = scored.map((entry) => entry.item);

  if (ranked.length > 0) {
    if (federatedCache.size >= FEDERATED_CACHE_MAX_SIZE) {
      for (const [k, v] of federatedCache.entries()) {
        if (now - v.timestampMs >= FEDERATED_CACHE_TTL_MS) federatedCache.delete(k);
      }
      if (federatedCache.size >= FEDERATED_CACHE_MAX_SIZE) {
        const oldestKey = federatedCache.keys().next().value;
        if (oldestKey !== undefined) federatedCache.delete(oldestKey);
      }
    }
    federatedCache.set(cacheKey, {
      timestampMs: now,
      items: ranked.map((it) => ({ ...it })),
    });
  }

  if (limit && Number.isInteger(limit) && limit > 0) {
    return ranked.slice(0, limit);
  }

  return ranked;
}

// ---------------------------------------------------------------------------
// 6. Magnet Resolution
// ---------------------------------------------------------------------------
export async function resolveMagnet({ provider, desc, link, magnet, infoHash, title } = {}) {
  if (typeof magnet === 'string' && magnet.startsWith('magnet:?xt=urn:btih:')) {
    return magnet;
  }

  if (typeof infoHash === 'string' && infoHash.trim()) {
    return formatMagnetUri(infoHash, title);
  }

  // If link points to apibay details (t.php?id=...), validate URL structure strictly
  if (typeof link === 'string') {
    const idMatch = link.match(/^https?:\/\/apibay\.org\/t\.php\?id=(\d+)$/);
    if (idMatch) {
      const safeId = idMatch[1];
      const safeUrl = `https://apibay.org/t.php?id=${safeId}`;
      try {
        const res = await fetch(safeUrl, {
          headers: { Accept: 'application/json' },
        });
        if (res.ok) {
          const data = await res.json();
          if (data && data.info_hash) {
            return formatMagnetUri(data.info_hash, data.name || title);
          }
        }
      } catch {
        // Fall through
      }
    }
  }

  // Strictly validate extto.org detail URLs for deferred trending torrent magnet resolution
  const detailCandidate = [link, desc].find((u) => typeof u === 'string' && u.includes('/post-detail/'));
  if (detailCandidate) {
    try {
      const parsed = new URL(detailCandidate);
      if (
        parsed.protocol === 'https:' &&
        parsed.hostname === 'extto.org' &&
        /^\/post-detail\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9._-]+)?\/?$/.test(parsed.pathname)
      ) {
        const res = await fetch(`https://extto.org${parsed.pathname}`, {
          headers: {
            ...THERARBG_HEADERS,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const html = await res.text();
          const magnetMatch = html.match(/href="(magnet:\?[^"]+)"/i);
          if (magnetMatch) {
            return decodeHtmlEntities(magnetMatch[1]).trim();
          }
          const hashMatch = html.match(/\b([a-fA-F0-9]{40})\b/);
          if (hashMatch) {
            return formatMagnetUri(hashMatch[1], title);
          }
        }
      }
    } catch {
      // Fall through
    }
  }

  return '';
}

// ---------------------------------------------------------------------------
// 7. Discover / Trending Movies, TV & Anime Releases
// ---------------------------------------------------------------------------
const DISCOVER_CATEGORIES = {
  movies: { extto: 'Movies', apibay: '207', spotlightType: 'apple-movies' },
  tv: { extto: 'TV', apibay: '208', spotlightType: 'apple-tv' },
  anime: { extto: 'Anime', apibay: null, spotlightType: 'anilist-anime' },
};

const DISCOVER_WINDOWS = new Set(['1D', '7D', '30D']);
const DISCOVER_CACHE_TTL_MS = 10 * 60 * 1000;
const DISCOVER_STALE_MAX_MS = 24 * 60 * 60 * 1000;
const SPOTLIGHT_CACHE_TTL_MS = 15 * 60 * 1000;
const IMDB_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const IMDB_CACHE_MAX_ENTRIES = 320;
const POSTER_CACHE_TTL_MS = 30 * 60 * 1000;
const POSTER_CACHE_MAX_ENTRIES = 260;
const POSTER_REGISTRY_MAX_ENTRIES = 1000;
const POSTER_TOKEN_RE = /^[a-f0-9]{24}$/;
const ALLOWED_POSTER_HOST_RE = /(?:^|\.)mzstatic\.com$|^(?:s\d+\.)?anilist\.co$|^i\.rar\.pics$|^m\.media-amazon\.com$/i;
const NSFW_SPOTLIGHT_RE = /\b(hentai|xxx|porn|onlyfans|jav|brazzers|naughtyamerica|nsfw|uncensored|playboy|erotic|18\+)\b/i;

const discoverCache = new Map();
const discoverInFlight = new Map();
const spotlightCache = new Map();
const imdbCardCache = new Map();
const posterCache = new Map();
const posterInFlight = new Map();
const posterUrlRegistry = new Map();

/**
 * Validates that a poster URL is HTTPS (default port, no credentials) and hosted on an allowlisted CDN.
 * @param {string} rawUrl
 * @returns {boolean}
 */
export function isAllowedPosterUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password || parsed.port) return false;
    return ALLOWED_POSTER_HOST_RE.test(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Registers a server-discovered poster URL and returns its opaque 24-char token ID.
 * Prevents arbitrary user-supplied URLs from reaching the poster proxy fetcher.
 * @param {string} rawUrl
 * @returns {string}
 */
export function registerDiscoverPoster(rawUrl) {
  if (!isAllowedPosterUrl(rawUrl)) return '';
  const canonicalUrl = new URL(rawUrl.trim()).toString();
  const token = crypto.createHash('sha256').update(canonicalUrl).digest('hex').slice(0, 24);
  posterUrlRegistry.delete(token);
  if (posterUrlRegistry.size >= POSTER_REGISTRY_MAX_ENTRIES) {
    const oldestToken = posterUrlRegistry.keys().next().value;
    if (oldestToken) posterUrlRegistry.delete(oldestToken);
  }
  posterUrlRegistry.set(token, canonicalUrl);
  return token;
}

/**
 * Fetches and caches a Discover poster image for a server-issued token ID.
 * @param {string} token
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ contentType: string, buffer: Buffer } | null>}
 */
export async function fetchRegisteredPoster(token, { signal } = {}) {
  if (typeof token !== 'string' || !POSTER_TOKEN_RE.test(token)) return null;
  const safeUrl = posterUrlRegistry.get(token);
  if (!safeUrl) return null;
  return fetchDiscoverPoster(safeUrl, { signal });
}

async function fetchDiscoverPoster(rawUrl, { signal } = {}) {
  if (!isAllowedPosterUrl(rawUrl)) return null;
  const normalizedUrl = rawUrl.trim();
  const now = Date.now();

  const cached = posterCache.get(normalizedUrl);
  if (cached && now - cached.timestampMs < POSTER_CACHE_TTL_MS) {
    posterCache.delete(normalizedUrl);
    posterCache.set(normalizedUrl, cached);
    return { contentType: cached.contentType, buffer: cached.buffer };
  }

  if (posterInFlight.has(normalizedUrl)) {
    return posterInFlight.get(normalizedUrl);
  }

  const task = (async () => {
    try {
      const fetchSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(4500)])
        : AbortSignal.timeout(4500);
      const res = await fetch(normalizedUrl, {
        signal: fetchSignal,
        headers: {
          ...THERARBG_HEADERS,
          Accept: 'image/webp,image/avif,image/jpeg,image/png,image/*;q=0.8,*/*;q=0.5',
        },
      });
      if (!res.ok) return null;

      const rawCt = String(res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim().toLowerCase();
      if (!rawCt.startsWith('image/')) return null;

      const arrayBuf = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);
      if (buffer.length === 0 || buffer.length > 4 * 1024 * 1024) return null;

      if (posterCache.size >= POSTER_CACHE_MAX_ENTRIES) {
        const oldestKey = posterCache.keys().next().value;
        if (oldestKey) posterCache.delete(oldestKey);
      }

      posterCache.set(normalizedUrl, { contentType: rawCt, buffer, timestampMs: Date.now() });
      return { contentType: rawCt, buffer };
    } catch {
      return null;
    } finally {
      posterInFlight.delete(normalizedUrl);
    }
  })();

  posterInFlight.set(normalizedUrl, task);
  return task;
}

async function warmPosterUrls(cards) {
  const urls = Array.from(new Set(
    (Array.isArray(cards) ? cards : [])
      .map((card) => card?.poster)
      .filter((u) => isAllowedPosterUrl(u))
  ));
  if (urls.length === 0) return;

  for (const url of urls) {
    registerDiscoverPoster(url);
  }

  const concurrency = 8;
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    await Promise.allSettled(batch.map((u) => fetchDiscoverPoster(u)));
  }
}

/**
 * Parses `https://extto.org/trending/<limit>/<category>/<window>/` HTML tables.
 * @param {string} html
 * @param {string} [baseUrl]
 * @returns {Array<object>}
 */
export function parseExttoTrendingHtml(html, baseUrl = THERARBG_PRIMARY_BASE) {
  if (!html || typeof html !== 'string') return [];
  const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) return [];

  const rows = tbodyMatch[1].split(/<tr[^>]*>/i).slice(1);
  const provider = resolveTheRarbgProvider(baseUrl);
  const results = [];

  for (const row of rows) {
    const linkMatch = row.match(/<a\s+href="(\/post-detail\/([^/"]+)\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const relPath = linkMatch[1].trim();
    const id = linkMatch[2].trim();
    const title = decodeHtmlEntities(stripHtmlTags(linkMatch[3])).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    if (!title || title.includes('${') || relPath.includes('${')) continue;

    const sizeMatch = row.match(/<span class="add-block">Size<\/span>\s*<span>([^<]+)<\/span>/i);
    const ageMatch = row.match(/<td class="nowrap-td hide-on-mob">\s*<div class="add-block-wrapper">\s*<span>([^<]+)<\/span>/i);
    const seedMatch = row.match(/<span class="text-success">([\d,]+)<\/span>/i);
    const peerMatch = row.match(/<span class="text-danger">([\d,]+)<\/span>/i);
    const imdbMatch = row.match(/\/imdb-detail\/(tt\d+)\//i);

    const detailUrl = `${baseUrl}${relPath}`;
    results.push({
      provider,
      id,
      title,
      size: sizeMatch ? sizeMatch[1].replace(/\u00a0/g, ' ').trim() : '',
      age: ageMatch ? ageMatch[1].replace(/\u00a0/g, ' ').trim() : '',
      seeds: sanitizeSwarmCount(seedMatch ? seedMatch[1].replace(/,/g, '') : 0),
      peers: sanitizeSwarmCount(peerMatch ? peerMatch[1].replace(/,/g, '') : 0),
      imdbId: imdbMatch ? imdbMatch[1] : '',
      infoHash: '',
      magnet: '',
      desc: detailUrl,
      link: detailUrl,
    });
  }

  return results;
}

/**
 * Parses Apple iTunes RSS Top Movies / TV Seasons feeds into compact WebP spotlight cards.
 * @param {object} data
 * @param {'movies'|'tv'} [kind]
 * @returns {Array<object>}
 */
export function parseAppleSpotlightFeed(data, kind = 'movies') {
  const rawEntries = data?.feed?.entry;
  const entries = Array.isArray(rawEntries) ? rawEntries : rawEntries ? [rawEntries] : [];
  const cards = [];

  for (const entry of entries) {
    const rawTitle = entry?.['im:name']?.label;
    if (!rawTitle || typeof rawTitle !== 'string') continue;

    const title = rawTitle.replace(/\s+/g, ' ').trim();
    const releaseIso = entry?.['im:releaseDate']?.label || '';
    const yearMatch = releaseIso.match(/^(\d{4})/);
    const year = yearMatch ? yearMatch[1] : '';
    const genre = entry?.category?.attributes?.label || '';
    const summary = typeof entry?.summary?.label === 'string' ? entry.summary.label.trim() : '';

    const images = Array.isArray(entry?.['im:image']) ? entry['im:image'] : [];
    const rawPoster = images[images.length - 1]?.label || '';
    const poster = typeof rawPoster === 'string'
      ? rawPoster.replace(/\/\d+x\d+bb\.(png|jpg|webp)$/i, '/240x360bb.webp')
      : '';

    const cleanSearchBase = title
      .replace(/,\s*Season\s+\d+$/i, '')
      .replace(/:\s*The Complete Series$/i, '')
      .replace(/\s*\(\d{4}\)\s*$/g, '')
      .trim();
    const searchQuery = kind === 'movies' && year ? `${cleanSearchBase} ${year}` : cleanSearchBase;

    cards.push({
      id: entry?.id?.attributes?.['im:id'] || title,
      title,
      year,
      genre,
      summary,
      poster,
      searchQuery,
    });
  }

  return cards;
}

/**
 * Parses AniList GraphQL trending anime payload into spotlight cards.
 * @param {object} data
 * @returns {Array<object>}
 */
export function parseAniListSpotlight(data) {
  const mediaList = data?.data?.Page?.media;
  if (!Array.isArray(mediaList)) return [];
  const cards = [];

  for (const item of mediaList) {
    if (!item || item.isAdult) continue;
    const rawTitle = item?.title?.english || item?.title?.romaji;
    if (!rawTitle || typeof rawTitle !== 'string') continue;

    const title = rawTitle.replace(/\s+/g, ' ').trim();
    const year = Number.isFinite(item.seasonYear) ? String(item.seasonYear) : '';
    const genres = Array.isArray(item.genres) ? item.genres.filter((g) => typeof g === 'string') : [];
    const poster = item?.coverImage?.large || item?.coverImage?.medium || '';
    const searchQuery = title
      .replace(/:\s*Season\s+\d+$/i, '')
      .replace(/\s+Season\s+\d+$/i, '')
      .trim();

    cards.push({
      id: `anilist-${item.id || title}`,
      title,
      year,
      genre: genres[0] || 'Anime',
      summary: genres.slice(0, 3).join(', '),
      poster: typeof poster === 'string' ? poster : '',
      searchQuery: searchQuery || title,
    });
  }

  return cards;
}

/**
 * Converts a relative torrent age label (e.g. "2 hours ago", "8 days ago") into approximate hours.
 * @param {string} ageStr
 * @returns {number}
 */
export function parseRelativeAgeHours(ageStr) {
  if (!ageStr || typeof ageStr !== 'string') return Number.POSITIVE_INFINITY;
  const match = ageStr.trim().toLowerCase().match(/(\d+(?:\.\d+)?)\s*(sec|second|min|minute|hour|hr|day|week|wk|month|mo|year|yr)s?/);
  if (!match) return Number.POSITIVE_INFINITY;
  const num = Number(match[1]);
  if (!Number.isFinite(num)) return Number.POSITIVE_INFINITY;
  const unit = match[2];
  if (unit.startsWith('sec')) return num / 3600;
  if (unit.startsWith('min')) return num / 60;
  if (unit.startsWith('h')) return num;
  if (unit.startsWith('d')) return num * 24;
  if (unit.startsWith('w')) return num * 24 * 7;
  if (unit.startsWith('mo')) return num * 24 * 30;
  if (unit.startsWith('y')) return num * 24 * 365;
  return Number.POSITIVE_INFINITY;
}

/**
 * Preserves per-window trending relevance while prioritizing releases matching the active timeframe.
 * @param {Array<object>} rows
 * @param {'1D'|'7D'|'30D'} winKey
 * @returns {Array<object>}
 */
export function orderTrendingByWindow(rows, winKey) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const tierFor = (ageStr) => {
    const hrs = parseRelativeAgeHours(ageStr);
    if (winKey === '1D') {
      return hrs <= 72 ? 0 : 1;
    }
    if (winKey === '7D') {
      return hrs <= 14 * 24 ? 0 : 1;
    }
    if (hrs > 7 * 24 && hrs <= 60 * 24) return 0;
    if (hrs <= 7 * 24) return 1;
    return 2;
  };

  const buckets = [[], [], []];
  for (const row of rows) {
    buckets[tierFor(row?.age)].push(row);
  }
  return [...buckets[0], ...buckets[1], ...buckets[2]];
}

/**
 * Extracts distinct movie or TV titles (and optional IMDb IDs) from trending torrent names.
 * @param {Array<object>} rows
 * @param {'movies'|'tv'|'anime'} catKey
 * @param {number} [limit]
 * @returns {Array<{ normKey: string, title: string, year: string, imdbId: string }>}
 */
export function extractSpotlightCandidates(rows, catKey = 'movies', limit = 14) {
  const candidates = [];
  const byNorm = new Map();

  for (const row of rows) {
    if (!row?.title || NSFW_SPOTLIGHT_RE.test(row.title)) continue;
    let raw = row.title
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/\.(?=[a-z0-9])/gi, ' ')
      .replace(/[()_]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const yearMatch = raw.match(/\b(19\d\d|20\d\d)\b/);
    const year = yearMatch ? yearMatch[1] : '';

    if (catKey === 'tv') {
      const cut = raw.search(/\b(S\d{1,2}(?:E\d{1,2})?|Season\s*\d+|Complete|1080[pi]|2160p|720p|480p|WEB[-\s]?DL|WEBRip|BluRay|HDTV|x264|x265|HEVC|10bit|AAC|DDP)\b/i);
      if (cut > 1) raw = raw.slice(0, cut).trim();
    } else {
      const yearIdx = year ? raw.indexOf(year) : -1;
      const techCut = raw.search(/\b(2160p|1080[pi]|720p|480p|540p|4k|uhd|hdr\d*|bluray|blu[-\s]?ray|bdrip|brrip|web[-\s]?dl|webrip|tsrip|hdts|hdcam|camrip|dvdrip|x264|x265|hevc|10bit|remux|aac|ddp?\d|repack|encore)\b/i);
      const cut = yearIdx > 1 && (techCut < 0 || yearIdx < techCut) ? yearIdx : techCut;
      if (cut > 1) raw = raw.slice(0, cut).trim();
    }

    const cleanTitle = raw
      .replace(/\b(19\d\d|20\d\d)\b/g, '')
      .replace(/[-:.,\s]+$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleanTitle || cleanTitle.length < 2) continue;

    const normKey = cleanTitle.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!normKey) continue;

    const validImdb = /^tt\d+$/i.test(row.imdbId || '') ? row.imdbId.toLowerCase() : '';
    const existing = byNorm.get(normKey);
    if (existing) {
      if (!existing.imdbId && validImdb) existing.imdbId = validImdb;
      continue;
    }

    const entry = { normKey, title: cleanTitle, year, imdbId: validImdb };
    byNorm.set(normKey, entry);
    candidates.push(entry);
    if (candidates.length >= limit) break;
  }

  return candidates;
}

async function fetchExttoTrending(exttoCategory, win, signal) {
  const url = `${THERARBG_PRIMARY_BASE}/trending/50/${encodeURIComponent(exttoCategory)}/${encodeURIComponent(win)}/`;
  const res = await fetch(url, {
    signal,
    headers: {
      ...THERARBG_HEADERS,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  if (!res.ok) {
    throw new Error(`extto.org trending (${exttoCategory}/${win}) HTTP ${res.status}`);
  }
  return parseExttoTrendingHtml(await res.text(), THERARBG_PRIMARY_BASE);
}

async function fetchApibayTrending(catId, signal) {
  const url = `https://apibay.org/precompiled/data_top100_${encodeURIComponent(catId)}.json`;
  const res = await fetch(url, {
    signal,
    headers: { ...THERARBG_HEADERS, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`apibay top100_${catId} HTTP ${res.status}`);
  }
  return parseApibayItems(await res.json(), 50);
}

function normalizeImdbSuggestionCard(data, catKey, fallbackYear = '') {
  const hits = Array.isArray(data?.d) ? data.d : [];
  if (hits.length === 0) return null;

  const isVideoHit = (h) => h?.i?.imageUrl && !/videoGame|musicVideo|podcast/i.test(String(h?.q || ''));
  const typeMatch = catKey === 'tv' ? /tv|mini/i : /feature|movie|video/i;
  const pick = catKey === 'tv'
    ? hits.find((h) => isVideoHit(h) && typeMatch.test(String(h?.q || '')))
    : hits.find((h) => isVideoHit(h) && typeMatch.test(String(h?.q || ''))) || hits.find((h) => isVideoHit(h));

  if (!pick || !pick.l || !pick.i?.imageUrl) return null;

  const rawPoster = String(pick.i.imageUrl);
  const poster = rawPoster.replace(/\._V1_.*\.(jpg|jpeg|png|webp)$/i, '._V1_UX240_.jpg');
  const title = String(pick.l).replace(/\s+/g, ' ').trim();
  const year = Number.isFinite(Number(pick.y)) && pick.y > 0 ? String(pick.y) : fallbackYear;

  return {
    id: String(pick.id || title),
    title,
    year,
    genre: pick.q === 'TV series' || pick.q === 'TV mini-series' ? 'Series' : '',
    summary: '',
    poster,
    searchQuery: catKey === 'movies' && year ? `${title} ${year}` : title,
  };
}

async function lookupImdbSpotlightCard(candidate, catKey, signal) {
  const cacheKey = `${catKey}|${candidate.imdbId || candidate.normKey}`;
  const now = Date.now();
  const cached = imdbCardCache.get(cacheKey);
  if (cached && now - cached.timestampMs < IMDB_CACHE_TTL_MS) {
    return cached.card ? { ...cached.card } : null;
  }

  const paths = [];
  if (candidate.imdbId) {
    paths.push(`t/${candidate.imdbId}.json`);
  }
  const qStr = `${candidate.title}${candidate.year && catKey === 'movies' ? ` ${candidate.year}` : ''}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 48);
  if (qStr) {
    const bucket = /^[a-z0-9]/.test(qStr) ? qStr[0] : 'x';
    paths.push(`${bucket}/${encodeURIComponent(qStr)}.json`);
  }

  let card = null;
  for (const relPath of paths) {
    try {
      const fetchSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(3000)])
        : AbortSignal.timeout(3000);
      const res = await fetch(`https://v3.sg.media-imdb.com/suggestion/${relPath}`, {
        signal: fetchSignal,
        headers: { ...THERARBG_HEADERS, Accept: 'application/json' },
      });
      if (!res.ok) continue;
      card = normalizeImdbSuggestionCard(await res.json(), catKey, candidate.year);
      if (card) break;
    } catch {
      // Try next path or return null
    }
  }

  if (imdbCardCache.size >= IMDB_CACHE_MAX_ENTRIES) {
    const oldest = imdbCardCache.keys().next().value;
    if (oldest) imdbCardCache.delete(oldest);
  }
  imdbCardCache.set(cacheKey, { timestampMs: now, card });
  return card ? { ...card } : null;
}

async function fetchAniListSpotlight(winKey, signal) {
  const year = new Date().getFullYear();
  let mediaFilter = 'type: ANIME, isAdult: false, sort: TRENDING_DESC';
  if (winKey === '7D') {
    mediaFilter = 'type: ANIME, isAdult: false, status: RELEASING, sort: POPULARITY_DESC';
  } else if (winKey === '30D') {
    mediaFilter = `type: ANIME, isAdult: false, seasonYear: ${year}, sort: SCORE_DESC`;
  }

  const query = `{ Page(perPage: 14) { media(${mediaFilter}) { id isAdult title { english romaji } seasonYear genres coverImage { large medium } } } }`;
  try {
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      signal,
      headers: {
        ...THERARBG_HEADERS,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query }),
    });
    if (res.ok) {
      return parseAniListSpotlight(await res.json()).slice(0, 14);
    }
  } catch {
    // Ignore AniList spotlight failure and fall back to empty list
  }
  return [];
}

async function fetchAppleSpotlightFeed(kind, winKey, signal) {
  const appleFeed = kind === 'tv'
    ? (winKey === '1D' ? 'toptvepisodes' : 'toptvseasons')
    : 'topmovies';
  try {
    const res = await fetch(`https://itunes.apple.com/us/rss/${appleFeed}/limit=20/json`, {
      signal,
      headers: { ...THERARBG_HEADERS, Accept: 'application/json' },
    });
    if (res.ok) {
      const cards = parseAppleSpotlightFeed(await res.json(), kind);
      if (cards.length > 0) return cards;
    }
  } catch {
    // Ignore Apple RSS fallback error
  }
  return [];
}

async function buildWindowSpotlight(catKey, winKey, orderedExttoRows, signal, forceRefresh = false) {
  const cacheKey = `${catKey}|${winKey}`;
  const now = Date.now();
  if (!forceRefresh) {
    const cached = spotlightCache.get(cacheKey);
    if (cached && now - cached.timestampMs < SPOTLIGHT_CACHE_TTL_MS) {
      return cached.cards.map((c) => ({ ...c }));
    }
  }

  let cards = [];
  if (catKey === 'anime') {
    cards = await fetchAniListSpotlight(winKey, signal);
  } else {
    const candidates = extractSpotlightCandidates(orderedExttoRows, catKey, 16);
    const seenIds = new Set();
    const seenNorm = new Set();

    const lookups = await Promise.allSettled(
      candidates.map((cand) => lookupImdbSpotlightCard(cand, catKey, signal))
    );

    for (const res of lookups) {
      if (res.status !== 'fulfilled' || !res.value) continue;
      const card = res.value;
      const normTitle = card.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (seenIds.has(card.id) || (normTitle && seenNorm.has(normTitle))) continue;
      seenIds.add(card.id);
      if (normTitle) seenNorm.add(normTitle);
      cards.push(card);
      if (cards.length >= 14) break;
    }

    if (cards.length < 12) {
      const fallbackCards = await fetchAppleSpotlightFeed(catKey, winKey, signal);
      for (const card of fallbackCards) {
        const normTitle = card.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        if (seenIds.has(card.id) || (normTitle && seenNorm.has(normTitle))) continue;
        seenIds.add(card.id);
        if (normTitle) seenNorm.add(normTitle);
        cards.push(card);
        if (cards.length >= 14) break;
      }
    }
  }

  if (cards.length > 0) {
    spotlightCache.set(cacheKey, { timestampMs: now, cards });
    void warmPosterUrls(cards);
  }

  return cards.map((c) => ({ ...c }));
}

function normalizeWorkKey(title, catKey = 'movies') {
  const [cand] = extractSpotlightCandidates([{ title }], catKey, 1);
  if (!cand) return normalizeTitleForDedup(title);
  if (catKey === 'tv') {
    const epMatch = String(title || '').match(/\b(S\d{1,2}E\d{1,2}|S\d{1,2})\b/i);
    return epMatch ? `${cand.normKey} ${epMatch[1].toLowerCase()}` : cand.normKey;
  }
  return cand.year ? `${cand.normKey} ${cand.year}` : cand.normKey;
}

const CAM_QUALITY_RE = /\b(cam|camrip|hdcam|tsrip|hdts|telesync|dvdscr|screener|workprint|hq[\s._-]?clean|1xbet|line[\s._-]?audio)\b/i;
const HD_DIGITAL_RE = /\b(2160p|1080[pi])\b.*\b(web[-\s.]?dl|webrip|bluray|blu[-\s.]?ray|remux|bdrip)\b|\b(web[-\s.]?dl|webrip|bluray|blu[-\s.]?ray|remux|bdrip)\b.*\b(2160p|1080[pi])\b/i;

/**
 * Computes an intelligent trending score balancing swarm velocity, multi-source consensus,
 * timeframe freshness, release quality, and editorial demand rank.
 * @param {object} item
 * @param {{ winKey?: '1D'|'7D'|'30D', mergedProviders?: Set<string>, workProviderCount?: number, exttoRank?: number }} ctx
 * @returns {number}
 */
export function scoreTrendingRelease(
  item,
  { winKey = '7D', mergedProviders, workProviderCount = 1, exttoRank = null } = {}
) {
  const seeds = Math.max(0, Number(item?.seeds || 0));
  const peers = Math.max(0, Number(item?.peers || 0));
  if (seeds === 0 && peers === 0) return -100;

  const swarmScore =
    Math.log10(seeds + 1) * 18 +
    Math.log10(peers + 1) * 11 +
    (peers > 0 ? Math.min(10, (peers / Math.max(seeds, 1)) * 12) : 0);

  const exactConsensus = mergedProviders ? Math.min(48, Math.max(0, mergedProviders.size - 1) * 20) : 0;
  const workConsensus = Math.min(42, Math.max(0, workProviderCount - 1) * 16);

  const hrs = parseRelativeAgeHours(item?.age);
  let freshness = 5;
  if (Number.isFinite(hrs)) {
    if (winKey === '1D') {
      if (hrs <= 24) freshness = 65;
      else if (hrs <= 48) freshness = 45;
      else if (hrs <= 72) freshness = 22;
      else if (hrs <= 168) freshness = 0;
      else if (hrs <= 720) freshness = -38;
      else freshness = -75;
    } else if (winKey === '7D') {
      if (hrs <= 72) freshness = 32;
      else if (hrs <= 336) freshness = 48;
      else if (hrs <= 504) freshness = 15;
      else if (hrs > 1080) freshness = -50;
      else freshness = 0;
    } else {
      if (hrs > 168 && hrs <= 1080) freshness = 45;
      else if (hrs <= 168) freshness = 15;
      else if (hrs > 2160) freshness = -35;
      else freshness = 5;
    }
  }

  const editorialRankBoost = Number.isInteger(exttoRank) && exttoRank >= 0
    ? 28 * Math.max(0, 1 - exttoRank / 60)
    : 0;
  const magnetBoost = item?.magnet || item?.infoHash ? 6 : 0;

  const title = String(item?.title || '');
  let qualityAdjust = 0;
  if (CAM_QUALITY_RE.test(title)) qualityAdjust -= 32;
  else if (HD_DIGITAL_RE.test(title)) qualityAdjust += 14;

  return swarmScore + exactConsensus + workConsensus + freshness + editorialRankBoost + magnetBoost + qualityAdjust;
}

/**
 * Aggregates and intelligently ranks trending releases across all profiled sources.
 * @param {Array<{ source: string, items: Array<object> }>} batches
 * @param {{ catKey?: 'movies'|'tv'|'anime', winKey?: '1D'|'7D'|'30D', maxPerWork?: number, limit?: number }} [opts]
 * @returns {Array<object>}
 */
export function rankMultiSourceTrending(
  batches,
  { catKey = 'movies', winKey = '7D', maxPerWork = 2, limit = 85 } = {}
) {
  const merged = new Map();
  const workProviders = new Map();

  for (const batch of batches) {
    if (!batch || !Array.isArray(batch.items)) continue;
    for (let idx = 0; idx < batch.items.length; idx += 1) {
      const item = batch.items[idx];
      if (!item || !item.title || NSFW_SPOTLIGHT_RE.test(item.title)) continue;

      const workKey = normalizeWorkKey(item.title, catKey);
      const provName = String(item.provider || batch.source || 'Unknown');
      if (workKey) {
        if (!workProviders.has(workKey)) workProviders.set(workKey, new Set());
        workProviders.get(workKey).add(provName);
      }

      const normTitle = normalizeTitleForDedup(item.title);
      const sizeMb = Math.round(parseSizeToBytes(item.size) / (1024 * 1024));
      const dedupKey = item.infoHash
        ? `hash:${item.infoHash.toLowerCase()}`
        : normTitle
          ? `title:${normTitle}|${sizeMb}`
          : `id:${provName}|${item.title}`;

      const isExtto = provName === 'extto.org' || batch.source === 'extto';
      const existing = merged.get(dedupKey);
      if (!existing) {
        merged.set(dedupKey, {
          item: { ...item },
          providers: new Set([provName]),
          exttoRank: isExtto ? idx : null,
          workKey,
        });
        continue;
      }

      existing.providers.add(provName);
      if (isExtto && (existing.exttoRank === null || idx < existing.exttoRank)) {
        existing.exttoRank = idx;
      }

      const dst = existing.item;
      if (!dst.magnet && item.magnet) {
        dst.magnet = item.magnet;
        dst.infoHash = dst.infoHash || item.infoHash || '';
        if (dst.provider === 'extto.org' && item.provider) {
          dst.provider = item.provider;
        }
      }
      if (!dst.infoHash && item.infoHash) dst.infoHash = item.infoHash;
      if (!dst.age && item.age) dst.age = item.age;
      if (!dst.imdbId && item.imdbId) dst.imdbId = item.imdbId;
      if ((item.seeds || 0) > (dst.seeds || 0)) dst.seeds = item.seeds;
      if ((item.peers || 0) > (dst.peers || 0)) dst.peers = item.peers;
    }
  }

  const scored = Array.from(merged.values()).map((entry) => {
    const workProviderCount = entry.workKey ? (workProviders.get(entry.workKey)?.size || 1) : 1;
    return {
      ...entry,
      score: scoreTrendingRelease(entry.item, {
        winKey,
        mergedProviders: entry.providers,
        workProviderCount,
        exttoRank: entry.exttoRank,
      }),
    };
  });

  scored.sort((a, b) => b.score - a.score);

  const selected = [];
  const deferred = [];
  const workCounts = new Map();

  for (const entry of scored) {
    if (!entry.workKey) {
      selected.push(entry.item);
      continue;
    }
    const count = workCounts.get(entry.workKey) || 0;
    if (count < maxPerWork) {
      workCounts.set(entry.workKey, count + 1);
      selected.push(entry.item);
    } else {
      deferred.push(entry.item);
    }
  }

  return [...selected, ...deferred].slice(0, limit);
}

async function fetchApibayWindowTrending(catKey, winKey, catId, signal) {
  const endpoint = winKey === '1D'
    ? `data_top100_48h_${encodeURIComponent(catId)}.json`
    : `data_top100_${encodeURIComponent(catId)}.json`;
  const items = await fetchApibayTrending(endpoint.replace(/^data_top100_|\.json$/g, ''), signal);
  const currentYear = new Date().getFullYear();
  if (catKey === 'movies' && winKey === '1D') {
    return items.filter((it) => {
      const hrs = parseRelativeAgeHours(it.age);
      return !Number.isFinite(hrs) || hrs <= 96 || it.title.includes(String(currentYear));
    });
  }
  return items;
}

async function fetchKnabenTrending(catKey, winKey, signal) {
  const currentYear = new Date().getFullYear();
  const isDay = winKey === '1D';
  const queryMap = {
    movies: { query: String(currentYear), categories: [3000000], filter: /\bmovie/i },
    tv: { query: 'S0', categories: [2000000], filter: /\btv\b/i },
    anime: { query: '1080p', categories: [6000000], filter: /\banime/i },
  };
  const spec = queryMap[catKey];
  if (!spec) return [];

  const data = await queryKnabenRaw({
    search_field: 'title',
    query: spec.query,
    order_by: isDay ? 'date' : 'seeders',
    order_direction: 'desc',
    categories: spec.categories,
    hide_xxx: true,
    hide_unsafe: true,
    from: 0,
    size: isDay ? 60 : 70,
  }, { signal });

  const parsed = parseKnabenHits(data, { categoryFilter: spec.filter });
  return parsed.filter((item) => {
    if (catKey !== 'anime' && (item.provider === 'Nyaa' || item.provider === 'TokyoTosho')) return false;
    if (NSFW_SPOTLIGHT_RE.test(item.title)) return false;
    if ((item.seeds || 0) < (isDay ? 5 : 15)) return false;
    if (winKey === '7D') {
      const hrs = parseRelativeAgeHours(item.age);
      return !Number.isFinite(hrs) || hrs <= 21 * 24;
    }
    return true;
  });
}

async function fetchNyaaTrending(winKey, signal) {
  const url = winKey === '1D'
    ? 'https://nyaa.si/?page=rss&c=1_2&f=2'
    : 'https://nyaa.si/?page=rss&c=1_2&f=2&s=seeders&o=desc';
  const res = await fetch(url, {
    signal,
    headers: {
      ...THERARBG_HEADERS,
      Accept: 'application/rss+xml, application/xml, text/xml',
    },
  });
  if (!res.ok) {
    throw new Error(`Nyaa trending HTTP ${res.status}`);
  }
  const rows = parseNyaaRssXml(await res.text(), 60);
  return rows.filter((row) => !NSFW_SPOTLIGHT_RE.test(row.title) && (row.seeds || 0) >= 8);
}

async function fetchEztvTrending(signal) {
  const res = await fetch('https://eztvx.to/api/get-torrents?limit=80&page=1', {
    signal,
    headers: { ...THERARBG_HEADERS, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`EZTV API HTTP ${res.status}`);
  }
  const data = await res.json();
  const list = Array.isArray(data?.torrents) ? data.torrents : [];
  const results = [];

  for (const item of list) {
    if (!item?.title) continue;
    const seeds = sanitizeSwarmCount(item.seeds);
    const peers = sanitizeSwarmCount(item.peers);
    if (seeds < 5 && peers < 5) continue;
    const releasedSec = Number(item.date_released_unix);
    const age = Number.isFinite(releasedSec) && releasedSec > 1000000000
      ? formatRelativeAgeFromMs(releasedSec * 1000)
      : '';
    const entry = buildNormalizedResult({
      provider: 'EZTV',
      id: item.id,
      title: item.title,
      sizeBytes: Number(item.size_bytes),
      age,
      seeds,
      peers,
      infoHash: item.hash,
      magnet: item.magnet_url,
      desc: item.torrent_url || '',
    });
    if (entry) {
      if (item.imdb_id) entry.imdbId = `tt${String(item.imdb_id).replace(/^tt/, '')}`;
      results.push(entry);
    }
  }

  return results;
}

function cloneDiscoverPayload(payload) {
  return {
    category: payload.category,
    window: payload.window,
    spotlight: payload.spotlight.map((c) => ({ ...c })),
    torrents: payload.torrents.map((t) => ({ ...t })),
  };
}

async function fetchAndStoreDiscover(catKey, winKey, forceRefresh, signal) {
  const cacheKey = `${catKey}|${winKey}`;
  const inFlightKey = `${cacheKey}|${forceRefresh ? 'force' : 'normal'}`;
  if (discoverInFlight.has(inFlightKey)) {
    return discoverInFlight.get(inFlightKey);
  }

  const task = (async () => {
    const cfg = DISCOVER_CATEGORIES[catKey];
    const sourceTasks = [
      fetchExttoTrending(cfg.extto, winKey, withProviderTimeout(signal, 6500))
        .then((items) => ({ source: 'extto', items: orderTrendingByWindow(items, winKey) }))
        .catch((err) => {
          console.warn('[discover:extto.org] error:', `${catKey}/${winKey}`, err.message);
          return { source: 'extto', items: [] };
        }),
      fetchKnabenTrending(catKey, winKey, withProviderTimeout(signal, 5500))
        .then((items) => ({ source: 'knaben', items }))
        .catch((err) => {
          console.warn('[discover:Knaben] error:', `${catKey}/${winKey}`, err.message);
          return { source: 'knaben', items: [] };
        }),
    ];

    if (cfg.apibay) {
      sourceTasks.push(
        fetchApibayWindowTrending(catKey, winKey, cfg.apibay, withProviderTimeout(signal, 4500))
          .then((items) => ({ source: 'apibay', items }))
          .catch((err) => {
            console.warn('[discover:ThePirateBay] error:', err.message);
            return { source: 'apibay', items: [] };
          })
      );
    }

    if (catKey === 'anime') {
      sourceTasks.push(
        fetchNyaaTrending(winKey, withProviderTimeout(signal, 5500))
          .then((items) => ({ source: 'nyaa', items }))
          .catch((err) => {
            console.warn('[discover:Nyaa] error:', winKey, err.message);
            return { source: 'nyaa', items: [] };
          })
      );
    } else if (catKey === 'tv' && winKey !== '30D') {
      sourceTasks.push(
        fetchEztvTrending(withProviderTimeout(signal, 5000))
          .then((items) => ({ source: 'eztv', items }))
          .catch((err) => {
            console.warn('[discover:EZTV] error:', err.message);
            return { source: 'eztv', items: [] };
          })
      );
    }

    const batches = await Promise.all(sourceTasks);
    let torrents = rankMultiSourceTrending(batches, { catKey, winKey });

    const prevCached = discoverCache.get(cacheKey);
    if (torrents.length === 0 && prevCached?.payload?.torrents?.length > 0) {
      torrents = prevCached.payload.torrents.map((t) => ({ ...t }));
    }

    const spotlight = await buildWindowSpotlight(
      catKey,
      winKey,
      torrents,
      withProviderTimeout(signal, 4500),
      forceRefresh
    );

    const payload = { category: catKey, window: winKey, spotlight, torrents };
    if (torrents.length > 0) {
      discoverCache.set(cacheKey, { timestampMs: Date.now(), payload });
    }
    return payload;
  })().finally(() => {
    discoverInFlight.delete(inFlightKey);
  });

  discoverInFlight.set(inFlightKey, task);
  return task;
}

/**
 * Fetches trending spotlight cards and trending torrents for Discover (Movies, TV, Anime).
 * Uses stale-while-revalidate caching so Day/Week/Month stay fast and never poison with empty results.
 * @param {{ category?: string, window?: string, forceRefresh?: boolean, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ category: string, window: string, spotlight: Array<object>, torrents: Array<object> }>}
 */
export async function discoverTorrents({ category = 'movies', window = '7D', forceRefresh = false, signal } = {}) {
  const catKey = Object.hasOwn(DISCOVER_CATEGORIES, String(category || '').toLowerCase())
    ? String(category).toLowerCase()
    : 'movies';
  const winKey = DISCOVER_WINDOWS.has(String(window || '').toUpperCase())
    ? String(window).toUpperCase()
    : '7D';

  const cacheKey = `${catKey}|${winKey}`;
  const now = Date.now();
  const cached = discoverCache.get(cacheKey);

  if (!forceRefresh && cached && cached.payload.torrents.length > 0) {
    const ageMs = now - cached.timestampMs;
    if (ageMs < DISCOVER_CACHE_TTL_MS) {
      return cloneDiscoverPayload(cached.payload);
    }
    if (ageMs < DISCOVER_STALE_MAX_MS) {
      void fetchAndStoreDiscover(catKey, winKey, false, undefined).catch(() => {});
      return cloneDiscoverPayload(cached.payload);
    }
  }

  return fetchAndStoreDiscover(catKey, winKey, forceRefresh, signal);
}

/**
 * Warms trending feeds and spotlight poster buffers in gentle batches after boot.
 * @returns {Promise<void>}
 */
export async function warmDiscoverCache() {
  const batches = [
    [['movies', '7D'], ['tv', '7D'], ['anime', '7D']],
    [['movies', '1D'], ['tv', '1D']],
    [['movies', '30D'], ['tv', '30D']],
    [['anime', '1D'], ['anime', '30D']],
  ];

  for (let i = 0; i < batches.length; i += 1) {
    const settled = await Promise.allSettled(
      batches[i].map(([cat, win]) => discoverTorrents({ category: cat, window: win }))
    );
    const cards = settled
      .filter((r) => r.status === 'fulfilled')
      .flatMap((r) => r.value?.spotlight || []);
    if (cards.length > 0) {
      await warmPosterUrls(cards);
    }
    if (i < batches.length - 1) {
      await new Promise((r) => setTimeout(r, 450));
    }
  }
}
