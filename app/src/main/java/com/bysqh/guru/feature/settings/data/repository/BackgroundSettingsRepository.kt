package com.bysqh.guru.feature.settings.data.repository

import android.content.Context
import android.net.Uri
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.bysqh.guru.core.datastore.preferencesCorruptionHandler
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext
import java.io.File
import java.util.Locale
import javax.inject.Inject
import javax.inject.Singleton

private val Context.backgroundDataStore by preferencesDataStore(
    name = "background_prefs",
    corruptionHandler = preferencesCorruptionHandler
)

/**
 * 全局自定义背景：媒体文件拷贝到应用私有目录持久化（不依赖 content URI 授权），
 * 透明度、文件路径与背景类型存 DataStore。路径为 null 表示未设置背景。
 *
 * [二开] 在上游「静态图片」的基础上扩展出 GIF / MP4 两种动态背景（见 [Kind]），
 * 新增字段全部独立命名，不改动上游既有 key 的语义，便于后续同步上游代码。
 */
@Singleton
class BackgroundSettingsRepository @Inject constructor(
    @param:ApplicationContext private val context: Context
) {
    /**
     * 背景类型。上游只有静态图片，这里按 MIME 把背景分成三类，渲染时各走各的实现：
     * [IMAGE] 位图直接绘制，[GIF] 走 Movie 逐帧绘制，[MP4] 走 TextureView + MediaPlayer。
     */
    enum class Kind {
        IMAGE,
        GIF,
        MP4
    }

    companion object {
        const val DEFAULT_ALPHA = 0.15f
        /** 顶层水印模式下透明度上限：超过会盖住文字影响可读性。 */
        const val MAX_ALPHA = 0.2f
        /** 最小透明度：0 表示完全透明（背景不可见）。 */
        const val MIN_ALPHA = 0f
        private val IMAGE_PATH_KEY = stringPreferencesKey("background_image_path")
        private val ALPHA_KEY = floatPreferencesKey("background_alpha")

        /** [二开] 背景类型键；历史数据没有该键时按 [Kind.IMAGE] 兜底，老用户无感升级。 */
        private val IMAGE_KIND_KEY = stringPreferencesKey("background_image_kind")

        /** [二开] 背景亮度键：静态图/GIF/MP4 共用。默认 1.0 表示不做亮度调整。 */
        private val BRIGHTNESS_KEY = floatPreferencesKey("background_brightness")
        /** 亮度下限：太暗看不见，给用户留一点下限保护。 */
        const val MIN_BRIGHTNESS = 0.2f
        /** 亮度上限：允许提亮，但太高会让背景盖过正文可读性。 */
        const val MAX_BRIGHTNESS = 1.8f
        /** 亮度默认值：1.0 = 原图亮度（配合透明度滑块使用）。 */
        const val DEFAULT_BRIGHTNESS = 1.0f

        /** 把 UI 百分比（0~100）线性映射为实际透明度（0~MAX_ALPHA）。 */
        fun sliderToAlpha(percent: Float): Float =
            MAX_ALPHA * (percent / 100f).coerceIn(0f, 1f)

        /** 把实际透明度反映射为 UI 百分比（0~100）。 */
        fun alphaToSlider(alpha: Float): Float =
            (alpha / MAX_ALPHA).coerceIn(0f, 1f) * 100f

        /**
         * [二开] 把 UI 百分比（0~100）映射为亮度（[MIN_BRIGHTNESS]~[MAX_BRIGHTNESS]）。
         * 50% 即 1.0（原亮度），与透明度滑块的线性映射保持同一套手感。
         */
        fun sliderToBrightness(percent: Float): Float =
            MIN_BRIGHTNESS + (MAX_BRIGHTNESS - MIN_BRIGHTNESS) * (percent / 100f).coerceIn(0f, 1f)

        /** [二开] 把实际亮度反映射为 UI 百分比（0~100）。 */
        fun brightnessToSlider(brightness: Float): Float =
            ((brightness - MIN_BRIGHTNESS) / (MAX_BRIGHTNESS - MIN_BRIGHTNESS)
                .coerceIn(0f, 1f)) * 100f

        /**
         * [二开] MIME 转背景类型：只认 GIF 与 MP4 两种动态格式，其余一律按静态图片处理。
         * 部分来源（如某些文件管理器）给不出 MIME，此时 [mime] 为 null，同样按静态图片兜底。
         */
        fun mimeToKind(mime: String?): Kind = when (mime?.lowercase(Locale.ROOT)) {
            "image/gif" -> Kind.GIF
            "video/mp4" -> Kind.MP4
            else -> Kind.IMAGE
        }
    }

    /** 当前背景图文件绝对路径；null 表示未设置。 */
    val imagePathFlow: Flow<String?> = context.backgroundDataStore.data.map { it[IMAGE_PATH_KEY] }

    /** 背景图不透明度（0.05~0.2，顶层水印保证文字可读）。 */
    val alphaFlow: Flow<Float> = context.backgroundDataStore.data.map {
        (it[ALPHA_KEY] ?: DEFAULT_ALPHA).coerceIn(MIN_ALPHA, MAX_ALPHA)
    }

    /** [二开] 当前背景类型；键缺失或值无法识别时按静态图片处理。 */
    val kindFlow: Flow<Kind> = context.backgroundDataStore.data.map { prefs ->
        prefs[IMAGE_KIND_KEY]
            ?.let { name -> Kind.entries.firstOrNull { it.name == name } }
            ?: Kind.IMAGE
    }

    /**
     * [二开] 背景亮度（0.2~1.8，1.0 = 原亮度）。
     * 透明度决定背景「有多淡」，亮度决定背景「有多亮」，两者相乘才是最终效果；
     * 之前只有透明度，默认 15% 叠加在浅色图上就会显得发暗。
     */
    val brightnessFlow: Flow<Float> = context.backgroundDataStore.data.map {
        (it[BRIGHTNESS_KEY] ?: DEFAULT_BRIGHTNESS).coerceIn(MIN_BRIGHTNESS, MAX_BRIGHTNESS)
    }

    /**
     * 选择新背景：把 [uri] 拷贝到私有目录 backgrounds/ 后替换旧文件。
     * 先写新文件成功再更新 DataStore，失败时旧背景保持不变。
     *
     * @param mime 选择器返回的 MIME；为空时回退到 ContentResolver 查询，再失败按静态图片处理。
     *   [二开] 该参数用于判定背景类型（图片 / GIF / MP4），上游只有静态图片时无此参数。
     */
    suspend fun setBackgroundImage(uri: Uri, mime: String? = null) {
        val resolvedMime = mime ?: runCatching { context.contentResolver.getType(uri) }.getOrNull()
        val extension = extensionFor(resolvedMime)
        val target = File(context.filesDir, "backgrounds/bg_${System.currentTimeMillis()}.$extension")
        target.parentFile?.mkdirs()
        val copied = withContext(Dispatchers.IO) {
            runCatching {
                context.contentResolver.openInputStream(uri)?.use { input ->
                    target.outputStream().use { output -> input.copyTo(output) }
                }
                target.length() > 0
            }.getOrDefault(false)
        }
        if (!copied) return
        val oldPath = context.backgroundDataStore.data.first()[IMAGE_PATH_KEY]
        context.backgroundDataStore.edit {
            it[IMAGE_PATH_KEY] = target.absolutePath
            it[IMAGE_KIND_KEY] = mimeToKind(resolvedMime).name
        }
        oldPath?.let { runCatching { File(it).delete() } }
    }

    /** 移除背景：删媒体文件并清路径与类型。 */
    suspend fun clearBackground() {
        val oldPath = context.backgroundDataStore.data.first()[IMAGE_PATH_KEY]
        context.backgroundDataStore.edit {
            it.remove(IMAGE_PATH_KEY)
            it.remove(IMAGE_KIND_KEY)
        }
        oldPath?.let { runCatching { File(it).delete() } }
    }

    suspend fun setBackgroundAlpha(alpha: Float) {
        context.backgroundDataStore.edit {
            it[ALPHA_KEY] = alpha.coerceIn(MIN_ALPHA, MAX_ALPHA)
        }
    }

    /**
     * 按 MIME 决定落盘扩展名。[二开] 比上游多了 gif / mp4 两种，
     * 播放器与 Movie 解码都依赖扩展名之外的容器头，这里取名只为可读性。
     */
    /** [二开] 设置背景亮度；直接落盘（滑块拖动由 ViewModel 侧节流）。 */
    suspend fun setBackgroundBrightness(brightness: Float) {
        context.backgroundDataStore.edit {
            it[BRIGHTNESS_KEY] = brightness.coerceIn(MIN_BRIGHTNESS, MAX_BRIGHTNESS)
        }
    }

    private fun extensionFor(mime: String?): String = when (mime?.lowercase(Locale.ROOT)) {
        "image/png" -> "png"
        "image/webp" -> "webp"
        "image/gif" -> "gif"
        "video/mp4" -> "mp4"
        else -> "jpg"
    }
}
