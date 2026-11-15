package com.bysqh.guru.feature.settings.presentation.component

/*
 * [二开] 动态背景渲染层（GIF / MP4）。
 *
 * 上游只支持静态图片背景，本文件补上动图与视频背景的绘制，供 MainActivity 的全局背景层按
 * BackgroundSettingsRepository.Kind 分发调用。刻意独立成文件，不修改上游既有渲染逻辑，
 * 便于后续 rebase/merge 上游代码（冲突面为 0）。
 *
 * 实现要点（对齐 VantaCode 2.0 的做法）：
 *  - GIF：android.graphics.Movie 解码整段动画，自己起一个 33ms 的帧循环，按 uptime 取模
 *    计算当前帧时间；用 Canvas 手绘并按「短边铺满 + 居中裁剪」缩放，效果等同 ContentScale.Crop。
 *  - MP4：TextureView + MediaPlayer，静音、循环、prepareAsync 后起播；随 Compose 生命周期销毁。
 */

import android.graphics.Movie
import android.graphics.SurfaceTexture
import android.media.MediaPlayer
import android.os.SystemClock
import android.view.Surface
import android.view.TextureView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.io.FileInputStream

/** GIF 帧循环间隔：约 30fps，够顺滑又不至于把主线程 Graphics 压满。 */
private const val GIF_FRAME_INTERVAL_MS = 33L

/** 动画时长兜底值：个别 GIF 头信息缺失会导致 duration() 返回 0，取模会崩。 */
private const val GIF_MIN_DURATION_MS = 100

/**
 * 将 [movie] 按「短边铺满 + 居中裁剪」画到当前画布，语义等同 Compose 的 [ContentScale.Crop]。
 *
 * @param timeMs 当前应显示的动画时间（毫秒），由调用方按总时长取模后传入。
 */
private fun DrawScope.drawMovieCrop(movie: Movie, timeMs: Int) {
    movie.setTime(timeMs)
    val movieWidth = movie.width().coerceAtLeast(1)
    val movieHeight = movie.height().coerceAtLeast(1)
    val scale = maxOf(size.width / movieWidth, size.height / movieHeight)
    val offsetX = (size.width - movieWidth * scale) / 2f
    val offsetY = (size.height - movieHeight * scale) / 2f
    drawContext.canvas.nativeCanvas.apply {
        save()
        translate(offsetX, offsetY)
        scale(scale, scale)
        movie.draw(this, 0f, 0f)
        restore()
    }
}

/**
 * GIF 动图背景。
 *
 * @param path 应用私有目录下的 GIF 绝对路径。
 * @param alpha 不透明度（与静态图共用同一套 0~0.2 的水印透明度）。
 * @param modifier 外层修饰符，通常无需传入。
 */
@Composable
internal fun GifBackgroundView(
    path: String,
    alpha: Float,
    modifier: Modifier = Modifier
) {
    // Movie 解码要读整段文件，放 IO 线程；解析失败则退化为「不显示背景」，不影响正文可读性。
    val movie by produceState<Movie?>(initialValue = null, path) {
        value = withContext(Dispatchers.IO) {
            runCatching {
                FileInputStream(path).use { Movie.decodeStream(it) }
            }.getOrNull()
        }
    }

    val current = movie ?: return
    val durationMs = current.duration().coerceAtLeast(GIF_MIN_DURATION_MS)
    var elapsedMs by remember(path) { mutableLongStateOf(0L) }

    LaunchedEffect(path, current) {
        val startedAt = SystemClock.uptimeMillis()
        while (true) {
            elapsedMs = SystemClock.uptimeMillis() - startedAt
            delay(GIF_FRAME_INTERVAL_MS)
        }
    }

    // 在 draw 阶段读取 elapsedMs：Compose 会记录这次状态读取并只重绘，不触发重组。
    Canvas(
        modifier = modifier
            .fillMaxSize()
            .alpha(alpha)
    ) {
        drawMovieCrop(current, (elapsedMs % durationMs).toInt())
    }
}

/**
 * MP4 视频背景：静音 + 循环播放，覆盖全屏。
 *
 * 用 TextureView（而非 SurfaceView）是为了能参与 Compose 的图层合成，透明度才能生效。
 *
 * @param path 应用私有目录下的 MP4 绝对路径。
 * @param alpha 不透明度（与静态图共用同一套 0~0.2 的水印透明度）。
 * @param modifier 外层修饰符，通常无需传入。
 */
@Composable
internal fun VideoBackgroundView(
    path: String,
    alpha: Float,
    modifier: Modifier = Modifier
) {
    // Surface 由 TextureView 的回调产出，MediaPlayer 依赖它才能出画面。
    var surface by remember(path) { mutableStateOf<Surface?>(null) }

    DisposableEffect(path, surface) {
        val target = surface
        if (target == null) {
            // 纹理还没就绪：先不建播放器，等回调把 surface 填进来后本效应会重跑。
            onDispose { }
        } else {
            val player = MediaPlayer()
            runCatching {
                player.setDataSource(path)
                player.setSurface(target)
                player.isLooping = true
                player.setVolume(0f, 0f)
                player.setOnPreparedListener { it.start() }
                // 解码失败时吞掉错误，避免 MediaPlayer 抛 ANR 级异常拖垮界面。
                player.setOnErrorListener { _, _, _ -> true }
                player.prepareAsync()
            }
            onDispose {
                runCatching {
                    player.stop()
                    player.release()
                }
            }
        }
    }

    DisposableEffect(path) {
        onDispose {
            surface?.release()
            surface = null
        }
    }

    AndroidView(
        factory = { context ->
            TextureView(context).apply {
                // 背景层只负责显示，不抢焦点、不拦截触摸，正文区域依旧可正常滚动点击。
                isFocusable = false
                isFocusableInTouchMode = false
                surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                    override fun onSurfaceTextureAvailable(
                        surfaceTexture: SurfaceTexture,
                        width: Int,
                        height: Int
                    ) {
                        surface = Surface(surfaceTexture)
                    }

                    override fun onSurfaceTextureSizeChanged(
                        surfaceTexture: SurfaceTexture,
                        width: Int,
                        height: Int
                    ) = Unit

                    override fun onSurfaceTextureDestroyed(surfaceTexture: SurfaceTexture): Boolean {
                        surface?.release()
                        surface = null
                        // true 表示由系统回收 SurfaceTexture，这里已先释放自建的 Surface。
                        return true
                    }

                    override fun onSurfaceTextureUpdated(surfaceTexture: SurfaceTexture) = Unit
                }
            }
        },
        modifier = modifier
            .fillMaxSize()
            .alpha(alpha)
    )
}
