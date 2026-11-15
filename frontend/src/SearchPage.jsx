import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import { TorrentTable } from './TorrentTable';
import { useTorrentRowActions } from './useTorrentRowActions';
import {
  SEARCH_QUALITY_FILTERS,
  SEARCH_TAG_FILTERS,
  apiGet,
  filterSearchResults,
  getCompletedHashSet,
  getPageNumbers,
  getSearchFilterCounts,
  nextSortState,
  normalizeTorrentItems,
  sortTorrentRows,
} from './lib';

export function SearchPage({
  notify,
  onDownloadAdded,
  initialQuery,
  initialQuerySeq = 0,
  isActive = true,
  downloads = [],
}) {
  const [query, setQuery] = useState(initialQuery || '');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchedTerm, setSearchedTerm] = useState('');
  const [error, setError] = useState('');
  const [sort, setSort] = useState({ key: 'relevance', dir: 'desc' });
  const [source, setSource] = useState('all');
  const [qualityFilter, setQualityFilter] = useState('all');
  const [selectedTags, setSelectedTags] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const activeCompletedHashes = useMemo(() => getCompletedHashSet(downloads), [downloads]);

  const inputRef = useRef(null);
  const tableRef = useRef(null);
  const searchId = useRef(0);
  const searchController = useRef(null);
  const resultId = useRef(0);
  const debounce = useRef(null);

  const { rowState, clearRowState, handleAction } = useTorrentRowActions({
    setItems: setResults,
    generationRef: resultId,
    isActive,
    notify,
    onDownloadAdded,
  });

  const mounted = useRef(false);

  const cancelSearch = useCallback(() => {
    clearTimeout(debounce.current);
    searchController.current?.abort();
    searchId.current += 1;
  }, []);

  const runSearch = useCallback(async (raw) => {
    const term = raw.trim();
    cancelSearch();
    if (!term) return;

    const id = searchId.current;
    const controller = new AbortController();
    searchController.current = controller;
    setLoading(true);
    setError('');

    try {
      const data = await apiGet(`/search?q=${encodeURIComponent(term)}`, { signal: controller.signal, timeoutMs: 15000 });
      if (!mounted.current || searchId.current !== id) return;
      if (!Array.isArray(data) || data.some((r) => !r || typeof r.title !== 'string' || typeof r.provider !== 'string')) {
        throw new Error('The server returned invalid search results. Please try again.');
      }
      resultId.current = id;
      setResults(normalizeTorrentItems(data, id));
      clearRowState();
      setSource('all');
      setQualityFilter('all');
      setSelectedTags([]);
      setPage(1);
      setSearchedTerm(term);
    } catch (err) {
      if (mounted.current && searchId.current === id && !controller.signal.aborted) {
        setError(err.message || 'Could not search. Please try again.');
      }
    } finally {
      if (mounted.current && searchId.current === id) setLoading(false);
    }
  }, [cancelSearch, clearRowState]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelSearch();
    };
  }, [cancelSearch]);

  useEffect(() => {
    if (typeof initialQuery !== 'string') return;
    const trimmed = initialQuery.trim();
    cancelSearch();
    setLoading(false);
    setQuery(trimmed);
    if (!trimmed) {
      resultId.current = searchId.current;
      setResults([]);
      setSearchedTerm('');
      setError('');
      clearRowState();
      setSource('all');
      setQualityFilter('all');
      setSelectedTags([]);
      setPage(1);
    } else if (initialQuerySeq > 0) {
      runSearch(trimmed);
    }
  }, [initialQuery, initialQuerySeq, cancelSearch, clearRowState, runSearch]);

  // Search after user stops typing
  useEffect(() => {
    const term = query.trim();
    cancelSearch();
    setLoading(false);
    if (term.length < 2) return;
    debounce.current = setTimeout(() => runSearch(term), 280);
    return cancelSearch;
  }, [query, runSearch, cancelSearch]);

  // "/" focuses search field from anywhere on the page
  useEffect(() => {
    const onKey = (e) => {
      const target = e.target;
      const editing = target instanceof Element && (target.closest('input, textarea, select, [role="textbox"], [role="dialog"], dialog') || target.isContentEditable);
      if (isActive && e.key === '/' && !e.defaultPrevented && !e.isComposing &&
        !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !editing && inputRef.current?.offsetParent) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isActive]);

  const sources = useMemo(() => [...new Set(results.map((r) => r.provider).filter(Boolean))].sort(), [results]);

  const filterCounts = useMemo(
    () => getSearchFilterCounts(results, { source, quality: qualityFilter, tags: selectedTags }),
    [results, source, qualityFilter, selectedTags],
  );

  const qualityPills = useMemo(() => {
    const specific = SEARCH_QUALITY_FILTERS.filter(
      (f) => f.id !== 'all' && (filterCounts.availableQualities[f.id] || qualityFilter === f.id),
    );
    return specific.length > 0 ? [SEARCH_QUALITY_FILTERS[0], ...specific] : [];
  }, [filterCounts, qualityFilter]);

  const tagPills = useMemo(
    () => SEARCH_TAG_FILTERS.filter((f) => filterCounts.tagCounts[f.id] > 0 || selectedTags.includes(f.id)),
    [filterCounts, selectedTags],
  );

  const hasActiveFilters = source !== 'all' || qualityFilter !== 'all' || selectedTags.length > 0;

  const resetFilters = () => {
    setSource('all');
    setQualityFilter('all');
    setSelectedTags([]);
    setPage(1);
  };

  const toggleTag = (tagId) => {
    setSelectedTags((prev) => (prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId]));
    setPage(1);
  };

  const rows = useMemo(() => {
    const filtered = filterSearchResults(results, {
      source,
      quality: qualityFilter,
      tags: selectedTags,
    });
    return sortTorrentRows(filtered, sort, 'relevance');
  }, [results, sort, source, qualityFilter, selectedTags]);

  const totalResults = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalResults / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalResults);
  const paginatedRows = useMemo(() => rows.slice(startIndex, endIndex), [rows, startIndex, endIndex]);

  const goToPage = (newPage) => {
    const target = Math.min(Math.max(1, newPage), totalPages);
    setPage(target);
    const prefersReducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    const behavior = prefersReducedMotion ? 'auto' : 'smooth';
    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, left: 0, behavior });
      document.documentElement?.scrollTo({ top: 0, left: 0, behavior });
      document.body?.scrollTo({ top: 0, left: 0, behavior });
    });
  };

  const toggleSort = (key) => {
    setPage(1);
    setSort((prev) => nextSortState(prev, key, 'relevance'));
  };

  const clear = () => {
    cancelSearch();
    resultId.current = searchId.current;
    setQuery('');
    setResults([]);
    setSearchedTerm('');
    setError('');
    clearRowState();
    setSort({ key: 'relevance', dir: 'desc' });
    setSource('all');
    setQualityFilter('all');
    setSelectedTags([]);
    setPage(1);
    setLoading(false);
    inputRef.current?.focus();
  };

  const hasResults = results.length > 0;

  return (
    <section className="search-page" aria-label="Torrent search">
      <form
        className="searchbar"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          runSearch(query);
        }}
      >
        <div className="searchbar-field">
          <Icon name="search" className="searchbar-icon" />
          <input
            id="search-input"
            ref={inputRef}
            type="search"
            aria-label="Search torrents"
            placeholder="Search torrents by name…"
            value={query}
            onChange={(e) => {
              if (!e.target.value) return clear();
              cancelSearch();
              setLoading(false);
              setError('');
              setQuery(e.target.value);
            }}
            autoFocus={isActive}
            autoComplete="off"
            spellCheck="false"
          />
          {query ? (
            <button type="button" className="icon-btn" onClick={clear} aria-label="Clear search">
              <Icon name="x" size={14} />
            </button>
          ) : (
            <kbd className="kbd">/</kbd>
          )}
        </div>

        <button id="search-submit" type="submit" className="btn btn-primary" disabled={!query.trim() || loading}>
          Search
        </button>
      </form>

      {error && <div className="notice notice-error" role="alert">{error}</div>}

      {hasResults && (
        <>
          <div className="toolbar">
            <span className="toolbar-summary" role="status">
              {loading
                ? 'Searching…'
                : totalResults > pageSize
                ? `Showing ${startIndex + 1}–${endIndex} of ${totalResults} results for “${searchedTerm}”`
                : `${totalResults} result${totalResults === 1 ? '' : 's'} for “${searchedTerm}”`}
            </span>
            <div className="toolbar-actions">
              {hasActiveFilters && (
                <button type="button" className="btn btn-outline btn-sm search-filter-reset" onClick={resetFilters}>
                  Reset filters
                </button>
              )}
              {sources.length > 1 && (
                <label className="select-wrap">
                  <span className="sr-only">Filter by source</span>
                  <select
                    id="source-filter"
                    value={source}
                    onChange={(e) => {
                      setSource(e.target.value);
                      setPage(1);
                    }}
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
              {(results.length > 20 || totalResults > 20) && (
                <label className="select-wrap">
                  <span className="sr-only">Results per page</span>
                  <select
                    id="page-size-select"
                    value={pageSize}
                    onChange={(e) => {
                      setPageSize(Number(e.target.value));
                      setPage(1);
                    }}
                  >
                    <option value={20}>20 / page</option>
                    <option value={25}>25 / page</option>
                    <option value={50}>50 / page</option>
                    <option value={100}>100 / page</option>
                  </select>
                </label>
              )}
            </div>
          </div>

          {(qualityPills.length > 0 || tagPills.length > 0) && (
            <div className="search-filters" role="region" aria-label="Filter search results">
              {qualityPills.length > 0 && (
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
                          onClick={() => {
                            setQualityFilter(active && f.id !== 'all' ? 'all' : f.id);
                            setPage(1);
                          }}
                        >
                          <span>{f.label}</span>
                          <span className="segment-count">{filterCounts.qualityCounts[f.id]}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {tagPills.length > 0 && (
                <div className="search-filter-row" role="group" aria-label="Release tag filters">
                  {tagPills.map((f) => {
                    const active = selectedTags.includes(f.id);
                    return (
                      <button
                        key={f.id}
                        type="button"
                        className={`filter-pill ${active ? 'is-active' : ''}`}
                        aria-pressed={active}
                        onClick={() => toggleTag(f.id)}
                      >
                        <span>{f.label}</span>
                        <span className="filter-pill-count">{filterCounts.tagCounts[f.id]}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {hasResults ? (
        <>
          <TorrentTable
            rows={paginatedRows}
            sort={sort}
            onToggleSort={toggleSort}
            rowState={rowState}
            onAction={handleAction}
            activeCompletedHashes={activeCompletedHashes}
            loading={loading}
            tableRef={tableRef}
            emptyView={
              <div className="empty empty-filtered">
                <p>No results match the current filters.</p>
                {hasActiveFilters && (
                  <button type="button" className="btn btn-outline btn-sm" onClick={resetFilters}>
                    Reset filters
                  </button>
                )}
              </div>
            }
          />

          {totalPages > 1 && (
            <nav className="pagination" aria-label="Search results pagination">
              <button
                type="button"
                className="btn btn-outline btn-sm pagination-btn pagination-prev"
                onClick={() => goToPage(currentPage - 1)}
                disabled={currentPage === 1}
                aria-label="Previous page"
              >
                Previous
              </button>
              <div className="pagination-pages">
                {getPageNumbers(currentPage, totalPages).map((p, idx) =>
                  typeof p === 'number' ? (
                    <button
                      key={`page-${p}`}
                      type="button"
                      className={`pagination-page ${p === currentPage ? 'is-active' : ''}`}
                      onClick={() => goToPage(p)}
                      aria-label={`Page ${p}`}
                      aria-current={p === currentPage ? 'page' : undefined}
                    >
                      {p}
                    </button>
                  ) : (
                    <span key={`ellipsis-${idx}`} className="pagination-ellipsis" aria-hidden="true">
                      &hellip;
                    </span>
                  )
                )}
              </div>
              <button
                type="button"
                className="btn btn-outline btn-sm pagination-btn pagination-next"
                onClick={() => goToPage(currentPage + 1)}
                disabled={currentPage === totalPages}
                aria-label="Next page"
              >
                Next
              </button>
            </nav>
          )}
        </>
      ) : loading ? (
        <p className="empty" role="status">Searching…</p>
      ) : !error && searchedTerm && query.trim() ? (
        <p className="empty" role="status">Nothing found for “{searchedTerm}”. Try fewer or different keywords.</p>
      ) : (
        !error && (
          <p className="empty">
            Search by name. Choose a result to download.
          </p>
        )
      )}
    </section>
  );
}
