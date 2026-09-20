import React, { useState, useEffect, useRef } from 'react';
import { CinemaPlayer } from './CinemaPlayer';
import { NerdModal } from './NerdModal';
import './index.css';

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

function App() {
  const isPlayerRoute =
    window.location.pathname === '/player' ||
    window.location.pathname.endsWith('/player') ||
    new URLSearchParams(window.location.search).has('player') ||
    new URLSearchParams(window.location.search).has('streamMagnet');

  if (isPlayerRoute) {
    return <CinemaPlayer />;
  }

  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [actionState, setActionState] = useState({});

  // Downloads Manager State
  const [downloads, setDownloads] = useState([]);
  const [showDownloadsDrawer, setShowDownloadsDrawer] = useState(false);

  // Streaming Preview Modal State
  const [activeStream, setActiveStream] = useState(null);
  const [streamStatus, setStreamStatus] = useState(null);
  const [streamError, setStreamError] = useState('');
  const streamPollRef = useRef(null);

  // Nerd Info Modal State
  const [nerdModalTorrentId, setNerdModalTorrentId] = useState(null);

  // Check URL on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const streamMagnet = params.get('streamMagnet');
    if (streamMagnet) {
      setActiveStream({
        magnet: streamMagnet,
        title: 'Streaming Torrent',
      });
    }
  }, []);

  // Poll all downloads every 1.5s
  useEffect(() => {
    const fetchDownloads = async () => {
      try {
        const res = await fetch('http://localhost:3001/api/torrents');
        if (res.ok) {
          const list = await res.json();
          setDownloads(list);
        }
      } catch (e) {}
    };

    fetchDownloads();
    const interval = setInterval(fetchDownloads, 1500);
    return () => clearInterval(interval);
  }, []);

  // Poll streaming status
  useEffect(() => {
    if (!activeStream) {
      setStreamStatus(null);
      setStreamError('');
      if (streamPollRef.current) clearInterval(streamPollRef.current);
      return;
    }

    const fetchStatus = async () => {
      try {
        const params = new URLSearchParams();
        if (activeStream.magnet) params.set('magnet', activeStream.magnet);
        if (activeStream.provider) params.set('provider', activeStream.provider);
        if (activeStream.desc) params.set('desc', activeStream.desc);
        if (activeStream.link) params.set('link', activeStream.link);

        const res = await fetch(`http://localhost:3001/api/torrent/status?${params.toString()}`);
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || 'Failed to fetch stream status');
        }
        const data = await res.json();
        setStreamStatus(data);
        if (data.magnet && !activeStream.magnet) {
          setActiveStream((prev) => (prev ? { ...prev, magnet: data.magnet } : null));
        }
      } catch (err) {
        setStreamError(err.message);
      }
    };

    fetchStatus();
    streamPollRef.current = setInterval(fetchStatus, 1200);
    return () => {
      if (streamPollRef.current) clearInterval(streamPollRef.current);
    };
  }, [activeStream]);



  const handleSearch = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    setError('');
    setResults([]);

    try {
      const response = await fetch(`http://localhost:3001/api/search?q=${encodeURIComponent(query)}`);
      if (!response.ok) throw new Error('Failed to fetch results');
      const data = await response.json();
      setResults(data);
    } catch (err) {
      setError('An error occurred while querying trackers. Please ensure backend is running.');
    } finally {
      setLoading(false);
    }
  };

  const getMagnetLink = async (torrent) => {
    if (torrent.magnet) return torrent.magnet;
    const params = new URLSearchParams({
      provider: torrent.provider,
      desc: torrent.desc || '',
      link: torrent.link || '',
    });
    const res = await fetch(`http://localhost:3001/api/magnet?${params}`);
    if (!res.ok) throw new Error('Failed to retrieve magnet link');
    const data = await res.json();
    return data.magnet;
  };

  // 1-Click Download direct to disk in Svorrent
  const handleDownloadToDisk = async (torrent, idx) => {
    setActionState((prev) => ({ ...prev, [idx]: { loading: true, status: 'Starting download...' } }));
    try {
      const res = await fetch('http://localhost:3001/api/torrent/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          magnet: torrent.magnet,
          provider: torrent.provider,
          desc: torrent.desc,
          link: torrent.link,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || 'Failed to start download');
      }
      const data = await res.json();
      setActionState((prev) => ({ ...prev, [idx]: { loading: false, status: '✓ Downloading to Disk' } }));
      setShowDownloadsDrawer(true);
      setTimeout(() => {
        setActionState((prev) => ({ ...prev, [idx]: null }));
      }, 3000);
    } catch (err) {
      setActionState((prev) => ({ ...prev, [idx]: { loading: false, status: 'Download failed' } }));
    }
  };

  const handleOpenCinemaTab = (torrent, idx) => {
    setActionState((prev) => ({ ...prev, [idx]: { loading: true, status: 'Opening Cinema tab...' } }));

    const playerUrl = new URL('/player', window.location.origin);
    if (torrent.magnet) {
      playerUrl.searchParams.set('magnet', torrent.magnet);
    } else {
      if (torrent.provider) playerUrl.searchParams.set('provider', torrent.provider);
      if (torrent.desc) playerUrl.searchParams.set('desc', torrent.desc);
      if (torrent.link) playerUrl.searchParams.set('link', torrent.link);
    }
    if (torrent.title) playerUrl.searchParams.set('title', torrent.title);

    window.open(playerUrl.toString(), '_blank');

    setActionState((prev) => ({ ...prev, [idx]: { loading: false, status: '✓ Opened Cinema Tab' } }));
    setTimeout(() => setActionState((prev) => ({ ...prev, [idx]: null })), 2500);
  };

  const handleOpenMagnet = async (torrent, idx) => {
    setActionState((prev) => ({ ...prev, [idx]: { loading: true, status: 'Resolving...' } }));
    try {
      const magnet = await getMagnetLink(torrent);
      torrent.magnet = magnet;
      window.location.href = magnet;
      setActionState((prev) => ({ ...prev, [idx]: { loading: false, status: '✓ Opened Client' } }));
      setTimeout(() => setActionState((prev) => ({ ...prev, [idx]: null })), 3000);
    } catch (err) {
      setActionState((prev) => ({ ...prev, [idx]: { loading: false, status: 'Error' } }));
    }
  };

  const handleCopyMagnet = async (torrent, idx) => {
    setActionState((prev) => ({ ...prev, [idx]: { loading: true, status: 'Copying...' } }));
    try {
      const magnet = await getMagnetLink(torrent);
      torrent.magnet = magnet;
      await navigator.clipboard.writeText(magnet);
      setActionState((prev) => ({ ...prev, [idx]: { loading: false, status: '✓ Copied' } }));
      setTimeout(() => setActionState((prev) => ({ ...prev, [idx]: null })), 2500);
    } catch (err) {
      setActionState((prev) => ({ ...prev, [idx]: { loading: false, status: 'Failed' } }));
    }
  };

  const handlePauseResume = async (infoHash, isPaused) => {
    const endpoint = isPaused ? 'resume' : 'pause';
    // Optimistic UI update so the pause/resume button responds instantly
    setDownloads((prev) =>
      prev.map((t) => (t.infoHash === infoHash ? { ...t, paused: !isPaused } : t))
    );
    try {
      await fetch(`http://localhost:3001/api/torrent/${infoHash}/${endpoint}`, { method: 'POST' });
    } catch (e) {}
  };

  const handleDeleteTorrent = async (infoHash) => {
    if (confirm('Stop and remove this torrent from Svorrent?')) {
      await fetch(`http://localhost:3001/api/torrent/${infoHash}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteFiles: false }),
      });
      setDownloads((prev) => prev.filter((t) => t.infoHash !== infoHash));
      if (nerdModalTorrentId === infoHash) setNerdModalTorrentId(null);
    }
  };

  const handleOpenFinder = async (infoHash) => {
    await fetch(`http://localhost:3001/api/torrent/${infoHash}/open-finder`, { method: 'POST' });
  };

  const handlePlayNative = async (infoHash) => {
    await fetch(`http://localhost:3001/api/torrent/${infoHash}/play-native`, { method: 'POST' });
  };

  const totalSpeed = downloads.reduce((acc, t) => acc + (t.downloadSpeed || 0), 0);
  const activeCount = downloads.filter((t) => !t.done && !t.paused).length;

  return (
    <div className="container">
      {/* Top Navigation / Downloads Bar */}
      <nav className="top-nav">
        <div className="nav-brand">
          <span className="brand-dot"></span> Svorrent
        </div>
        <button
          className={`downloads-toggle-btn ${downloads.length > 0 ? 'active' : ''}`}
          onClick={() => setShowDownloadsDrawer(!showDownloadsDrawer)}
        >
          <span>⬇ Downloads ({downloads.length})</span>
          {totalSpeed > 0 && <span className="speed-badge">⚡ {formatBytes(totalSpeed)}/s</span>}
        </button>
      </nav>

      {/* Main Header */}
      <header>
        <h1>Svorrent</h1>
      </header>

      {/* Search Input */}
      <form className="search-box" onSubmit={handleSearch}>
        <input
          type="text"
          className="search-input"
          placeholder="Search movies, TV shows, software, Linux distros..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={loading}
          autoFocus
        />
        <button type="submit" className="search-btn" disabled={loading || !query.trim()}>
          {loading ? 'Searching...' : 'Search'}
        </button>
      </form>

      {error && <div className="error-banner">{error}</div>}

      {/* Active Downloads Drawer / Panel */}
      {showDownloadsDrawer && (
        <div className="downloads-panel">
          <div className="panel-header">
            <div className="panel-title">
              <h3>Active Downloads on Mac</h3>
              <span className="folder-hint">📁 Saved to ~/Downloads/Svorrent</span>
            </div>
            <button className="panel-close" onClick={() => setShowDownloadsDrawer(false)}>✕</button>
          </div>

          {downloads.length === 0 ? (
            <div className="empty-panel">
              <p>No active downloads in Svorrent.</p>
              <p className="dim-text">Search for any torrent above and click <strong>⬇ Download</strong> to save directly to disk.</p>
            </div>
          ) : (
            <div className="downloads-list">
              {downloads.map((t) => {
                const pct = Math.round((t.progress || 0) * 100);
                return (
                  <div className="download-item-card" key={t.infoHash}>
                    <div className="download-item-top">
                      <div className="download-item-info">
                        <span className="download-item-title" title={t.name}>{t.name}</span>
                        <div className="download-item-meta">
                          <span>{formatBytes(t.downloaded)} / {formatBytes(t.length)} ({pct}%)</span>
                          <span>⚡ {formatBytes(t.downloadSpeed)}/s</span>
                          <span>● {t.numPeers} peers</span>
                          <span>ETA: {formatTime(t.timeRemaining)}</span>
                        </div>
                      </div>

                      <div className="download-item-actions">
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => {
                            const playerUrl = `/player?magnet=${encodeURIComponent(t.magnet)}&title=${encodeURIComponent(t.name)}`;
                            window.open(playerUrl, '_blank');
                          }}
                          title="Stream 100% lossless remux in dedicated separate tab"
                        >
                          ⚡ Stream
                        </button>

                        <button
                          className="btn btn-nerd"
                          onClick={() => setNerdModalTorrentId(t.infoHash)}
                          title="Open deep packet, peer, bitfield and tracker inspector"
                        >
                          🔍 Nerd Info
                        </button>

                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => handleOpenFinder(t.infoHash)}
                          title="Reveal folder in macOS Finder"
                        >
                          📂 Finder
                        </button>

                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => handlePlayNative(t.infoHash)}
                          title="Open with default macOS player (IINA, VLC, QuickTime) with 100% native quality"
                        >
                          ▶ Open
                        </button>

                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => handlePauseResume(t.infoHash, t.paused)}
                        >
                          {t.paused ? '▶ Resume' : '⏸ Pause'}
                        </button>

                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => handleDeleteTorrent(t.infoHash)}
                          title="Remove torrent"
                        >
                          ✕
                        </button>
                      </div>
                    </div>

                    <div className="progress-bar-bg">
                      <div
                        className={`progress-bar-fill ${t.done ? 'fill-done' : t.paused ? 'fill-paused' : ''}`}
                        style={{ width: `${pct}%` }}
                      ></div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Search Results */}
      <div className="results-container">
        {loading && (
          <div className="loader">
            <div className="spinner"></div>
            <span>Aggregating trackers (The Pirate Bay, LimeTorrents, TorrentProject)...</span>
          </div>
        )}

        {!loading && results.length > 0 && (
          <div className="results-header">
            <span>Found <strong>{results.length}</strong> torrents</span>
            <span className="results-tip">
              Click <strong>⬇ Download</strong> to save natively, or <strong>⚡ Stream</strong> to preview
            </span>
          </div>
        )}

        {!loading && results.length > 0 && results.map((torrent, idx) => {
          const state = actionState[idx];

          return (
            <div className="result-card" key={idx}>
              <div className="result-info">
                <div className="result-title" title={torrent.title}>{torrent.title}</div>
                <div className="result-meta">
                  <span className="meta-tag size-tag">{torrent.size || 'Unknown Size'}</span>
                  <span className="meta-tag seeds-tag" title="Seeders">
                    ▲ {torrent.seeds ?? 0} seeds
                  </span>
                  <span className="meta-tag peers-tag" title="Peers">
                    ▼ {torrent.peers ?? 0} peers
                  </span>
                  <span className="meta-tag provider-tag">{torrent.provider}</span>
                </div>
              </div>

              <div className="result-actions">
                {state && state.status ? (
                  <span className="action-feedback">{state.status}</span>
                ) : null}

                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => handleDownloadToDisk(torrent, idx)}
                  disabled={state?.loading}
                  title="Download in full 100% native quality directly to ~/Downloads/Svorrent"
                >
                  ⬇ Download
                </button>

                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => handleOpenCinemaTab(torrent, idx)}
                  disabled={state?.loading}
                  title="Stream 100% lossless remux in dedicated separate tab"
                >
                  ⚡ Stream
                </button>

                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => handleOpenMagnet(torrent, idx)}
                  disabled={state?.loading}
                  title="Open magnet in desktop client"
                >
                  🧲 Magnet
                </button>

                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => handleCopyMagnet(torrent, idx)}
                  disabled={state?.loading}
                  title="Copy Magnet link"
                >
                  📋 Copy
                </button>

                {torrent.link && (
                  <a
                    href={torrent.link}
                    className="btn btn-ghost"
                    download
                    target="_blank"
                    rel="noreferrer"
                    title="Download raw .torrent file"
                  >
                    .torrent
                  </a>
                )}
              </div>
            </div>
          );
        })}

        {!loading && query && results.length === 0 && !error && (
          <div className="empty-state">
            <h3>No results found</h3>
            <p>Try searching for a broader term or different keywords.</p>
          </div>
        )}
      </div>

      {/* =========================================================================
         DEEP NERD INFO INSPECTOR MODAL
         ========================================================================= */}
      {nerdModalTorrentId && (
        <NerdModal
          torrentId={nerdModalTorrentId}
          onClose={() => setNerdModalTorrentId(null)}
        />
      )}

      {/* =========================================================================
         STREAMING PREVIEW MODAL
         ========================================================================= */}
      {activeStream && (
        <div className="stream-overlay" onClick={(e) => e.target.classList.contains('stream-overlay') && setActiveStream(null)}>
          <div className="stream-modal">
            <div className="stream-modal-header">
              <div className="stream-modal-title-box">
                <span className={`status-pill ${streamStatus?.ready ? 'status-ready' : streamStatus?.numPeers > 0 ? 'status-connected' : 'status-searching'}`}>
                  {streamStatus?.ready ? 'Streaming Active' : streamStatus?.numPeers > 0 ? `Connecting (${streamStatus.numPeers} peers)` : 'Searching Swarm...'}
                </span>
                <h3 className="stream-modal-title">{streamStatus?.fileName || activeStream.title}</h3>
              </div>
              <button className="stream-modal-close" onClick={() => setActiveStream(null)}>✕</button>
            </div>

            {streamError ? (
              <div className="stream-error-box">
                <p>{streamError}</p>
              </div>
            ) : (
              <div className="stream-modal-body">
                <div className="progress-section">
                  <div className="progress-header">
                    <span>Buffering Swarm Pieces</span>
                    <span className="progress-value">{Math.round((streamStatus?.progress || 0) * 100)}%</span>
                  </div>
                  <div className="progress-bar-bg">
                    <div className="progress-bar-fill" style={{ width: `${Math.max(Math.round((streamStatus?.progress || 0) * 100), 5)}%` }}></div>
                  </div>
                </div>

                <div className="stats-grid">
                  <div className="stat-card">
                    <span className="stat-label">Peers</span>
                    <span className="stat-value peers-val">● {streamStatus?.numPeers ?? 0}</span>
                  </div>
                  <div className="stat-card">
                    <span className="stat-label">Speed</span>
                    <span className="stat-value speed-val">⚡ {formatBytes(streamStatus?.downloadSpeed || 0)}/s</span>
                  </div>
                  <div className="stat-card">
                    <span className="stat-label">Downloaded</span>
                    <span className="stat-value">{formatBytes(streamStatus?.downloaded || 0)} / {formatBytes(streamStatus?.length || 0)}</span>
                  </div>
                  <div className="stat-card">
                    <span className="stat-label">Status</span>
                    <span className="stat-value status-val">{streamStatus?.ready ? 'Ready to play' : 'Connecting...'}</span>
                  </div>
                </div>

                <div className="player-viewport">
                  {streamStatus?.ready ? (
                    <video key={streamStatus.streamUrl} controls autoPlay playsInline className="stream-video" src={streamStatus.streamUrl}>
                      Your browser does not support HTML5 video streaming.
                    </video>
                  ) : (
                    <div className="buffering-placeholder">
                      <div className="radar-pulse"></div>
                      <h4>Connecting to BitTorrent Swarm</h4>
                      <p>Found {streamStatus?.numPeers || 0} peers. Buffering initial sequential pieces...</p>
                    </div>
                  )}
                </div>

                <div className="stream-modal-footer">
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      if (activeStream.magnet) {
                        handleDownloadToDisk({ magnet: activeStream.magnet }, 0);
                        setActiveStream(null);
                      }
                    }}
                  >
                    ⬇ Download Full File to Disk
                  </button>
                  {streamStatus?.infoHash && (
                    <button
                      className="btn btn-nerd"
                      onClick={() => {
                        setNerdModalTorrentId(streamStatus.infoHash);
                        setActiveStream(null);
                      }}
                    >
                      🔍 Inspect Nerd Stats
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
