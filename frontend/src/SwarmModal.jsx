import { useEffect, useState, useMemo } from 'react';
import { useDialog } from './useDialog';
import { SwarmWorldMap } from './SwarmWorldMap';
import { countryFlag, countryName } from './countryUtils';
import { Icon } from './Icon';
import { apiGet, formatSpeed, formatBytes, formatPeerAddress } from './lib';

const INTERFACE_COLORS = {
  wifi: '#5b8dee',
  cellular: '#57ab72',
  ethernet: '#c9a24a',
  bridge: '#a3a4a8',
  other: '#a3a4a8',
};

function getIfaceColor(type) {
  return INTERFACE_COLORS[type] || INTERFACE_COLORS.other;
}

function formatPeerIface(p, allInterfaces = []) {
  const name = p.networkInterface || p.networkDevice || '';
  const type = p.networkType || (p.networkDevice === 'feth0' ? 'cellular' : 'wifi');

  if (type === 'wifi' || /^wi-?fi/i.test(name)) {
    return 'Wi-Fi';
  }

  if (type === 'cellular' || /tether|rndis|feth/i.test(name) || /tether|rndis|feth/i.test(p.networkDevice || '')) {
    const cellularCount = allInterfaces.filter((i) => i.type === 'cellular').length;
    if (cellularCount > 1) {
      const match = name.match(/\(([^)]+)\)/);
      if (match) {
        const shortDevice = match[1].replace(/samsung\s+/i, '').replace(/google\s+/i, '');
        return `USB (${shortDevice})`;
      }
    }
    return 'USB Tether';
  }

  if (type === 'ethernet' || /ethernet|lan/i.test(name)) {
    return 'Ethernet';
  }

  if (type === 'bridge' || /bridge/i.test(name)) {
    return 'Bridge';
  }

  return name.length > 12 ? `${name.slice(0, 10)}…` : (name || 'Default');
}

export function SwarmModal({ torrent, onClose }) {
  const [data, setData] = useState({
    peers: [],
    summary: { totalPeers: 0, countriesCount: 0, countries: [], interfaces: [] },
    pieceTelemetry: null,
  });
  const [viewMode, setViewMode] = useState('matrix');
  const [selectedCountry, setSelectedCountry] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('downSpeed');
  const [error, setError] = useState('');
  const dialog = useDialog(true, onClose);

  const torrentId = torrent?.infoHash;

  useEffect(() => {
    if (!torrentId) return;
    let alive = true;
    let timer;
    const controller = new AbortController();

    const load = async () => {
      try {
        const res = await apiGet(`/swarm?id=${encodeURIComponent(torrentId)}`, { signal: controller.signal });
        if (alive && res) {
          setData(res);
          setError('');
        }
      } catch (err) {
        if (alive) setError(err.message || 'Could not update peers. Retrying…');
      } finally {
        if (alive) timer = setTimeout(load, 1500);
      }
    };

    load();
    return () => {
      alive = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [torrentId]);

  const peers = useMemo(() => data.peers || [], [data.peers]);
  const summary = data.summary || { totalPeers: 0, countriesCount: 0, countries: [], interfaces: [] };
  const pieceTelemetry = data.pieceTelemetry;

  const filteredPeers = useMemo(() => {
    return peers.filter((p) => {
      if (selectedCountry) {
        const pCountry = p.geo?.countryCode?.toLowerCase();
        if (pCountry !== selectedCountry.toLowerCase()) {
          return false;
        }
      }

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const ip = (p.ip || '').toLowerCase();
        const client = (p.client || '').toLowerCase();
        const cName = countryName(p.geo?.countryCode).toLowerCase();
        const city = (p.geo?.city || '').toLowerCase();
        const proto = (p.protocol || '').toLowerCase();
        if (!ip.includes(q) && !client.includes(q) && !cName.includes(q) && !city.includes(q) && !proto.includes(q)) {
          return false;
        }
      }

      return true;
    });
  }, [peers, selectedCountry, searchQuery]);

  const sortedPeers = useMemo(() => {
    const list = [...filteredPeers];
    list.sort((a, b) => {
      if (sortBy === 'downSpeed') return (b.downloadSpeed || 0) - (a.downloadSpeed || 0);
      if (sortBy === 'progress') return (b.progress || 0) - (a.progress || 0);
      if (sortBy === 'client') return (a.client || '').localeCompare(b.client || '');
      if (sortBy === 'protocol') return (a.protocol || 'TCP').localeCompare(b.protocol || 'TCP');
      if (sortBy === 'country') {
        const cA = countryName(a.geo?.countryCode);
        const cB = countryName(b.geo?.countryCode);
        return cA.localeCompare(cB);
      }
      return 0;
    });
    return list;
  }, [filteredPeers, sortBy]);

  const interfaceBreakdown = useMemo(() => {
    const ifaces = summary.interfaces || [];
    return ifaces.map((iface) => {
      const ifacePeers = peers.filter(
        (p) => iface.device ? p.networkDevice === iface.device : p.networkType === iface.type
      );
      const tcpCount = ifacePeers.filter((p) => !p.protocol || p.protocol === 'TCP').length;
      const utpCount = ifacePeers.filter((p) => p.protocol === 'uTP').length;
      const unchokedCount = ifacePeers.filter((p) => !p.choked).length;
      const chokedCount = ifacePeers.filter((p) => p.choked).length;
      const downSpeed = iface.downSpeed ?? ifacePeers.reduce((s, p) => s + (p.downloadSpeed || 0), 0);
      const upSpeed = ifacePeers.reduce((s, p) => s + (p.uploadSpeed || 0), 0);

      return {
        ...iface,
        peerCount: ifacePeers.length,
        tcpCount,
        utpCount,
        unchokedCount,
        chokedCount,
        downSpeed,
        upSpeed,
      };
    });
  }, [summary.interfaces, peers]);

  return (
    <div className="modal-backdrop swarm-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} tabIndex={-1} className="modal swarm-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="swarm-modal-title">
        <div className="swarm-modal-head">
          <div className="swarm-modal-title-wrap">
            <div>
              <h2 id="swarm-modal-title" className="swarm-modal-title ellipsis" title={torrent?.name || torrent?.fileName}>
                {torrent?.name || torrent?.fileName || torrentId}
              </h2>
              <div className="swarm-modal-sub mono muted">
                <span>{formatBytes(torrent?.length || 0)}</span>
                <span className="dot-sep" />
                <span>{((torrent?.progress || 0) * 100).toFixed(1)}%</span>
                <span className="dot-sep" />
                <span>↓ {formatSpeed(torrent?.downloadSpeed || 0)}</span>
                <span className="dot-sep" />
                <span>{peers.length} peer{peers.length !== 1 ? 's' : ''} · {summary.countriesCount || 0} countr{summary.countriesCount === 1 ? 'y' : 'ies'}</span>
              </div>
            </div>
          </div>

          <div className="swarm-head-actions">
            <div className="segmented" role="group" aria-label="View mode">
              <button
                className={`segment ${viewMode === 'matrix' ? 'is-active' : ''}`}
                onClick={() => setViewMode('matrix')}
                aria-pressed={viewMode === 'matrix'}
              >
                Pieces
              </button>
              <button
                className={`segment ${viewMode === 'map' ? 'is-active' : ''}`}
                onClick={() => setViewMode('map')}
                aria-pressed={viewMode === 'map'}
              >
                Map
              </button>
            </div>

            <button className="icon-btn" onClick={onClose} aria-label="Close dialog">
              <Icon name="x" size={15} />
            </button>
          </div>
        </div>

        <div className="swarm-modal-body">
          {error && <p className="notice notice-error" role="status">{error} Peer data may be out of date.</p>}

          {viewMode === 'matrix' ? (
            <div className="swarm-telemetry-container">
              <div className="telemetry-card">
                <div className="card-top-bar">
                  <span className="card-title">Piece map</span>
                  {pieceTelemetry && (
                    <div className="frontier-metrics mono muted">
                      <span>{pieceTelemetry.verifiedPieces} / {pieceTelemetry.totalPieces} verified</span>
                      <span className="dot-sep" />
                      <span>{pieceTelemetry.progressPercent}%</span>
                      {pieceTelemetry.pieceLength > 0 && (
                        <>
                          <span className="dot-sep" />
                          <span>{formatBytes(pieceTelemetry.pieceLength)} each</span>
                        </>
                      )}
                    </div>
                  )}
                </div>

                <div className="piece-grid-wrapper">
                  {pieceTelemetry?.piecesGrid ? (
                    <div className="piece-grid-row">
                      {pieceTelemetry.piecesGrid.map((status, idx) => {
                        const isDone = status === 2;
                        const isDownloading = status === 1;
                        const isCursor = idx === Math.floor(pieceTelemetry.streamingCursorPiece * (pieceTelemetry.piecesGrid.length / pieceTelemetry.totalPieces));
                        return (
                          <div
                            key={idx}
                            className={`piece-block ${isDone ? 'is-verified' : isDownloading ? 'is-downloading' : 'is-missing'} ${isCursor ? 'is-streaming-cursor' : ''}`}
                            title={`Piece #${idx + 1}: ${isDone ? 'Verified' : isDownloading ? 'Downloading' : 'Missing'}`}
                          />
                        );
                      })}
                    </div>
                  ) : (
                    <div className="empty-sub muted">Reading piece bitfield…</div>
                  )}
                </div>

                {pieceTelemetry?.availability && pieceTelemetry.availability.length > 0 && (
                  <div className="swarm-rarity-row">
                    <div className="rarity-label-bar">
                      <span className="muted">Swarm availability</span>
                      <span className="mono muted">0–100%</span>
                    </div>
                    <div className="rarity-track">
                      {pieceTelemetry.availability.map((avail, idx) => (
                        <div
                          key={idx}
                          className="rarity-bar"
                          style={{
                            backgroundColor: avail === 0 ? 'var(--surface-2)' : 'var(--accent)',
                            opacity: avail === 0 ? 1 : Math.max(0.2, avail / 100),
                          }}
                          title={`Piece #${idx + 1}: ${avail}% swarm availability`}
                        />
                      ))}
                    </div>
                  </div>
                )}

                <div className="grid-legend muted">
                  <span className="legend-item"><span className="legend-box verified" /> Verified</span>
                  <span className="legend-item"><span className="legend-box downloading" /> Active</span>
                  <span className="legend-item"><span className="legend-box missing" /> Missing</span>
                  <span className="legend-item"><span className="cursor-indicator" /> Playback cursor</span>
                </div>
              </div>

              {interfaceBreakdown.length > 0 && (
                <div className="telemetry-card">
                  <div className="card-top-bar">
                    <span className="card-title">Interfaces</span>
                    <span className="muted">{interfaceBreakdown.length} active</span>
                  </div>

                  <div className="interface-cards-grid">
                    {interfaceBreakdown.map((iface) => {
                      const color = getIfaceColor(iface.type);
                      return (
                        <div key={iface.device} className="iface-stat-card">
                          <div className="iface-stat-head">
                            <div className="iface-name-badge">
                              <span className="status-dot" style={{ backgroundColor: color }} />
                              <span>{iface.name}</span>
                              <span className="mono muted">{iface.device}</span>
                            </div>
                            <span className="mono muted">{iface.peerCount} peers</span>
                          </div>

                          <div className="iface-speeds-row mono">
                            <span>↓ {formatSpeed(iface.downSpeed)}</span>
                            <span className="muted">↑ {formatSpeed(iface.upSpeed)}</span>
                          </div>

                          <div className="iface-protocols-row mono muted">
                            <span>TCP {iface.tcpCount} · uTP {iface.utpCount}</span>
                            <span>{iface.unchokedCount} unchoked</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="swarm-main-grid">
              <div className="swarm-map-card">
                <div className="card-top-bar">
                  <div className="card-heading">
                    <span className="card-title">Geographic distribution</span>
                    {selectedCountry && (
                      <span className="selected-filter-badge">
                        {countryFlag(selectedCountry)} {countryName(selectedCountry)}
                        <button className="clear-filter-btn" onClick={() => setSelectedCountry(null)} title="Clear country filter">
                          <Icon name="x" size={11} />
                        </button>
                      </span>
                    )}
                  </div>
                  <span className="muted">Select a country to filter peers</span>
                </div>

                <SwarmWorldMap
                  peers={peers}
                  selectedCountry={selectedCountry}
                  onSelectCountry={setSelectedCountry}
                />
              </div>

              <div className="swarm-countries-card">
                <div className="card-top-bar">
                  <span className="card-title">Countries</span>
                  <span className="mono muted">{summary.countries?.length || 0}</span>
                </div>

                <div className="countries-list">
                  {(!summary.countries || summary.countries.length === 0) ? (
                    <p className="empty-sub muted">Discovering peers…</p>
                  ) : (
                    summary.countries.map((c) => {
                      const isSelected = selectedCountry === c.code.toLowerCase();
                      const pct = peers.length > 0 ? Math.round((c.count / peers.length) * 100) : 0;
                      return (
                        <button
                          type="button"
                          key={c.code}
                          className={`country-row ${isSelected ? 'is-selected' : ''}`}
                          onClick={() => setSelectedCountry(isSelected ? null : c.code.toLowerCase())}
                          aria-pressed={isSelected}
                        >
                          <div className="country-row-main">
                            <span className="country-flag">{countryFlag(c.code)}</span>
                            <span className="country-name ellipsis">{countryName(c.code)}</span>
                            <span className="country-peers mono muted">{c.count}</span>
                          </div>

                          <div className="country-row-sub">
                            <div className="country-bar-track">
                              <div className="country-bar-fill" style={{ width: `${pct}%` }} />
                            </div>
                            <span className="country-speed mono muted">{formatSpeed(c.downSpeed)}</span>
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Peer Details Inspector Table */}
          <div className="swarm-peers-section">
            <div className="section-head">
              <div className="section-title-wrap">
                <h3 className="card-title">Peers</h3>
                <span className="mono muted">{sortedPeers.length}</span>
              </div>

              <div className="table-filter-bar">
                <div className="input-with-icon">
                  <Icon name="search" size={13} />
                  <input
                    type="text"
                    placeholder="Filter IP, client, country…"
                    aria-label="Filter peers"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="input-search-compact"
                  />
                  {searchQuery && (
                    <button className="input-clear-btn" aria-label="Clear peer filter" onClick={() => setSearchQuery('')}>
                      <Icon name="x" size={12} />
                    </button>
                  )}
                </div>

                <label className="select-wrap">
                  <span className="sr-only">Sort peers</span>
                  <select
                    aria-label="Sort peers"
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value)}
                  >
                    <option value="downSpeed">Sort: Download speed</option>
                    <option value="progress">Sort: Progress</option>
                    <option value="country">Sort: Country</option>
                    <option value="client">Sort: Client</option>
                    <option value="protocol">Sort: Protocol</option>
                  </select>
                </label>
              </div>
            </div>

            <div className="table-responsive">
              <table className="table table-compact swarm-peers-table">
                <thead>
                  <tr>
                    <th className="col-country">Country</th>
                    <th className="col-peer-ip">Address</th>
                    <th className="col-client">Client</th>
                    <th className="col-proto">Proto</th>
                    <th className="col-iface">Interface</th>
                    <th className="col-down col-num">Down</th>
                    <th className="col-up col-num">Up</th>
                    <th className="col-progress col-num">Have</th>
                    <th className="col-flags col-num" title="C = Choked, U = Unchoked, I = Interested">Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedPeers.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="empty-table-cell">
                        {peers.length === 0 ? 'Connecting to peers…' : 'No peers match the current filter.'}
                      </td>
                    </tr>
                  ) : (
                    sortedPeers.map((p, idx) => {
                      const cCode = p.geo?.countryCode;
                      const proto = p.protocol || 'TCP';
                      const addrText = formatPeerAddress(p.ip, p.port);
                      const cName = countryName(cCode);
                      const ifaceLabel = formatPeerIface(p, summary.interfaces || []);
                      const ifaceTooltip = `${p.networkInterface || p.networkDevice || 'Unknown'}${p.networkDevice ? ` (${p.networkDevice})` : ''}`;
                      return (
                        <tr key={`${p.ip}:${p.port}-${idx}`}>
                          <td className="col-country">
                            <div className="country-cell" title={`${cName}${p.geo?.city ? ` (${p.geo.city})` : ''}`}>
                              <span className="table-flag">{countryFlag(cCode)}</span>
                              <span className="table-country-name ellipsis">{cName}</span>
                            </div>
                          </td>

                          <td className="col-peer-ip mono" title={addrText}>
                            <span className="peer-ip-text">{addrText}</span>
                          </td>

                          <td className="col-client muted" title={p.client || 'Unknown'}>
                            <span className="ellipsis">{p.client || 'Unknown'}</span>
                          </td>

                          <td className="col-proto mono muted">{proto}</td>

                          <td className="col-iface muted" title={ifaceTooltip}>
                            {ifaceLabel}
                          </td>

                          <td className="col-down col-num mono">
                            {p.downloadSpeed > 0 ? formatSpeed(p.downloadSpeed) : <span className="muted">—</span>}
                          </td>

                          <td className="col-up col-num mono muted">
                            {formatSpeed(p.uploadSpeed)}
                          </td>

                          <td className="col-progress col-num mono muted">
                            {p.progress || 0}%
                          </td>

                          <td className="col-flags col-num mono muted">
                            <span title={p.choked ? 'Peer is choking us' : 'Peer is unchoked'}>
                              {p.choked ? 'C' : 'U'}
                            </span>
                            {p.interested && <span title="Peer is interested">·I</span>}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
