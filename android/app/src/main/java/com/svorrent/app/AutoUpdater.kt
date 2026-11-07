package com.svorrent.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale

data class UpdateState(
    val status: String = "idle", // idle, checking, up-to-date, available, downloading, ready, error
    val currentVersion: String = BuildConfig.VERSION_NAME,
    val currentSha: String = BuildConfig.GIT_SHA,
    val latestSha: String = BuildConfig.GIT_SHA,
    val latestMessage: String = "Up to date · v${BuildConfig.VERSION_NAME} (${BuildConfig.GIT_SHA})",
    val downloadProgress: Int = 0,
    val apkDownloadUrl: String? = null,
    val browserReleaseApkUrl: String = AutoUpdater.PUBLIC_LATEST_APK_URL
)

object AutoUpdater {
    const val PUBLIC_LATEST_APK_URL = "https://github.com/sovopr/svorrent/releases/latest/download/Svorrent.apk"
    const val MAIN_LATEST_APK_URL = "https://github.com/sovopr/svorrent/releases/download/main-latest/Svorrent.apk"
    const val MAIN_BUILD_MANIFEST_URL = "https://github.com/sovopr/svorrent/releases/download/main-latest/main-build.json"
    private val TAG_REDIRECT_REGEX = Regex("""/releases/tag/[vV]?([0-9]+\.[0-9]+\.[0-9]+[^\s/?#]*)""")

    private val _state = MutableStateFlow(UpdateState())
    val state: StateFlow<UpdateState> = _state.asStateFlow()

    @Volatile
    private var lastCheckedAtMs: Long = 0L

    @Volatile
    private var isChecking: Boolean = false

    fun getDownloadedApkFile(context: Context): File {
        val dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: context.cacheDir
        return File(dir, "Svorrent-update.apk")
    }

    fun isDownloadedApkReady(context: Context): Boolean =
        getDownloadedApkFile(context).let { it.exists() && it.length() > 0 }

    fun extractReleaseTagFromLocation(location: String?): String {
        if (location.isNullOrBlank()) return ""
        val match = TAG_REDIRECT_REGEX.find(location.trim()) ?: return ""
        return match.groupValues[1].trim()
    }

    fun isNewerSemver(currentVer: String, candidateVer: String): Boolean {
        fun parse(v: String): List<Int> =
            v.trim().removePrefix("v").removePrefix("V")
                .split(".")
                .map { it.takeWhile { ch -> ch.isDigit() }.toIntOrNull() ?: 0 }
                .let { parts -> List(3) { idx -> parts.getOrElse(idx) { 0 } } }
        val c = parse(currentVer)
        val l = parse(candidateVer)
        for (i in 0..2) {
            if (l[i] > c[i]) return true
            if (l[i] < c[i]) return false
        }
        return false
    }

    fun isMainBuildNewer(
        currentVersion: String,
        currentVersionCode: Int,
        currentSha: String,
        remoteVersion: String,
        remoteVersionCode: Int,
        remoteShortSha: String
    ): Boolean {
        val cleanRemoteSha = remoteShortSha.trim().take(7)
        val cleanCurrentSha = currentSha.trim().take(7)
        if (cleanRemoteSha.isNotEmpty() &&
            cleanCurrentSha.isNotEmpty() &&
            !cleanCurrentSha.equals("local", ignoreCase = true) &&
            cleanRemoteSha.equals(cleanCurrentSha, ignoreCase = true)
        ) {
            return false
        }
        if (remoteVersionCode > 0 && currentVersionCode > 0 && remoteVersionCode < currentVersionCode) {
            return false
        }
        if (remoteVersion.isNotBlank() && isNewerSemver(currentVersion, remoteVersion)) {
            return true
        }
        if (cleanRemoteSha.isNotEmpty() &&
            cleanCurrentSha.isNotEmpty() &&
            !cleanCurrentSha.equals("local", ignoreCase = true) &&
            remoteVersionCode > currentVersionCode
        ) {
            return true
        }
        return false
    }

    private fun fetchTextFollowingRedirects(initialUrl: String): String {
        var currentUrl = initialUrl
        var hops = 0
        while (hops < 6) {
            val conn = (URL(currentUrl).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                instanceFollowRedirects = false
                setRequestProperty("User-Agent", "Svorrent/${BuildConfig.VERSION_NAME} (Android)")
                setRequestProperty("Cache-Control", "no-cache")
                connectTimeout = 4000
                readTimeout = 4000
            }
            val code = conn.responseCode
            if (code in 300..399) {
                val location = conn.getHeaderField("Location")
                conn.disconnect()
                if (location.isNullOrBlank()) {
                    throw IllegalStateException("Redirect missing Location ($code)")
                }
                currentUrl = if (location.startsWith("http://") || location.startsWith("https://")) {
                    location
                } else {
                    URL(URL(currentUrl), location).toString()
                }
                hops++
                continue
            }
            if (code !in 200..299) {
                conn.disconnect()
                throw IllegalStateException("HTTP $code from $currentUrl")
            }
            return try {
                conn.inputStream.bufferedReader().use { it.readText() }
            } finally {
                conn.disconnect()
            }
        }
        throw IllegalStateException("Too many redirects")
    }

    suspend fun checkForUpdatesIfStale(minIntervalMs: Long = 45_000L): UpdateState {
        val current = _state.value
        if (isChecking || current.status in listOf("available", "downloading", "ready")) {
            return current
        }
        val now = System.currentTimeMillis()
        if (current.status == "up-to-date" && lastCheckedAtMs > 0L && (now - lastCheckedAtMs) < minIntervalMs) {
            return current
        }
        return checkForUpdates(silent = true)
    }

    suspend fun checkForUpdates(silent: Boolean = false): UpdateState = withContext(Dispatchers.IO) {
        if (isChecking) return@withContext _state.value
        val existingStatus = _state.value.status
        if (existingStatus in listOf("downloading", "ready")) {
            return@withContext _state.value
        }

        isChecking = true
        if (!silent) {
            _state.value = _state.value.copy(
                status = "checking",
                latestMessage = "Checking repository for updates…"
            )
        }

        var checkedOk = false
        var fallbackLatestApkUrl: String? = _state.value.apkDownloadUrl
        try {
            // 1. Check rolling main-branch build manifest (updates on any Android commit merged to main, no version bump needed)
            runCatching {
                val cacheBuster = System.currentTimeMillis() / 20_000L
                val rawManifest = fetchTextFollowingRedirects("$MAIN_BUILD_MANIFEST_URL?t=$cacheBuster")
                val manifest = JSONObject(rawManifest)
                val remoteVersion = manifest.optString("version", "").removePrefix("v").removePrefix("V")
                val remoteShortSha = manifest.optString("shortSha", "").ifEmpty {
                    manifest.optString("sha", "").take(7)
                }
                val remoteVersionCode = manifest.optInt("versionCode", 0)
                val commitMsg = manifest.optString("message", "").trim()
                val remoteApkUrl = manifest.optString("apkUrl", "").ifEmpty { MAIN_LATEST_APK_URL }

                if (remoteShortSha.isNotEmpty()) {
                    checkedOk = true
                    fallbackLatestApkUrl = remoteApkUrl
                    if (isMainBuildNewer(
                            currentVersion = BuildConfig.VERSION_NAME,
                            currentVersionCode = BuildConfig.VERSION_CODE,
                            currentSha = BuildConfig.GIT_SHA,
                            remoteVersion = remoteVersion,
                            remoteVersionCode = remoteVersionCode,
                            remoteShortSha = remoteShortSha
                        )
                    ) {
                        lastCheckedAtMs = System.currentTimeMillis()
                        val displayMsg = if (commitMsg.isNotEmpty()) {
                            "New commit $remoteShortSha on main: $commitMsg"
                        } else {
                            "New build available from main ($remoteShortSha)"
                        }
                        val nextState = UpdateState(
                            status = "available",
                            currentVersion = BuildConfig.VERSION_NAME,
                            currentSha = BuildConfig.GIT_SHA,
                            latestSha = remoteShortSha,
                            latestMessage = displayMsg,
                            apkDownloadUrl = remoteApkUrl,
                            browserReleaseApkUrl = remoteApkUrl
                        )
                        _state.value = nextState
                        return@withContext nextState
                    }
                }
            }

            var apkUrl: String? = null
            var releaseTag = ""
            var releaseBody = ""

            // 2. Fast CDN 302 redirect check for tagged semver releases (immune to api.github.com 60/hr CGNAT IP rate limits)
            runCatching {
                val latestConn = (URL("https://github.com/sovopr/svorrent/releases/latest").openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    instanceFollowRedirects = false
                    setRequestProperty("User-Agent", "Svorrent/${BuildConfig.VERSION_NAME} (Android)")
                    connectTimeout = 4000
                    readTimeout = 4000
                }
                val code = latestConn.responseCode
                val location = latestConn.getHeaderField("Location")
                latestConn.disconnect()

                if (code in 300..399) {
                    val tag = extractReleaseTagFromLocation(location)
                    if (tag.isNotEmpty()) {
                        if (!isNewerSemver(BuildConfig.VERSION_NAME, tag)) {
                            checkedOk = true
                        } else {
                            val rawTagSegment = location?.substringAfter("/releases/tag/", "")
                                ?.substringBefore("?")?.substringBefore("#")?.trim()
                                .takeUnless { it.isNullOrEmpty() } ?: "v$tag"
                            val candidateApk = "https://github.com/sovopr/svorrent/releases/download/$rawTagSegment/Svorrent.apk"
                            val assetConn = (URL(candidateApk).openConnection() as HttpURLConnection).apply {
                                requestMethod = "GET"
                                instanceFollowRedirects = false
                                setRequestProperty("User-Agent", "Svorrent/${BuildConfig.VERSION_NAME} (Android)")
                                connectTimeout = 4000
                                readTimeout = 4000
                            }
                            val assetCode = assetConn.responseCode
                            assetConn.disconnect()
                            if (assetCode in 200..399) {
                                releaseTag = tag
                                releaseBody = "v$tag"
                                apkUrl = candidateApk
                                checkedOk = true
                            }
                        }
                    }
                }
            }

            // 3. Fallback to GitHub REST API (with DoH resilience if carrier DNS interferes)
            if (!checkedOk) {
                runCatching {
                    val rawJson = SearchRepository.fetchUrlWithDoHFallback(
                        "https://api.github.com/repos/sovopr/svorrent/releases/latest",
                        mapOf("Accept" to "application/vnd.github+json")
                    )
                    val relJson = JSONObject(rawJson)
                    releaseTag = relJson.optString("tag_name", "").removePrefix("v").removePrefix("V")
                    releaseBody = relJson.optString("name", "").ifEmpty { "v$releaseTag" }
                    val assets = relJson.optJSONArray("assets")
                    if (assets != null) {
                        for (i in 0 until assets.length()) {
                            val asset = assets.getJSONObject(i)
                            val name = asset.optString("name", "")
                            if (name.endsWith(".apk", ignoreCase = true)) {
                                apkUrl = asset.optString("browser_download_url", null)
                                break
                            }
                        }
                    }
                    if (releaseTag.isNotEmpty()) {
                        checkedOk = true
                    }
                }
            }

            if (checkedOk) {
                lastCheckedAtMs = System.currentTimeMillis()
            }

            if (apkUrl != null && releaseTag.isNotEmpty() && isNewerSemver(BuildConfig.VERSION_NAME, releaseTag)) {
                val nextState = UpdateState(
                    status = "available",
                    currentVersion = BuildConfig.VERSION_NAME,
                    currentSha = BuildConfig.GIT_SHA,
                    latestSha = releaseTag,
                    latestMessage = "New release v$releaseTag available ($releaseBody)",
                    apkDownloadUrl = apkUrl,
                    browserReleaseApkUrl = apkUrl ?: PUBLIC_LATEST_APK_URL
                )
                _state.value = nextState
                return@withContext nextState
            }
        } catch (_: Throwable) {
        } finally {
            isChecking = false
        }

        if (!checkedOk) {
            if (!silent) {
                val errState = _state.value.copy(
                    status = "error",
                    latestMessage = "Could not reach GitHub. Check internet connection."
                )
                _state.value = errState
                return@withContext errState
            }
            return@withContext _state.value
        }

        val readyState = _state.value.copy(
            status = "up-to-date",
            latestMessage = "Up to date · v${BuildConfig.VERSION_NAME} (${BuildConfig.GIT_SHA})",
            apkDownloadUrl = fallbackLatestApkUrl
        )
        _state.value = readyState
        readyState
    }

    fun openPrivateReleaseApkDownload(context: Context) {
        try {
            val targetUrl = _state.value.apkDownloadUrl ?: PUBLIC_LATEST_APK_URL
            val intent = Intent(
                Intent.ACTION_VIEW,
                Uri.parse(targetUrl)
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
        } catch (_: Throwable) {
        }
    }

    suspend fun downloadAndInstallApk(context: Context, url: String) = withContext(Dispatchers.IO) {
        try {
            _state.value = _state.value.copy(
                status = "downloading",
                downloadProgress = 0,
                latestMessage = "Connecting to download server…"
            )

            // Follow HTTP redirects explicitly across domains/protocols
            var currentUrl = url
            var hops = 0
            var finalConnection: HttpURLConnection? = null

            while (hops < 6) {
                val conn = (URL(currentUrl).openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    instanceFollowRedirects = false
                    setRequestProperty("User-Agent", "Svorrent/${BuildConfig.VERSION_NAME} (Android)")
                    setRequestProperty("Accept", "application/vnd.android.package-archive,*/*")
                    connectTimeout = 20000
                    readTimeout = 60000
                }

                val code = conn.responseCode
                if (code in 300..399) {
                    val location = conn.getHeaderField("Location")
                    conn.disconnect()
                    if (location.isNullOrEmpty()) {
                        throw IllegalStateException("HTTP redirect without Location header ($code)")
                    }
                    currentUrl = if (location.startsWith("http://") || location.startsWith("https://")) {
                        location
                    } else {
                        URL(URL(currentUrl), location).toString()
                    }
                    hops++
                    continue
                }

                if (code !in 200..299) {
                    conn.disconnect()
                    _state.value = _state.value.copy(status = "error", latestMessage = "Download failed (HTTP $code)")
                    return@withContext
                }

                finalConnection = conn
                break
            }

            val conn = finalConnection ?: run {
                _state.value = _state.value.copy(status = "error", latestMessage = "Too many redirects")
                return@withContext
            }

            val totalBytes = conn.contentLengthLong
            val totalBytesKnown = totalBytes > 0
            val outFile = getDownloadedApkFile(context)
            if (outFile.exists()) outFile.delete()

            val buffer = ByteArray(64 * 1024)
            var downloaded = 0L
            var lastUpdateMs = 0L
            var lastReportedPct = -1

            conn.inputStream.use { input ->
                FileOutputStream(outFile).use { output ->
                    var read: Int
                    while (input.read(buffer).also { read = it } != -1) {
                        output.write(buffer, 0, read)
                        downloaded += read

                        val now = System.currentTimeMillis()
                        val pct = if (totalBytesKnown) {
                            ((downloaded * 100L) / totalBytes).toInt().coerceIn(0, 100)
                        } else {
                            0
                        }

                        if (pct != lastReportedPct || now - lastUpdateMs > 150L) {
                            lastReportedPct = pct
                            lastUpdateMs = now
                            val downloadedMb = String.format(Locale.US, "%.1f", downloaded / (1024.0 * 1024.0))
                            val progressText = if (totalBytesKnown) {
                                val totalMb = String.format(Locale.US, "%.1f", totalBytes / (1024.0 * 1024.0))
                                "Downloading update… $downloadedMb / $totalMb MB ($pct%)"
                            } else {
                                "Downloading update… $downloadedMb MB"
                            }
                            _state.value = _state.value.copy(
                                status = "downloading",
                                downloadProgress = pct,
                                latestMessage = progressText
                            )
                        }
                    }
                    output.flush()
                }
            }

            outFile.setReadable(true, false)

            _state.value = _state.value.copy(
                status = "ready",
                downloadProgress = 100,
                latestMessage = "Update downloaded. Ready to install."
            )
            withContext(Dispatchers.Main) {
                triggerApkInstall(context, outFile)
            }
        } catch (e: Throwable) {
            _state.value = _state.value.copy(status = "error", latestMessage = "Update failed: ${e.message}")
        }
    }

    fun installDownloadedApk(context: Context) {
        val outFile = getDownloadedApkFile(context)
        if (outFile.exists() && outFile.length() > 0) {
            triggerApkInstall(context, outFile)
        }
    }

    fun triggerApkInstall(context: Context, apkFile: File) {
        if (!apkFile.exists() || apkFile.length() == 0L) {
            _state.value = _state.value.copy(status = "error", latestMessage = "APK file missing or incomplete")
            return
        }
        apkFile.setReadable(true, false)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
            _state.value = _state.value.copy(
                status = "ready",
                latestMessage = "Allow Svorrent to install apps in Settings, then tap Install Update"
            )
            val permIntent = Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:${context.packageName}")
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(permIntent)
            return
        }

        try {
            val apkUri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", apkFile)
            val installIntent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(apkUri, "application/vnd.android.package-archive")
                addFlags(
                    Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP
                )
            }
            context.startActivity(installIntent)
        } catch (e: Throwable) {
            _state.value = _state.value.copy(status = "error", latestMessage = "Install failed: ${e.message}")
        }
    }
}
