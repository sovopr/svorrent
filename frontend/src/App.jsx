import React, { useState, useEffect, useRef } from 'react';
import './index.css';

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function App() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [actionState, setActionState] = useState({});

  // Active streaming state
  const [activeStream, setActiveStream] = useState(null); // { magnet, title, provider, desc, link }
  const [streamStatus, setStreamStatus] = useState(null);
  const [streamError, setStreamError] = useState('');
  const pollTimerRef = useRef(null);

  // Check on load if URL has ?streamMagnet=...
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

  // Poll status when activeStream changes
  useEffect(() => {
    if (!activeStream) {
      setStreamStatus(null);
      setStreamError('');
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
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
          throw new Error(errData.error || 'Failed to fetch swarm status');
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
    pollTimerRef.current = setInterval(fetchStatus, 1200);

    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
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
      setError('An error occurred while querying trackers. Please ensure the backend is running.');
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
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to retrieve magnet link');
    }
    const data = await res.json();
    return data.magnet;
  };

  const handleOpenMagnet = async (torrent, idx) => {
    setActionState((prev) => ({ ...prev, [idx]: { loading: true, status: 'Resolving...' } }));
    try {
      const magnet = await getMagnetLink(torrent);
      torrent.magnet = magnet;
      window.location.href = magnet;
      setActionState((prev) => ({ ...prev, [idx]: { loading: false, status: '✓ Opened Client' } }));
      setTimeout(() => {
        setActionState((prev) => ({ ...prev, [idx]: null }));
      }, 3000);
    } catch (err) {
      setActionState((prev) => ({ ...prev, [idx]: { loading: false, status: 'Error fetching magnet' } }));
    }
  };

  const handleCopyMagnet = async (torrent, idx) => {
    setActionState((prev) => ({ ...prev, [idx]: { loading: true, status: 'Copying...' } }));
    try {
      const magnet = await getMagnetLink(torrent);
      torrent.magnet = magnet;
      await navigator.clipboard.writeText(magnet);
      setActionState((prev) => ({ ...prev, [idx]: { loading: false, status: '✓ Copied Magnet' } }));
      setTimeout(() => {
        setActionState((prev) => ({ ...prev, [idx]: null }));
      }, 2500);
    } catch (err) {
      setActionState((prev) => ({ ...prev, [idx]: { loading: false, status: 'Failed to copy' } }));
    }
  };

  const handleStartStream = (torrent) => {
    setActiveStream({
      title: torrent.title,
      magnet: torrent.magnet || null,
      provider: torrent.provider,
      desc: torrent.desc,
      link: torrent.link,
    });
  };

  const closeStreamModal = () => {
    setActiveStream(null);
    setStreamStatus(null);
    setStreamError('');
    // Clear URL search params if opened via link
    if (window.location.search) {
      window.history.replaceState({}, '', window.location.pathname);
    }
  };

  const isVideoFile = (filename) => {
    if (!filename) return false;
    const lower = filename.toLowerCase();
    return (
      lower.endsWith('.mp4') ||
      lower.endsWith('.mkv') ||
      lower.endsWith('.webm') ||
      lower.endsWith('.mov') ||
      lower.endsWith('.avi') ||
      lower.endsWith('.mp3')
    );
  };

  const progressPercent = streamStatus ? Math.round((streamStatus.progress || 0) * 100) : 0;

  return (
    <div className="container">
      <header>
        <h1>Svorrent</h1>
      </header>

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
            <span className="results-tip">Tip: Click <strong>⚡ Stream</strong> to preview in browser</span>
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
                  onClick={() => handleStartStream(torrent)}
                  title="Stream or preview file with live progress loader"
                >
                  ⚡ Stream
                </button>

                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => handleOpenMagnet(torrent, idx)}
                  disabled={state?.loading}
                  title="Open directly in Transmission, qBittorrent, BitTorrent Web"
                >
                  🧲 Magnet
                </button>

                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => handleCopyMagnet(torrent, idx)}
                  disabled={state?.loading}
                  title="Copy Magnet link to clipboard"
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

      {/* Streaming & Progress Modal */}
      {activeStream && (
        <div className="stream-overlay" onClick={(e) => e.target.classList.contains('stream-overlay') && closeStreamModal()}>
          <div className="stream-modal">
            <div className="stream-modal-header">
              <div className="stream-modal-title-box">
                <span className={`status-pill ${streamStatus?.ready ? 'status-ready' : streamStatus?.numPeers > 0 ? 'status-connected' : 'status-searching'}`}>
                  {streamStatus?.ready
                    ? 'Streaming Active'
                    : streamStatus?.numPeers > 0
                    ? `Connecting (${streamStatus.numPeers} peers)`
                    : 'Searching Swarm...'}
                </span>
                <h3 className="stream-modal-title" title={streamStatus?.fileName || activeStream.title}>
                  {streamStatus?.fileName || activeStream.title}
                </h3>
              </div>
              <button className="stream-modal-close" onClick={closeStreamModal} title="Close player">✕</button>
            </div>

            {streamError ? (
              <div className="stream-error-box">
                <p>{streamError}</p>
                <div className="stream-error-actions">
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      if (activeStream.magnet) window.location.href = activeStream.magnet;
                    }}
                  >
                    🧲 Open in Desktop Client
                  </button>
                </div>
              </div>
            ) : (
              <div className="stream-modal-body">
                {/* Progress Bar */}
                <div className="progress-section">
                  <div className="progress-header">
                    <span className="progress-label">
                      {streamStatus?.ready ? 'Swarm Download & Cache' : 'Buffering Swarm Chunks'}
                    </span>
                    <span className="progress-value">{progressPercent}%</span>
                  </div>
                  <div className="progress-bar-bg">
                    <div
                      className="progress-bar-fill"
                      style={{ width: `${Math.max(progressPercent, streamStatus?.ready ? 10 : streamStatus?.numPeers > 0 ? 5 : 2)}%` }}
                    ></div>
                  </div>
                </div>

                {/* Real-time stats grid */}
                <div className="stats-grid">
                  <div className="stat-card">
                    <span className="stat-label">Peers</span>
                    <span className="stat-value peers-val">● {streamStatus?.numPeers ?? 0}</span>
                  </div>
                  <div className="stat-card">
                    <span className="stat-label">Speed</span>
                    <span className="stat-value speed-val">
                      ⚡ {streamStatus?.downloadSpeed ? `${formatBytes(streamStatus.downloadSpeed)}/s` : '0 KB/s'}
                    </span>
                  </div>
                  <div className="stat-card">
                    <span className="stat-label">Downloaded</span>
                    <span className="stat-value">
                      {formatBytes(streamStatus?.downloaded || 0)} / {formatBytes(streamStatus?.length || 0)}
                    </span>
                  </div>
                  <div className="stat-card">
                    <span className="stat-label">Status</span>
                    <span className="stat-value status-val">
                      {streamStatus?.ready ? 'Ready to play' : streamStatus?.numPeers > 0 ? 'Downloading...' : 'Contacting trackers'}
                    </span>
                  </div>
                </div>

                {/* Video Player or File Download View */}
                <div className="player-viewport">
                  {streamStatus?.ready ? (
                    isVideoFile(streamStatus.fileName) ? (
                      <div className="video-container">
                        <video
                          key={streamStatus.streamUrl}
                          controls
                          autoPlay
                          playsInline
                          className="stream-video"
                          src={streamStatus.streamUrl}
                        >
                          Your browser does not support HTML5 video streaming.
                        </video>
                      </div>
                    ) : (
                      <div className="file-ready-box">
                        <div className="file-icon">📦</div>
                        <div className="file-info">
                          <h4>{streamStatus.fileName}</h4>
                          <p>{formatBytes(streamStatus.length)}</p>
                        </div>
                        <a
                          href={streamStatus.streamUrl}
                          className="btn btn-primary btn-large"
                          download
                        >
                          💾 Save File to Disk
                        </a>
                      </div>
                    )
                  ) : (
                    <div className="buffering-placeholder">
                      <div className="radar-pulse"></div>
                      <h4>Connecting to BitTorrent Swarm</h4>
                      <p>
                        {streamStatus?.numPeers > 0
                          ? `Found ${streamStatus.numPeers} active peers. Retrieving metadata and piece fragments...`
                          : 'Announcing to public DHT and tracker nodes. Initial connection takes 5-20 seconds...'}
                      </p>
                    </div>
                  )}
                </div>

                {/* Modal Footer Controls */}
                <div className="stream-modal-footer">
                  <div className="stream-footer-left">
                    {activeStream.magnet && (
                      <button
                        className="btn btn-secondary"
                        onClick={() => {
                          window.location.href = activeStream.magnet;
                        }}
                      >
                        🧲 Open in Client
                      </button>
                    )}
                    {activeStream.magnet && (
                      <button
                        className="btn btn-secondary"
                        onClick={async () => {
                          await navigator.clipboard.writeText(activeStream.magnet);
                          alert('Magnet link copied!');
                        }}
                      >
                        📋 Copy Magnet
                      </button>
                    )}
                  </div>

                  {streamStatus?.streamUrl && (
                    <a
                      href={streamStatus.streamUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="btn btn-outline"
                    >
                      🔗 Open Direct Stream Tab
                    </a>
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
