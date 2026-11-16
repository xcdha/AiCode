package com.bysqh.guru.feature.settings.data.repository

/*
 * [二开] 导航手势偏好：横移返回、预测性返回动画。
 *
 * 注：本 App 锁定 targetSdk 28，系统的「预测性返回」(OnBackInvokedCallback) 不会启用，
 * 所以这里的预测性返回是应用内自绘的预览动画（拖动时页面跟手位移、松手回弹或完成返回），
 * 效果与系统预测性返回一致，且不依赖系统版本。
 */

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.preferencesDataStore
import com.bysqh.guru.core.datastore.preferencesCorruptionHandler
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton

private val Context.gestureDataStore by preferencesDataStore(
    name = "gesture_prefs",
    corruptionHandler = preferencesCorruptionHandler
)

@Singleton
class GestureSettingsRepository @Inject constructor(
    @param:ApplicationContext private val context: Context
) {
    private companion object {
        val SWIPE_BACK_KEY = booleanPreferencesKey("swipe_back_enabled")
        val PREDICTIVE_BACK_KEY = booleanPreferencesKey("predictive_back_enabled")
    }

    /** 横移返回手势开关，默认开启。 */
    val swipeBackFlow: Flow<Boolean> = context.gestureDataStore.data.map { it[SWIPE_BACK_KEY] != false }

    /** 预测性返回动画开关，默认开启。 */
    val predictiveBackFlow: Flow<Boolean> =
        context.gestureDataStore.data.map { it[PREDICTIVE_BACK_KEY] != false }

    suspend fun setSwipeBack(enabled: Boolean) {
        context.gestureDataStore.edit { it[SWIPE_BACK_KEY] = enabled }
    }

    suspend fun setPredictiveBack(enabled: Boolean) {
        context.gestureDataStore.edit { it[PREDICTIVE_BACK_KEY] = enabled }
    }
}
