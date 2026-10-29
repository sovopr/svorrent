// Svorrent Search Query Expansion & Result Normalization
// Automatically adds wildcard prefix search variants (e.g. "inters" -> "inters*")
// to support partial-word matching on indexers like ThePirateBay, and filters
// out scraper empty-result placeholder rows.

export function buildSearchQueries(rawQuery) {
  if (typeof rawQuery !== 'string') return [];
  const clean = rawQuery.trim();
  if (!clean) return [];

  const variants = new Set([clean]);
  const words = clean.split(/\s+/).filter(Boolean);

  if (words.length > 0) {
    const wildcardWords = words.map((w) => {
      if (w.length >= 3 && !w.endsWith('*') && /^[a-zA-Z0-9_-]+$/.test(w)) {
        return `${w}*`;
      }
      return w;
    });
    const wildcardQuery = wildcardWords.join(' ');
    if (wildcardQuery !== clean) {
      variants.add(wildcardQuery);
    }
  }

  return Array.from(variants);
}

export function filterAndDeduplicateResults(results) {
  if (!Array.isArray(results)) return [];
  const seen = new Set();
  const valid = [];

  for (const item of results) {
    if (!item || typeof item.title !== 'string') continue;
    const title = item.title.trim();
    const lower = title.toLowerCase();

    // Filter out scraper placeholder rows when 0 torrents match
    if (!title || lower === 'no results returned' || lower === 'no results found') continue;
    if (item.id === '0' && (item.size === '0 B' || !item.size)) continue;

    const key = `${lower}|${String(item.size || '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push(item);
  }

  return valid.sort((a, b) => (parseInt(b.seeds, 10) || 0) - (parseInt(a.seeds, 10) || 0));
}
