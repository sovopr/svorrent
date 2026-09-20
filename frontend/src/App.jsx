import React, { useState } from 'react';
import './index.css';

function App() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [actionState, setActionState] = useState({}); // { [idx]: { loading: boolean, status: string } }
  const [activeTab, setActiveTab] = useState('all');

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
      // Update torrent item with magnet so subsequent clicks are instant
      torrent.magnet = magnet;
      
      // Trigger native client (qBittorrent, Transmission, BitTorrent Web, etc.)
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

  const handleDirectStream = (torrent) => {
    const params = new URLSearchParams();
    if (torrent.magnet) {
      params.append('magnet', torrent.magnet);
    } else {
      params.append('provider', torrent.provider);
      if (torrent.desc) params.append('desc', torrent.desc);
      if (torrent.link) params.append('link', torrent.link);
    }
    window.open(`http://localhost:3001/api/stream?${params.toString()}`, '_blank');
  };

  return (
    <div className="container">
      <header>
        <div className="logo-badge">Svorrent</div>
        <h1>Torrent Discovery & 1-Click Launch</h1>
        <p className="subtitle">Instant aggregator across top trackers with native client launch and proxy streaming.</p>
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
            <span className="results-tip">Tip: Click <strong>Magnet</strong> to open in your torrent client</span>
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

                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => handleDirectStream(torrent)}
                  title="Direct stream / download via server proxy"
                >
                  ⚡ Stream
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
    </div>
  );
}

export default App;
