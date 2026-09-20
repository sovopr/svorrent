import React, { useState, useEffect, useRef } from 'react';
import { NerdModal } from './NerdModal';

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export function CinemaPlayer() {
  const [params, setParams] = useState(() => {
    const p = new URLSearchParams(window.location.search);
    return {
      magnet: p.get('magnet') || p.get('streamMagnet') || '',
      title: p.get('title') || 'Streaming Remux',
      provider: p.get('provider') || '',
      desc: p.get('desc') || '',
      link: p.get('link') || '',
    };
  });

  const [streamMode, setStreamMode] = useState('copy'); // 'copy' | 'transcode' | 'raw'
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [actionFeedback, setActionFeedback] = useState('');
  const [showNerdModal, setShowNerdModal] = useState(false);
  const [isVideoLoading, setIsVideoLoading] = useState(true);

  const videoRef = useRef(null);
  const pollRef = useRef(null);

  // Poll status from backend
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const q = new URLSearchParams();
        if (params.magnet) q.set('magnet', params.magnet);
        if (params.provider) q.set('provider', params.provider);
        if (params.desc) q.set('desc', params.desc);
        if (params.link) q.set('link', params.link);

        const res = await fetch(`http://localhost:3001/api/torrent/status?${q.toString()}`);
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || 'Failed to connect to torrent swarm');
        }
        const data = await res.json();
        setStatus(data);
        if (data.magnet && !params.magnet) {
          setParams((prev) => ({ ...prev, magnet: data.magnet }));
        }
      } catch (err) {
        setError(err.message);
      }
    };

    fetchStatus();
    pollRef.current = setInterval(fetchStatus, 1200);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [params.magnet, params.provider, params.desc, params.link]);

  // Compute live stream URL based on mode
  const getStreamUrl = () => {
    const effectiveMagnet = status?.magnet || params.magnet;
    if (!effectiveMagnet) return '';

    if (streamMode === 'copy') {
      return `http://localhost:3001/api/stream/remux?mode=copy&magnet=${encodeURIComponent(effectiveMagnet)}`;
    } else if (streamMode === 'transcode') {
      return `http://localhost:3001/api/stream/remux?mode=transcode&magnet=${encodeURIComponent(effectiveMagnet)}`;
    } else {
      return `http://localhost:3001/api/stream?raw=true&magnet=${encodeURIComponent(effectiveMagnet)}`;
    }
  };

  const streamUrl = getStreamUrl();

  // Keyboard controls for Cinema Player
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Don't trigger shortcuts if typing inside an input
      if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;

      const video = videoRef.current;
      if (!video) return;

      if (e.code === 'Space') {
        e.preventDefault();
        if (video.paused) video.play();
        else video.pause();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - 10);
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        video.currentTime = Math.min(video.duration || 999999, video.currentTime + 10);
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        if (document.fullscreenElement) {
          document.exitFullscreen();
        } else {
          video.requestFullscreen().catch(() => {});
        }
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        video.muted = !video.muted;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handlePlayNative = async () => {
    if (!status?.infoHash) return;
    setActionFeedback('Launching in native player (IINA / VLC)...');
    try {
      const res = await fetch(`http://localhost:3001/api/torrent/${status.infoHash}/play-native`, { method: 'POST' });
      if (!res.ok) throw new Error('Could not open file in native player');
      setActionFeedback('✓ Opened in desktop player');
      setTimeout(() => setActionFeedback(''), 3500);
    } catch (err) {
      setActionFeedback('Failed to open: ' + err.message);
      setTimeout(() => setActionFeedback(''), 3500);
    }
  };

  const handleDownloadFull = async () => {
    const effectiveMagnet = status?.magnet || params.magnet;
    if (!effectiveMagnet) return;

    setActionFeedback('Starting full download to disk...');
    try {
      const res = await fetch('http://localhost:3001/api/torrent/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ magnet: effectiveMagnet }),
      });
      if (!res.ok) throw new Error('Download request failed');
      setActionFeedback('✓ Saving to ~/Downloads/Svorrent');
      setTimeout(() => setActionFeedback(''), 3500);
    } catch (err) {
      setActionFeedback('Error: ' + err.message);
      setTimeout(() => setActionFeedback(''), 3500);
    }
  };

  const bufferPct = Math.round((status?.progress || 0) * 100);

  return (
    <div className="cinema-wrapper">
      {/* Top Theater Navigation */}
      <header className="cinema-header">
        <div className="cinema-header-left">
          <a href="/" className="cinema-back-link" title="Return to Svorrent Search">
            ← Svorrent
          </a>
          <span className="cinema-brand-badge">💎 Svorrent Cinema</span>
          <div className="cinema-meta-box">
            <h1 className="cinema-title" title={status?.fileName || params.title}>
              {status?.fileName || params.title}
            </h1>
            <div className="cinema-sub-badges">
              {status?.length > 0 && <span className="cinema-badge size-badge">{formatBytes(status.length)}</span>}
              <span className="cinema-badge mode-badge">
                {streamMode === 'copy'
                  ? '💎 100% Lossless Remux Direct'
                  : streamMode === 'transcode'
                  ? '⚡ Universal H.264 Transcode'
                  : '📁 Raw Stream'}
              </span>
            </div>
          </div>
        </div>

        <div className="cinema-header-right">
          {/* Swarm Telemetry HUD */}
          <div className="cinema-hud-stats">
            <div className="hud-pill" title="Connected Peers in Swarm">
              <span className="hud-dot">●</span>
              <span className="hud-val">{status?.numPeers ?? 0}</span>
              <span className="hud-label">peers</span>
            </div>
            <div className="hud-pill" title="Current Download Speed">
              <span className="hud-icon">⚡</span>
              <span className="hud-val speed-val">{formatBytes(status?.downloadSpeed || 0)}/s</span>
            </div>
            <div className="hud-pill" title="Buffer Percentage">
              <span className="hud-val">{bufferPct}%</span>
              <span className="hud-label">buffered</span>
            </div>
          </div>

          {/* Quick Actions */}
          <div className="cinema-header-actions">
            {actionFeedback && <span className="cinema-feedback">{actionFeedback}</span>}

            <button
              className="btn btn-secondary btn-sm"
              onClick={handlePlayNative}
              title="Launch in macOS / Windows native player (IINA / VLC / Media Player) for full Dolby Vision / TrueHD Atmos"
            >
              ▶ Open in IINA / VLC
            </button>

            <button
              className="btn btn-secondary btn-sm"
              onClick={handleDownloadFull}
              title="Download entire torrent directly to disk"
            >
              ⬇ Download to Disk
            </button>

            {status?.infoHash && (
              <button
                className="btn btn-nerd btn-sm"
                onClick={() => setShowNerdModal(true)}
                title="Inspect real-time peer packets, bitfield piece map, and trackers"
              >
                🔍 Nerd Info
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main Cinema Viewport */}
      <main className="cinema-main">
        {error ? (
          <div className="cinema-error-box">
            <h3>Playback Connection Error</h3>
            <p>{error}</p>
            <button className="btn btn-primary" onClick={() => window.location.reload()}>
              Retry Connection
            </button>
          </div>
        ) : (
          <div className="cinema-viewport-container">
            {/* Mode Selector Toolbar */}
            <div className="cinema-mode-toolbar">
              <div className="mode-selector-label">
                <span>STREAM QUALITY:</span>
              </div>
              <div className="mode-btn-group">
                <button
                  className={`mode-btn ${streamMode === 'copy' ? 'active' : ''}`}
                  onClick={() => setStreamMode('copy')}
                  title="Zero re-encoding. 100% original Blu-ray HEVC/AVC video bitstream preserved bit-for-bit with transparent 384k AAC audio."
                >
                  <span className="mode-btn-icon">💎</span>
                  <span className="mode-btn-text">100% Remux Direct (Lossless Bit-for-Bit)</span>
                  <span className="mode-btn-sub">Original Quality</span>
                </button>

                <button
                  className={`mode-btn ${streamMode === 'transcode' ? 'active' : ''}`}
                  onClick={() => setStreamMode('transcode')}
                  title="Universal compatibility mode. Uses hardware-accelerated H.264 transcode (Apple VideoToolbox / Windows NVENC / QuickSync / AVX-2) at 14 Mbps."
                >
                  <span className="mode-btn-icon">⚡</span>
                  <span className="mode-btn-text">Universal Fast (Hardware Transcode)</span>
                  <span className="mode-btn-sub">Max Compatibility</span>
                </button>

                <button
                  className={`mode-btn ${streamMode === 'raw' ? 'active' : ''}`}
                  onClick={() => setStreamMode('raw')}
                  title="Direct HTTP byte range streaming for native MP4 / WebM files."
                >
                  <span className="mode-btn-icon">📁</span>
                  <span className="mode-btn-text">Raw Swarm Stream</span>
                  <span className="mode-btn-sub">Native MP4</span>
                </button>
              </div>
            </div>

            {/* Video Player Box */}
            <div className="cinema-player-frame">
              {status?.ready ? (
                <div className="video-element-wrapper">
                  <video
                    ref={videoRef}
                    key={streamUrl}
                    controls
                    autoPlay
                    playsInline
                    className="cinema-video"
                    src={streamUrl}
                    onWaiting={() => setIsVideoLoading(true)}
                    onPlaying={() => setIsVideoLoading(false)}
                    onCanPlay={() => setIsVideoLoading(false)}
                  >
                    Your browser does not support HTML5 video playback.
                  </video>

                  {isVideoLoading && (
                    <div className="video-loading-overlay">
                      <div className="spinner"></div>
                      <span>Buffering sequential stream fragments...</span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="cinema-buffering-state">
                  <div className="cinema-radar-box">
                    <div className="radar-pulse"></div>
                    <div className="radar-inner-glow"></div>
                  </div>
                  <h3>Connecting to BitTorrent Swarm...</h3>
                  <p className="buffering-detail">
                    {status?.numPeers > 0
                      ? `Found ${status.numPeers} swarm peers. Buffering initial sequential pieces (${bufferPct}% complete)...`
                      : 'Searching swarm DHT and announcing to trackers for high-speed seeders...'}
                  </p>

                  <div className="cinema-buffer-progress">
                    <div className="progress-bar-bg">
                      <div
                        className="progress-bar-fill"
                        style={{ width: `${Math.max(bufferPct, 6)}%` }}
                      ></div>
                    </div>
                    <div className="progress-labels">
                      <span>Sequential Swarm Buffer</span>
                      <span>{bufferPct}% ({formatBytes(status?.downloaded || 0)})</span>
                    </div>
                  </div>

                  <div className="buffering-specs">
                    <div className="spec-item">
                      <span className="spec-label">Stream Engine</span>
                      <span className="spec-val">FFmpeg On-the-Fly Remuxer</span>
                    </div>
                    <div className="spec-item">
                      <span className="spec-label">Video Stream</span>
                      <span className="spec-val">100% Untouched Bit-for-Bit (-c:v copy)</span>
                    </div>
                    <div className="spec-item">
                      <span className="spec-label">Audio Stream</span>
                      <span className="spec-val">384 kbps Studio AAC Passthrough</span>
                    </div>
                    <div className="spec-item">
                      <span className="spec-label">Container</span>
                      <span className="spec-val">Fragmented MP4 (fMP4)</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Technical Format & Specs Footer */}
            <div className="cinema-tech-banner">
              <div className="tech-banner-item">
                <span className="tech-icon">💎</span>
                <div>
                  <h4>100% Native Remux Quality</h4>
                  <p>
                    Zero pixel re-encoding. Full original 10-bit HEVC / AVC resolution and dynamic range streamed bit-for-bit directly into your browser.
                  </p>
                </div>
              </div>

              <div className="tech-banner-item">
                <span className="tech-icon">🎧</span>
                <div>
                  <h4>Studio-Grade Audio Transmuxing</h4>
                  <p>
                    High-bitrate Dolby TrueHD, DTS-HD MA, or AC3 master audio is converted on-the-fly to 384k AAC for crystal-clear browser audio.
                  </p>
                </div>
              </div>

              <div className="tech-banner-item">
                <span className="tech-icon">⌨️</span>
                <div>
                  <h4>Keyboard Shortcuts</h4>
                  <p>
                    <kbd>Space</kbd> Play/Pause &nbsp;•&nbsp; <kbd>←</kbd> <kbd>→</kbd> Seek 10s &nbsp;•&nbsp; <kbd>F</kbd> Fullscreen &nbsp;•&nbsp; <kbd>M</kbd> Mute
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Nerd Stats Modal */}
      {showNerdModal && status?.infoHash && (
        <NerdModal torrentId={status.infoHash} onClose={() => setShowNerdModal(false)} />
      )}
    </div>
  );
}
