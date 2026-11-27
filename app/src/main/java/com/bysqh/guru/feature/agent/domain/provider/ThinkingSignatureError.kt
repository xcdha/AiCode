package com.bysqh.guru.feature.agent.domain.provider

import com.bysqh.guru.core.util.UpstreamErrorBodyCarrier
import com.bysqh.guru.feature.agent.domain.model.AgentMessage
import com.bysqh.guru.feature.agent.domain.model.id
import retrofit2.HttpException

/**
 * Anthropic 400：回传的历史 thinking 块签名校验失败。
 *
 * [fromMessageId] 是报错消息在会话历史中的 id。上游把索引打码（如 `***.***.content.0`）
 * 或换了文案时无法定位，此时为 null，调用方应清空全部历史的 thinking 快照。
 */
class ThinkingSignatureInvalidException(
    val fromMessageId: String?,
    override val upstreamErrorBody: String,
    message: String,
    cause: Throwable? = null
) : IllegalStateException(message, cause), UpstreamErrorBodyCarrier

private val THINKING_SIGNATURE_MARKERS = listOf(
    "Invalid `signature` in `thinking` block",
    "Invalid signature in thinking block"
)

private val MESSAGE_POSITION = Regex("""messages\.(\d+)\.content\.(\d+)""")

/**
 * 从 400 响应体解析要清理的起始消息 id；不是签名错误时返回 null。
 * 识别只看文案，位置解析失败不影响降级（fromMessageId 为 null 表示清理全部）。
 */
internal fun thinkingSignatureError(
    body: String,
    sourceIds: List<String>,
    cause: Throwable? = null
): ThinkingSignatureInvalidException? {
    if (THINKING_SIGNATURE_MARKERS.none { body.contains(it) }) return null
    val messageIndex = MESSAGE_POSITION.find(body)?.groupValues?.get(1)?.toIntOrNull()
    return ThinkingSignatureInvalidException(
        fromMessageId = messageIndex?.let { sourceIds.getOrNull(it) },
        upstreamErrorBody = body,
        message = "thinking 块签名校验失败（400）",
        cause = cause
    )
}

/**
 * 判断一次 HTTP 失败是否为 thinking 签名错误。
 * 读取一次错误体并随异常保留原文，供后续错误日志使用。
 */
internal fun Throwable.asThinkingSignatureInvalid(sourceIds: List<String>): ThinkingSignatureInvalidException? {
    if (this !is HttpException || code() != 400) return null
    val body = extractRawErrorBody() ?: return null
    return thinkingSignatureError(body, sourceIds, cause = this)
}

/** 清除目标历史消息及之后所有 assistant 消息的 thinking 签名快照。 */
internal fun stripThinkingSnapshots(
    messages: List<AgentMessage>,
    fromMessageId: String?
): Pair<List<AgentMessage>, List<String>> {
    val start = fromMessageId
        ?.let { id -> messages.indexOfFirst { it.id == id } }
        ?.takeIf { it >= 0 }
        ?: 0
    val changedIds = mutableListOf<String>()
    val stripped = messages.mapIndexed { index, message ->
        if (
            index >= start &&
            message is AgentMessage.AssistantMessage &&
            (message.signature.isNotEmpty() || message.thinkingBlocksJson.isNotEmpty())
        ) {
            changedIds.add(message.id)
            message.copy(signature = "", thinkingBlocksJson = "")
        } else {
            message
        }
    }
    return stripped to changedIds
}