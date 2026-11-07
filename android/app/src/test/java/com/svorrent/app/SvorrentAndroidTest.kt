package com.svorrent.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SvorrentAndroidTest {

    @Test
    fun testFormattersSpeedAndBytes() {
        assertEquals("0 B", Formatters.formatBytes(0))
        assertEquals("1.0 KB", Formatters.formatBytes(1024))
        assertEquals("1.5 MB/s", Formatters.formatSpeed((1.5 * 1024 * 1024).toLong()))
        assertEquals("1m 5s", Formatters.formatEta(65))
        assertFalse(AutoUpdater.isNewerSemver("1.0.6", "1.0.4"))
        assertFalse(AutoUpdater.isNewerSemver("1.0.6", "1.0.5"))
        assertFalse(AutoUpdater.isNewerSemver("1.0.7", "1.0.5"))
        assertFalse(AutoUpdater.isNewerSemver("1.0.7", "1.0.6"))
        assertFalse(AutoUpdater.isNewerSemver("1.0.7", "1.0.7"))
        assertTrue(AutoUpdater.isNewerSemver("1.0.6", "1.0.7"))
        assertTrue(AutoUpdater.isNewerSemver("1.0.7", "1.0.8"))
        assertTrue(AutoUpdater.isNewerSemver("1.0.7", "2.0.0"))
    }

    @Test
    fun testBuildMagnetUriIncludesTrackersAndHash() {
        val hash = "0123456789abcdef0123456789abcdef01234567"
        val magnet = SearchRepository.buildMagnetUri(hash, "Batman 2026 1080p")
        assertTrue(magnet.startsWith("magnet:?xt=urn:btih:$hash"))
        assertTrue(magnet.contains("dn=Batman+2026+1080p"))
        assertTrue(magnet.contains("tr="))
        assertEquals("Batman 2026 1080p", SvorrentEngine.extractMagnetDisplayName(magnet))
    }

    @Test
    fun testExtractInfoHashVariants() {
        val hash = "0123456789abcdef0123456789abcdef01234567"
        assertEquals(hash, SearchRepository.extractInfoHash(hash))
        assertEquals(hash, SearchRepository.extractInfoHash(hash.uppercase()))
        assertEquals(hash, SearchRepository.extractInfoHash("magnet:?xt=urn:btih:$hash&dn=Test"))
        assertEquals("", SearchRepository.extractInfoHash("invalid-hash"))
        assertEquals("", SearchRepository.extractInfoHash(null))
    }

    @Test
    fun testDecodeHtmlEntities() {
        assertEquals("Tom & Jerry", SearchRepository.decodeHtmlEntities("Tom &amp; Jerry"))
        assertEquals("Rick and Morty's", SearchRepository.decodeHtmlEntities("Rick and Morty&#039;s"))
        assertEquals("Rick and Morty's", SearchRepository.decodeHtmlEntities("Rick and Morty&#39;s"))
        assertEquals("Rick and Morty's", SearchRepository.decodeHtmlEntities("Rick and Morty&#x27;s"))
        assertEquals("Dune: Part Two", SearchRepository.decodeHtmlEntities("Dune: Part Two"))
        assertEquals("x = y", SearchRepository.decodeHtmlEntities("x &#x3d; y"))
        assertEquals("<tag>", SearchRepository.decodeHtmlEntities("&lt;tag&gt;"))
    }

    @Test
    fun testStripHtmlTags() {
        assertEquals("Batman 2026", SearchRepository.stripHtmlTags("<b>Batman</b> 2026"))
        assertEquals("Movie Title", SearchRepository.stripHtmlTags("<a href=\"/link\"><span>Movie Title</span></a>"))
        assertEquals("Clean Text", SearchRepository.stripHtmlTags("Clean Text"))
    }

    @Test
    fun testSanitizeSwarmCount() {
        assertEquals(423, SearchRepository.sanitizeSwarmCount("423"))
        assertEquals(0, SearchRepository.sanitizeSwarmCount(0))
        assertEquals(0, SearchRepository.sanitizeSwarmCount("-5"))
        assertEquals(0, SearchRepository.sanitizeSwarmCount(null))
        assertEquals(0, SearchRepository.sanitizeSwarmCount("invalid"))
        // 64-bit flag overflow test: 4294967301 = 2^32 + 5 -> masks to 5
        assertEquals(5, SearchRepository.sanitizeSwarmCount(4294967301L))
        assertEquals(5, SearchRepository.sanitizeSwarmCount("4294967301"))
        // Overly huge values (> 500,000) return 0
        assertEquals(0, SearchRepository.sanitizeSwarmCount(600000))
    }

    @Test
    fun testParseFormattedSize() {
        assertEquals(1024L, SearchRepository.parseFormattedSize("1.0 KB"))
        assertEquals(1024L * 1024L, SearchRepository.parseFormattedSize("1 MB"))
        assertEquals((1.5 * 1024 * 1024 * 1024).toLong(), SearchRepository.parseFormattedSize("1.5 GB"))
        assertEquals((2.0 * 1024 * 1024 * 1024 * 1024).toLong(), SearchRepository.parseFormattedSize("2.0 TB"))
        assertEquals(0L, SearchRepository.parseFormattedSize("invalid"))
    }

    @Test
    fun testBuildSearchQueries() {
        assertEquals(listOf("remux", "remux*"), SearchRepository.buildSearchQueries("remux"))
        assertEquals(listOf("it"), SearchRepository.buildSearchQueries("it"))
        assertEquals(listOf("project hail mary", "project* hail* mary*"), SearchRepository.buildSearchQueries("project hail mary"))
        assertEquals(emptyList<String>(), SearchRepository.buildSearchQueries("   "))
    }

    @Test
    fun testNormalizeTitleForDedup() {
        assertEquals(
            "batman the enemy within the telltale series",
            SearchRepository.normalizeTitleForDedup("Batman: The Enemy Within -The Telltale Series (Episode 1-3)")
        )
        assertEquals(
            "the batman 2022 1080p bluray x264",
            SearchRepository.normalizeTitleForDedup("The.Batman.2022.1080p.BluRay.x264-[YTS]")
        )
    }

    @Test
    fun testScoreSearchResultPrioritizesMoviesOverGames() {
        val query = "the batman"
        val movie = SearchResultItem(
            id = "0123456789abcdef0123456789abcdef01234567",
            title = "The Batman (2022) [1080p] [WEBRip] [5.1] [YTS.LT]",
            sizeBytes = 2254857830L,
            sizeFormatted = "2.1 GB",
            seeds = 1400,
            leechers = 300,
            provider = "ThePirateBay",
            infoHash = "0123456789abcdef0123456789abcdef01234567",
            magnet = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"
        )
        val game = SearchResultItem(
            id = "abcdef0123456789abcdef0123456789abcdef01",
            title = "Batman: The Enemy Within -The Telltale Series (Episode 1-3)",
            sizeBytes = 8315208L,
            sizeFormatted = "7.93 MB",
            seeds = 5000,
            leechers = 3000,
            provider = "BitSearch",
            infoHash = "abcdef0123456789abcdef0123456789abcdef01",
            magnet = "magnet:?xt=urn:btih:abcdef0123456789abcdef0123456789abcdef01"
        )
        val fragment = SearchResultItem(
            id = "1111111111111111111111111111111111111111",
            title = "(Episode 1-3)",
            sizeBytes = 8315208L,
            sizeFormatted = "7.93 MB",
            seeds = 5000,
            leechers = 3000,
            provider = "BitSearch",
            infoHash = "1111111111111111111111111111111111111111",
            magnet = "magnet:?xt=urn:btih:1111111111111111111111111111111111111111"
        )

        val movieScore = SearchRepository.scoreSearchResult(movie, query)
        val gameScore = SearchRepository.scoreSearchResult(game, query)
        val fragmentScore = SearchRepository.scoreSearchResult(fragment, query)

        assertTrue("Movie score ($movieScore) must be higher than game score ($gameScore)", movieScore > gameScore)
        assertTrue("Fragment score ($fragmentScore) must be deeply penalized", fragmentScore < 0)
    }

    @Test
    fun testExtractReleaseTagAndSemverTen() {
        assertEquals(
            "1.0.10",
            AutoUpdater.extractReleaseTagFromLocation("https://github.com/sovopr/svorrent/releases/tag/v1.0.10")
        )
        assertEquals(
            "1.0.10",
            AutoUpdater.extractReleaseTagFromLocation("/sovopr/svorrent/releases/tag/V1.0.10?foo=bar")
        )
        assertEquals("", AutoUpdater.extractReleaseTagFromLocation("https://github.com/sovopr/svorrent/releases"))
        assertEquals("", AutoUpdater.extractReleaseTagFromLocation(null))
        assertTrue(AutoUpdater.isNewerSemver("1.0.9", "1.0.10"))
        assertFalse(AutoUpdater.isNewerSemver("1.0.10", "1.0.9"))
        assertFalse(AutoUpdater.isNewerSemver("1.0.10", "1.0.10"))
    }

    @Test
    fun testScoreSearchResultHighResAndSceneRepack() {
        val query = "the batman"
        val movie1080p = SearchResultItem(
            id = "2222222222222222222222222222222222222222",
            title = "The Batman (2022) 1080p WEBRip x264",
            sizeBytes = 2254857830L,
            sizeFormatted = "2.1 GB",
            seeds = 900,
            leechers = 120,
            provider = "ThePirateBay",
            infoHash = "2222222222222222222222222222222222222222",
            magnet = "magnet:?xt=urn:btih:2222222222222222222222222222222222222222"
        )
        val movie720p = movie1080p.copy(
            id = "3333333333333333333333333333333333333333",
            title = "The Batman (2022) 720p WEBRip x264",
            infoHash = "3333333333333333333333333333333333333333"
        )
        val sceneRepack = movie1080p.copy(
            id = "4444444444444444444444444444444444444444",
            title = "The Batman (2022) REPACK 1080p BluRay x265",
            infoHash = "4444444444444444444444444444444444444444"
        )
        val gameRepack = movie1080p.copy(
            id = "5555555555555555555555555555555555555555",
            title = "Batman Arkham Knight FitGirl Repack",
            infoHash = "5555555555555555555555555555555555555555"
        )

        val s1080 = SearchRepository.scoreSearchResult(movie1080p, query)
        val s720 = SearchRepository.scoreSearchResult(movie720p, query)
        val sSceneRepack = SearchRepository.scoreSearchResult(sceneRepack, query)
        val sGameRepack = SearchRepository.scoreSearchResult(gameRepack, query)

        assertTrue("1080p ($s1080) should rank higher than 720p ($s720)", s1080 > s720)
        assertTrue("Scene BluRay REPACK ($sSceneRepack) must rank far above game repack ($sGameRepack)", sSceneRepack > sGameRepack + 7000)
    }

    @Test
    fun testIsMainBuildNewerDetectsRepoCommitsWithoutVersionBump() {
        // New commit pushed to main with identical semver (1.0.11 -> 1.0.11) and higher monotonic versionCode
        assertTrue(
            AutoUpdater.isMainBuildNewer(
                currentVersion = "1.0.11",
                currentVersionCode = 94037500,
                currentSha = "eb2ff5b",
                remoteVersion = "1.0.11",
                remoteVersionCode = 94038100,
                remoteShortSha = "a1b2c3d"
            )
        )

        // Exact same commit SHA is NOT treated as an update even if versionCode differs slightly
        assertFalse(
            AutoUpdater.isMainBuildNewer(
                currentVersion = "1.0.11",
                currentVersionCode = 94037500,
                currentSha = "a1b2c3d",
                remoteVersion = "1.0.11",
                remoteVersionCode = 94037505,
                remoteShortSha = "a1b2c3d"
            )
        )

        // Older remote versionCode is never offered as a downgrade
        assertFalse(
            AutoUpdater.isMainBuildNewer(
                currentVersion = "1.0.11",
                currentVersionCode = 94039000,
                currentSha = "f9e8d7c",
                remoteVersion = "1.0.11",
                remoteVersionCode = 94038100,
                remoteShortSha = "a1b2c3d"
            )
        )
    }
}
