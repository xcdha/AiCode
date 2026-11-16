package com.bysqh.guru.feature.pet.presentation

/*
 * [二开] 桌宠悬浮层（应用内，非系统悬浮窗）。
 *
 * 机制对齐 VantaCode 的 VantaPetOverlay：
 *  - 跟随 AgentUIState 切换表情（Idle/Loading/Streaming/Result/Error → 5 种表情）
 *  - 可拖动，位置按归一化坐标存盘，换屏幕尺寸后仍落在相对位置
 *  - 呼吸 + 上下浮动两个无限动画，侧栏展开时淡出避免遮挡
 *
 * 刻意没搬 VantaCode 的 pet/vanta.png 美术资源（那是对方的版权素材），
 * 这里用 Compose Canvas 自绘一只，表情由形状变化表达，风格与 App 主题色一致。
 */

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.bysqh.guru.R
import com.bysqh.guru.feature.agent.presentation.AgentUIState
import kotlinx.coroutines.delay
import kotlin.math.roundToInt

/** 桌宠表情，与 VantaCode 的 PetExpression 取值一致。 */
enum class PetExpression {
    IDLE,
    LOOKING,
    STREAMING,
    PLEASED,
    DOWNCAST
}

/** Agent 状态 → 表情：等待时张望、流式输出时专注、成功开心、失败沮丧。 */
internal fun AgentUIState.toPetExpression(): PetExpression = when (this) {
    AgentUIState.Idle -> PetExpression.IDLE
    AgentUIState.Loading -> PetExpression.LOOKING
    AgentUIState.Streaming -> PetExpression.STREAMING
    is AgentUIState.Result -> PetExpression.PLEASED
    is AgentUIState.Error -> PetExpression.DOWNCAST
}

/** 气泡文案资源；IDLE 不出气泡，避免平时一直挡视线。 */
private fun PetExpression.bubbleRes(): Int? = when (this) {
    PetExpression.IDLE -> null
    PetExpression.LOOKING -> R.string.pet_bubble_thinking
    PetExpression.STREAMING -> R.string.pet_bubble_working
    PetExpression.PLEASED -> R.string.pet_bubble_done
    PetExpression.DOWNCAST -> R.string.pet_bubble_error
}

/**
 * 全局桌宠层。挂在主界面最外层 `Box` 里，位于内容之上、水印之下。
 *
 * @param agentState 当前 Agent 状态，决定表情。
 * @param viewModel 桌宠偏好（开关 / 尺寸 / 位置），与设置页共用。
 * @param hiddenByDrawer 侧栏是否展开；展开时淡出，避免挡住文件树。
 */
@Composable
internal fun PetOverlay(
    agentState: AgentUIState,
    viewModel: PetSettingsViewModel,
    hiddenByDrawer: Boolean,
    modifier: Modifier = Modifier
) {
    val enabled by viewModel.enabled.collectAsStateWithLifecycle()
    if (!enabled) return

    val sizeDp by viewModel.sizeDp.collectAsStateWithLifecycle()
    val savedPosition by viewModel.position.collectAsStateWithLifecycle()

    val expression = agentState.toPetExpression()
    val alpha by animateFloatAsState(
        targetValue = if (hiddenByDrawer) 0f else 1f,
        animationSpec = tween(220),
        label = "pet-alpha"
    )
    if (alpha <= 0.01f) return

    var ratioX by remember(savedPosition) { mutableFloatStateOf(savedPosition.xRatio) }
    var ratioY by remember(savedPosition) { mutableFloatStateOf(savedPosition.yRatio) }

    // 气泡：状态切换时短暂出现，1.6s 后自动收起。
    var bubbleVisible by remember { mutableStateOf(false) }
    LaunchedEffect(expression) {
        bubbleVisible = expression.bubbleRes() != null
        if (bubbleVisible) {
            delay(1600)
            bubbleVisible = false
        }
    }

    val infinite = rememberInfiniteTransition(label = "pet")
    val breath by infinite.animateFloat(
        initialValue = 0.97f,
        targetValue = 1.03f,
        animationSpec = infiniteRepeatable(
            animation = tween(1800, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "pet-breath"
    )
    val floatOffset by infinite.animateFloat(
        initialValue = -4f,
        targetValue = 4f,
        animationSpec = infiniteRepeatable(
            animation = tween(2400, easing = LinearEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "pet-float"
    )

    BoxWithConstraints(modifier = modifier.fillMaxSize()) {
        val petSizePx = with(LocalDensity.current) { sizeDp.dp.toPx() }
        // 可移动范围：容器尺寸减去宠物自身尺寸，避免拖出屏幕外。
        val travelX = (constraints.maxWidth - petSizePx).coerceAtLeast(1f)
        val travelY = (constraints.maxHeight - petSizePx).coerceAtLeast(1f)

        Box(
            modifier = Modifier
                .offset {
                    IntOffset(
                        (ratioX * travelX).roundToInt(),
                        (ratioY * travelY).roundToInt()
                    )
                }
                .size(sizeDp.dp)
                .alpha(alpha)
                .pointerInput(Unit) {
                    detectDragGestures(
                        onDrag = { change, dragAmount ->
                            change.consume()
                            ratioX = (ratioX + dragAmount.x / travelX).coerceIn(0f, 1f)
                            ratioY = (ratioY + dragAmount.y / travelY).coerceIn(0f, 1f)
                        },
                        onDragEnd = { viewModel.savePosition(ratioX, ratioY) },
                        onDragCancel = { viewModel.savePosition(ratioX, ratioY) }
                    )
                }
        ) {
            PetSprite(
                expression = expression,
                modifier = Modifier
                    .fillMaxSize()
                    .graphicsLayer {
                        scaleX = breath
                        scaleY = breath
                        translationY = floatOffset
                    }
            )

            val bubbleRes = expression.bubbleRes()
            if (bubbleVisible && bubbleRes != null) {
                Surface(
                    color = MaterialTheme.colorScheme.surfaceVariant,
                    shape = RoundedCornerShape(10.dp),
                    shadowElevation = 2.dp,
                    modifier = Modifier
                        .align(Alignment.TopCenter)
                        .offset(y = (-30).dp)
                ) {
                    Text(
                        text = stringResource(bubbleRes),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
                    )
                }
            }
        }
    }
}

/**
 * 自绘桌宠：圆角身体 + 高光 + 按表情变化的眼睛与嘴。
 * 全部用几何图形拼，不依赖任何位图资源。
 */
@Composable
private fun PetSprite(expression: PetExpression, modifier: Modifier = Modifier) {
    val body = MaterialTheme.colorScheme.primary
    val face = MaterialTheme.colorScheme.onPrimary

    Canvas(modifier) {
        val w = size.width
        val h = size.height

        // 身体：圆角方块，下沿留一点阴影感。
        drawRoundRect(
            color = body,
            cornerRadius = CornerRadius(w * 0.34f, w * 0.34f),
            size = Size(w, h)
        )
        // 左上高光，让纯色身体不至于太扁。
        drawCircle(
            color = Color.White.copy(alpha = 0.16f),
            radius = w * 0.17f,
            center = Offset(w * 0.30f, h * 0.26f)
        )

        val eyeY = h * 0.44f
        val eyeLeft = w * 0.34f
        val eyeRight = w * 0.66f
        val eyeRadius = w * 0.065f
        val stroke = Stroke(width = w * 0.045f, cap = StrokeCap.Round)

        when (expression) {
            PetExpression.IDLE -> {
                drawCircle(face, eyeRadius, Offset(eyeLeft, eyeY))
                drawCircle(face, eyeRadius, Offset(eyeRight, eyeY))
                // 微笑：下弧线
                drawArc(
                    color = face,
                    startAngle = 20f,
                    sweepAngle = 140f,
                    useCenter = false,
                    topLeft = Offset(w * 0.38f, h * 0.55f),
                    size = Size(w * 0.24f, h * 0.16f),
                    style = stroke
                )
            }

            PetExpression.LOOKING -> {
                // 眼珠偏右：像在等回复
                drawCircle(face, eyeRadius, Offset(eyeLeft + w * 0.02f, eyeY))
                drawCircle(face, eyeRadius, Offset(eyeRight + w * 0.02f, eyeY))
                drawCircle(
                    color = face,
                    radius = w * 0.035f,
                    center = Offset(w * 0.5f, h * 0.66f)
                )
            }

            PetExpression.STREAMING -> {
                // 眯眼（专注）：两条横线
                drawLine(
                    color = face,
                    start = Offset(eyeLeft - w * 0.05f, eyeY),
                    end = Offset(eyeLeft + w * 0.05f, eyeY),
                    strokeWidth = w * 0.045f,
                    cap = StrokeCap.Round
                )
                drawLine(
                    color = face,
                    start = Offset(eyeRight - w * 0.05f, eyeY),
                    end = Offset(eyeRight + w * 0.05f, eyeY),
                    strokeWidth = w * 0.045f,
                    cap = StrokeCap.Round
                )
                drawCircle(
                    color = face,
                    radius = w * 0.045f,
                    center = Offset(w * 0.5f, h * 0.66f)
                )
            }

            PetExpression.PLEASED -> {
                // 弯月眼（开心）
                drawArc(
                    color = face,
                    startAngle = 200f,
                    sweepAngle = 140f,
                    useCenter = false,
                    topLeft = Offset(eyeLeft - w * 0.06f, eyeY - h * 0.02f),
                    size = Size(w * 0.12f, h * 0.09f),
                    style = stroke
                )
                drawArc(
                    color = face,
                    startAngle = 200f,
                    sweepAngle = 140f,
                    useCenter = false,
                    topLeft = Offset(eyeRight - w * 0.06f, eyeY - h * 0.02f),
                    size = Size(w * 0.12f, h * 0.09f),
                    style = stroke
                )
                drawArc(
                    color = face,
                    startAngle = 10f,
                    sweepAngle = 160f,
                    useCenter = false,
                    topLeft = Offset(w * 0.36f, h * 0.56f),
                    size = Size(w * 0.28f, h * 0.20f),
                    style = stroke
                )
            }

            PetExpression.DOWNCAST -> {
                drawCircle(face, eyeRadius * 0.85f, Offset(eyeLeft, eyeY + h * 0.02f))
                drawCircle(face, eyeRadius * 0.85f, Offset(eyeRight, eyeY + h * 0.02f))
                // 向下弯的嘴
                drawArc(
                    color = face,
                    startAngle = 200f,
                    sweepAngle = 140f,
                    useCenter = false,
                    topLeft = Offset(w * 0.40f, h * 0.64f),
                    size = Size(w * 0.20f, h * 0.12f),
                    style = stroke
                )
            }
        }
    }
}
