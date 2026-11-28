package com.bysqh.guru.feature.plugin.data.index

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PluginIndexCachePolicyTest {

    @Test
    fun officialSourceUsesPublishedIndexRepositoryAndRecognizesBothPersistedIds() {
        assertEquals("guru.official", PluginIndexDefaults.OFFICIAL_ID)
        assertTrue(isOfficialPluginIndexSourceId("guru.official"))
        assertTrue(isOfficialPluginIndexSourceId("aicode.official"))
        assertFalse(isOfficialPluginIndexSourceId("custom.source"))
        assertTrue(samePluginIndexSourceId("aicode.official", "guru.official"))
        assertFalse(samePluginIndexSourceId("aicode.official", "community.index"))
        assertEquals("Guru Plugins", PluginIndexDefaults.OFFICIAL_NAME)
        assertEquals(
            "https://raw.githubusercontent.com/xcdha/Guru-Plugins-Store/main/index.json",
            PluginIndexDefaults.OFFICIAL_URL
        )
    }

    @Test
    fun changingOfficialUrlInvalidatesThePreviousFetchTimestamp() {
        assertEquals(0L, officialIndexFetchedAt("https://old.example/index.json", 123L))
        assertEquals(123L, officialIndexFetchedAt(PluginIndexDefaults.OFFICIAL_URL, 123L))
    }

    @Test
    fun cacheRemainsFreshForOneHour() {
        val now = PLUGIN_INDEX_CACHE_TTL_MS * 3

        assertTrue(isPluginIndexCacheFresh(now - PLUGIN_INDEX_CACHE_TTL_MS + 1, now))
        assertFalse(isPluginIndexCacheFresh(now - PLUGIN_INDEX_CACHE_TTL_MS, now))
        assertFalse(isPluginIndexCacheFresh(0, now))
    }
}
