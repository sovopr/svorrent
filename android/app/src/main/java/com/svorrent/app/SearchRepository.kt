package com.svorrent.app

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.Socket
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLParameters
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

object SearchRepository {
    val PUBLIC_TRACKERS = listOf(
        "udp://tracker.opentrackr.org:1337/announce",
        "udp://open.stealth.si:80/announce",
        "udp://tracker.torrent.eu.org:451/announce",
        "udp://tracker.bittorrent.com:6969/announce",
        "udp://tracker.openbittorrent.com:6969/announce",
        "udp://explodie.org:6969/announce",
        "udp://tracker.cyberia.is:6969/announce"
    )

    private val INDEXER_HOSTS = listOf(
        "apibay.org",
        "bitsearch.eu",
        "torrents-csv.com",
        "nyaa.si"
    )

    // Precompiled regular expressions to avoid per-item Pattern.compile overhead
    private val NUM_ENTITY_REGEX = Regex("&#(\\d+);")
    private val HTML_TAG_REGEX = Regex("<[^>]*>")
    private val BTIH_REGEX = Regex("""xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})""", RegexOption.IGNORE_CASE)
    private val SIZE_REGEX = Regex("""([\d.]+)\s*([KMGT]?i?B)""", RegexOption.IGNORE_CASE)
    private val WHITESPACE_REGEX = Regex("\\s+")
    private val SQUARE_BRACKET_REGEX = Regex("""\[[^\]]*]""")
    private val PAREN_BRACKET_REGEX = Regex("""\([^\)]*\)""")
    private val CURLY_BRACKET_REGEX = Regex("""\{[^\}]*\}""")
    private val NON_ALNUM_REGEX = Regex("""[^a-z0-9]+""")

    private val HIGH_RES_VIDEO_REGEX = Regex(
        """\b(2160p|1080p|4k|uhd|remux|bluray|blu-ray)\b""",
        RegexOption.IGNORE_CASE
    )
    private val STD_VIDEO_REGEX = Regex(
        """\b(720p|480p|web-dl|webrip|hdrip|bdrip|dvdrip|dvd|brrip|hdtv)\b""",
        RegexOption.IGNORE_CASE
    )
    private val VIDEO_CODEC_REGEX = Regex(
        """\b(x264|x265|hevc|h264|h265|avc|truehd|atmos|dts|ac3|eac3|ddp5\.1|aac|yts|rarbg|yify|swtyblz|galaxyrg|proper|extended)\b""",
        RegexOption.IGNORE_CASE
    )
    private val RELEASE_YEAR_REGEX = Regex("""\b(19\d\d|20\d\d)\b""")
    private val GAME_OR_SOFTWARE_REGEX = Regex(
        """\b(fitgirl|dodi|codex|skidrow|flt|plaza|cpass|telltale|dlc|switch|nsp|xci|iso|rom|emulator|crack|keygen|patch|trainer|mod|apk|setup\.exe)\b""",
        RegexOption.IGNORE_CASE
    )
    private val REPACK_WORD_REGEX = Regex("""\brepack\b""", RegexOption.IGNORE_CASE)

    private val BS_TITLE_REGEX = Regex("""<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)</a>""", RegexOption.IGNORE_CASE)
    private val BS_MAGNET_REGEX = Regex("""href="(magnet:\?[^"]+)"""", RegexOption.IGNORE_CASE)
    private val BS_SEED_REGEX = Regex("""text-green-600[\s\S]*?<span class="font-medium">(\d+)</span>""", RegexOption.IGNORE_CASE)
    private val BS_LEECH_REGEX = Regex("""text-red-600[\s\S]*?<span class="font-medium">(\d+)</span>""", RegexOption.IGNORE_CASE)
    private val BS_SIZE_REGEX = Regex("""fa-download[^>]*></i>[\s\S]*?<span>([\d.]+\s*[KMGT]?i?B)</span>""", RegexOption.IGNORE_CASE)

    private val NYAA_ITEM_REGEX = Regex("""<item>([\s\S]*?)</item>""", RegexOption.IGNORE_CASE)
    private val NYAA_TITLE_REGEX = Regex("""<title>([\s\S]*?)</title>""", RegexOption.IGNORE_CASE)
    private val NYAA_CDATA_REGEX = Regex("""<!\[CDATA\[([\s\S]*?)\]\]>""")
    private val NYAA_HASH_REGEX = Regex("""<nyaa:infoHash>([a-fA-F0-9]{40})</nyaa:infoHash>""", RegexOption.IGNORE_CASE)
    private val NYAA_SEED_REGEX = Regex("""<nyaa:seeders>(\d+)</nyaa:seeders>""", RegexOption.IGNORE_CASE)
    private val NYAA_LEECH_REGEX = Regex("""<nyaa:leechers>(\d+)</nyaa:leechers>""", RegexOption.IGNORE_CASE)
    private val NYAA_SIZE_REGEX = Regex("""<nyaa:size>([\s\S]*?)</nyaa:size>""", RegexOption.IGNORE_CASE)

    private data class CachedQueryEntry(
        val timestampMs: Long,
        val results: List<SearchResultItem>
    )

    private data class ScoredSearchItem(
        val item: SearchResultItem,
        val score: Long
    )

    private const val QUERY_CACHE_TTL_MS = 90_000L
    private const val QUERY_CACHE_MAX_SIZE = 30
    private val queryCache = ConcurrentHashMap<String, CachedQueryEntry>()

    private val dnsCache = ConcurrentHashMap<String, String>()
    private val inFlightDns = ConcurrentHashMap<String, CompletableFuture<String?>>()
    private val blockedDirectHosts = ConcurrentHashMap.newKeySet<String>()
    private val unreachableHostsUntil = ConcurrentHashMap<String, Long>()
    private val networkRaceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    fun decodeHtmlEntities(input: String?): String {
        if (input.isNullOrEmpty()) return ""
        if (!input.contains('&')) return input
        var str = input
            .replace("&amp;", "&", ignoreCase = true)
            .replace("&lt;", "<", ignoreCase = true)
            .replace("&gt;", ">", ignoreCase = true)
            .replace("&quot;", "\"", ignoreCase = true)
            .replace("&#039;", "'", ignoreCase = true)
            .replace("&#39;", "'", ignoreCase = true)
            .replace("&apos;", "'", ignoreCase = true)
            .replace("&#x27;", "'", ignoreCase = true)
            .replace("&#x3d;", "=", ignoreCase = true)
            .replace("&#61;", "=", ignoreCase = true)

        if (str.contains("&#")) {
            str = NUM_ENTITY_REGEX.replace(str) { match ->
                val code = match.groupValues[1].toIntOrNull()
                if (code != null && code in 32..126) code.toChar().toString() else match.value
            }
        }
        return str
    }

    fun stripHtmlTags(input: String?): String {
        if (input.isNullOrEmpty()) return ""
        if (!input.contains('<')) return input.trim()
        return input.replace(HTML_TAG_REGEX, "").trim()
    }

    fun sanitizeSwarmCount(raw: Any?): Int {
        if (raw == null) return 0
        val str = raw.toString().trim()
        val n = str.toLongOrNull() ?: return 0
        if (n <= 0) return 0
        // Mask out 64-bit internal tracking flags (e.g. 4294967301 = 2^32 + 5)
        val masked = (n and 0xFFFFFFFFL).toInt()
        if (masked > 500000 || masked < 0) return 0
        return masked
    }

    fun extractInfoHash(magnetOrHash: String?): String {
        if (magnetOrHash.isNullOrBlank()) return ""
        val trimmed = magnetOrHash.trim()
        if (trimmed.length == 40 && trimmed.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) {
            return trimmed.lowercase()
        }
        val match = BTIH_REGEX.find(trimmed)
        if (match != null) {
            return match.groupValues[1].lowercase()
        }
        return ""
    }

    fun parseFormattedSize(sizeStr: String): Long {
        val clean = sizeStr.trim()
        if (clean.isEmpty()) return 0L
        val match = SIZE_REGEX.find(clean) ?: return 0L
        val num = match.groupValues[1].toDoubleOrNull() ?: return 0L
        val unit = match.groupValues[2].uppercase()
        val multiplier = when {
            unit.startsWith("T") -> 1024L * 1024L * 1024L * 1024L
            unit.startsWith("G") -> 1024L * 1024L * 1024L
            unit.startsWith("M") -> 1024L * 1024L
            unit.startsWith("K") -> 1024L
            else -> 1L
        }
        return (num * multiplier).toLong()
    }

    fun buildSearchQueries(rawQuery: String): List<String> {
        val clean = rawQuery.trim()
        if (clean.isEmpty()) return emptyList()
        val variants = LinkedHashSet<String>()
        variants.add(clean)

        val words = clean.split(WHITESPACE_REGEX).filter { it.isNotEmpty() }
        if (words.isNotEmpty()) {
            val wildcardWords = words.map { w ->
                if (w.length >= 3 && !w.endsWith("*") && w.all { it.isLetterOrDigit() || it == '_' || it == '-' }) {
                    "$w*"
                } else {
                    w
                }
            }
            val wildcardQuery = wildcardWords.joinToString(" ")
            if (wildcardQuery != clean) {
                variants.add(wildcardQuery)
            }
        }
        return variants.toList()
    }

    fun buildMagnetUri(infoHash: String, displayName: String): String {
        val cleanHash = extractInfoHash(infoHash).ifEmpty { infoHash.trim().lowercase() }
        val encodedName = URLEncoder.encode(displayName, "UTF-8")
        val trackersPart = PUBLIC_TRACKERS.joinToString("") {
            "&tr=" + URLEncoder.encode(it, "UTF-8")
        }
        return "magnet:?xt=urn:btih:$cleanHash&dn=$encodedName$trackersPart"
    }

    fun normalizeTitleForDedup(title: String): String {
        return title.lowercase()
            .replace(SQUARE_BRACKET_REGEX, " ")
            .replace(PAREN_BRACKET_REGEX, " ")
            .replace(CURLY_BRACKET_REGEX, " ")
            .replace(NON_ALNUM_REGEX, " ")
            .trim()
    }

    fun scoreSearchResult(item: SearchResultItem, query: String = ""): Long {
        val lowerQuery = query.trim().lowercase()
        val queryTokens = if (lowerQuery.isEmpty()) {
            emptyList()
        } else {
            lowerQuery.split(NON_ALNUM_REGEX).filter { it.length >= 2 }
        }
        return scoreSearchResultTokens(item, lowerQuery, queryTokens)
    }

    private fun scoreSearchResultTokens(
        item: SearchResultItem,
        lowerQuery: String,
        queryTokens: List<String>
    ): Long {
        var score = 0L
        val title = item.title.trim()
        val lowerTitle = title.lowercase()

        // 1. Query matching
        if (lowerQuery.isNotEmpty() && lowerTitle.contains(lowerQuery)) {
            score += 4000L
        }
        if (lowerQuery.isNotEmpty() && lowerTitle.startsWith(lowerQuery)) {
            score += 1500L
        }
        if (queryTokens.isNotEmpty()) {
            val matched = queryTokens.count { lowerTitle.contains(it) }
            score += ((matched.toDouble() / queryTokens.size) * 2000L).toLong()
        }

        // 2. Video & Movie Indicators (1080p/4K preferred over 720p/SD)
        val isHighResVideo = HIGH_RES_VIDEO_REGEX.containsMatchIn(lowerTitle)
        val isStdVideo = !isHighResVideo && STD_VIDEO_REGEX.containsMatchIn(lowerTitle)
        val hasVideoRes = isHighResVideo || isStdVideo
        if (isHighResVideo) {
            score += 4800L
        } else if (isStdVideo) {
            score += 4200L
        }

        if (VIDEO_CODEC_REGEX.containsMatchIn(lowerTitle)) {
            score += 2500L
        }

        if (RELEASE_YEAR_REGEX.containsMatchIn(lowerTitle)) {
            score += 2000L
        }

        // 3. File size heuristics for Movies vs tiny patches / cracks
        val sizeBytes = item.sizeBytes
        if (sizeBytes in (700L * 1024L * 1024L)..(90L * 1024L * 1024L * 1024L)) {
            score += 3000L
            if (sizeBytes in (1200L * 1024L * 1024L)..(35L * 1024L * 1024L * 1024L)) {
                score += 1500L
            }
        } else if (sizeBytes in 1L until (60L * 1024L * 1024L)) {
            score -= 6000L
        }

        // 4. Non-movie / Game / Software penalties (do not penalize scene BluRay/1080p REPACK movies)
        val isGameOrSoftware = GAME_OR_SOFTWARE_REGEX.containsMatchIn(lowerTitle) ||
            (!hasVideoRes && REPACK_WORD_REGEX.containsMatchIn(lowerTitle))
        if (isGameOrSoftware) {
            score -= 7000L
        }

        // 5. Penalize fragmented / bracket-only titles
        if (title.startsWith("(") && title.endsWith(")")) {
            score -= 8000L
        }

        // 6. Capped seed count so fake seeds cannot overpower genuine movie releases
        val seeds = item.seeds.coerceAtLeast(0)
        score += seeds.coerceAtMost(2500)

        return score
    }

    private fun queryDoHEndpoint(dohUrl: String): String? {
        var conn: HttpsURLConnection? = null
        return try {
            conn = (URL(dohUrl).openConnection() as HttpsURLConnection).apply {
                requestMethod = "GET"
                setRequestProperty("Accept", "application/dns-json")
                connectTimeout = 2000
                readTimeout = 2000
            }
            if (conn.responseCode != 200) return null
            val body = BufferedReader(InputStreamReader(conn.inputStream)).use { it.readText() }
            val json = JSONObject(body)
            val answers = json.optJSONArray("Answer") ?: return null
            for (i in 0 until answers.length()) {
                val ans = answers.getJSONObject(i)
                if (ans.optInt("type") == 1) {
                    val data = ans.optString("data")
                    if (data.isNotBlank()) {
                        return data
                    }
                }
            }
            null
        } catch (_: Exception) {
            null
        } finally {
            runCatching { conn?.disconnect() }
        }
    }

    private fun resolveViaDoH(hostname: String): String? {
        dnsCache[hostname]?.let { return it }

        val future = CompletableFuture<String?>()
        val existing = inFlightDns.putIfAbsent(hostname, future)
        if (existing != null) {
            return runCatching { existing.get(3500, TimeUnit.MILLISECONDS) }.getOrNull()
        }

        return try {
            val encodedHost = URLEncoder.encode(hostname, "UTF-8")
            val ip = queryDoHEndpoint("https://1.1.1.1/dns-query?name=$encodedHost&type=A")
                ?: queryDoHEndpoint("https://8.8.8.8/resolve?name=$encodedHost&type=A")
            if (!ip.isNullOrBlank()) {
                dnsCache[hostname] = ip
            }
            future.complete(ip)
            ip
        } catch (_: Throwable) {
            future.complete(null)
            null
        } finally {
            inFlightDns.remove(hostname, future)
        }
    }

    suspend fun prewarmIndexers() = withContext(Dispatchers.IO) {
        runCatching {
            coroutineScope {
                INDEXER_HOSTS
                    .filter { !dnsCache.containsKey(it) }
                    .map { host -> async { resolveViaDoH(host) } }
                    .awaitAll()
            }
        }
    }

    private fun areAllIndexersMarkedUnreachable(nowMs: Long): Boolean {
        return INDEXER_HOSTS.all { host ->
            val until = unreachableHostsUntil[host]
            until != null && nowMs < until
        }
    }

    private fun fetchDirect(
        parsed: URL,
        headers: Map<String, String>,
        connectMs: Int,
        readMs: Int
    ): String {
        var conn: HttpURLConnection? = null
        try {
            conn = (parsed.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                setRequestProperty("User-Agent", "Mozilla/5.0 (Android; Mobile; Svorrent/${BuildConfig.VERSION_NAME})")
                for ((k, v) in headers) {
                    setRequestProperty(k, v)
                }
                connectTimeout = connectMs
                readTimeout = readMs
            }
            val code = conn.responseCode
            if (code !in 200..299) {
                throw IOException("HTTP $code from ${parsed.host}")
            }
            return BufferedReader(InputStreamReader(conn.inputStream)).use { it.readText() }
        } finally {
            runCatching { conn?.disconnect() }
        }
    }

    private fun fetchViaDoHIp(
        parsed: URL,
        resolvedIp: String,
        headers: Map<String, String>,
        connectMs: Int,
        readMs: Int
    ): String {
        val sniHost = parsed.host
        val baseFactory = SSLSocketFactory.getDefault() as SSLSocketFactory
        val sniFactory = object : SSLSocketFactory() {
            override fun getDefaultCipherSuites(): Array<String> = baseFactory.defaultCipherSuites
            override fun getSupportedCipherSuites(): Array<String> = baseFactory.supportedCipherSuites
            override fun createSocket(s: Socket?, host: String?, port: Int, autoClose: Boolean): Socket {
                val ssl = baseFactory.createSocket(s, sniHost, port, autoClose) as SSLSocket
                ssl.sslParameters = ssl.sslParameters.apply { serverNames = listOf(SNIHostName(sniHost)) }
                return ssl
            }
            override fun createSocket(host: String?, port: Int): Socket {
                val ssl = baseFactory.createSocket(InetAddress.getByName(resolvedIp), port) as SSLSocket
                ssl.sslParameters = SSLParameters().apply { serverNames = listOf(SNIHostName(sniHost)) }
                return ssl
            }
            override fun createSocket(host: String?, port: Int, localHost: InetAddress?, localPort: Int): Socket =
                createSocket(host, port)
            override fun createSocket(host: InetAddress?, port: Int): Socket =
                createSocket(sniHost, port)
            override fun createSocket(address: InetAddress?, port: Int, localAddress: InetAddress?, localPort: Int): Socket =
                createSocket(sniHost, port)
        }

        val ipUrl = URL(parsed.protocol, resolvedIp, if (parsed.port == -1) 443 else parsed.port, parsed.file)
        var httpsConn: HttpsURLConnection? = null
        try {
            httpsConn = (ipUrl.openConnection() as HttpsURLConnection).apply {
                sslSocketFactory = sniFactory
                setRequestProperty("Host", sniHost)
                setRequestProperty("User-Agent", "Mozilla/5.0 (Android; Mobile; Svorrent/${BuildConfig.VERSION_NAME})")
                for ((k, v) in headers) {
                    setRequestProperty(k, v)
                }
                setHostnameVerifier { _, session ->
                    HttpsURLConnection.getDefaultHostnameVerifier().verify(sniHost, session)
                }
                connectTimeout = connectMs
                readTimeout = readMs
            }
            val code = httpsConn.responseCode
            if (code !in 200..299) {
                throw IOException("HTTP $code from $sniHost via DoH")
            }
            return BufferedReader(InputStreamReader(httpsConn.inputStream)).use { it.readText() }
        } finally {
            runCatching { httpsConn?.disconnect() }
        }
    }

    fun fetchUrlWithDoHFallback(targetUrl: String, headers: Map<String, String> = emptyMap()): String {
        val parsed = URL(targetUrl)
        val host = parsed.host

        if (!blockedDirectHosts.contains(host)) {
            try {
                return fetchDirect(parsed, headers, connectMs = 1800, readMs = 2800)
            } catch (_: Exception) {
                blockedDirectHosts.add(host)
            }
        }

        val resolvedIp = resolveViaDoH(host)
            ?: throw IOException("Could not reach search index ($host). Check internet connection.")

        return fetchViaDoHIp(parsed, resolvedIp, headers, connectMs = 2200, readMs = 3200)
    }

    private suspend fun fetchUrlFast(
        targetUrl: String,
        headers: Map<String, String> = emptyMap()
    ): String = withContext(Dispatchers.IO) {
        val parsed = URL(targetUrl)
        val host = parsed.host
        val now = System.currentTimeMillis()

        val blockedUntil = unreachableHostsUntil[host]
        if (blockedUntil != null) {
            if (now < blockedUntil && !areAllIndexersMarkedUnreachable(now)) {
                throw IOException("Host $host temporarily unreachable")
            } else if (now >= blockedUntil) {
                unreachableHostsUntil.remove(host)
            }
        }

        if (blockedDirectHosts.contains(host)) {
            return@withContext try {
                val ip = resolveViaDoH(host)
                    ?: throw IOException("Could not resolve $host via DoH")
                fetchViaDoHIp(parsed, ip, headers, connectMs = 2000, readMs = 2800)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                unreachableHostsUntil[host] = System.currentTimeMillis() + 60_000L
                throw e
            }
        }

        val outcome = Channel<Result<String>>(Channel.UNLIMITED)
        val directFailed = CompletableDeferred<Unit>()

        val directJob = networkRaceScope.launch {
            val res = runCatching {
                fetchDirect(parsed, headers, connectMs = 1500, readMs = 2500)
            }
            if (res.exceptionOrNull() is CancellationException) return@launch
            if (res.isFailure) {
                blockedDirectHosts.add(host)
                directFailed.complete(Unit)
            }
            if (!isActive) return@launch
            outcome.trySend(res)
        }

        val dohJob = networkRaceScope.launch {
            withTimeoutOrNull(450L) {
                directFailed.await()
            }
            if (!isActive) return@launch
            val res = runCatching {
                val ip = resolveViaDoH(host)
                    ?: throw IOException("Could not resolve $host via DoH")
                fetchViaDoHIp(parsed, ip, headers, connectMs = 2000, readMs = 2800)
            }
            if (!isActive || res.exceptionOrNull() is CancellationException) return@launch
            outcome.trySend(res)
        }

        try {
            val first = outcome.receive()
            if (first.isSuccess) {
                return@withContext first.getOrThrow()
            }

            val second = outcome.receive()
            if (second.isSuccess) {
                return@withContext second.getOrThrow()
            }

            unreachableHostsUntil[host] = System.currentTimeMillis() + 60_000L
            throw second.exceptionOrNull()
                ?: first.exceptionOrNull()
                ?: IOException("Could not reach search index ($host)")
        } finally {
            directJob.cancel()
            dohJob.cancel()
        }
    }

    // 1. ThePirateBay (apibay.org JSON API)
    private fun parseThePirateBayJson(raw: String): List<SearchResultItem> {
        val arr = JSONArray(raw)
        val results = ArrayList<SearchResultItem>(arr.length())

        for (i in 0 until arr.length()) {
            val obj = arr.getJSONObject(i)
            val name = decodeHtmlEntities(stripHtmlTags(obj.optString("name", "")))
            val infoHash = obj.optString("info_hash", "").trim().lowercase()
            if (name.isEmpty() || name.equals("No results returned", ignoreCase = true) || infoHash.length != 40 || infoHash == "0".repeat(40)) {
                continue
            }

            val sizeBytes = obj.optString("size", "0").toLongOrNull() ?: 0L
            val seeds = sanitizeSwarmCount(obj.opt("seeders"))
            val leechers = sanitizeSwarmCount(obj.opt("leechers"))
            val catCode = obj.optString("category", "200").toIntOrNull() ?: 200
            val catName = when (catCode / 100) {
                1 -> "Audio"
                2 -> "Video"
                3 -> "Apps"
                4 -> "Games"
                else -> "Other"
            }

            results.add(
                SearchResultItem(
                    id = infoHash,
                    title = name,
                    sizeBytes = sizeBytes,
                    sizeFormatted = Formatters.formatBytes(sizeBytes),
                    seeds = seeds,
                    leechers = leechers,
                    provider = "ThePirateBay",
                    infoHash = infoHash,
                    magnet = buildMagnetUri(infoHash, name),
                    category = catName
                )
            )
        }
        return results
    }

    fun searchThePirateBay(query: String): List<SearchResultItem> {
        val encoded = URLEncoder.encode(query.trim(), "UTF-8")
        val raw = fetchUrlWithDoHFallback("https://apibay.org/q.php?q=$encoded&cat=0")
        return parseThePirateBayJson(raw)
    }

    private suspend fun searchThePirateBayFast(query: String): List<SearchResultItem> {
        val encoded = URLEncoder.encode(query.trim(), "UTF-8")
        val raw = fetchUrlFast("https://apibay.org/q.php?q=$encoded&cat=0")
        return parseThePirateBayJson(raw)
    }

    // 2. BitSearch (Linear chunked HTML parser - avoids lookahead backtracking on 180 KB HTML)
    private fun parseBitSearchHtml(html: String): List<SearchResultItem> {
        val chunks = html.split("torrent-result-card", ignoreCase = true)
        if (chunks.size <= 1) return emptyList()
        val results = ArrayList<SearchResultItem>(chunks.size - 1)

        for (idx in 1 until chunks.size) {
            val card = chunks[idx].take(12288)

            val titleMatch = BS_TITLE_REGEX.find(card) ?: continue
            val title = decodeHtmlEntities(stripHtmlTags(titleMatch.groupValues[1]))
            if (title.isBlank()) continue

            val magnetMatch = BS_MAGNET_REGEX.find(card)
            var magnet = magnetMatch?.groupValues?.get(1)
                ?.replace("&#x3D;", "=", ignoreCase = true)
                ?.replace("&amp;", "&")
                ?: ""
            val infoHash = extractInfoHash(magnet)
            if (infoHash.isEmpty()) continue
            if (magnet.isEmpty()) {
                magnet = buildMagnetUri(infoHash, title)
            }

            val seeds = sanitizeSwarmCount(BS_SEED_REGEX.find(card)?.groupValues?.get(1))
            val leechers = sanitizeSwarmCount(BS_LEECH_REGEX.find(card)?.groupValues?.get(1))
            val sizeFormatted = BS_SIZE_REGEX.find(card)?.groupValues?.get(1)?.trim() ?: ""
            val sizeBytes = parseFormattedSize(sizeFormatted)

            val lowerTitle = title.lowercase()
            val category = when {
                lowerTitle.contains("mp3") || lowerTitle.contains("flac") -> "Audio"
                lowerTitle.contains("apk") || lowerTitle.contains(".exe") -> "Apps"
                else -> "Video"
            }

            results.add(
                SearchResultItem(
                    id = infoHash,
                    title = title,
                    sizeBytes = sizeBytes,
                    sizeFormatted = if (sizeFormatted.isNotEmpty()) sizeFormatted else Formatters.formatBytes(sizeBytes),
                    seeds = seeds,
                    leechers = leechers,
                    provider = "BitSearch",
                    infoHash = infoHash,
                    magnet = magnet,
                    category = category
                )
            )
        }
        return results
    }

    fun searchBitSearch(query: String, page: Int = 1): List<SearchResultItem> {
        val encoded = URLEncoder.encode(query.trim(), "UTF-8")
        val url = "https://bitsearch.eu/search?q=$encoded&page=$page"
        val html = fetchUrlWithDoHFallback(url, mapOf("Accept" to "text/html,application/xhtml+xml"))
        return parseBitSearchHtml(html)
    }

    private suspend fun searchBitSearchFast(query: String, page: Int = 1): List<SearchResultItem> {
        val encoded = URLEncoder.encode(query.trim(), "UTF-8")
        val url = "https://bitsearch.eu/search?q=$encoded&page=$page"
        val html = fetchUrlFast(url, mapOf("Accept" to "text/html,application/xhtml+xml"))
        return parseBitSearchHtml(html)
    }

    // 3. Torrents.csv (Open JSON Torrent Index)
    private fun parseTorrentsCsvJson(raw: String): List<SearchResultItem> {
        val obj = JSONObject(raw)
        val arr = obj.optJSONArray("torrents") ?: return emptyList()
        val results = ArrayList<SearchResultItem>(arr.length())

        for (i in 0 until arr.length()) {
            val item = arr.getJSONObject(i)
            val title = decodeHtmlEntities(stripHtmlTags(item.optString("name", "")))
            val infoHash = item.optString("infohash", "").trim().lowercase()
            if (title.isEmpty() || infoHash.length != 40) continue

            val sizeBytes = item.optLong("size_bytes", 0L)
            val seeds = sanitizeSwarmCount(item.opt("seeders"))
            val leechers = sanitizeSwarmCount(item.opt("leechers"))

            results.add(
                SearchResultItem(
                    id = infoHash,
                    title = title,
                    sizeBytes = sizeBytes,
                    sizeFormatted = Formatters.formatBytes(sizeBytes),
                    seeds = seeds,
                    leechers = leechers,
                    provider = "Torrents.csv",
                    infoHash = infoHash,
                    magnet = buildMagnetUri(infoHash, title),
                    category = "Video"
                )
            )
        }
        return results
    }

    fun searchTorrentsCsv(query: String): List<SearchResultItem> {
        val encoded = URLEncoder.encode(query.trim(), "UTF-8")
        val raw = fetchUrlWithDoHFallback("https://torrents-csv.com/service/search?q=$encoded", mapOf("Accept" to "application/json"))
        return parseTorrentsCsvJson(raw)
    }

    private suspend fun searchTorrentsCsvFast(query: String): List<SearchResultItem> {
        val encoded = URLEncoder.encode(query.trim(), "UTF-8")
        val raw = fetchUrlFast("https://torrents-csv.com/service/search?q=$encoded", mapOf("Accept" to "application/json"))
        return parseTorrentsCsvJson(raw)
    }

    // 4. Nyaa (Anime & Media RSS Feed)
    private fun parseNyaaXml(xml: String): List<SearchResultItem> {
        val results = mutableListOf<SearchResultItem>()

        for (match in NYAA_ITEM_REGEX.findAll(xml)) {
            val item = match.groupValues[1]

            val titleMatch = NYAA_TITLE_REGEX.find(item)
            val rawTitle = titleMatch?.groupValues?.get(1)?.replace(NYAA_CDATA_REGEX, "$1") ?: ""
            val title = decodeHtmlEntities(stripHtmlTags(rawTitle))
            if (title.isBlank()) continue

            val infoHash = NYAA_HASH_REGEX.find(item)?.groupValues?.get(1)?.lowercase() ?: ""
            if (infoHash.isEmpty()) continue

            val seeds = sanitizeSwarmCount(NYAA_SEED_REGEX.find(item)?.groupValues?.get(1))
            val leechers = sanitizeSwarmCount(NYAA_LEECH_REGEX.find(item)?.groupValues?.get(1))
            val sizeFormatted = NYAA_SIZE_REGEX.find(item)?.groupValues?.get(1)?.trim() ?: ""
            val sizeBytes = parseFormattedSize(sizeFormatted)

            results.add(
                SearchResultItem(
                    id = infoHash,
                    title = title,
                    sizeBytes = sizeBytes,
                    sizeFormatted = if (sizeFormatted.isNotEmpty()) sizeFormatted else Formatters.formatBytes(sizeBytes),
                    seeds = seeds,
                    leechers = leechers,
                    provider = "Nyaa",
                    infoHash = infoHash,
                    magnet = buildMagnetUri(infoHash, title),
                    category = "Video"
                )
            )
        }
        return results
    }

    fun searchNyaa(query: String): List<SearchResultItem> {
        val encoded = URLEncoder.encode(query.trim(), "UTF-8")
        val xml = fetchUrlWithDoHFallback("https://nyaa.si/?page=rss&q=$encoded", mapOf("Accept" to "application/rss+xml, text/xml"))
        return parseNyaaXml(xml)
    }

    private suspend fun searchNyaaFast(query: String): List<SearchResultItem> {
        val encoded = URLEncoder.encode(query.trim(), "UTF-8")
        val xml = fetchUrlFast("https://nyaa.si/?page=rss&q=$encoded", mapOf("Accept" to "application/rss+xml, text/xml"))
        return parseNyaaXml(xml)
    }

    private fun deduplicateAndRank(
        rawResults: List<SearchResultItem>,
        lowerQuery: String,
        queryTokens: List<String>
    ): List<SearchResultItem> {
        val seenByHash = HashMap<String, SearchResultItem>(rawResults.size)
        val seenByTitle = HashMap<String, SearchResultItem>(rawResults.size)

        for (item in rawResults) {
            val title = item.title.trim()
            val lowerTitle = title.lowercase()

            // Filter out placeholders, broken scrapes, and non-matching fragments
            if (title.length < 3 || lowerTitle == "no results returned" || lowerTitle == "no results found") continue
            if (title.startsWith("(") && title.endsWith(")")) continue
            if (queryTokens.isNotEmpty() && !queryTokens.any { lowerTitle.contains(it) }) continue

            val infoHash = item.infoHash.lowercase()
            val normTitle = normalizeTitleForDedup(title)
            val sizeMb = item.sizeBytes / (1024L * 1024L)
            val titleKey = if (normTitle.isNotEmpty()) "$normTitle|$sizeMb" else ""

            var existing: SearchResultItem? = null
            if (infoHash.isNotEmpty() && seenByHash.containsKey(infoHash)) {
                existing = seenByHash[infoHash]
            } else if (titleKey.isNotEmpty() && seenByTitle.containsKey(titleKey)) {
                existing = seenByTitle[titleKey]
            }

            if (existing != null) {
                if (item.seeds > existing.seeds) {
                    val merged = if (item.magnet.isEmpty() && existing.magnet.isNotEmpty()) {
                        item.copy(magnet = existing.magnet)
                    } else {
                        item
                    }
                    if (infoHash.isNotEmpty()) seenByHash[infoHash] = merged
                    if (titleKey.isNotEmpty()) seenByTitle[titleKey] = merged
                }
                continue
            }

            if (infoHash.isNotEmpty()) seenByHash[infoHash] = item
            if (titleKey.isNotEmpty()) seenByTitle[titleKey] = item
        }

        val deduped = (seenByHash.values + seenByTitle.values).distinctBy {
            if (it.infoHash.isNotEmpty()) it.infoHash else it.title
        }

        // Precompute scores once in O(N) instead of recomputing inside O(N log N) comparator
        val scored = ArrayList<ScoredSearchItem>(deduped.size)
        for (item in deduped) {
            scored.add(ScoredSearchItem(item, scoreSearchResultTokens(item, lowerQuery, queryTokens)))
        }

        scored.sortWith { a, b ->
            val diff = b.score.compareTo(a.score)
            if (diff != 0) diff else b.item.seeds.compareTo(a.item.seeds)
        }

        return scored.map { it.item }
    }

    private fun saveToQueryCache(cacheKey: String, results: List<SearchResultItem>) {
        if (results.isEmpty()) return
        val now = System.currentTimeMillis()
        if (queryCache.size >= QUERY_CACHE_MAX_SIZE) {
            val expiredKeys = queryCache.entries
                .filter { now - it.value.timestampMs >= QUERY_CACHE_TTL_MS }
                .map { it.key }
            for (k in expiredKeys) {
                queryCache.remove(k)
            }
            if (queryCache.size >= QUERY_CACHE_MAX_SIZE) {
                val oldestKey = queryCache.entries.minByOrNull { it.value.timestampMs }?.key
                if (oldestKey != null) queryCache.remove(oldestKey)
            }
        }
        queryCache[cacheKey] = CachedQueryEntry(now, results)
    }

    suspend fun searchStreaming(
        query: String,
        onPartialResults: suspend (List<SearchResultItem>) -> Unit
    ): List<SearchResultItem> {
        val clean = query.trim()
        if (clean.isEmpty()) return emptyList()

        val lowerQuery = clean.lowercase()
        val cached = queryCache[lowerQuery]
        val now = System.currentTimeMillis()
        if (cached != null && (now - cached.timestampMs) < QUERY_CACHE_TTL_MS && cached.results.isNotEmpty()) {
            onPartialResults(cached.results)
            return cached.results
        }

        val callerContext = currentCoroutineContext()
        val queryTokens = lowerQuery.split(NON_ALNUM_REGEX).filter { it.length >= 2 }

        return withContext(Dispatchers.IO) {
            val rawResults = mutableListOf<SearchResultItem>()
            var rankedResults: List<SearchResultItem> = emptyList()
            val successfulProviders = AtomicInteger(0)

            val batchChannel = Channel<List<SearchResultItem>>(Channel.UNLIMITED)
            val remainingProviders = AtomicInteger(4)
            val providerJobs = ArrayList<Job>(4)

            fun markProviderFinished() {
                if (remainingProviders.decrementAndGet() == 0) {
                    batchChannel.close()
                }
            }

            // 1. ThePirateBay (fast JSON API; only issue wildcard fallback when exact < 10)
            providerJobs.add(networkRaceScope.launch {
                try {
                    val primary = runCatching {
                        val list = searchThePirateBayFast(clean)
                        successfulProviders.incrementAndGet()
                        list
                    }.getOrDefault(emptyList())

                    if (isActive && primary.isNotEmpty()) {
                        batchChannel.trySend(primary)
                    }
                    if (isActive && primary.size < 10) {
                        val variants = buildSearchQueries(clean)
                        if (variants.size > 1) {
                            val extra = runCatching { searchThePirateBayFast(variants[1]) }.getOrDefault(emptyList())
                            if (isActive && extra.isNotEmpty()) {
                                batchChannel.trySend(extra)
                            }
                        }
                    }
                } finally {
                    markProviderFinished()
                }
            })

            // 2. Torrents.csv (compact JSON API)
            providerJobs.add(networkRaceScope.launch {
                try {
                    val list = runCatching {
                        val res = searchTorrentsCsvFast(clean)
                        successfulProviders.incrementAndGet()
                        res
                    }.getOrDefault(emptyList())
                    if (isActive && list.isNotEmpty()) {
                        batchChannel.trySend(list)
                    }
                } finally {
                    markProviderFinished()
                }
            })

            // 3. Nyaa (lightweight RSS XML)
            providerJobs.add(networkRaceScope.launch {
                try {
                    val list = runCatching {
                        val res = searchNyaaFast(clean)
                        successfulProviders.incrementAndGet()
                        res
                    }.getOrDefault(emptyList())
                    if (isActive && list.isNotEmpty()) {
                        batchChannel.trySend(list)
                    }
                } finally {
                    markProviderFinished()
                }
            })

            // 4. BitSearch (Page 1 only to avoid downloading 350 KB HTML on cellular)
            providerJobs.add(networkRaceScope.launch {
                try {
                    val list = runCatching {
                        val res = searchBitSearchFast(clean, page = 1)
                        successfulProviders.incrementAndGet()
                        res
                    }.getOrDefault(emptyList())
                    if (isActive && list.isNotEmpty()) {
                        batchChannel.trySend(list)
                    }
                } finally {
                    markProviderFinished()
                }
            })

            try {
                withTimeoutOrNull(3500L) {
                    for (firstBatch in batchChannel) {
                        rawResults.addAll(firstBatch)
                        while (true) {
                            val extraBatch = batchChannel.tryReceive().getOrNull() ?: break
                            rawResults.addAll(extraBatch)
                        }
                        rankedResults = deduplicateAndRank(rawResults, lowerQuery, queryTokens)
                        if (rankedResults.isNotEmpty()) {
                            withContext(callerContext) {
                                onPartialResults(rankedResults)
                            }
                        }
                    }
                }
            } finally {
                providerJobs.forEach { it.cancel() }
                batchChannel.close()
            }

            if (rankedResults.isEmpty() && successfulProviders.get() == 0) {
                throw IOException("Could not reach search indexers. Check your internet connection.")
            }

            saveToQueryCache(lowerQuery, rankedResults)
            rankedResults
        }
    }

    suspend fun search(query: String): List<SearchResultItem> = searchStreaming(query) {}
}
