import { useState, useEffect, useRef } from 'react';
import { Icon } from './Icon';
import { apiGet, apiPost, formatBytes, formatSpeed } from './lib';

const TYPE_LABELS = {
  wifi: 'Wi-Fi',
  cellular: 'Cellular',
  ethernet: 'Ethernet',
  bridge: 'Bridge',
  other: 'Adapter',
};

const TYPE_COLORS = {
  wifi: '#5b8dee',
  cellular: '#57ab72',
  ethernet: '#c9a24a',
  bridge: '#a3a4a8',
  other: '#a3a4a8',
};

function MiniSparkline({ data = [], color = '#5b8dee', height = 18, width = 64 }) {
  if (!data || data.length < 2) {
    return <div style={{ width, height }} className="sparkline-placeholder" />;
  }

  const hasSignal = data.some((val) => val > 0);
  const max = Math.max(...data, 1024);
  const points = data.map((val, idx) => {
    const x = (idx / (data.length - 1)) * width;
    const y = height - (Math.min(val, max) / max) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return (
    <svg width={width} height={height} className="mini-sparkline" aria-hidden="true">
      <polyline
        fill="none"
        stroke={color}
        strokeOpacity={hasSignal ? 1 : 0.45}
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
}

export function NetworksPage({ notify, isActive = true }) {
  const [data, setData] = useState({
    interfaces: [],
    totalDownSpeed: 0,
    totalUpSpeed: 0,
    totalDownloaded: 0,
    totalUploaded: 0,
    bondedCount: 0,
    connectedCount: 0,
    aggregateHistory: [],
  });
  const [loading, setLoading] = useState(true);
  const [peakSpeed, setPeakSpeed] = useState(0);
  const [pendingAction, setPendingAction] = useState(null);
  const [error, setError] = useState('');
  const requestRef = useRef(null);
  const notifyRef = useRef(notify);

  const [updater, setUpdater] = useState(null);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [isRestartingUpdate, setIsRestartingUpdate] = useState(false);

  const fetchUpdater = () => {
    apiGet('/updater/status')
      .then((status) => {
        if (status && typeof status === 'object') setUpdater(status);
      })
      .catch(() => {});
  };

  useEffect(() => {
    if (!isActive) return;
    fetchUpdater();
    const isBusy = updater?.status === 'checking' || updater?.status === 'available' || updater?.status === 'downloading' || isRestartingUpdate;
    const interval = setInterval(fetchUpdater, isBusy ? 1500 : 20000);
    return () => clearInterval(interval);
  }, [isActive, updater?.status, isRestartingUpdate]);

  const handleCheckUpdate = async () => {
    if (isCheckingUpdate) return;
    setIsCheckingUpdate(true);
    try {
      const res = await apiPost('/updater/check');
      if (res && typeof res === 'object') {
        setUpdater(res);
        if (res.status === 'error') {
          notifyRef.current?.(res.error || 'Update check failed', 'error');
        } else if (res.updateAvailable) {
          notifyRef.current?.('New update found — integrating…');
        } else {
          notifyRef.current?.(`Up to date (v${res.currentVersion || '1.0.4'})`);
        }
      }
    } catch (err) {
      notifyRef.current?.(err.message || 'Failed to check for updates', 'error');
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  const handleRestartUpdate = async () => {
    if (isRestartingUpdate) return;
    setIsRestartingUpdate(true);
    notifyRef.current?.('Integrating update and restarting Svorrent…');
    try {
      await apiPost('/updater/restart');
      setTimeout(() => {
        setIsRestartingUpdate(false);
        fetchUpdater();
      }, 3000);
    } catch (err) {
      notifyRef.current?.(err.message || 'Failed to apply update', 'error');
      setIsRestartingUpdate(false);
    }
  };

  useEffect(() => {
    notifyRef.current = notify;
  }, [notify]);

  useEffect(() => {
    if (!isActive) return;
    let disposed = false;
    let timer;
    let currentRequest = null;

    const requestNetworks = async (kind = 'poll', iface) => {
      if (disposed || (currentRequest && (kind === 'poll' || currentRequest.kind !== 'poll'))) return;
      clearTimeout(timer);
      currentRequest?.controller.abort();
      const request = { kind, controller: new AbortController() };
      currentRequest = request;
      const isCurrent = () => !disposed && currentRequest === request;
      const options = { signal: request.controller.signal, timeoutMs: 15000 };
      setPendingAction(kind === 'poll' ? null : kind);

      try {
        const snap = kind === 'toggle'
          ? await apiPost(`/networks/${encodeURIComponent(iface.id)}/toggle`, { enabled: !iface.enabled }, options)
          : await apiGet(kind === 'refresh' ? '/networks?rescan=true' : '/networks', options);
        if (!isCurrent()) return;
        if (!snap || !Array.isArray(snap.interfaces)) throw new Error('The server returned invalid network data.');
        setData(snap);
        setPeakSpeed((previous) => Math.max(previous, Number(snap.totalDownSpeed) || 0));
        setError('');
        if (kind === 'toggle') {
          notifyRef.current?.(`${iface.name} (${iface.device}) ${iface.enabled ? 'disabled' : 'enabled'}`);
        }
      } catch (err) {
        if (!isCurrent()) return;
        const message = err.message || 'Unable to load network data.';
        setError(message);
        if (kind === 'toggle') notifyRef.current?.(message, 'error');
      } finally {
        if (isCurrent()) {
          currentRequest = null;
          setLoading(false);
          setPendingAction(null);
          timer = setTimeout(() => requestNetworks(), 1200);
        }
      }
    };

    requestRef.current = requestNetworks;
    requestNetworks();
    return () => {
      disposed = true;
      clearTimeout(timer);
      currentRequest?.controller.abort();
      requestRef.current = null;
    };
  }, [isActive]);

  const isRefreshing = pendingAction === 'refresh';

  const {
    interfaces = [],
    totalDownSpeed = 0,
    totalUpSpeed = 0,
    totalDownloaded = 0,
    totalUploaded = 0,
    bondedCount = 0,
    connectedCount = 0,
    aggregateHistory = [],
  } = data;

  const selfAssignedInterfaces = interfaces.filter((i) => i.statusReason === 'link-local');
  const iphoneDhcpIface = interfaces.find(
    (i) => (i.name?.toLowerCase().includes('iphone') || (data?.iosTether?.detected && i.type === 'cellular')) && i.statusReason === 'link-local'
  );
  const showIosBanner = (data?.iosTether?.detected && !data?.iosTether?.interfaceActive) || !!iphoneDhcpIface;
  const nonIosSelfAssigned = selfAssignedInterfaces.filter((i) => i !== iphoneDhcpIface);
  const hasMultiple = bondedCount > 1;
  const totalPeers = interfaces.reduce((sum, i) => sum + (Number(i.peers) || 0), 0);
  const measuredPeak = Math.max(peakSpeed, ...(aggregateHistory || []), 0);
  const downloadShare = (iface) => totalDownSpeed > 0 && iface.connected && iface.enabled
    ? Math.max(0, Math.min(100, Number(iface.sharePercent) || 0))
    : 0;

  return (
    <section className="networks-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Networks</h1>
          <p className="page-sub">
            Route peer connections across one or more network interfaces.
          </p>
        </div>
        <div className="page-actions">
          <button
            id="refresh-networks"
            className={`btn btn-outline ${isRefreshing ? 'is-refreshing' : ''}`}
            onClick={() => requestRef.current?.('refresh')}
            disabled={pendingAction !== null}
            title="Rescan network adapters"
          >
            <Icon name="refresh" size={13} className={isRefreshing ? 'icon-spin' : ''} />
            <span>{isRefreshing ? 'Scanning…' : 'Refresh adapters'}</span>
          </button>
        </div>
      </div>

      {error && <p className="notice notice-error" role="alert">Network update failed: {error} Retrying automatically.</p>}

      {showIosBanner && (
        <div className="usb-tether-banner" role="status">
          <div className="usb-tether-dot" />
          <div className="usb-tether-content">
            <span className="usb-tether-title">
              {data?.iosTether?.locked
                ? 'Unlock your iPhone with Face ID or Passcode to enable USB Personal Hotspot.'
                : 'Go to System Settings → Network → iPhone USB → Details… and turn off "Disable unless needed".'}
            </span>
          </div>
        </div>
      )}

      {nonIosSelfAssigned.length > 0 && !showIosBanner && (
        <div className="usb-tether-banner" role="status">
          <div className="usb-tether-dot" />
          <div className="usb-tether-content">
            <span className="usb-tether-title">
              {nonIosSelfAssigned.map((iface) => iface.device).join(', ')} has a self-assigned address
            </span>
            <span className="usb-tether-hint muted">
              This adapter cannot carry internet traffic yet. Check its network service and DHCP settings in macOS, then refresh adapters.
            </span>
          </div>
        </div>
      )}

      {data?.usbTether?.detected && !data?.usbTether?.interfaceActive && (
        <div className="usb-tether-banner" role="status">
          <div className="usb-tether-dot" />
          <div className="usb-tether-content">
            <span className="usb-tether-title">
              {data.usbTether.name || 'Android device'} detected via USB
            </span>
            <span className="usb-tether-hint muted">
              {!data.usbTether.helperInstalled
                ? 'Reopen Svorrent from Applications and choose Enable Android USB tethering when prompted.'
                : data.usbTether.daemonActive
                  ? 'Connected via USB. On your phone, go to Settings → Connections → Mobile Hotspot and Tethering and turn on "USB Tethering".'
                  : 'The Android USB helper is not running. Reopen Svorrent to retry setup.'}
            </span>
          </div>
        </div>
      )}

      {/* Compact Telemetry Summary Strip */}
      <div className="stat-grid network-kpi-grid">
        <div>
          <span className="stat-label">Download</span>
          <div className="stat-value-row">
            <span className="stat-value mono">{formatSpeed(totalDownSpeed)}</span>
            <MiniSparkline data={aggregateHistory} color="#5b8dee" width={68} height={18} />
          </div>
          <span className="stat-meta mono muted">
            Peak {measuredPeak > 0 ? formatSpeed(measuredPeak) : '0 B/s'}
          </span>
        </div>

        <div>
          <span className="stat-label">Upload</span>
          <span className="stat-value mono">{formatSpeed(totalUpSpeed)}</span>
          <span className="stat-meta mono muted">
            {totalPeers} active peer{totalPeers === 1 ? '' : 's'}
          </span>
        </div>

        <div>
          <span className="stat-label">Routing</span>
          <span className="stat-value mono">
            {bondedCount} <span className="stat-unit">of {connectedCount} active</span>
          </span>
          <span className="stat-meta">
            <span className={`status-indicator ${bondedCount > 0 ? 'online' : 'offline'}`} />
            {bondedCount === 0 ? 'No active adapters' : hasMultiple ? 'Multi-interface bonding' : 'Single interface'}
          </span>
        </div>

        <div>
          <span className="stat-label">Session transferred</span>
          <span className="stat-value mono">{formatBytes(totalDownloaded)}</span>
          <span className="stat-meta mono muted">
            {formatBytes(totalUploaded)} uploaded
          </span>
        </div>
      </div>

      {/* Adapters Management Table */}
      <div className="adapters-section">
        <div className="section-bar">
          <h2 className="section-heading">Interfaces</h2>
          <span className="section-caption muted">
            Toggle routing per interface. Disconnected interfaces cannot route peer traffic.
          </span>
        </div>

        {loading ? (
          <div className="empty">Loading network adapters…</div>
        ) : interfaces.length === 0 ? (
          <div className="empty">{error ? 'Network adapters are unavailable.' : 'No network adapters detected.'}</div>
        ) : (
          <div className="table-wrap">
            <table className="table adapters-table">
              <thead>
                <tr>
                  <th className="col-iface">Interface</th>
                  <th className="col-type">Type</th>
                  <th className="col-ip">IPv4</th>
                  <th className="col-num col-download">Download</th>
                  <th className="col-num col-upload">Upload</th>
                  <th className="col-num col-share">Share</th>
                  <th className="col-num col-data">Session</th>
                  <th className="col-num col-peers">Peers</th>
                  <th className="col-actions">Routing</th>
                </tr>
              </thead>
              <tbody>
                {interfaces.map((iface) => {
                  const color = TYPE_COLORS[iface.type] || TYPE_COLORS.other;
                  const typeLabel = TYPE_LABELS[iface.type] || iface.type;
                  const isOnline = iface.connected && iface.enabled;
                  const share = downloadShare(iface);

                  return (
                    <tr key={iface.id} className={iface.enabled ? '' : 'row-disabled'}>
                      <td className="col-iface">
                        <div className="iface-cell">
                          <span
                            className={`status-dot ${isOnline ? 'is-online' : 'is-offline'}`}
                            style={{ backgroundColor: isOnline ? color : undefined }}
                            title={iface.statusReason === 'link-local' ? 'Needs DHCP; turn off "Disable unless needed" in System Settings' : !iface.connected ? 'Disconnected' : iface.enabled ? 'Routing enabled' : 'Routing disabled'}
                          />
                          <span className="iface-name">{iface.name}</span>
                          <span className="mono muted iface-device">{iface.device}</span>
                          {iface.statusReason === 'link-local' && (
                            <span className="tag-inline-warn">Needs DHCP</span>
                          )}
                        </div>
                      </td>
                      <td className="col-type muted">{typeLabel}</td>
                      <td className="col-ip mono muted">{iface.ip || '—'}</td>
                      <td className="col-num col-download">
                        <div className="speed-with-sparkline">
                          <span className="mono">{formatSpeed(iface.downSpeed)}</span>
                          <MiniSparkline data={iface.history} color={isOnline ? color : '#3a3b40'} width={52} height={16} />
                        </div>
                      </td>
                      <td className="col-num col-upload mono muted">{formatSpeed(iface.upSpeed)}</td>
                      <td className="col-num col-share mono muted">
                        {!iface.enabled ? 'Off' : totalDownSpeed > 0 ? `${share}%` : '—'}
                      </td>
                      <td className="col-num col-data mono muted">{formatBytes(iface.downloaded)}</td>
                      <td className="col-num col-peers mono muted">{iface.peers ?? 0}</td>
                      <td className="col-actions">
                        <button
                          className={`btn-toggle ${iface.enabled ? 'is-active' : ''}`}
                          onClick={() => requestRef.current?.('toggle', iface)}
                          disabled={pendingAction !== null || !iface.connected}
                          aria-pressed={!!iface.enabled}
                          aria-label={`Toggle routing on ${iface.name}`}
                          title={iface.statusReason === 'link-local' ? 'Turn off "Disable unless needed" in System Settings to route peer traffic' : iface.enabled ? 'Disable adapter' : 'Enable adapter'}
                        >
                          <span className="toggle-thumb" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Minimalist Application Version & Update Row */}
      <div className="updates-section">
        <div className="section-bar">
          <h2 className="section-heading">Application</h2>
        </div>

        <div className={`updates-bar ${updater?.updateAvailable || updater?.readyToInstall ? 'has-update' : ''}`}>
          <div className="updates-meta">
            <span className="updates-version mono">
              Svorrent v{updater?.currentVersion || '1.0.4'}
            </span>
            <span className="dot-sep" />
            <span className="updates-status-text">
              {updater?.readyToInstall
                ? 'New update ready to integrate'
                : updater?.status === 'downloading' || updater?.status === 'available'
                ? `New update found · Integrating (${updater.downloadProgress || 0}%)…`
                : updater?.status === 'error'
                ? `Update check failed: ${updater.error || 'Unknown error'}`
                : updater?.updateAvailable
                ? 'New update available'
                : 'Up to date'}
            </span>
            {updater?.lastChecked && (
              <>
                <span className="dot-sep" />
                <span className="updates-timestamp mono muted">
                  Checked {new Date(updater.lastChecked).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </>
            )}
          </div>

          <div className="updates-actions">
            {updater?.readyToInstall ? (
              <button
                id="btn-restart-update"
                className="btn btn-primary btn-sm"
                onClick={handleRestartUpdate}
                disabled={isRestartingUpdate}
              >
                <Icon name="refresh" size={13} className={isRestartingUpdate ? 'spin' : ''} />
                <span>{isRestartingUpdate ? 'Restarting…' : 'Restart & Integrate'}</span>
              </button>
            ) : (
              <button
                id="btn-check-update"
                className="btn btn-outline btn-sm"
                onClick={handleCheckUpdate}
                disabled={isCheckingUpdate || updater?.status === 'downloading'}
                title="Check for updates"
              >
                <Icon name="refresh" size={13} className={isCheckingUpdate || updater?.status === 'downloading' ? 'spin' : ''} />
                <span>
                  {isCheckingUpdate
                    ? 'Checking…'
                    : updater?.status === 'downloading'
                    ? `Integrating (${updater.downloadProgress || 0}%)…`
                    : 'Check for update'}
                </span>
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
