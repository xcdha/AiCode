package com.bysqh.guru.feature.agent.domain.provider

import com.bysqh.guru.core.util.UpstreamErrorBodyCarrier
import com.bysqh.guru.feature.agent.domain.model.AgentMessage
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response

class ThinkingSignatureErrorTest {

    private val sourceIds = List(30) { "m$it" }

    @Test
    fun parses_message_position_and_maps_to_source_id() {
        val body = """{"error":{"type":"invalid_request_error","message":"messages.19.content.0: Invalid `signature` in `thinking` block (request_id: chatcmpl-x)"}}"""

        val error = thinkingSignatureError(body, sourceIds)

        assertNotNull(error)
        assertEquals("m19", error!!.fromMessageId)
    }

    @Test
    fun falls_back_to_strip_all_when_upstream_masks_position() {
        val body = """{"error":{"message":"***.***.content.0: Invalid `signature` in `thinking` block"}}"""

        val error = thinkingSignatureError(body, sourceIds)

        assertNotNull(error)
        assertNull(error!!.fromMessageId)
    }

    @Test
    fun ignores_other_400_bodies() {
        val body = """{"error":{"message":"thinking.type.disabled is not supported for this model"}}"""

        assertNull(thinkingSignatureError(body, sourceIds))
    }

    @Test
    fun httpErrorProducesRecoverableExceptionAndPreservesBody() {
        val raw = """{"error":{"message":"messages.2.content.0: Invalid `signature` in `thinking` block"}}"""
        val http = HttpException(Response.error<Any>(400, raw.toResponseBody(null)))

        val converted = http.asThinkingSignatureInvalid(sourceIds)

        assertNotNull(converted)
        assertEquals("m2", converted!!.fromMessageId)
        assertSame(http, converted.cause)
        assertFalse(isRetriableNetworkError(converted))
        assertTrue(converted is UpstreamErrorBodyCarrier)
        assertEquals(raw, (converted as UpstreamErrorBodyCarrier).upstreamErrorBody)
        assertSame(converted, converted.enrichWithHttpErrorBody())
        assertEquals(raw, (converted as UpstreamErrorBodyCarrier).upstreamErrorBody)
        assertEquals(raw, http.extractRawErrorBody())
    }

    @Test
    fun stripThinkingSnapshotsClearsFromMappedMessageButKeepsDisplayedReasoning() {
        val messages = listOf(
            AgentMessage.UserMessage(id = "user-1", content = "first"),
            AgentMessage.AssistantMessage(
                id = "assistant-1", content = "answer", reasoning = "visible reasoning",
                signature = "sig-1", thinkingBlocksJson = "[{\"type\":\"thinking\"}]"
            ),
            AgentMessage.UserMessage(id = "user-2", content = "second"),
            AgentMessage.AssistantMessage(
                id = "assistant-2", content = "answer 2", signature = "sig-2", thinkingBlocksJson = "snapshot-2"
            )
        )

        val (stripped, ids) = stripThinkingSnapshots(messages, "user-2")

        assertEquals(listOf("assistant-2"), ids)
        assertEquals("sig-1", (stripped[1] as AgentMessage.AssistantMessage).signature)
        val changed = stripped[3] as AgentMessage.AssistantMessage
        assertEquals("", changed.signature)
        assertEquals("", changed.thinkingBlocksJson)
        assertEquals("answer 2", changed.content)
    }

    @Test
    fun stripThinkingSnapshotsClearsAllWhenMessagePositionCannotBeMapped() {
        val messages = listOf(
            AgentMessage.AssistantMessage(id = "a1", content = "one", signature = "sig-1"),
            AgentMessage.AssistantMessage(id = "a2", content = "two", thinkingBlocksJson = "snapshot")
        )

        val (stripped, ids) = stripThinkingSnapshots(messages, "missing")

        assertEquals(listOf("a1", "a2"), ids)
        assertTrue(stripped.filterIsInstance<AgentMessage.AssistantMessage>().all {
            it.signature.isEmpty() && it.thinkingBlocksJson.isEmpty()
        })
    }

    @Test
    fun falls_back_when_index_out_of_range() {
        val body = """messages.999.content.0: Invalid `signature` in `thinking` block"""

        val error = thinkingSignatureError(body, sourceIds)

        assertNotNull(error)
        assertNull(error!!.fromMessageId)
    }
}