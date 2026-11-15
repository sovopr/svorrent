package com.svorrent.app

import java.io.File

/**
 * Snapshot of a torrent's known file layout and prior on-disk state for reconciliation.
 */
data class TrackedDiskRecord(
    val infoHash: String,
    val name: String,
    val savePath: String = "",
    val relativePaths: List<String> = emptyList(),
    val hadFilesOnDisk: Boolean = false,
    val done: Boolean = false
)

data class DiskCheckResult(
    val baseDir: File?,
    val basePresent: Boolean,
    val anyPresent: Boolean,
    val targetFiles: List<File>
)

/**
 * Pure JVM-testable disk reconciliation helper mirroring desktop backend/lib/reconcile.js.
 * Detects when a download's files were manually deleted from storage without touching unmounted
 * storage or unstarted magnet transfers before pieces hit disk.
 */
object ReconcileHelper {
    private val FALLBACK_PLACEHOLDER_RE = Regex("""^(Magnet|Torrent)-[a-fA-F0-9]{6,}$""")

    fun resolveWithinBase(baseDir: File, relPath: String?): File? {
        if (relPath.isNullOrBlank()) return null
        return try {
            val baseCanonical = baseDir.canonicalFile
            val candidate = File(baseCanonical, relPath.trim()).canonicalFile
            val basePrefix = baseCanonical.path.trimEnd(File.separatorChar) + File.separatorChar
            if (candidate.path == baseCanonical.path || candidate.path.startsWith(basePrefix)) {
                candidate
            } else {
                null
            }
        } catch (_: Throwable) {
            null
        }
    }

    fun getDiskTargets(record: TrackedDiskRecord, defaultDownloadDir: File): Pair<File?, List<File>> {
        val baseDir = record.savePath.takeIf { it.isNotBlank() }?.let { File(it) } ?: defaultDownloadDir
        val targets = LinkedHashSet<File>()

        for (rel in record.relativePaths) {
            val resolved = resolveWithinBase(baseDir, rel)
            if (resolved != null && resolved != baseDir) {
                targets.add(resolved)
            }
        }

        if (targets.isEmpty() && record.name.isNotBlank() && !FALLBACK_PLACEHOLDER_RE.matches(record.name.trim())) {
            val fallback = resolveWithinBase(baseDir, record.name)
            if (fallback != null && fallback != baseDir) {
                targets.add(fallback)
            }
        }

        return baseDir to targets.toList()
    }

    fun checkFilesOnDisk(record: TrackedDiskRecord, defaultDownloadDir: File): DiskCheckResult {
        val (baseDir, targetFiles) = getDiskTargets(record, defaultDownloadDir)
        if (baseDir == null) {
            return DiskCheckResult(null, basePresent = false, anyPresent = false, targetFiles = emptyList())
        }

        val basePresent = runCatching { baseDir.exists() && baseDir.isDirectory }.getOrDefault(false)
        if (!basePresent || targetFiles.isEmpty()) {
            return DiskCheckResult(baseDir, basePresent = basePresent, anyPresent = false, targetFiles = targetFiles)
        }

        val anyPresent = targetFiles.any { file ->
            runCatching { file.exists() }.getOrDefault(false)
        }
        return DiskCheckResult(baseDir, basePresent = true, anyPresent = anyPresent, targetFiles = targetFiles)
    }

    fun shouldRemoveTorrentForMissingFiles(record: TrackedDiskRecord, defaultDownloadDir: File): Boolean {
        val check = checkFilesOnDisk(record, defaultDownloadDir)
        if (check.anyPresent) return false
        if (!check.basePresent || check.targetFiles.isEmpty()) return false
        return record.hadFilesOnDisk || record.done
    }

    fun deleteLeftoverPaths(record: TrackedDiskRecord, defaultDownloadDir: File) {
        val (baseDir, targetFiles) = getDiskTargets(record, defaultDownloadDir)
        if (baseDir == null) return
        for (target in targetFiles) {
            runCatching {
                if (target.exists()) {
                    target.deleteRecursively()
                }
            }
            // Remove empty parent subfolder inside downloadDir left behind after manual/in-app deletion
            var parent = target.parentFile
            while (parent != null && parent != baseDir) {
                val listed = parent.list()
                if (listed != null && listed.isEmpty()) {
                    parent.delete()
                    parent = parent.parentFile
                } else {
                    break
                }
            }
        }
    }
}
