package com.svorrent.app

import java.util.Locale
import kotlin.math.ln
import kotlin.math.pow

data class SearchResultItem(
    val id: String,
    val title: String,
    val sizeBytes: Long,
    val sizeFormatted: String,
    val seeds: Int,
    val leechers: Int,
    val provider: String,
    val infoHash: String,
    val magnet: String
)

data class TorrentFileItem(
    val index: Int,
    val name: String,
    val path: String,
    val length: Long,
    val downloaded: Long,
    val progress: Float
)

data class TorrentItem(
    val infoHash: String,
    val name: String,
    val progress: Float,
    val downloadSpeed: Long,
    val uploadSpeed: Long,
    val numPeers: Int,
    val timeRemainingSec: Long,
    val done: Boolean,
    val paused: Boolean,
    val ready: Boolean,
    val length: Long,
    val downloaded: Long,
    val filesCount: Int,
    val savePath: String,
    val primaryVideoFile: String?,
    val canPlay: Boolean,
    val playReason: String,
    val files: List<TorrentFileItem> = emptyList(),
    val trackers: List<String> = emptyList()
)

data class PeerItem(
    val ip: String,
    val port: Int,
    val client: String,
    val protocol: String,
    val networkInterface: String,
    val networkType: String,
    val downloadSpeed: Long,
    val uploadSpeed: Long,
    val progressPercent: Int,
    val choked: Boolean
)

data class PieceTelemetry(
    val totalPieces: Int,
    val verifiedPieces: Int,
    val progressPercent: String,
    val pieceLength: Long,
    val streamingCursorPiece: Int,
    val piecesGrid: List<Int>,
    val availability: List<Int>
)

data class SwarmSnapshot(
    val infoHash: String,
    val peers: List<PeerItem>,
    val pieceTelemetry: PieceTelemetry?,
    val interfaces: List<NetworkAdapterItem>
)

data class NetworkAdapterItem(
    val id: String,
    val name: String,
    val device: String,
    val type: String, // "wifi" or "cellular" or "ethernet"
    val ip: String,
    val connected: Boolean,
    val enabled: Boolean,
    val active: Boolean,
    val downSpeed: Long,
    val upSpeed: Long,
    val downloaded: Long,
    val uploaded: Long,
    val peers: Int,
    val sharePercent: Int,
    val history: List<Long>
)

data class NetworkSnapshot(
    val interfaces: List<NetworkAdapterItem> = emptyList(),
    val totalDownSpeed: Long = 0L,
    val totalUpSpeed: Long = 0L,
    val totalDownloaded: Long = 0L,
    val totalUploaded: Long = 0L,
    val peakSpeed: Long = 0L,
    val bondedCount: Int = 0,
    val connectedCount: Int = 0,
    val aggregateHistory: List<Long> = emptyList()
)

object Formatters {
    fun formatBytes(bytes: Long): String {
        if (bytes <= 0L) return "0 B"
        val units = arrayOf("B", "KB", "MB", "GB", "TB")
        val digitGroups = (ln(bytes.toDouble()) / ln(1024.0)).toInt().coerceIn(0, units.lastIndex)
        val value = bytes / 1024.0.pow(digitGroups.toDouble())
        return if (digitGroups == 0) {
            "$bytes B"
        } else {
            String.format(Locale.US, "%.1f %s", value, units[digitGroups])
        }
    }

    fun formatSpeed(bytesPerSec: Long): String {
        if (bytesPerSec <= 0L) return "0 B/s"
        return "${formatBytes(bytesPerSec)}/s"
    }

    fun formatEta(seconds: Long): String {
        if (seconds <= 0L || seconds > 86400L * 30) return "—"
        val h = seconds / 3600
        val m = (seconds % 3600) / 60
        val s = seconds % 60
        return when {
            h > 0 -> "${h}h ${m}m"
            m > 0 -> "${m}m ${s}s"
            else -> "${s}s"
        }
    }
}

