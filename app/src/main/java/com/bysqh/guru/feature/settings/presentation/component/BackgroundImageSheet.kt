package com.bysqh.guru.feature.settings.presentation.component

import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import com.bysqh.guru.core.ui.AdaptiveModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.bysqh.guru.R
import com.bysqh.guru.core.theme.Spacing
import com.bysqh.guru.feature.settings.data.repository.BackgroundSettingsRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import com.bysqh.guru.core.ui.AppButton

/**
 * [二开] 取视频首帧作为预览缩略图，失败返回 null。
 * 仅用于设置弹窗里的预览图，与全局背景的播放链路无关。
 */
internal fun decodeBackgroundVideoFrame(path: String): ImageBitmap? = runCatching {
    val retriever = MediaMetadataRetriever()
    try {
        retriever.setDataSource(path)
        // 取首帧；部分编码在 0 位置取不到帧时退到 0.1s 处再试一次。
        val frame = retriever.getFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
            ?: retriever.getFrameAtTime(100_000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
        frame?.asImageBitmap()
    } finally {
        runCatching { retriever.release() }
    }
}.getOrNull()

/**
 * 按目标尺寸采样解码背景图（inSampleSize 2 的幂缩放，控制峰值内存），失败返回 null。
 * 全局背景层与设置弹窗缩略图共用。
 */
internal fun decodeBackgroundBitmap(path: String, maxWidth: Int, maxHeight: Int): ImageBitmap? =
    runCatching {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(path, bounds)
        var sample = 1
        while (bounds.outWidth / sample > maxWidth * 2 || bounds.outHeight / sample > maxHeight * 2) {
            sample *= 2
        }
        val opts = BitmapFactory.Options().apply { inSampleSize = sample }
        BitmapFactory.decodeFile(path, opts)?.asImageBitmap()
    }.getOrNull()

/**
 * 自定义背景设置弹窗：缩略图预览 + 透明度滑块 + 选图/选视频/移除。
 *
 * @param imagePath 当前背景文件路径，null 表示未设置。
 * @param kind 当前背景类型（[二开] 静态图 / GIF / MP4），决定缩略图的取帧方式。
 * @param alpha 当前透明度（0.05~1.0）。
 * @param onPickImage 用户选定媒体后回调，携带 MIME（可能为 null）供上层判定背景类型。
 * @param onAlphaChange 透明度变化回调（写 DataStore，全局背景随之变化；落盘节流在 ViewModel 侧）。
 * @param onRemove 移除背景回调。
 * @param onDismiss 关闭弹窗。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun BackgroundImageSheet(
    imagePath: String?,
    kind: BackgroundSettingsRepository.Kind,
    alpha: Float,
    onPickImage: (Uri, String?) -> Unit,
    onAlphaChange: (Float) -> Unit,
    onRemove: () -> Unit,
    onDismiss: () -> Unit
) {
    val sheetState = rememberModalBottomSheetState()
    val context = LocalContext.current
    val imagePicker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia()
    ) { uri ->
        if (uri != null) {
            val mime = runCatching { context.contentResolver.getType(uri) }.getOrNull()
            onPickImage(uri, mime)
        }
    }

    // 缩略图预览：按屏幕宽度采样，避免大图全量解码；MP4 取首帧。
    val previewBitmap by produceState<ImageBitmap?>(initialValue = null, imagePath, kind) {
        value = imagePath?.let { path ->
            withContext(Dispatchers.IO) {
                when (kind) {
                    BackgroundSettingsRepository.Kind.MP4 -> decodeBackgroundVideoFrame(path)
                    else -> decodeBackgroundBitmap(path, 1024, 1024)
                }
            }
        }
    }

    // 滑块位置由本地状态驱动：直接绑外部 alpha 会让每次拖动都走「写 DataStore → 回读 → 整个设置页重组」
    // 的往返，滑块因此跟不上手指。弹窗每次打开都重建，初值取当前设置即可。
    var sliderPercent by remember { mutableFloatStateOf(BackgroundSettingsRepository.alphaToSlider(alpha)) }

    AdaptiveModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = MaterialTheme.colorScheme.surface
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = Spacing.lg)
                .padding(bottom = Spacing.xl)
        ) {
            Text(
                text = stringResource(R.string.settings_background_image),
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(bottom = Spacing.md)
            )

            // [二开] 说明支持的媒体类型，避免用户以为只能选静态图。
            Text(
                text = stringResource(R.string.settings_background_image_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(bottom = Spacing.md)
            )

            if (previewBitmap != null) {
                Image(
                    bitmap = previewBitmap!!,
                    contentDescription = stringResource(R.string.settings_background_image),
                    contentScale = ContentScale.Crop,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(160.dp)
                        .clip(RoundedCornerShape(12.dp))
                )
                Spacer(Modifier.height(Spacing.lg))
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = androidx.compose.ui.Alignment.CenterVertically
            ) {
                Text(
                    text = stringResource(R.string.settings_background_image_alpha),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f)
                )
                Text(
                    text = "${sliderPercent.toInt()}%",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurface
                )
            }
            Slider(
                value = sliderPercent,
                onValueChange = { percent ->
                    sliderPercent = percent
                    onAlphaChange(BackgroundSettingsRepository.sliderToAlpha(percent))
                },
                valueRange = 0f..100f
            )



            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = Spacing.sm),
                horizontalArrangement = Arrangement.spacedBy(Spacing.md)
            ) {
                AppButton(
                    onClick = {
                        imagePicker.launch(
                            // [二开] 放开视频选择，GIF 属于图片由系统分类，MP4 属于视频。
                            PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)
                        )
                    },
                    modifier = Modifier.weight(1f)
                ) {
                    Text(stringResource(R.string.settings_background_image_pick))
                }
                OutlinedButton(
                    onClick = {
                        onRemove()
                        onDismiss()
                    },
                    enabled = imagePath != null,
                    modifier = Modifier.weight(1f)
                ) {
                    Text(stringResource(R.string.settings_background_image_remove))
                }
            }
        }
    }
}
