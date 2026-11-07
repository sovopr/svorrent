import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import os from 'node:os';
import dgram from 'node:dgram';
import { NetworkManager, classifyInterface } from '../lib/networks.js';

test('self-assigned adapters stay visible but are excluded from peer routing', () => {
  const originalNetworkInterfaces = os.networkInterfaces;
  os.networkInterfaces = () => ({
    en0: [{ family: 'IPv4', internal: false, address: '10.29.42.201' }],
    en14: [{ family: 'IPv4', internal: false, address: '169.254.239.58' }],
  });
  try {
    const manager = Object.create(NetworkManager.prototype);
    manager.hardwarePorts = new Map([['en0', 'Wi-Fi'], ['en14', 'iPhone USB']]);
    manager.disabledIds = new Set();
    manager.stats = new Map();
    manager.roundRobinIndex = 0;
    const interfaces = manager.getAllInterfaces();
    assert.equal(interfaces.find((iface) => iface.id === 'en14').connected, false);
    assert.equal(interfaces.find((iface) => iface.id === 'en14').statusReason, 'link-local');
    assert.equal(manager.pickInterface().id, 'en0');
    assert.equal(manager.getSnapshot().bondedCount, 1);
  } finally {
    os.networkInterfaces = originalNetworkInterfaces;
  }
});

test('interface routing does not capture ordinary web requests', () => {
  const realConnect = net.connect;
  const calls = [];
  net.connect = (...args) => { calls.push(args); return {}; };
  try {
    const manager = Object.create(NetworkManager.prototype);
    manager.socketToInterface = new WeakMap();
    manager.pickInterface = () => ({ id: 'cellular', ip: '192.0.2.10' });
    manager.hookNetConnect();

    net.connect(443, '198.51.100.10');
    net.connect({ port: '80', host: '198.51.100.10' });
    assert.equal(calls[0][0].localAddress, undefined);
    assert.equal(calls[1][0].localAddress, undefined);

    net.connect(51413, '198.51.100.10');
    net.connect({ port: 51413, host: '198.51.100.10' });
    assert.equal(calls[2][0].localAddress, '192.0.2.10');
    assert.equal(calls[3][0].localAddress, '192.0.2.10');
  } finally {
    net.connect = realConnect;
  }
});

test('classifyInterface accurately categorizes standard, cellular, bridge, and VPN tunnel devices', () => {
  // Wi-Fi
  assert.equal(classifyInterface('Wi-Fi', 'en0'), 'wifi');
  assert.equal(classifyInterface('Wireless Network Adapter', 'wlan0'), 'wifi');
  assert.equal(classifyInterface('AirPort Extreme', 'en1'), 'wifi');

  // Cellular & Tethering
  assert.equal(classifyInterface('iPhone USB', 'en14'), 'cellular');
  assert.equal(classifyInterface('Android Tether', 'rndis0'), 'cellular');
  assert.equal(classifyInterface('Mobile Hotspot', 'feth0'), 'cellular');

  // Ethernet
  assert.equal(classifyInterface('Ethernet', 'en5'), 'ethernet');
  assert.equal(classifyInterface('Gigabit LAN', 'eth0'), 'ethernet');
  assert.equal(classifyInterface('USB 10/100/1000 LAN', 'en8'), 'ethernet');

  // Bridge
  assert.equal(classifyInterface('Thunderbolt Bridge', 'bridge0'), 'bridge');

  // VPN & Tunnels
  assert.equal(classifyInterface('Tailscale', 'utun3'), 'vpn');
  assert.equal(classifyInterface('WireGuard', 'wg0'), 'vpn');
  assert.equal(classifyInterface('OpenVPN Client', 'tun0'), 'vpn');
  assert.equal(classifyInterface('Corporate IPsec', 'ppp0'), 'vpn');

  // Fallbacks and unknown devices
  assert.equal(classifyInterface('Unknown Hardware Device', 'unk0'), 'other');
  assert.equal(classifyInterface('Loopback Adapter', 'lo0'), 'other');
  assert.equal(classifyInterface('', ''), 'other');
  assert.equal(classifyInterface(null, null), 'other');
  assert.equal(classifyInterface(undefined, undefined), 'other');
});

test('tick and getSnapshot track per-interface upHistory and aggregateUpHistory across active adapters', () => {
  const originalNetworkInterfaces = os.networkInterfaces;
  os.networkInterfaces = () => ({
    en0: [{ family: 'IPv4', internal: false, address: '10.0.0.5' }],
    en7: [{ family: 'IPv4', internal: false, address: '172.20.10.2' }],
  });
  try {
    const wireWifi = {
      destroyed: false,
      conn: { localAddress: '10.0.0.5' },
      downloadSpeed: () => 4096,
      uploadSpeed: () => 2048,
    };
    const wireCell = {
      destroyed: false,
      conn: { localAddress: '172.20.10.2' },
      downloadSpeed: () => 8192,
      uploadSpeed: () => 1024,
    };
    const client = {
      maxConns: 120,
      torrents: [{
        destroyed: false,
        paused: false,
        done: false,
        downloadSpeed: 12288,
        uploadSpeed: 3072,
        wires: [wireWifi, wireCell],
      }],
    };
    const manager = Object.create(NetworkManager.prototype);
    manager.getClient = () => client;
    manager.hardwarePorts = new Map([['en0', 'Wi-Fi'], ['en7', 'iPhone USB']]);
    manager.disabledIds = new Set();
    manager.stats = new Map();
    manager.wireToInterface = new WeakMap();
    manager.socketToInterface = new WeakMap();
    manager.wireToSocket = new WeakMap();
    manager.baseMaxConns = 120;
    manager.roundRobinIndex = 0;

    manager.tick();
    const snap = manager.getSnapshot();
    assert.equal(snap.totalDownSpeed, 12288);
    assert.equal(snap.totalUpSpeed, 3072);
    assert.equal(snap.aggregateHistory.length, 24);
    assert.equal(snap.aggregateUpHistory.length, 24);
    assert.equal(snap.aggregateHistory.at(-1), 12288);
    assert.equal(snap.aggregateUpHistory.at(-1), 3072);

    const wifi = snap.interfaces.find((i) => i.id === 'en0');
    const cell = snap.interfaces.find((i) => i.id === 'en7');
    assert.equal(wifi.upHistory.at(-1), 2048);
    assert.equal(cell.upHistory.at(-1), 1024);

    // Disabling cellular excludes its upload history from aggregateUpHistory
    manager.disabledIds.add('en7');
    const disabledSnap = manager.getSnapshot();
    assert.equal(disabledSnap.aggregateUpHistory.at(-1), 2048);
  } finally {
    os.networkInterfaces = originalNetworkInterfaces;
  }
});

test('sendHeartbeat sends keepalive probe only for idle cellular interfaces', () => {
  const sent = [];
  const fakeSocket = {
    once: () => {},
    bind: (port, ip, cb) => cb(),
    send: (buf, port, host, cb) => {
      sent.push({ length: buf.length, host, port });
      cb();
    },
    close: () => {},
  };
  const originalCreateSocket = dgram.createSocket;
  dgram.createSocket = () => fakeSocket;

  try {
    const manager = Object.create(NetworkManager.prototype);
    manager.disabledIds = new Set(['en9']); // en9 disabled
    manager.stats = new Map([
      ['en7', { currentDown: 5000, currentUp: 0 }], // busy cellular -> should skip
      ['feth0', { currentDown: 0, currentUp: 0 }],  // idle cellular -> should send probe
    ]);
    manager.getAllInterfaces = () => [
      { id: 'en0', type: 'wifi', ip: '10.0.0.2', connected: true }, // wifi -> skip
      { id: 'en9', type: 'cellular', ip: '192.168.1.5', connected: true }, // disabled -> skip
      { id: 'en7', type: 'cellular', ip: '172.20.10.2', connected: true }, // busy -> skip
      { id: 'feth0', type: 'cellular', ip: '10.78.7.77', connected: true }, // idle cellular -> probes!
    ];

    manager.sendHeartbeat();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].length, 17); // RFC valid 17-byte DNS query
    assert.equal(sent[0].host, '1.1.1.1');
    assert.equal(sent[0].port, 53);
  } finally {
    dgram.createSocket = originalCreateSocket;
  }
});

test('tick automatically triggers recoverUsbTether when feth0 is stuck on a link-local address', () => {
  const originalNetworkInterfaces = os.networkInterfaces;
  let fethIp = '169.254.75.221';
  os.networkInterfaces = () => ({
    en0: [{ family: 'IPv4', internal: false, address: '10.29.55.39' }],
    feth0: [{ family: 'IPv4', internal: false, address: fethIp }],
  });

  try {
    let recoverCalls = 0;
    const manager = Object.create(NetworkManager.prototype);
    manager.getClient = () => ({ maxConns: 120, torrents: [] });
    manager.hardwarePorts = new Map([['en0', 'Wi-Fi']]);
    manager.disabledIds = new Set();
    manager.stats = new Map();
    manager.fethLinkLocalTicks = new Map();
    manager.recoverUsbTether = () => {
      recoverCalls++;
    };

    for (let i = 0; i < 24; i++) {
      manager.tick();
    }
    assert.equal(recoverCalls, 0);

    // 25th consecutive second stuck in link-local triggers recovery
    manager.tick();
    assert.equal(recoverCalls, 1);

    // Once DHCP lease is acquired, counter resets
    fethIp = '10.78.7.114';
    manager.tick();
    assert.equal(manager.fethLinkLocalTicks.has('feth0'), false);
    assert.equal(manager.getSnapshot().usbTether.interfacePresent, true);
    assert.equal(manager.getSnapshot().usbTether.interfaceActive, true);
  } finally {
    os.networkInterfaces = originalNetworkInterfaces;
  }
});


