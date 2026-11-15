package com.svorrent.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class SvorrentFeaturesTest {

    @Test
    fun testSearchFilterHelperQualityTagsSourceAndCounts() {
        val sample = listOf(
            SearchResultItem(
                id = "1",
                title = "Dune Part Two 2024 2160p BluRay Remux HEVC DV HDR10",
                sizeBytes = 60L * 1024L * 1024L * 1024L,
                sizeFormatted = "60.0 GB",
                seeds = 120,
                leechers = 15,
                provider = "extto.org",
                infoHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                magnet = "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            ),
            SearchResultItem(
                id = "2",
                title = "Dune Part Two 2024 1080p WEB-DL x265 HEVC",
                sizeBytes = 4L * 1024L * 1024L * 1024L,
                sizeFormatted = "4.0 GB",
                seeds = 350,
                leechers = 40,
                provider = "ThePirateBay",
                infoHash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                magnet = "magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            ),
            SearchResultItem(
                id = "3",
                title = "Dune Part Two 2024 720p WEBRip x264",
                sizeBytes = 1500L * 1024L * 1024L,
                sizeFormatted = "1.5 GB",
                seeds = 80,
                leechers = 10,
                provider = "1337x",
                infoHash = "cccccccccccccccccccccccccccccccccccccccc",
                magnet = "magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc"
            )
        )

        val counts = SearchFilterHelper.getFilterCounts(sample)
        assertEquals(3, counts.qualityCounts["all"])
        assertEquals(1, counts.qualityCounts["4k"])
        assertEquals(1, counts.qualityCounts["1080p"])
        assertEquals(1, counts.qualityCounts["720p"])
        assertTrue(counts.availableQualities["4k"] == true)
        assertTrue(counts.availableQualities["1080p"] == true)
        assertFalse(counts.availableQualities["sd"] == true)
        assertEquals(2, counts.tagCounts["hevc"])
        assertEquals(1, counts.tagCounts["remux"])

        val filtered = SearchFilterHelper.filterResults(
            results = sample,
            source = "all",
            quality = "4k",
            tags = setOf("remux", "hdr", "dv", "hevc")
        )
        assertEquals(1, filtered.size)
        assertEquals("1", filtered[0].id)

        val sourceOnly = SearchFilterHelper.filterResults(sample, source = "ThePirateBay")
        assertEquals(1, sourceOnly.size)
        assertEquals("2", sourceOnly[0].id)

        assertEquals(
            "Dune Part Two 2024",
            SearchFilterHelper.cleanReleaseSearchQuery("[Group] Dune.Part.Two.2024.2160p.WEB-DL.x265-GRP")
        )
    }

    @Test
    fun testDownloadHistoryStorePersistenceAndMatching() {
        val tmpDir = Files.createTempDirectory("svorrent_hist_test").toFile()
        try {
            val historyFile = File(tmpDir, "download-history.json")
            val store = DownloadHistoryStore(historyFile)
            val hash = "0123456789abcdef0123456789abcdef01234567"
            val title = "Interstellar.2014.1080p.BluRay.x264"
            val sizeBytes = 2_000L * 1024L * 1024L

            assertTrue(store.record(hash, title, "magnet:?xt=urn:btih:$hash", sizeBytes, nowMs = 1700000000000L))
            assertTrue(historyFile.exists())
            assertTrue(store.has(infoHash = hash.uppercase()))
            assertTrue(store.has(title = "Interstellar 2014 1080p BluRay x264", sizeBytes = sizeBytes))
            assertFalse(store.has(title = "Interstellar 2014 1080p BluRay x264", sizeBytes = 900L * 1024L * 1024L))

            // Reload from persisted JSON file into a fresh store instance
            val reloaded = DownloadHistoryStore(historyFile)
            assertTrue(reloaded.has(infoHash = hash))
            val entry = reloaded.get(hash)
            assertNotNull(entry)
            assertEquals(title, entry?.name)
            assertEquals(1, reloaded.getAll().size)

            assertTrue(reloaded.delete(hash))
            assertFalse(reloaded.has(infoHash = hash))
        } finally {
            tmpDir.deleteRecursively()
        }
    }

    @Test
    fun testDiscoverParsersAndPosterAllowlist() {
        assertTrue(DiscoverRepository.isAllowedPosterUrl("https://is1-ssl.mzstatic.com/image/thumb/a/240x360bb.webp"))
        assertTrue(DiscoverRepository.isAllowedPosterUrl("https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/1.jpg"))
        assertTrue(DiscoverRepository.isAllowedPosterUrl("https://m.media-amazon.com/images/M/test._V1_UX240_.jpg"))
        assertFalse(DiscoverRepository.isAllowedPosterUrl("http://m.media-amazon.com/images/M/insecure.jpg"))
        assertFalse(DiscoverRepository.isAllowedPosterUrl("https://user:pass@mzstatic.com/a.webp"))
        assertFalse(DiscoverRepository.isAllowedPosterUrl("https://169.254.169.254/latest/meta-data/"))

        val exttoHtml = """
            <table><tbody>
              <tr>
                <td><a href="/post-detail/abc123/Dune-2024/">Dune.Part.Two.2024.1080p.WEB-DL</a> <a href="/imdb-detail/tt15239678/">IMDb</a></td>
                <td><span class="add-block">Size</span><span>4.2 GB</span></td>
                <td class="nowrap-td hide-on-mob"><div class="add-block-wrapper"><span>5 hours ago</span></div></td>
                <td><span class="text-success">1,250</span><span class="text-danger">310</span></td>
              </tr>
              <tr>
                <td><a href="/post-detail/bad/${'$'}{template}/">${'$'}{title}</a></td>
              </tr>
            </tbody></table>
        """.trimIndent()
        val exttoRows = DiscoverRepository.parseExttoTrendingHtml(exttoHtml)
        assertEquals(1, exttoRows.size)
        assertEquals("Dune.Part.Two.2024.1080p.WEB-DL", exttoRows[0].title)
        assertEquals("5 hours ago", exttoRows[0].age)
        assertEquals(1250, exttoRows[0].seeds)
        assertEquals(310, exttoRows[0].leechers)
        assertEquals("tt15239678", exttoRows[0].imdbId)

        val appleJson = """
            {
              "feed": {
                "entry": [
                  {
                    "id": { "attributes": { "im:id": "999" } },
                    "im:name": { "label": "Arrival (2016)" },
                    "im:releaseDate": { "label": "2016-11-11T00:00:00-08:00" },
                    "category": { "attributes": { "label": "Sci-Fi" } },
                    "summary": { "label": "First contact linguistics thriller." },
                    "im:image": [{ "label": "https://is1-ssl.mzstatic.com/image/thumb/100x100bb.png" }]
                  }
                ]
              }
            }
        """.trimIndent()
        val appleCards = DiscoverRepository.parseAppleSpotlightFeed(appleJson, "movies")
        assertEquals(1, appleCards.size)
        assertEquals("Arrival 2016", appleCards[0].searchQuery)
        assertTrue(appleCards[0].poster.endsWith("/240x360bb.webp"))

        val aniJson = """
            {
              "data": {
                "Page": {
                  "media": [
                    { "id": 1, "isAdult": true, "title": { "english": "Skipped Adult" }, "coverImage": { "large": "https://s4.anilist.co/a.jpg" } },
                    { "id": 2, "isAdult": false, "seasonYear": 2025, "genres": ["Action", "Fantasy"], "title": { "english": "Solo Leveling: Season 2" }, "coverImage": { "large": "https://s4.anilist.co/b.jpg" } }
                  ]
                }
              }
            }
        """.trimIndent()
        val aniCards = DiscoverRepository.parseAniListSpotlight(aniJson)
        assertEquals(1, aniCards.size)
        assertEquals("Solo Leveling", aniCards[0].searchQuery)
    }

    @Test
    fun testMultiSourceRankingAndKnabenParsing() {
        val hashA = "1111111111111111111111111111111111111111"
        val knabenJson = """
            {
              "hits": [
                {
                  "id": "k1",
                  "trackerId": "1337x",
                  "category": "Movies HD",
                  "title": "Sinners.2025.1080p.WEB-DL.DDP5.1.H264",
                  "bytes": 3221225472,
                  "liveSeeders": 920,
                  "livePeers": 140,
                  "hash": "$hashA",
                  "date": "2025-05-01T12:00:00Z"
                }
              ]
            }
        """.trimIndent()
        val knabenItems = SearchRepository.parseKnabenHits(knabenJson)
        assertEquals(1, knabenItems.size)
        assertEquals("1337x", knabenItems[0].provider)
        assertEquals(hashA, knabenItems[0].infoHash)
        assertEquals(920, knabenItems[0].seeds)
        assertTrue(knabenItems[0].age.isNotEmpty())

        val nsfwItem = knabenItems[0].copy(id = "nsfw", title = "Bad NSFW Playboy XXX Release 1080p", infoHash = "2222222222222222222222222222222222222222")
        val camItem = knabenItems[0].copy(id = "cam", title = "Sinners 2025 1080p HDCAM Line Audio", infoHash = "3333333333333333333333333333333333333333", seeds = 950)
        val ranked = DiscoverRepository.rankMultiSourceTrending(
            batches = listOf(
                "extto" to listOf(knabenItems[0].copy(magnet = "", infoHash = "", provider = "extto.org")),
                "knaben" to listOf(knabenItems[0], nsfwItem, camItem)
            ),
            catKey = "movies",
            winKey = "7D"
        )
        assertFalse(ranked.any { it.id == "nsfw" })
        // Verified WEB-DL merges magnet from Knaben with extto editorial boost and outranks HDCAM
        assertEquals(hashA, ranked.first().infoHash)
        assertTrue(ranked.first().magnet.startsWith("magnet:?xt=urn:btih:"))
    }

    @Test
    fun testReconcileHelperManualDeletionAndGuards() {
        val baseDir = Files.createTempDirectory("svorrent_reconcile_test").toFile()
        try {
            val movieDir = File(baseDir, "Oppenheimer.2023.1080p")
            movieDir.mkdirs()
            val movieFile = File(movieDir, "Oppenheimer.mkv")
            movieFile.writeText("video-bytes")

            val presentRecord = TrackedDiskRecord(
                infoHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                name = "Oppenheimer.2023.1080p",
                savePath = baseDir.absolutePath,
                relativePaths = listOf("Oppenheimer.2023.1080p/Oppenheimer.mkv"),
                hadFilesOnDisk = true,
                done = true
            )
            assertFalse(ReconcileHelper.shouldRemoveTorrentForMissingFiles(presentRecord, baseDir))

            // Manually delete the video file from disk -> should trigger removal cleanly
            assertTrue(movieFile.delete())
            assertTrue(ReconcileHelper.shouldRemoveTorrentForMissingFiles(presentRecord, baseDir))

            // Unstarted magnet (never had files on disk and not done) -> never falsely remove
            val unstartedRecord = presentRecord.copy(hadFilesOnDisk = false, done = false)
            assertFalse(ReconcileHelper.shouldRemoveTorrentForMissingFiles(unstartedRecord, baseDir))

            // Unmounted base folder -> protect external storage downloads
            val unmountedDir = File(baseDir, "nonexistent_sd_mount")
            val unmountedRecord = presentRecord.copy(savePath = unmountedDir.absolutePath)
            assertFalse(ReconcileHelper.shouldRemoveTorrentForMissingFiles(unmountedRecord, baseDir))

            // Path traversal blocked
            assertNull(ReconcileHelper.resolveWithinBase(baseDir, "../../etc/passwd"))

            // Leftover empty directory cleanup keeps baseDir intact
            ReconcileHelper.deleteLeftoverPaths(presentRecord, baseDir)
            assertFalse(movieDir.exists())
            assertTrue(baseDir.exists())
        } finally {
            baseDir.deleteRecursively()
        }
    }
}
