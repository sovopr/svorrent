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
  const isSafariBrowser = /safari/i.test(navigator.userAgent) && !/chrome|chromium|android/i.test(navigator.userAgent);

  // Quality / Stream Mode: 'auto' | 'direct' | 'remux' | '1080p' | '720p' | '480p'
  const [streamMode, setStreamMode] = useState('auto');
  const [effectiveAutoProfile, setEffectiveAutoProfile] = useState('remux');
  const [bufferHealthSec, setBufferHealthSec] = useState(0);
  const [isRebuffering, setIsRebuffering] = useState(false);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [actionFeedback, setActionFeedback] = useState('');
  const [showNerdModal, setShowNerdModal] = useState(false);
  const [isVideoLoading, setIsVideoLoading] = useState(true);
  const [remuxAttempt, setRemuxAttempt] = useState(0);
  const hasAutoSelectedModeRef = useRef(false);
  const remuxFailureCountRef = useRef(0);
  const recoveryTimerRef = useRef(null);

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
  const playbackOffsetRef = useRef(0); // Stream start offset for seamless seek & quality transitions
  const seekTimeRef = useRef(0); // Stable requested start timestamp (only changes on seek / quality change, never on ongoing playback ticks)
  const stallTimerRef = useRef(null); // Auto-downgrade timer when playback gets stuck
  const lastStallTimeRef = useRef(0);
  const forcePlayTimerRef = useRef(null); // Auto-dismiss overlay if video stalls
  const firstPieceReadyAtRef = useRef(null); // Timestamp when piece 0 was first seen
  const userPausedRef = useRef(false);
  const lastAutoSwitchRef = useRef(0);
  const smoothedSpeedRef = useRef(0);
  const autoProfileInitializedRef = useRef(false);
  const scrubberRef = useRef(null);
  const idleTimerRef = useRef(null);

  // YouTube Timeline Scrubber State
  const [currentTime, setCurrentTime] = useState(0);
  const [isPaused, setIsPaused] = useState(true);
  const [hoverTime, setHoverTime] = useState(null);
  const [hoverPos, setHoverPos] = useState(0);
  const [isUserIdle, setIsUserIdle] = useState(false);

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
        const ct = videoRef.current ? (videoRef.current.currentTime || 0) : 0;
        q.set('currentTime', String(ct));
        q.set('paused', String(!!userPausedRef.current));

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
        if (data.fileName && !hasAutoSelectedModeRef.current) {
          hasAutoSelectedModeRef.current = true;
          // Auto remains active by default
        }

        // Adaptive Buffer Safety Runway:
        // Wait until an uninterrupted safety runway is accumulated to prevent stuttering.
        if (data.isRunwaySafe || (data.hasFirstPiece && (data.downloadSpeed || 0) > 2500000)) {
          if (!firstPieceReadyAtRef.current) {
            firstPieceReadyAtRef.current = Date.now();
          }
          const waitedMs = Date.now() - firstPieceReadyAtRef.current;
          if (waitedMs > 1200 && !forcePlayTimerRef.current) {
            forcePlayTimerRef.current = setTimeout(() => {
              setIsVideoLoading(false);
              const video = videoRef.current;
              if (video && !userPausedRef.current) {
                video.playbackRate = playbackSpeed;
                video.play().catch(() => {});
              }
            }, 300);
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

  // Dynamic ABR: Real-time Auto Quality Upgrade & Downgrade (YouTube Style)
  useEffect(() => {
    if (!status || streamMode !== 'auto') return;

    // Smooth download speed to prevent rapid jitter
    const currentSpeed = status.downloadSpeed || 0;
    if (smoothedSpeedRef.current === 0) {
      smoothedSpeedRef.current = currentSpeed;
    } else {
      smoothedSpeedRef.current = 0.7 * smoothedSpeedRef.current + 0.3 * currentSpeed;
    }
    const effSpeed = smoothedSpeedRef.current;
    const now = Date.now();

    // 1. Initial resolution on load
    if (!autoProfileInitializedRef.current) {
      autoProfileInitializedRef.current = true;
      let initialTarget = 'remux';
      if (status.isNativeCompatible) {
        initialTarget = 'direct';
      } else if (status.isBandwidthConstrained || effSpeed < 1200000) {
        initialTarget = effSpeed > 650000 ? '1080p' : '720p';
      }
      setEffectiveAutoProfile(initialTarget);
      lastAutoSwitchRef.current = now;
      return;
    }

    // 2. Real-time Emergency DOWNGRADE (when buffer health drops below 2.5s or during rebuffering)
    if (bufferHealthSec < 2.5 || isRebuffering) {
      if (now - lastAutoSwitchRef.current > 7000) { // 7s cooldown for emergency downgrade
        let lower = effectiveAutoProfile;
        if (effectiveAutoProfile === 'remux' || effectiveAutoProfile === 'browser4k') {
          lower = effSpeed > 750000 ? '1080p' : '720p';
        } else if (effectiveAutoProfile === '1080p') {
          lower = '720p';
        } else if (effectiveAutoProfile === '720p' && effSpeed < 300000) {
          lower = '480p';
        }

        if (lower !== effectiveAutoProfile) {
          const cur = (playbackOffsetRef.current || 0) + (videoRef.current?.currentTime || 0);
          if (cur > 0) {
            savedPositionRef.current = cur;
            seekTimeRef.current = Math.floor(cur);
            playbackOffsetRef.current = Math.floor(cur);
          }
          lastAutoSwitchRef.current = now;
          lastStallTimeRef.current = now;
          setEffectiveAutoProfile(lower);
          setActionFeedback(`⚡ Swarm bottleneck: auto-downgraded to ${lower.toUpperCase()} for uninterrupted streaming`);
          setTimeout(() => setActionFeedback(''), 3000);
          return;
        }
      }
    }

    // 3. Opportunistic UPGRADE (when buffer runway is abundant > 15s and speed is sustained)
    if (bufferHealthSec > 15.0 && now - lastStallTimeRef.current > 20000 && now - lastAutoSwitchRef.current > 20000) {
      let higher = effectiveAutoProfile;
      if (effectiveAutoProfile === '480p' && effSpeed > 500000) {
        higher = '720p';
      } else if (effectiveAutoProfile === '720p' && effSpeed > 1400000) {
        higher = '1080p';
      } else if (effectiveAutoProfile === '1080p' && effSpeed > 3000000 && !status.isBandwidthConstrained) {
        higher = 'remux';
      }

      if (higher !== effectiveAutoProfile) {
        const cur = (playbackOffsetRef.current || 0) + (videoRef.current?.currentTime || 0);
        if (cur > 0) {
          savedPositionRef.current = cur;
          seekTimeRef.current = Math.floor(cur);
          playbackOffsetRef.current = Math.floor(cur);
        }
        lastAutoSwitchRef.current = now;
        setEffectiveAutoProfile(higher);
        setActionFeedback(`⚡ Buffer healthy (${bufferHealthSec}s): auto-upgraded to ${higher.toUpperCase()}`);
        setTimeout(() => setActionFeedback(''), 3000);
      }
    }
  }, [
    status?.isNativeCompatible,
    status?.isBandwidthConstrained,
    status?.downloadSpeed,
    bufferHealthSec,
    isRebuffering,
    streamMode,
    effectiveAutoProfile,
  ]);

  // YouTube-Style Buffer Health Monitor & Rebuffering Cushion Controller
  useEffect(() => {
    const interval = setInterval(() => {
      const video = videoRef.current;
      if (!video || !video.buffered || !video.buffered.length) {
        setBufferHealthSec(0);
        return;
      }
      const ct = video.currentTime || 0;
      let ahead = 0;
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= ct + 0.3 && ct <= video.buffered.end(i)) {
          ahead = video.buffered.end(i) - ct;
          break;
        }
      }
      const aheadSec = Number(ahead.toFixed(1));
      setBufferHealthSec(aheadSec);

      // If rebuffering after an underrun, wait until cushion reaches 5.5 seconds!
      if (isRebuffering) {
        const minCushion = (status?.isRunwaySafe && (status?.downloadSpeed || 0) > 2000000) ? 3.0 : 5.5;
        if (aheadSec >= minCushion || (status?.isRunwaySafe && aheadSec >= 2.5)) {
          setIsRebuffering(false);
          setIsVideoLoading(false);
          if (video.paused && !userPausedRef.current) {
            video.play().catch(() => {});
          }
        }
      }
    }, 250);

    return () => clearInterval(interval);
  }, [isRebuffering, status?.isRunwaySafe, status?.downloadSpeed]);

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
    const activeMode = streamMode === 'auto' ? effectiveAutoProfile : streamMode;
    if (!status?.hasFirstPiece || !infoHash) return '';
    if (activeMode !== 'direct' && !hasRemuxBuffer) return '';

    // Stable startSec: ONLY changes when explicitly seeking or switching quality, NEVER on ongoing playback ticks
    const startSec = Math.floor(seekTimeRef.current || 0);
    const startParam = startSec > 0 ? `&startTime=${startSec}` : '';

    if (activeMode === 'direct') {
      return `http://localhost:3001/api/torrent/${infoHash}/stream`;
    } else if (activeMode === 'remux') {
      return `http://localhost:3001/api/stream/remux?mode=copy&attempt=${remuxAttempt}${startParam}&magnet=${encodeURIComponent(effectiveMagnet)}`;
    } else if (activeMode === '1080p') {
      return `http://localhost:3001/api/stream/remux?mode=1080p&attempt=${remuxAttempt}${startParam}&magnet=${encodeURIComponent(effectiveMagnet)}`;
    } else if (activeMode === '720p') {
      return `http://localhost:3001/api/stream/remux?mode=720p&attempt=${remuxAttempt}${startParam}&magnet=${encodeURIComponent(effectiveMagnet)}`;
    } else if (activeMode === '480p') {
      return `http://localhost:3001/api/stream/remux?mode=480p&attempt=${remuxAttempt}${startParam}&magnet=${encodeURIComponent(effectiveMagnet)}`;
    } else if (activeMode === 'browser4k') {
      return `http://localhost:3001/api/stream/remux?mode=browser4k&attempt=${remuxAttempt}${startParam}&magnet=${encodeURIComponent(effectiveMagnet)}`;
    } else {
      return `http://localhost:3001/api/stream?raw=true&magnet=${encodeURIComponent(effectiveMagnet)}`;
    }
  };

  const streamUrl = getStreamUrl();
  const streamReady = Boolean(streamUrl);

  // Universal Media Duration (probed dynamically for ANY video from container or HTML5 element)
  const movieDuration = (status?.duration && status.duration > 10)
    ? status.duration
    : (videoRef.current?.duration && isFinite(videoRef.current.duration) && videoRef.current.duration > 10)
    ? videoRef.current.duration
    : 0;

  // Format Time Helper (HH:MM:SS or MM:SS) like YouTube
  const formatTime = (seconds, isTotal = false) => {
    if (seconds === undefined || seconds === null || isNaN(seconds) || seconds < 0) {
      return isTotal ? '--:--' : '0:00';
    }
    if (isTotal && seconds <= 0) return '--:--';
    const totalSec = Math.floor(seconds);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0 || (movieDuration >= 3600)) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // Scrubber progress percentages
  const playPct = movieDuration > 0 ? (currentTime / movieDuration) * 100 : 0;

  // Browser HTML5 video buffer
  let browserBufferedSec = 0;
  const vEl = videoRef.current;
  if (vEl && vEl.buffered && vEl.buffered.length > 0) {
    for (let i = 0; i < vEl.buffered.length; i++) {
      const s = vEl.buffered.start(i);
      const e = vEl.buffered.end(i);
      if (s <= currentTime + 2 && currentTime <= e + 2) {
        browserBufferedSec = Math.max(browserBufferedSec, e);
      }
    }
    if (browserBufferedSec === 0) {
      browserBufferedSec = vEl.buffered.end(vEl.buffered.length - 1);
    }
  }

  // P2P Swarm RAM Runway buffer (pieces downloaded into memory directly ahead of playhead)
  const ramRunwayBytes = (status?.runwayPiecesReady || 0) * (status?.pieceLength || 0);
  const bytesPerSec = (movieDuration > 0 && status?.length > 0) ? status.length / movieDuration : 0;
  const ramRunwaySec = bytesPerSec > 0 ? ramRunwayBytes / bytesPerSec : 0;
  const totalBufferedAheadSec = Math.max(browserBufferedSec, currentTime + ramRunwaySec);

  // The YouTube Grey Buffer Bar percentage (universal across any video):
  const bufferPct = movieDuration > 0
    ? Math.min(100, Math.max(playPct, (totalBufferedAheadSec / movieDuration) * 100))
    : 0;

  // Toggle Play / Pause like YouTube
  const togglePlayPause = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      userPausedRef.current = false;
      setIsPaused(false);
      video.play().catch(() => {});
    } else {
      userPausedRef.current = true;
      setIsPaused(true);
      video.pause();
    }
  };

  // Fullscreen on Double Click
  const handleVideoDoubleClick = () => {
    const frame = document.querySelector('.cinema-player-frame');
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else if (frame) {
      frame.requestFullscreen().catch(() => {});
    }
  };

  // YouTube Scrubber Click & Seek
  const handleScrubberClick = (e) => {
    if (!scrubberRef.current || !movieDuration) return;
    const rect = scrubberRef.current.getBoundingClientRect();
    const clickX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const targetPct = clickX / rect.width;
    const targetTime = Math.floor(targetPct * movieDuration);

    const video = videoRef.current;
    if (!video) return;

    savedPositionRef.current = targetTime;
    setCurrentTime(targetTime);

    if (streamMode === 'direct') {
      video.currentTime = targetTime;
    } else {
      seekTimeRef.current = targetTime;
      playbackOffsetRef.current = targetTime;
      setRemuxAttempt((prev) => prev + 1);
    }
  };

  // Scrubber Hover Tooltip
  const handleScrubberHover = (e) => {
    if (!scrubberRef.current || !movieDuration) return;
    const rect = scrubberRef.current.getBoundingClientRect();
    const hoverX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const pct = (hoverX / rect.width) * 100;
    const time = (hoverX / rect.width) * movieDuration;
    setHoverPos(pct);
    setHoverTime(time);
  };

  // Auto-hide controls when user is idle
  const handleMouseMovePlayer = () => {
    setIsUserIdle(false);
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    if (!userPausedRef.current) {
      idleTimerRef.current = setTimeout(() => {
        setIsUserIdle(true);
      }, 3000);
    }
  };

  // Seamless Quality Switching (preserves exact playback position)
  const handleQualityChange = (newMode) => {
    if (newMode === streamMode && streamMode !== 'auto') return;
    const cur = (playbackOffsetRef.current || 0) + (videoRef.current?.currentTime || 0);
    if (cur > 0) {
      savedPositionRef.current = cur;
      seekTimeRef.current = Math.floor(cur);
      playbackOffsetRef.current = Math.floor(cur);
    }
    remuxFailureCountRef.current = 0;
    if (recoveryTimerRef.current) {
      clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
    setStreamMode(newMode);
    if (newMode === 'auto') {
      setEffectiveAutoProfile('720p');
    }
    setActionFeedback(`Switching quality to ${newMode.toUpperCase()}...`);
    setTimeout(() => setActionFeedback(''), 2500);
  };

  // Restore position and apply speed after quality switch or load
  const handleVideoCanPlay = () => {
    setIsVideoLoading(false);
    setIsRebuffering(false);
    const video = videoRef.current;
    if (!video) return;

    if (streamMode === 'direct' && savedPositionRef.current > 0) {
      video.currentTime = savedPositionRef.current;
    }
    video.playbackRate = playbackSpeed;
    if (video.paused && !userPausedRef.current) {
      video.play().catch(() => {});
    }
  };

  const handleVideoError = (e) => {
    console.warn('Video element playback error:', e.nativeEvent?.message || e);
    if (forcePlayTimerRef.current) {
      clearTimeout(forcePlayTimerRef.current);
      forcePlayTimerRef.current = null;
    }
    const cur = (playbackOffsetRef.current || 0) + (videoRef.current?.currentTime || 0);
    if (cur > 0) {
      savedPositionRef.current = cur;
      seekTimeRef.current = Math.floor(cur);
      playbackOffsetRef.current = Math.floor(cur);
    }
    if (streamMode === 'direct') {
      setActionFeedback('Direct stream unavailable — switching to remux fallback...');
      setTimeout(() => handleQualityChange('remux'), 800);
    } else {
      remuxFailureCountRef.current += 1;
      if (remuxFailureCountRef.current <= 2) {
        setActionFeedback('Catching up with buffer runway — resuming...');
        recoveryTimerRef.current = setTimeout(() => {
          recoveryTimerRef.current = null;
          setRemuxAttempt((attempt) => attempt + 1);
        }, 2000);
      } else {
        // If repeatedly stalling, auto-downgrade to 720p
        setActionFeedback('⚡ Swarm bottleneck: auto-switching to 720p to eliminate buffering...');
        setTimeout(() => handleQualityChange('720p'), 1000);
      }
    }
  };

  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;
    const actual = (playbackOffsetRef.current || 0) + (video.currentTime || 0);
    setCurrentTime(actual);
    savedPositionRef.current = actual;
  };

  const handleWaiting = () => {
    setIsVideoLoading(true);
    setIsRebuffering(true);
    lastStallTimeRef.current = Date.now();
    // In auto mode, if stalled for > 3.5s, auto-downgrade to unfreeze
    if (streamMode === 'auto' && !stallTimerRef.current) {
      stallTimerRef.current = setTimeout(() => {
        stallTimerRef.current = null;
        if (effectiveAutoProfile === 'remux' || effectiveAutoProfile === 'browser4k' || effectiveAutoProfile === '1080p') {
          handleQualityChange('720p');
        } else if (effectiveAutoProfile === '720p') {
          handleQualityChange('480p');
        }
      }, 3500);
    }
  };

  const handlePlaying = () => {
    setIsVideoLoading(false);
    setIsRebuffering(false);
    setIsPaused(false);
    if (stallTimerRef.current) {
      clearTimeout(stallTimerRef.current);
      stallTimerRef.current = null;
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

      if (e.code === 'Space' || e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        togglePlayPause();
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

  const overallProgressPct = Math.round((status?.progress || 0) * 100);

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
                  ? `💎 Browser Remux${status?.sourceContainer ? ` · source .${status.sourceContainer}` : ''}`
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
              <span className="hud-val">{overallProgressPct}%</span>
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
                    className={`control-pill-btn ${streamMode === 'auto' ? 'active' : ''}`}
                    onClick={() => handleQualityChange('auto')}
                    title="YouTube-Style Adaptive Bitrate — automatically adjusts quality based on swarm throughput to eliminate all buffering"
                  >
                    ⚡ Auto {streamMode === 'auto' && effectiveAutoProfile ? `(${effectiveAutoProfile.toUpperCase()})` : ''}
                  </button>
                  <button
                    className={`control-pill-btn ${streamMode === 'direct' ? 'active' : ''}`}
                    onClick={() => handleQualityChange('direct')}
                    disabled={status?.isNativeCompatible === false}
                    title="Native direct stream — zero FFmpeg, instant playback, best for MP4/WebM"
                  >
                    ⚡ Direct
                  </button>
                  <button
                    className={`control-pill-btn ${streamMode === 'remux' ? 'active' : ''}`}
                    onClick={() => handleQualityChange('remux')}
                    title="Browser playback adapter — keeps the source video intact and only repackages unsupported containers"
                  >
                    💎 Source
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

                {/* YouTube Buffer Health Live Gauge */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '4px 10px',
                  borderRadius: '6px',
                  background: bufferHealthSec > 12 ? 'rgba(16, 185, 129, 0.15)' : bufferHealthSec > 4 ? 'rgba(59, 130, 246, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                  border: `1px solid ${bufferHealthSec > 12 ? 'rgba(16, 185, 129, 0.4)' : bufferHealthSec > 4 ? 'rgba(59, 130, 246, 0.4)' : 'rgba(239, 68, 68, 0.4)'}`,
                  color: bufferHealthSec > 12 ? '#34d399' : bufferHealthSec > 4 ? '#60a5fa' : '#f87171',
                  fontSize: '0.74rem',
                  fontWeight: '600',
                  marginLeft: '8px',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.2)'
                }}>
                  <span style={{
                    display: 'inline-block',
                    width: '7px',
                    height: '7px',
                    borderRadius: '50%',
                    background: bufferHealthSec > 12 ? '#34d399' : bufferHealthSec > 4 ? '#60a5fa' : '#f87171',
                    boxShadow: `0 0 6px ${bufferHealthSec > 12 ? '#34d399' : bufferHealthSec > 4 ? '#60a5fa' : '#f87171'}`
                  }}></span>
                  <span>Buffer: {bufferHealthSec}s</span>
                  {isRebuffering && (
                    <span style={{ color: '#fbbf24', marginLeft: '4px', fontSize: '0.7rem' }}>(Cushioning...)</span>
                  )}
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

            {/* Bandwidth Bottleneck Warning Banner */}
            {status?.isBandwidthConstrained && streamMode === 'remux' && (
              <div style={{
                margin: '8px 16px 12px 16px',
                padding: '10px 16px',
                borderRadius: '10px',
                background: 'rgba(234, 179, 8, 0.12)',
                border: '1px solid rgba(234, 179, 8, 0.35)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontSize: '0.82rem',
                color: '#fef08a'
              }}>
                <div>
                  <strong>⚡ Swarm Bottleneck:</strong> Swarm speed ({formatBytes(status.downloadSpeed)}/s) is lower than this {formatBytes(status.length)} BluRay's bitrate (~{formatBytes(status.requiredBitrateBytesPerSec)}/s).
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    className="control-pill-btn"
                    style={{ background: '#eab308', color: '#000', fontWeight: 'bold', padding: '5px 12px', fontSize: '0.75rem' }}
                    onClick={() => handleQualityChange('1080p')}
                  >
                    Switch to 1080p Smooth
                  </button>
                  <button
                    className="control-pill-btn"
                    style={{ padding: '5px 12px', fontSize: '0.75rem' }}
                    onClick={() => handleQualityChange('720p')}
                  >
                    Switch to 720p Fast
                  </button>
                </div>
              </div>
            )}

            {/* Video Player Box */}
            <div className="cinema-player-frame">
              {status?.ready ? (
                <div
                  className={`video-element-wrapper subtitle-style-${subtitleSize} ${isUserIdle ? 'user-idle' : ''} ${isPaused ? 'paused' : ''}`}
                  onMouseMove={handleMouseMovePlayer}
                  onMouseLeave={() => !userPausedRef.current && setIsUserIdle(true)}
                >
                  {streamUrl && (
                    <video
                      ref={videoRef}
                      controls={false}
                      playsInline
                      crossOrigin="anonymous"
                      preload="auto"
                      className="cinema-video"
                      src={streamUrl}
                      onClick={togglePlayPause}
                      onDoubleClick={handleVideoDoubleClick}
                      onTimeUpdate={handleTimeUpdate}
                      onWaiting={handleWaiting}
                      onPlaying={handlePlaying}
                      onPlay={() => {
                        userPausedRef.current = false;
                        setIsPaused(false);
                        setIsVideoLoading(false);
                      }}
                      onPause={() => {
                        setIsPaused(true);
                      }}
                      onLoadedData={() => {
                        setIsVideoLoading(false);
                      }}
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

                  {/* YouTube Center Buffering Spinner (NO DIALOG BOX) */}
                  {isVideoLoading && !userPausedRef.current && (
                    <div className="yt-center-spinner">
                      <div className="yt-spinner-ring"></div>
                    </div>
                  )}

                  {/* YouTube Player Control Bar & Scrubber */}
                  <div className="yt-scrubber-wrapper">
                    {/* YouTube Scrubber Timeline Bar */}
                    <div
                      className="yt-progress-container"
                      ref={scrubberRef}
                      onClick={handleScrubberClick}
                      onMouseMove={handleScrubberHover}
                      onMouseLeave={() => setHoverTime(null)}
                    >
                      <div className="yt-progress-bg">
                        {/* THE YOUTUBE GREY BUFFER BAR */}
                        <div
                          className="yt-progress-buffer"
                          style={{ width: `${Math.min(100, Math.max(0, bufferPct))}%` }}
                        />
                        {/* THE YOUTUBE RED PLAYED BAR */}
                        <div
                          className="yt-progress-played"
                          style={{ width: `${Math.min(100, Math.max(0, playPct))}%` }}
                        >
                          <div className="yt-scrubber-thumb" />
                        </div>
                      </div>

                      {/* Hover Timestamp Tooltip */}
                      {hoverTime !== null && (
                        <div
                          className="yt-time-tooltip"
                          style={{ left: `${hoverPos}%` }}
                        >
                          {formatTime(hoverTime)}
                        </div>
                      )}
                    </div>

                    {/* YouTube Controls Row */}
                    <div className="yt-controls-row">
                      <div className="yt-controls-left">
                        <button
                          className="yt-btn"
                          onClick={togglePlayPause}
                          title={isPaused ? 'Play (Space / k)' : 'Pause (Space / k)'}
                        >
                          {isPaused ? '▶' : '❚❚'}
                        </button>

                        <button
                          className="yt-btn"
                          onClick={() => {
                            if (videoRef.current) {
                              videoRef.current.muted = !videoRef.current.muted;
                            }
                          }}
                          title="Mute / Unmute (m)"
                        >
                          {videoRef.current?.muted ? '🔇' : '🔊'}
                        </button>

                        {/* Exact Movie Duration Timecode */}
                        <div className="yt-time-display">
                          <span>{formatTime(currentTime)}</span>
                          <span style={{ margin: '0 4px', opacity: 0.6 }}>/</span>
                          <span>{formatTime(movieDuration, true)}</span>
                        </div>

                        {/* Real-time Buffer Runway Pill */}
                        <div className="yt-buffer-badge" title="Active forward buffer runway in RAM">
                          <span style={{
                            display: 'inline-block',
                            width: '6px',
                            height: '6px',
                            borderRadius: '50%',
                            background: bufferHealthSec > 10 ? '#34d399' : bufferHealthSec > 4 ? '#60a5fa' : '#fbbf24',
                            marginRight: '6px'
                          }}></span>
                          <span>Buffer: {bufferHealthSec}s</span>
                          {userPausedRef.current && (
                            <span style={{ color: '#38bdf8', marginLeft: '6px' }}>⚡ Buffering in RAM...</span>
                          )}
                        </div>
                      </div>

                      <div className="yt-controls-right">
                        {/* Quality Selector Badge */}
                        <div
                          className="yt-quality-badge"
                          onClick={() => handleQualityChange(streamMode === 'auto' ? '1080p' : streamMode === '1080p' ? '720p' : 'auto')}
                          title="Click to cycle video quality"
                        >
                          ⚡ {streamMode === 'auto' ? `Auto (${effectiveAutoProfile.toUpperCase()})` : streamMode.toUpperCase()}
                        </div>

                        {/* Subtitles CC Button */}
                        <button
                          className={`yt-btn ${activeSubtitle ? 'yt-active' : ''}`}
                          onClick={() => setShowSubtitleMenu((prev) => !prev)}
                          title="Subtitles / Captions (c)"
                        >
                          💬 CC
                        </button>

                        {/* Speed Button */}
                        <button
                          className="yt-btn yt-speed-btn"
                          onClick={() => {
                            const speeds = [0.75, 1.0, 1.25, 1.5, 2.0];
                            const currIdx = speeds.indexOf(playbackSpeed);
                            const next = speeds[(currIdx + 1) % speeds.length];
                            handleSpeedChange(next);
                          }}
                          title="Playback Speed ([ / ])"
                        >
                          {playbackSpeed}x
                        </button>

                        {/* Fullscreen Button */}
                        <button
                          className="yt-btn"
                          onClick={handleVideoDoubleClick}
                          title="Fullscreen (f)"
                        >
                          ⛶
                        </button>
                      </div>
                    </div>
                  </div>
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
                      ? `Found ${status.numPeers} swarm peers. Buffering initial sequential pieces (${overallProgressPct}% complete)...`
                      : 'Searching swarm DHT and announcing to trackers for high-speed seeders...'}
                  </p>

                  <div className="cinema-buffer-progress">
                    <div className="progress-bar-bg">
                      <div
                        className="progress-bar-fill"
                        style={{ width: `${Math.max(overallProgressPct, 6)}%` }}
                      ></div>
                    </div>
                    <div className="progress-labels">
                      <span>Sequential Swarm Buffer</span>
                      <span>{overallProgressPct}% ({formatBytes(status?.downloaded || 0)})</span>
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
