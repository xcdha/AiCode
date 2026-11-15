package com.bysqh.guru.core.ui

/*
 * [二开] 横移返回容器：从屏幕左/右边缘向内拖动触发返回。
 *
 * 两种模式：
 *  - 预测性返回开：拖动时页面跟着手指位移，松手超过阈值完成返回，否则回弹（自绘预览动画）
 *  - 预测性返回关：拖动过程不位移，松手超过阈值直接返回
 *
 * 只从边缘 24dp 内起手，避免与列表横向滑动、抽屉手势抢事件；聊天页本身承载抽屉手势，
 * 由调用方通过 [enabled] 关掉。
 */

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.roundToInt

/** 触发返回所需的最小位移占比（相对屏幕宽度）。 */
private const val SWIPE_THRESHOLD_RATIO = 0.22f

@Composable
fun SwipeBackContainer(
    enabled: Boolean,
    predictive: Boolean,
    onBack: () -> Unit,
    content: @Composable () -> Unit
) {
    val scope = rememberCoroutineScope()
    val scopeOffset = remember { Animatable(0f) }
    val density = LocalDensity.current
    val edgePx = with(density) { 24.dp.toPx() }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .offset {
                IntOffset(
                    if (predictive) scopeOffset.value.roundToInt() else 0,
                    0
                )
            }
            .pointerInput(enabled, predictive) {
                if (!enabled) return@pointerInput
                var fromEdge = false
                var widthPx = size.width.toFloat().coerceAtLeast(1f)
                detectHorizontalDragGestures(
                    onDragStart = { start ->
                        // 只认边缘起手：左边缘或右边缘
                        fromEdge = start.x <= edgePx || start.x >= widthPx - edgePx
                    },
                    onHorizontalDrag = { change, dragAmount ->
                        if (!fromEdge) return@detectHorizontalDragGestures
                        change.consume()
                        if (predictive) {
                            scope.launch {
                                scopeOffset.snapTo(
                                    (scopeOffset.value + dragAmount).coerceIn(0f, widthPx)
                                )
                            }
                        }
                    },
                    onDragEnd = {
                        if (fromEdge) {
                            val travel = scopeOffset.value
                            val trigger = !predictive || abs(travel) >= widthPx * SWIPE_THRESHOLD_RATIO
                            if (predictive) {
                                if (trigger) {
                                    scope.launch { scopeOffset.animateTo(widthPx, tween(160)) }
                                    onBack()
                                    scope.launch { scopeOffset.snapTo(0f) }
                                } else {
                                    scope.launch { scopeOffset.animateTo(0f, tween(180)) }
                                }
                            } else if (trigger) {
                                onBack()
                            }
                        }
                        fromEdge = false
                    },
                    onDragCancel = {
                        fromEdge = false
                        if (predictive) scope.launch { scopeOffset.animateTo(0f, tween(180)) }
                    }
                )
            }
    ) {
        content()
    }
}
