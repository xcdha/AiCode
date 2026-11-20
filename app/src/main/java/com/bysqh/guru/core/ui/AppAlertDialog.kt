package com.bysqh.guru.core.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.bysqh.guru.core.theme.LocalUiStyle
import com.bysqh.guru.core.theme.UiStyle
import top.yukonga.miuix.kmp.theme.MiuixTheme

/**
 * 全局统一弹窗：参数与 Material3 [AlertDialog] 一致，Miuix 界面样式下换成 miuix 的容器与配色。
 *
 * 不能直接用 miuix 的 OverlayDialog：它把内容挂到 miuix Scaffold 提供的宿主列表上，
 * 本应用根布局不是 miuix Scaffold，弹窗会静默不显示（点编辑没反应就是这个原因）。
 * 所以这里用自己的窗口 Dialog 承托，只借它的配色与圆角。
 *
 * [title] / [text] 仍是 Composable，调用处能塞任意内容（表单、列表、图标）的写法不用改。
 */
@Composable
fun AppAlertDialog(
    onDismissRequest: () -> Unit,
    confirmButton: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    dismissButton: (@Composable () -> Unit)? = null,
    icon: (@Composable () -> Unit)? = null,
    title: (@Composable () -> Unit)? = null,
    text: (@Composable () -> Unit)? = null,
    shape: Shape = androidx.compose.material3.AlertDialogDefaults.shape,
    containerColor: Color = androidx.compose.material3.AlertDialogDefaults.containerColor,
    tonalElevation: Dp = androidx.compose.material3.AlertDialogDefaults.TonalElevation
) {
    if (LocalUiStyle.current != UiStyle.MIUIX) {
        AlertDialog(
            onDismissRequest = onDismissRequest,
            confirmButton = confirmButton,
            modifier = modifier,
            dismissButton = dismissButton,
            icon = icon,
            title = title,
            text = text,
            shape = shape,
            containerColor = containerColor,
            tonalElevation = tonalElevation
        )
        return
    }

    Dialog(
        onDismissRequest = onDismissRequest,
        properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 24.dp),
            contentAlignment = Alignment.Center
        ) {
            Surface(
                modifier = modifier,
                shape = RoundedCornerShape(28.dp),
                color = MiuixTheme.colorScheme.surfaceContainer,
                contentColor = MiuixTheme.colorScheme.onSurfaceContainer
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 20.dp, vertical = 18.dp)
                ) {
                    icon?.invoke()
                    title?.invoke()
                    if (text != null) {
                        Column(modifier = Modifier.padding(top = 8.dp)) { text() }
                    }
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = 16.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        dismissButton?.invoke()
                        confirmButton()
                    }
                }
            }
        }
    }
}
