package com.bysqh.guru.core.theme

import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.LocalOverscrollFactory
import androidx.compose.material3.ColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import top.yukonga.miuix.kmp.theme.Colors
import top.yukonga.miuix.kmp.theme.MiuixTheme
import top.yukonga.miuix.kmp.theme.darkColorScheme
import top.yukonga.miuix.kmp.theme.lightColorScheme

/**
 * [二开] 把本工程的 Material3 配色映射到 Miuix 的 Colors。
 *
 * Miuix 自带一套 MIUI 配色，但用户在这里还能切强调色、配色方案与 Monet；
 * 只取它的默认底子、再覆盖成我们算出来的颜色，才能让「界面样式」与「配色」两套设置互不覆盖。
 * Colors 的属性是 internal，只能走公开的 lightColorScheme / darkColorScheme 工厂。
 */
private fun ColorScheme.toMiuixColors(dark: Boolean): Colors {
    val base = if (dark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = primary,
        onPrimary = onPrimary,
        primaryVariant = primaryContainer,
        onPrimaryVariant = onPrimaryContainer,
        primaryContainer = primaryContainer,
        onPrimaryContainer = onPrimaryContainer,
        secondary = secondary,
        onSecondary = onSecondary,
        secondaryVariant = secondaryContainer,
        onSecondaryVariant = onSecondaryContainer,
        secondaryContainer = secondaryContainer,
        onSecondaryContainer = onSecondaryContainer,
        tertiaryContainer = tertiaryContainer,
        onTertiaryContainer = onTertiaryContainer,
        background = background,
        onBackground = onBackground,
        onBackgroundVariant = onSurfaceVariant,
        surface = surface,
        onSurface = onSurface,
        surfaceVariant = surfaceVariant,
        onSurfaceSecondary = onSurfaceVariant,
        onSurfaceVariantSummary = onSurfaceVariant,
        onSurfaceVariantActions = onSurfaceVariant,
        surfaceContainer = surfaceContainer,
        onSurfaceContainer = onSurface,
        onSurfaceContainerVariant = onSurfaceVariant,
        surfaceContainerHigh = surfaceContainerHigh,
        onSurfaceContainerHigh = onSurface,
        surfaceContainerHighest = surfaceContainerHighest,
        onSurfaceContainerHighest = onSurface,
        outline = outline,
        dividerLine = outlineVariant,
        error = error,
        onError = onError,
        errorContainer = errorContainer,
        onErrorContainer = onErrorContainer,
        disabledPrimary = primary.copy(alpha = 0.35f),
        disabledOnPrimary = onPrimary.copy(alpha = 0.6f),
        disabledPrimaryButton = primary.copy(alpha = 0.35f),
        disabledOnPrimaryButton = onPrimary.copy(alpha = 0.6f),
        disabledPrimarySlider = primary.copy(alpha = 0.35f),
        disabledSecondary = secondary.copy(alpha = 0.35f),
        disabledOnSecondary = onSecondary.copy(alpha = 0.6f),
        disabledSecondaryVariant = secondaryContainer.copy(alpha = 0.35f),
        disabledOnSecondaryVariant = onSecondaryContainer.copy(alpha = 0.6f),
        disabledOnSurface = onSurface.copy(alpha = 0.35f),
        sliderBackground = surfaceVariant,
        sliderKeyPoint = primary,
        sliderKeyPointForeground = onPrimary
    )
}

/**
 * [二开] Miuix 界面的主题外壳。
 *
 * 两套样式都挂 [MiuixTheme]，结构保持完全一致：切「界面样式」时不能重建子树，
 * 否则主题下面 remember 的导航控制器会丢，表现就是一切样式就跳回对话首页。
 * 标准样式把 Compose 默认的点击反馈与拉伸效果换回去；
 * Miuix 自己的本地变量（LocalColors / LocalTextStyles）不影响 Material 组件。
 */
@Composable
fun MiuixStyleScope(
    enabled: Boolean,
    dark: Boolean,
    scheme: ColorScheme,
    content: @Composable () -> Unit
) {
    val colors = remember(dark, scheme) { scheme.toMiuixColors(dark) }
    val outerIndication = LocalIndication.current
    val outerOverscroll = LocalOverscrollFactory.current
    MiuixTheme(colors = colors) {
        CompositionLocalProvider(
            LocalIndication provides if (enabled) LocalIndication.current else outerIndication,
            LocalOverscrollFactory provides if (enabled) LocalOverscrollFactory.current else outerOverscroll,
            content = content
        )
    }
}
