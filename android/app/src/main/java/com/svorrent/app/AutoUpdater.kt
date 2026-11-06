package com.svorrent.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
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

    private val _state = MutableStateFlow(UpdateState())
    val state: StateFlow<UpdateState> = _state.asStateFlow()

    fun getDownloadedApkFile(context: Context): File = File(context.cacheDir, "Svorrent-update.apk")

    fun isDownloadedApkReady(context: Context): Boolean =
        getDownloadedApkFile(context).let { it.exists() && it.length() > 0 }

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

    suspend fun checkForUpdates(): UpdateState = withContext(Dispatchers.IO) {
        _state.value = _state.value.copy(status = "checking", latestMessage = "Checking GitHub Releases for updates…")
        try {
            var apkUrl: String? = null
            var releaseTag = ""
            var releaseBody = ""
            runCatching {
                val relConn = (URL("https://api.github.com/repos/sovopr/svorrent/releases/latest").openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    setRequestProperty("User-Agent", "Svorrent/${BuildConfig.VERSION_NAME} (Android)")
                    connectTimeout = 6000
                    readTimeout = 6000
                }
                if (relConn.responseCode == 200) {
                    val relJson = JSONObject(relConn.inputStream.bufferedReader().use { it.readText() })
                    releaseTag = relJson.optString("tag_name", "").removePrefix("v")
                    releaseBody = relJson.optString("name", "")
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
                }
            }

            if (apkUrl != null && releaseTag.isNotEmpty() && isNewerSemver(BuildConfig.VERSION_NAME, releaseTag)) {
                val nextState = UpdateState(
                    status = "available",
                    currentVersion = BuildConfig.VERSION_NAME,
                    currentSha = BuildConfig.GIT_SHA,
                    latestSha = releaseTag,
                    latestMessage = "New release v$releaseTag available ($releaseBody)",
                    apkDownloadUrl = apkUrl
                )
                _state.value = nextState
                return@withContext nextState
            }
        } catch (_: Throwable) {
        }

        val readyState = _state.value.copy(
            status = "up-to-date",
            latestMessage = "Up to date · v${BuildConfig.VERSION_NAME} (${BuildConfig.GIT_SHA})"
        )
        _state.value = readyState
        readyState
    }

    fun openPrivateReleaseApkDownload(context: Context) {
        try {
            val intent = Intent(
                Intent.ACTION_VIEW,
                Uri.parse(PUBLIC_LATEST_APK_URL)
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
        } catch (_: Throwable) {
        }
    }

    suspend fun downloadAndInstallApk(context: Context, url: String) = withContext(Dispatchers.IO) {
        try {
            _state.value = _state.value.copy(status = "downloading", downloadProgress = 0, latestMessage = "Downloading Svorrent.apk…")
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                instanceFollowRedirects = true
                setRequestProperty("User-Agent", "Svorrent/${BuildConfig.VERSION_NAME} (Android)")
                connectTimeout = 15000
                readTimeout = 30000
            }
            if (conn.responseCode !in 200..299) {
                _state.value = _state.value.copy(status = "error", latestMessage = "Download failed (HTTP ${conn.responseCode})")
                return@withContext
            }

            val totalBytes = conn.contentLengthLong.coerceAtLeast(1L)
            val outFile = getDownloadedApkFile(context)
            if (outFile.exists()) outFile.delete()

            conn.inputStream.use { input ->
                FileOutputStream(outFile).use { output ->
                    val buffer = ByteArray(16 * 1024)
                    var downloaded = 0L
                    var read: Int
                    while (input.read(buffer).also { read = it } != -1) {
                        output.write(buffer, 0, read)
                        downloaded += read
                        val pct = ((downloaded * 100L) / totalBytes).toInt().coerceIn(0, 100)
                        _state.value = _state.value.copy(
                            status = "downloading",
                            downloadProgress = pct,
                            latestMessage = "Downloading update… $pct%"
                        )
                    }
                    output.flush()
                }
            }

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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
            val permIntent = Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:${context.packageName}")
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(permIntent)
            return
        }

        val apkUri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", apkFile)
        val installIntent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(apkUri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(installIntent)
    }
}
