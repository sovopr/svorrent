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
  const cardRegex = /<div[^>]*class="[^"]*torrent-result-card[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*torrent-result-card[^"]*"|$)/gi;
  const results = [];
  let m;

  while ((m = cardRegex.exec(html)) !== null) {
    const card = m[1];

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
    bitSearchPages = 3,
    signal,
  } = {}
) {
  if (!query || typeof query !== 'string' || !query.trim()) return [];

  const tasks = [];

  if (providers.includes('ThePirateBay')) {
    tasks.push(
      searchThePirateBay(query, { signal }).catch((err) => {
        console.warn('[search:ThePirateBay] Scraper error:', err.message);
        return [];
      })
    );
  }

  if (providers.includes('BitSearch')) {
    tasks.push(
      scrapeBitSearch(query, { maxPages: bitSearchPages, signal }).catch((err) => {
        console.warn('[search:BitSearch] Scraper error:', err.message);
        return [];
      })
    );
  }

  if (providers.includes('Torrents.csv')) {
    tasks.push(
      searchTorrentsCsv(query, { signal }).catch((err) => {
        console.warn('[search:Torrents.csv] Scraper error:', err.message);
        return [];
      })
    );
  }

  if (providers.includes('Nyaa')) {
    tasks.push(
      searchNyaa(query, { signal }).catch((err) => {
        console.warn('[search:Nyaa] Scraper error:', err.message);
        return [];
      })
    );
  }

  const resultsNested = await Promise.all(tasks);
  const rawResults = resultsNested.flat();

  // Deduplicate across indexers
  const seen = new Map();
  for (const item of rawResults) {
    if (!item || typeof item.title !== 'string') continue;
    const title = item.title.trim();
    const lowerTitle = title.toLowerCase();

    // Skip empty placeholder rows
    if (!title || lowerTitle === 'no results returned' || lowerTitle === 'no results found') continue;
    if (item.id === '0' && (item.size === '0 B' || !item.size)) continue;

    const infoHash = item.infoHash || extractInfoHash(item.magnet);
    const key = infoHash ? `hash:${infoHash}` : `title:${lowerTitle}|${(item.size || '').toLowerCase()}`;

    if (seen.has(key)) {
      const existing = seen.get(key);
      // Keep entry with higher seeds or richer magnet URI
      if ((item.seeds || 0) > (existing.seeds || 0)) {
        seen.set(key, item);
      } else if (!existing.magnet && item.magnet) {
        existing.magnet = item.magnet;
      }
      continue;
    }

    seen.set(key, item);
  }

  const deduped = Array.from(seen.values());

  // Sort globally by seeds descending, then peers descending
  deduped.sort((a, b) => {
    const sDiff = (b.seeds || 0) - (a.seeds || 0);
    if (sDiff !== 0) return sDiff;
    return (b.peers || 0) - (a.peers || 0);
  });

  if (limit && Number.isInteger(limit) && limit > 0) {
    return deduped.slice(0, limit);
  }

  return deduped;
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
