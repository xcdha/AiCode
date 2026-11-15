package com.bysqh.guru.core.ui

/*
 * [二开] 系统级预测性返回开关。
 *
 * 参考 Eta 的 PredictiveBackController：Android 14 (UPSIDE_DOWN_CAKE) 起，系统提供
 * ApplicationInfo.setEnableOnBackInvokedCallback(boolean) 开关。App 锁 targetSdk 28，
 * 默认拿不到系统的手势预测动画，这里用反射把它打开（隐藏 API，需要 HiddenApiBypass 或
 * 系统放开灰名单；失败时静默降级，不影响其它功能）。
 */

import android.content.pm.ApplicationInfo
import android.os.Build
import java.lang.reflect.Method

object PredictiveBackController {
    private const val METHOD_NAME = "setEnableOnBackInvokedCallback"

    /**
     * 打开/关闭系统预测性返回。
     *
     * @return 是否成功应用（false 表示系统版本不支持或反射被拦）
     */
    fun apply(applicationInfo: ApplicationInfo, enabled: Boolean): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return false
        return runCatching {
            val method: Method = ApplicationInfo::class.java.getDeclaredMethod(
                METHOD_NAME,
                Boolean::class.javaPrimitiveType
            )
            method.isAccessible = true
            method.invoke(applicationInfo, enabled)
        }.isSuccess
    }
}
