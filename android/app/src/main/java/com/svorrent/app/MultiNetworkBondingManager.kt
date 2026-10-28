package com.svorrent.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.max
import kotlin.math.roundToInt

class MultiNetworkBondingManager(context: Context) {
    private val connectivityManager =
        context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    @Volatile
    var wifiNetwork: Network? = null
        private set

    @Volatile
    var cellularNetwork: Network? = null
        private set

    private val disabledAdapterIds = ConcurrentHashMap.newKeySet<String>()
    private val historyMap = ConcurrentHashMap<String, ArrayDeque<Long>>()
    private val aggregateHistory = ArrayDeque<Long>()
    private val sessionDownloadedMap = ConcurrentHashMap<String, Long>()
    private val sessionUploadedMap = ConcurrentHashMap<String, Long>()

    @Volatile
    private var peakDownSpeed: Long = 0L

    private var wifiCallback: ConnectivityManager.NetworkCallback? = null
    private var cellularCallback: ConnectivityManager.NetworkCallback? = null

    fun startBonding(onInterfacesChanged: () -> Unit = {}) {
        // 1. Request Wi-Fi transport explicitly
        try {
            val wifiReq = NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build()
            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    wifiNetwork = network
                    onInterfacesChanged()
                }
                override fun onLost(network: Network) {
                    if (wifiNetwork == network) wifiNetwork = null
                    onInterfacesChanged()
                }
            }
            wifiCallback = cb
            connectivityManager.requestNetwork(wifiReq, cb)
        } catch (_: Exception) {
        }

        // 2. Request Cellular (5G / LTE) transport explicitly so Android keeps Mobile Data
        // alive and routable even while Wi-Fi is connected!
        try {
            val cellReq = NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_CELLULAR)
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build()
            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    cellularNetwork = network
                    onInterfacesChanged()
                }
                override fun onLost(network: Network) {
                    if (cellularNetwork == network) cellularNetwork = null
                    onInterfacesChanged()
                }
            }
            cellularCallback = cb
            connectivityManager.requestNetwork(cellReq, cb)
        } catch (_: Exception) {
        }
    }

    fun stopBonding() {
        wifiCallback?.let { runCatching { connectivityManager.unregisterNetworkCallback(it) } }
        cellularCallback?.let { runCatching { connectivityManager.unregisterNetworkCallback(it) } }
        wifiCallback = null
        cellularCallback = null
    }

    fun isAdapterEnabled(id: String): Boolean = !disabledAdapterIds.contains(id)

    fun setAdapterEnabled(id: String, enabled: Boolean) {
        if (enabled) {
            disabledAdapterIds.remove(id)
        } else {
            disabledAdapterIds.add(id)
        }
    }

    private fun extractIpv4FromLink(link: LinkProperties?): Pair<String, String>? {
        if (link == null) return null
        val ifaceName = link.interfaceName ?: return null
        for (addr in link.linkAddresses) {
            val inet = addr.address
            if (inet is Inet4Address && !inet.isLoopbackAddress && !inet.isLinkLocalAddress) {
                return Pair(ifaceName, inet.hostAddress ?: "")
            }
        }
        return null
    }

    fun discoverAdapters(): List<DiscoveredAdapter> {
        val result = mutableListOf<DiscoveredAdapter>()
        val seenDevices = mutableSetOf<String>()

        // 1. Check active ConnectivityManager networks first (Wi-Fi & Cellular)
        val wifiNet = wifiNetwork
        if (wifiNet != null) {
            val info = extractIpv4FromLink(connectivityManager.getLinkProperties(wifiNet))
            if (info != null && info.second.isNotEmpty()) {
                seenDevices.add(info.first)
                result.add(
                    DiscoveredAdapter(
                        id = "wifi",
                        name = "Wi-Fi",
                        device = info.first,
                        type = "wifi",
                        ip = info.second,
                        connected = true,
                        network = wifiNet
                    )
                )
            }
        }

        val cellNet = cellularNetwork
        if (cellNet != null) {
            val info = extractIpv4FromLink(connectivityManager.getLinkProperties(cellNet))
            if (info != null && info.second.isNotEmpty()) {
                seenDevices.add(info.first)
                result.add(
                    DiscoveredAdapter(
                        id = "cellular",
                        name = "Mobile Data (5G / LTE)",
                        device = info.first,
                        type = "cellular",
                        ip = info.second,
                        connected = true,
                        network = cellNet
                    )
                )
            }
        }

        // 2. Also inspect OS NetworkInterfaces as fallback for wlan / rmnet / ccmni / eth
        try {
            val interfaces = Collections.list(NetworkInterface.getNetworkInterfaces())
            for (nif in interfaces) {
                if (!nif.isUp || nif.isLoopback) continue
                val dev = nif.name ?: continue
                if (seenDevices.contains(dev)) continue
                if (dev.startsWith("tun") || dev.startsWith("dummy") || dev.startsWith("lo")) continue

                val ipv4 = Collections.list(nif.inetAddresses)
                    .firstOrNull { it is Inet4Address && !it.isLoopbackAddress && !it.isLinkLocalAddress }
                    ?.hostAddress ?: continue

                val isWifi = dev.startsWith("wlan") || dev.startsWith("ap")
                val isCell = dev.startsWith("rmnet") || dev.startsWith("ccmni") || dev.startsWith("pdp") || dev.startsWith(" clat")
                val isEth = dev.startsWith("eth") || dev.startsWith("rndis") || dev.startsWith("usb")

                if (isWifi && result.none { it.id == "wifi" }) {
                    seenDevices.add(dev)
                    result.add(
                        DiscoveredAdapter(
                            id = "wifi",
                            name = "Wi-Fi",
                            device = dev,
                            type = "wifi",
                            ip = ipv4,
                            connected = true,
                            network = wifiNetwork
                        )
                    )
                } else if (isCell && result.none { it.id == "cellular" }) {
                    seenDevices.add(dev)
                    result.add(
                        DiscoveredAdapter(
                            id = "cellular",
                            name = "Mobile Data (5G / LTE)",
                            device = dev,
                            type = "cellular",
                            ip = ipv4,
                            connected = true,
                            network = cellularNetwork
                        )
                    )
                } else if (isEth) {
                    seenDevices.add(dev)
                    result.add(
                        DiscoveredAdapter(
                            id = dev,
                            name = "USB / Ethernet",
                            device = dev,
                            type = "ethernet",
                            ip = ipv4,
                            connected = true,
                            network = null
                        )
                    )
                }
            }
        } catch (_: Exception) {
        }

        // Always show both Wi-Fi and Mobile Data slots so user sees their status clearly
        if (result.none { it.id == "wifi" }) {
            result.add(
                0,
                DiscoveredAdapter(
                    id = "wifi",
                    name = "Wi-Fi",
                    device = "wlan0",
                    type = "wifi",
                    ip = "Disconnected",
                    connected = false,
                    network = null
                )
            )
        }
        if (result.none { it.id == "cellular" }) {
            result.add(
                DiscoveredAdapter(
                    id = "cellular",
                    name = "Mobile Data (5G / LTE)",
                    device = "rmnet_data0",
                    type = "cellular",
                    ip = "Standby (Enable Mobile Data)",
                    connected = false,
                    network = null
                )
            )
        }

        return result
    }

    fun getActiveListenInterfacesString(port: Int = 6881): String {
        val enabledConnected = discoverAdapters().filter { it.connected && isAdapterEnabled(it.id) }
        if (enabledConnected.isEmpty()) return "0.0.0.0:$port"
        return enabledConnected.joinToString(",") { "${it.ip}:$port" }
    }

    fun getActiveOutgoingInterfacesString(): String {
        val enabledConnected = discoverAdapters().filter { it.connected && isAdapterEnabled(it.id) }
        if (enabledConnected.isEmpty()) return ""
        return enabledConnected.joinToString(",") { it.device }
    }

    fun sampleTelemetry(
        totalTorrentDown: Long,
        totalTorrentUp: Long,
        peers: List<PeerItem>
    ): NetworkSnapshot {
        val discovered = discoverAdapters()
        val activeAdapters = discovered.filter { it.connected && isAdapterEnabled(it.id) }

        val downByAdapter = mutableMapOf<String, Long>()
        val upByAdapter = mutableMapOf<String, Long>()
        val peersByAdapter = mutableMapOf<String, Int>()

        for (adapter in activeAdapters) {
            val matchingPeers = peers.filter { it.networkType == adapter.type }
            peersByAdapter[adapter.id] = matchingPeers.size
            downByAdapter[adapter.id] = matchingPeers.sumOf { it.downloadSpeed }
            upByAdapter[adapter.id] = matchingPeers.sumOf { it.uploadSpeed }
        }

        // Harmonize unallocated torrent download & upload speeds across active adapters
        val wireDownSum = downByAdapter.values.sum()
        val unallocatedDown = max(0L, totalTorrentDown - wireDownSum)
        if (unallocatedDown > 0L && activeAdapters.isNotEmpty()) {
            val totalPeersCount = peersByAdapter.values.sum().coerceAtLeast(1)
            for (adapter in activeAdapters) {
                val weight = if (peers.isNotEmpty()) {
                    peersByAdapter[adapter.id]?.toDouble() ?: (1.0 / activeAdapters.size)
                } else {
                    1.0
                }
                val denom = if (peers.isNotEmpty()) totalPeersCount.toDouble() else activeAdapters.size.toDouble()
                val share = (unallocatedDown * (weight / denom)).toLong()
                downByAdapter[adapter.id] = (downByAdapter[adapter.id] ?: 0L) + share
            }
        }

        val wireUpSum = upByAdapter.values.sum()
        val unallocatedUp = max(0L, totalTorrentUp - wireUpSum)
        if (unallocatedUp > 0L && activeAdapters.isNotEmpty()) {
            for (adapter in activeAdapters) {
                val share = unallocatedUp / activeAdapters.size
                upByAdapter[adapter.id] = (upByAdapter[adapter.id] ?: 0L) + share
            }
        }

        val totalDown = downByAdapter.values.sum()
        val totalUp = upByAdapter.values.sum()
        if (totalDown > peakDownSpeed) peakDownSpeed = totalDown

        synchronized(aggregateHistory) {
            aggregateHistory.addLast(totalDown)
            while (aggregateHistory.size > 24) aggregateHistory.removeFirst()
        }

        val items = discovered.map { adapter ->
            val enabled = isAdapterEnabled(adapter.id)
            val active = adapter.connected && enabled
            val down = if (active) (downByAdapter[adapter.id] ?: 0L) else 0L
            val up = if (active) (upByAdapter[adapter.id] ?: 0L) else 0L
            val peerCount = if (active) (peersByAdapter[adapter.id] ?: 0) else 0

            val prevDown = sessionDownloadedMap[adapter.id] ?: 0L
            val prevUp = sessionUploadedMap[adapter.id] ?: 0L
            val newDown = prevDown + down
            val newUp = prevUp + up
            sessionDownloadedMap[adapter.id] = newDown
            sessionUploadedMap[adapter.id] = newUp

            val hist = historyMap.getOrPut(adapter.id) { ArrayDeque() }
            synchronized(hist) {
                hist.addLast(down)
                while (hist.size > 24) hist.removeFirst()
            }

            val sharePct = if (active && totalDown > 0L) {
                ((down.toDouble() / totalDown.toDouble()) * 100.0).roundToInt().coerceIn(0, 100)
            } else {
                0
            }

            NetworkAdapterItem(
                id = adapter.id,
                name = adapter.name,
                device = adapter.device,
                type = adapter.type,
                ip = adapter.ip,
                connected = adapter.connected,
                enabled = enabled,
                active = active,
                downSpeed = down,
                upSpeed = up,
                downloaded = newDown,
                uploaded = newUp,
                peers = peerCount,
                sharePercent = sharePct,
                history = synchronized(hist) { hist.toList() }
            )
        }

        return NetworkSnapshot(
            interfaces = items,
            totalDownSpeed = totalDown,
            totalUpSpeed = totalUp,
            totalDownloaded = sessionDownloadedMap.values.sum(),
            totalUploaded = sessionUploadedMap.values.sum(),
            peakSpeed = peakDownSpeed,
            bondedCount = items.count { it.active },
            connectedCount = items.count { it.connected },
            aggregateHistory = synchronized(aggregateHistory) { aggregateHistory.toList() }
        )
    }

    data class DiscoveredAdapter(
        val id: String,
        val name: String,
        val device: String,
        val type: String,
        val ip: String,
        val connected: Boolean,
        val network: Network?
    )
}
