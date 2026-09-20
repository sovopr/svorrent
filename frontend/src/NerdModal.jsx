import React, { useState, useEffect, useRef } from 'react';

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatClientName(client) {
  if (!client) return 'Unknown Client';
  if (typeof client === 'string') return client;
  if (typeof client === 'object') {
    try {
      const chars = Object.values(client).map((c) => (typeof c === 'number' ? String.fromCharCode(c) : String(c))).join('');
      return chars.trim() || 'Unknown Client';
    } catch (e) {
      return 'Unknown Client';
    }
  }
  return String(client);
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, errorInfo) {
    console.error('NerdModal Error:', error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="stream-overlay" onClick={this.props.onClose}>
          <div className="nerd-modal" style={{ padding: '2.5rem', textAlign: 'center' }}>
            <h3 style={{ color: '#f87171', marginBottom: '0.75rem' }}>Inspector Data Recovered</h3>
            <p style={{ color: '#94a3b8', marginBottom: '1.5rem' }}>{this.state.error?.message || 'Recovered from unexpected wire payload'}</p>
            <button className="btn btn-secondary" onClick={this.props.onClose}>Close Inspector</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function NerdModalInner({ torrentId, onClose }) {
  const [nerdStats, setNerdStats] = useState(null);
  const [activeNerdTab, setActiveNerdTab] = useState('peers');
  const pollRef = useRef(null);

  useEffect(() => {
    if (!torrentId) return;

    const fetchNerd = async () => {
      try {
        const res = await fetch(`http://localhost:3001/api/torrent/${torrentId}/nerd-stats`);
        if (res.ok) {
          const data = await res.json();
          setNerdStats(data);
        }
      } catch (e) {}
    };

    fetchNerd();
    pollRef.current = setInterval(fetchNerd, 1000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [torrentId]);

  const handleOpenFinder = async () => {
    await fetch(`http://localhost:3001/api/torrent/${torrentId}/open-finder`, { method: 'POST' });
  };

  const handlePlayNative = async () => {
    await fetch(`http://localhost:3001/api/torrent/${torrentId}/play-native`, { method: 'POST' });
  };

  if (!nerdStats) {
    return (
      <div className="stream-overlay" onClick={(e) => e.target.classList.contains('stream-overlay') && onClose()}>
        <div className="nerd-modal" style={{ padding: '3rem', textAlign: 'center' }}>
          <div className="spinner" style={{ margin: '0 auto 1rem' }}></div>
          <p>Connecting to wire telemetry & loading swarm stats...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="stream-overlay" onClick={(e) => e.target.classList.contains('stream-overlay') && onClose()}>
      <div className="nerd-modal">
        <div className="nerd-modal-header">
          <div className="nerd-header-title-box">
            <span className="nerd-badge">⚡ NERD INSPECTOR</span>
            <h3>{nerdStats.name}</h3>
          </div>
          <button className="stream-modal-close" onClick={onClose}>✕</button>
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
                          <td className="mono">{String(p.ip)}:{String(p.port)}</td>
                          <td className="client-name">{formatClientName(p.client)}</td>
                          <td><span className="badge-type">{String(p.type)}</span></td>
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
                        <td className="mono" style={{ maxWidth: '380px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {tr.url}
                        </td>
                        <td><span className="badge-type">{tr.status}</span></td>
                        <td className="speed-val">▲ {tr.seeds}</td>
                        <td>▼ {tr.peers}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 4: FILES LIST */}
          {activeNerdTab === 'files' && (
            <div className="nerd-tab-pane">
              <div className="table-responsive">
                <table className="nerd-table">
                  <thead>
                    <tr>
                      <th>File Name & Path</th>
                      <th>Size</th>
                      <th>Downloaded</th>
                      <th>Progress</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {nerdStats.files.map((f, fIdx) => (
                      <tr key={fIdx}>
                        <td style={{ maxWidth: '340px', wordBreak: 'break-all' }}>{f.name}</td>
                        <td>{formatBytes(f.length)}</td>
                        <td>{formatBytes(f.downloaded)}</td>
                        <td>{Math.round((f.progress || 0) * 100)}%</td>
                        <td>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={handlePlayNative}
                            title="Open in native player"
                          >
                            ▶ Play
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
          <button className="btn btn-secondary" onClick={handleOpenFinder}>
            📂 Reveal in Finder
          </button>
          <button className="btn btn-primary" onClick={handlePlayNative}>
            ▶ Open in Default Player (IINA / VLC)
          </button>
        </div>
      </div>
    </div>
  );
}

export function NerdModal(props) {
  return (
    <ErrorBoundary onClose={props.onClose}>
      <NerdModalInner {...props} />
    </ErrorBoundary>
  );
}
