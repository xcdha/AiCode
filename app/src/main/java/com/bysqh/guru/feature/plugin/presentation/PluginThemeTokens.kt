package com.bysqh.guru.feature.plugin.presentation

import androidx.compose.material3.ColorScheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import com.bysqh.guru.core.theme.AppSemanticColors
import com.bysqh.guru.core.theme.Radius
import com.bysqh.guru.core.theme.Spacing
import java.util.Locale
import kotlin.math.roundToInt

/**
 * 插件页面可见的设计 token。颜色、间距、圆角都从当前 Compose 主题计算，
 * 页面只依赖 CSS 变量；主题切换时宿主更新变量即可，不重新加载页面。
 *
 * 变量名是插件作者可见的稳定接口，改动等于破坏插件页面，新增变量只能追加。
 */
object PluginThemeTokens {

    fun isDark(scheme: ColorScheme): Boolean = scheme.background.luminance() < 0.5f

    fun variables(
        scheme: ColorScheme,
        semantic: AppSemanticColors,
        fontScale: Float
    ): Map<String, String> = linkedMapOf(
        "--guru-bg" to scheme.background.toCss(),
        "--guru-surface" to scheme.surface.toCss(),
        "--guru-surface-variant" to scheme.surfaceVariant.toCss(),
        "--guru-on-surface" to scheme.onSurface.toCss(),
        "--guru-on-surface-variant" to scheme.onSurfaceVariant.toCss(),
        "--guru-primary" to scheme.primary.toCss(),
        "--guru-on-primary" to scheme.onPrimary.toCss(),
        "--guru-primary-container" to scheme.primaryContainer.toCss(),
        "--guru-primary-soft" to scheme.primary.copy(alpha = 0.12f).toCss(),
        "--guru-tertiary" to scheme.tertiary.toCss(),
        "--guru-tertiary-soft" to scheme.tertiary.copy(alpha = 0.12f).toCss(),
        "--guru-outline" to scheme.outline.toCss(),
        "--guru-outline-soft" to scheme.outline.copy(alpha = 0.12f).toCss(),
        "--guru-error" to scheme.error.toCss(),
        "--guru-success" to semantic.success.toCss(),
        "--guru-success-soft" to semantic.success.copy(alpha = 0.12f).toCss(),
        "--guru-warning" to semantic.warning.toCss(),
        "--guru-warning-soft" to semantic.warning.copy(alpha = 0.12f).toCss(),
        "--guru-page-bg" to semantic.pageBackground.toCss(),
        "--guru-card-surface" to semantic.cardSurface.toCss(),
        "--guru-subtle-text" to semantic.subtleText.toCss(),
        "--guru-subtle-border" to semantic.subtleBorder.toCss(),
        "--guru-space-xs" to px(Spacing.xs.value),
        "--guru-space-sm" to px(Spacing.sm.value),
        "--guru-space-md" to px(Spacing.md.value),
        "--guru-space-lg" to px(Spacing.lg.value),
        "--guru-space-xl" to px(Spacing.xl.value),
        "--guru-radius-xs" to px(Radius.xs.value),
        "--guru-radius-sm" to px(Radius.sm.value),
        "--guru-radius-md" to px(Radius.md.value),
        "--guru-radius-md-large" to px(Radius.mdLarge.value),
        "--guru-radius-lg" to px(Radius.lg.value),
        "--guru-radius-xl" to px(Radius.xl.value),
        "--guru-font-scale" to String.format(Locale.US, "%.2f", fontScale),
        "--guru-touch-target" to "44px",
        "--guru-switch-track" to if (isDark(scheme)) "#334155" else "#E2E8F0",
        "--guru-switch-thumb" to if (isDark(scheme)) "#F8FAFC" else "#FFFFFF",
        "--guru-font-sans" to "system-ui, -apple-system, \"Noto Sans CJK SC\", sans-serif",
        "--guru-font-mono" to "ui-monospace, \"Roboto Mono\", monospace",
        "--guru-text-field-border" to if (isDark(scheme)) {
            scheme.outlineVariant.copy(alpha = 0.6f).toCss()
        } else {
            scheme.outlineVariant.toCss()
        },
        "--guru-text-field-focused-bg" to if (isDark(scheme)) {
            scheme.surfaceVariant.copy(alpha = 0.8f).toCss()
        } else {
            semantic.cardSurface.toCss()
        },
        "--guru-text-field-disabled-border" to scheme.outlineVariant
            .copy(alpha = if (isDark(scheme)) 0.3f else 0.5f).toCss(),
        "--guru-text-field-disabled-text" to scheme.onSurface.copy(alpha = 0.38f).toCss(),
        "--guru-dialog-surface" to scheme.surfaceContainerHigh.toCss()
    )

    fun css(variables: Map<String, String>): String =
        ":root{" + variables.entries.joinToString("") { (key, value) -> "$key:$value;" } + "}"

    /** 主题变化时注入页面；页面侧由 [aicode.js] 的 applyTheme 写到根元素。 */
    fun applyScript(variables: Map<String, String>): String {
        val obj = variables.entries.joinToString(prefix = "{", postfix = "}") { (key, value) ->
            "\"$key\":\"${value.replace("\\", "\\\\").replace("\"", "\\\"")}\""
        }
        return "window.aicode&&window.aicode.applyTheme($obj)"
    }

    private fun px(value: Float): String = "${value.roundToInt()}px"

    private fun Color.toCss(): String {
        val r = (red * 255f).roundToInt().coerceIn(0, 255)
        val g = (green * 255f).roundToInt().coerceIn(0, 255)
        val b = (blue * 255f).roundToInt().coerceIn(0, 255)
        if (alpha >= 1f) return "#%02X%02X%02X".format(r, g, b)
        val a = String.format(Locale.US, "%.3f", alpha.coerceIn(0f, 1f))
        return "rgba($r,$g,$b,$a)"
    }
}
