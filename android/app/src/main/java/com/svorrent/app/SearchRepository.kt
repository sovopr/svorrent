package com.svorrent.app

import kotlinx.coroutines.Dispatchers
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
    private val PUBLIC_TRACKERS = listOf(
        "udp://tracker.opentrackr.org:1337/announce",
        "udp://open.demonii.com:1337/announce",
        "udp://open.stealth.si:80/announce",
        "udp://exodus.desync.com:6969/announce",
        "udp://tracker.torrent.eu.org:451/announce",
        "udp://explodie.org:6969/announce",
        "udp://tracker.openbittorrent.com:6969/announce",
        "http://tracker.opentrackr.org:1337/announce"
    )

    fun buildMagnetUri(infoHash: String, displayName: String): String {
        val cleanHash = infoHash.trim().lowercase()
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

    private fun fetchUrlWithDoHFallback(targetUrl: String): String {
        val parsed = URL(targetUrl)
        try {
            val conn = (parsed.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                setRequestProperty("User-Agent", "Svorrent/1.0.4 (Android)")
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
            ?: throw Exception("Could not reach search index. Check your internet connection.")

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
            setRequestProperty("User-Agent", "Svorrent/1.0.4 (Android)")
            setHostnameVerifier { _, session ->
                HttpsURLConnection.getDefaultHostnameVerifier().verify(sniHost, session)
            }
            connectTimeout = 8000
            readTimeout = 8000
        }
        return BufferedReader(InputStreamReader(httpsConn.inputStream)).use { it.readText() }
    }

    suspend fun search(query: String): List<SearchResultItem> = withContext(Dispatchers.IO) {
        val clean = query.trim()
        if (clean.isEmpty()) return@withContext emptyList()
        val encoded = URLEncoder.encode(clean, "UTF-8")
        val raw = fetchUrlWithDoHFallback("https://apibay.org/q.php?q=$encoded&cat=0")
        val arr = JSONArray(raw)
        val results = mutableListOf<SearchResultItem>()
        val seenHashes = mutableSetOf<String>()

        for (i in 0 until arr.length()) {
            val obj = arr.getJSONObject(i)
            val name = obj.optString("name", "").trim()
            val infoHash = obj.optString("info_hash", "").trim().lowercase()
            if (name.isEmpty() || name == "No results returned" || infoHash.length != 40 || infoHash == "0".repeat(40)) {
                continue
            }
            if (!seenHashes.add(infoHash)) continue

            val sizeBytes = obj.optString("size", "0").toLongOrNull() ?: 0L
            val seeds = obj.optString("seeders", "0").toIntOrNull() ?: 0
            val leechers = obj.optString("leechers", "0").toIntOrNull() ?: 0

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
                    magnet = buildMagnetUri(infoHash, name)
                )
            )
        }

        results.sortedByDescending { it.seeds }
    }
}
