package com.bysqh.guru.feature.agent.domain.provider

import com.bysqh.guru.core.util.UpstreamErrorBodyCarrier
import com.google.gson.JsonParser
import retrofit2.HttpException

/**
 * [enrichWithHttpErrorBody] 产出的异常：`message` 为「HTTP <code>: <detail>」可读文案，
 * [upstreamErrorBody] 保留上游错误响应体原文全文，供 [com.bysqh.guru.core.util.AILogger] 完整落盘。
 */
class EnrichedHttpException(
    message: String,
    val statusCode: Int,
    override val upstreamErrorBody: String?,
    cause: Throwable
) : IllegalStateException(message, cause), UpstreamErrorBodyCarrier

/**
 * 把上游返回的 HTTP 错误转换成带**响应体**的异常，便于用户定位 4xx/5xx 的真实原因。
 *
 * Retrofit 的 [HttpException] 默认 message 只有 `"HTTP 400 Bad Request"` 这类状态码描述，
 * 服务端写在响应体里的具体原因（如 `model not found`、`invalid api key`、`Invalid value for tools`）
 * 不会被读出，用户只看到一句没用的状态码。这里把 errorBody 读出来拼到 message 里，
 * 原异常作为 cause 保留，并让产出异常携带原始响应体原文供日志完整记录。
 *
 * 注意：errorBody 只能读一次，调用后即被消费。
 */
fun Throwable.enrichWithHttpErrorBody(): Throwable {
    if (this !is HttpException) return this
    val raw = (this as? UpstreamErrorBodyCarrier)?.upstreamErrorBody ?: extractRawErrorBody()
    val detail = extractHttpErrorDetail(raw)
    val composed = if (detail.isBlank()) {
        message() ?: "HTTP ${code()}"
    } else {
        "HTTP ${code()}: $detail"
    }
    return EnrichedHttpException(composed, code(), raw, this)
}

/** One-shot Retrofit error bodies are cached so classification and later error logging share the same response. */
private val consumedErrorBodies = java.util.WeakHashMap<Throwable, String>()

/** Read the raw [HttpException] error body once; non-HTTP errors and empty bodies return null. */
internal fun Throwable.extractRawErrorBody(): String? {
    if (this !is HttpException) return null
    synchronized(consumedErrorBodies) { consumedErrorBodies[this] }?.let { return it }
    val raw = runCatching { response()?.errorBody()?.string()?.trim() }
        .getOrNull()
        ?.takeIf { it.isNotBlank() }
        ?: return null
    synchronized(consumedErrorBodies) { consumedErrorBodies[this] = raw }
    return raw
}

/**
 * 从错误响应体原文抽出可读 detail：优先 `error.message` / 顶层 `message`，否则回退原文。
 * 解析失败（非 JSON 等）时回退原文前 500 字符，避免整段 HTML 撑爆日志与提示。
 */
internal fun extractHttpErrorDetail(raw: String?): String {
    if (raw.isNullOrBlank()) return ""
    val body = runCatching {
        // 常见格式：{"error":{"message":"...","type":"..."}} 或 {"message":"..."}；尽量抽出可读文本。
        val obj = JsonParser.parseString(raw).asJsonObject
        obj.get("error")?.takeIf { it.isJsonObject }?.asJsonObject?.get("message")?.asString
            ?: obj.get("message")?.asString
            ?: raw
    }.getOrNull().orEmpty()
    return if (body.isBlank()) raw.trim().take(500) else body
}
