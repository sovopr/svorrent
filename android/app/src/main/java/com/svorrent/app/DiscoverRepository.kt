package com.svorrent.app

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.net.URL
import java.net.URLEncoder
import java.util.Calendar
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

data class SpotlightCandidate(
    val normKey: String,
    val title: String,
    val year: String,
    val imdbId: String
)

private data class DiscoverCategorySpec(
    val exttoCategory: String,
    val apibayCatId: String?
)

private data class CachedDiscoverEntry(
    val timestampMs: Long,
    val payload: DiscoverFeedResult
)

private data class CachedSpotlightEntry(
    val timestampMs: Long,
    val cards: List<SpotlightCardItem>
)

private data class CachedImdbEntry(
    val timestampMs: Long,
    val card: SpotlightCardItem?
)

/**
 * Multi-source Trending Discovery & Poster Spotlight engine mirroring desktop backend/lib/indexer.js.
 * Races extto.org editorial trending, Knaben, ThePirateBay top100, EZTV, and Nyaa alongside
 * Apple iTunes, AniList GraphQL, and IMDb artwork spotlights with stale-while-revalidate caching.
 */
object DiscoverRepository {
    private const val EXTTO_BASE = "https://extto.org"
    private const val DISCOVER_CACHE_TTL_MS = 10 * 60 * 1000L
    private const val SPOTLIGHT_CACHE_TTL_MS = 15 * 60 * 1000L
    private const val IMDB_CACHE_TTL_MS = 6 * 60 * 60 * 1000L
    private const val IMDB_CACHE_MAX_ENTRIES = 320

    private val CATEGORY_SPECS = mapOf(
        "movies" to DiscoverCategorySpec(exttoCategory = "Movies", apibayCatId = "207"),
        "tv" to DiscoverCategorySpec(exttoCategory = "TV", apibayCatId = "208"),
        "anime" to DiscoverCategorySpec(exttoCategory = "Anime", apibayCatId = null)
    )
    private val VALID_WINDOWS = setOf("1D", "7D", "30D")

    private val ALLOWED_POSTER_HOST_RE = Regex(
        """(?:^|\.)mzstatic\.com$|^(?:s\d+\.)?anilist\.co$|^i\.rar\.pics$|^m\.media-amazon\.com$""",
        RegexOption.IGNORE_CASE
    )
    private val NSFW_SPOTLIGHT_RE = Regex(
        """\b(hentai|xxx|porn|onlyfans|jav|brazzers|naughtyamerica|nsfw|uncensored|playboy|erotic|18\+)\b""",
        RegexOption.IGNORE_CASE
    )
    private val CAM_QUALITY_RE = Regex(
        """\b(cam|camrip|hdcam|tsrip|hdts|telesync|dvdscr|screener|workprint|hq[\s._-]?clean|1xbet|line[\s._-]?audio)\b""",
        RegexOption.IGNORE_CASE
    )
    private val HD_DIGITAL_RE = Regex(
        """\b(2160p|1080[pi])\b.*\b(web[-\s.]?dl|webrip|bluray|blu[-\s.]?ray|remux|bdrip)\b|\b(web[-\s.]?dl|webrip|bluray|blu[-\s.]?ray|remux|bdrip)\b.*\b(2160p|1080[pi])\b""",
        RegexOption.IGNORE_CASE
    )

    private val TBODY_RE = Regex("""<tbody>([\s\S]*?)</tbody>""", RegexOption.IGNORE_CASE)
    private val TR_SPLIT_RE = Regex("""<tr[^>]*>""", RegexOption.IGNORE_CASE)
    private val EXTTO_LINK_RE = Regex("""<a\s+href="(/post-detail/([^/"]+)/[^"]*)"[^>]*>([\s\S]*?)</a>""", RegexOption.IGNORE_CASE)
    private val EXTTO_SIZE_RE = Regex("""<span class="add-block">Size</span>\s*<span>([^<]+)</span>""", RegexOption.IGNORE_CASE)
    private val EXTTO_AGE_RE = Regex("""<td class="nowrap-td hide-on-mob">\s*<div class="add-block-wrapper">\s*<span>([^<]+)</span>""", RegexOption.IGNORE_CASE)
    private val EXTTO_SEED_RE = Regex("""<span class="text-success">([\d,]+)</span>""", RegexOption.IGNORE_CASE)
    private val EXTTO_PEER_RE = Regex("""<span class="text-danger">([\d,]+)</span>""", RegexOption.IGNORE_CASE)
    private val EXTTO_IMDB_RE = Regex("""/imdb-detail/(tt\d+)/""", RegexOption.IGNORE_CASE)

    private val RELATIVE_AGE_RE = Regex("""(\d+(?:\.\d+)?)\s*(sec|second|min|minute|hour|hr|day|week|wk|month|mo|year|yr)s?""")
    private val APPLE_IMG_RES_RE = Regex("""/\d+x\d+bb\.(png|jpg|webp)$""", RegexOption.IGNORE_CASE)
    private val APPLE_SEASON_CUT_RE = Regex(""",\s*Season\s+\d+$""", RegexOption.IGNORE_CASE)
    private val APPLE_COMPLETE_CUT_RE = Regex(""":\s*The Complete Series$""", RegexOption.IGNORE_CASE)
    private val APPLE_YEAR_SUFFIX_RE = Regex("""\s*\(\d{4}\)\s*$""")
    private val ANILIST_SEASON_COLON_RE = Regex(""":\s*Season\s+\d+$""", RegexOption.IGNORE_CASE)
    private val ANILIST_SEASON_SPACE_RE = Regex("""\s+Season\s+\d+$""", RegexOption.IGNORE_CASE)
    private val IMDB_IMG_RES_RE = Regex("""\._V1_.*\.(jpg|jpeg|png|webp)$""", RegexOption.IGNORE_CASE)

    private val YEAR_WORD_RE = Regex("""\b(19\d\d|20\d\d)\b""")
    private val TV_CUT_RE = Regex(
        """\b(S\d{1,2}(?:E\d{1,2})?|Season\s*\d+|Complete|1080[pi]|2160p|720p|480p|WEB[-\s]?DL|WEBRip|BluRay|HDTV|x264|x265|HEVC|10bit|AAC|DDP)\b""",
        RegexOption.IGNORE_CASE
    )
    private val MOVIE_TECH_CUT_RE = Regex(
        """\b(2160p|1080[pi]|720p|480p|540p|4k|uhd|hdr\d*|bluray|blu[-\s]?ray|bdrip|brrip|web[-\s]?dl|webrip|tsrip|hdts|hdcam|camrip|dvdrip|x264|x265|hevc|10bit|remux|aac|ddp?\d|repack|encore)\b""",
        RegexOption.IGNORE_CASE
    )
    private val BRACKET_RE = Regex("""\[[^\]]*\]""")
    private val DOT_BEFORE_ALNUM_RE = Regex("""\.(?=[a-z0-9])""", RegexOption.IGNORE_CASE)
    private val PAREN_UNDERSCORE_RE = Regex("""[()_]""")
    private val WHITESPACE_RE = Regex("""\s+""")
    private val TRAILING_PUNCT_RE = Regex("""[-:.,\s]+$""")
    private val NON_ALNUM_RE = Regex("""[^a-z0-9]+""")
    private val EP_TAG_RE = Regex("""\b(S\d{1,2}E\d{1,2}|S\d{1,2})\b""", RegexOption.IGNORE_CASE)
    private val VIDEO_GAME_TYPE_RE = Regex("""videoGame|musicVideo|podcast""", RegexOption.IGNORE_CASE)
    private val TV_TYPE_RE = Regex("""tv|mini""", RegexOption.IGNORE_CASE)
    private val MOVIE_TYPE_RE = Regex("""feature|movie|video""", RegexOption.IGNORE_CASE)

    private val KNABEN_MOVIE_RE = Regex("""\bmovie""", RegexOption.IGNORE_CASE)
    private val KNABEN_TV_RE = Regex("""\btv\b""", RegexOption.IGNORE_CASE)
    private val KNABEN_ANIME_RE = Regex("""\banime""", RegexOption.IGNORE_CASE)

    private val discoverCache = ConcurrentHashMap<String, CachedDiscoverEntry>()
    private val discoverInFlight = ConcurrentHashMap<String, CompletableDeferred<DiscoverFeedResult>>()
    private val spotlightCache = ConcurrentHashMap<String, CachedSpotlightEntry>()
    private val imdbCache = ConcurrentHashMap<String, CachedImdbEntry>()
    private val backgroundScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    fun isAllowedPosterUrl(rawUrl: String?): Boolean {
        if (rawUrl.isNullOrBlank()) return false
        return try {
            val parsed = URL(rawUrl.trim())
            if (!parsed.protocol.equals("https", ignoreCase = true)) return false
            if (!parsed.userInfo.isNullOrEmpty() || parsed.port != -1) return false
            ALLOWED_POSTER_HOST_RE.containsMatchIn(parsed.host)
        } catch (_: Throwable) {
            false
        }
    }

    fun getCachedEntry(category: String = "movies", window: String = "7D"): DiscoverFeedResult? {
        val catKey = normalizeCategory(category)
        val winKey = normalizeWindow(window)
        val cached = discoverCache["$catKey|$winKey"] ?: return null
        if (System.currentTimeMillis() - cached.timestampMs >= DISCOVER_CACHE_TTL_MS) return null
        return cached.payload
    }

    fun parseRelativeAgeHours(ageStr: String?): Double {
        if (ageStr.isNullOrBlank()) return Double.POSITIVE_INFINITY
        val match = RELATIVE_AGE_RE.find(ageStr.trim().lowercase(Locale.US)) ?: return Double.POSITIVE_INFINITY
        val num = match.groupValues[1].toDoubleOrNull() ?: return Double.POSITIVE_INFINITY
        val unit = match.groupValues[2]
        return when {
            unit.startsWith("sec") -> num / 3600.0
            unit.startsWith("min") -> num / 60.0
            unit.startsWith("h") -> num
            unit.startsWith("d") -> num * 24.0
            unit.startsWith("w") -> num * 24.0 * 7.0
            unit.startsWith("mo") -> num * 24.0 * 30.0
            unit.startsWith("y") -> num * 24.0 * 365.0
            else -> Double.POSITIVE_INFINITY
        }
    }

    fun orderTrendingByWindow(rows: List<SearchResultItem>, winKey: String): List<SearchResultItem> {
        if (rows.isEmpty()) return emptyList()
        val bucket0 = ArrayList<SearchResultItem>()
        val bucket1 = ArrayList<SearchResultItem>()
        val bucket2 = ArrayList<SearchResultItem>()

        for (row in rows) {
            val hrs = parseRelativeAgeHours(row.age)
            val tier = when (winKey) {
                "1D" -> if (hrs <= 72.0) 0 else 1
                "7D" -> if (hrs <= 14.0 * 24.0) 0 else 1
                else -> when {
                    hrs > 7.0 * 24.0 && hrs <= 60.0 * 24.0 -> 0
                    hrs <= 7.0 * 24.0 -> 1
                    else -> 2
                }
            }
            when (tier) {
                0 -> bucket0.add(row)
                1 -> bucket1.add(row)
                else -> bucket2.add(row)
            }
        }
        return bucket0 + bucket1 + bucket2
    }

    fun parseExttoTrendingHtml(html: String, baseUrl: String = EXTTO_BASE): List<SearchResultItem> {
        if (html.isBlank()) return emptyList()
        val tbodyMatch = TBODY_RE.find(html) ?: return emptyList()
        val rows = TR_SPLIT_RE.split(tbodyMatch.groupValues[1]).drop(1)
        val results = ArrayList<SearchResultItem>(rows.size)

        for (row in rows) {
            val linkMatch = EXTTO_LINK_RE.find(row) ?: continue
            val relPath = linkMatch.groupValues[1].trim()
            val id = linkMatch.groupValues[2].trim()
            val rawTitle = SearchRepository.decodeHtmlEntities(SearchRepository.stripHtmlTags(linkMatch.groupValues[3]))
            val title = rawTitle.replace('\u00a0', ' ').replace(WHITESPACE_RE, " ").trim()
            if (title.isEmpty() || title.contains("\${") || relPath.contains("\${")) continue

            val sizeStr = EXTTO_SIZE_RE.find(row)?.groupValues?.get(1)?.replace('\u00a0', ' ')?.trim() ?: ""
            val sizeBytes = SearchRepository.parseFormattedSize(sizeStr)
            val age = EXTTO_AGE_RE.find(row)?.groupValues?.get(1)?.replace('\u00a0', ' ')?.trim() ?: ""
            val seeds = SearchRepository.sanitizeSwarmCount(EXTTO_SEED_RE.find(row)?.groupValues?.get(1)?.replace(",", ""))
            val leechers = SearchRepository.sanitizeSwarmCount(EXTTO_PEER_RE.find(row)?.groupValues?.get(1)?.replace(",", ""))
            val imdbId = EXTTO_IMDB_RE.find(row)?.groupValues?.get(1)?.lowercase(Locale.US) ?: ""
            val detailUrl = "$baseUrl$relPath"

            results.add(
                SearchResultItem(
                    id = id.ifEmpty { detailUrl },
                    title = title,
                    sizeBytes = sizeBytes,
                    sizeFormatted = sizeStr.ifEmpty { Formatters.formatBytes(sizeBytes) },
                    seeds = seeds,
                    leechers = leechers,
                    provider = "extto.org",
                    infoHash = "",
                    magnet = "",
                    category = "Video",
                    age = age,
                    imdbId = imdbId,
                    detailUrl = detailUrl
                )
            )
        }
        return results
    }

    fun parseAppleSpotlightFeed(rawJson: String, kind: String = "movies"): List<SpotlightCardItem> {
        val root = JSONObject(rawJson)
        val feed = root.optJSONObject("feed") ?: return emptyList()
        val rawEntry = feed.opt("entry") ?: return emptyList()
        val entries = when (rawEntry) {
            is JSONArray -> (0 until rawEntry.length()).mapNotNull { rawEntry.optJSONObject(it) }
            is JSONObject -> listOf(rawEntry)
            else -> emptyList()
        }

        val cards = ArrayList<SpotlightCardItem>(entries.size)
        for (entry in entries) {
            val rawTitle = entry.optJSONObject("im:name")?.optString("label", "")?.trim() ?: ""
            if (rawTitle.isEmpty()) continue
            val title = rawTitle.replace(WHITESPACE_RE, " ").trim()
            val releaseIso = entry.optJSONObject("im:releaseDate")?.optString("label", "") ?: ""
            val year = YEAR_WORD_RE.find(releaseIso)?.groupValues?.get(1) ?: ""
            val genre = entry.optJSONObject("category")?.optJSONObject("attributes")?.optString("label", "") ?: ""
            val summary = entry.optJSONObject("summary")?.optString("label", "")?.trim() ?: ""

            val images = entry.optJSONArray("im:image")
            val rawPoster = if (images != null && images.length() > 0) {
                images.optJSONObject(images.length() - 1)?.optString("label", "") ?: ""
            } else {
                ""
            }
            val poster = rawPoster.replace(APPLE_IMG_RES_RE, "/240x360bb.webp")
                .takeIf { isAllowedPosterUrl(it) } ?: ""

            val cleanBase = title
                .replace(APPLE_SEASON_CUT_RE, "")
                .replace(APPLE_COMPLETE_CUT_RE, "")
                .replace(APPLE_YEAR_SUFFIX_RE, "")
                .trim()
            val searchQuery = if (kind == "movies" && year.isNotEmpty()) "$cleanBase $year" else cleanBase
            val id = entry.optJSONObject("id")?.optJSONObject("attributes")?.optString("im:id", "")
                ?.ifEmpty { title } ?: title

            cards.add(
                SpotlightCardItem(
                    id = id,
                    title = title,
                    year = year,
                    genre = genre,
                    summary = summary,
                    poster = poster,
                    searchQuery = searchQuery.ifEmpty { title }
                )
            )
        }
        return cards
    }

    fun parseAniListSpotlight(rawJson: String): List<SpotlightCardItem> {
        val mediaList = JSONObject(rawJson)
            .optJSONObject("data")
            ?.optJSONObject("Page")
            ?.optJSONArray("media") ?: return emptyList()

        val cards = ArrayList<SpotlightCardItem>(mediaList.length())
        for (i in 0 until mediaList.length()) {
            val item = mediaList.optJSONObject(i) ?: continue
            if (item.optBoolean("isAdult", false)) continue
            val titleObj = item.optJSONObject("title") ?: continue
            val rawTitle = titleObj.optString("english", "").ifBlank { titleObj.optString("romaji", "") }.trim()
            if (rawTitle.isEmpty()) continue
            val title = rawTitle.replace(WHITESPACE_RE, " ").trim()
            val yearInt = item.optInt("seasonYear", 0)
            val year = if (yearInt > 0) yearInt.toString() else ""

            val genresArr = item.optJSONArray("genres")
            val genres = if (genresArr != null) {
                (0 until genresArr.length()).mapNotNull { idx -> genresArr.optString(idx, "").takeIf { it.isNotBlank() } }
            } else {
                emptyList()
            }
            val coverObj = item.optJSONObject("coverImage")
            val rawPoster = coverObj?.optString("large", "")?.ifBlank { coverObj.optString("medium", "") } ?: ""
            val poster = rawPoster.takeIf { isAllowedPosterUrl(it) } ?: ""
            val searchQuery = title
                .replace(ANILIST_SEASON_COLON_RE, "")
                .replace(ANILIST_SEASON_SPACE_RE, "")
                .trim()
                .ifEmpty { title }

            val itemId = item.optString("id", "").ifEmpty { title }
            cards.add(
                SpotlightCardItem(
                    id = "anilist-$itemId",
                    title = title,
                    year = year,
                    genre = genres.firstOrNull() ?: "Anime",
                    summary = genres.take(3).joinToString(", "),
                    poster = poster,
                    searchQuery = searchQuery
                )
            )
        }
        return cards
    }

    fun parseEztvJson(rawJson: String): List<SearchResultItem> {
        val list = JSONObject(rawJson).optJSONArray("torrents") ?: return emptyList()
        val results = ArrayList<SearchResultItem>(list.length())

        for (i in 0 until list.length()) {
            val item = list.optJSONObject(i) ?: continue
            val title = SearchRepository.decodeHtmlEntities(SearchRepository.stripHtmlTags(item.optString("title", ""))).trim()
            if (title.isEmpty()) continue
            val seeds = SearchRepository.sanitizeSwarmCount(item.opt("seeds"))
            val peers = SearchRepository.sanitizeSwarmCount(item.opt("peers"))
            if (seeds < 5 && peers < 5) continue

            val releasedSec = item.optLong("date_released_unix", 0L)
            val age = if (releasedSec > 1_000_000_000L) Formatters.formatRelativeAgeFromMs(releasedSec * 1000L) else ""
            val sizeBytes = item.optLong("size_bytes", 0L).coerceAtLeast(0L)
            val rawHash = item.optString("hash", "").trim().lowercase(Locale.US)
            val magnetCandidate = item.optString("magnet_url", "").trim()
            val infoHash = SearchRepository.extractInfoHash(rawHash).ifEmpty { SearchRepository.extractInfoHash(magnetCandidate) }
            val magnet = when {
                magnetCandidate.startsWith("magnet:?xt=urn:btih:", ignoreCase = true) -> magnetCandidate
                infoHash.length == 40 -> SearchRepository.buildMagnetUri(infoHash, title)
                else -> ""
            }
            if (magnet.isEmpty() && infoHash.isEmpty()) continue

            val rawImdb = item.optString("imdb_id", "").trim()
            val imdbId = if (rawImdb.isNotEmpty()) {
                val digits = rawImdb.removePrefix("tt")
                if (digits.all { it.isDigit() }) "tt$digits" else ""
            } else {
                ""
            }

            results.add(
                SearchResultItem(
                    id = infoHash.ifEmpty { item.optString("id", title) },
                    title = title,
                    sizeBytes = sizeBytes,
                    sizeFormatted = Formatters.formatBytes(sizeBytes),
                    seeds = seeds,
                    leechers = peers,
                    provider = "EZTV",
                    infoHash = infoHash,
                    magnet = magnet,
                    category = "Video",
                    age = age,
                    imdbId = imdbId,
                    detailUrl = item.optString("torrent_url", "").trim()
                )
            )
        }
        return results
    }

    fun extractSpotlightCandidates(
        rows: List<SearchResultItem>,
        catKey: String = "movies",
        limit: Int = 14
    ): List<SpotlightCandidate> {
        val candidates = ArrayList<SpotlightCandidate>()
        val byNorm = LinkedHashMap<String, SpotlightCandidate>()

        for (row in rows) {
            if (row.title.isBlank() || NSFW_SPOTLIGHT_RE.containsMatchIn(row.title)) continue
            var raw = row.title
                .replace(BRACKET_RE, " ")
                .replace(DOT_BEFORE_ALNUM_RE, " ")
                .replace(PAREN_UNDERSCORE_RE, " ")
                .replace(WHITESPACE_RE, " ")
                .trim()

            val year = YEAR_WORD_RE.find(raw)?.groupValues?.get(1) ?: ""
            if (catKey == "tv") {
                val cut = TV_CUT_RE.find(raw)?.range?.first ?: -1
                if (cut > 1) raw = raw.substring(0, cut).trim()
            } else {
                val yearIdx = if (year.isNotEmpty()) raw.indexOf(year) else -1
                val techCut = MOVIE_TECH_CUT_RE.find(raw)?.range?.first ?: -1
                val cut = if (yearIdx > 1 && (techCut < 0 || yearIdx < techCut)) yearIdx else techCut
                if (cut > 1) raw = raw.substring(0, cut).trim()
            }

            val cleanTitle = raw
                .replace(YEAR_WORD_RE, "")
                .replace(TRAILING_PUNCT_RE, "")
                .replace(WHITESPACE_RE, " ")
                .trim()
            if (cleanTitle.length < 2) continue

            val normKey = cleanTitle.lowercase(Locale.US).replace(NON_ALNUM_RE, " ").trim()
            if (normKey.isEmpty()) continue

            val validImdb = if (row.imdbId.matches(Regex("""^tt\d+$""", RegexOption.IGNORE_CASE))) {
                row.imdbId.lowercase(Locale.US)
            } else {
                ""
            }

            val existing = byNorm[normKey]
            if (existing != null) {
                if (existing.imdbId.isEmpty() && validImdb.isNotEmpty()) {
                    byNorm[normKey] = existing.copy(imdbId = validImdb)
                }
                continue
            }

            val cand = SpotlightCandidate(normKey = normKey, title = cleanTitle, year = year, imdbId = validImdb)
            byNorm[normKey] = cand
            candidates.add(cand)
            if (candidates.size >= limit) break
        }
        return candidates
    }

    private fun normalizeWorkKey(title: String, catKey: String): String {
        val cand = extractSpotlightCandidates(listOf(SearchResultItem("", title, 0L, "", 0, 0, "", "", "")), catKey, 1)
            .firstOrNull() ?: return SearchRepository.normalizeTitleForDedup(title)
        if (catKey == "tv") {
            val epMatch = EP_TAG_RE.find(title)
            return if (epMatch != null) "${cand.normKey} ${epMatch.groupValues[1].lowercase(Locale.US)}" else cand.normKey
        }
        return if (cand.year.isNotEmpty()) "${cand.normKey} ${cand.year}" else cand.normKey
    }

    fun scoreTrendingRelease(
        item: SearchResultItem,
        winKey: String = "7D",
        mergedProvidersCount: Int = 1,
        workProviderCount: Int = 1,
        exttoRank: Int? = null
    ): Double {
        val seeds = item.seeds.coerceAtLeast(0).toDouble()
        val peers = item.leechers.coerceAtLeast(0).toDouble()
        if (seeds == 0.0 && peers == 0.0) return -100.0

        val swarmScore =
            kotlin.math.log10(seeds + 1.0) * 18.0 +
                kotlin.math.log10(peers + 1.0) * 11.0 +
                if (peers > 0.0) kotlin.math.min(10.0, (peers / kotlin.math.max(seeds, 1.0)) * 12.0) else 0.0

        val exactConsensus = kotlin.math.min(48, kotlin.math.max(0, mergedProvidersCount - 1) * 20).toDouble()
        val workConsensus = kotlin.math.min(42, kotlin.math.max(0, workProviderCount - 1) * 16).toDouble()

        val hrs = parseRelativeAgeHours(item.age)
        val freshness = if (hrs.isFinite()) {
            when (winKey) {
                "1D" -> when {
                    hrs <= 24.0 -> 65.0
                    hrs <= 48.0 -> 45.0
                    hrs <= 72.0 -> 22.0
                    hrs <= 168.0 -> 0.0
                    hrs <= 720.0 -> -38.0
                    else -> -75.0
                }
                "7D" -> when {
                    hrs <= 72.0 -> 32.0
                    hrs <= 336.0 -> 48.0
                    hrs <= 504.0 -> 15.0
                    hrs > 1080.0 -> -50.0
                    else -> 0.0
                }
                else -> when {
                    hrs > 168.0 && hrs <= 1080.0 -> 45.0
                    hrs <= 168.0 -> 15.0
                    hrs > 2160.0 -> -35.0
                    else -> 5.0
                }
            }
        } else {
            5.0
        }

        val editorialRankBoost = if (exttoRank != null && exttoRank >= 0) {
            28.0 * kotlin.math.max(0.0, 1.0 - exttoRank / 60.0)
        } else {
            0.0
        }
        val magnetBoost = if (item.magnet.isNotEmpty() || item.infoHash.isNotEmpty()) 6.0 else 0.0

        val qualityAdjust = when {
            CAM_QUALITY_RE.containsMatchIn(item.title) -> -32.0
            HD_DIGITAL_RE.containsMatchIn(item.title) -> 14.0
            else -> 0.0
        }

        return swarmScore + exactConsensus + workConsensus + freshness + editorialRankBoost + magnetBoost + qualityAdjust
    }

    private data class MergedTrendingEntry(
        var item: SearchResultItem,
        val providers: LinkedHashSet<String>,
        var exttoRank: Int?,
        val workKey: String
    )

    private data class ScoredTrendingEntry(
        val entry: MergedTrendingEntry,
        val score: Double
    )

    fun rankMultiSourceTrending(
        batches: List<Pair<String, List<SearchResultItem>>>,
        catKey: String = "movies",
        winKey: String = "7D",
        maxPerWork: Int = 2,
        limit: Int = 85
    ): List<SearchResultItem> {
        val merged = LinkedHashMap<String, MergedTrendingEntry>()
        val workProviders = HashMap<String, MutableSet<String>>()

        for ((sourceName, items) in batches) {
            for (idx in items.indices) {
                val item = items[idx]
                if (item.title.isBlank() || NSFW_SPOTLIGHT_RE.containsMatchIn(item.title)) continue

                val workKey = normalizeWorkKey(item.title, catKey)
                val provName = item.provider.ifBlank { sourceName }
                if (workKey.isNotEmpty()) {
                    workProviders.getOrPut(workKey) { HashSet() }.add(provName)
                }

                val normTitle = SearchRepository.normalizeTitleForDedup(item.title)
                val sizeMb = Math.round(item.sizeBytes / (1024.0 * 1024.0))
                val dedupKey = when {
                    item.infoHash.isNotBlank() -> "hash:${item.infoHash.lowercase(Locale.US)}"
                    normTitle.isNotEmpty() -> "title:$normTitle|$sizeMb"
                    else -> "id:$provName|${item.title}"
                }

                val isExtto = provName == "extto.org" || sourceName == "extto"
                val existing = merged[dedupKey]
                if (existing == null) {
                    merged[dedupKey] = MergedTrendingEntry(
                        item = item,
                        providers = linkedSetOf(provName),
                        exttoRank = if (isExtto) idx else null,
                        workKey = workKey
                    )
                    continue
                }

                existing.providers.add(provName)
                if (isExtto && (existing.exttoRank == null || idx < existing.exttoRank!!)) {
                    existing.exttoRank = idx
                }

                var dst = existing.item
                if (dst.magnet.isEmpty() && item.magnet.isNotEmpty()) {
                    dst = dst.copy(
                        magnet = item.magnet,
                        infoHash = dst.infoHash.ifEmpty { item.infoHash },
                        provider = if (dst.provider == "extto.org") item.provider else dst.provider
                    )
                }
                if (dst.infoHash.isEmpty() && item.infoHash.isNotEmpty()) dst = dst.copy(infoHash = item.infoHash)
                if (dst.age.isEmpty() && item.age.isNotEmpty()) dst = dst.copy(age = item.age)
                if (dst.imdbId.isEmpty() && item.imdbId.isNotEmpty()) dst = dst.copy(imdbId = item.imdbId)
                if (item.seeds > dst.seeds) dst = dst.copy(seeds = item.seeds)
                if (item.leechers > dst.leechers) dst = dst.copy(leechers = item.leechers)
                existing.item = dst
            }
        }

        val scored = merged.values.map { entry ->
            val workProvCount = if (entry.workKey.isNotEmpty()) (workProviders[entry.workKey]?.size ?: 1) else 1
            ScoredTrendingEntry(
                entry = entry,
                score = scoreTrendingRelease(
                    item = entry.item,
                    winKey = winKey,
                    mergedProvidersCount = entry.providers.size,
                    workProviderCount = workProvCount,
                    exttoRank = entry.exttoRank
                )
            )
        }.sortedByDescending { it.score }

        val selected = ArrayList<SearchResultItem>(limit)
        val deferred = ArrayList<SearchResultItem>()
        val workCounts = HashMap<String, Int>()

        for (scoredItem in scored) {
            val item = scoredItem.entry.item
            val workKey = scoredItem.entry.workKey
            if (workKey.isEmpty()) {
                selected.add(item)
                continue
            }
            val count = workCounts[workKey] ?: 0
            if (count < maxPerWork) {
                workCounts[workKey] = count + 1
                selected.add(item)
            } else {
                deferred.add(item)
            }
        }
        return (selected + deferred).take(limit)
    }

    private fun normalizeImdbSuggestionCard(rawJson: String, catKey: String, fallbackYear: String = ""): SpotlightCardItem? {
        val hits = JSONObject(rawJson).optJSONArray("d") ?: return null
        if (hits.length() == 0) return null

        fun isVideoHit(h: JSONObject): Boolean {
            val img = h.optJSONObject("i")?.optString("imageUrl", "") ?: ""
            val q = h.optString("q", "")
            return img.isNotEmpty() && !VIDEO_GAME_TYPE_RE.containsMatchIn(q)
        }

        val typeRegex = if (catKey == "tv") TV_TYPE_RE else MOVIE_TYPE_RE
        var pick: JSONObject? = null
        for (i in 0 until hits.length()) {
            val h = hits.optJSONObject(i) ?: continue
            if (isVideoHit(h) && typeRegex.containsMatchIn(h.optString("q", ""))) {
                pick = h
                break
            }
        }
        if (pick == null && catKey != "tv") {
            for (i in 0 until hits.length()) {
                val h = hits.optJSONObject(i) ?: continue
                if (isVideoHit(h)) {
                    pick = h
                    break
                }
            }
        }
        if (pick == null) return null

        val title = pick.optString("l", "").replace(WHITESPACE_RE, " ").trim()
        val rawPoster = pick.optJSONObject("i")?.optString("imageUrl", "") ?: ""
        if (title.isEmpty() || rawPoster.isEmpty()) return null

        val poster = rawPoster.replace(IMDB_IMG_RES_RE, "._V1_UX240_.jpg").takeIf { isAllowedPosterUrl(it) } ?: ""
        if (poster.isEmpty()) return null
        val y = pick.optInt("y", 0)
        val year = if (y > 0) y.toString() else fallbackYear
        val qLabel = pick.optString("q", "")
        val genre = if (qLabel.equals("TV series", true) || qLabel.equals("TV mini-series", true)) "Series" else ""
        val id = pick.optString("id", "").ifEmpty { title }

        return SpotlightCardItem(
            id = id,
            title = title,
            year = year,
            genre = genre,
            summary = "",
            poster = poster,
            searchQuery = if (catKey == "movies" && year.isNotEmpty()) "$title $year" else title
        )
    }

    private suspend fun fetchExttoTrending(exttoCategory: String, winKey: String): List<SearchResultItem> {
        val url = "$EXTTO_BASE/trending/50/${URLEncoder.encode(exttoCategory, "UTF-8")}/${URLEncoder.encode(winKey, "UTF-8")}/"
        val html = SearchRepository.fetchUrlFast(url, mapOf("Accept" to "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"))
        return parseExttoTrendingHtml(html, EXTTO_BASE)
    }

    private suspend fun fetchApibayWindowTrending(catKey: String, winKey: String, catId: String): List<SearchResultItem> {
        val endpoint = if (winKey == "1D") "data_top100_48h_$catId.json" else "data_top100_$catId.json"
        val raw = SearchRepository.fetchUrlFast("https://apibay.org/precompiled/$endpoint", mapOf("Accept" to "application/json"))
        val items = SearchRepository.parseThePirateBayJson(raw, maxItems = 50)
        val currentYear = Calendar.getInstance().get(Calendar.YEAR)
        if (catKey == "movies" && winKey == "1D") {
            return items.filter { it ->
                val hrs = parseRelativeAgeHours(it.age)
                !hrs.isFinite() || hrs <= 240.0 || it.title.contains(currentYear.toString()) || it.title.contains((currentYear - 1).toString())
            }
        }
        return items
    }

    private suspend fun fetchKnabenTrending(catKey: String, winKey: String): List<SearchResultItem> {
        val isDay = winKey == "1D"
        val currentYear = Calendar.getInstance().get(Calendar.YEAR)
        val (queryStr, catId, filterRe) = when (catKey) {
            "movies" -> Triple(currentYear.toString(), 3000000, KNABEN_MOVIE_RE)
            "tv" -> Triple("S0", 2000000, KNABEN_TV_RE)
            "anime" -> Triple("1080p", 6000000, KNABEN_ANIME_RE)
            else -> return emptyList()
        }
        val body = JSONObject().apply {
            put("search_field", "title")
            put("query", queryStr)
            put("order_by", if (isDay) "date" else "seeders")
            put("order_direction", "desc")
            put("categories", JSONArray(listOf(catId)))
            put("hide_xxx", true)
            put("hide_unsafe", true)
            put("from", 0)
            put("size", if (isDay) 60 else 70)
        }.toString()

        val raw = SearchRepository.queryKnabenRaw(body)
        return SearchRepository.parseKnabenHits(raw, filterRe).filter { item ->
            if (catKey != "anime" && (item.provider == "Nyaa" || item.provider == "TokyoTosho")) return@filter false
            if (NSFW_SPOTLIGHT_RE.containsMatchIn(item.title)) return@filter false
            if (item.seeds < (if (isDay) 5 else 15)) return@filter false
            if (winKey == "7D") {
                val hrs = parseRelativeAgeHours(item.age)
                !hrs.isFinite() || hrs <= 21.0 * 24.0
            } else {
                true
            }
        }
    }

    private suspend fun fetchNyaaTrending(winKey: String): List<SearchResultItem> {
        val url = if (winKey == "1D") {
            "https://nyaa.si/?page=rss&c=1_2&f=2"
        } else {
            "https://nyaa.si/?page=rss&c=1_2&f=2&s=seeders&o=desc"
        }
        val xml = SearchRepository.fetchUrlFast(url, mapOf("Accept" to "application/rss+xml, application/xml, text/xml"))
        return SearchRepository.parseNyaaXml(xml, maxItems = 60)
            .filter { !NSFW_SPOTLIGHT_RE.containsMatchIn(it.title) && it.seeds >= 8 }
    }

    private suspend fun fetchEztvTrending(): List<SearchResultItem> {
        val raw = SearchRepository.fetchUrlFast("https://eztvx.to/api/get-torrents?limit=80&page=1", mapOf("Accept" to "application/json"))
        return parseEztvJson(raw)
    }

    private suspend fun lookupImdbSpotlightCard(cand: SpotlightCandidate, catKey: String): SpotlightCardItem? {
        val cacheKey = "$catKey|${cand.imdbId.ifEmpty { cand.normKey }}"
        val now = System.currentTimeMillis()
        val cached = imdbCache[cacheKey]
        if (cached != null && now - cached.timestampMs < IMDB_CACHE_TTL_MS) {
            return cached.card
        }

        val paths = ArrayList<String>(2)
        if (cand.imdbId.isNotEmpty()) {
            paths.add("t/${cand.imdbId}.json")
        }
        val qRaw = if (cand.year.isNotEmpty() && catKey == "movies") "${cand.title} ${cand.year}" else cand.title
        val qSlug = qRaw.lowercase(Locale.US)
            .replace(NON_ALNUM_RE, "_")
            .trim('_')
            .take(48)
        if (qSlug.isNotEmpty()) {
            val firstChar = qSlug[0]
            val bucket = if (firstChar in 'a'..'z' || firstChar in '0'..'9') firstChar else 'x'
            paths.add("$bucket/${URLEncoder.encode(qSlug, "UTF-8")}.json")
        }

        var card: SpotlightCardItem? = null
        for (relPath in paths) {
            val res = runCatching {
                val json = SearchRepository.fetchUrlFast(
                    "https://v3.sg.media-imdb.com/suggestion/$relPath",
                    mapOf("Accept" to "application/json")
                )
                normalizeImdbSuggestionCard(json, catKey, cand.year)
            }.getOrNull()
            if (res != null) {
                card = res
                break
            }
        }

        if (imdbCache.size >= IMDB_CACHE_MAX_ENTRIES) {
            val oldestKey = imdbCache.entries.minByOrNull { it.value.timestampMs }?.key
            if (oldestKey != null) imdbCache.remove(oldestKey)
        }
        imdbCache[cacheKey] = CachedImdbEntry(now, card)
        return card
    }

    private suspend fun fetchAniListSpotlight(winKey: String): List<SpotlightCardItem> {
        val year = Calendar.getInstance().get(Calendar.YEAR)
        val filter = when (winKey) {
            "7D" -> "type: ANIME, isAdult: false, status: RELEASING, sort: POPULARITY_DESC"
            "30D" -> "type: ANIME, isAdult: false, seasonYear: $year, sort: SCORE_DESC"
            else -> "type: ANIME, isAdult: false, sort: TRENDING_DESC"
        }
        val query = "{ Page(perPage: 14) { media($filter) { id isAdult title { english romaji } seasonYear genres coverImage { large medium } } } }"
        return runCatching {
            val body = JSONObject().put("query", query).toString()
            val raw = SearchRepository.postJsonFast("https://graphql.anilist.co", body)
            parseAniListSpotlight(raw).take(14)
        }.getOrDefault(emptyList())
    }

    private suspend fun fetchAppleSpotlightFeed(catKey: String, winKey: String): List<SpotlightCardItem> {
        val appleFeed = when {
            catKey == "tv" && winKey == "1D" -> "toptvepisodes"
            catKey == "tv" -> "toptvseasons"
            else -> "topmovies"
        }
        return runCatching {
            val raw = SearchRepository.fetchUrlFast(
                "https://itunes.apple.com/us/rss/$appleFeed/limit=20/json",
                mapOf("Accept" to "application/json")
            )
            parseAppleSpotlightFeed(raw, catKey)
        }.getOrDefault(emptyList())
    }

    private suspend fun buildWindowSpotlight(
        catKey: String,
        winKey: String,
        torrents: List<SearchResultItem>,
        forceRefresh: Boolean
    ): List<SpotlightCardItem> = coroutineScope {
        val cacheKey = "$catKey|$winKey"
        val now = System.currentTimeMillis()
        if (!forceRefresh) {
            val cached = spotlightCache[cacheKey]
            if (cached != null && now - cached.timestampMs < SPOTLIGHT_CACHE_TTL_MS) {
                return@coroutineScope cached.cards
            }
        }

        val cards = ArrayList<SpotlightCardItem>()
        if (catKey == "anime") {
            cards.addAll(fetchAniListSpotlight(winKey))
        } else {
            val candidates = extractSpotlightCandidates(torrents, catKey, limit = 16)
            val seenIds = HashSet<String>()
            val seenNorm = HashSet<String>()
            val lookedUp = candidates.map { cand ->
                async(Dispatchers.IO) {
                    withTimeoutOrNull(3500L) { lookupImdbSpotlightCard(cand, catKey) }
                }
            }.awaitAll()

            for (card in lookedUp) {
                if (card == null) continue
                val normTitle = card.title.lowercase(Locale.US).replace(NON_ALNUM_RE, " ").trim()
                if (!seenIds.add(card.id)) continue
                if (normTitle.isNotEmpty() && !seenNorm.add(normTitle)) continue
                cards.add(card)
                if (cards.size >= 14) break
            }

            if (cards.size < 12) {
                val fallback = withTimeoutOrNull(3500L) { fetchAppleSpotlightFeed(catKey, winKey) } ?: emptyList()
                for (card in fallback) {
                    val normTitle = card.title.lowercase(Locale.US).replace(NON_ALNUM_RE, " ").trim()
                    if (!seenIds.add(card.id)) continue
                    if (normTitle.isNotEmpty() && !seenNorm.add(normTitle)) continue
                    cards.add(card)
                    if (cards.size >= 14) break
                }
            }
        }

        if (cards.isNotEmpty()) {
            spotlightCache[cacheKey] = CachedSpotlightEntry(now, cards.toList())
        }
        cards
    }

    private suspend fun fetchAndStore(catKey: String, winKey: String, forceRefresh: Boolean): DiscoverFeedResult {
        val cacheKey = "$catKey|$winKey"
        val inFlightKey = "$cacheKey|${if (forceRefresh) "force" else "normal"}"
        discoverInFlight[inFlightKey]?.let { existing ->
            return existing.await()
        }

        val deferred = CompletableDeferred<DiscoverFeedResult>()
        val prev = discoverInFlight.putIfAbsent(inFlightKey, deferred)
        if (prev != null) {
            return prev.await()
        }

        return try {
            val cfg = CATEGORY_SPECS[catKey] ?: CATEGORY_SPECS.getValue("movies")
            val batches = coroutineScope {
                val tasks = mutableListOf(
                    async(Dispatchers.IO) {
                        val items = withTimeoutOrNull(6500L) {
                            runCatching { fetchExttoTrending(cfg.exttoCategory, winKey) }.getOrDefault(emptyList())
                        } ?: emptyList()
                        "extto" to orderTrendingByWindow(items, winKey)
                    },
                    async(Dispatchers.IO) {
                        val items = withTimeoutOrNull(5500L) {
                            runCatching { fetchKnabenTrending(catKey, winKey) }.getOrDefault(emptyList())
                        } ?: emptyList()
                        "knaben" to items
                    }
                )
                if (cfg.apibayCatId != null) {
                    tasks.add(async(Dispatchers.IO) {
                        val items = withTimeoutOrNull(4500L) {
                            runCatching { fetchApibayWindowTrending(catKey, winKey, cfg.apibayCatId) }.getOrDefault(emptyList())
                        } ?: emptyList()
                        "apibay" to items
                    })
                }
                if (catKey == "anime") {
                    tasks.add(async(Dispatchers.IO) {
                        val items = withTimeoutOrNull(5500L) {
                            runCatching { fetchNyaaTrending(winKey) }.getOrDefault(emptyList())
                        } ?: emptyList()
                        "nyaa" to items
                    })
                } else if (catKey == "tv" && winKey != "30D") {
                    tasks.add(async(Dispatchers.IO) {
                        val items = withTimeoutOrNull(5000L) {
                            runCatching { fetchEztvTrending() }.getOrDefault(emptyList())
                        } ?: emptyList()
                        "eztv" to items
                    })
                }
                tasks.awaitAll()
            }

            var torrents = rankMultiSourceTrending(batches, catKey = catKey, winKey = winKey)
            if (torrents.isEmpty()) {
                val cachedFallback = discoverCache[cacheKey]?.payload?.torrents
                if (!cachedFallback.isNullOrEmpty()) {
                    torrents = cachedFallback
                }
            }

            val spotlight = withTimeoutOrNull(4500L) {
                buildWindowSpotlight(catKey, winKey, torrents, forceRefresh)
            } ?: discoverCache[cacheKey]?.payload?.spotlight ?: emptyList()

            val payload = DiscoverFeedResult(
                category = catKey,
                window = winKey,
                spotlight = spotlight,
                torrents = torrents
            )
            if (torrents.isNotEmpty() || spotlight.isNotEmpty()) {
                discoverCache[cacheKey] = CachedDiscoverEntry(System.currentTimeMillis(), payload)
            }
            deferred.complete(payload)
            payload
        } catch (t: Throwable) {
            deferred.completeExceptionally(t)
            throw t
        } finally {
            discoverInFlight.remove(inFlightKey, deferred)
        }
    }

    suspend fun discoverTorrents(
        category: String = "movies",
        window: String = "7D",
        forceRefresh: Boolean = false
    ): DiscoverFeedResult = withContext(Dispatchers.IO) {
        val catKey = normalizeCategory(category)
        val winKey = normalizeWindow(window)
        val cached = discoverCache["$catKey|$winKey"]
        val now = System.currentTimeMillis()

        if (!forceRefresh && cached != null) {
            val ageMs = now - cached.timestampMs
            if (ageMs < DISCOVER_CACHE_TTL_MS) {
                return@withContext cached.payload
            }
            backgroundScope.launch {
                runCatching { fetchAndStore(catKey, winKey, forceRefresh = false) }
            }
            return@withContext cached.payload
        }

        fetchAndStore(catKey, winKey, forceRefresh)
    }

    fun warmCacheInBackground() {
        backgroundScope.launch {
            runCatching { fetchAndStore("movies", "7D", forceRefresh = false) }
            launch { runCatching { fetchAndStore("movies", "1D", forceRefresh = false) } }
            launch { runCatching { fetchAndStore("tv", "7D", forceRefresh = false) } }
            launch { runCatching { fetchAndStore("anime", "7D", forceRefresh = false) } }
        }
    }

    private fun normalizeCategory(raw: String): String {
        val clean = raw.trim().lowercase(Locale.US)
        return if (CATEGORY_SPECS.containsKey(clean)) clean else "movies"
    }

    private fun normalizeWindow(raw: String): String {
        val clean = raw.trim().uppercase(Locale.US)
        return if (VALID_WINDOWS.contains(clean)) clean else "7D"
    }
}
