import React, { useState } from 'react';
import './index.css';

function App() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

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
      // Sort by seeders descending
      data.sort((a, b) => (b.seeds || 0) - (a.seeds || 0));
      setResults(data);
    } catch (err) {
      setError('An error occurred while searching. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container">
      <header>
        <h1>Svorrent</h1>
        <p className="subtitle">Minimalist 1-click torrent discovery.</p>
      </header>

      <form className="search-box" onSubmit={handleSearch}>
        <input
          type="text"
          className="search-input"
          placeholder="Search for movies, software, music..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={loading}
        />
        <button type="submit" className="search-btn" disabled={loading || !query.trim()}>
          {loading ? 'Searching...' : 'Search'}
        </button>
      </form>

      {error && <div style={{color: '#ef4444', textAlign: 'center'}}>{error}</div>}

      <div className="results">
        {loading && <div className="loader">Scraping indexers...</div>}
        
        {!loading && results.length > 0 && results.map((torrent, idx) => {
          let downloadUrl = '#';
          if (torrent.magnet) {
            downloadUrl = `http://localhost:3001/api/stream?magnet=${encodeURIComponent(torrent.magnet)}`;
          } else if (torrent.desc) {
            downloadUrl = `http://localhost:3001/api/stream?desc=${encodeURIComponent(torrent.desc)}`;
          }

          return (
            <div className="result-card" key={idx}>
              <div className="result-info">
                <div className="result-title" title={torrent.title}>{torrent.title}</div>
                <div className="result-meta">
                  <div className="meta-item">Size: <span>{torrent.size || 'Unknown'}</span></div>
                  <div className="meta-item">Seeders: <span style={{color: '#22c55e'}}>{torrent.seeds ?? 'N/A'}</span></div>
                  <div className="meta-item">Peers: <span>{torrent.peers ?? 'N/A'}</span></div>
                  <div className="meta-item">Provider: <span>{torrent.provider}</span></div>
                </div>
              </div>
              <a href={downloadUrl} className="download-btn" target="_blank" rel="noreferrer">
                Download
              </a>
            </div>
          );
        })}

        {!loading && query && results.length === 0 && !error && (
          <div className="empty-state">
            No results found for "{query}".
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
