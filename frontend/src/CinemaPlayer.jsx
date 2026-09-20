import React, { useState, useEffect, useRef } from 'react';
import { NerdModal } from './NerdModal';

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Helper to convert SRT string into clean WebVTT
function convertSrtToVtt(srtText) {
  if (srtText.trim().startsWith('WEBVTT')) return srtText;
  const normalized = srtText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const converted = normalized.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return 'WEBVTT\n\n' + converted;
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

  // Helper to check if file is natively playable in browser
  const isNativeVideoFile = (filename) => {
    if (!filename) return false;
    return /\.(mp4|m4v|webm)$/i.test(filename);
  };

  // Quality / Stream Mode: 'direct' | 'remux' | '1080p' | '720p' | '480p'
  const [streamMode, setStreamMode] = useState(() => {
    const title = new URLSearchParams(window.location.search).get('title') || '';
    if (isNativeVideoFile(title)) return 'direct';
    return 'direct';
  });
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [actionFeedback, setActionFeedback] = useState('');
  const [showNerdModal, setShowNerdModal] = useState(false);
  const [isVideoLoading, setIsVideoLoading] = useState(true);
  const [remuxAttempt, setRemuxAttempt] = useState(0);
  const hasAutoSelectedModeRef = useRef(false);
  const remuxFailureCountRef = useRef(0);

  // Playback Speed State
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);

  // Subtitles State
  const [activeSubtitle, setActiveSubtitle] = useState(null); // { id, label, url, ... }
  const [customSubtitles, setCustomSubtitles] = useState([]);
  const [onlineSubtitles, setOnlineSubtitles] = useState([]);
  const [isSearchingSubtitles, setIsSearchingSubtitles] = useState(false);
  const [subtitleSearchQuery, setSubtitleSearchQuery] = useState('');
  const [subtitleLang, setSubtitleLang] = useState('eng');
  const [showSubtitleMenu, setShowSubtitleMenu] = useState(false);
  const [subtitleSize, setSubtitleSize] = useState('normal'); // 'normal' | 'large' | 'xlarge'
  const [subtitleDelay, setSubtitleDelay] = useState(0); // seconds offset
  const hasAutoSearchedRef = useRef(false);

  const videoRef = useRef(null);
  const pollRef = useRef(null);
  const fileInputRef = useRef(null);
  const savedPositionRef = useRef(0);
  const forcePlayTimerRef = useRef(null); // Auto-dismiss overlay if video stalls
  const firstPieceReadyAtRef = useRef(null); // Timestamp when piece 0 was first seen

  // Online Subtitles Search Method
  const searchOnlineSubtitles = async (searchTarget, langCode = subtitleLang) => {
    const q = searchTarget || subtitleSearchQuery || status?.fileName || params.title;
    if (!q) return;

    setIsSearchingSubtitles(true);
    try {
      const res = await fetch(`http://localhost:3001/api/subtitles/search?query=${encodeURIComponent(q)}&lang=${encodeURIComponent(langCode)}`);
      if (res.ok) {
        const data = await res.json();
        const results = (data.results || []).map((item) => ({
          id: item.id,
          label: `${item.language}${item.isHearingImpaired ? ' (SDH)' : ''}`,
          fileName: item.fileName,
          language: item.language,
          downloads: item.downloads,
          isHearingImpaired: item.isHearingImpaired,
          url: `http://localhost:3001/api/subtitles/download?url=${encodeURIComponent(item.downloadUrl)}`,
          isOnline: true,
          rating: item.rating,
        }));
        setOnlineSubtitles(results);

        // Auto-select the top result if no subtitle is selected yet
        if (!activeSubtitle && results.length > 0) {
          setActiveSubtitle(results[0]);
          setActionFeedback(`✓ Auto-loaded: ${results[0].label}`);
          setTimeout(() => setActionFeedback(''), 3500);
        }
      }
    } catch (err) {
      console.warn('Subtitle search failed:', err);
    } finally {
      setIsSearchingSubtitles(false);
    }
  };

  // Auto-search subtitles as soon as movie filename or title is resolved
  useEffect(() => {
    const title = status?.fileName || params.title;
    if (title && !hasAutoSearchedRef.current) {
      hasAutoSearchedRef.current = true;
      searchOnlineSubtitles(title, 'eng');
    }
  }, [status?.fileName, params.title]);

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
        // Auto-select optimal stream mode once we know the file type
        if (!hasAutoSelectedModeRef.current && data.fileName) {
          hasAutoSelectedModeRef.current = true;
          if (data.isNativeCompatible !== false) {
            // MP4/WebM: use direct seekable byte-range stream (no FFmpeg)
            setStreamMode('direct');
          } else {
            // MKV / other: use remux (FFmpeg fmp4 pipe)
            setStreamMode('remux');
          }
        }

        // Auto-force-play: if piece 0 has been ready for >3s and video hasn't
        // started (onCanPlay never fired), force-dismiss the overlay and play.
        if (data.hasFirstPiece) {
          if (!firstPieceReadyAtRef.current) {
            firstPieceReadyAtRef.current = Date.now();
          }
          const waitedMs = Date.now() - firstPieceReadyAtRef.current;
          if (waitedMs > 3000 && !forcePlayTimerRef.current) {
            forcePlayTimerRef.current = setTimeout(() => {
              setIsVideoLoading(false);
              const video = videoRef.current;
              if (video) {
                video.playbackRate = playbackSpeed;
                video.play().catch(() => {});
              }
            }, 500);
          }
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
  // 'direct' = native HTTP 206 byte-range stream (MP4/WebM, no FFmpeg, instant)
  // 'remux'  = FFmpeg fmp4 pipe (for MKV/TrueHD/DTS files)
  // '1080p' / '720p' / '480p' = hardware transcode
  const getStreamUrl = () => {
    const effectiveMagnet = status?.magnet || params.magnet;
    const infoHash = status?.infoHash;
    // Remux/transcode needs more than the first torrent piece because FFmpeg
    // must inspect MKV headers before it can emit the first MP4 fragment.
    const hasRemuxBuffer = (status?.downloaded || 0) >= 8 * 1024 * 1024;

    // Don't expose src until we have piece 0 + infoHash.
    // If we set src too early, the video element fires onerror immediately which
    // cascades: direct → remux → 1080p even for native MP4 files.
    if (!status?.hasFirstPiece || !infoHash) return '';
    if (streamMode !== 'direct' && !hasRemuxBuffer) return '';

    if (streamMode === 'direct') {
      return `http://localhost:3001/api/torrent/${infoHash}/stream`;
    } else if (streamMode === 'remux') {
      return `http://localhost:3001/api/stream/remux?mode=copy&attempt=${remuxAttempt}&magnet=${encodeURIComponent(effectiveMagnet)}`;
    } else if (streamMode === '1080p') {
      return `http://localhost:3001/api/stream/remux?mode=1080p&magnet=${encodeURIComponent(effectiveMagnet)}`;
    } else if (streamMode === '720p') {
      return `http://localhost:3001/api/stream/remux?mode=720p&magnet=${encodeURIComponent(effectiveMagnet)}`;
    } else if (streamMode === '480p') {
      return `http://localhost:3001/api/stream/remux?mode=480p&magnet=${encodeURIComponent(effectiveMagnet)}`;
    } else if (streamMode === 'browser4k') {
      return `http://localhost:3001/api/stream/remux?mode=browser4k&magnet=${encodeURIComponent(effectiveMagnet)}`;
    } else {
      // 'copy' legacy fallback
      return `http://localhost:3001/api/stream?raw=true&magnet=${encodeURIComponent(effectiveMagnet)}`;
    }
  };

  const streamUrl = getStreamUrl();
  const streamReady = Boolean(streamUrl);

  // Seamless Quality Switching (preserves playback position)
  const handleQualityChange = (newMode) => {
    if (newMode === streamMode) return;
    if (videoRef.current) {
      savedPositionRef.current = videoRef.current.currentTime || 0;
    }
    remuxFailureCountRef.current = 0;
    setStreamMode(newMode);
    setActionFeedback(`Switching quality to ${newMode.toUpperCase()}...`);
    setTimeout(() => setActionFeedback(''), 2500);
  };

  // Restore position and apply speed after quality switch or load
  const handleVideoCanPlay = () => {
    setIsVideoLoading(false);
    const video = videoRef.current;
    if (!video) return;

    if (savedPositionRef.current > 0) {
      video.currentTime = savedPositionRef.current;
      savedPositionRef.current = 0;
    }
    video.playbackRate = playbackSpeed;
  };

  const handleVideoError = (e) => {
    console.warn('Video element playback error:', e.nativeEvent?.message || e);
    if (streamMode === 'direct') {
      // Direct stream failed — try remux as fallback
      setActionFeedback('Direct stream unavailable — trying remux fallback...');
      setTimeout(() => handleQualityChange('remux'), 800);
    } else if (streamMode === 'remux') {
      // Retry remux while more torrent data arrives. Do not silently switch to
      // a lossy 1080p transcode; that is a manual user choice.
      remuxFailureCountRef.current += 1;
      if (remuxFailureCountRef.current <= 3) {
        setActionFeedback(`Remux is still buffering — retrying (${remuxFailureCountRef.current}/3)...`);
        setRemuxAttempt((attempt) => attempt + 1);
      } else {
        setActionFeedback('Safari cannot decode this 4K HEVC stream — switching to hardware 4K compatibility mode...');
        setTimeout(() => handleQualityChange('browser4k'), 500);
      }
    }
  };

  // Speed Control
  const handleSpeedChange = (speed) => {
    setPlaybackSpeed(speed);
    if (videoRef.current) {
      videoRef.current.playbackRate = speed;
    }
    setShowSpeedMenu(false);
    setActionFeedback(`Playback Speed: ${speed}x`);
    setTimeout(() => setActionFeedback(''), 2000);
  };

  // Subtitle selection & HTML5 textTrack mode sync
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (video.textTracks && video.textTracks.length > 0) {
      for (let i = 0; i < video.textTracks.length; i++) {
        video.textTracks[i].mode = activeSubtitle ? 'showing' : 'disabled';
      }
    }
  }, [activeSubtitle]);

  // Handle local subtitle file upload
  const handleSubtitleFileUpload = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const raw = event.target.result;
        const vtt = convertSrtToVtt(raw);
        const blob = new Blob([vtt], { type: 'text/vtt' });
        const url = URL.createObjectURL(blob);
        const newSub = {
          id: 'custom-' + Date.now(),
          label: file.name.replace(/\.[^/.]+$/, ''),
          url,
          isCustom: true,
        };
        setCustomSubtitles((prev) => [...prev, newSub]);
        setActiveSubtitle(newSub);
        setActionFeedback(`Loaded subtitles: ${file.name}`);
        setTimeout(() => setActionFeedback(''), 3000);
      } catch (err) {
        setActionFeedback('Failed to parse subtitle file');
      }
    };
    reader.readAsText(file);
  };

  // Keyboard controls for Cinema Player
  useEffect(() => {
    const handleKeyDown = (e) => {
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
      } else if (e.key === '[') {
        // Slow down speed
        e.preventDefault();
        const speeds = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
        const currIdx = speeds.indexOf(playbackSpeed);
        const nextIdx = Math.max(0, (currIdx === -1 ? 2 : currIdx) - 1);
        handleSpeedChange(speeds[nextIdx]);
      } else if (e.key === ']') {
        // Speed up
        e.preventDefault();
        const speeds = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
        const currIdx = speeds.indexOf(playbackSpeed);
        const nextIdx = Math.min(speeds.length - 1, (currIdx === -1 ? 2 : currIdx) + 1);
        handleSpeedChange(speeds[nextIdx]);
      } else if (e.key === '\\') {
        // Reset speed to 1.0x
        e.preventDefault();
        handleSpeedChange(1.0);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [playbackSpeed]);

  const handlePlayNative = async () => {
    const effectiveMagnet = status?.magnet || params.magnet;
    const targetId = status?.infoHash || 'stream';

    setActionFeedback('Launching in native player (VLC / IINA)...');
    try {
      const q = new URLSearchParams();
      if (effectiveMagnet) q.set('magnet', effectiveMagnet);

      const res = await fetch(`http://localhost:3001/api/torrent/${targetId}/play-native?${q.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ magnet: effectiveMagnet }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Could not launch native player');
      }
      setActionFeedback(`✓ Opened in ${data.player || 'VLC Media Player'}`);
      setTimeout(() => setActionFeedback(''), 4000);
    } catch (err) {
      setActionFeedback('Failed to open: ' + err.message);
      setTimeout(() => setActionFeedback(''), 4000);
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

  // Subtitles from swarm
  const swarmSubtitles = (status?.subtitleFiles || []).map((sub) => ({
    id: `swarm-${sub.index}`,
    label: sub.name.replace(/^.*[\\/]/, ''),
    fileName: sub.name.replace(/^.*[\\/]/, ''),
    url: `http://localhost:3001/api/torrent/${status.infoHash}/subtitle/${sub.index}`,
    isSwarm: true,
  }));

  const allSubtitles = [...onlineSubtitles, ...swarmSubtitles, ...customSubtitles];

  return (
    <div className="cinema-wrapper">
      {/* Hidden File Input for Custom Subtitle Upload */}
      <input
        type="file"
        ref={fileInputRef}
        style={{ display: 'none' }}
        accept=".srt,.vtt,.sub,.ass"
        onChange={handleSubtitleFileUpload}
      />

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
                {streamMode === 'direct'
                  ? '⚡ Native Direct Stream'
                  : streamMode === 'remux'
                  ? '💎 Lossless Remux'
                  : streamMode === '1080p'
                  ? '🎬 1080p Transcode'
                  : streamMode === '720p'
                  ? '📺 720p Balanced'
                  : streamMode === '480p'
                  ? '📱 480p Low Bandwidth'
                  : '📁 Stream'}
              </span>
              {playbackSpeed !== 1.0 && <span className="cinema-badge speed-badge">⚡ {playbackSpeed}x Speed</span>}
              {activeSubtitle && <span className="cinema-badge sub-badge">💬 {activeSubtitle.label}</span>}
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
            {/* Top Multi-Option Cinema Controls Strip */}
            <div className="cinema-controls-bar">
              {/* Quality Preset Selector */}
              <div className="control-group quality-group">
                <span className="control-label">QUALITY:</span>
                <div className="control-pill-group">
                  <button
                    className={`control-pill-btn ${streamMode === 'direct' ? 'active' : ''}`}
                    onClick={() => handleQualityChange('direct')}
                    title="Native direct stream — zero FFmpeg, instant playback, best for MP4/WebM"
                  >
                    ⚡ Direct
                  </button>
                  <button
                    className={`control-pill-btn ${streamMode === 'remux' ? 'active' : ''}`}
                    onClick={() => handleQualityChange('remux')}
                    title="Lossless FFmpeg remux to fMP4 — use for MKV/TrueHD/DTS files"
                  >
                    💎 Remux
                  </button>
                  <button
                    className={`control-pill-btn ${streamMode === '1080p' ? 'active' : ''}`}
                    onClick={() => handleQualityChange('1080p')}
                    title="Hardware transcoded 1080p"
                  >
                    1080p
                  </button>
                  <button
                    className={`control-pill-btn ${streamMode === '720p' ? 'active' : ''}`}
                    onClick={() => handleQualityChange('720p')}
                    title="Fast 720p balanced"
                  >
                    720p
                  </button>
                  <button
                    className={`control-pill-btn ${streamMode === '480p' ? 'active' : ''}`}
                    onClick={() => handleQualityChange('480p')}
                    title="Low bandwidth 480p"
                  >
                    480p
                  </button>
                </div>
              </div>

              {/* Playback Speed Selector */}
              <div className="control-group speed-group">
                <span className="control-label">SPEED:</span>
                <div className="control-pill-group">
                  {[0.5, 0.75, 1.0, 1.25, 1.5, 2.0].map((s) => (
                    <button
                      key={s}
                      className={`control-pill-btn ${playbackSpeed === s ? 'active' : ''}`}
                      onClick={() => handleSpeedChange(s)}
                    >
                      {s}x
                    </button>
                  ))}
                </div>
              </div>

              {/* Subtitles (CC) Selector */}
              <div className="control-group subtitle-group">
                <span className="control-label">SUBTITLES:</span>
                <div className="subtitle-selector-box">
                  <button
                    className={`control-pill-btn sub-toggle-btn ${activeSubtitle ? 'active' : ''}`}
                    onClick={() => setShowSubtitleMenu((prev) => !prev)}
                    title="Toggle Subtitle Selection Menu"
                  >
                    💬 {activeSubtitle ? activeSubtitle.label : 'Subtitles (Off)'} ▾
                  </button>

                  <button
                    className="control-pill-btn sub-upload-btn"
                    onClick={() => fileInputRef.current?.click()}
                    title="Upload external .srt or .vtt subtitle file"
                  >
                    + Upload .srt
                  </button>

                  {/* Subtitle Dropdown Menu */}
                  {showSubtitleMenu && (
                    <div className="subtitles-dropdown">
                      <div className="dropdown-header">
                        <span>Subtitles & Captions</span>
                        <button className="dropdown-close" onClick={() => setShowSubtitleMenu(false)}>✕</button>
                      </div>

                      {/* Search & Language Bar */}
                      <form
                        className="sub-search-bar"
                        onSubmit={(e) => {
                          e.preventDefault();
                          searchOnlineSubtitles(subtitleSearchQuery, subtitleLang);
                        }}
                      >
                        <input
                          type="text"
                          className="sub-search-input"
                          placeholder="Search movie / subtitles..."
                          value={subtitleSearchQuery}
                          onChange={(e) => setSubtitleSearchQuery(e.target.value)}
                        />
                        <select
                          className="sub-lang-select"
                          value={subtitleLang}
                          onChange={(e) => {
                            const newLang = e.target.value;
                            setSubtitleLang(newLang);
                            searchOnlineSubtitles(subtitleSearchQuery || status?.fileName || params.title, newLang);
                          }}
                          title="Filter subtitle language"
                        >
                          <option value="eng">EN (English)</option>
                          <option value="spa">ES (Spanish)</option>
                          <option value="fre">FR (French)</option>
                          <option value="ger">DE (German)</option>
                          <option value="ita">IT (Italian)</option>
                          <option value="por">PT (Portuguese)</option>
                          <option value="rus">RU (Russian)</option>
                          <option value="hin">HI (Hindi)</option>
                          <option value="chi">ZH (Chinese)</option>
                          <option value="jpn">JA (Japanese)</option>
                          <option value="all">All Languages</option>
                        </select>
                        <button type="submit" className="btn btn-secondary btn-sm" style={{ padding: '0.2rem 0.55rem', fontSize: '0.72rem' }}>
                          🔍
                        </button>
                      </form>

                      <div className="dropdown-list">
                        {/* Off option */}
                        <button
                          className={`dropdown-item ${!activeSubtitle ? 'selected' : ''}`}
                          onClick={() => {
                            setActiveSubtitle(null);
                            setShowSubtitleMenu(false);
                          }}
                        >
                          <div className="track-info-col">
                            <span className="track-name">None (Subtitles Off)</span>
                          </div>
                          {!activeSubtitle && <span className="check-mark">✓</span>}
                        </button>

                        {/* Online Subtitles Section */}
                        {isSearchingSubtitles && (
                          <div className="dropdown-empty">
                            <div className="spinner" style={{ width: '20px', height: '20px', margin: '0 auto 0.5rem' }}></div>
                            <span>Searching OpenSubtitles database...</span>
                          </div>
                        )}

                        {!isSearchingSubtitles && onlineSubtitles.length > 0 && (
                          <>
                            <div className="dropdown-section-title">🌐 Online Subtitles ({onlineSubtitles.length})</div>
                            {onlineSubtitles.map((sub) => (
                              <button
                                key={sub.id}
                                className={`dropdown-item ${activeSubtitle?.id === sub.id ? 'selected' : ''}`}
                                onClick={() => {
                                  setActiveSubtitle(sub);
                                  setShowSubtitleMenu(false);
                                  setActionFeedback(`Loaded: ${sub.label}`);
                                  setTimeout(() => setActionFeedback(''), 2500);
                                }}
                              >
                                <div className="track-info-col">
                                  <span className="track-name" title={sub.fileName}>
                                    {sub.fileName || sub.label}
                                  </span>
                                  <div className="track-meta-row">
                                    <span className="tag-badge tag-online">OpenSubtitles</span>
                                    {sub.isHearingImpaired && <span className="tag-badge tag-sdh">SDH</span>}
                                    {sub.downloads > 0 && (
                                      <span title="Total downloads">📥 {sub.downloads.toLocaleString()}</span>
                                    )}
                                    {sub.rating && sub.rating !== '0.0' && <span>⭐ {sub.rating}</span>}
                                  </div>
                                </div>
                                {activeSubtitle?.id === sub.id && <span className="check-mark">✓</span>}
                              </button>
                            ))}
                          </>
                        )}

                        {/* Swarm embedded subtitles if any */}
                        {swarmSubtitles.length > 0 && (
                          <>
                            <div className="dropdown-section-title">📁 Torrent Files ({swarmSubtitles.length})</div>
                            {swarmSubtitles.map((sub) => (
                              <button
                                key={sub.id}
                                className={`dropdown-item ${activeSubtitle?.id === sub.id ? 'selected' : ''}`}
                                onClick={() => {
                                  setActiveSubtitle(sub);
                                  setShowSubtitleMenu(false);
                                }}
                              >
                                <div className="track-info-col">
                                  <span className="track-name">{sub.label}</span>
                                  <div className="track-meta-row">
                                    <span className="tag-badge tag-torrent">Torrent Stream</span>
                                  </div>
                                </div>
                                {activeSubtitle?.id === sub.id && <span className="check-mark">✓</span>}
                              </button>
                            ))}
                          </>
                        )}

                        {/* Custom uploads if any */}
                        {customSubtitles.length > 0 && (
                          <>
                            <div className="dropdown-section-title">💾 Custom Files ({customSubtitles.length})</div>
                            {customSubtitles.map((sub) => (
                              <button
                                key={sub.id}
                                className={`dropdown-item ${activeSubtitle?.id === sub.id ? 'selected' : ''}`}
                                onClick={() => {
                                  setActiveSubtitle(sub);
                                  setShowSubtitleMenu(false);
                                }}
                              >
                                <div className="track-info-col">
                                  <span className="track-name">{sub.label}</span>
                                  <div className="track-meta-row">
                                    <span className="tag-badge tag-custom">Uploaded</span>
                                  </div>
                                </div>
                                {activeSubtitle?.id === sub.id && <span className="check-mark">✓</span>}
                              </button>
                            ))}
                          </>
                        )}

                        {!isSearchingSubtitles && allSubtitles.length === 0 && (
                          <div className="dropdown-empty">
                            <span>No subtitles found for this title.</span>
                            <button
                              className="btn btn-secondary btn-sm"
                              style={{ marginTop: '0.6rem' }}
                              onClick={() => {
                                setShowSubtitleMenu(false);
                                fileInputRef.current?.click();
                              }}
                            >
                              📂 Upload .srt / .vtt File
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Font Size & Upload Footer */}
                      <div className="dropdown-footer">
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <span className="footer-label">Size:</span>
                          <div className="size-btns">
                            <button
                              className={`size-btn ${subtitleSize === 'normal' ? 'active' : ''}`}
                              onClick={() => setSubtitleSize('normal')}
                            >
                              Normal
                            </button>
                            <button
                              className={`size-btn ${subtitleSize === 'large' ? 'active' : ''}`}
                              onClick={() => setSubtitleSize('large')}
                            >
                              Large
                            </button>
                            <button
                              className={`size-btn ${subtitleSize === 'xlarge' ? 'active' : ''}`}
                              onClick={() => setSubtitleSize('xlarge')}
                            >
                              XL
                            </button>
                          </div>
                        </div>

                        <button
                          className="btn btn-secondary btn-sm"
                          style={{ fontSize: '0.72rem', padding: '0.2rem 0.55rem' }}
                          onClick={() => {
                            setShowSubtitleMenu(false);
                            fileInputRef.current?.click();
                          }}
                          title="Upload your own subtitle file"
                        >
                          + Upload File
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Video Player Box */}
            <div className="cinema-player-frame">
              {status?.ready ? (
                <div className={`video-element-wrapper subtitle-style-${subtitleSize}`}>
                  {streamUrl && (
                    <video
                      ref={videoRef}
                      controls
                      playsInline
                      crossOrigin="anonymous"
                      className="cinema-video"
                      src={streamUrl}
                      onWaiting={() => setIsVideoLoading(true)}
                      onPlaying={() => setIsVideoLoading(false)}
                      onPlay={() => setIsVideoLoading(false)}
                      onLoadedData={() => setIsVideoLoading(false)}
                      onCanPlay={handleVideoCanPlay}
                      onError={handleVideoError}
                    >
                      {activeSubtitle && (
                        <track
                          key={activeSubtitle.url}
                          kind="subtitles"
                          src={activeSubtitle.url}
                          srcLang="en"
                          label={activeSubtitle.label}
                          default
                        />
                      )}
                      Your browser does not support HTML5 video playback.
                    </video>
                  )}

                  {isVideoLoading && (
                    <div className="video-loading-overlay">
                      <div className="buffer-telemetry-card">
                        <div className="buffer-telemetry-top">
                          <div className="buffer-spinner-glow"></div>
                          <div>
                            <h3 className="buffer-title">
                              {streamReady ? 'Ready to Play!' : 'Buffering BitTorrent Stream'}
                            </h3>
                            <p className="buffer-desc">
                              {streamReady
                                ? streamMode === 'direct'
                                  ? 'First piece downloaded — click Play or wait for auto-start'
                                  : 'First piece ready — FFmpeg starting stream...'
                                : 'Downloading first piece from swarm...'}
                            </p>
                          </div>
                        </div>

                        {/* Play Now CTA — shown once piece 0 is ready */}
                        {streamReady && (
                          <button
                            className="buffer-play-now-btn"
                            onClick={() => {
                              setIsVideoLoading(false);
                              const video = videoRef.current;
                              if (video) {
                                video.playbackRate = playbackSpeed;
                                video.play().catch(() => {});
                              }
                            }}
                          >
                            ▶ Play Now
                          </button>
                        )}

                        {/* Piece Progress Bar — shown while waiting for piece 0 */}
                        {!streamReady && (
                        <div className="buffer-piece-meter">
                          <div className="meter-label-row">
                            <span className="meter-main-text">
                              {`Piece #0: ${formatBytes(status?.firstPieceDownloaded || 0)} / ${formatBytes(status?.pieceLength || 16777216)} (${status?.firstPieceProgress || 0}%)`}
                            </span>
                            <span className="meter-speed-text">
                              ⚡ {formatBytes(status?.downloadSpeed || 0)}/s • {status?.numPeers || 0} peers
                              {status?.etaSeconds && status.etaSeconds > 0 ? ` • ~${status.etaSeconds}s ETA` : ''}
                            </span>
                          </div>
                          <div className="meter-bar-track">
                            <div
                              className="meter-bar-fill"
                              style={{
                                width: `${Math.max(status?.firstPieceProgress || 0, 8)}%`,
                              }}
                            ></div>
                          </div>
                        </div>
                        )}

                        {/* Speed + peers mini-stats when piece is ready */}
                        {streamReady && (
                          <div style={{ textAlign: 'center', fontSize: '0.72rem', color: 'rgba(255,255,255,0.45)', marginTop: '2px' }}>
                            ⚡ {formatBytes(status?.downloadSpeed || 0)}/s • {status?.numPeers || 0} peers
                          </div>
                        )}

                        {/* Fast Action: Native Desktop Player */}
                        <div className="buffer-native-shortcut">
                          <div className="shortcut-info">
                            <span className="shortcut-title">⚡ Want instant zero-wait playback?</span>
                            <span className="shortcut-sub">
                              Launch directly in IINA / VLC for immediate hardware acceleration with Dolby Vision & TrueHD Atmos.
                            </span>
                          </div>
                          <button
                            className="btn btn-primary btn-sm buffer-open-btn"
                            onClick={handlePlayNative}
                          >
                            ▶ Open in IINA / VLC
                          </button>
                        </div>

                        {/* Stream quality switcher if network speed is slow */}
                        <div className="buffer-quick-profiles">
                          <span className="profiles-label">Slow swarm? Switch stream profile:</span>
                          <div className="profiles-btns">
                            <button
                              className={`profile-chip ${streamMode === '1080p' ? 'active' : ''}`}
                              onClick={() => handleQualityChange('1080p')}
                            >
                              1080p Transcode
                            </button>
                            <button
                              className={`profile-chip ${streamMode === '720p' ? 'active' : ''}`}
                              onClick={() => handleQualityChange('720p')}
                            >
                              720p Fast
                            </button>
                            <button
                              className={`profile-chip ${streamMode === 'copy' ? 'active' : ''}`}
                              onClick={() => handleQualityChange('copy')}
                            >
                              💎 4K Remux
                            </button>
                          </div>
                        </div>
                      </div>
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
                    Zero pixel re-encoding in Remux mode. Full original HEVC/AVC bitrate streamed bit-for-bit directly into your browser, with 1080p, 720p, and 480p instant fallbacks.
                  </p>
                </div>
              </div>

              <div className="tech-banner-item">
                <span className="tech-icon">💬</span>
                <div>
                  <h4>Subtitles & Speed Control</h4>
                  <p>
                    Automatic extraction of torrent subtitles, local <kbd>.srt</kbd>/<kbd>.vtt</kbd> drag-and-drop upload, and multi-speed playback from <kbd>0.5x</kbd> up to <kbd>2.0x</kbd>.
                  </p>
                </div>
              </div>

              <div className="tech-banner-item">
                <span className="tech-icon">⌨️</span>
                <div>
                  <h4>Keyboard Shortcuts</h4>
                  <p>
                    <kbd>Space</kbd> Play/Pause &nbsp;•&nbsp; <kbd>←</kbd> <kbd>→</kbd> Seek 10s &nbsp;•&nbsp; <kbd>[</kbd> <kbd>]</kbd> Speed &nbsp;•&nbsp; <kbd>\</kbd> Reset &nbsp;•&nbsp; <kbd>F</kbd> Fullscreen
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
