package com.svorrent.app

import android.content.Context
import android.os.Environment
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.libtorrent4j.AddTorrentParams
import org.libtorrent4j.AlertListener
import org.libtorrent4j.PeerInfo
import org.libtorrent4j.Priority
import org.libtorrent4j.SessionManager
import org.libtorrent4j.SessionParams
import org.libtorrent4j.SettingsPack
import org.libtorrent4j.Sha1Hash
import org.libtorrent4j.TorrentFlags
import org.libtorrent4j.TorrentHandle
import org.libtorrent4j.alerts.Alert
import org.libtorrent4j.alerts.AlertType
import org.libtorrent4j.swig.session_handle
import org.libtorrent4j.swig.settings_pack
import java.io.File
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.max
import kotlin.math.min

object SvorrentEngine {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val sessionManager = SessionManager(false)

    @Volatile
    private var initialized = false

    private lateinit var appContext: Context
    private lateinit var bondingManager: MultiNetworkBondingManager
    lateinit var downloadDir: File
        private set

    private val _torrents = MutableStateFlow<List<TorrentItem>>(emptyList())
    val torrents: StateFlow<List<TorrentItem>> = _torrents.asStateFlow()

    private val _networkSnapshot = MutableStateFlow(NetworkSnapshot())
    val networkSnapshot: StateFlow<NetworkSnapshot> = _networkSnapshot.asStateFlow()

    private val _autoStopSeeding = MutableStateFlow(false)
    val autoStopSeeding: StateFlow<Boolean> = _autoStopSeeding.asStateFlow()

    private val pausedByUser = ConcurrentHashMap.newKeySet<String>()
    private val swarmCache = ConcurrentHashMap<String, SwarmSnapshot>()

    private val VIDEO_EXTENSIONS = setOf(".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v")

    fun init(context: Context) {
        if (initialized) return
        synchronized(this) {
            if (initialized) return
            appContext = context.applicationContext
            val publicDownloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
            downloadDir = File(publicDownloads, "Svorrent").apply { mkdirs() }

            val prefs = appContext.getSharedPreferences("svorrent_prefs", Context.MODE_PRIVATE)
            _autoStopSeeding.value = prefs.getBoolean("auto_stop_seeding", false)

            bondingManager = MultiNetworkBondingManager(appContext)
            bondingManager.startBonding {
                applyMultiInterfaceSettings()
            }

            sessionManager.addListener(object : AlertListener {
                override fun types(): IntArray? = null
                override fun alert(alert: Alert<*>) {
                    when (alert.type()) {
                        AlertType.ADD_TORRENT,
                        AlertType.METADATA_RECEIVED -> {
                            tickOnce()
                        }
                        else -> {}
                    }
                }
            })

            val sp = buildTunedSettingsPack()
            sessionManager.start(SessionParams(sp))
            initialized = true

            scope.launch {
                while (true) {
                    try {
                        tickOnce()
                    } catch (_: Exception) {
                    }
                    delay(1000L)
                }
            }
        }
    }

    private fun buildTunedSettingsPack(): SettingsPack {
        val sp = SettingsPack()
        sp.setBoolean(settings_pack.bool_types.enable_dht.swigValue(), true)
        sp.setBoolean(settings_pack.bool_types.enable_lsd.swigValue(), true)
        sp.setBoolean(settings_pack.bool_types.enable_natpmp.swigValue(), true)
        sp.setBoolean(settings_pack.bool_types.enable_upnp.swigValue(), true)
        sp.setBoolean(settings_pack.bool_types.announce_to_all_trackers.swigValue(), true)
        sp.setBoolean(settings_pack.bool_types.announce_to_all_tiers.swigValue(), true)
        sp.setBoolean(settings_pack.bool_types.prefer_rc4.swigValue(), true)

        // High-speed Swarm Pipeline Accelerator parameters
        sp.setInteger(settings_pack.int_types.connections_limit.swigValue(), 200)
        sp.setInteger(settings_pack.int_types.active_downloads.swigValue(), 10)
        sp.setInteger(settings_pack.int_types.active_seeds.swigValue(), 10)
        sp.setInteger(settings_pack.int_types.active_limit.swigValue(), 25)
        sp.setInteger(settings_pack.int_types.max_out_request_queue.swigValue(), 1500)
        sp.setInteger(settings_pack.int_types.request_queue_time.swigValue(), 6)
        sp.setInteger(settings_pack.int_types.aio_threads.swigValue(), 8)

        val listenStr = bondingManager.getActiveListenInterfacesString(6881)
        sp.setString(settings_pack.string_types.listen_interfaces.swigValue(), listenStr)
        val outgoingStr = bondingManager.getActiveOutgoingInterfacesString()
        if (outgoingStr.isNotEmpty()) {
            sp.setString(settings_pack.string_types.outgoing_interfaces.swigValue(), outgoingStr)
        }
        return sp
    }

    fun applyMultiInterfaceSettings() {
        if (!initialized || !sessionManager.isRunning) return
        try {
            val sp = buildTunedSettingsPack()
            sessionManager.swig().apply_settings(sp.swig())
            sessionManager.reopenNetworkSockets()
        } catch (_: Exception) {
        }
    }

    fun setAutoStopSeeding(enabled: Boolean) {
        _autoStopSeeding.value = enabled
        if (::appContext.isInitialized) {
            appContext.getSharedPreferences("svorrent_prefs", Context.MODE_PRIVATE)
                .edit()
                .putBoolean("auto_stop_seeding", enabled)
                .apply()
        }
        if (enabled) {
            tickOnce()
        }
    }

    fun setAdapterRouting(adapterId: String, enabled: Boolean) {
        if (!::bondingManager.isInitialized) return
        bondingManager.setAdapterEnabled(adapterId, enabled)
        applyMultiInterfaceSettings()
        tickOnce()
    }

    fun refreshAdapters() {
        applyMultiInterfaceSettings()
        tickOnce()
    }

    fun addMagnet(rawInput: String): Result<String> {
        return try {
            val trimmed = rawInput.trim()
            val magnetUri = when {
                trimmed.startsWith("magnet:?", ignoreCase = true) -> trimmed
                trimmed.matches(Regex("^[0-9a-fA-F]{40}$")) ->
                    SearchRepository.buildMagnetUri(trimmed.lowercase(), "Torrent-${trimmed.take(8)}")
                else -> return Result.failure(IllegalArgumentException("Enter a valid magnet link or 40-character info hash"))
            }

            val params = AddTorrentParams.parseMagnetUri(magnetUri)
            params.savePath = downloadDir.absolutePath
            params.flags = params.flags.or_(TorrentFlags.SEQUENTIAL_DOWNLOAD)
            val hashHex = params.infoHashes.best.toHex().lowercase(Locale.US)
            pausedByUser.remove(hashHex)
            sessionManager.swig().async_add_torrent(params.swig())
            SvorrentEngineService.ensureRunning(appContext)
            Result.success(hashHex)
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    fun togglePause(infoHash: String) {
        val handle = findHandle(infoHash) ?: return
        val key = infoHash.lowercase(Locale.US)
        if (pausedByUser.contains(key)) {
            pausedByUser.remove(key)
            handle.unsetFlags(TorrentFlags.AUTO_MANAGED)
            handle.resume()
            handle.forceReannounce()
        } else {
            pausedByUser.add(key)
            handle.unsetFlags(TorrentFlags.AUTO_MANAGED)
            handle.pause()
        }
        tickOnce()
    }

    fun forceRecheck(infoHash: String) {
        val handle = findHandle(infoHash) ?: return
        handle.forceRecheck()
        tickOnce()
    }

    fun removeTorrent(infoHash: String, deleteFiles: Boolean) {
        val handle = findHandle(infoHash) ?: return
        val key = infoHash.lowercase(Locale.US)
        pausedByUser.remove(key)
        swarmCache.remove(key)
        if (deleteFiles) {
            sessionManager.remove(handle, session_handle.delete_files)
        } else {
            sessionManager.remove(handle)
        }
        tickOnce()
    }

    fun getSwarmSnapshot(infoHash: String): SwarmSnapshot? {
        return swarmCache[infoHash.lowercase(Locale.US)]
    }

    private fun findHandle(infoHash: String): TorrentHandle? {
        if (!initialized || !sessionManager.isRunning) return null
        return try {
            val hash = Sha1Hash.parseHex(infoHash.lowercase(Locale.US))
            val h = sessionManager.find(hash)
            if (h != null && h.isValid) h else null
        } catch (_: Exception) {
            null
        }
    }

    private fun updateRollingCriticalFrontier(handle: TorrentHandle) {
        try {
            val status = handle.status()
            if (!status.hasMetadata() || status.isFinished || status.isSeeding) return
            val pieces = status.pieces() ?: return
            val numPieces = pieces.size()
            if (numPieces <= 0) return

            var firstMissing = 0
            while (firstMissing < numPieces && pieces.getBit(firstMissing)) {
                firstMissing++
            }

            // Rolling window of next 16 unverified pieces marked TOP_PRIORITY
            var marked = 0
            var idx = firstMissing
            while (idx < numPieces && marked < 16) {
                if (!pieces.getBit(idx)) {
                    handle.piecePriority(idx, Priority.TOP_PRIORITY)
                    marked++
                }
                idx++
            }
        } catch (_: Exception) {
        }
    }

    @Synchronized
    private fun tickOnce() {
        if (!initialized || !sessionManager.isRunning) return
        val swigSession = sessionManager.swig()
        val handlesVec = swigSession.get_torrents()
        val count = handlesVec.size

        val activeAdapters = bondingManager.discoverAdapters()
            .filter { it.connected && bondingManager.isAdapterEnabled(it.id) }

        val items = mutableListOf<TorrentItem>()
        val allPeers = mutableListOf<PeerItem>()
        var totalDown = 0L
        var totalUp = 0L

        for (i in 0 until count) {
            val handle = TorrentHandle(handlesVec[i])
            if (!handle.isValid) continue

            val infoHash = handle.infoHash().toHex().lowercase(Locale.US)
            val status = handle.status()
            val hasMeta = status.hasMetadata()
            val isDone = status.isFinished || status.isSeeding
            val isPaused = pausedByUser.contains(infoHash)

            if (isDone && _autoStopSeeding.value && !isPaused) {
                pausedByUser.add(infoHash)
                handle.unsetFlags(TorrentFlags.AUTO_MANAGED)
                handle.pause()
            }

            if (hasMeta && !isDone && !isPaused) {
                updateRollingCriticalFrontier(handle)
            }

            val downRate = if (isPaused || isDone) 0L else status.downloadPayloadRate().toLong().coerceAtLeast(0L)
            val upRate = if (isPaused) 0L else status.uploadPayloadRate().toLong().coerceAtLeast(0L)
            totalDown += downRate
            totalUp += upRate

            val totalWanted = status.totalWanted().coerceAtLeast(0L)
            val totalDone = status.totalWantedDone().coerceAtLeast(0L)
            val prog = if (isDone) 1.0f else status.progress().coerceIn(0f, 1f)
            val remainingBytes = max(0L, totalWanted - totalDone)
            val etaSec = if (downRate > 0L && !isDone) remainingBytes / downRate else 0L

            val fileItems = mutableListOf<TorrentFileItem>()
            var primaryVideoPath: String? = null
            var primaryVideoProgress = 0f

            if (hasMeta) {
                try {
                    val tf = handle.torrentFile()
                    if (tf != null) {
                        val files = tf.files()
                        val progressArr = handle.fileProgress()
                        val numFiles = files.numFiles()
                        var largestVideoSize = 0L
                        for (fIdx in 0 until numFiles) {
                            val fName = files.fileName(fIdx)
                            val fPath = files.filePath(fIdx)
                            val fSize = files.fileSize(fIdx)
                            val fDone = if (fIdx < progressArr.size) progressArr[fIdx] else 0L
                            val fProg = if (fSize > 0) (fDone.toFloat() / fSize.toFloat()).coerceIn(0f, 1f) else 0f
                            fileItems.add(TorrentFileItem(fIdx, fName, fPath, fSize, fDone, fProg))

                            val lower = fName.lowercase(Locale.US)
                            if (VIDEO_EXTENSIONS.any { lower.endsWith(it) } && fSize > largestVideoSize) {
                                largestVideoSize = fSize
                                primaryVideoPath = File(downloadDir, fPath).absolutePath
                                primaryVideoProgress = fProg
                            }
                        }
                    }
                } catch (_: Exception) {
                }
            }

            val canPlay = primaryVideoPath != null && (isDone || primaryVideoProgress >= 0.05f)
            val playReason = when {
                primaryVideoPath == null -> "No video file"
                canPlay -> "Ready to play in VLC / Video Player"
                else -> "Buffering initial pieces (${(primaryVideoProgress * 100).toInt()}% / 5%)"
            }

            // Collect peer list & assign across active Wi-Fi + Cellular adapters
            val rawPeers: List<PeerInfo> = try {
                handle.peerInfo()
            } catch (_: Exception) {
                emptyList()
            }

            val torrentPeers = rawPeers.mapIndexed { idx, p ->
                val assignedAdapter = if (activeAdapters.isNotEmpty()) {
                    activeAdapters[idx % activeAdapters.size]
                } else {
                    null
                }
                val ipPort = p.ip() ?: "0.0.0.0:0"
                val splitIdx = ipPort.lastIndexOf(':')
                val ip = if (splitIdx > 0) ipPort.substring(0, splitIdx) else ipPort
                val port = if (splitIdx > 0) ipPort.substring(splitIdx + 1).toIntOrNull() ?: 6881 else 6881

                PeerItem(
                    ip = ip,
                    port = port,
                    client = p.client()?.takeIf { it.isNotBlank() } ?: "BitTorrent Peer",
                    protocol = "TCP",
                    networkInterface = assignedAdapter?.name ?: "Wi-Fi",
                    networkType = assignedAdapter?.type ?: "wifi",
                    downloadSpeed = p.downSpeed().toLong().coerceAtLeast(0L),
                    uploadSpeed = p.upSpeed().toLong().coerceAtLeast(0L),
                    progressPercent = (p.progress() * 100f).toInt().coerceIn(0, 100),
                    choked = false
                )
            }
            allPeers.addAll(torrentPeers)

            // Build piece telemetry for Swarm Modal
            val pieceTelemetry = if (hasMeta) {
                try {
                    val pieces = status.pieces()
                    val totalPieces = pieces.size().coerceAtLeast(1)
                    val verifiedPieces = pieces.count()
                    val availArr = handle.pieceAvailability()
                    val gridBins = min(160, totalPieces)
                    val grid = MutableList(gridBins) { 0 }
                    val availBins = MutableList(gridBins) { 0 }
                    var firstMissingPiece = totalPieces
                    for (pIdx in 0 until totalPieces) {
                        if (!pieces.getBit(pIdx) && firstMissingPiece == totalPieces) {
                            firstMissingPiece = pIdx
                        }
                    }

                    for (b in 0 until gridBins) {
                        val start = (b * totalPieces) / gridBins
                        val end = max(start + 1, ((b + 1) * totalPieces) / gridBins)
                        var verifiedInBin = 0
                        var maxAvail = 0
                        for (pIdx in start until min(end, totalPieces)) {
                            if (pieces.getBit(pIdx)) verifiedInBin++
                            if (pIdx < availArr.size && availArr[pIdx] > maxAvail) {
                                maxAvail = availArr[pIdx]
                            }
                        }
                        grid[b] = when {
                            verifiedInBin == (end - start) -> 2
                            verifiedInBin > 0 || (start <= firstMissingPiece + 8 && end >= firstMissingPiece) -> 1
                            else -> 0
                        }
                        availBins[b] = if (rawPeers.isNotEmpty()) {
                            min(100, (maxAvail * 100) / max(1, rawPeers.size))
                        } else if (grid[b] == 2) {
                            100
                        } else {
                            0
                        }
                    }

                    val pieceLen = handle.torrentFile()?.pieceLength()?.toLong() ?: 0L
                    PieceTelemetry(
                        totalPieces = totalPieces,
                        verifiedPieces = verifiedPieces,
                        progressPercent = String.format(Locale.US, "%.1f", prog * 100f),
                        pieceLength = pieceLen,
                        streamingCursorPiece = min(firstMissingPiece, totalPieces - 1),
                        piecesGrid = grid,
                        availability = availBins
                    )
                } catch (_: Exception) {
                    null
                }
            } else {
                null
            }

            val trackersList = try {
                handle.trackers().mapNotNull { it.url() }
            } catch (_: Exception) {
                emptyList()
            }

            val displayName = status.name()?.takeIf { it.isNotBlank() } ?: "Magnet-$infoHash"

            items.add(
                TorrentItem(
                    infoHash = infoHash,
                    name = displayName,
                    progress = prog,
                    downloadSpeed = downRate,
                    uploadSpeed = upRate,
                    numPeers = torrentPeers.size,
                    timeRemainingSec = etaSec,
                    done = isDone,
                    paused = isPaused,
                    ready = hasMeta,
                    length = totalWanted,
                    downloaded = totalDone,
                    filesCount = max(1, fileItems.size),
                    savePath = downloadDir.absolutePath,
                    primaryVideoFile = primaryVideoPath,
                    canPlay = canPlay,
                    playReason = playReason,
                    files = fileItems,
                    trackers = trackersList
                )
            )

            val netSnap = _networkSnapshot.value
            swarmCache[infoHash] = SwarmSnapshot(
                infoHash = infoHash,
                peers = torrentPeers,
                pieceTelemetry = pieceTelemetry,
                interfaces = netSnap.interfaces.filter { it.active }
            )
        }

        _torrents.value = items
        _networkSnapshot.value = bondingManager.sampleTelemetry(totalDown, totalUp, allPeers)
    }
}

