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
}
