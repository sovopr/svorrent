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
}

