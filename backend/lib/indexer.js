// Federated Multi-Source Indexer Engine for Svorrent
// Replaces torrent-search-api with modern native fetch() scrapers across multiple
// public indexers (ThePirateBay, BitSearch, Torrents.csv, Nyaa).
// Eliminates npm audit CVEs, un-caps 100-result limits, and aggregates hundreds
// of deduplicated torrents across providers.

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
const GAME_OR_SOFTWARE_RE = /\b(fitgirl|dodi|codex|skidrow|flt|plaza|cpass|telltale|dlc|switch|nsp|xci|iso|rom|emulator|crack|keygen|patch|trainer|mod|apk|setup\.exe)\b/i;
const REPACK_WORD_RE = /\brepack\b/i;

const FEDERATED_CACHE_TTL_MS = 90_000;
const FEDERATED_CACHE_MAX_SIZE = 40;
const federatedCache = new Map();

function withProviderTimeout(signal, timeoutMs = 3500) {
  const timerSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timerSignal]) : timerSignal;
}

export function scoreSearchResult(item, query = '') {
  if (!item || !item.title) return 0;
  const lowerQuery = (query || '').trim().toLowerCase();
  const queryTokens = lowerQuery ? lowerQuery.split(/[^a-z0-9]+/).filter((t) => t.length >= 2) : [];
  return scoreSearchResultWithTokens(item, lowerQuery, queryTokens);
}

function scoreSearchResultWithTokens(item, lowerQuery, queryTokens) {
  if (!item || !item.title) return 0;
  let score = 0;
  const title = item.title.trim();
  const lowerTitle = title.toLowerCase();

  // 1. Query matching
  if (lowerQuery && lowerTitle.includes(lowerQuery)) {
    score += 4000;
  }
  if (lowerQuery && lowerTitle.startsWith(lowerQuery)) {
    score += 1500;
  }
  if (queryTokens.length > 0) {
    let matchedCount = 0;
    for (let i = 0; i < queryTokens.length; i++) {
      if (lowerTitle.includes(queryTokens[i])) matchedCount++;
    }
    score += (matchedCount / queryTokens.length) * 2000;
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

  // 6. Seed count (capped influence so spam seeds cannot overpower true movies)
  const seeds = Math.max(0, item.seeds || 0);
  score += Math.min(seeds, 2500);

  return score;
}

// ---------------------------------------------------------------------------
// 1. ThePirateBay (apibay.org JSON API)
// ---------------------------------------------------------------------------
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

  const data = await res.json();
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

    results.push({
      provider: 'ThePirateBay',
      id: String(item.id),
      title,
      size: sizeStr,
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

  const xml = await res.text();
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

    results.push({
      provider: 'Nyaa',
      title,
      size,
      seeds,
      peers,
      infoHash,
      magnet: infoHash ? formatMagnetUri(infoHash, title) : '',
      desc,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// 5. Federated Search Aggregator & Deduplication
// ---------------------------------------------------------------------------
export async function searchFederated(
  query,
  {
    limit,
    providers = ['ThePirateBay', 'BitSearch', 'Torrents.csv', 'Nyaa'],
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

  const resultsNested = await Promise.all(tasks);
  const rawResults = resultsNested.flat();

  // Deduplicate across indexers using both infoHash and normalized title + size
  const seenByHash = new Map();
  const seenByTitle = new Map();
  const tokens = lowerQuery.split(/[^a-z0-9]+/).filter((t) => t.length >= 2);

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

  // Precompute scores once in O(N), then sort descending with seeds/peers tiebreakers
  const scored = deduped.map((item) => ({
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

  return '';
}
