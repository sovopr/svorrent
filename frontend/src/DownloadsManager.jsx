import { useState, useEffect, useRef } from 'react';
import { useDialog } from './useDialog';
import { TorrentDetails } from './TorrentDetails';
import { SwarmModal } from './SwarmModal';
import { Icon } from './Icon';
import { apiGet, apiPost, formatBytes, formatEta, formatSpeed } from './lib';

const FILTERS = [
  { key: 'active', label: 'Active' },
  { key: 'completed', label: 'Completed' },
];

function statusOf(t) {
  if (t.isFolderFile) {
    if (t.isRecoverable) return { key: 'halfway', label: 'Incomplete · On disk' };
    return { key: 'local', label: 'On disk' };
  }
  if (t.done) {
    if (t.paused) return { key: 'done-paused', label: 'Completed · Stopped' };
    return { key: 'done', label: 'Completed · Seeding' };
  }
  if (t.paused) return { key: 'paused', label: 'Paused' };
  if (!t.ready) return { key: 'meta', label: 'Fetching metadata' };
  if (!t.numPeers) return { key: 'stalled', label: 'Looking for peers' };
  return { key: 'active', label: 'Downloading' };
}

export function DownloadsManager({ torrents, setTorrents, refresh, notify, onGoSearch }) {
  const [downloadDir, setDownloadDir] = useState(null);
  const [autoStopSeeding, setAutoStopSeeding] = useState(false);
  const [togglingSettings, setTogglingSettings] = useState(false);
  const [filter, setFilter] = useState('active');
  const [detailsId, setDetailsId] = useState(null);
  const [swarmTorrent, setSwarmTorrent] = useState(null);
  const [resumeModalOpen, setResumeModalOpen] = useState(false);
  const [magnetInput, setMagnetInput] = useState('');
  const [resuming, setResuming] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteFromDisk, setDeleteFromDisk] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const resumeDialog = useDialog(resumeModalOpen, () => setResumeModalOpen(false), resuming);
  const deleteDialog = useDialog(!!deleteTarget, () => setDeleteTarget(null), deleting);
  const openedFromHash = useRef(false);
  const pendingActions = useRef(new Set());
  const [pending, setPending] = useState(new Set());

  useEffect(() => {
    let active = true;
    apiGet('/config').then((config) => {
      if (active && typeof config.downloadDir === 'string') setDownloadDir(config.downloadDir);
      if (active && config?.settings && typeof config.settings.autoStopSeeding === 'boolean') {
        setAutoStopSeeding(config.settings.autoStopSeeding);
      }
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  const toggleAutoStopSeeding = async () => {
    if (togglingSettings) return;
    const nextVal = !autoStopSeeding;
    setAutoStopSeeding(nextVal);
    setTogglingSettings(true);
    try {
      await apiPost('/settings', { autoStopSeeding: nextVal });
      if (nextVal) {
        notify('Auto-stop seeding enabled');
        refresh();
      } else {
        notify('Auto-stop seeding disabled');
      }
    } catch (err) {
      setAutoStopSeeding(!nextVal);
      notify(err.message || 'Failed to update settings', 'error');
    } finally {
      setTogglingSettings(false);
    }
  };

  const location = downloadDir || 'the download folder';

  const runAction = async (id, action) => {
    if (pendingActions.current.has(id)) return;
    pendingActions.current.add(id);
    setPending(new Set(pendingActions.current));
    try { await action(); } finally {
      pendingActions.current.delete(id);
      setPending(new Set(pendingActions.current));
    }
  };

  useEffect(() => {
    if (!openedFromHash.current && window.location.hash.includes('swarm=open') && torrents.length > 0) {
      openedFromHash.current = true;
      setSwarmTorrent(torrents[0]);
    }
  }, [torrents]);

  const counts = {
    active: torrents.filter((t) => !t.done).length,
    completed: torrents.filter((t) => t.done).length,
  };

  const visible = torrents.filter((t) => {
    if (filter === 'completed') return t.done;
    return !t.done;
  });

  const togglePause = async (t) => {
    if (t.isFolderFile && t.isRecoverable) {
      return resumeRecoverable(t);
    }
    const nextPaused = !t.paused;
    setTorrents((prev) => prev.map((x) => (x.infoHash === t.infoHash ? { ...x, paused: nextPaused } : x)));
    try {
      await apiPost(`/torrent/${t.infoHash}/${t.paused ? 'resume' : 'pause'}`);
      if (t.done) {
        notify(nextPaused ? `Stopped seeding “${t.name}”` : `Resumed seeding “${t.name}”`);
      } else {
        notify(nextPaused ? `Paused “${t.name}”` : `Resumed “${t.name}”`);
      }
    } catch (err) {
      notify(err.message, 'error');
    }
    refresh();
  };

  const promptRemove = (t) => {
    setDeleteTarget(t);
    setDeleteFromDisk(false);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const t = deleteTarget;
    setDeleting(true);

    try {
      if (t.isFolderFile) {
        await apiPost('/folder-files/delete', { name: t.folderItemName || t.name });
        setTorrents((prev) => prev.filter((x) => x.infoHash !== t.infoHash));
        notify(`Deleted “${t.name}” from disk`);
      } else {
        await apiPost(`/torrent/${t.infoHash}/delete`, { deleteFiles: deleteFromDisk });
        setTorrents((prev) => prev.filter((x) => x.infoHash !== t.infoHash));
        if (detailsId === t.infoHash) setDetailsId(null);
        notify(
          deleteFromDisk
            ? `Deleted “${t.name}” and removed files from disk`
            : `Removed “${t.name}” (local files retained)`
        );
      }
      setDeleteTarget(null);
      refresh();
    } catch (err) {
      notify(err.message || 'Failed to remove', 'error');
    } finally {
      setDeleting(false);
    }
  };

  const reveal = async (targetIdOrName) => {
    try {
      await apiPost(`/torrent/${encodeURIComponent(targetIdOrName || 'root')}/open-finder`);
    } catch (err) {
      notify(err.message || 'Could not open folder', 'error');
    }
  };

  const recheckTorrent = async (infoHash, name) => {
    notify(`Verifying local data for “${name || infoHash}”…`);
    try {
      const res = await apiPost(`/torrent/${infoHash}/recheck`);
      const pct = Math.round((res.progress || 0) * 100);
      notify(`Verified “${name || infoHash}”: ${pct}% complete on disk`);
      refresh();
    } catch (err) {
      notify(err.message || 'Recheck failed', 'error');
    }
  };

  const resumeRecoverable = async (t) => {
    const infoHash = t.recoverable?.infoHash || t.infoHash;
    const magnet = t.magnet || t.recoverable?.magnetURI;
    try {
      notify(`Resuming “${t.name}” against existing files…`);
      await apiPost('/folder-files/resume', { infoHash, magnet });
      notify(`Resumed “${t.name}”`);
      refresh();
    } catch (err) {
      notify(err.message || 'Failed to resume download', 'error');
    }
  };

  const playMedia = async (t) => {
    try {
      const res = await apiPost(`/torrent/${encodeURIComponent(t.infoHash)}/play`);
      notify(`Opening “${res.file || t.name}” in ${res.player || 'VLC'}…`);
    } catch (err) {
      notify(err.message || 'Could not open media player', 'error');
    }
  };

  const handleResumeMagnetSubmit = async (e) => {
    e.preventDefault();
    const uri = magnetInput.trim();
    if (!uri) return;
    setResuming(true);
    try {
      await apiPost('/folder-files/resume', { magnet: uri });
      notify('Download added · Verifying local files…');
      setMagnetInput('');
      setResumeModalOpen(false);
      refresh();
      setFilter('active');
    } catch (err) {
      notify(err.message || 'Could not resume with magnet', 'error');
    } finally {
      setResuming(false);
    }
  };

  return (
    <section className="downloads-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Downloads</h1>
          <p className="page-sub">
            Saved to <span className="mono">{location}</span>
          </p>
        </div>
        <div className="page-actions">
          <button
            id="btn-resume-magnet"
            className="btn btn-outline"
            onClick={() => {
              setMagnetInput('');
              setResumeModalOpen(true);
            }}
            title="Resume a download by pasting its magnet link or infohash"
          >
            <Icon name="magnet" size={13} /> Resume with magnet
          </button>
          <button
            id="open-downloads-folder"
            className="btn btn-outline"
            onClick={() => reveal('root')}
            title={`Open ${location} in Finder`}
          >
            <Icon name="folder" size={13} /> Open folder
          </button>
        </div>
      </div>

      {/* Toolbar & Filter Tabs */}
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Filter downloads">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              id={`filter-${f.key}`}
              aria-pressed={filter === f.key}
              className={`segment ${filter === f.key ? 'is-active' : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              <span className="segment-count">{counts[f.key]}</span>
            </button>
          ))}
        </div>
        <div className="toolbar-actions">
          <label className="toggle-setting" title="Automatically stop uploading when downloads finish">
            <span className="toggle-setting-label">Stop seeding when done</span>
            <button
              type="button"
              role="switch"
              id="toggle-auto-stop-seeding"
              aria-checked={autoStopSeeding}
              className={`btn-toggle ${autoStopSeeding ? 'is-active' : ''}`}
              onClick={toggleAutoStopSeeding}
              disabled={togglingSettings}
              aria-label="Toggle auto-stop seeding when complete"
            >
              <span className="toggle-thumb" />
            </button>
          </label>
        </div>
      </div>

      {/* Downloads Table */}
      {visible.length === 0 ? (
        <div className="empty-block">
          {torrents.length === 0 ? (
            <>
              <p>No downloads yet.</p>
              <button className="btn btn-outline" onClick={() => onGoSearch('')}>
                Search for something
              </button>
            </>
          ) : (
            <p>Nothing in this view.</p>
          )}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table downloads-table">
            <thead>
              <tr>
                <th className="col-name">Name</th>
                <th className="col-num">Size</th>
                <th className="col-num col-hide-sm">Down</th>
                <th className="col-num col-hide-sm">Up</th>
                <th className="col-num col-hide-md">Peers</th>
                <th className="col-num">ETA</th>
                <th className="col-actions">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((t) => {
                const pct = Math.floor(Math.max(0, Math.min(1, t.progress || 0)) * 1000) / 10;
                const status = statusOf(t);
                const isFolder = !!t.isFolderFile;
                const displayName = !isFolder && t.playability?.fileName ? t.playability.fileName : t.name;

                return (
                  <tr key={t.infoHash} className={`dl-row is-${status.key}`}>
                    <td className="col-name">
                      {isFolder ? (
                        <div className="dl-name-wrapper">
                          <span className="dl-name-static" title={t.name}>
                            {t.name}
                          </span>
                          {t.isRecoverable ? (
                            <span className="tag-inline-warn">Incomplete</span>
                          ) : (
                            <span className="tag-inline-muted">On disk</span>
                          )}
                        </div>
                      ) : (
                        <button
                          className="dl-name"
                          onClick={() => setDetailsId(t.infoHash)}
                          title={displayName === t.name ? t.name : `${displayName} — ${t.name}`}
                        >
                          {displayName}
                        </button>
                      )}

                      <div className="dl-progress">
                        <div className="bar">
                          <div
                            className={`bar-fill ${t.isRecoverable ? 'bar-fill-warn' : ''}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="dl-status">
                          <span className="mono">{t.done ? '100%' : `${pct.toFixed(1)}%`}</span>
                          <span className="dot-sep" />
                          <span>{status.label}</span>
                          {t.length > 0 && (
                            <>
                              <span className="dot-sep" />
                              <span className="mono">{formatBytes(t.downloaded ?? (isFolder ? t.length : 0))}</span>
                              {t.isRecoverable && t.length > t.downloaded && (
                                <span className="muted mono"> of {formatBytes(t.length)}</span>
                              )}
                            </>
                          )}
                          {t.filesCount > 1 && (
                            <>
                              <span className="dot-sep" />
                              <span>{t.filesCount} files</span>
                            </>
                          )}
                          {t.playability?.isMedia && !t.playability.canPlay && (
                            <>
                              <span className="dot-sep" />
                              <span className="muted" title={t.playability.reason}>
                                {t.paused ? 'Resume to buffer' : 'Buffering for playback'}
                              </span>
                            </>
                          )}
                        </span>
                      </div>
                    </td>

                    <td className="col-num mono">{t.length ? formatBytes(t.length) : '—'}</td>
                    <td className="col-num mono col-hide-sm">
                      {isFolder || t.done ? '—' : formatSpeed(t.downloadSpeed)}
                    </td>
                    <td className="col-num mono col-hide-sm muted">
                      {isFolder || (t.done && t.paused) ? '—' : formatSpeed(t.uploadSpeed)}
                    </td>
                    <td className="col-num mono col-hide-md muted">
                      {isFolder || (t.done && t.paused) ? '—' : (t.numPeers || 0)}
                    </td>
                    <td className="col-num mono muted">
                      {isFolder || t.done || t.paused ? '—' : formatEta(t.timeRemaining)}
                    </td>

                    <td className="col-actions">
                      <div className="dl-actions-row">
                        {isFolder ? (
                          <>
                            {t.isRecoverable && (
                              <button
                                className="btn btn-outline btn-sm"
                                onClick={() => runAction(t.infoHash, () => resumeRecoverable(t))}
                                disabled={pending.has(t.infoHash)}
                                title="Resume download"
                              >
                                <Icon name="play" size={12} /> Resume
                              </button>
                            )}
                            {t.playability?.isMedia && (
                              <button
                                className="btn btn-outline btn-sm"
                                disabled={!t.playability.canPlay}
                                onClick={() => playMedia(t)}
                                title={t.playability.reason}
                                aria-label={`Play media: ${t.playability.reason}`}
                              >
                                <Icon name="play" size={12} /> Play
                              </button>
                            )}
                            <button
                              className="icon-btn"
                              onClick={() => {
                                setMagnetInput(t.magnet || '');
                                setResumeModalOpen(true);
                              }}
                              title={t.isRecoverable ? 'Resume with custom magnet' : 'Seed or resume via magnet link'}
                              aria-label="Resume with magnet link"
                            >
                              <Icon name="magnet" size={14} />
                            </button>
                            <button className="icon-btn" onClick={() => reveal(t.folderItemName || t.name)} title="Show in Finder" aria-label="Show in Finder">
                              <Icon name="folder" size={14} />
                            </button>
                            <button className="icon-btn icon-btn-danger" onClick={() => promptRemove(t)} title="Delete from disk" aria-label="Delete from disk">
                              <Icon name="trash" size={14} />
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              className="btn btn-outline btn-sm"
                              onClick={() => runAction(t.infoHash, () => togglePause(t))}
                              disabled={pending.has(t.infoHash)}
                              title={t.done ? (t.paused ? 'Resume seeding' : 'Stop seeding') : (t.paused ? 'Resume download' : 'Pause download')}
                            >
                              <Icon name={t.paused ? 'play' : 'pause'} size={12} />
                              <span>{t.done ? (t.paused ? 'Seed' : 'Stop') : (t.paused ? 'Resume' : 'Pause')}</span>
                            </button>
                            {t.playability?.isMedia && (
                              <button
                                className="btn btn-outline btn-sm"
                                disabled={!t.playability.canPlay}
                                onClick={() => playMedia(t)}
                                title={t.playability.reason}
                                aria-label={`Play media: ${t.playability.reason}`}
                              >
                                <Icon name="play" size={12} /> Play
                              </button>
                            )}
                            <button className="icon-btn" onClick={() => setSwarmTorrent(t)} title="Peers and pieces" aria-label="Peers and pieces">
                              <Icon name="globe" size={14} />
                            </button>
                            <button className="icon-btn" onClick={() => setDetailsId(t.infoHash)} title="Details" aria-label="Details">
                              <Icon name="info" size={14} />
                            </button>
                            <button className="icon-btn" onClick={() => reveal(t.infoHash)} title="Show in Finder" aria-label="Show in Finder">
                              <Icon name="folder" size={14} />
                            </button>
                            <button className="icon-btn" onClick={() => runAction(t.infoHash, () => recheckTorrent(t.infoHash, t.name))} disabled={pending.has(t.infoHash)} title="Verify local data" aria-label="Force Recheck">
                              <Icon name="refresh" size={14} />
                            </button>
                            <button className="icon-btn icon-btn-danger" onClick={() => promptRemove(t)} title="Remove" aria-label="Remove">
                              <Icon name="trash" size={14} />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal: Resume Download with Magnet or InfoHash */}
      {resumeModalOpen && (
        <div className="modal-backdrop" onClick={() => !resuming && setResumeModalOpen(false)}>
          <div ref={resumeDialog} tabIndex={-1} className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="modal-resume-title">
            <div className="modal-head">
              <h2 id="modal-resume-title" className="modal-title">Resume a download</h2>
              <button className="icon-btn" disabled={resuming} onClick={() => setResumeModalOpen(false)} aria-label="Close dialog">
                <Icon name="x" size={14} />
              </button>
            </div>
            <form onSubmit={handleResumeMagnetSubmit} className="modal-body">
              <p className="modal-desc muted">
                Paste a magnet link or info hash. Existing files in <span className="mono">{location}</span> will be verified before missing pieces are downloaded.
              </p>
              <div className="field">
                <input
                  type="text"
                  aria-label="Magnet link or info hash"
                  className="input mono"
                  placeholder="magnet:?xt=urn:btih:..."
                  value={magnetInput}
                  onChange={(e) => setMagnetInput(e.target.value)}
                  autoFocus
                  required
                />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" disabled={resuming} onClick={() => setResumeModalOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={resuming || !magnetInput.trim()}>
                  {resuming ? 'Verifying files…' : 'Resume download'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Delete / Remove Download Confirmation */}
      {deleteTarget && (
        <div
          className="modal-backdrop"
          onClick={() => !deleting && setDeleteTarget(null)}
        >
          <div
            ref={deleteDialog}
            tabIndex={-1}
            className="modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-delete-title"
          >
            <div className="modal-head">
              <h2 id="modal-delete-title" className="modal-title">
                {deleteTarget.isFolderFile ? 'Delete file?' : 'Remove download?'}
              </h2>
              <button
                className="icon-btn"
                onClick={() => !deleting && setDeleteTarget(null)}
                aria-label="Close dialog"
                disabled={deleting}
              >
                <Icon name="x" size={14} />
              </button>
            </div>

            <div className="modal-body">
              <div className="delete-target-preview">
                <div className="delete-target-name ellipsis" title={deleteTarget.name}>
                  {deleteTarget.name}
                </div>
                <div className="delete-target-meta mono muted">
                  {deleteTarget.isFolderFile ? (
                    <span>{formatBytes(deleteTarget.length || deleteTarget.downloaded || 0)} on disk</span>
                  ) : (
                    <span>
                      {formatBytes(deleteTarget.downloaded || 0)}
                      {deleteTarget.length > 0 && ` of ${formatBytes(deleteTarget.length)}`}
                      {deleteTarget.progress > 0 && ` (${Math.round(deleteTarget.progress * 100)}%)`}
                    </span>
                  )}
                </div>
              </div>

              {deleteTarget.isFolderFile ? (
                <p className="modal-desc muted">
                  This permanently deletes the file from <span className="mono">{location}</span>.
                </p>
              ) : (
                <label className="delete-disk-option">
                  <input
                    type="checkbox"
                    className="delete-disk-checkbox"
                    checked={deleteFromDisk}
                    onChange={(e) => setDeleteFromDisk(e.target.checked)}
                    disabled={deleting}
                  />
                  <div className="delete-disk-label">
                    <span className="delete-disk-title">Also delete downloaded files from disk</span>
                    <span className="delete-disk-sub">
                      {deleteFromDisk
                        ? `Permanently removes downloaded data from ${location}.`
                        : 'Leaves downloaded files on disk so you can access or resume them later.'}
                    </span>
                  </div>
                </label>
              )}

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => setDeleteTarget(null)}
                  disabled={deleting}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={`btn ${deleteFromDisk || deleteTarget.isFolderFile ? 'btn-danger' : 'btn-primary'}`}
                  onClick={confirmDelete}
                  disabled={deleting}
                >
                  {deleting
                    ? 'Removing…'
                    : deleteFromDisk || deleteTarget.isFolderFile
                    ? 'Delete files'
                    : 'Remove download'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Torrent Details Drawer */}
      {detailsId && (
        <TorrentDetails
          torrentId={detailsId}
          onClose={() => setDetailsId(null)}
          onReveal={() => reveal(detailsId)}
        />
      )}

      {/* Swarm Topology & Peer Map Modal */}
      {swarmTorrent && (
        <SwarmModal
          torrent={torrents.find((t) => t.infoHash === swarmTorrent.infoHash) || swarmTorrent}
          onClose={() => setSwarmTorrent(null)}
        />
      )}
    </section>
  );
}
