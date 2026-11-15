package com.bysqh.guru.core.theme

import android.os.Build
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.Shapes
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

object Spacing {
    val xs = 4.dp
    val sm = 8.dp
    val md = 12.dp
    val lg = 16.dp
    val xl = 24.dp
    val xxl = 32.dp
}

object Radius {
    val xs = 4.dp
    val sm = 8.dp
    val md = 10.dp
    val mdLarge = 12.dp
    val lg = 14.dp
    val xl = 16.dp
    val pill = 999.dp
}

object Brand {
    val Blue = Color(0xFF2563EB)
    val Sky = Color(0xFF38BDF8)
    val IconGray = Color(0xFF64748B)
    val Orange = Color(0xFFF57C00)
}

/** 全局统一语义色彩，解决业务代码私自 hardcode 颜色问题。 */
data class AppSemanticColors(
    val success: Color,
    val onSuccess: Color,
    val successContainer: Color,
    val onSuccessContainer: Color,
    val warning: Color,
    val onWarning: Color,
    val warningContainer: Color,
    val onWarningContainer: Color,
    val info: Color,
    val onInfo: Color,
    val infoContainer: Color,
    val onInfoContainer: Color,
    val diffAdd: Color,
    val diffAddBg: Color,
    val diffRemove: Color,
    val diffRemoveBg: Color,
    val subtleText: Color,
    val subtleBorder: Color,
    val cardSurface: Color,
    val pageBackground: Color,
    val mutedSurface: Color,
    val capsuleSurface: Color,
    val buttonMutedBg: Color
)

/**
 * [二开] Miuix 调色板：Miui 语言的核心是「浅灰底 + 纯白卡片 + 亮蓝主色 + 胶囊按钮」。
 * 深色下则是纯黑底 + #1C1C1E 卡片，避免与 Material 的深灰底混同。
 */
private fun miuixColorScheme(base: ColorScheme, dark: Boolean): ColorScheme =
    if (dark) {
        base.copy(
            primary = Color(0xFF4E9BFF),
            onPrimary = Color(0xFF001A33),
            primaryContainer = Color(0xFF103A66),
            onPrimaryContainer = Color(0xFFD6E7FF),
            secondary = Color(0xFF8FA8C7),
            tertiary = Color(0xFF7FB2FF),
            background = Color(0xFF000000),
            onBackground = Color(0xFFEDEDED),
            surface = Color(0xFF1C1C1E),
            onSurface = Color(0xFFEDEDED),
            surfaceVariant = Color(0xFF2C2C2E),
            onSurfaceVariant = Color(0xFFB0B0B4),
            outline = Color(0xFF3A3A3C),
            outlineVariant = Color(0xFF2C2C2E)
        )
    } else {
        base.copy(
            primary = Color(0xFF3482FF),
            onPrimary = Color(0xFFFFFFFF),
            primaryContainer = Color(0xFFE6F0FF),
            onPrimaryContainer = Color(0xFF00305F),
            secondary = Color(0xFF5B7A9D),
            tertiary = Color(0xFF2F6BD8),
            background = Color(0xFFF2F3F5),
            onBackground = Color(0xFF111111),
            surface = Color(0xFFFFFFFF),
            onSurface = Color(0xFF111111),
            surfaceVariant = Color(0xFFF7F7F8),
            onSurfaceVariant = Color(0xFF6B6B6F),
            outline = Color(0xFFD9D9DE),
            outlineVariant = Color(0xFFE9E9EC)
        )
    }

/**
 * [二开] Miuix 版式：标题更粗、正文更大、行高更松，配合大圆角形成与标准样式明显的观感差异。
 * 只调字重与字号，不换字体族，避免设备字体缺失导致回退不一致。
 */
private fun miuixTypography(base: Typography): Typography = base.run {
    copy(
        headlineSmall = headlineSmall.copy(fontWeight = FontWeight.Bold),
        titleLarge = titleLarge.copy(fontWeight = FontWeight.Bold, fontSize = 23.sp),
        titleMedium = titleMedium.copy(fontWeight = FontWeight.Bold),
        titleSmall = titleSmall.copy(fontWeight = FontWeight.SemiBold),
        bodyLarge = bodyLarge.copy(fontSize = 17.sp, lineHeight = 25.sp),
        bodyMedium = bodyMedium.copy(fontSize = 15.sp, lineHeight = 22.sp),
        labelLarge = labelLarge.copy(fontWeight = FontWeight.SemiBold)
    )
}

/**
 * [二开] Miuix 界面样式：更大的圆角，接近 Miui 的卡片观感。
 * 只改形状不改色板，避免与「配色方案 / 色彩风格」互相打架。
 */
private val MiuixShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    // 胶囊：Miuix 的按钮、输入框、标签都是两端全圆
    small = RoundedCornerShape(50),
    medium = RoundedCornerShape(18.dp),
    large = RoundedCornerShape(22.dp),
    extraLarge = RoundedCornerShape(28.dp)
)

val LightSemanticColors = AppSemanticColors(
    success = Color(0xFF22C55E),
    onSuccess = Color(0xFFFFFFFF),
    successContainer = Color(0xFFDCFCE7),
    onSuccessContainer = Color(0xFF15803D),
    warning = Color(0xFFF59E0B),
    onWarning = Color(0xFFFFFFFF),
    warningContainer = Color(0xFFFEF3C7),
    onWarningContainer = Color(0xFF92400E),
    info = Color(0xFF0284C7),
    onInfo = Color(0xFFFFFFFF),
    infoContainer = Color(0xFFE0F2FE),
    onInfoContainer = Color(0xFF075985),
    diffAdd = Color(0xFF22C55E),
    diffAddBg = Color(0x2622C55E),
    diffRemove = Color(0xFFEF4444),
    diffRemoveBg = Color(0x26EF4444),
    subtleText = Color(0xFF8E8E93),
    subtleBorder = Color(0xFFE5E5EA),
    cardSurface = Color(0xFFFFFFFF),
    pageBackground = Color(0xFFF8F8F8),
    mutedSurface = Color(0xFFF2F2F7),
    capsuleSurface = Color(0xFFE9E9EB),
    buttonMutedBg = Color(0xFFF0F2F5)
)

val DarkSemanticColors = AppSemanticColors(
    success = Color(0xFF4ADE80),
    onSuccess = Color(0xFF052E16),
    successContainer = Color(0x59052E16),
    onSuccessContainer = Color(0xFFBBF7D0),
    warning = Color(0xFFFBBF24),
    onWarning = Color(0xFF78350F),
    warningContainer = Color(0x5978350F),
    onWarningContainer = Color(0xFFFDE68A),
    info = Color(0xFF38BDF8),
    onInfo = Color(0xFF0C4A6E),
    infoContainer = Color(0x590C4A6E),
    onInfoContainer = Color(0xFFBAE6FD),
    diffAdd = Color(0xFF4ADE80),
    diffAddBg = Color(0x334ADE80),
    diffRemove = Color(0xFFF87171),
    diffRemoveBg = Color(0x33F87171),
    subtleText = Color(0xFF94A3B8),
    subtleBorder = Color(0xFF2A3F56),
    cardSurface = Color(0xFF0D1B2E),
    pageBackground = Color(0xFF07111F),
    mutedSurface = Color(0xFF13273F),
    capsuleSurface = Color(0xFF1E293B),
    buttonMutedBg = Color(0xFF1E293B)
)

val LocalAppSemanticColors = staticCompositionLocalOf { LightSemanticColors }

val MaterialTheme.semanticColors: AppSemanticColors
    @Composable
    @ReadOnlyComposable
    get() = LocalAppSemanticColors.current

/** Git 模块统一 8 色泳道调色板 */
object GitLanePalette {
    val colors = listOf(
        Color(0xFF2563EB), // 1. 经典蓝
        Color(0xFF16A34A), // 2. 翠绿
        Color(0xFFF59E0B), // 3. 琥珀
        Color(0xFF8B5CF6), // 4. 优雅紫
        Color(0xFF06B6D4), // 5. 青蓝
        Color(0xFFEF4444), // 6. 珊瑚红
        Color(0xFFEC4899), // 7. 亮粉
        Color(0xFFEAB308)  // 8. 柠檬金
    )
}

/** Git 状态徽章统一色彩映射 */
object GitStatusColors {
    val Added = Color(0xFF16A34A)
    val Modified = Color(0xFFD97706)
    val Deleted = Color(0xFFDC2626)
    val Renamed = Color(0xFF2563EB)
    val Untracked = Color(0xFF94A3B8)
    val Conflict = Color(0xFF9333EA)
    val TypeChanged = Color(0xFF0891B2)
    val Default = Color(0xFF64748B)
}

/** 日志级别统一色彩映射 */
object LogLevelColors {
    val Verbose = Color(0xFF94A3B8)
    val Debug = Color(0xFF3B82F6)
    val Info = Color(0xFF22C55E)
    val Warn = Color(0xFFF59E0B)
    val Error = Color(0xFFEF4444)
    val None = Color(0xFF64748B)
}

/** Token / 统计图表统一调色板 */
object TokenStatsPalette {
    val Input = Color(0xFF3B82F6)
    val Output = Color(0xFFF59E0B)
    val Cache = Color(0xFF8B5CF6)
    val Error = Color(0xFFEF4444)
    val Cancelled = Color(0xFF94A3B8)
    val Progress = Color(0xFF22C55E)
}

/** 存储空间页各占用分类的色标（堆叠条与行前色点共用）。 */
object StorageUsagePalette {
    val Chat = Color(0xFF3B82F6)
    val Container = Color(0xFF8B5CF6)
    val ContainerImages = Color(0xFFA78BFA)
    val Workspaces = Color(0xFF22C55E)
    val AiConfig = Color(0xFF14B8A6)
    val Checkpoints = Color(0xFFF59E0B)
    val Logs = Color(0xFFF97316)
    val Caches = Color(0xFF94A3B8)
    val OtherData = Color(0xFFCBD5E1)
    val Apk = Color(0xFF64748B)
}

internal val DarkColorScheme = darkColorScheme(
    primary = Color(0xFF60A5FA),
    onPrimary = Color(0xFF082F49),
    primaryContainer = Color(0xFF0F3A63),
    onPrimaryContainer = Color(0xFFDBEAFE),
    secondary = Color(0xFF7DD3FC),
    onSecondary = Color(0xFF082F49),
    secondaryContainer = Color(0xFF0C4A6E),
    onSecondaryContainer = Color(0xFFBAE6FD),
    tertiary = Color(0xFF22C55E),
    tertiaryContainer = Color(0xFF14532D),
    onTertiaryContainer = Color(0xFFBBF7D0),
    background = Color(0xFF07111F),
    onBackground = Color(0xFFEAF2FF),
    surface = Color(0xFF0D1B2E),
    onSurface = Color(0xFFEAF2FF),
    surfaceVariant = Color(0xFF13273F),
    onSurfaceVariant = Color(0xFFB8C7DA),
    surfaceTint = Color.Transparent,
    surfaceContainerLowest = Color(0xFF050C17),
    surfaceContainerLow = Color(0xFF07111F),
    surfaceContainer = Color(0xFF0D1B2E),
    surfaceContainerHigh = Color(0xFF13273F),
    surfaceContainerHighest = Color(0xFF1B3350),
    surfaceBright = Color(0xFF24405F),
    surfaceDim = Color(0xFF07111F),
    outline = Color(0xFF64748B),
    outlineVariant = Color(0xFF334155),
    error = Color(0xFFF87171),
    onError = Color(0xFF450A0A),
    errorContainer = Color(0xFF7F1D1D),
    onErrorContainer = Color(0xFFFECACA)
)

internal val LightColorScheme = lightColorScheme(
    primary = Brand.Blue,
    onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFDBEAFE),
    onPrimaryContainer = Color(0xFF0B3B76),
    secondary = Color(0xFF0284C7),
    onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFE0F2FE),
    onSecondaryContainer = Color(0xFF075985),
    tertiary = Color(0xFF16A34A),
    tertiaryContainer = Color(0xFFDCFCE7),
    onTertiaryContainer = Color(0xFF15803D),
    background = Color(0xFFFFFFFF),
    onBackground = Color(0xFF0F172A),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF0F172A),
    surfaceVariant = Color(0xFFEAF4FF),
    onSurfaceVariant = Color(0xFF475569),
    surfaceTint = Color.White,
    surfaceContainerLowest = Color(0xFFFFFFFF),
    surfaceContainerLow = Color(0xFFFAFCFF),
    surfaceContainer = Color(0xFFF4F9FF),
    surfaceContainerHigh = Color(0xFFEAF4FF),
    surfaceContainerHighest = Color(0xFFE0EDFA),
    surfaceBright = Color(0xFFFFFFFF),
    surfaceDim = Color(0xFFE8EEF6),
    outline = Color(0xFFD1D1D6),
    outlineVariant = Color(0xFFE5E5EA),
    error = Color(0xFFDC2626),

    onError = Color(0xFFFFFFFF),
    errorContainer = Color(0xFFFEE2E2),
    onErrorContainer = Color(0xFF7F1D1D)
)

private val AppTypography = Typography().run {
    copy(
        headlineSmall = headlineSmall.copy(fontWeight = FontWeight.SemiBold, letterSpacing = 0.sp),
        titleLarge = titleLarge.copy(fontWeight = FontWeight.SemiBold, letterSpacing = 0.sp),
        titleMedium = titleMedium.copy(fontWeight = FontWeight.SemiBold),
        bodyLarge = bodyLarge.copy(lineHeight = 24.sp),
        bodyMedium = bodyMedium.copy(lineHeight = 21.sp),
        labelLarge = labelLarge.copy(fontWeight = FontWeight.Medium, letterSpacing = 0.sp)
    )
}

/**
 * @param preset 用户选定的配色主题。
 * @param dynamicColor 是否启用系统莫奈取色；低于 Android 12 时自动回退到 [preset]。
 */
@Composable
fun AIEditorTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    preset: AppThemePreset = AppThemePreset.DEFAULT,
    dynamicColor: Boolean = false,
    // [二开] 外观选项：强调色 / 色彩风格 / 界面样式 / 纯黑 / 界面缩放
    appearance: AppearanceOptions = AppearanceOptions(),
    content: @Composable () -> Unit
) {
    val context = LocalContext.current
    val themeColors = remember(darkTheme, preset, dynamicColor, context) {
        if (dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val dynamicScheme =
                if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
            deriveDynamicThemeColors(dynamicScheme, darkTheme)
        } else if (darkTheme) {
            preset.dark
        } else {
            preset.light
        }
    }

    // [二开] 外观变换：强调色与色彩风格作用在基础配色之上，纯黑只影响深色模式。
    val scheme = remember(themeColors, darkTheme, appearance) {
        val withAppearance = buildAppearanceColorScheme(themeColors.colorScheme, darkTheme, appearance)
        if (appearance.uiStyle == UiStyle.MIUIX) {
            miuixColorScheme(withAppearance, darkTheme)
        } else {
            withAppearance
        }
    }
    // Miuix 风格：更大的圆角，层级更「卡片化」；标准模式沿用 Material3 默认形状。
    val shapes = remember(appearance.uiStyle) {
        if (appearance.uiStyle == UiStyle.MIUIX) MiuixShapes else Shapes()
    }
    val density = LocalDensity.current
    val scaledDensity = remember(density, appearance.interfaceScale) {
        Density(density.density, density.fontScale * appearance.interfaceScale)
    }

    // [二开] 纯黑：页面底色与卡片面用的是语义色（不是 colorScheme.background），
    // 所以这里要同步压黑，否则「纯黑」只生效一半。
    val semanticColors = remember(themeColors, darkTheme, appearance, scheme) {
        // [二开] 用户改过外观（强调色/色彩风格/Miuix）时，把中性色与信息色也改为从最终配色派生，
        // 否则页面底色、卡片、分隔线仍是预设写死的值，看起来「只有部分组件变色」。
        // 全默认时保持预设原样，避免影响既有观感。
        val customized = appearance.accent != AccentColor.SYSTEM ||
            appearance.paletteStyle != PaletteStyle.TONAL_SPOT ||
            appearance.uiStyle == UiStyle.MIUIX
        val derived = if (customized) {
            themeColors.semanticColors.copy(
                pageBackground = scheme.background,
                cardSurface = scheme.surface,
                mutedSurface = scheme.surfaceVariant,
                capsuleSurface = scheme.surfaceVariant,
                buttonMutedBg = scheme.surfaceVariant,
                subtleBorder = scheme.outlineVariant,
                subtleText = scheme.onSurfaceVariant,
                info = scheme.primary,
                infoContainer = scheme.primaryContainer,
                onInfo = scheme.onPrimary,
                onInfoContainer = scheme.onPrimaryContainer
            )
        } else {
            themeColors.semanticColors
        }
        if (appearance.pureBlack && darkTheme) {
            derived.copy(
                pageBackground = Color.Black,
                cardSurface = Color(0xFF141414),
                mutedSurface = Color(0xFF0A0A0A),
                subtleBorder = Color(0xFF242424)
            )
        } else {
            derived
        }
    }
    CompositionLocalProvider(
        LocalAppSemanticColors provides semanticColors,
        LocalUiStyle provides appearance.uiStyle
    ) {
        CompositionLocalProvider(LocalDensity provides scaledDensity) {
            MaterialTheme(
                colorScheme = scheme,
                typography = if (appearance.uiStyle == UiStyle.MIUIX) {
                    miuixTypography(AppTypography)
                } else {
                    AppTypography
                },
                shapes = shapes,
                content = content
            )
        }
    }
}
