package com.svorrent.app

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.Socket
import java.net.URL
import java.net.URLEncoder
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

    fun decodeHtmlEntities(input: String?): String {
        if (input.isNullOrEmpty()) return ""
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

        val numRegex = Regex("&#(\\d+);")
        str = numRegex.replace(str) { match ->
            val code = match.groupValues[1].toIntOrNull()
            if (code != null && code in 32..126) code.toChar().toString() else match.value
        }
        return str
    }

    fun stripHtmlTags(input: String?): String {
        if (input.isNullOrEmpty()) return ""
        return input.replace(Regex("<[^>]*>"), "").trim()
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
        val match = Regex("""xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})""", RegexOption.IGNORE_CASE).find(trimmed)
        if (match != null) {
            return match.groupValues[1].lowercase()
        }
        return ""
    }

    fun parseFormattedSize(sizeStr: String): Long {
        val clean = sizeStr.trim()
        if (clean.isEmpty()) return 0L
        val match = Regex("""([\d.]+)\s*([KMGT]?i?B)""", RegexOption.IGNORE_CASE).find(clean) ?: return 0L
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

        val words = clean.split(Regex("\\s+")).filter { it.isNotEmpty() }
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

    private fun resolveViaDoH(hostname: String): String? {
        return try {
            val url = URL("https://1.1.1.1/dns-query?name=${URLEncoder.encode(hostname, "UTF-8")}&type=A")
            val conn = (url.openConnection() as HttpsURLConnection).apply {
                requestMethod = "GET"
                setRequestProperty("Accept", "application/dns-json")
                connectTimeout = 5000
                readTimeout = 5000
            }
            if (conn.responseCode != 200) return null
            val body = BufferedReader(InputStreamReader(conn.inputStream)).use { it.readText() }
            val json = JSONObject(body)
            val answers = json.optJSONArray("Answer") ?: return null
            for (i in 0 until answers.length()) {
                val ans = answers.getJSONObject(i)
                if (ans.optInt("type") == 1) {
                    val data = ans.optString("data")
                    if (data.isNotBlank()) return data
                }
            }
            null
        } catch (_: Exception) {
            null
        }
    }

    fun fetchUrlWithDoHFallback(targetUrl: String, headers: Map<String, String> = emptyMap()): String {
        val parsed = URL(targetUrl)
        try {
            val conn = (parsed.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                setRequestProperty("User-Agent", "Mozilla/5.0 (Android; Mobile; Svorrent/${BuildConfig.VERSION_NAME})")
                for ((k, v) in headers) {
                    setRequestProperty(k, v)
                }
                connectTimeout = 7000
                readTimeout = 8000
            }
            if (conn.responseCode in 200..299) {
                return BufferedReader(InputStreamReader(conn.inputStream)).use { it.readText() }
            }
        } catch (_: Exception) {
            // Fall through to Cloudflare DoH resolution if ISP/carrier blocks DNS
        }

        val resolvedIp = resolveViaDoH(parsed.host)
            ?: throw Exception("Could not reach search index ($parsed.host). Check internet connection.")

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
        val httpsConn = (ipUrl.openConnection() as HttpsURLConnection).apply {
            sslSocketFactory = sniFactory
            setRequestProperty("Host", sniHost)
            setRequestProperty("User-Agent", "Mozilla/5.0 (Android; Mobile; Svorrent/${BuildConfig.VERSION_NAME})")
            for ((k, v) in headers) {
                setRequestProperty(k, v)
            }
            setHostnameVerifier { _, session ->
                HttpsURLConnection.getDefaultHostnameVerifier().verify(sniHost, session)
            }
            connectTimeout = 8000
            readTimeout = 8000
        }
        return BufferedReader(InputStreamReader(httpsConn.inputStream)).use { it.readText() }
    }

    // 1. ThePirateBay (apibay.org JSON API)
    fun searchThePirateBay(query: String): List<SearchResultItem> {
        val encoded = URLEncoder.encode(query.trim(), "UTF-8")
        val raw = fetchUrlWithDoHFallback("https://apibay.org/q.php?q=$encoded&cat=0")
        val arr = JSONArray(raw)
        val results = mutableListOf<SearchResultItem>()

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

    // 2. BitSearch (HTML Multi-page Scraper)
    fun searchBitSearch(query: String, page: Int = 1): List<SearchResultItem> {
        val encoded = URLEncoder.encode(query.trim(), "UTF-8")
        val url = "https://bitsearch.eu/search?q=$encoded&page=$page"
        val html = fetchUrlWithDoHFallback(url, mapOf("Accept" to "text/html,application/xhtml+xml"))

        val cardRegex = Regex("""<div[^>]*class="[^"]*torrent-result-card[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*torrent-result-card[^"]*"|$)""", RegexOption.IGNORE_CASE)
        val results = mutableListOf<SearchResultItem>()

        for (match in cardRegex.findAll(html)) {
            val card = match.groupValues[1]

            val titleMatch = Regex("""<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)</a>""", RegexOption.IGNORE_CASE).find(card)
            val rawTitle = titleMatch?.groupValues?.get(1)?.let { stripHtmlTags(it) } ?: ""
            val title = decodeHtmlEntities(rawTitle)
            if (title.isBlank()) continue

            val magnetMatch = Regex("""href="(magnet:\?[^"]+)"""", RegexOption.IGNORE_CASE).find(card)
            var magnet = magnetMatch?.groupValues?.get(1)?.replace("&#x3D;", "=", ignoreCase = true)?.replace("&amp;", "&") ?: ""
            val infoHash = extractInfoHash(magnet)
            if (infoHash.isEmpty()) continue
            if (magnet.isEmpty()) {
                magnet = buildMagnetUri(infoHash, title)
            }

            val seedMatch = Regex("""text-green-600[\s\S]*?<span class="font-medium">(\d+)</span>""", RegexOption.IGNORE_CASE).find(card)
            val seeds = sanitizeSwarmCount(seedMatch?.groupValues?.get(1))

            val leechMatch = Regex("""text-red-600[\s\S]*?<span class="font-medium">(\d+)</span>""", RegexOption.IGNORE_CASE).find(card)
            val leechers = sanitizeSwarmCount(leechMatch?.groupValues?.get(1))

            val sizeMatch = Regex("""fa-download[^>]*></i>[\s\S]*?<span>([\d.]+\s*[KMGT]?i?B)</span>""", RegexOption.IGNORE_CASE).find(card)
            val sizeFormatted = sizeMatch?.groupValues?.get(1)?.trim() ?: ""
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

    // 3. Torrents.csv (Open JSON Torrent Index)
    fun searchTorrentsCsv(query: String): List<SearchResultItem> {
        val encoded = URLEncoder.encode(query.trim(), "UTF-8")
        val raw = fetchUrlWithDoHFallback("https://torrents-csv.com/service/search?q=$encoded", mapOf("Accept" to "application/json"))
        val obj = JSONObject(raw)
        val arr = obj.optJSONArray("torrents") ?: return emptyList()
        val results = mutableListOf<SearchResultItem>()

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

    // 4. Nyaa (Anime & Media RSS Feed)
    fun searchNyaa(query: String): List<SearchResultItem> {
        val encoded = URLEncoder.encode(query.trim(), "UTF-8")
        val xml = fetchUrlWithDoHFallback("https://nyaa.si/?page=rss&q=$encoded", mapOf("Accept" to "application/rss+xml, text/xml"))
        val itemRegex = Regex("""<item>([\s\S]*?)</item>""", RegexOption.IGNORE_CASE)
        val results = mutableListOf<SearchResultItem>()

        for (match in itemRegex.findAll(xml)) {
            val item = match.groupValues[1]

            val titleMatch = Regex("""<title>([\s\S]*?)</title>""", RegexOption.IGNORE_CASE).find(item)
            val rawTitle = titleMatch?.groupValues?.get(1)?.replace(Regex("""<!\[CDATA\[([\s\S]*?)\]\]>"""), "$1") ?: ""
            val title = decodeHtmlEntities(stripHtmlTags(rawTitle))
            if (title.isBlank()) continue

            val hashMatch = Regex("""<nyaa:infoHash>([a-fA-F0-9]{40})</nyaa:infoHash>""", RegexOption.IGNORE_CASE).find(item)
            val infoHash = hashMatch?.groupValues?.get(1)?.lowercase() ?: ""
            if (infoHash.isEmpty()) continue

            val seedMatch = Regex("""<nyaa:seeders>(\d+)</nyaa:seeders>""", RegexOption.IGNORE_CASE).find(item)
            val seeds = sanitizeSwarmCount(seedMatch?.groupValues?.get(1))

            val leechMatch = Regex("""<nyaa:leechers>(\d+)</nyaa:leechers>""", RegexOption.IGNORE_CASE).find(item)
            val leechers = sanitizeSwarmCount(leechMatch?.groupValues?.get(1))

            val sizeMatch = Regex("""<nyaa:size>([\s\S]*?)</nyaa:size>""", RegexOption.IGNORE_CASE).find(item)
            val sizeFormatted = sizeMatch?.groupValues?.get(1)?.trim() ?: ""
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

    suspend fun search(query: String): List<SearchResultItem> = withContext(Dispatchers.IO) {
        val clean = query.trim()
        if (clean.isEmpty()) return@withContext emptyList()

        val queries = buildSearchQueries(clean)
        val results = mutableListOf<SearchResultItem>()
        val seenHashes = mutableSetOf<String>()

        coroutineScope {
            val tasks = mutableListOf<kotlinx.coroutines.Deferred<List<SearchResultItem>>>()

            // 1. ThePirateBay (query original and prefix wildcard if different)
            for (q in queries) {
                tasks.add(async { runCatching { searchThePirateBay(q) }.getOrDefault(emptyList()) })
            }

            // 2. BitSearch (Pages 1 & 2)
            tasks.add(async { runCatching { searchBitSearch(clean, page = 1) }.getOrDefault(emptyList()) })
            tasks.add(async { runCatching { searchBitSearch(clean, page = 2) }.getOrDefault(emptyList()) })

            // 3. Torrents.csv
            tasks.add(async { runCatching { searchTorrentsCsv(clean) }.getOrDefault(emptyList()) })

            // 4. Nyaa
            tasks.add(async { runCatching { searchNyaa(clean) }.getOrDefault(emptyList()) })

            val allLists = tasks.awaitAll()
            for (list in allLists) {
                for (item in list) {
                    if (item.infoHash.length == 40 && seenHashes.add(item.infoHash)) {
                        results.add(item)
                    }
                }
            }
        }

        results.sortedByDescending { it.seeds }
    }
}
