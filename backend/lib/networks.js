// Multi-Network Traffic Aggregation & Real Hardware Interface Bonding Engine
// Inspired by Plexo: binds discrete peer connections to specific local
// network interfaces (Wi-Fi, Ethernet, Mobile Hotspot) to aggregate bandwidth.

import os from 'node:os';
import net from 'node:net';
import dgram from 'node:dgram';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getTetherDaemonBin() {
  const privilegedSub = '/Library/PrivilegedHelperTools/com.svorrent.tetherd/svorrent-tetherd';
  if (fs.existsSync(privilegedSub)) return privilegedSub;
  const privileged = '/Library/PrivilegedHelperTools/svorrent-tetherd';
  if (fs.existsSync(privileged)) return privileged;
  return path.resolve(__dirname, '../bin/svorrent-tetherd');
}

function classifyInterface(name, device) {
  const s = `${name} ${device}`.toLowerCase();
  if (/wi-?fi|wireless|wlan|airport|802\.11/.test(s)) return 'wifi';
  if (/iphone|ipad|tether|hotspot|cellular|mobile|usb|rndis|feth|samsung|android/.test(s)) return 'cellular';
  if (/ethernet|lan|gigabit|usb.*lan/.test(s)) return 'ethernet';
  if (/bridge|thunderbolt bridge/.test(s)) return 'bridge';
  return 'other';
}

export function isUsableIpv4(address) {
  return net.isIPv4(address) && !address.startsWith('169.254.') &&
    address !== '0.0.0.0' && !address.startsWith('127.');
}

async function getMacHardwarePortNames() {
  const map = new Map();
  if (process.platform !== 'darwin') return map;

  try {
    const { stdout } = await execAsync('networksetup -listallhardwareports');
    const blocks = stdout.split(/\n\s*\n/);
    for (const block of blocks) {
      const lines = block.split('\n');
      let port = null;
      let device = null;
      for (const line of lines) {
        if (line.startsWith('Hardware Port:')) {
          port = line.replace('Hardware Port:', '').trim();
        } else if (line.startsWith('Device:')) {
          device = line.replace('Device:', '').trim();
        }
      }
      if (device && port) {
        map.set(device, port);
      }
    }
  } catch {}

  try {
    const { stdout } = await execAsync('networksetup -listnetworkserviceorder');
    for (const match of stdout.matchAll(/Hardware Port:\s*([^,]+),\s*Device:\s*([a-zA-Z0-9]+)/g)) {
      const port = match[1].trim();
      const device = match[2].trim();
      if (device && port && !map.has(device)) {
        map.set(device, port);
      }
    }
  } catch {}

  // Detect dynamic Apple USB NCM network interfaces (iPhone / iPad USB tethering)
  try {
    const { stdout } = await execAsync('ioreg -r -n AppleUSBNCM11Data -l');
    const matches = [...stdout.matchAll(/"BSD Name"\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
    for (const bsdName of matches) {
      if (bsdName.startsWith('en') && !map.has(bsdName)) {
        map.set(bsdName, 'iPhone USB');
      }
    }
  } catch {}

  return map;
}

export class NetworkManager {
  constructor(clientProvider) {
    this.getClient = clientProvider;
    this.disabledIds = new Set();
    this.hardwarePorts = new Map();
    this.roundRobinIndex = 0;
    this.wireToInterface = new WeakMap();
    this.socketToInterface = new WeakMap();
    this.wireToSocket = new WeakMap();
    this.baseMaxConns = this.getClient()?.maxConns || 120;
    this.stats = new Map(); // id -> { downloaded: 0, uploaded: 0, currentDown: 0, currentUp: 0, peers: 0, history: [] }
    this.usbTetherDevice = { found: false, name: null };
    this.iosDevice = { found: false, detected: false, name: null, locked: false };
    this.isTetherDaemonRunning = false;

    // Start background scanner
    this.refreshHardwarePorts();
    this.checkUsbTether();
    this.checkIosDevice();
    this.tickCount = 0;
    this.intervalId = setInterval(() => {
      this.tickCount++;
      if (this.tickCount % 5 === 0) {
        this.refreshHardwarePorts();
        this.checkUsbTether();
        this.checkIosDevice();
      }
      if (this.tickCount % 3 === 0) {
        this.sendHeartbeat();
      }
      this.tick();
    }, 1000);
    this.intervalId.unref?.();

    // Hook net.connect to bind outgoing peer sockets to local interfaces
    this.hookNetConnect();
  }

  async checkUsbTether() {
    try {
      const tetherBin = getTetherDaemonBin();
      const { stdout } = await execFileAsync(tetherBin, ['--list'], { timeout: 4000 });
      if (stdout.includes('RNDIS devices found:')) {
        let deviceName = 'Android Device';
        if (stdout.includes('04e8:')) deviceName = 'Samsung Galaxy';
        else if (stdout.includes('18d1:')) deviceName = 'Google Pixel';
        else if (stdout.includes('2717:')) deviceName = 'Xiaomi / Redmi';
        else if (stdout.includes('2a70:')) deviceName = 'OnePlus';
        else if (stdout.includes('22b8:')) deviceName = 'Motorola';
        else if (stdout.includes('0fce:')) deviceName = 'Sony Xperia';
        else if (stdout.includes('12d1:')) deviceName = 'Huawei / Honor';

        this.usbTetherDevice = {
          found: true,
          name: deviceName,
          details: stdout.trim(),
        };
      } else {
        this.usbTetherDevice = { found: false, name: null };
      }
    } catch {
      this.usbTetherDevice = { found: false, name: null };
    }

    try {
      const { stdout } = await execFileAsync('launchctl', ['print', 'system/com.svorrent.tetherd'], { timeout: 4000 });
      this.isTetherDaemonRunning = stdout.includes('state = running');
    } catch {
      this.isTetherDaemonRunning = false;
    }
  }

  async checkIosDevice() {
    if (process.platform !== 'darwin') {
      this.iosDevice = { found: false, detected: false, name: null, locked: false };
      return;
    }

    try {
      const pyScript = `
import socket, plistlib, struct, ssl, tempfile, json

try:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(1.0)
    s.connect("/var/run/usbmuxd")
    req = {"MessageType": "ListDevices", "ClientVersionString": "svorrent", "ProgName": "svorrent"}
    p = plistlib.dumps(req)
    s.sendall(struct.pack("<IIII", len(p) + 16, 1, 8, 1) + p)
    l = struct.unpack("<IIII", s.recv(16))[0]
    devs = plistlib.loads(s.recv(l - 16)).get("DeviceList", [])
    usb_devs = [d for d in devs if d.get("Properties", {}).get("ConnectionType") == "USB"]
    if not usb_devs:
        print(json.dumps({"detected": False}))
        exit(0)

    dev = usb_devs[0]["Properties"]
    dev_id = dev["DeviceID"]
    serial = dev["SerialNumber"]

    req2 = {"MessageType": "ReadPairRecord", "PairRecordID": serial, "ClientVersionString": "svorrent", "ProgName": "svorrent"}
    p2 = plistlib.dumps(req2)
    s.sendall(struct.pack("<IIII", len(p2) + 16, 1, 8, 1) + p2)
    l2 = struct.unpack("<IIII", s.recv(16))[0]
    rec_resp = plistlib.loads(s.recv(l2 - 16))
    rec_data = rec_resp.get("PairRecordData")
    if not rec_data:
        print(json.dumps({"detected": True, "paired": False, "locked": True, "name": "iPhone"}))
        exit(0)
    record = plistlib.loads(rec_data)

    s2 = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s2.settimeout(1.0)
    s2.connect("/var/run/usbmuxd")
    req_conn = {"MessageType": "Connect", "DeviceID": dev_id, "PortNumber": socket.htons(62078), "ClientVersionString": "svorrent", "ProgName": "svorrent"}
    p_conn = plistlib.dumps(req_conn)
    s2.sendall(struct.pack("<IIII", len(p_conn) + 16, 1, 8, 1) + p_conn)
    l_conn = struct.unpack("<IIII", s2.recv(16))[0]
    s2.recv(l_conn - 16)

    def send_plist(sock, obj):
        data = plistlib.dumps(obj)
        sock.sendall(struct.pack(">I", len(data)) + data)

    def recv_plist(sock):
        hdr = sock.recv(4)
        if not hdr: return None
        length = struct.unpack(">I", hdr)[0]
        data = b""
        while len(data) < length:
            data += sock.recv(length - len(data))
        return plistlib.loads(data)

    send_plist(s2, {"Request": "StartSession", "HostID": record["HostID"], "SystemBUID": record["SystemBUID"]})
    recv_plist(s2)

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    with tempfile.NamedTemporaryFile("wb", delete=False) as f_cert, tempfile.NamedTemporaryFile("wb", delete=False) as f_key:
        f_cert.write(record["HostCertificate"])
        f_cert.flush()
        f_key.write(record["HostPrivateKey"])
        f_key.flush()
        ctx.load_cert_chain(f_cert.name, f_key.name)

    ssl_sock = ctx.wrap_socket(s2)
    send_plist(ssl_sock, {"Request": "GetValue", "Key": "PasswordProtected"})
    is_locked = recv_plist(ssl_sock).get("Value", False)

    send_plist(ssl_sock, {"Request": "GetValue", "Key": "DeviceName"})
    dev_name = recv_plist(ssl_sock).get("Value", "iPhone")

    print(json.dumps({"detected": True, "paired": True, "locked": bool(is_locked), "name": dev_name}))
except Exception as e:
    print(json.dumps({"detected": False, "error": str(e)}))
`;
      const { stdout } = await execFileAsync('/usr/bin/python3', ['-c', pyScript], { timeout: 3000 });
      const parsed = JSON.parse(stdout.trim());
      if (parsed?.detected) {
        this.iosDevice = {
          found: true,
          detected: true,
          name: parsed.name || 'iPhone',
          locked: !!parsed.locked,
        };
        return;
      }
    } catch {}

    // Fallback: check ioreg for connected Apple USB mobile device
    try {
      const { stdout } = await execAsync('ioreg -p IOUSB -l -w0 -r -n iPhone');
      if (stdout.includes('"idVendor" = 1452')) {
        this.iosDevice = {
          found: true,
          detected: true,
          name: 'iPhone',
          locked: false,
        };
        return;
      }
    } catch {}

    this.iosDevice = { found: false, detected: false, name: null, locked: false };
  }

  // Keep active cellular tether links from becoming idle. Other interfaces do
  // not need this traffic, and a keepalive cannot guarantee carrier behavior.
  sendHeartbeat() {
    const hasActiveTorrent = this.getClient()?.torrents?.some(
      (torrent) => !torrent.destroyed && !torrent.paused && !torrent._pausedManually,
    );
    if (!hasActiveTorrent) return;
    const ifaces = this.getAllInterfaces();
    for (const iface of ifaces) {
      if (this.disabledIds.has(iface.id)) continue;
      if (iface.type !== 'cellular') continue;
      if (!iface.ip || !iface.connected) continue;
      try {
        const sock = dgram.createSocket('udp4');
        const close = () => { try { sock.close(); } catch {} };
        const timer = setTimeout(close, 2000);
        timer.unref?.();
        sock.once('close', () => clearTimeout(timer));
        sock.once('error', close);
        sock.bind(0, iface.ip, () => {
          // Small keepalive request; the timeout also closes stalled sockets.
          sock.send(Buffer.alloc(1), 53, '1.1.1.1', close);
        });
      } catch {}
    }
  }

  async refreshHardwarePorts() {
    this.hardwarePorts = await getMacHardwarePortNames();
  }

  async rescan() {
    await Promise.allSettled([
      this.refreshHardwarePorts(),
      this.checkUsbTether(),
      this.checkIosDevice(),
    ]);
    this.tick();
    return this.getSnapshot();
  }

  hookNetConnect() {
    const originalConnect = net.connect;
    this.originalConnect = originalConnect;
    const self = this;

    this.connectHook = net.connect = function (...args) {
      let opts = args[0];
      let cb = args[1];
      let chosen = null;

      if (typeof opts === 'number') {
        const port = opts;
        const host = typeof args[1] === 'string' ? args[1] : 'localhost';
        cb = typeof args[1] === 'function' ? args[1] : args[2];
        // Do not reroute ordinary HTTP(S) requests used by search, trackers,
        // update checks, and other services through a possibly offline adapter.
        chosen = port !== 80 && port !== 443 && net.isIPv4(host) && !host.startsWith('127.')
          ? self.pickInterface() : null;
        opts = { port, host };
        if (chosen && chosen.ip) {
          opts.localAddress = chosen.ip;
        }
        const socket = originalConnect.call(this, opts, cb);
        if (chosen) {
          self.socketToInterface.set(socket, chosen.id);
        }
        return socket;
      } else if (opts && typeof opts === 'object') {
        // Interfaces currently carry IPv4 addresses. Never bind IPv6, loopback,
        // Unix sockets or hostname-based service requests to one of those.
        if (!opts.path && opts.port && Number(opts.port) !== 80 && Number(opts.port) !== 443 &&
            !opts.localAddress && net.isIPv4(opts.host) && !opts.host.startsWith('127.')) {
          chosen = self.pickInterface();
          if (chosen && chosen.ip) {
            opts = { ...opts, localAddress: chosen.ip };
            args[0] = opts;
          }
        }
        const socket = originalConnect.apply(this, args);
        if (chosen) {
          self.socketToInterface.set(socket, chosen.id);
        }
        return socket;
      }
      return originalConnect.apply(this, args);
    };
  }

  destroy() {
    clearInterval(this.intervalId);
    if (net.connect === this.connectHook) net.connect = this.originalConnect;
  }

  trackWire(torrent, wire) {
    // WebTorrent keeps the socket on Peer, not on its protocol Wire.
    const peer = Array.from(torrent._peers?.values() || []).find((entry) => entry.wire === wire);
    if (peer?.conn) this.wireToSocket.set(wire, peer.conn);
    const socket = peer?.conn || wire.conn;
    if (!socket) return;
    const iface = this.getAllInterfaces().find((entry) => entry.ip === socket.localAddress);
    const id = iface?.id || this.socketToInterface.get(socket);
    if (id) this.wireToInterface.set(wire, id);
  }

  getAllInterfaces() {
    const ifaces = os.networkInterfaces();
    const list = [];

    // Only return physically connected network interfaces with IPv4
    for (const [device, addrs] of Object.entries(ifaces)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        if ((addr.family === 'IPv4' || addr.family === 4) && !addr.internal && !list.some((entry) => entry.id === device)) {
          let humanName = this.hardwarePorts.get(device);
          if (!humanName) {
            if (device.startsWith('feth')) {
              const devName = this.usbTetherDevice?.name || 'Android Device';
              humanName = `Android USB Tethering (${devName})`;
            } else if (device.startsWith('en')) {
              humanName = `Interface (${device})`;
            } else {
              humanName = device;
            }
          }
          const type = classifyInterface(humanName, device);
          const linkLocal = addr.address.startsWith('169.254.');
          list.push({
            id: device,
            device,
            name: humanName,
            ip: addr.address,
            netmask: addr.netmask,
            mac: addr.mac,
            type,
            connected: isUsableIpv4(addr.address),
            statusReason: linkLocal ? 'link-local' : null,
          });
        }
      }
    }

    return list;
  }

  /**
   * Plexo fewest-peers-first load balancing:
   * Selects the interface currently handling the fewest active peer connections.
   * A faster network naturally pulls more torrent blocks because its peers answer
   * requests quicker and request queues stay replenished.
   */
  pickInterface() {
    const available = this.getAllInterfaces().filter(
      (iface) => iface.connected && iface.ip && !this.disabledIds.has(iface.id)
    );
    if (available.length === 0) return null;
    if (available.length === 1) return available[0];

    const client = typeof this.getClient === 'function' ? this.getClient() : null;
    const ifaceDownPeers = new Map();
    const ifaceTotalPeers = new Map();
    let totalMeasuredDown = 0;
    for (const iface of available) {
      ifaceDownPeers.set(iface.id, 0);
      ifaceTotalPeers.set(iface.id, this.stats?.get(iface.id)?.peers ?? 0);
      totalMeasuredDown += this.stats?.get(iface.id)?.currentDown ?? 0;
    }

    let hasActiveDownloads = false;
    if (client?.torrents) {
      for (const t of client.torrents) {
        if (t.destroyed || t.paused) continue;
        if (!t.done) hasActiveDownloads = true;
        if (!t.wires) continue;
        const isDownloading = !t.done;
        for (const wire of t.wires) {
          if (wire.destroyed) continue;
          const ifaceId = this.wireToInterface?.get(wire);
          if (ifaceId && ifaceDownPeers.has(ifaceId)) {
            if (isDownloading) {
              ifaceDownPeers.set(ifaceId, ifaceDownPeers.get(ifaceId) + 1);
            }
          }
        }
      }
    }

    let minDownPeersOnAny = Infinity;
    for (const iface of available) {
      const dp = ifaceDownPeers.get(iface.id) || 0;
      if (dp < minDownPeersOnAny) minDownPeersOnAny = dp;
    }
    const useThroughputWeighting = hasActiveDownloads && minDownPeersOnAny >= 4 && totalMeasuredDown > 64 * 1024;
    const avgDown = available.length > 0 ? totalMeasuredDown / available.length : 0;

    let best = null;
    let minScore = Infinity;

    for (let index = 0; index < available.length; index++) {
      const iface = available[(this.roundRobinIndex + index) % available.length];
      const downPeers = ifaceDownPeers.get(iface.id) || 0;
      const totalPeers = ifaceTotalPeers.get(iface.id) || 0;

      // Once every bonded adapter has at least 4 active download peers, weight peer capacity
      // by live download throughput so faster adapters (e.g. Wi-Fi / Ethernet) receive proportionally
      // more peer slots instead of being bottlenecked 50/50 by a slower cellular tether.
      let effectiveDownPeers = downPeers;
      if (useThroughputWeighting) {
        const currentDown = this.stats?.get(iface.id)?.currentDown ?? 0;
        const speedWeight = Math.max(0.4, Math.min(2.5, (currentDown + 65536) / (avgDown + 65536)));
        effectiveDownPeers = downPeers / speedWeight;
      }

      const score = hasActiveDownloads
        ? (effectiveDownPeers * 100) + totalPeers
        : totalPeers;

      if (score < minScore) {
        minScore = score;
        best = iface;
      }
    }

    this.roundRobinIndex = (available.indexOf(best) + 1) % available.length;

    return best;
  }

  getWireInterface(wire) {
    if (!wire) return null;
    const ifaceId = this.wireToInterface.get(wire);
    if (!ifaceId) return null;
    const ifaces = this.getAllInterfaces();
    return ifaces.find((i) => i.id === ifaceId) || null;
  }

  toggleInterface(id, enabled) {
    if (enabled) {
      this.disabledIds.delete(id);
    } else {
      this.disabledIds.add(id);
      const client = this.getClient();
      if (client?.torrents) {
        for (const t of client.torrents) {
          if (t.wires) {
            for (const wire of t.wires) {
              const ifaceId = this.wireToInterface.get(wire);
              if (ifaceId === id) {
                try { wire.destroy(); } catch {}
              }
            }
          }
        }
      }
    }
  }

  // Ticks every 1s to record live speeds and moving history per network adapter
  tick() {
    const client = this.getClient();
    if (!client) return;

    const ifaces = this.getAllInterfaces();
    const speedMap = new Map();
    const upMap = new Map();
    const peerMap = new Map();

    for (const iface of ifaces) {
      speedMap.set(iface.id, 0);
      upMap.set(iface.id, 0);
      peerMap.set(iface.id, 0);
    }

    const availableActiveIds = ifaces.filter((i) => i.connected && !this.disabledIds.has(i.id)).map((i) => i.id);

    // Detect newly attached/connected interfaces to dynamically rebalance active downloading swarms
    if (!this.previousActiveIds) this.previousActiveIds = new Set(availableActiveIds);
    const newlyConnectedIds = availableActiveIds.filter((id) => !this.previousActiveIds.has(id));
    this.previousActiveIds = new Set(availableActiveIds);

    if (newlyConnectedIds.length > 0 && client.torrents) {
      for (const t of client.torrents) {
        if (t.destroyed || t.paused) continue;
        if (!t.done) {
          try {
            if (t.discovery?.tracker?._trackers) {
              const opts = t.discovery.tracker._defaultAnnounceOpts({ event: 'started' });
              for (const tr of t.discovery.tracker._trackers) {
                try { tr.announce(opts); } catch {}
              }
            }
            if (typeof t.discovery?._dhtAnnounce === 'function') {
              try { t.discovery._dhtAnnounce(); } catch {}
            }
          } catch {}

          if (t._knownPeers && t._knownPeers.size > 0) {
            for (const addr of t._knownPeers) {
              try { t.addPeer(addr); } catch {}
            }
          }

          if (t.wires && t.wires.length >= 6) {
            const wiresToRebalance = t.wires
              .filter((w) => !w.destroyed && w.peerChoking && (typeof w.downloadSpeed !== 'function' || w.downloadSpeed() === 0))
              .slice(0, Math.min(3, Math.floor(t.wires.length / 3)));
            for (const wire of wiresToRebalance) {
              try { wire.destroy(); } catch {}
            }
          }
        }
      }
    }

    // Plexo reconcile: if an adapter was unplugged or disabled, tear down its remaining wires
    // so WebTorrent immediately redials on the remaining active interface(s).
    if (client.torrents) {
      for (const t of client.torrents) {
        if (!t.wires) continue;
        for (const wire of t.wires) {
          const assignedId = this.wireToInterface.get(wire);
          if (assignedId && (!availableActiveIds.includes(assignedId) || this.disabledIds.has(assignedId))) {
            try { wire.destroy(); } catch {}
          }
        }
      }
    }

    // Dynamic swarm connection scaling (Plexo pattern):
    // Scales total maxConns based on the number of bonded interfaces
    if (availableActiveIds.length > 0 && typeof client.maxConns === 'number') {
      const targetConns = Math.max(this.baseMaxConns, 60 * availableActiveIds.length);
      if (client.maxConns !== targetConns) {
        client.maxConns = targetConns;
      }
    }

    // Collect throughput directly from all active torrent wires
    if (client.torrents && availableActiveIds.length > 0) {
      for (const t of client.torrents) {
        if (!t.wires) continue;
        let torrentWireUp = 0;
        const torrentIfaceWires = new Map();

        for (const wire of t.wires) {
          if (wire.destroyed) continue;
          let ifaceId = null;
          const socket = this.wireToSocket.get(wire) || wire.conn;

          // 1. Direct kernel localAddress match on active physical interface
          if (socket?.localAddress) {
            const match = ifaces.find((i) => i.ip === socket.localAddress && !this.disabledIds.has(i.id));
            if (match) ifaceId = match.id;
          }

          // 2. Fall back to socket mapping registered at connect()
          if (!ifaceId && socket && this.socketToInterface.has(socket)) {
            const mapped = this.socketToInterface.get(socket);
            if (availableActiveIds.includes(mapped) && !this.disabledIds.has(mapped)) {
              ifaceId = mapped;
            }
          }

          // 3. Reuse a previously observed assignment. Unknown sockets must
          // not be credited to an adapter that may not have carried them.
          if (!ifaceId || !availableActiveIds.includes(ifaceId)) {
            const existing = this.wireToInterface.get(wire);
            if (existing && availableActiveIds.includes(existing) && !this.disabledIds.has(existing)) {
              ifaceId = existing;
            }
          }

          if (ifaceId) this.wireToInterface.set(wire, ifaceId);

          const downSpeed = typeof wire.downloadSpeed === 'function' ? wire.downloadSpeed() : 0;
          const upSpeed = typeof wire.uploadSpeed === 'function' ? wire.uploadSpeed() : 0;
          torrentWireUp += upSpeed;

          if (speedMap.has(ifaceId)) {
            speedMap.set(ifaceId, speedMap.get(ifaceId) + downSpeed);
            upMap.set(ifaceId, upMap.get(ifaceId) + upSpeed);
            peerMap.set(ifaceId, peerMap.get(ifaceId) + 1);
            torrentIfaceWires.set(ifaceId, (torrentIfaceWires.get(ifaceId) || 0) + 1);
          }
        }

        // Harmonize upload speeds: wire.uploadSpeed() only counts payload pieces sent when peers request them.
        // During active downloading, WebTorrent emits outgoing piece requests, HAVE notifications, DHT pings,
        // and keepalives (tracked by t.uploadSpeed). If t.uploadSpeed exceeds raw piece upload, allocate
        // the remaining outgoing socket throughput across this torrent's active interfaces.
        const totalTorrentUp = typeof t.uploadSpeed === 'number' ? t.uploadSpeed : 0;
        const unallocatedUp = Math.max(0, totalTorrentUp - torrentWireUp);
        if (unallocatedUp > 0 && torrentIfaceWires.size > 0) {
          const totalWiresInTorrent = Array.from(torrentIfaceWires.values()).reduce((a, b) => a + b, 0);
          for (const [ifaceId, count] of torrentIfaceWires.entries()) {
            const share = Math.round(unallocatedUp * (count / totalWiresInTorrent));
            upMap.set(ifaceId, (upMap.get(ifaceId) || 0) + share);
          }
        }
      }
    }

    // Update cumulative counters and sparkline history (last 24 seconds)
    for (const iface of ifaces) {
      const id = iface.id;
      if (!this.stats.has(id)) {
        this.stats.set(id, {
          downloaded: 0,
          uploaded: 0,
          currentDown: 0,
          currentUp: 0,
          peers: 0,
          history: Array(24).fill(0),
        });
      }
      const st = this.stats.get(id);
      const isEnabled = iface.connected && !this.disabledIds.has(id);
      const currentDown = isEnabled ? (speedMap.get(id) || 0) : 0;
      const currentUp = isEnabled ? (upMap.get(id) || 0) : 0;
      const peers = isEnabled ? (peerMap.get(id) || 0) : 0;

      st.currentDown = currentDown;
      st.currentUp = currentUp;
      st.peers = peers;
      st.downloaded += currentDown;
      st.uploaded += currentUp;

      st.history.push(currentDown);
      if (st.history.length > 24) {
        st.history.shift();
      }
    }
  }

  getSnapshot() {
    const all = this.getAllInterfaces();
    let totalDown = 0;
    let totalUp = 0;

    const list = all.map((iface) => {
      const id = iface.id;
      const isConnected = !!iface.connected;
      const isEnabled = isConnected && !this.disabledIds.has(id);
      const st = this.stats.get(id) || {
        downloaded: 0,
        uploaded: 0,
        currentDown: 0,
        currentUp: 0,
        peers: 0,
        history: Array(24).fill(0),
      };
      const currentDown = isEnabled ? (st.currentDown || 0) : 0;
      const currentUp = isEnabled ? (st.currentUp || 0) : 0;

      totalDown += currentDown;
      totalUp += currentUp;

      return {
        id,
        device: iface.device,
        name: iface.name,
        ip: iface.ip,
        type: iface.type,
        statusReason: iface.statusReason,
        connected: isConnected,
        enabled: isEnabled,
        downSpeed: currentDown,
        upSpeed: currentUp,
        downloaded: st.downloaded,
        uploaded: st.uploaded,
        peers: st.peers || 0,
        history: [...st.history],
      };
    });

    const enriched = list.map((item) => ({
      ...item,
      sharePercent: totalDown > 0 ? Math.round((item.downSpeed / totalDown) * 100) : 0,
    }));

    const bondedInterfaces = enriched.filter((i) => i.connected && i.enabled);

    // Aggregate throughput history over time (last 24 data points)
    const historyLength = 24;
    const aggregateHistory = [];
    for (let t = 0; t < historyLength; t++) {
      let tSum = 0;
      for (const item of enriched) {
        if (item.connected && item.enabled && item.history) {
          const val = item.history[item.history.length - historyLength + t];
          if (typeof val === 'number') tSum += val;
        }
      }
      aggregateHistory.push(tSum);
    }

    return {
      interfaces: enriched,
      totalDownSpeed: totalDown,
      totalUpSpeed: totalUp,
      totalDownloaded: enriched.reduce((s, i) => s + i.downloaded, 0),
      totalUploaded: enriched.reduce((s, i) => s + i.uploaded, 0),
      bondedCount: bondedInterfaces.length,
      connectedCount: enriched.filter((i) => i.connected).length,
      aggregateHistory,
      usbTether: {
        detected: this.usbTetherDevice?.found || false,
        name: this.usbTetherDevice?.name || null,
        helperInstalled: fs.existsSync('/Library/PrivilegedHelperTools/com.svorrent.tetherd/svorrent-tetherd'),
        daemonActive: this.isTetherDaemonRunning,
        interfaceActive: all.some((i) => i.device.startsWith('feth') && i.connected),
      },
      iosTether: {
        detected: this.iosDevice?.found || false,
        name: this.iosDevice?.name || 'iPhone',
        locked: this.iosDevice?.locked ?? false,
        interfaceActive: all.some((i) => i.type === 'cellular' && i.connected),
      },
    };
  }
}
