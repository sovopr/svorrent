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
import java.net.URLDecoder
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.max
import kotlin.math.min

object SvorrentEngine {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val sessionManager by lazy { SessionManager(false) }

    @Volatile
    private var initialized = false

    @Volatile
    private var needsImmediateTick = true

    @Volatile
    var inspectedSwarmHash: String? = null
        set(value) {
            field = value
            if (value != null) {
                needsImmediateTick = true
            }
        }

    private lateinit var appContext: Context
    private lateinit var bondingManager: MultiNetworkBondingManager
    lateinit var downloadDir: File
        private set
    var displayDownloadPath: String = "/Download/Svorrent"
        private set

    private val _torrents = MutableStateFlow<List<TorrentItem>>(emptyList())
    val torrents: StateFlow<List<TorrentItem>> = _torrents.asStateFlow()

    private val _networkSnapshot = MutableStateFlow(NetworkSnapshot())
    val networkSnapshot: StateFlow<NetworkSnapshot> = _networkSnapshot.asStateFlow()

    private val _autoStopSeeding = MutableStateFlow(false)
    val autoStopSeeding: StateFlow<Boolean> = _autoStopSeeding.asStateFlow()

    private val pausedByUser = ConcurrentHashMap.newKeySet<String>()
    private val knownNames = ConcurrentHashMap<String, String>()
    private val swarmCache = ConcurrentHashMap<String, SwarmSnapshot>()

    private val VIDEO_EXTENSIONS = setOf(".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v")

    fun init(context: Context) {
        if (initialized) return
        synchronized(this) {
            if (initialized) return
            appContext = context.applicationContext
            downloadDir = resolveWritableDownloadDir(appContext)

            val prefs = appContext.getSharedPreferences("svorrent_prefs", Context.MODE_PRIVATE)
            _autoStopSeeding.value = prefs.getBoolean("auto_stop_seeding", false)

            // Restore saved torrent display names
            val namePrefs = appContext.getSharedPreferences("svorrent_names", Context.MODE_PRIVATE)
            for ((k, v) in namePrefs.all) {
                if (v is String && v.isNotBlank()) {
                    knownNames[k.lowercase(Locale.US)] = v
                }
            }

            bondingManager = MultiNetworkBondingManager(appContext)
            bondingManager.startBonding {
                scope.launch {
                    applyMultiInterfaceSettings()
                    needsImmediateTick = true
                }
            }

            sessionManager.addListener(object : AlertListener {
                override fun types(): IntArray? = null
                override fun alert(alert: Alert<*>) {
                    when (alert.type()) {
                        AlertType.ADD_TORRENT,
                        AlertType.METADATA_RECEIVED,
                        AlertType.TORRENT_FINISHED -> {
                            needsImmediateTick = true
                        }
                        else -> {}
                    }
                }
            })

            try {
                val sp = buildTunedSettingsPack()
                sessionManager.start(SessionParams(sp))
            } catch (_: Throwable) {
            }

            _networkSnapshot.value = bondingManager.sampleTelemetry(0L, 0L, emptyList(), forceRefreshAdapters = true)
            initialized = true

            scope.launch {
                var idleCycles = 0
                while (true) {
                    try {
                        val hasActive = _torrents.value.any { !it.done && !it.paused }
                        if (hasActive || needsImmediateTick || inspectedSwarmHash != null || idleCycles >= 3) {
                            needsImmediateTick = false
                            idleCycles = 0
                            tickOnce()
                        } else {
                            idleCycles++
                        }
                    } catch (_: Throwable) {
                    }
                    val sleepMs = if (_torrents.value.any { !it.done && !it.paused }) 1200L else 2000L
                    delay(sleepMs)
                }
            }
        }
    }

    private fun resolveWritableDownloadDir(context: Context): File {
        try {
            val pubRoot = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
            val pubDir = File(pubRoot, "Svorrent")
            if (pubDir.exists() || pubDir.mkdirs()) {
                val probe = File(pubDir, ".probe_${System.currentTimeMillis()}")
                probe.writeText("ok")
                if (probe.exists()) {
                    probe.delete()
                    displayDownloadPath = "/Download/Svorrent"
                    return pubDir
                }
            }
        } catch (_: Throwable) {
        }

        val appExt = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: context.filesDir
        val fallbackDir = File(appExt, "Svorrent").apply { mkdirs() }
        displayDownloadPath = "/Android/data/${context.packageName}/files/Download/Svorrent"
        return fallbackDir
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

        sp.setInteger(settings_pack.int_types.connections_limit.swigValue(), 75)
        sp.setInteger(settings_pack.int_types.active_downloads.swigValue(), 6)
        sp.setInteger(settings_pack.int_types.active_seeds.swigValue(), 4)
        sp.setInteger(settings_pack.int_types.active_limit.swigValue(), 12)
        sp.setInteger(settings_pack.int_types.max_out_request_queue.swigValue(), 500)
        sp.setInteger(settings_pack.int_types.request_queue_time.swigValue(), 4)
        sp.setInteger(settings_pack.int_types.aio_threads.swigValue(), 2)

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
            sessionManager.applySettings(sp)
            sessionManager.reopenNetworkSockets()
        } catch (_: Throwable) {
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
        needsImmediateTick = true
    }

    fun setAdapterRouting(adapterId: String, enabled: Boolean) {
        if (!::bondingManager.isInitialized) return
        bondingManager.setAdapterEnabled(adapterId, enabled)
        scope.launch {
            applyMultiInterfaceSettings()
            _networkSnapshot.value = bondingManager.sampleTelemetry(
                _torrents.value.sumOf { it.downloadSpeed },
                _torrents.value.sumOf { it.uploadSpeed },
                emptyList(),
                forceRefreshAdapters = true
            )
            needsImmediateTick = true
        }
    }

    fun refreshAdapters() {
        if (!::bondingManager.isInitialized) return
        scope.launch {
            bondingManager.invalidateCache()
            applyMultiInterfaceSettings()
            _networkSnapshot.value = bondingManager.sampleTelemetry(
                _torrents.value.sumOf { it.downloadSpeed },
                _torrents.value.sumOf { it.uploadSpeed },
                emptyList(),
                forceRefreshAdapters = true
            )
            needsImmediateTick = true
        }
    }

    internal fun extractMagnetDisplayName(magnetUri: String): String? {
        return try {
            val query = magnetUri.substringAfter("magnet:?", "")
            for (part in query.split("&")) {
                if (part.startsWith("dn=", ignoreCase = true)) {
                    val decoded = URLDecoder.decode(part.substring(3), "UTF-8").trim()
                    if (decoded.isNotBlank()) return decoded
                }
            }
            null
        } catch (_: Throwable) {
            null
        }
    }

    fun addMagnet(rawInput: String, preferredTitle: String? = null): Result<String> {
        return try {
            val trimmed = rawInput.trim()
            val magnetUri = when {
                trimmed.startsWith("magnet:?", ignoreCase = true) -> trimmed
                trimmed.matches(Regex("^[0-9a-fA-F]{40}$")) ->
                    SearchRepository.buildMagnetUri(
                        trimmed.lowercase(Locale.US),
                        preferredTitle?.takeIf { it.isNotBlank() } ?: "Torrent-${trimmed.take(8)}"
                    )
                else -> return Result.failure(IllegalArgumentException("Enter a valid magnet link or 40-character info hash"))
            }

            val parsed = AddTorrentParams.parseMagnetUri(magnetUri)
            val hashHex = parsed.infoHashes.best.toHex().lowercase(Locale.US)
            val dnFromUri = extractMagnetDisplayName(magnetUri)
            val displayName = preferredTitle?.takeIf { it.isNotBlank() }
                ?: dnFromUri
                ?: parsed.name.takeIf { it.isNotBlank() && !it.equals(hashHex, ignoreCase = true) }
                ?: knownNames[hashHex]
                ?: "Torrent-${hashHex.take(8)}"

            knownNames[hashHex] = displayName
            if (::appContext.isInitialized) {
                appContext.getSharedPreferences("svorrent_names", Context.MODE_PRIVATE)
                    .edit()
                    .putString(hashHex, displayName)
                    .apply()
            }
            pausedByUser.remove(hashHex)

            val currentList = _torrents.value
            if (currentList.none { it.infoHash == hashHex }) {
                _torrents.value = listOf(
                    TorrentItem(
                        infoHash = hashHex,
                        name = displayName,
                        progress = 0f,
                        downloadSpeed = 0L,
                        uploadSpeed = 0L,
                        numPeers = 0,
                        timeRemainingSec = 0L,
                        done = false,
                        paused = false,
                        ready = false,
                        length = 0L,
                        downloaded = 0L,
                        filesCount = 1,
                        savePath = downloadDir.absolutePath
                    )
                ) + currentList
            }

            scope.launch {
                try {
                    sessionManager.download(magnetUri, downloadDir, TorrentFlags.SEQUENTIAL_DOWNLOAD)
                    needsImmediateTick = true
                } catch (_: Throwable) {
                }
            }

            if (::appContext.isInitialized) {
                SvorrentEngineService.ensureRunning(appContext)
            }
            Result.success(hashHex)
        } catch (e: Throwable) {
            Result.failure(e)
        }
    }

    fun togglePause(infoHash: String) {
        scope.launch {
            val handle = findHandle(infoHash) ?: return@launch
            val key = infoHash.lowercase(Locale.US)
            try {
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
                needsImmediateTick = true
            } catch (_: Throwable) {
            }
        }
    }

    fun forceRecheck(infoHash: String) {
        scope.launch {
            try {
                findHandle(infoHash)?.forceRecheck()
                needsImmediateTick = true
            } catch (_: Throwable) {
            }
        }
    }

    fun removeTorrent(infoHash: String, deleteFiles: Boolean) {
        val key = infoHash.lowercase(Locale.US)
        pausedByUser.remove(key)
        swarmCache.remove(key)
        _torrents.value = _torrents.value.filterNot { it.infoHash == key }
        scope.launch {
            try {
                val handle = findHandle(key) ?: return@launch
                if (deleteFiles) {
                    sessionManager.remove(handle, session_handle.delete_files)
                } else {
                    sessionManager.remove(handle)
                }
                needsImmediateTick = true
            } catch (_: Throwable) {
            }
        }
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
        } catch (_: Throwable) {
            null
        }
    }

    private fun isHexHash(candidate: String?, infoHash: String): Boolean {
        if (candidate.isNullOrBlank()) return true
        val trimmed = candidate.trim()
        return trimmed.equals(infoHash, ignoreCase = true) ||
            trimmed.startsWith("Magnet-", ignoreCase = true) ||
            trimmed.matches(Regex("^[0-9a-fA-F]{40}$"))
    }

    @Synchronized
    private fun tickOnce() {
        if (!initialized || !sessionManager.isRunning) return
        val swigSession = sessionManager.swig() ?: return
        val handlesVec = try {
            swigSession.get_torrents()
        } catch (_: Throwable) {
            return
        }
        val count = handlesVec.size

        val activeAdapters = bondingManager.discoverAdapters()
            .filter { it.connected && bondingManager.isAdapterEnabled(it.id) }

        val items = mutableListOf<TorrentItem>()
        val allPeers = mutableListOf<PeerItem>()
        var totalDown = 0L
        var totalUp = 0L
        val currentInspectedHash = inspectedSwarmHash?.lowercase(Locale.US)

        for (i in 0 until count) {
            val handle = try {
                TorrentHandle(handlesVec[i])
            } catch (_: Throwable) {
                continue
            }
            if (!handle.isValid) continue

            val infoHash = try {
                handle.infoHash().toHex().lowercase(Locale.US)
            } catch (_: Throwable) {
                continue
            }

            // Query QUERY_NAME (and QUERY_PIECES only if this torrent's Swarm modal is currently open)
            val status = try {
                if (currentInspectedHash == infoHash) {
                    handle.status(TorrentHandle.QUERY_NAME.or_(TorrentHandle.QUERY_PIECES))
                } else {
                    handle.status(TorrentHandle.QUERY_NAME)
                }
            } catch (_: Throwable) {
                continue
            }

            val hasMeta = status.hasMetadata()
            val isDone = status.isFinished || status.isSeeding
            val isPaused = pausedByUser.contains(infoHash)

            if (isDone && _autoStopSeeding.value && !isPaused) {
                pausedByUser.add(infoHash)
                runCatching {
                    handle.unsetFlags(TorrentFlags.AUTO_MANAGED)
                    handle.pause()
                }
            }

            val rawPeers: List<PeerInfo> = if (!isPaused) {
                try {
                    handle.peerInfo()
                } catch (_: Throwable) {
                    emptyList()
                }
            } else {
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
                    client = p.client()?.takeIf { it.isNotBlank() } ?: "Torrent Peer",
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

            val peerDownSum = torrentPeers.sumOf { it.downloadSpeed }
            val peerUpSum = torrentPeers.sumOf { it.uploadSpeed }

            val statusDown = max(status.downloadPayloadRate().toLong(), status.downloadRate().toLong()).coerceAtLeast(0L)
            val statusUp = max(status.uploadPayloadRate().toLong(), status.uploadRate().toLong()).coerceAtLeast(0L)

            val downRate = if (isPaused || isDone) 0L else max(statusDown, peerDownSum)
            val upRate = if (isPaused) 0L else max(statusUp, peerUpSum)
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
            var torrentFileName: String? = null
            var totalPiecesFromTorrentFile = 0
            var pieceLenFromTorrentFile = 0L

            if (hasMeta) {
                try {
                    val tf = handle.torrentFile()
                    if (tf != null) {
                        torrentFileName = tf.name()?.takeIf { !isHexHash(it, infoHash) }
                        totalPiecesFromTorrentFile = tf.numPieces().coerceAtLeast(0)
                        pieceLenFromTorrentFile = tf.pieceLength().toLong().coerceAtLeast(0L)

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
                } catch (_: Throwable) {
                }
            }

            val canPlay = primaryVideoPath != null && (isDone || primaryVideoProgress >= 0.05f)
            val playReason = when {
                primaryVideoPath == null -> "No video file"
                canPlay -> "Ready to play in video player"
                else -> "Buffering initial pieces (${(primaryVideoProgress * 100).toInt()}% / 5%)"
            }

            // Crash-proof Piece Telemetry builder (never indexes into an empty C++ bitfield)
            val pieceTelemetry = if (currentInspectedHash == infoHash) {
                buildSafePieceTelemetry(
                    status = status,
                    hasMeta = hasMeta,
                    prog = prog,
                    fallbackTotalPieces = totalPiecesFromTorrentFile,
                    pieceLen = pieceLenFromTorrentFile
                )
            } else {
                swarmCache[infoHash]?.pieceTelemetry
            }

            // Resolve real human-readable torrent name (never Magnet-<hex> if a title is known)
            val statusName = status.name()?.takeIf { !isHexHash(it, infoHash) }
            val handleName = runCatching { handle.name }.getOrNull()?.takeIf { !isHexHash(it, infoHash) }
            val firstFileName = fileItems.firstOrNull()?.name?.takeIf { !isHexHash(it, infoHash) }

            val resolvedName = torrentFileName
                ?: statusName
                ?: handleName
                ?: knownNames[infoHash]
                ?: firstFileName
                ?: "Torrent-${infoHash.take(8)}"

            if (!isHexHash(resolvedName, infoHash)) {
                knownNames[infoHash] = resolvedName
            }

            items.add(
                TorrentItem(
                    infoHash = infoHash,
                    name = resolvedName,
                    progress = prog,
                    downloadSpeed = downRate,
                    uploadSpeed = upRate,
                    numPeers = max(torrentPeers.size, status.numPeers()),
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
                    trackers = emptyList()
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

    private fun buildSafePieceTelemetry(
        status: org.libtorrent4j.TorrentStatus,
        hasMeta: Boolean,
        prog: Float,
        fallbackTotalPieces: Int,
        pieceLen: Long
    ): PieceTelemetry {
        val gridBins = 120
        try {
            if (hasMeta) {
                val pieces = status.pieces()
                val rawSize = pieces?.size() ?: 0
                if (pieces != null && rawSize > 0) {
                    val verifiedPieces = pieces.count().coerceIn(0, rawSize)
                    val bins = min(gridBins, rawSize)
                    val grid = MutableList(bins) { 0 }
                    var firstMissing = rawSize
                    for (pIdx in 0 until rawSize) {
                        if (!pieces.getBit(pIdx)) {
                            firstMissing = pIdx
                            break
                        }
                    }

                    for (b in 0 until bins) {
                        val start = (b * rawSize) / bins
                        val end = max(start + 1, ((b + 1) * rawSize) / bins).coerceAtMost(rawSize)
                        var verifiedInBin = 0
                        for (pIdx in start until end) {
                            if (pieces.getBit(pIdx)) verifiedInBin++
                        }
                        grid[b] = when {
                            verifiedInBin >= (end - start) -> 2
                            verifiedInBin > 0 || (start <= firstMissing + 6 && end >= firstMissing) -> 1
                            else -> 0
                        }
                    }

                    return PieceTelemetry(
                        totalPieces = rawSize,
                        verifiedPieces = verifiedPieces,
                        progressPercent = String.format(Locale.US, "%.1f", prog * 100f),
                        pieceLength = pieceLen,
                        streamingCursorPiece = min(firstMissing, rawSize - 1).coerceAtLeast(0),
                        piecesGrid = grid,
                        availability = emptyList()
                    )
                }
            }
        } catch (_: Throwable) {
        }

        // Safe fallback grid derived from progress (used while metadata is still arriving or if bitfield is empty)
        val total = fallbackTotalPieces.takeIf { it > 0 } ?: gridBins
        val verified = (prog * total).toInt().coerceIn(0, total)
        val verifiedBins = (prog * gridBins).toInt().coerceIn(0, gridBins)
        val fallbackGrid = List(gridBins) { b ->
            when {
                b < verifiedBins -> 2
                b == verifiedBins && prog > 0f && prog < 1f -> 1
                else -> 0
            }
        }
        return PieceTelemetry(
            totalPieces = total,
            verifiedPieces = verified,
            progressPercent = String.format(Locale.US, "%.1f", prog * 100f),
            pieceLength = pieceLen,
            streamingCursorPiece = min(verified, total - 1).coerceAtLeast(0),
            piecesGrid = fallbackGrid,
            availability = emptyList()
        )
    }
}
