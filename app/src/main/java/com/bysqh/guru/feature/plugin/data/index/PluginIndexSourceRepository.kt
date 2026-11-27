package com.bysqh.guru.feature.plugin.data.index

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.bysqh.guru.core.datastore.preferencesCorruptionHandler
import dagger.hilt.android.qualifiers.ApplicationContext
import java.net.URI
import java.security.MessageDigest
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

private val Context.pluginIndexDataStore by preferencesDataStore(
    name = "plugin_index_sources",
    corruptionHandler = preferencesCorruptionHandler
)

/** 一个索引来源。身份由规范化地址派生，改显示名称不会改变来源身份。 */
data class PluginIndexSource(
    val id: String,
    val name: String,
    val indexUrl: String,
    val official: Boolean,
    val lastFetchedAt: Long = 0
) {
    val rootUrl: String get() = indexUrl.substringBeforeLast('/') + "/"
}

object PluginIndexDefaults {
    const val OFFICIAL_URL = "https://raw.githubusercontent.com/jieapi/AiCode-Plugins-Store/main/index.json"
    const val OFFICIAL_NAME = "Guru Plugins"
    const val OFFICIAL_ID = "guru.official"
    const val LEGACY_OFFICIAL_ID = "aicode.official"

    val official = PluginIndexSource(
        id = OFFICIAL_ID,
        name = OFFICIAL_NAME,
        indexUrl = OFFICIAL_URL,
        official = true
    )
}

internal fun isOfficialPluginIndexSourceId(id: String): Boolean =
    id == PluginIndexDefaults.OFFICIAL_ID || id == PluginIndexDefaults.LEGACY_OFFICIAL_ID

internal fun samePluginIndexSourceId(first: String?, second: String?): Boolean =
    first == second ||
        first != null && second != null &&
        isOfficialPluginIndexSourceId(first) && isOfficialPluginIndexSourceId(second)

private fun List<StoredSource>.officialSource(): StoredSource? =
    firstOrNull { it.id == PluginIndexDefaults.OFFICIAL_ID }
        ?: firstOrNull { it.id == PluginIndexDefaults.LEGACY_OFFICIAL_ID }

@Serializable
private data class StoredSource(
    val id: String,
    val name: String,
    val indexUrl: String,
    val lastFetchedAt: Long = 0
)

@Serializable
private data class StoredSources(val sources: List<StoredSource> = emptyList())

/**
 * 索引来源的持久化。官方来源永远由宿主常量提供且固定排在最前；
 * 自定义来源只有一个按行编辑的地址列表，列表顺序就是商店里各来源条目的叠加顺序。
 */
@Singleton
class PluginIndexSourceRepository @Inject constructor(
    @param:ApplicationContext private val context: Context
) {
    val sources: Flow<List<PluginIndexSource>> = context.pluginIndexDataStore.data.map { preferences ->
        val stored = preferences[KEY]?.let { raw ->
            runCatching { PluginIndexJson.decodeFromString<StoredSources>(raw) }.getOrNull()
        } ?: StoredSources()
        buildList {
            add(
                PluginIndexDefaults.official.copy(
                    lastFetchedAt = stored.sources.officialSource()?.lastFetchedAt ?: 0
                )
            )
            stored.sources
                .filterNot { isOfficialPluginIndexSourceId(it.id) }
                .map { it.toModel() }
                .forEach(::add)
        }
    }

    /** 自定义来源地址，顺序即展示顺序；官方来源不在其中。 */
    val customIndexUrls: Flow<List<String>> = sources.map { list ->
        list.filterNot { it.official }.map { it.indexUrl }
    }

    /** 用输入行整体替换自定义来源；空行、无效地址与重复地址会被忽略，其余保持输入顺序。 */
    suspend fun setCustomSources(lines: List<String>): Result<Unit> = runCatching {
        val existing = sources.first().filterNot { it.official }.associateBy { it.indexUrl }
        val next = linkedMapOf<String, PluginIndexSource>()
        lines.forEach { raw ->
            val url = runCatching { normalizeIndexUrl(raw) }.getOrNull() ?: return@forEach
            if (url in next) return@forEach
            next[url] = existing[url] ?: PluginIndexSource(
                id = sourceId(url),
                name = defaultName(url),
                indexUrl = url,
                official = false
            )
        }
        updateStored { stored ->
            val officialEntry = stored.sources.officialSource()?.let {
                StoredSource(
                    id = PluginIndexDefaults.OFFICIAL_ID,
                    name = PluginIndexDefaults.OFFICIAL_NAME,
                    indexUrl = PluginIndexDefaults.OFFICIAL_URL,
                    lastFetchedAt = it.lastFetchedAt
                )
            }
            stored.copy(sources = listOfNotNull(officialEntry) + next.values.map { it.toStored() })
        }
    }

    /** 记录最近一次成功拉取时间，仅用于离线展示。 */
    suspend fun markFetched(id: String, fetchedAt: Long) {
        updateStored { stored ->
            if (isOfficialPluginIndexSourceId(id)) {
                val canonical = StoredSource(
                    id = PluginIndexDefaults.OFFICIAL_ID,
                    name = PluginIndexDefaults.OFFICIAL_NAME,
                    indexUrl = PluginIndexDefaults.OFFICIAL_URL,
                    lastFetchedAt = fetchedAt
                )
                stored.copy(
                    sources = listOf(canonical) + stored.sources.filterNot {
                        isOfficialPluginIndexSourceId(it.id)
                    }
                )
            } else {
                stored.copy(
                    sources = stored.sources.map {
                        if (it.id == id) it.copy(lastFetchedAt = fetchedAt) else it
                    }
                )
            }
        }
    }

    private suspend fun updateStored(block: (StoredSources) -> StoredSources) {
        context.pluginIndexDataStore.edit { preferences ->
            val current = preferences[KEY]?.let { raw ->
                runCatching { PluginIndexJson.decodeFromString<StoredSources>(raw) }.getOrNull()
            } ?: StoredSources()
            preferences[KEY] = PluginIndexJson.encodeToString(block(current))
        }
    }

    private fun StoredSource.toModel() = PluginIndexSource(
        id = id,
        name = name,
        indexUrl = indexUrl,
        official = false,
        lastFetchedAt = lastFetchedAt
    )

    private fun PluginIndexSource.toStored() = StoredSource(
        id = id,
        name = name,
        indexUrl = indexUrl,
        lastFetchedAt = lastFetchedAt
    )

    private companion object {
        val KEY = stringPreferencesKey("sources_json")

        fun normalizeIndexUrl(raw: String): String {
            val text = raw.trim()
            val uri = URI(text)
            require(uri.scheme == "https" || uri.scheme == "http") { "scheme" }
            require(uri.host != null) { "host" }
            require(uri.userInfo == null) { "userInfo" }
            require(!text.contains('#')) { "fragment" }
            return text
        }

        /** 自定义来源没有单独的名称输入，用主机名作展示名。 */
        fun defaultName(indexUrl: String): String =
            runCatching { URI(indexUrl).host }.getOrNull() ?: indexUrl

        fun sourceId(indexUrl: String): String {
            val digest = MessageDigest.getInstance("SHA-256").digest(indexUrl.toByteArray(Charsets.UTF_8))
            return digest.joinToString("") { "%02x".format(it) }.take(24)
        }
    }
}
