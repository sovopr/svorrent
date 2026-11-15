import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractInfoHash,
  formatMagnetUri,
  formatBytes,
  resolveMagnet,
  searchFederated,
  sanitizeSwarmCount,
  decodeHtmlEntities,
  parseSizeToBytes,
  normalizeTitleForDedup,
  scoreSearchResult,
  parseKnabenHits,
  parseTheRarbgJson,
  parseTheRarbgBrowseHtml,
  parseExttoTrendingHtml,
  parseAppleSpotlightFeed,
  parseAniListSpotlight,
  isAllowedPosterUrl,
  registerDiscoverPoster,
  fetchRegisteredPoster,
  parseRelativeAgeHours,
  orderTrendingByWindow,
  extractSpotlightCandidates,
  formatRelativeAgeFromMs,
  parseNyaaRssXml,
  scoreTrendingRelease,
  rankMultiSourceTrending,
} from '../lib/indexer.js';

test('extractInfoHash extracts 40-char hex hash from magnet URI or raw string', () => {
  const hash = 'cfdd00ae7bb73ddbaa0531c5b14087324295e701';
  assert.equal(extractInfoHash(hash), hash);
  assert.equal(extractInfoHash(hash.toUpperCase()), hash);
  assert.equal(extractInfoHash(`magnet:?xt=urn:btih:${hash}&dn=Ubuntu`), hash);
  assert.equal(extractInfoHash('magnet:?xt=urn:btih:4D4ED4C0F0C04718849DA90FE1DF9F5BAF184A0E&dn=Test'), '4d4ed4c0f0c04718849da90fe1df9f5baf184a0e');
  assert.equal(extractInfoHash('not a magnet'), '');
  assert.equal(extractInfoHash(''), '');
  assert.equal(extractInfoHash(null), '');
});

test('sanitizeSwarmCount masks 64-bit flag overflow and negative underflows', () => {
  // 4294967301 is 2^32 + 5 (BitSearch packed internal 64-bit flag bit 32)
  assert.equal(sanitizeSwarmCount('4294967301'), 5);
  // 4294967614 is 2^32 + 318
  assert.equal(sanitizeSwarmCount('4294967614'), 318);
  // Standard swarm numbers
  assert.equal(sanitizeSwarmCount(586), 586);
  assert.equal(sanitizeSwarmCount('12'), 12);
  // Negative and zeroes
  assert.equal(sanitizeSwarmCount(0), 0);
  assert.equal(sanitizeSwarmCount('-10'), 0);
  assert.equal(sanitizeSwarmCount(null), 0);
  // Absurd counts beyond reasonable swarm ceiling
  assert.equal(sanitizeSwarmCount(1000000), 0);
});

test('decodeHtmlEntities decodes XML/HTML entity escaped characters', () => {
  assert.equal(decodeHtmlEntities('Dune &amp; Part Two'), 'Dune & Part Two');
  assert.equal(decodeHtmlEntities('It&#039;s a Wonderful Life'), "It's a Wonderful Life");
  assert.equal(decodeHtmlEntities('&quot;Inception&quot;'), '"Inception"');
  assert.equal(decodeHtmlEntities(''), '');
});

test('formatMagnetUri generates valid magnet link with trackers', () => {
  const hash = 'cfdd00ae7bb73ddbaa0531c5b14087324295e701';
  const name = 'Ubuntu 24.04 Desktop';
  const uri = formatMagnetUri(hash, name);

  assert.ok(uri.startsWith('magnet:?xt=urn:btih:cfdd00ae7bb73ddbaa0531c5b14087324295e701'));
  assert.ok(uri.includes('&dn=Ubuntu%2024.04%20Desktop'));
  assert.ok(uri.includes('&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce'));
});

test('formatMagnetUri handles missing or empty input safely', () => {
  assert.equal(formatMagnetUri(''), '');
  assert.equal(formatMagnetUri(null), '');
  assert.equal(formatMagnetUri(undefined), '');
});

test('formatBytes formats binary byte sizes accurately', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(-100), '0 B');
  assert.equal(formatBytes(500), '500 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1572864), '1.5 MB');
  assert.equal(formatBytes(1073741824), '1.0 GB');
  assert.equal(formatBytes(13207024435), '12.3 GB');
});

test('resolveMagnet returns valid magnet without extra network calls when already present', async () => {
  const existing = 'magnet:?xt=urn:btih:1234567890abcdef1234567890abcdef12345678&dn=Test';
  const resolved = await resolveMagnet({ magnet: existing });
  assert.equal(resolved, existing);
});

test('resolveMagnet constructs magnet from infoHash and title', async () => {
  const hash = '1234567890abcdef1234567890abcdef12345678';
  const resolved = await resolveMagnet({ infoHash: hash, title: 'Test Download' });
  assert.ok(resolved.startsWith(`magnet:?xt=urn:btih:${hash}`));
  assert.ok(resolved.includes('&dn=Test%20Download'));
});

test('searchFederated returns empty array when query is empty or whitespace', async () => {
  assert.deepEqual(await searchFederated(''), []);
  assert.deepEqual(await searchFederated('   '), []);
  assert.deepEqual(await searchFederated(null), []);
});

test('scoreSearchResult prioritizes movies and video releases over game repacks and small files', () => {
  const query = 'the batman';
  const movie = {
    title: 'The Batman (2022) [1080p] [WEBRip] [5.1] [YTS.LT]',
    size: '2.1 GB',
    seeds: 1400,
  };
  const game = {
    title: 'Batman: The Enemy Within -The Telltale Series (Episode 1-3)',
    size: '7.93 MB',
    seeds: 5000,
  };

  const movieScore = scoreSearchResult(movie, query);
  const gameScore = scoreSearchResult(game, query);

  assert.ok(movieScore > gameScore, `Movie score (${movieScore}) should exceed game score (${gameScore})`);
});

test('normalizeTitleForDedup removes brackets and punctuation for deduplication', () => {
  assert.equal(
    normalizeTitleForDedup('Batman: The Enemy Within -The Telltale Series (Episode 1-3)'),
    'batman the enemy within the telltale series'
  );
  assert.equal(
    normalizeTitleForDedup('The.Batman.2022.1080p.BluRay.x264-[YTS]'),
    'the batman 2022 1080p bluray x264'
  );
});

test('parseSizeToBytes correctly calculates byte values', () => {
  assert.equal(parseSizeToBytes('7.93 MB'), 8315208);
  assert.equal(parseSizeToBytes('2.1 GB'), 2254857830);
  assert.equal(parseSizeToBytes('400 KB'), 409600);
  assert.equal(parseSizeToBytes(''), 0);
});

test('scoreSearchResult severely penalizes fragmented titles and non-matching scraps', () => {
  const query = 'the batman';
  const fragment = {
    title: '(Episode 1-3)',
    size: '7.93 MB',
    seeds: 5000,
  };
  const score = scoreSearchResult(fragment, query);
  assert.ok(score < 0, `Scraper fragment score (${score}) should be negative`);
});

test('scoreSearchResult ranks 1080p above 720p and preserves scene REPACK movies', () => {
  const query = 'the batman';
  const movie1080p = {
    title: 'The Batman (2022) 1080p WEBRip x264',
    size: '2.1 GB',
    seeds: 900,
  };
  const movie720p = {
    title: 'The Batman (2022) 720p WEBRip x264',
    size: '1.3 GB',
    seeds: 900,
  };
  const sceneRepack = {
    title: 'The Batman (2022) REPACK 1080p BluRay x265',
    size: '2.4 GB',
    seeds: 850,
  };
  const gameRepack = {
    title: 'Batman Arkham Knight FitGirl Repack',
    size: '28.5 GB',
    seeds: 1200,
  };

  assert.ok(scoreSearchResult(movie1080p, query) > scoreSearchResult(movie720p, query));
  assert.ok(scoreSearchResult(sceneRepack, query) > scoreSearchResult(gameRepack, query) + 7000);
});

test('scoreSearchResult penalizes dead 0-seeder releases and scores dot-separated scene names fairly', () => {
  const query = 'ubuntu';
  const liveIso = {
    title: 'ubuntu-24.04.1-desktop-amd64.iso',
    size: '5.8 GB',
    seeds: 53,
    peers: 15,
  };
  const deadEpisode = {
    title: 'Celtics.City.S01E08.Chapter.VIII.Ubuntu.2160p.WEB-DL.H265',
    size: '8.0 GB',
    seeds: 0,
    peers: 0,
  };
  assert.ok(scoreSearchResult(liveIso, query) > scoreSearchResult(deadEpisode, query));

  const dotted = { title: 'The.Odyssey.2026.1080p.BluRay.x264', size: '2.5 GB', seeds: 100 };
  const spaced = { title: 'The Odyssey 2026 1080p BluRay x264', size: '2.5 GB', seeds: 100 };
  assert.equal(scoreSearchResult(dotted, 'odyssey 2026'), scoreSearchResult(spaced, 'odyssey 2026'));
});

test('parseKnabenHits normalizes tracker names, hashes, and live swarm counts', () => {
  const hash1 = '2849211F150E966EF7924F43AEC22727A644E10D';
  const hash2 = 'DAFC8C076CA2F3ED376EEAE7C76A0D6BE2415C45';
  const items = parseKnabenHits({
    hits: [
      {
        id: 'abc1',
        title: 'Inception 2010 2160p BluRay',
        bytes: 9556302233,
        hash: hash1,
        magnetUrl: `magnet:?xt=urn:btih:${hash1}&dn=Inception`,
        seeders: 40,
        liveSeeders: 85,
        peers: 12,
        livePeers: 19,
        tracker: '1337x',
        trackerId: '1337x',
      },
      {
        id: 'abc2',
        title: 'Game Pack 2026',
        bytes: 1073741824,
        hash: hash2,
        magnetUrl: null,
        seeders: 15,
        peers: 4,
        tracker: 'RuTracker.org',
        trackerId: 'rutracker',
      },
      { id: 'bad', title: 'No Hash Hit', bytes: 1024, hash: '' },
    ],
  });

  assert.equal(items.length, 2);
  assert.equal(items[0].provider, '1337x');
  assert.equal(items[0].seeds, 85);
  assert.equal(items[0].peers, 19);
  assert.equal(items[0].infoHash, hash1.toLowerCase());
  assert.equal(items[1].provider, 'RuTracker');
  assert.ok(items[1].magnet.startsWith(`magnet:?xt=urn:btih:${hash2.toLowerCase()}`));
});

test('parseTheRarbgJson and parseTheRarbgBrowseHtml extract clean TheRARBG results', () => {
  const hash = '4A3F5E08BCEF825718EDA30637230585E3330599';
  const jsonItems = parseTheRarbgJson({
    results: [
      {
        pk: '8a6ee9',
        n: 'ubuntu-24.04.1-desktop-amd64.iso',
        s: 6203355136,
        se: 53,
        le: 15,
        h: hash,
      },
      { pk: 'bad', n: 'Missing Hash', s: 100, se: 1, le: 0, h: '' },
    ],
  });

  assert.equal(jsonItems.length, 1);
  assert.equal(jsonItems[0].provider, 'extto.org');
  assert.equal(jsonItems[0].size, '5.8 GB');
  assert.equal(jsonItems[0].seeds, 53);

  const fallbackItems = parseTheRarbgJson(
    { results: [{ pk: '8a6ee9', n: 'ubuntu-24.04.1-desktop-amd64.iso', s: 6203355136, se: 53, le: 15, h: hash }] },
    'https://therarbg.to',
  );
  assert.equal(fallbackItems[0].provider, 'TheRARBG');

  const html = `
    <table><tbody>
      <tr>
        <td>
          <a href="/post-detail/8a715c/ubuntu-iso/" class="torrent-title-link"><b>Ubuntu &amp; Linux</b></a>
          <a href="magnet:?xt=urn:btih:${hash}&amp;dn=Ubuntu">magnet</a>
        </td>
        <td><span class="add-block">Size</span><span>5.8\u00a0GB</span></td>
        <td><span class="add-block">Seeds</span><span>1,234</span></td>
        <td><span class="add-block">Leechs</span><span>56</span></td>
      </tr>
    </tbody></table>
  `;
  const htmlItems = parseTheRarbgBrowseHtml(html);
  assert.equal(htmlItems.length, 1);
  assert.equal(htmlItems[0].provider, 'extto.org');
  assert.equal(htmlItems[0].title, 'Ubuntu & Linux');
  assert.equal(htmlItems[0].size, '5.8 GB');
  assert.equal(htmlItems[0].seeds, 1234);
  assert.equal(htmlItems[0].peers, 56);
});

test('parseExttoTrendingHtml extracts trending release metadata and deferred magnet link', async () => {
  const html = `
    <table><tbody>
      <tr>
        <td class="text-left">
          <div class="float-left">
            <a href="/post-detail/943791/the-odyssey-2026-1080p/"><b>The Odyssey 2026 &amp; More</b></a>
          </div>
          <a class="vide-watch-btn" href="/imdb-detail/tt33764258/"></a>
        </td>
        <td class="nowrap-td hide-on-mob"><div class="add-block-wrapper"><span class="add-block">Size</span><span>4.2\u00a0GB</span></div></td>
        <td class="hide-on-mob"><div class="add-block-wrapper"><span class="add-block">Files</span><span>1</span></div></td>
        <td class="nowrap-td hide-on-mob"><div class="add-block-wrapper"><span>8 days ago</span></div></td>
        <td class="hide-on-mob"><div class="add-block-wrapper"><span class="text-success">17,993</span></div></td>
        <td class="hide-on-mob"><div class="add-block-wrapper"><span class="text-danger">1,200</span></div></td>
      </tr>
    </tbody></table>
  `;

  const items = parseExttoTrendingHtml(html);
  assert.equal(items.length, 1);
  assert.equal(items[0].provider, 'extto.org');
  assert.equal(items[0].id, '943791');
  assert.equal(items[0].title, 'The Odyssey 2026 & More');
  assert.equal(items[0].size, '4.2 GB');
  assert.equal(items[0].age, '8 days ago');
  assert.equal(items[0].seeds, 17993);
  assert.equal(items[0].peers, 1200);
  assert.equal(items[0].imdbId, 'tt33764258');
  assert.equal(items[0].link, 'https://extto.org/post-detail/943791/the-odyssey-2026-1080p/');

  // Arbitrary external links outside extto.org/apibay must not resolve
  assert.equal(await resolveMagnet({ link: 'https://evil.example.com/post-detail/123/' }), '');
});

test('parseAppleSpotlightFeed normalizes posters, years, and search queries', () => {
  const cards = parseAppleSpotlightFeed({
    feed: {
      entry: [
        {
          id: { attributes: { 'im:id': '101' } },
          'im:name': { label: 'Resident Evil (2026)' },
          'im:releaseDate': { label: '2026-09-18T00:00:00-07:00' },
          category: { attributes: { label: 'Horror' } },
          summary: { label: 'Survival horror.' },
          'im:image': [
            { label: 'https://is1-ssl.mzstatic.com/image/thumb/x/60x60bb.png' },
            { label: 'https://is1-ssl.mzstatic.com/image/thumb/x/115x170bb.png' },
          ],
        },
      ],
    },
  });

  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, '101');
  assert.equal(cards[0].title, 'Resident Evil (2026)');
  assert.equal(cards[0].year, '2026');
  assert.equal(cards[0].genre, 'Horror');
  assert.equal(cards[0].poster, 'https://is1-ssl.mzstatic.com/image/thumb/x/240x360bb.webp');
  assert.equal(cards[0].searchQuery, 'Resident Evil 2026');
});

test('parseAniListSpotlight parses SFW trending anime cards and skips adult items', () => {
  const cards = parseAniListSpotlight({
    data: {
      Page: {
        media: [
          {
            id: 21,
            isAdult: false,
            title: { english: 'ONE PIECE', romaji: 'ONE PIECE' },
            seasonYear: 1999,
            genres: ['Action', 'Adventure', 'Fantasy'],
            coverImage: { large: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx21.jpg' },
          },
          {
            id: 99,
            isAdult: true,
            title: { english: 'Adult Entry', romaji: 'Adult Entry' },
            seasonYear: 2026,
            genres: ['Hentai'],
            coverImage: { large: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx99.jpg' },
          },
        ],
      },
    },
  });

  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, 'anilist-21');
  assert.equal(cards[0].title, 'ONE PIECE');
  assert.equal(cards[0].year, '1999');
  assert.equal(cards[0].genre, 'Action');
  assert.equal(cards[0].poster, 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx21.jpg');
  assert.equal(cards[0].searchQuery, 'ONE PIECE');
});

test('isAllowedPosterUrl permits HTTPS allowlisted CDNs and blocks arbitrary URLs', async () => {
  assert.equal(isAllowedPosterUrl('https://is1-ssl.mzstatic.com/image/thumb/x/240x360bb.webp'), true);
  assert.equal(isAllowedPosterUrl('https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx21.jpg'), true);
  assert.equal(isAllowedPosterUrl('https://i.rar.pics/poster.jpg'), true);
  assert.equal(isAllowedPosterUrl('https://m.media-amazon.com/images/M/test._V1_UX240_.jpg'), true);
  assert.equal(isAllowedPosterUrl('http://is1-ssl.mzstatic.com/image/thumb/x/240x360bb.webp'), false);
  assert.equal(isAllowedPosterUrl('https://notmzstatic.com/foo.webp'), false);
  assert.equal(isAllowedPosterUrl('https://m.media-amazon.com:8443/images/M/test.jpg'), false);
  assert.equal(isAllowedPosterUrl('https://user:pass@m.media-amazon.com/images/M/test.jpg'), false);
  assert.equal(isAllowedPosterUrl('http://127.0.0.1:3001/secret'), false);
  assert.equal(isAllowedPosterUrl('javascript:alert(1)'), false);

  const token = registerDiscoverPoster('https://is1-ssl.mzstatic.com/image/thumb/x/240x360bb.webp');
  assert.match(token, /^[a-f0-9]{24}$/);
  assert.equal(registerDiscoverPoster('https://evil.example/poster.jpg'), '');
  assert.equal(await fetchRegisteredPoster('not-a-token'), null);
  assert.equal(await fetchRegisteredPoster('ffffffffffffffffffffffff'), null);
});

test('orderTrendingByWindow separates Day, Week, and Month freshness tiers cleanly', () => {
  const sample = [
    { title: 'Old Month Hit 2026', age: '26 days ago', imdbId: 'tt111' },
    { title: 'Today Movie 2026 1080p WEB-DL', age: '12 hours ago', imdbId: 'tt222' },
    { title: 'Today Movie (2026) 2160p HDR', age: '1 day ago', imdbId: '' },
    { title: 'Weekly Show S02E03 1080p', age: '6 days ago', imdbId: 'tt333' },
  ];

  assert.equal(parseRelativeAgeHours('12 hours ago'), 12);
  assert.equal(parseRelativeAgeHours('6 days ago'), 144);
  assert.equal(parseRelativeAgeHours('1 month ago'), 720);

  const dayOrdered = orderTrendingByWindow(sample, '1D');
  assert.equal(dayOrdered[0].title, 'Today Movie 2026 1080p WEB-DL');

  const monthOrdered = orderTrendingByWindow(sample, '30D');
  assert.equal(monthOrdered[0].title, 'Old Month Hit 2026');

  const movieCandidates = extractSpotlightCandidates(sample, 'movies', 10);
  assert.deepEqual(movieCandidates.map((c) => c.title), ['Old Month Hit', 'Today Movie', 'Weekly Show S02E03']);

  const tvCandidates = extractSpotlightCandidates(sample, 'tv', 10);
  assert.equal(tvCandidates[2].title, 'Weekly Show');
});

test('formatRelativeAgeFromMs and parseNyaaRssXml extract clean relative timestamps', () => {
  const now = 1_794_760_000_000;
  assert.equal(formatRelativeAgeFromMs(now - 3 * 3600 * 1000, now), '3 hours ago');
  assert.equal(formatRelativeAgeFromMs(now - 5 * 86400 * 1000, now), '5 days ago');

  const xml = `<rss><channel><item>
    <title>[SubsPlease] Sample Anime - 05 (1080p) [ABCDEF01].mkv</title>
    <pubDate>${new Date(Date.now() - 2 * 3600 * 1000).toUTCString()}</pubDate>
    <nyaa:seeders>320</nyaa:seeders>
    <nyaa:leechers>45</nyaa:leechers>
    <nyaa:infoHash>a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2</nyaa:infoHash>
    <nyaa:size>1.4 GiB</nyaa:size>
  </item></channel></rss>`;
  const items = parseNyaaRssXml(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].provider, 'Nyaa');
  assert.match(items[0].age, /hour/i);
  assert.equal(items[0].seeds, 320);
});

test('rankMultiSourceTrending rewards multi-source consensus, freshness, HD quality, and diversity', () => {
  const batches = [
    {
      source: 'extto',
      items: [
        { provider: 'extto.org', title: 'Old Hit 2026 1080p BluRay x265', size: '4.0 GB', age: '26 days ago', seeds: 1500, peers: 100 },
        { provider: 'extto.org', title: 'Fresh Hit 2026 1080p WEB-DL x265', size: '3.2 GB', age: '1 day ago', seeds: 1200, peers: 400, imdbId: 'tt1234567' },
      ],
    },
    {
      source: 'knaben',
      items: [
        { provider: 'YTS', title: 'Fresh Hit (2026) [1080p] [WEBRip]', size: '2.1 GB', age: '1 day ago', seeds: 900, peers: 220, infoHash: '1111111111111111111111111111111111111111', magnet: 'magnet:?xt=urn:btih:1111111111111111111111111111111111111111' },
      ],
    },
    {
      source: 'apibay',
      items: [
        { provider: 'ThePirateBay', title: 'Flood Movie (2026) HDCAM 720p v1', size: '1.1 GB', age: '1 day ago', seeds: 5000, peers: 50, infoHash: '2222222222222222222222222222222222222222', magnet: 'magnet:?xt=urn:btih:2222222222222222222222222222222222222222' },
        { provider: 'ThePirateBay', title: 'Flood Movie (2026) HDCAM 720p v2', size: '1.2 GB', age: '1 day ago', seeds: 4900, peers: 40, infoHash: '3333333333333333333333333333333333333333', magnet: 'magnet:?xt=urn:btih:3333333333333333333333333333333333333333' },
        { provider: 'ThePirateBay', title: 'Flood Movie (2026) HDCAM 1080p v3', size: '1.8 GB', age: '1 day ago', seeds: 4800, peers: 30, infoHash: '4444444444444444444444444444444444444444', magnet: 'magnet:?xt=urn:btih:4444444444444444444444444444444444444444' },
      ],
    },
  ];

  const rankedDay = rankMultiSourceTrending(batches, { catKey: 'movies', winKey: '1D', maxPerWork: 2 });
  assert.ok(rankedDay[0].title.includes('Fresh Hit'));
  // 3rd variant of Flood Movie must be deferred behind non-duplicate entries
  const firstFour = rankedDay.slice(0, 4).map((r) => r.title);
  assert.equal(firstFour.filter((t) => t.includes('Flood Movie')).length, 2);

  // scoreTrendingRelease should penalize CAM relative to HD digital of same swarm/age
  const hdScore = scoreTrendingRelease({ title: 'Movie 2026 1080p WEB-DL', age: '1 day ago', seeds: 500, peers: 50, magnet: 'magnet:?xt=urn:btih:a' }, { winKey: '1D' });
  const camScore = scoreTrendingRelease({ title: 'Movie 2026 HDCAM', age: '1 day ago', seeds: 500, peers: 50, magnet: 'magnet:?xt=urn:btih:b' }, { winKey: '1D' });
  assert.ok(hdScore > camScore + 40);
});
