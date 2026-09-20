import React, { useState, useEffect, useRef } from 'react';
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
  const [nerdStats, setNerdStats] = useState(null);
  const [activeNerdTab, setActiveNerdTab] = useState('peers'); // 'peers' | 'pieces' | 'trackers' | 'files'
  const nerdPollRef = useRef(null);

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

  // Poll Nerd Stats
  useEffect(() => {
    if (!nerdModalTorrentId) {
      setNerdStats(null);
      if (nerdPollRef.current) clearInterval(nerdPollRef.current);
      return;
    }

    const fetchNerd = async () => {
      try {
        const res = await fetch(`http://localhost:3001/api/torrent/${nerdModalTorrentId}/nerd-stats`);
        if (res.ok) {
          const data = await res.json();
          setNerdStats(data);
        }
      } catch (e) {}
    };

    fetchNerd();
    nerdPollRef.current = setInterval(fetchNerd, 1000);
    return () => {
      if (nerdPollRef.current) clearInterval(nerdPollRef.current);
    };
  }, [nerdModalTorrentId]);

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
    await fetch(`http://localhost:3001/api/torrent/${infoHash}/${endpoint}`, { method: 'POST' });
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
                  onClick={() => setActiveStream({
                    title: torrent.title,
                    magnet: torrent.magnet || null,
                    provider: torrent.provider,
                    desc: torrent.desc,
                    link: torrent.link,
                  })}
                  title="Stream preview with progress loader"
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
      {nerdModalTorrentId && nerdStats && (
        <div className="stream-overlay" onClick={(e) => e.target.classList.contains('stream-overlay') && setNerdModalTorrentId(null)}>
          <div className="nerd-modal">
            <div className="nerd-modal-header">
              <div className="nerd-header-title-box">
                <span className="nerd-badge">⚡ NERD INSPECTOR</span>
                <h3>{nerdStats.name}</h3>
              </div>
              <button className="stream-modal-close" onClick={() => setNerdModalTorrentId(null)}>✕</button>
            </div>

            {/* Quick telemetry summary */}
            <div className="nerd-telemetry-bar">
              <div className="tele-item">
                <span className="tele-label">Progress</span>
                <span className="tele-val">{Math.round((nerdStats.progress || 0) * 100)}%</span>
              </div>
              <div className="tele-item">
                <span className="tele-label">Download Speed</span>
                <span className="tele-val speed-val">⚡ {formatBytes(nerdStats.downloadSpeed)}/s</span>
              </div>
              <div className="tele-item">
                <span className="tele-label">Upload Speed</span>
                <span className="tele-val">▲ {formatBytes(nerdStats.uploadSpeed)}/s</span>
              </div>
              <div className="tele-item">
                <span className="tele-label">Swarm Peers</span>
                <span className="tele-val peers-val">● {nerdStats.numPeers} connected</span>
              </div>
              <div className="tele-item">
                <span className="tele-label">DHT Network</span>
                <span className="tele-val">🌐 {nerdStats.dhtNodes} nodes</span>
              </div>
            </div>

            {/* Tabs Bar */}
            <div className="nerd-tabs-nav">
              <button
                className={`nerd-tab-btn ${activeNerdTab === 'peers' ? 'active' : ''}`}
                onClick={() => setActiveNerdTab('peers')}
              >
                👥 Connected Peers ({nerdStats.peers.length})
              </button>
              <button
                className={`nerd-tab-btn ${activeNerdTab === 'pieces' ? 'active' : ''}`}
                onClick={() => setActiveNerdTab('pieces')}
              >
                🧩 Piece Map ({nerdStats.pieces.verified} / {nerdStats.pieces.total})
              </button>
              <button
                className={`nerd-tab-btn ${activeNerdTab === 'trackers' ? 'active' : ''}`}
                onClick={() => setActiveNerdTab('trackers')}
              >
                📡 Trackers & DHT ({nerdStats.trackers.length})
              </button>
              <button
                className={`nerd-tab-btn ${activeNerdTab === 'files' ? 'active' : ''}`}
                onClick={() => setActiveNerdTab('files')}
              >
                📁 Files ({nerdStats.files.length})
              </button>
            </div>

            <div className="nerd-modal-content">
              {/* TAB 1: PEERS TABLE */}
              {activeNerdTab === 'peers' && (
                <div className="nerd-tab-pane">
                  {nerdStats.peers.length === 0 ? (
                    <div className="nerd-empty">
                      <p>Searching for peers in the swarm...</p>
                    </div>
                  ) : (
                    <div className="table-responsive">
                      <table className="nerd-table">
                        <thead>
                          <tr>
                            <th>IP Address & Port</th>
                            <th>Client / Version</th>
                            <th>Type</th>
                            <th>Down Speed</th>
                            <th>Up Speed</th>
                            <th>Downloaded</th>
                            <th>Peer %</th>
                            <th>Flags</th>
                          </tr>
                        </thead>
                        <tbody>
                          {nerdStats.peers.map((p, pIdx) => (
                            <tr key={pIdx}>
                              <td className="mono">{p.ip}:{p.port}</td>
                              <td className="client-name">{p.client}</td>
                              <td><span className="badge-type">{p.type}</span></td>
                              <td className="speed-val">{formatBytes(p.downloadSpeed)}/s</td>
                              <td>{formatBytes(p.uploadSpeed)}/s</td>
                              <td>{formatBytes(p.downloaded)}</td>
                              <td>{p.progress}%</td>
                              <td>
                                <span className="flag-tag" title={p.choked ? 'Peer is choking us' : 'Peer unchoked'}>
                                  {p.choked ? 'C' : 'U'}
                                </span>
                                <span className="flag-tag" title={p.interested ? 'Peer is interested' : 'Not interested'}>
                                  {p.interested ? 'I' : '-'}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* TAB 2: PIECE MAP (VISUAL BITFIELD) */}
              {activeNerdTab === 'pieces' && (
                <div className="nerd-tab-pane">
                  <div className="piece-meta-row">
                    <div>
                      <strong>Total Pieces:</strong> {nerdStats.pieces.total.toLocaleString()} pieces
                    </div>
                    <div>
                      <strong>Piece Size:</strong> {formatBytes(nerdStats.pieces.pieceLength)}
                    </div>
                    <div>
                      <strong>Verified Pieces:</strong> {nerdStats.pieces.verified.toLocaleString()} (
                      {nerdStats.pieces.total > 0
                        ? Math.round((nerdStats.pieces.verified / nerdStats.pieces.total) * 100)
                        : 0}
                      %)
                    </div>
                  </div>

                  <div className="piece-legend">
                    <span className="legend-item"><span className="legend-box box-done"></span> Verified SHA-1</span>
                    <span className="legend-item"><span className="legend-box box-downloading"></span> In-Flight / Buffering</span>
                    <span className="legend-item"><span className="legend-box box-missing"></span> Missing</span>
                  </div>

                  {nerdStats.pieces.grid.length === 0 ? (
                    <div className="nerd-empty">
                      <p>Waiting for torrent metadata to generate piece map...</p>
                    </div>
                  ) : (
                    <div className="piece-grid">
                      {nerdStats.pieces.grid.map((statusVal, gIdx) => (
                        <div
                          key={gIdx}
                          className={`piece-block ${statusVal === 2 ? 'piece-done' : statusVal === 1 ? 'piece-active' : 'piece-missing'}`}
                          title={`Piece group #${gIdx}: ${statusVal === 2 ? 'Verified' : statusVal === 1 ? 'Downloading' : 'Missing'}`}
                        ></div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* TAB 3: TRACKERS & DHT */}
              {activeNerdTab === 'trackers' && (
                <div className="nerd-tab-pane">
                  <div className="dht-summary-card">
                    <div className="dht-icon">🌐</div>
                    <div>
                      <h4>Distributed Hash Table (Mainline DHT)</h4>
                      <p>
                        Connected to <strong>{nerdStats.dhtNodes}</strong> active DHT routing nodes across the global decentralized network.
                      </p>
                    </div>
                  </div>

                  <h4 style={{ margin: '1.25rem 0 0.5rem', color: '#fff' }}>Announce Trackers</h4>
                  <div className="table-responsive">
                    <table className="nerd-table">
                      <thead>
                        <tr>
                          <th>Tracker Announce URL</th>
                          <th>Status</th>
                          <th>Active Seeds</th>
                          <th>Active Peers</th>
                        </tr>
                      </thead>
                      <tbody>
                        {nerdStats.trackers.map((tr, trIdx) => (
                          <tr key={trIdx}>
                            <td className="mono" title={tr.url}>{tr.url}</td>
                            <td><span className="badge-success">{tr.status}</span></td>
                            <td className="seeds-val">▲ {tr.seeds}</td>
                            <td>▼ {tr.peers}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* TAB 4: FILES */}
              {activeNerdTab === 'files' && (
                <div className="nerd-tab-pane">
                  <div className="table-responsive">
                    <table className="nerd-table">
                      <thead>
                        <tr>
                          <th>File Name</th>
                          <th>Size</th>
                          <th>Downloaded</th>
                          <th>Progress</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {nerdStats.files.map((f, fIdx) => (
                          <tr key={fIdx}>
                            <td className="mono" title={f.name}>{f.name}</td>
                            <td>{formatBytes(f.length)}</td>
                            <td>{formatBytes(f.downloaded)}</td>
                            <td>{Math.round((f.progress || 0) * 100)}%</td>
                            <td>
                              <button
                                className="btn btn-secondary btn-xs"
                                onClick={() => handleOpenFinder(nerdModalTorrentId)}
                              >
                                📂 Show
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            <div className="nerd-modal-footer">
              <button
                className="btn btn-secondary"
                onClick={() => handleOpenFinder(nerdModalTorrentId)}
              >
                📂 Reveal in Finder
              </button>
              <button
                className="btn btn-primary"
                onClick={() => handlePlayNative(nerdModalTorrentId)}
              >
                ▶ Open in Default Player (IINA / VLC)
              </button>
            </div>
          </div>
        </div>
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
