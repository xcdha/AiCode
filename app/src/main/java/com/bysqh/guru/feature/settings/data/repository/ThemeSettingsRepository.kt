package com.bysqh.guru.feature.settings.data.repository

import android.content.Context
import com.bysqh.guru.R
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.bysqh.guru.core.datastore.preferencesCorruptionHandler
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton

private val Context.themeDataStore by preferencesDataStore(
    name = "theme_prefs",
    corruptionHandler = preferencesCorruptionHandler
)

enum class AppThemeMode(val labelRes: Int) {
    AUTO(R.string.theme_auto),
    DARK(R.string.theme_dark),
    LIGHT(R.string.theme_light);

    companion object {
        fun fromPersisted(value: String?): AppThemeMode? = entries.firstOrNull { it.name == value }
    }
}

/** 持久化 App 外观主题。默认跟随系统，也兼容旧版深色开关。 */
@Singleton
class ThemeSettingsRepository @Inject constructor(
    @param:ApplicationContext private val context: Context
) {
    private companion object {
        val THEME_MODE_KEY = stringPreferencesKey("theme_mode")
        val DARK_THEME_KEY = booleanPreferencesKey("dark_theme_enabled")
        val THEME_PRESET_KEY = stringPreferencesKey("theme_preset_id")
        val DYNAMIC_COLOR_KEY = booleanPreferencesKey("dynamic_color_enabled")
        // [二开] 外观选项（参考 Eta）：强调色 / 色彩风格 / 界面样式 / 纯黑 / 界面缩放
        val ACCENT_COLOR_KEY = stringPreferencesKey("appearance_accent_color")
        val PALETTE_STYLE_KEY = stringPreferencesKey("appearance_palette_style")
        val UI_STYLE_KEY = stringPreferencesKey("appearance_ui_style")
        val PURE_BLACK_KEY = booleanPreferencesKey("appearance_pure_black")
        val INTERFACE_SCALE_KEY = floatPreferencesKey("appearance_interface_scale")
    }

    val themeModeFlow: Flow<AppThemeMode> = context.themeDataStore.data.map { prefs ->
        AppThemeMode.fromPersisted(prefs[THEME_MODE_KEY])
            ?: prefs[DARK_THEME_KEY]?.let { if (it) AppThemeMode.DARK else AppThemeMode.LIGHT }
            ?: AppThemeMode.AUTO
    }

    /** 配色主题 id，对应 `AppThemePreset.id`；未设置时为 null，由调用方回退默认。 */
    val themePresetIdFlow: Flow<String?> = context.themeDataStore.data.map { it[THEME_PRESET_KEY] }

    /** 是否启用系统莫奈取色。开启后配色主题的选择不再生效。 */
    val dynamicColorFlow: Flow<Boolean> =
        context.themeDataStore.data.map { it[DYNAMIC_COLOR_KEY] == true }

    /** [二开] 强调色（强色调）。 */
    val accentColorFlow: Flow<com.bysqh.guru.core.theme.AccentColor> =
        context.themeDataStore.data.map { com.bysqh.guru.core.theme.AccentColor.fromId(it[ACCENT_COLOR_KEY]) }

    /** [二开] 色彩风格。 */
    val paletteStyleFlow: Flow<com.bysqh.guru.core.theme.PaletteStyle> =
        context.themeDataStore.data.map { com.bysqh.guru.core.theme.PaletteStyle.fromId(it[PALETTE_STYLE_KEY]) }

    /** [二开] 界面样式（标准 / Miuix）。 */
    val uiStyleFlow: Flow<com.bysqh.guru.core.theme.UiStyle> =
        context.themeDataStore.data.map { com.bysqh.guru.core.theme.UiStyle.fromId(it[UI_STYLE_KEY]) }

    /** [二开] 纯黑背景（仅深色模式生效）。 */
    val pureBlackFlow: Flow<Boolean> = context.themeDataStore.data.map { it[PURE_BLACK_KEY] == true }

    /** [二开] 界面缩放（0.85~1.15）。 */
    val interfaceScaleFlow: Flow<Float> = context.themeDataStore.data.map {
        com.bysqh.guru.core.theme.AppearanceOptions.normalizeScale(
            it[INTERFACE_SCALE_KEY] ?: com.bysqh.guru.core.theme.AppearanceOptions.DEFAULT_SCALE
        )
    }

    suspend fun setAccentColor(value: com.bysqh.guru.core.theme.AccentColor) {
        context.themeDataStore.edit { it[ACCENT_COLOR_KEY] = value.id }
    }

    suspend fun setPaletteStyle(value: com.bysqh.guru.core.theme.PaletteStyle) {
        context.themeDataStore.edit { it[PALETTE_STYLE_KEY] = value.id }
    }

    suspend fun setUiStyle(value: com.bysqh.guru.core.theme.UiStyle) {
        context.themeDataStore.edit { it[UI_STYLE_KEY] = value.id }
    }

    suspend fun setPureBlack(enabled: Boolean) {
        context.themeDataStore.edit { it[PURE_BLACK_KEY] = enabled }
    }

    suspend fun setInterfaceScale(value: Float) {
        context.themeDataStore.edit {
            it[INTERFACE_SCALE_KEY] = com.bysqh.guru.core.theme.AppearanceOptions.normalizeScale(value)
        }
    }

    suspend fun setThemeMode(mode: AppThemeMode) {
        context.themeDataStore.edit { it[THEME_MODE_KEY] = mode.name }
    }

    suspend fun setThemePresetId(id: String) {
        context.themeDataStore.edit { it[THEME_PRESET_KEY] = id }
    }

    suspend fun setDynamicColorEnabled(enabled: Boolean) {
        context.themeDataStore.edit { it[DYNAMIC_COLOR_KEY] = enabled }
    }

    /** 备份快照：返回当前持久化的主题模式名（未设置时为 null，导入时回退默认）。 */
    suspend fun snapshot(): String? = themeModeFlow.first().name

    /** 从备份还原主题模式；null 时清除键回退默认。 */
    suspend fun restore(value: String?) {
        context.themeDataStore.edit {
            if (value == null) it.remove(THEME_MODE_KEY) else it[THEME_MODE_KEY] = value
        }
    }

    /** 备份快照：当前配色主题 id。 */
    suspend fun presetSnapshot(): String? = themePresetIdFlow.first()

    /** 备份快照：莫奈取色开关。 */
    suspend fun dynamicColorSnapshot(): Boolean = dynamicColorFlow.first()

    /** 从备份还原配色主题与莫奈开关；id 为 null 时清除键回退默认。 */
    suspend fun restoreColors(presetId: String?, dynamicColor: Boolean) {
        context.themeDataStore.edit {
            if (presetId == null) it.remove(THEME_PRESET_KEY) else it[THEME_PRESET_KEY] = presetId
            it[DYNAMIC_COLOR_KEY] = dynamicColor
        }
    }
}
