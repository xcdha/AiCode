package com.bysqh.guru.feature.pet.data

/*
 * [二开] 桌宠偏好：开关、显示尺寸、上次拖动位置。
 *
 * 机制对齐 VantaCode 的 PetSettingsRepository（同样的 pet_enabled / pet_x_ratio / pet_y_ratio 键），
 * 额外补一个尺寸项：VantaCode 尺寸写死在代码里，这里做成可调。
 */

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.bysqh.guru.core.datastore.preferencesCorruptionHandler
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton

private val Context.petDataStore by preferencesDataStore(
    name = "pet_prefs",
    corruptionHandler = preferencesCorruptionHandler
)

@Singleton
class PetSettingsRepository @Inject constructor(
    @param:ApplicationContext private val context: Context
) {
    /** 桌宠在屏幕上的归一化位置（0~1），换屏幕尺寸后仍落在相近的相对位置。 */
    data class Position(val xRatio: Float, val yRatio: Float)

    companion object {
        /** 默认尺寸（dp）。 */
        const val DEFAULT_SIZE_DP = 76f
        /** 最小尺寸：再小就看不清表情了。 */
        const val MIN_SIZE_DP = 40f
        /** 最大尺寸：再大会挡住正文。 */
        const val MAX_SIZE_DP = 160f
        /** 默认停靠位置：右侧中部，避开输入框与顶部标题。 */
        val DEFAULT_POSITION = Position(0.96f, 0.62f)

        private val ENABLED_KEY = booleanPreferencesKey("pet_enabled")
        private val SIZE_KEY = floatPreferencesKey("pet_size_dp")
        private val X_RATIO_KEY = floatPreferencesKey("pet_x_ratio")
        private val Y_RATIO_KEY = floatPreferencesKey("pet_y_ratio")
    }

    val enabledFlow: Flow<Boolean> = context.petDataStore.data.map { it[ENABLED_KEY] ?: false }

    val sizeFlow: Flow<Float> = context.petDataStore.data.map {
        (it[SIZE_KEY] ?: DEFAULT_SIZE_DP).coerceIn(MIN_SIZE_DP, MAX_SIZE_DP)
    }

    val positionFlow: Flow<Position> = context.petDataStore.data.map { prefs ->
        Position(
            xRatio = (prefs[X_RATIO_KEY] ?: DEFAULT_POSITION.xRatio).coerceIn(0f, 1f),
            yRatio = (prefs[Y_RATIO_KEY] ?: DEFAULT_POSITION.yRatio).coerceIn(0f, 1f)
        )
    }

    suspend fun setEnabled(enabled: Boolean) {
        context.petDataStore.edit { it[ENABLED_KEY] = enabled }
    }

    suspend fun setSizeDp(sizeDp: Float) {
        context.petDataStore.edit { it[SIZE_KEY] = sizeDp.coerceIn(MIN_SIZE_DP, MAX_SIZE_DP) }
    }

    suspend fun savePosition(xRatio: Float, yRatio: Float) {
        context.petDataStore.edit {
            it[X_RATIO_KEY] = xRatio.coerceIn(0f, 1f)
            it[Y_RATIO_KEY] = yRatio.coerceIn(0f, 1f)
        }
    }
}
