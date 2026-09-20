import React, { useState, useEffect, useRef } from 'react';
import { CinemaPlayer } from './CinemaPlayer';
import { DownloadsManager } from './DownloadsManager';
import './index.css';

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function App() {
  const isPlayerRoute =
    window.location.pathname === '/player' ||
    window.location.pathname.endsWith('/player') ||
    new URLSearchParams(window.location.search).has('player');

  if (isPlayerRoute) {
    return <CinemaPlayer />;
  }

  const isDownloadsRoute =
    window.location.pathname === '/downloads' ||
    window.location.pathname.endsWith('/downloads') ||
    new URLSearchParams(window.location.search).has('downloads');

  if (isDownloadsRoute) {
    return <DownloadsManager />;
  }

  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [error, setError] = useState('');
  const [actionState, setActionState] = useState({});

  const activeQueryRef = useRef('');
  const debounceTimerRef = useRef(null);

  // Downloads telemetry for top-nav indicator
  const [downloads, setDownloads] = useState([]);

  // Poll all downloads every 1.5s to keep top navbar badge and speed updated
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

  const executeSearch = async (searchTerm) => {
    const term = (searchTerm ?? query).trim();
    if (!term) {
      setResults([]);
      setHasSearched(false);
      setLoading(false);
      return;
    }

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    activeQueryRef.current = term;
    setLoading(true);
    setError('');
    setHasSearched(true);

    try {
      const response = await fetch(`http://localhost:3001/api/search?q=${encodeURIComponent(term)}`);
      if (!response.ok) throw new Error('Failed to fetch results');
      const data = await response.json();
      if (activeQueryRef.current === term) {
        setResults(data);
      }
    } catch (err) {
      if (activeQueryRef.current === term) {
        setError('An error occurred while querying trackers. Please ensure backend is running.');
      }
    } finally {
      if (activeQueryRef.current === term) {
        setLoading(false);
      }
    }
  };

  // Debounced auto-search as you type (triggers after 450ms pause if query >= 2 characters)
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setHasSearched(false);
      setLoading(false);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      return;
    }

    if (trimmed.length < 2) {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      return;
    }

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      executeSearch(trimmed);
    }, 450);

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [query]);

  const handleSearch = (e) => {
    if (e) e.preventDefault();
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    executeSearch(query);
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
      setActionState((prev) => ({ ...prev, [idx]: { loading: false, status: '✓ Downloading to ~/Downloads/Svorrent' } }));
      setTimeout(() => {
        setActionState((prev) => ({ ...prev, [idx]: null }));
      }, 3500);
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

  const permanentDownloads = downloads.filter((t) => t.isPermanentDownload || !t.isStreamOnly);
  const totalSpeed = permanentDownloads.reduce((acc, t) => acc + (t.downloadSpeed || 0), 0);

  return (
    <div className="container">
      {/* Top Navigation Bar */}
      <nav className="top-nav">
        <div className="nav-brand">
          <span className="brand-dot"></span> Svorrent
        </div>
        <div className="nav-actions">
          <button
            className={`downloads-toggle-btn ${permanentDownloads.length > 0 ? 'active' : ''}`}
            onClick={() => window.open('/downloads', '_blank')}
            title="Open Downloads in a dedicated separate tab"
          >
            <span>⬇ Downloads ({permanentDownloads.length})</span>
            {totalSpeed > 0 && <span className="speed-badge">⚡ {formatBytes(totalSpeed)}/s</span>}
          </button>
        </div>
      </nav>

      {/* Main Header */}
      <header>
        <h1>Svorrent</h1>
      </header>

      {/* Search Input */}
      <form className="search-box" onSubmit={handleSearch}>
        <div className="search-input-wrapper">
          <input
            type="text"
            className="search-input"
            placeholder="Search movies, TV shows, software, Linux distros..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          {query && (
            <button
              type="button"
              className="search-clear-btn"
              onClick={() => {
                setQuery('');
                setResults([]);
                setHasSearched(false);
              }}
              title="Clear search"
            >
              ✕
            </button>
          )}
        </div>
        <button type="submit" className="search-btn" disabled={loading || !query.trim()}>
          {loading ? 'Searching...' : 'Search'}
        </button>
      </form>

      {error && <div className="error-banner">{error}</div>}

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
                  {(() => {
                    const sizeStr = (torrent.size || '').toLowerCase();
                    const isHeavy = sizeStr.includes('gb') && parseFloat(sizeStr) >= 15;
                    const isFast = (sizeStr.includes('gb') && parseFloat(sizeStr) <= 3.5) || sizeStr.includes('mb');
                    if (isFast) {
                      return <span className="meta-tag" style={{ background: 'rgba(16, 185, 129, 0.15)', color: '#34d399', border: '1px solid rgba(16, 185, 129, 0.3)' }}>⚡ Instant Stream</span>;
                    }
                    if (isHeavy) {
                      return <span className="meta-tag" style={{ background: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa', border: '1px solid rgba(59, 130, 246, 0.3)' }}>💎 BluRay Transcode Ready</span>;
                    }
                    return null;
                  })()}
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

        {!loading && hasSearched && results.length === 0 && !error && query.trim() && (
          <div className="empty-state">
            <h3>No results found for "{query.trim()}"</h3>
            <p>Try searching for a broader term or different keywords.</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
