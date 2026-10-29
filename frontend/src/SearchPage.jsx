import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import { apiGet, apiPost, parseSize } from './lib';

const COLUMNS = [
  { key: 'title', label: 'Name', className: 'col-name' },
  { key: 'size', label: 'Size', className: 'col-num' },
  { key: 'seeds', label: 'Seeds', className: 'col-num' },
  { key: 'peers', label: 'Leech', className: 'col-num' },
  { key: 'provider', label: 'Source', className: 'col-source' },
];

function seedClass(seeds) {
  if (seeds >= 50) return 'seeds-good';
  if (seeds >= 5) return 'seeds-ok';
  return 'seeds-low';
}

function safeLink(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function validMagnet(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'magnet:' && !!url.searchParams.get('xt');
  } catch {
    return false;
  }
}

export function SearchPage({ notify, onDownloadAdded, initialQuery, isActive = true }) {
  const [query, setQuery] = useState(initialQuery || '');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchedTerm, setSearchedTerm] = useState('');
  const [error, setError] = useState('');
  const [sort, setSort] = useState({ key: 'seeds', dir: 'desc' });
  const [source, setSource] = useState('all');
  const [rowState, setRowState] = useState({});

  const inputRef = useRef(null);
  const searchId = useRef(0);
  const searchController = useRef(null);
  const resultId = useRef(0);
  const mounted = useRef(false);
  const active = useRef(isActive);
  const actions = useRef(new Map());
  const debounce = useRef(null);

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
      const count = (value) => {
        const number = Number(typeof value === 'string' ? value.replace(/,/g, '') : value);
        return Number.isFinite(number) ? Math.max(0, number) : 0;
      };
      resultId.current = id;
      const validResults = data.filter((r) => {
        if (!r || typeof r.title !== 'string') return false;
        const lower = r.title.trim().toLowerCase();
        return lower !== 'no results returned' && lower !== 'no results found';
      });
      setResults(validResults.map((r, index) => ({
        ...r,
        _id: `${id}:${index}`,
        _generation: id,
        size: typeof r.size === 'string' ? r.size : '',
        seeds: count(r.seeds),
        peers: count(r.peers),
        magnet: validMagnet(r.magnet) ? r.magnet : '',
        desc: typeof r.desc === 'string' ? r.desc : '',
        link: safeLink(r.link),
      })));
      setRowState({});
      setSource('all');
      setSearchedTerm(term);
    } catch (err) {
      if (mounted.current && searchId.current === id && !controller.signal.aborted) {
        setError(err.message || 'Could not search. Please try again.');
      }
    } finally {
      if (mounted.current && searchId.current === id) setLoading(false);
    }
  }, [cancelSearch]);

  useEffect(() => {
    active.current = isActive;
  }, [isActive]);

  useEffect(() => {
    mounted.current = true;
    const pending = actions.current;
    return () => {
      mounted.current = false;
      cancelSearch();
      for (const controller of pending.values()) controller.abort();
      pending.clear();
    };
  }, [cancelSearch]);

  useEffect(() => {
    if (typeof initialQuery === 'string') {
      cancelSearch();
      setLoading(false);
      setQuery(initialQuery.trim());
      if (!initialQuery.trim()) {
        resultId.current = searchId.current;
        setResults([]);
        setSearchedTerm('');
        setError('');
        setRowState({});
        setSource('all');
      }
    }
  }, [initialQuery, cancelSearch]);

  // Search after user stops typing
  useEffect(() => {
    const term = query.trim();
    cancelSearch();
    setLoading(false);
    if (term.length < 2) return;
    debounce.current = setTimeout(() => runSearch(term), 450);
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

  const rows = useMemo(() => {
    const list = results
      .map((r) => ({ ...r, _bytes: parseSize(r.size) }))
      .filter((r) => source === 'all' || r.provider === source);

    const dir = sort.dir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      if (sort.key === 'size') return (a._bytes - b._bytes) * dir;
      if (sort.key === 'seeds' || sort.key === 'peers') return ((a[sort.key] || 0) - (b[sort.key] || 0)) * dir;
      return String(a[sort.key] || '').localeCompare(String(b[sort.key] || '')) * dir;
    });
    return list;
  }, [results, sort, source]);

  const toggleSort = (key) => {
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'title' || key === 'provider' ? 'asc' : 'desc' }
    );
  };

  const isCurrent = (t, controller) => mounted.current && !controller.signal.aborted && resultId.current === t._generation;
  const setRow = (t, controller, value) => {
    if (isCurrent(t, controller)) setRowState((prev) => ({ ...prev, [t._id]: value }));
  };

  const resolveMagnet = async (t, controller) => {
    if (validMagnet(t.magnet)) return t.magnet;
    const params = new URLSearchParams({ provider: t.provider, desc: t.desc || '', link: t.link || '' });
    const data = await apiGet(`/magnet?${params}`, { signal: controller.signal });
    if (!validMagnet(data.magnet)) throw new Error('The server did not return a valid magnet link.');
    if (isCurrent(t, controller)) {
      setResults((prev) => prev.map((r) => (r._id === t._id ? { ...r, magnet: data.magnet } : r)));
    }
    return data.magnet;
  };

  const handleAction = async (t, action) => {
    if (actions.current.has(t._id) || (action === 'adding' && rowState[t._id] === 'added')) return;
    const controller = new AbortController();
    const previous = rowState[t._id];
    actions.current.set(t._id, controller);
    setRow(t, controller, action);
    try {
      if (action === 'adding') {
        const data = await apiPost('/torrent/download', { magnet: t.magnet, provider: t.provider, desc: t.desc, link: t.link }, { signal: controller.signal });
        if (data.success !== true || typeof data.infoHash !== 'string') throw new Error('The server did not confirm the download. Check Downloads before retrying.');
        setRow(t, controller, 'added');
        if (mounted.current && !controller.signal.aborted) {
          notify('Added to downloads.');
          onDownloadAdded?.();
        }
      } else {
        const magnet = await resolveMagnet(t, controller);
        if (!isCurrent(t, controller)) return;
        if (!active.current) return;
        if (action === 'opening') window.location.assign(magnet);
        else {
          await navigator.clipboard.writeText(magnet);
          if (isCurrent(t, controller)) notify('Magnet link copied');
        }
      }
    } catch (err) {
      setRow(t, controller, previous || null);
      if (isCurrent(t, controller)) notify(err.message || 'Could not complete the action.', 'error');
    } finally {
      if (action !== 'adding') setRow(t, controller, previous || null);
      if (actions.current.get(t._id) === controller) actions.current.delete(t._id);
    }
  };

  const clear = () => {
    cancelSearch();
    resultId.current = searchId.current;
    setQuery('');
    setResults([]);
    setSearchedTerm('');
    setError('');
    setRowState({});
    setSource('all');
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
        <div className="toolbar">
          <span className="toolbar-summary" role="status">
            {loading ? 'Searching…' : `${rows.length} result${rows.length === 1 ? '' : 's'} for “${searchedTerm}”`}
          </span>
          {sources.length > 1 && (
            <label className="select-wrap">
              <span className="sr-only">Filter by source</span>
              <select id="source-filter" value={source} onChange={(e) => setSource(e.target.value)}>
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
      )}

      {hasResults ? (
        <div className={`table-wrap ${loading ? 'is-stale' : ''}`} aria-busy={loading}>
          <table className="table results-table">
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <th key={c.key} className={c.className} aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    <button className="th-btn" onClick={() => toggleSort(c.key)}>
                      {c.label}
                      <span className={`sort-caret ${sort.key === c.key ? 'is-on' : ''}`}>{sort.key === c.key && sort.dir === 'asc' ? '▴' : '▾'}</span>
                    </button>
                  </th>
                ))}
                <th className="col-actions">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const state = rowState[t._id];
                const busy = ['adding', 'opening', 'copying'].includes(state);
                return (
                  <tr key={t._id}>
                    <td className="col-name">
                      <span className="cell-title" title={t.title}>
                        {t.title}
                      </span>
                    </td>
                    <td className="col-num mono">{t.size || '—'}</td>
                    <td className={`col-num mono ${seedClass(t.seeds || 0)}`}>{t.seeds ?? 0}</td>
                    <td className="col-num mono muted">{t.peers ?? 0}</td>
                    <td className="col-source">
                      <span className="provider-pill">{t.provider}</span>
                    </td>
                    <td className="col-actions">
                      <div className="row-actions">
                        <button
                          className={`btn btn-sm ${state === 'added' ? 'btn-done' : 'btn-outline'}`}
                          onClick={() => handleAction(t, 'adding')}
                          disabled={busy || state === 'added'}
                          aria-label={`${state === 'added' ? 'Added' : 'Download'} ${t.title}`}
                        >
                          {state === 'added' ? (
                            <>
                              <Icon name="check" size={14} /> Added
                            </>
                          ) : state === 'adding' ? (
                            'Adding…'
                          ) : (
                            <>
                              <Icon name="download" size={14} /> Download
                            </>
                          )}
                        </button>
                        <button className="icon-btn" disabled={busy} onClick={() => handleAction(t, 'opening')} title="Open magnet in desktop client" aria-label={`Open magnet for ${t.title}`}>
                          <Icon name="magnet" />
                        </button>
                        <button className="icon-btn" disabled={busy} onClick={() => handleAction(t, 'copying')} title="Copy magnet link" aria-label={`Copy magnet link for ${t.title}`}>
                          <Icon name="copy" />
                        </button>
                        {t.link ? (
                          <a className="icon-btn" href={t.link} target="_blank" rel="noreferrer" download title="Download .torrent file" aria-label="Download .torrent file">
                            <Icon name="file" />
                          </a>
                        ) : (
                          <span className="icon-btn is-placeholder" />
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && <p className="empty">No results match the current source filter.</p>}
        </div>
      ) : loading ? (
        <p className="empty" role="status">Searching…</p>
      ) : !error && searchedTerm && query.trim() ? (
        <p className="empty" role="status">Nothing found for “{searchedTerm}”. Try fewer or different keywords.</p>
      ) : (
        !error && (
          <p className="empty">
            Search by name. Choose a result to download or copy its magnet link.
          </p>
        )
      )}
    </section>
  );
}
