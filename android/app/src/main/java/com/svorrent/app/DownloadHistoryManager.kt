package com.svorrent.app

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Locale

/**
 * Pure JVM-testable persistent index of previously completed downloads.
 * Matches desktop DownloadHistory by infoHash as well as normalized title + MiB size.
 */
class DownloadHistoryStore(private val storageFile: File? = null) {
    private val lock = Any()
    private val records = LinkedHashMap<String, DownloadHistoryEntry>()
    private val titleKeys = HashMap<String, String>()
    private val nonAlnumRegex = Regex("""[^a-z0-9]+""")

    init {
        load()
    }

    fun load() {
        val file = storageFile ?: return
        synchronized(lock) {
            try {
                if (!file.exists()) return
                val raw = file.readText(Charsets.UTF_8)
                val arr = JSONArray(raw)
                records.clear()
                titleKeys.clear()
                for (i in 0 until arr.length()) {
                    val obj = arr.optJSONObject(i) ?: continue
                    val rawHash = obj.optString("infoHash", "").trim().lowercase(Locale.US)
                    if (!isHex40(rawHash)) continue
                    val name = obj.optString("name", "Unknown").ifBlank { "Unknown" }
                    val length = obj.optLong("length", 0L).coerceAtLeast(0L)
                    val completedAt = obj.optLong("completedAt", System.currentTimeMillis())
                    val lastSeenAt = obj.optLong("lastSeenAt", completedAt)
                    val magnetUri = obj.optString("magnetURI", obj.optString("magnetUri", ""))
                    records[rawHash] = DownloadHistoryEntry(
                        infoHash = rawHash,
                        name = name,
                        magnetUri = magnetUri,
                        length = length,
                        completedAt = completedAt,
                        lastSeenAt = lastSeenAt
                    )
                    indexTitleLocked(name, length, rawHash)
                }
            } catch (_: Throwable) {
            }
        }
    }

    fun save() {
        val file = storageFile ?: return
        val snapshot: String
        synchronized(lock) {
            val arr = JSONArray()
            for (entry in records.values) {
                arr.put(
                    JSONObject().apply {
                        put("infoHash", entry.infoHash)
                        put("name", entry.name)
                        put("magnetURI", entry.magnetUri)
                        put("length", entry.length)
                        put("completedAt", entry.completedAt)
                        put("lastSeenAt", entry.lastSeenAt)
                    }
                )
            }
            snapshot = arr.toString(2)
        }
        try {
            file.parentFile?.mkdirs()
            val tmpFile = File(file.parentFile, "${file.name}.${System.nanoTime()}.tmp")
            tmpFile.writeText(snapshot, Charsets.UTF_8)
            if (!tmpFile.renameTo(file)) {
                file.writeText(snapshot, Charsets.UTF_8)
                tmpFile.delete()
            }
        } catch (_: Throwable) {
        }
    }

    fun record(
        infoHash: String,
        name: String,
        magnetUri: String = "",
        length: Long = 0L,
        nowMs: Long = System.currentTimeMillis()
    ): Boolean {
        val cleanHash = infoHash.trim().lowercase(Locale.US)
        if (!isHex40(cleanHash)) return false
        synchronized(lock) {
            val existing = records[cleanHash]
            val finalName = name.trim().ifEmpty { existing?.name ?: "Unknown" }
            val finalMagnet = magnetUri.trim().ifEmpty { existing?.magnetUri ?: "" }
            val finalLength = if (length > 0L) length else (existing?.length ?: 0L)
            val entry = DownloadHistoryEntry(
                infoHash = cleanHash,
                name = finalName,
                magnetUri = finalMagnet,
                length = finalLength,
                completedAt = existing?.completedAt ?: nowMs,
                lastSeenAt = nowMs
            )
            records[cleanHash] = entry
            indexTitleLocked(finalName, finalLength, cleanHash)
        }
        save()
        return true
    }

    fun has(infoHash: String? = null, title: String? = null, sizeBytes: Long = 0L): Boolean {
        synchronized(lock) {
            if (!infoHash.isNullOrBlank()) {
                val cleanHash = infoHash.trim().lowercase(Locale.US)
                if (records.containsKey(cleanHash)) return true
            }
            if (!title.isNullOrBlank()) {
                val sizeMb = if (sizeBytes > 0L) Math.round(sizeBytes / (1024.0 * 1024.0)) else 0L
                val norm = SearchRepository.normalizeTitleForDedup(title)
                val rawNorm = title.lowercase(Locale.US).replace(nonAlnumRegex, " ").trim()
                for (key in listOf(norm, rawNorm)) {
                    if (key.isEmpty()) continue
                    if (sizeMb > 0L && titleKeys.containsKey("$key|$sizeMb")) {
                        return true
                    }
                }
            }
            return false
        }
    }

    fun get(infoHash: String?): DownloadHistoryEntry? {
        val clean = infoHash?.trim()?.lowercase(Locale.US) ?: return null
        synchronized(lock) {
            return records[clean]
        }
    }

    fun getAll(): List<DownloadHistoryEntry> {
        synchronized(lock) {
            return records.values.sortedByDescending { it.completedAt }
        }
    }

    fun getHashes(): Set<String> {
        synchronized(lock) {
            return records.keys.toSet()
        }
    }

    fun delete(infoHash: String?): Boolean {
        val clean = infoHash?.trim()?.lowercase(Locale.US) ?: return false
        synchronized(lock) {
            records.remove(clean) ?: return false
            titleKeys.entries.removeAll { it.value == clean }
        }
        save()
        return true
    }

    private fun indexTitleLocked(title: String, sizeBytes: Long, hash: String) {
        if (title.isBlank()) return
        val sizeMb = if (sizeBytes > 0L) Math.round(sizeBytes / (1024.0 * 1024.0)) else 0L
        val norm = SearchRepository.normalizeTitleForDedup(title)
        val rawNorm = title.lowercase(Locale.US).replace(nonAlnumRegex, " ").trim()
        for (key in listOf(norm, rawNorm)) {
            if (key.isEmpty()) continue
            if (sizeMb > 0L) {
                titleKeys["$key|$sizeMb"] = hash
            }
            if (!titleKeys.containsKey(key)) {
                titleKeys[key] = hash
            }
        }
    }

    private fun isHex40(hash: String): Boolean {
        return hash.length == 40 && hash.all { it in '0'..'9' || it in 'a'..'f' }
    }
}

object DownloadHistoryManager {
    private var store: DownloadHistoryStore = DownloadHistoryStore(null)
    private val _completedHashes = MutableStateFlow<Set<String>>(emptySet())
    val completedHashes: StateFlow<Set<String>> = _completedHashes.asStateFlow()

    @Synchronized
    fun init(context: Context) {
        val file = File(context.filesDir, "download-history.json")
        store = DownloadHistoryStore(file)
        _completedHashes.value = store.getHashes()
    }

    fun recordCompleted(infoHash: String, name: String, magnetUri: String, length: Long): Boolean {
        val changed = store.record(infoHash = infoHash, name = name, magnetUri = magnetUri, length = length)
        if (changed) {
            _completedHashes.value = store.getHashes()
        }
        return changed
    }

    fun isItemDownloaded(item: SearchResultItem): Boolean {
        return store.has(infoHash = item.infoHash, title = item.title, sizeBytes = item.sizeBytes)
    }

    fun has(infoHash: String? = null, title: String? = null, sizeBytes: Long = 0L): Boolean {
        return store.has(infoHash, title, sizeBytes)
    }

    fun getAll(): List<DownloadHistoryEntry> = store.getAll()
}
