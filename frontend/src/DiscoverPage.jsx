import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import { TorrentTable } from './TorrentTable';
import { useTorrentRowActions } from './useTorrentRowActions';
import {
  SEARCH_QUALITY_FILTERS,
  cleanReleaseSearchQuery,
  filterSearchResults,
  getCachedDiscoverEntry,
  getCachedDiscoverSpotlight,
  getCompletedHashSet,
  getSearchFilterCounts,
  nextSortState,
  normalizeTorrentItems,
  prefetchDiscoverFeed,
  preloadDiscoverPosters,
  resolveDiscoverPosterUrl,
  sortTorrentRows,
} from './lib';

const CATEGORIES = [
  { id: 'movies', label: 'Movies' },
  { id: 'tv', label: 'TV' },
  { id: 'anime', label: 'Anime' },
];

const WINDOWS = [
  { id: '1D', label: 'Day' },
  { id: '7D', label: 'Week' },
  { id: '30D', label: 'Month' },
];

function SpotlightCard({ card, onSelect }) {
  const [imgFailed, setImgFailed] = useState(false);
  const posterUrl = resolveDiscoverPosterUrl(card.poster);
  const hasYearInTitle = card.year && card.title.includes(`(${card.year})`);
  const metaParts = [hasYearInTitle ? '' : card.year, card.genre].filter(Boolean);

  return (
    <button
      type="button"
      className="discover-card"
      onClick={() => onSelect(card.searchQuery || card.title)}
      title={`Search torrents for ${card.title}`}
    >
      <div className="discover-poster-wrap">
        {posterUrl && !imgFailed ? (
          <img
            src={posterUrl}
            alt={card.title}
            className="discover-poster"
            decoding="async"
            fetchPriority="high"
            referrerPolicy="no-referrer"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div className="discover-poster-fallback" aria-hidden="true">
            <span>{card.title}</span>
          </div>
        )}
        <span className="discover-card-cta">
          <Icon name="search" size={12} /> Find torrents
        </span>
      </div>
      <div className="discover-card-body">
        <div className="discover-card-title">{card.title}</div>
        {metaParts.length > 0 && <div className="discover-card-meta">{metaParts.join(' · ')}</div>}
      </div>
    </button>
  );
}

export function DiscoverPage({ notify, onDownloadAdded, onGoSearch, isActive = false, downloads = [] }) {
  const [category, setCategory] = useState('movies');
  const [win, setWin] = useState('7D');
  const [spotlight, setSpotlight] = useState([]);
  const [torrents, setTorrents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sort, setSort] = useState({ key: 'relevance', dir: 'desc' });
  const [source, setSource] = useState('all');
  const [qualityFilter, setQualityFilter] = useState('all');

  const generationRef = useRef(0);
  const controllerRef = useRef(null);
  const mountedRef = useRef(false);

  const activeCompletedHashes = useMemo(() => getCompletedHashSet(downloads), [downloads]);

  const { rowState, clearRowState, handleAction } = useTorrentRowActions({
    setItems: setTorrents,
    generationRef,
    isActive,
    notify,
    onDownloadAdded,
  });

  const loadDiscover = useCallback(async (cat, winValue, { forceRefresh = false } = {}) => {
    controllerRef.current?.abort();
    const id = ++generationRef.current;

    if (!forceRefresh) {
      const cached = getCachedDiscoverEntry(cat, winValue);
      if (cached) {
        preloadDiscoverPosters(cached.cards);
        setSpotlight(cached.cards);
        setTorrents(normalizeTorrentItems(cached.rawTorrents, id));
        clearRowState();
        setSource('all');
        setQualityFilter('all');
        setSort({ key: 'relevance', dir: 'desc' });
        setError('');
        setLoading(false);
        return;
      }

      const cachedSpotlight = getCachedDiscoverSpotlight(cat, winValue);
      if (cachedSpotlight) {
        setSpotlight(cachedSpotlight);
      }
    }

    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError('');

    try {
      const entry = await prefetchDiscoverFeed(cat, winValue, {
        forceRefresh,
        signal: controller.signal,
      });
      if (!mountedRef.current || generationRef.current !== id) return;
      const rows = normalizeTorrentItems(entry.rawTorrents, id);
      setSpotlight(entry.cards);
      setTorrents(rows);
      clearRowState();
      setSource('all');
      setQualityFilter('all');
      setSort({ key: 'relevance', dir: 'desc' });
    } catch (err) {
      if (mountedRef.current && generationRef.current === id && !controller.signal.aborted) {
        setError(err.message || 'Could not load trending torrents.');
      }
    } finally {
      if (mountedRef.current && generationRef.current === id) setLoading(false);
    }
  }, [clearRowState]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!isActive) return;
    loadDiscover(category, win);
  }, [isActive, category, win, loadDiscover]);

  const sources = useMemo(
    () => [...new Set(torrents.map((r) => r.provider).filter(Boolean))].sort(),
    [torrents],
  );

  const filterCounts = useMemo(
    () => getSearchFilterCounts(torrents, { source, quality: qualityFilter }),
    [torrents, source, qualityFilter],
  );

  const qualityPills = useMemo(() => {
    const specific = SEARCH_QUALITY_FILTERS.filter(
      (f) => f.id !== 'all' && (filterCounts.availableQualities[f.id] || qualityFilter === f.id),
    );
    return specific.length > 0 ? [SEARCH_QUALITY_FILTERS[0], ...specific] : [];
  }, [filterCounts, qualityFilter]);

  const rows = useMemo(() => {
    const filtered = filterSearchResults(torrents, { source, quality: qualityFilter });
    return sortTorrentRows(filtered, sort, 'relevance');
  }, [torrents, source, qualityFilter, sort]);

  const toggleSort = (key) => {
    setSort((prev) => nextSortState(prev, key, 'relevance'));
  };

  const categoryLabel = CATEGORIES.find((c) => c.id === category)?.label || 'Movies';
  const windowHeading = win === '1D' ? 'Today' : win === '30D' ? 'This Month' : 'This Week';
  const spotlightHeading =
    category === 'anime'
      ? `Trending Anime · ${windowHeading}`
      : category === 'tv'
      ? `Trending TV Shows · ${windowHeading}`
      : `Trending Movies · ${windowHeading}`;

  return (
    <section className="discover-page" aria-label="Discover trending torrents">
      <div className="discover-header">
        <div>
          <h1 className="page-title">Discover</h1>
          <p className="page-subtitle">Popular {categoryLabel.toLowerCase()} and trending releases {windowHeading.toLowerCase()}</p>
        </div>

        <div className="discover-header-controls">
          <div className="segmented" role="group" aria-label="Category filter">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`segment ${category === c.id ? 'is-active' : ''}`}
                aria-pressed={category === c.id}
                onClick={() => setCategory(c.id)}
              >
                {c.label}
              </button>
            ))}
          </div>

          <div className="segmented" role="group" aria-label="Time window">
            {WINDOWS.map((w) => (
              <button
                key={w.id}
                type="button"
                className={`segment ${win === w.id ? 'is-active' : ''}`}
                aria-pressed={win === w.id}
                onClick={() => setWin(w.id)}
              >
                {w.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            className="icon-btn"
            onClick={() => loadDiscover(category, win, { forceRefresh: true })}
            disabled={loading}
            title="Refresh trending feed"
            aria-label="Refresh trending feed"
          >
            <Icon name="refresh" size={14} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </div>

      {error && <div className="notice notice-error" role="alert">{error}</div>}

      {spotlight.length > 0 && (
        <div className="discover-section">
          <div className="discover-section-head">
            <h2 className="discover-section-title">{spotlightHeading}</h2>
            <span className="discover-section-hint">Click any title to search all indexers</span>
          </div>
          <div className={`discover-poster-grid ${loading ? 'is-stale' : ''}`}>
            {spotlight.map((card) => (
              <SpotlightCard
                key={`${category}-${win}-${card.id}`}
                card={card}
                onSelect={(term) => onGoSearch?.(term)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="discover-section">
        <div className="toolbar">
          <span className="toolbar-summary" role="status">
            {loading && torrents.length === 0
              ? `Loading trending ${categoryLabel.toLowerCase()}…`
              : `${rows.length} trending ${categoryLabel.toLowerCase()} release${rows.length === 1 ? '' : 's'}`}
          </span>

          <div className="toolbar-actions">
            {(source !== 'all' || qualityFilter !== 'all') && (
              <button
                type="button"
                className="btn btn-outline btn-sm search-filter-reset"
                onClick={() => {
                  setSource('all');
                  setQualityFilter('all');
                }}
              >
                Reset filters
              </button>
            )}
            {sources.length > 1 && (
              <label className="select-wrap">
                <span className="sr-only">Filter by source</span>
                <select
                  id="discover-source-filter"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                >
                  <option value="all">All sources ({sources.length})</option>
                  {sources.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </div>

        {qualityPills.length > 0 && (
          <div className="search-filters">
            <div className="search-filter-row">
              <div className="segmented quality-segmented" role="group" aria-label="Quality filter">
                {qualityPills.map((f) => {
                  const active = qualityFilter === f.id;
                  return (
                    <button
                      key={f.id}
                      type="button"
                      className={`segment quality-segment ${active ? 'is-active' : ''}`}
                      aria-pressed={active}
                      onClick={() => setQualityFilter(active && f.id !== 'all' ? 'all' : f.id)}
                    >
                      <span>{f.label}</span>
                      <span className="segment-count">{filterCounts.qualityCounts[f.id]}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {torrents.length > 0 ? (
          <TorrentTable
            rows={rows}
            sort={sort}
            onToggleSort={toggleSort}
            rowState={rowState}
            onAction={handleAction}
            activeCompletedHashes={activeCompletedHashes}
            loading={loading}
            onFindSimilar={(item) => onGoSearch?.(cleanReleaseSearchQuery(item.title))}
            emptyView={
              <div className="empty empty-filtered">
                <p>No trending releases match the selected filters.</p>
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  onClick={() => {
                    setSource('all');
                    setQualityFilter('all');
                  }}
                >
                  Reset filters
                </button>
              </div>
            }
          />
        ) : loading ? (
          <p className="empty" role="status">Loading trending torrents…</p>
        ) : !error ? (
          <p className="empty">No trending releases found for this category right now.</p>
        ) : null}
      </div>
    </section>
  );
}
