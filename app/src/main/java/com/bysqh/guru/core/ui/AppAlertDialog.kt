package com.bysqh.guru.core.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.bysqh.guru.core.theme.LocalUiStyle
import com.bysqh.guru.core.theme.UiStyle

/**
 * 全局统一弹窗：参数与 Material3 [AlertDialog] 一致，Miuix 界面样式下改用 miuix 的 OverlayDialog。
 *
 * [title] / [text] 仍是 Composable，Miuix 弹窗只接受纯文本标题，所以两者都排进内容区，
 * 调用处原来能塞任意内容（表单、列表、图标）的写法不用改。
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

    var visible by remember { mutableStateOf(true) }
    top.yukonga.miuix.kmp.overlay.OverlayDialog(
        show = visible,
        onDismissRequest = {
            visible = false
            onDismissRequest()
        },
        onDismissFinished = { visible = true },
        insideMargin = androidx.compose.ui.unit.DpSize(20.dp, 22.dp)
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
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
