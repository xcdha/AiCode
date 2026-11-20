package com.bysqh.guru.core.ui

import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonColors
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.bysqh.guru.core.theme.LocalUiStyle
import com.bysqh.guru.core.theme.UiStyle

/**
 * 全局统一图标按钮：参数与 Material3 [IconButton] 一致，Miuix 界面样式下改用 miuix 的 IconButton。
 *
 * miuix 的点击反馈与按住缩放由它自己给，颜色跟随 MiuixTheme，所以 [colors] 在 Miuix 下不生效。
 */
@Composable
fun AppIconButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    colors: IconButtonColors = IconButtonDefaults.iconButtonColors(),
    interactionSource: MutableInteractionSource? = null,
    content: @Composable () -> Unit
) {
    if (LocalUiStyle.current == UiStyle.MIUIX) {
        top.yukonga.miuix.kmp.basic.IconButton(
            onClick = onClick,
            modifier = modifier,
            enabled = enabled,
            content = content
        )
        return
    }
    IconButton(
        onClick = onClick,
        modifier = modifier,
        enabled = enabled,
        colors = colors,
        interactionSource = interactionSource,
        content = content
    )
}
