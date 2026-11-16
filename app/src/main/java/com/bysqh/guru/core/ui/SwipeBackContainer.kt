package com.bysqh.guru.core.ui

/*
 * [二开] 横移返回容器：从屏幕左/右边缘向内拖动触发返回。
 *
 * 两种模式：
 *  - 预测性返回开：拖动时页面跟着手指位移，松手超过阈值完成返回，否则回弹（自绘预览动画）
 *  - 预测性返回关：拖动过程不位移，松手超过阈值直接返回
 *
 * 关键点：手势检测必须跑在 [PointerEventPass.Initial]。
 * 子节点（NavHost / 列表 / 输入框）会先消费掉横向拖动，父级若等到 Final 阶段就再也收不到，
 * 表现为「横移返回完全没效果」。这里在 Initial 阶段先判断是否起手于屏幕边缘，
 * 命中就自己接管整段拖动，否则完全不干预子节点的滚动。
 *
 * 只从边缘 32dp 内起手，避免与列表横向滑动、抽屉手势抢事件；聊天页本身承载抽屉手势，
 * 由调用方通过 [enabled] 关掉。
 */

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.roundToInt

/** 触发返回所需的最小位移占比（相对屏幕宽度）。 */
private const val SWIPE_THRESHOLD_RATIO = 0.22f

/** 边缘起手判定宽度（dp）：太宽会和抽屉手势冲突，太窄手指不好命中。 */
private const val EDGE_ZONE_DP = 32

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
    val edgePx = with(density) { EDGE_ZONE_DP.dp.toPx() }

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
                val widthPx = size.width.toFloat().coerceAtLeast(1f)
                awaitPointerEventScope {
                    while (true) {
                        // Initial 阶段：此刻子节点还没拿到事件，可以先判断起手位置。
                        val down = awaitPointerEvent(PointerEventPass.Initial)
                            .changes.firstOrNull { it.pressed } ?: continue
                        val fromEdge = down.position.x <= edgePx ||
                            down.position.x >= widthPx - edgePx
                        if (!fromEdge) {
                            // 非边缘起手：彻底不干预，让子节点正常滚动。
                            awaitPointerEvent(PointerEventPass.Initial)
                            continue
                        }
                        // 边缘起手：接管本次横向拖动，直到抬手。
                        var totalDrag = 0f
                        var triggered = false
                        var pointerId = down.id
                        var lastX = down.position.x
                        var finished = false
                        while (!finished) {
                            val event = awaitPointerEvent(PointerEventPass.Initial)
                            val change = event.changes.firstOrNull { it.id == pointerId }
                            if (change == null) {
                                finished = true
                                continue
                            }
                            if (!change.pressed) {
                                // 抬手：按位移量决定是否触发返回。
                                triggered = !predictive ||
                                    abs(totalDrag) >= widthPx * SWIPE_THRESHOLD_RATIO
                                finished = true
                                continue
                            }
                            // positionChange() 在本版本返回 Boolean（是否发生位移），
                            // 位移量自己用前后两个位置算。
                            val delta = change.position.x - lastX
                            if (delta != 0f) {
                                change.consume()
                                lastX = change.position.x
                                totalDrag += delta
                                if (predictive) {
                                    scope.launch {
                                        scopeOffset.snapTo(
                                            (scopeOffset.value + delta).coerceIn(0f, widthPx)
                                        )
                                    }
                                }
                            }
                        }
                        if (predictive) {
                            if (triggered) {
                                scope.launch { scopeOffset.animateTo(widthPx, tween(160)) }
                                onBack()
                                scope.launch { scopeOffset.snapTo(0f) }
                            } else {
                                scope.launch { scopeOffset.animateTo(0f, tween(180)) }
                            }
                        } else if (triggered) {
                            onBack()
                        }
                    }
                }
            }
    ) {
        content()
    }
}
