import assert from 'node:assert/strict';
import test from 'node:test';
import { setTorrentPaused, installSwarmPipelineAccelerator, updateCriticalFrontier } from '../lib/torrents.js';

test('setTorrentPaused preserves known peers and resets queue on pause, then redials on resume', () => {
  const redialedPeers = [];
  const destroyedWires = [];
  const destroyedPeers = [];
  let pauseCalled = false;
  let resumeCalled = false;
  let announceStarted = false;

  const mockTorrent = {
    paused: false,
    _pausedManually: false,
    _knownPeers: new Set(['1.1.1.1:51413']),
    wires: [
      { remoteAddress: '2.2.2.2', remotePort: 6881, destroy: () => destroyedWires.push('2.2.2.2:6881') },
    ],
    _peers: new Map([
      ['3.3.3.3:8000', { addr: '3.3.3.3:8000', destroy: () => destroyedPeers.push('3.3.3.3:8000') }],
    ]),
    _queue: ['old-queued-peer'],
    _numPending: 15,
    pause: () => { pauseCalled = true; },
    resume: () => { resumeCalled = true; },
    addPeer: (addr) => { redialedPeers.push(addr); return true; },
    discovery: {
      tracker: {
        _trackers: [{ announce: () => { announceStarted = true; } }],
        _defaultAnnounceOpts: (o) => o,
      },
    },
  };

  // 1. Pause
  setTorrentPaused(mockTorrent, true);
  assert.equal(pauseCalled, true);
  assert.equal(mockTorrent._pausedManually, true);
  assert.equal(destroyedWires.length, 1);
  assert.equal(destroyedPeers.length, 1);
  assert.equal(mockTorrent._queue.length, 0);
  assert.equal(mockTorrent._numPending, 0);
  assert.equal(mockTorrent._peers.size, 0);

  // Verify all peers were captured into knownPeers before destruction
  assert.ok(mockTorrent._knownPeers.has('1.1.1.1:51413'));
  assert.ok(mockTorrent._knownPeers.has('2.2.2.2:6881'));
  assert.ok(mockTorrent._knownPeers.has('3.3.3.3:8000'));

  // 2. Resume
  setTorrentPaused(mockTorrent, false);
  assert.equal(resumeCalled, true);
  assert.equal(mockTorrent._pausedManually, false);
  assert.ok(redialedPeers.includes('1.1.1.1:51413'));
  assert.ok(redialedPeers.includes('2.2.2.2:6881'));
  assert.ok(redialedPeers.includes('3.3.3.3:8000'));
  assert.equal(announceStarted, true);
});

test('installSwarmPipelineAccelerator boosts pipeline speed lookups while preserving real downloadSpeed for ranker/telemetry', () => {
  const wire = {
    type: 'tcp',
    downloadSpeed: () => 20 * 1024, // 20 KB/s real speed
  };

  const observedUpdateSpeeds = [];
  const observedRequestSpeeds = [];

  const mockTorrent = {
    _updateWire(w) {
      // Simulate getBlockPipelineLength min & max (first 2 calls), then speedRanker (3rd call)
      observedUpdateSpeeds.push(w.downloadSpeed());
      observedUpdateSpeeds.push(w.downloadSpeed());
      observedUpdateSpeeds.push(w.downloadSpeed());
      this._request(w, 0, false);
    },
    _request(w) {
      // Simulate getBlockPipelineLength max (1st call), then _hotswap (2nd call)
      observedRequestSpeeds.push(w.downloadSpeed());
      observedRequestSpeeds.push(w.downloadSpeed());
    },
  };

  installSwarmPipelineAccelerator(mockTorrent);
  mockTorrent._updateWire(wire);

  // First 2 calls in _updateWire are boosted to >= 256 KB/s; 3rd call (speedRanker) sees real 20 KB/s
  assert.equal(observedUpdateSpeeds[0], 256 * 1024);
  assert.equal(observedUpdateSpeeds[1], 256 * 1024);
  assert.equal(observedUpdateSpeeds[2], 20 * 1024);

  // First call in _request is boosted to >= 256 KB/s; 2nd call (_hotswap) sees real 20 KB/s
  assert.equal(observedRequestSpeeds[0], 256 * 1024);
  assert.equal(observedRequestSpeeds[1], 20 * 1024);

  // Outside _updateWire, telemetry always sees real 20 KB/s
  assert.equal(wire.downloadSpeed(), 20 * 1024);

  // Calling wire.downloadSpeed(bytes) forwards incoming block byte recording to the underlying throughput() function
  let recordedBytes = 0;
  const recordingWire = {
    type: 'tcp',
    downloadSpeed(bytes) {
      if (typeof bytes === 'number') recordedBytes += bytes;
      return recordedBytes;
    },
  };
  mockTorrent._updateWire(recordingWire);
  recordingWire.downloadSpeed(16384);
  assert.equal(recordedBytes, 16384);
  assert.equal(recordingWire.downloadSpeed(), 16384);
});

test('updateCriticalFrontier marks rolling window of unverified sequential pieces as critical', () => {
  const verified = new Set([0, 1, 2]);
  const mockTorrent = {
    destroyed: false,
    ready: true,
    pieces: new Array(20).fill({}),
    _critical: new Array(20).fill(false),
    bitfield: {
      get: (i) => verified.has(i),
    },
  };

  updateCriticalFrontier(mockTorrent, 4);
  assert.equal(mockTorrent._frontierCursor, 3);
  assert.deepEqual(mockTorrent._critical.slice(0, 8), [false, false, false, true, true, true, true, false]);
});
