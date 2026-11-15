import { Icon } from './Icon';
import { formatSwarmCount, seedClass } from './lib';

const COLUMNS = [
  { key: 'title', label: 'Name', className: 'col-name' },
  { key: 'size', label: 'Size', className: 'col-num' },
  { key: 'seeds', label: 'Seeds', className: 'col-num' },
  { key: 'peers', label: 'Leech', className: 'col-num' },
  { key: 'provider', label: 'Source', className: 'col-source' },
];

export function TorrentTable({
  rows,
  sort,
  onToggleSort,
  rowState,
  onAction,
  activeCompletedHashes,
  loading = false,
  tableRef = null,
  onFindSimilar = null,
  emptyView = null,
}) {
  return (
    <div ref={tableRef} className={`table-wrap ${loading ? 'is-stale' : ''}`} aria-busy={loading}>
      <table className="table results-table">
        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <th key={c.key} className={c.className} aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                <button className="th-btn" onClick={() => onToggleSort(c.key)}>
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
            const busy = state === 'adding' || state === 'opening';
            const isDownloaded = Boolean(
              t.downloaded || (t.infoHash && activeCompletedHashes.has(t.infoHash.toLowerCase())),
            );
            return (
              <tr key={t._id}>
                <td className="col-name">
                  <div className="title-with-badge">
                    <span className="cell-title" title={t.title}>
                      {t.title}
                    </span>
                    {t.age && <span className="age-chip">{t.age}</span>}
                    {isDownloaded && (
                      <span className="downloaded-badge" title="Previously downloaded">
                        <Icon name="check" size={11} /> Downloaded
                      </span>
                    )}
                  </div>
                </td>
                <td className="col-num mono">{t.size || '—'}</td>
                <td className={`col-num mono ${seedClass(formatSwarmCount(t.seeds))}`}>{formatSwarmCount(t.seeds)}</td>
                <td className="col-num mono muted">{formatSwarmCount(t.peers)}</td>
                <td className="col-source">
                  <span className="provider-pill">{t.provider}</span>
                </td>
                <td className="col-actions">
                  <div className="row-actions">
                    <button
                      className={`btn btn-sm ${
                        state === 'added'
                          ? 'btn-done'
                          : isDownloaded
                          ? 'btn-download-again'
                          : 'btn-outline'
                      }`}
                      onClick={() => onAction(t, 'adding')}
                      disabled={busy || state === 'added'}
                      aria-label={`${
                        state === 'added' ? 'Added' : isDownloaded ? 'Download again' : 'Download'
                      } ${t.title}`}
                    >
                      {state === 'added' ? (
                        <>
                          <Icon name="check" size={14} /> Added
                        </>
                      ) : state === 'adding' ? (
                        'Adding…'
                      ) : isDownloaded ? (
                        <>
                          <Icon name="refresh" size={13} /> Download again
                        </>
                      ) : (
                        <>
                          <Icon name="download" size={14} /> Download
                        </>
                      )}
                    </button>
                    {onFindSimilar && (
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => onFindSimilar(t)}
                        title="Find all releases across indexers"
                        aria-label={`Search all sources for ${t.title}`}
                      >
                        <Icon name="search" size={14} />
                      </button>
                    )}
                    <button
                      className="icon-btn"
                      disabled={busy}
                      onClick={() => onAction(t, 'opening')}
                      title="Open magnet in desktop client"
                      aria-label={`Open magnet for ${t.title}`}
                    >
                      <Icon name="magnet" />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && emptyView}
    </div>
  );
}
