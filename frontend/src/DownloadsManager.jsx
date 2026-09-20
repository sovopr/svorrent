import React, { useState, useEffect } from 'react';
import { NerdModal } from './NerdModal';

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatTime(ms) {
  if (!ms || ms === Infinity || isNaN(ms)) return '∞';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function DownloadsManager() {
  const [torrents, setTorrents] = useState([]);
  const [filter, setFilter] = useState('all'); // 'all' | 'downloading' | 'completed' | 'paused' | 'streams'
  const [nerdModalTorrentId, setNerdModalTorrentId] = useState(null);
  const [actionFeedback, setActionFeedback] = useState('');

  const fetchTorrents = async () => {
    try {
      const res = await fetch('http://localhost:3001/api/torrents');
      if (res.ok) {
        const list = await res.json();
        setTorrents(list);
      }
    } catch (e) {}
  };

  useEffect(() => {
    fetchTorrents();
    const interval = setInterval(fetchTorrents, 1200);
    return () => clearInterval(interval);
  }, []);

  const handlePauseResume = async (infoHash, isPaused) => {
    const endpoint = isPaused ? 'resume' : 'pause';
    // Optimistic UI update
    setTorrents((prev) =>
      prev.map((t) => (t.infoHash === infoHash ? { ...t, paused: !isPaused } : t))
    );
    try {
      await fetch(`http://localhost:3001/api/torrent/${infoHash}/${endpoint}`, { method: 'POST' });
      fetchTorrents();
    } catch (e) {}
  };

  const handleDelete = async (infoHash) => {
    if (confirm('Stop and remove this download from Svorrent?')) {
      await fetch(`http://localhost:3001/api/torrent/${infoHash}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteFiles: false }),
      });
      setTorrents((prev) => prev.filter((t) => t.infoHash !== infoHash));
      if (nerdModalTorrentId === infoHash) setNerdModalTorrentId(null);
    }
  };

  const handleOpenFinder = async (infoHash) => {
    await fetch(`http://localhost:3001/api/torrent/${infoHash}/open-finder`, { method: 'POST' });
    setActionFeedback('Opened download location');
    setTimeout(() => setActionFeedback(''), 2500);
  };

  const handlePlayNative = async (infoHash) => {
    await fetch(`http://localhost:3001/api/torrent/${infoHash}/play-native`, { method: 'POST' });
    setActionFeedback('Launched in desktop player');
    setTimeout(() => setActionFeedback(''), 2500);
  };

  // DownloadsManager displays real user downloads exclusively
  const filteredTorrents = torrents.filter((t) => {
    if (filter === 'downloading') return !t.done && !t.paused;
    if (filter === 'completed') return t.done;
    if (filter === 'paused') return t.paused;
    return true;
  });

  const totalDownSpeed = torrents.reduce((acc, t) => acc + (t.downloadSpeed || 0), 0);
  const totalUpSpeed = torrents.reduce((acc, t) => acc + (t.uploadSpeed || 0), 0);
  const activeCount = torrents.filter((t) => !t.done && !t.paused).length;
  const completedCount = torrents.filter((t) => t.done).length;
  const pausedCount = torrents.filter((t) => t.paused).length;

  return (
    <div className="downloads-page-container">
      {/* Top Header */}
      <header className="downloads-page-header">
        <div className="header-left">
          <a href="/" className="cinema-back-link" title="Return to Svorrent Search">
            ← Svorrent Search
          </a>
          <div className="downloads-title-group">
            <h1>⬇ Downloads Manager</h1>
            <span className="downloads-path-hint">
              📁 Saved to <strong>~/Downloads/Svorrent</strong>
            </span>
          </div>
        </div>

        <div className="header-right">
          {actionFeedback && <span className="action-feedback">{actionFeedback}</span>}

          <div className="global-stats-pill">
            <span className="stat-pill-item">
              <span className="pill-dot">●</span> <strong>{activeCount}</strong> active
            </span>
            <span className="stat-pill-item speed-down">
              ⚡ <strong>{formatBytes(totalDownSpeed)}/s</strong>
            </span>
            {totalUpSpeed > 0 && (
              <span className="stat-pill-item speed-up">
                ▲ <strong>{formatBytes(totalUpSpeed)}/s</strong>
              </span>
            )}
          </div>

          <button
            className="btn btn-secondary btn-sm"
            onClick={() => handleOpenFinder(permanentDownloads[0]?.infoHash || '')}
            title="Open ~/Downloads/Svorrent in Finder / Explorer"
          >
            📂 Open Downloads Folder
          </button>
        </div>
      </header>

      {/* Filter Tabs Bar */}
      <nav className="downloads-filter-bar">
        <div className="filter-tab-group">
          <button
            className={`filter-btn ${filter === 'all' ? 'active' : ''}`}
            onClick={() => setFilter('all')}
          >
            All Downloads ({permanentDownloads.length})
          </button>

          <button
            className={`filter-btn ${filter === 'downloading' ? 'active' : ''}`}
            onClick={() => setFilter('downloading')}
          >
            Downloading ({activeCount})
          </button>

          <button
            className={`filter-btn ${filter === 'completed' ? 'active' : ''}`}
            onClick={() => setFilter('completed')}
          >
            Completed ({completedCount})
          </button>

          <button
            className={`filter-btn ${filter === 'paused' ? 'active' : ''}`}
            onClick={() => setFilter('paused')}
          >
            Paused ({pausedCount})
          </button>
        </div>
      </nav>

      {/* Main Downloads List */}
      <main className="downloads-content">
        {filteredTorrents.length === 0 ? (
          <div className="empty-downloads-card">
            <div className="empty-icon">⬇</div>
            <h3>No Downloads in this category</h3>
            <p>
              {filter === 'completed'
                ? 'No completed torrents yet.'
                : filter === 'paused'
                ? 'No torrents are currently paused.'
                : 'Search for high-quality torrents or Remuxes and click ⬇ Download to save them locally.'}
            </p>
            <a href="/" className="btn btn-primary" style={{ textDecoration: 'none', display: 'inline-block' }}>
              🔍 Search Svorrent
            </a>
          </div>
        ) : (
          <div className="downloads-cards-grid">
            {filteredTorrents.map((t) => {
              const pct = Math.round((t.progress || 0) * 100);
              const isPaused = t.paused;
              const isDone = t.done;

              return (
                <div key={t.infoHash} className={`download-card ${isDone ? 'done' : isPaused ? 'paused' : 'active'}`}>
                  <div className="card-top-row">
                    <div className="card-title-box">
                      <div className="card-badges">
                        <span className={`status-tag ${isDone ? 'tag-done' : isPaused ? 'tag-paused' : 'tag-active'}`}>
                          {isDone ? '✓ Completed' : isPaused ? '⏸ Paused' : '⚡ Downloading'}
                        </span>
                        <span className="size-tag">{formatBytes(t.length)}</span>
                      </div>
                      <h3 className="download-name" title={t.name}>
                        {t.name}
                      </h3>
                    </div>

                    <div className="card-actions">
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          const playerUrl = `/player?magnet=${encodeURIComponent(t.magnet)}&title=${encodeURIComponent(t.name)}`;
                          window.open(playerUrl, '_blank');
                        }}
                        title="Stream in dedicated Cinema theater tab"
                      >
                        ⚡ Stream in Cinema
                      </button>

                      <button
                        className="btn btn-nerd btn-sm"
                        onClick={() => setNerdModalTorrentId(t.infoHash)}
                        title="Inspect wire packets, peers, piece map, and trackers"
                      >
                        🔍 Nerd Info
                      </button>

                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => handleOpenFinder(t.infoHash)}
                        title="Reveal file in Finder / Explorer"
                      >
                        📂 Finder
                      </button>

                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => handlePlayNative(t.infoHash)}
                        title="Open in native desktop player (IINA / VLC) with full HDR & TrueHD passthrough"
                      >
                        ▶ Open
                      </button>

                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => handlePauseResume(t.infoHash, t.paused)}
                        title={isPaused ? 'Resume downloading' : 'Pause downloading'}
                      >
                        {isPaused ? '▶ Resume' : '⏸ Pause'}
                      </button>

                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => handleDelete(t.infoHash)}
                        title="Remove torrent"
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  {/* Progress bar */}
                  <div className="card-progress-section">
                    <div className="progress-bar-bg">
                      <div
                        className={`progress-bar-fill ${isDone ? 'fill-done' : isPaused ? 'fill-paused' : ''}`}
                        style={{ width: `${Math.max(pct, 2)}%` }}
                      ></div>
                    </div>
                  </div>

                  {/* Metrics bar */}
                  <div className="card-metrics-row">
                    <div className="metric-item">
                      <span className="metric-label">Downloaded:</span>
                      <span className="metric-val">{formatBytes(t.downloaded)} of {formatBytes(t.length)} ({pct}%)</span>
                    </div>

                    {!isDone && (
                      <div className="metric-item">
                        <span className="metric-label">Down Speed:</span>
                        <span className="metric-val speed-val">⚡ {formatBytes(t.downloadSpeed)}/s</span>
                      </div>
                    )}

                    {!isDone && t.uploadSpeed > 0 && (
                      <div className="metric-item">
                        <span className="metric-label">Up Speed:</span>
                        <span className="metric-val">▲ {formatBytes(t.uploadSpeed)}/s</span>
                      </div>
                    )}

                    <div className="metric-item">
                      <span className="metric-label">Peers:</span>
                      <span className="metric-val peers-val">● {t.numPeers} connected</span>
                    </div>

                    {!isDone && (
                      <div className="metric-item">
                        <span className="metric-label">ETA:</span>
                        <span className="metric-val">{isPaused ? 'Paused' : formatTime(t.timeRemaining)}</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {/* Nerd Modal */}
      {nerdModalTorrentId && (
        <NerdModal
          torrentId={nerdModalTorrentId}
          onClose={() => setNerdModalTorrentId(null)}
        />
      )}
    </div>
  );
}
