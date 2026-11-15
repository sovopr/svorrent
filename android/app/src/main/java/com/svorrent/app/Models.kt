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
    val magnet: String,
    val category: String = "Video",
    val age: String = "",
    val imdbId: String = "",
    val detailUrl: String = ""
)

data class SpotlightCardItem(
    val id: String,
    val title: String,
    val year: String = "",
    val genre: String = "",
    val summary: String = "",
    val poster: String = "",
    val searchQuery: String = title
)

data class DiscoverFeedResult(
    val category: String,
    val window: String,
    val spotlight: List<SpotlightCardItem>,
    val torrents: List<SearchResultItem>
)

data class DownloadHistoryEntry(
    val infoHash: String,
    val name: String,
    val magnetUri: String = "",
    val length: Long = 0L,
    val completedAt: Long = 0L,
    val lastSeenAt: Long = 0L
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
    val primaryVideoFile: String? = null,
    val canPlay: Boolean = false,
    val playReason: String = "Fetching metadata",
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
    val aggregateHistory: List<Long> = emptyList(),
    val aggregateUpHistory: List<Long> = emptyList()
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

    fun formatRelativeAgeFromMs(timestampMs: Long, nowMs: Long = System.currentTimeMillis()): String {
        if (timestampMs <= 0L) return ""
        val diffMs = (nowMs - timestampMs).coerceAtLeast(0L)
        val hours = diffMs / 3_600_000L
        if (hours < 1L) {
            val mins = (diffMs / 60_000L).coerceAtLeast(1L)
            return if (mins == 1L) "1 minute ago" else "$mins minutes ago"
        }
        if (hours < 24L) {
            return if (hours == 1L) "1 hour ago" else "$hours hours ago"
        }
        val days = hours / 24L
        if (days < 30L) {
            return if (days == 1L) "1 day ago" else "$days days ago"
        }
        val months = (days / 30L).coerceAtLeast(1L)
        if (months < 12L) {
            return if (months == 1L) "1 month ago" else "$months months ago"
        }
        val years = (days / 365L).coerceAtLeast(1L)
        return if (years == 1L) "1 year ago" else "$years years ago"
    }
}

data class SearchFilterOption(
    val id: String,
    val label: String
)

data class SearchFilterCounts(
    val qualityCounts: Map<String, Int>,
    val availableQualities: Map<String, Boolean>,
    val tagCounts: Map<String, Int>
)

object SearchFilterHelper {
    val QUALITY_FILTERS = listOf(
        SearchFilterOption("all", "All"),
        SearchFilterOption("4k", "4K"),
        SearchFilterOption("1080p", "1080p"),
        SearchFilterOption("720p", "720p"),
        SearchFilterOption("sd", "SD")
    )

    val TAG_FILTERS = listOf(
        SearchFilterOption("remux", "Remux"),
        SearchFilterOption("bluray", "BluRay"),
        SearchFilterOption("webdl", "WEB-DL"),
        SearchFilterOption("hdr", "HDR"),
        SearchFilterOption("dv", "Dolby Vision"),
        SearchFilterOption("hevc", "HEVC")
    )

    private val QUALITY_REGEXES = mapOf(
        "4k" to Regex("""(?:^|[^a-z0-9])(2160p|4k|uhd)(?:$|[^a-z0-9])""", RegexOption.IGNORE_CASE),
        "1080p" to Regex("""(?:^|[^a-z0-9])(1080[pi]|full[\s._-]?hd|fhd)(?:$|[^a-z0-9])""", RegexOption.IGNORE_CASE),
        "720p" to Regex("""(?:^|[^a-z0-9])720p(?:$|[^a-z0-9])""", RegexOption.IGNORE_CASE),
        "sd" to Regex("""(?:^|[^a-z0-9])(480p|576p|360p|dvdrip|dvdscr|xvid|divx|camrip|hdcam|telesync|hdts)(?:$|[^a-z0-9])""", RegexOption.IGNORE_CASE)
    )

    private val TAG_REGEXES = mapOf(
        "remux" to Regex("""(?:^|[^a-z0-9])(remux|bdremux|uhd[\s._-]*remux)(?:$|[^a-z0-9])""", RegexOption.IGNORE_CASE),
        "bluray" to Regex("""(?:^|[^a-z0-9])(blu[\s._-]*ray|bdrip|brrip|bdremux)(?:$|[^a-z0-9])""", RegexOption.IGNORE_CASE),
        "webdl" to Regex("""(?:^|[^a-z0-9])(web[\s._-]*dl|webrip|amzn|nf|dsnp|atvp|hmax)(?:$|[^a-z0-9])""", RegexOption.IGNORE_CASE),
        "hdr" to Regex("""(?:^|[^a-z0-9])(hdr|hdr10|hdr10\+|hlg)(?:$|[^a-z0-9])""", RegexOption.IGNORE_CASE),
        "dv" to Regex("""(?:^|[^a-z0-9])(dolby[\s._-]*vision|dovi|dv)(?:$|[^a-z0-9])""", RegexOption.IGNORE_CASE),
        "hevc" to Regex("""(?:^|[^a-z0-9])(hevc|x265|h[\s._-]*265)(?:$|[^a-z0-9])""", RegexOption.IGNORE_CASE)
    )

    private val BRACKET_CLEAN_RE = Regex("""\[[^\]]*\]""")
    private val DOT_SPACE_RE = Regex("""\.(?=[a-z0-9])""", RegexOption.IGNORE_CASE)
    private val PAREN_UNDERSCORE_RE = Regex("""[()_]""")
    private val MULTI_SPACE_RE = Regex("""\s+""")
    private val TECH_CUT_RE = Regex(
        """\b(2160p|1080[pi]|720p|480p|540p|4k|uhd|hdr\d*|bluray|blu-ray|bdrip|brrip|web-dl|webrip|web|dvdrip|dvdscr|hdrip|hdts|tsrip|camrip|x264|x265|hevc|h264|h265|avc|10bit|remux|aac|ddp?\d|dts|repack)\b""",
        RegexOption.IGNORE_CASE
    )
    private val TRAILING_PUNCT_RE = Regex("""[-:.,\s]+$""")

    fun matchesFilters(
        item: SearchResultItem,
        source: String = "all",
        quality: String = "all",
        tags: Set<String> = emptySet()
    ): Boolean {
        if (source != "all" && !item.provider.equals(source, ignoreCase = false)) {
            return false
        }
        val title = item.title
        val qRe = QUALITY_REGEXES[quality]
        if (qRe != null && !qRe.containsMatchIn(title)) {
            return false
        }
        for (tagId in tags) {
            val tRe = TAG_REGEXES[tagId]
            if (tRe != null && !tRe.containsMatchIn(title)) {
                return false
            }
        }
        return true
    }

    fun filterResults(
        results: List<SearchResultItem>,
        source: String = "all",
        quality: String = "all",
        tags: Set<String> = emptySet()
    ): List<SearchResultItem> {
        if (results.isEmpty()) return emptyList()
        return results.filter { matchesFilters(it, source, quality, tags) }
    }

    fun getFilterCounts(
        results: List<SearchResultItem>,
        source: String = "all",
        quality: String = "all",
        tags: Set<String> = emptySet()
    ): SearchFilterCounts {
        val qualityCounts = QUALITY_FILTERS.associate { it.id to 0 }.toMutableMap()
        val availableQualities = QUALITY_FILTERS.associate { it.id to false }.toMutableMap()
        val tagCounts = TAG_FILTERS.associate { it.id to 0 }.toMutableMap()

        if (results.isEmpty()) {
            return SearchFilterCounts(qualityCounts, availableQualities, tagCounts)
        }

        availableQualities["all"] = true
        for (item in results) {
            val title = item.title
            for ((qId, qRe) in QUALITY_REGEXES) {
                if (qRe.containsMatchIn(title)) {
                    availableQualities[qId] = true
                }
            }

            if (matchesFilters(item, source = source, quality = "all", tags = tags)) {
                qualityCounts["all"] = (qualityCounts["all"] ?: 0) + 1
                for ((qId, qRe) in QUALITY_REGEXES) {
                    if (qRe.containsMatchIn(title)) {
                        qualityCounts[qId] = (qualityCounts[qId] ?: 0) + 1
                    }
                }
            }

            if (matchesFilters(item, source = source, quality = quality, tags = tags)) {
                for ((tId, tRe) in TAG_REGEXES) {
                    if (tRe.containsMatchIn(title)) {
                        tagCounts[tId] = (tagCounts[tId] ?: 0) + 1
                    }
                }
            }
        }

        return SearchFilterCounts(qualityCounts, availableQualities, tagCounts)
    }

    fun cleanReleaseSearchQuery(title: String): String {
        val trimmed = title.trim()
        if (trimmed.isEmpty()) return ""
        var clean = trimmed
            .replace(BRACKET_CLEAN_RE, " ")
            .replace(DOT_SPACE_RE, " ")
            .replace(PAREN_UNDERSCORE_RE, " ")
            .replace(MULTI_SPACE_RE, " ")
            .trim()
        val techMatch = TECH_CUT_RE.find(clean)
        if (techMatch != null && techMatch.range.first > 2) {
            clean = clean.substring(0, techMatch.range.first).trim()
        }
        return clean.replace(TRAILING_PUNCT_RE, "").trim().ifEmpty { trimmed }
    }
}

