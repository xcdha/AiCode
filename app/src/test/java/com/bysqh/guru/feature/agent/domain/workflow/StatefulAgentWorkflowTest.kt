package com.bysqh.guru.feature.agent.domain.workflow

import android.os.SystemClock
import com.bysqh.guru.feature.agent.domain.model.AgentContext
import com.bysqh.guru.feature.agent.domain.model.AgentMessage
import com.bysqh.guru.feature.agent.domain.prompt.SystemPromptProvider
import com.bysqh.guru.feature.agent.domain.provider.AIProvider
import com.bysqh.guru.feature.agent.domain.provider.AIResponse
import com.bysqh.guru.feature.agent.domain.provider.AIStreamChunk
import com.bysqh.guru.feature.agent.domain.provider.ThinkingSignatureInvalidException
import com.bysqh.guru.feature.agent.domain.session.MessagePersistenceUseCase
import com.bysqh.guru.feature.agent.domain.provider.ProviderInstanceFactory
import com.bysqh.guru.feature.agent.domain.provider.RetryErrorInfo
import com.bysqh.guru.feature.agent.domain.provider.RetryErrorKind
import com.bysqh.guru.feature.agent.domain.tool.ToolCall
import com.bysqh.guru.feature.agent.domain.tool.ToolRegistry
import com.bysqh.guru.feature.settings.data.remote.ModelMetadataService
import com.bysqh.guru.feature.settings.data.repository.CompactionModelSettingsRepository
import com.bysqh.guru.feature.settings.data.repository.DefaultModelSettingsRepository
import com.bysqh.guru.feature.settings.domain.model.AIProviderConfig
import com.bysqh.guru.feature.settings.domain.model.ModelMetadata
import com.bysqh.guru.feature.settings.domain.model.ProviderType
import com.bysqh.guru.feature.settings.domain.repository.AIProviderRepository
import io.mockk.coEvery
import io.mockk.every
import io.mockk.mockk
import io.mockk.mockkStatic
import io.mockk.unmockkStatic
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class StatefulAgentWorkflowTest {
    private val tools = mockk<ToolRegistry>()
    private val providers = mockk<AIProviderRepository>()
    private val factory = mockk<ProviderInstanceFactory>()
    private val prompts = mockk<SystemPromptProvider>()
    private val compactor = mockk<ContextCompactor>()
    private val metadata = mockk<ModelMetadataService>()
    private val compactionSettings = mockk<CompactionModelSettingsRepository>()
    private val defaultSettings = mockk<DefaultModelSettingsRepository>()
    private val provider = mockk<AIProvider>(relaxed = true)
    private val context = AgentContext(null, null, "/workspace", null)
    private val hooks = mockk<com.bysqh.guru.feature.plugin.runtime.PluginHookDispatcher>(relaxed = true)
    private val checkpoints = mockk<com.bysqh.guru.feature.agent.domain.checkpoint.CheckpointManager>(relaxed = true)
    private val outputStore = mockk<com.bysqh.guru.feature.agent.domain.tool.ToolOutputStore>(relaxed = true)
    private val policy = mockk<com.bysqh.guru.feature.agent.domain.permission.ToolPermissionPolicyEngine>(relaxed = true)
    private val sessions = mockk<com.bysqh.guru.feature.agent.domain.session.SessionUseCase>(relaxed = true)
    private val messagePersistence = mockk<MessagePersistenceUseCase>(relaxed = true)
    private val planApprovalManager = mockk<com.bysqh.guru.feature.agent.domain.tool.mode.PlanApprovalManager>(relaxed = true)
    private val notificationCenter = mockk<com.bysqh.guru.feature.agent.domain.notification.AgentNotificationCenter>(relaxed = true)
    private val eventInjector = mockk<com.bysqh.guru.feature.agent.domain.notification.AgentEventInjector>(relaxed = true)
    private val workflow = StatefulAgentWorkflow(
        toolRegistry = tools,
        aiProviderRepository = providers,
        providerFactory = factory,
        promptProvider = prompts,
        permissionManager = mockk(relaxed = true),
        policyEngine = policy,
        contextCompactor = compactor,
        planApprovalManager = planApprovalManager,
        toolOutputStore = outputStore,
        modelMetadataService = metadata,
        compactionModelSettingsRepository = compactionSettings,
        titleModelSettingsRepository = mockk(relaxed = true),
        defaultModelSettingsRepository = defaultSettings,
        sessionUseCase = sessions,
        messagePersistenceUseCase = messagePersistence,
        checkpointManager = checkpoints,
        llmCallRecordDao = mockk(relaxed = true),
        agentNotificationCenter = notificationCenter,
        eventInjector = eventInjector,
        fileAccess = mockk(relaxed = true),
        pluginHookDispatcher = hooks,
        appContext = mockk(relaxed = true)
    )

    @Before
    fun prepare() {
        mockkStatic(SystemClock::class)
        every { SystemClock.elapsedRealtime() } returns 1_000L
        every { tools.getTool(any()) } returns null
        every { prompts.build(any()) } returns "system"
        every { provider.providerId } returns "provider"
        every { provider.model } returns "model"
        val config = AIProviderConfig(
            id = "provider", name = "Provider", type = ProviderType.OPENAI,
            apiKey = "test-key", baseUrl = "", defaultModel = "model", models = listOf("model")
        )
        coEvery { defaultSettings.getDefaultProviderId() } returns config.id
        coEvery { defaultSettings.getDefaultModel() } returns config.defaultModel
        coEvery { providers.getProviderById(config.id) } returns config
        coEvery { factory.create(any(), any()) } returns provider
        coEvery { compactionSettings.getCompactionProviderId() } returns ""
        coEvery { metadata.resolve(any(), any(), any()) } returns ModelMetadata(id = "model", contextTokens = 128_000)
        coEvery {
            compactor.compactIfNeeded(any(), any(), any(), any(), any(), any(), any(), any(), any(), any())
        } answers { CompactionResult(firstArg(), compacted = false) }
    }

    @After
    fun tearDown() {
        unmockkStatic(SystemClock::class)
    }

    private suspend fun collectEvents(runContext: AgentContext = context): List<AgentEvent> {
        val events = mutableListOf<AgentEvent>()
        workflow.executeEvents("request", runContext, emptyList()).collect { event ->
            events.add(event)
            when (event) {
                is AgentEvent.AssistantText -> event.persisted?.complete(Unit)
                is AgentEvent.ToolCallFinished -> event.persisted?.complete(Unit)
                else -> Unit
            }
        }
        return events
    }

    @Test
    fun delegatedWriteUsesFinalPermissionsAndSkipsLocalExecutionAndCheckpoint() = runTest {
        val tool = mockk<com.bysqh.guru.feature.agent.domain.tool.AgentTool>(relaxed = true)
        every { tool.name } returns "writeFile"
        every { tools.getTool("writeFile") } returns tool
        coEvery { sessions.getSessionById(any()) } returns null
        val finalArgs = kotlinx.serialization.json.JsonObject(mapOf("path" to kotlinx.serialization.json.JsonPrimitive("remote.txt")))
        coEvery { hooks.beforeToolCall(any(), any(), any(), any(), any(), any(), any(), any()) } answers {
            com.bysqh.guru.feature.plugin.runtime.ToolBeforeHookResult(
                arguments = finalArgs,
                delegation = com.bysqh.guru.feature.plugin.runtime.ToolDelegation(
                    mockk(relaxed = true), "1", "remote", arg(1), arg(2), "writeFile", "execution"
                )
            )
        }
        coEvery { policy.evaluate(tool, "writeFile", any(), any()) } returns
            com.bysqh.guru.feature.agent.domain.permission.ToolPermissionPolicyEngine.EvalResult(
                com.bysqh.guru.feature.agent.domain.permission.ToolPermissionPolicyEngine.Verdict.ALLOW, emptyList()
            )
        coEvery { hooks.executeDelegatedTool(any(), any(), any(), any(), any(), any()) } returns
            com.bysqh.guru.feature.agent.domain.tool.ToolResult.Error("remote failed", "REMOTE_FAILED")
        every { outputStore.process(any(), any(), any()) } answers { thirdArg() }
        every { provider.completeStream(any(), any(), any(), any()) } returnsMany listOf(
            flowOf(AIStreamChunk.Final(AIResponse("", toolCalls = listOf(ToolCall("call", "writeFile", emptyMap()))))),
            flowOf(AIStreamChunk.Final(AIResponse("done")))
        )
        val events = collectEvents(context.copy(sessionId = "session"))
        assertTrue(events.filterIsInstance<AgentEvent.ToolCallFinished>().single().isError)
        io.mockk.coVerify(exactly = 1) { policy.evaluate(tool, "writeFile", finalArgs, any()) }
        io.mockk.coVerify(exactly = 1) { hooks.executeDelegatedTool(any(), any(), "call", "writeFile", finalArgs, any()) }
        io.mockk.coVerify(exactly = 0) { tool.executeWithContext(any(), any()) }
        io.mockk.coVerify(exactly = 0) { checkpoints.beforeFileModified(any(), any()) }
    }

    @Test
    fun toolCycleKeepsStreamAndPersistedIdsAndCreatesNewIdForNextCall() = runTest {
        val requests = mutableListOf<List<AgentMessage>>()
        val toolCall = ToolCall("call", "readFile", emptyMap())
        every { provider.completeStream(any(), capture(requests), any(), any()) } returnsMany listOf(
            flowOf(
                AIStreamChunk.ReasoningDelta("thinking"),
                AIStreamChunk.TextDelta("checking"),
                AIStreamChunk.ToolCallDeclared(toolCall.name),
                AIStreamChunk.Final(AIResponse("checking", toolCalls = listOf(toolCall)))
            ),
            flowOf(
                AIStreamChunk.ReasoningDelta("done thinking"),
                AIStreamChunk.TextDelta("done"),
                AIStreamChunk.Final(AIResponse("done"))
            )
        )

        val events = collectEvents()
        val responses = events.filterIsInstance<AgentEvent.AssistantText>()
        val textDeltas = events.filterIsInstance<AgentEvent.AssistantDelta>()
        val reasoningDeltas = events.filterIsInstance<AgentEvent.ReasoningDelta>()

        assertEquals(2, responses.size)
        assertEquals(responses.map { it.messageId }, textDeltas.map { it.messageId })
        assertEquals(responses.map { it.messageId }, reasoningDeltas.map { it.messageId })
        assertTrue(responses.all { it.messageId.isNotBlank() })
        assertNotEquals(responses[0].messageId, responses[1].messageId)
        assertEquals(listOf(toolCall), responses[0].toolCalls)
        val replayed = requests[1].filterIsInstance<AgentMessage.AssistantMessage>().single()
        assertEquals(responses[0].messageId, replayed.id)
        assertEquals("thinking", replayed.reasoning)
        assertTrue(events.last() is AgentEvent.Completed)
    }

    @Test
    fun turnPersistenceReceivesReasoningTtfbCacheWriteAndRetryStats() = runTest {
        var now = 1_000L
        every { SystemClock.elapsedRealtime() } answers { now }
        val recorded = mutableListOf<LlmCallStats>()
        val persistence = object : TurnPersistence by TurnPersistence.Noop {
            override suspend fun recordLlmCall(stats: LlmCallStats) {
                recorded += stats
            }
        }
        val turn = WorkflowTurnContext(
            runId = "run",
            sessionRef = SessionRef.Room("session"),
            providerId = "provider",
            model = "model",
            workflowState = null,
            permissionMode = com.bysqh.guru.feature.agent.domain.model.AgentMode.BUILD,
            persistence = persistence
        )
        every { provider.completeStream(any(), any(), any(), any()) } returns flow {
            emit(AIStreamChunk.Retrying(1, 3, RetryErrorInfo(RetryErrorKind.UNKNOWN)))
            now = 1_042L
            emit(AIStreamChunk.Final(AIResponse(
                content = "done",
                inputTokens = 10,
                outputTokens = 5,
                cachedInputTokens = 2,
                cacheCreationTokens = 4
            )))
        }

        collectEvents(context.copy(sessionId = "session", reasoningEffort = "high", turn = turn))

        val stats = recorded.single()
        assertEquals("high", stats.reasoningEffort)
        assertEquals("effort=high", stats.reasoningWire)
        assertEquals(42, stats.ttfbMillis)
        assertEquals(4, stats.cacheCreationTokens)
        assertEquals(1, stats.retryCount)
    }

    @Test
    fun retryAndKeySwitchKeepResponseIdWhileResettingAccumulatedContent() = runTest {
        every { provider.completeStream(any(), any(), any(), any()) } returns flowOf(
            AIStreamChunk.ReasoningDelta("old thinking"),
            AIStreamChunk.TextDelta("old text"),
            AIStreamChunk.Retrying(1, 3, RetryErrorInfo(RetryErrorKind.UNKNOWN)),
            AIStreamChunk.ReasoningDelta("retry thinking"),
            AIStreamChunk.TextDelta("retry text"),
            AIStreamChunk.KeySwitched(2, 2),
            AIStreamChunk.ReasoningDelta("final thinking"),
            AIStreamChunk.TextDelta("final text"),
            AIStreamChunk.Final(AIResponse("final text"))
        )

        val events = collectEvents()
        val response = events.filterIsInstance<AgentEvent.AssistantText>().single()
        val textDeltas = events.filterIsInstance<AgentEvent.AssistantDelta>()
        val reasoningDeltas = events.filterIsInstance<AgentEvent.ReasoningDelta>()

        assertEquals(listOf("old text", "retry text", "final text"), textDeltas.map { it.accumulated })
        assertEquals(listOf("old thinking", "retry thinking", "final thinking"), reasoningDeltas.map { it.accumulated })
        assertTrue(textDeltas.all { it.messageId == response.messageId })
        assertTrue(reasoningDeltas.all { it.messageId == response.messageId })
        assertEquals("final text", response.content)
        assertEquals("final thinking", response.reasoning)
        assertEquals(1, events.filterIsInstance<AgentEvent.Retrying>().size)
        assertEquals(1, events.filterIsInstance<AgentEvent.KeySwitched>().size)
    }

    @Test
    fun thinkingSignatureFailureClearsPersistedTailAndRetriesOnce() = runTest {
        val firstUser = AgentMessage.UserMessage(id = "user-1", content = "first")
        val firstAssistant = AgentMessage.AssistantMessage(
            id = "assistant-1", content = "answer 1", reasoning = "thinking 1",
            signature = "sig-1", thinkingBlocksJson = "snapshot-1"
        )
        val secondUser = AgentMessage.UserMessage(id = "user-2", content = "second")
        val secondAssistant = AgentMessage.AssistantMessage(
            id = "assistant-2", content = "answer 2", reasoning = "thinking 2",
            signature = "sig-2", thinkingBlocksJson = "snapshot-2"
        )
        val requests = mutableListOf<List<AgentMessage>>()
        var attempt = 0
        every { provider.completeStream(any(), capture(requests), any(), any()) } answers {
            attempt++
            if (attempt == 1) {
                flow { throw ThinkingSignatureInvalidException("user-2", "raw body", "signature invalid", IllegalStateException("HTTP 400")) }
            } else {
                flowOf(AIStreamChunk.Final(AIResponse("recovered")))
            }
        }
        coEvery { messagePersistence.clearThinkingSnapshots("session", listOf("assistant-2")) } returns 1
        val persistence = object : TurnPersistence by TurnPersistence.Noop {}
        val turn = WorkflowTurnContext(
            runId = "run",
            sessionRef = SessionRef.Room("session"),
            providerId = "provider",
            model = "model",
            workflowState = null,
            permissionMode = com.bysqh.guru.feature.agent.domain.model.AgentMode.BUILD,
            persistence = persistence
        )

        val events = collectEvents(
            context.copy(
                sessionId = "session",
                history = listOf(firstUser, firstAssistant, secondUser, secondAssistant),
                turn = turn
            )
        )

        assertEquals(2, attempt)
        coVerify(exactly = 1) { messagePersistence.clearThinkingSnapshots("session", listOf("assistant-2")) }
        val retryHistory = requests[1]
        assertEquals("sig-1", (retryHistory.first { it is AgentMessage.AssistantMessage } as AgentMessage.AssistantMessage).signature)
        val retryAssistant = retryHistory.filterIsInstance<AgentMessage.AssistantMessage>()
        assertEquals(listOf("assistant-1", "assistant-2"), retryAssistant.map { it.id })
        assertEquals("", retryAssistant[1].signature)
        assertEquals("", retryAssistant[1].thinkingBlocksJson)
        assertEquals(1, events.filterIsInstance<AgentEvent.Completed>().size)
        assertTrue(events.none { it is AgentEvent.Failed })
    }

    @Test
    fun thinkingSignatureRecoveryStopsWhenSnapshotPersistenceFails() = runTest {
        val requests = mutableListOf<List<AgentMessage>>()
        every { provider.completeStream(any(), capture(requests), any(), any()) } returns flow {
            throw ThinkingSignatureInvalidException("user", "raw body", "signature invalid")
        }
        coEvery { messagePersistence.clearThinkingSnapshots("session", any()) } throws IllegalStateException("database write failed")
        val turn = WorkflowTurnContext(
            runId = "run",
            sessionRef = SessionRef.Room("session"),
            providerId = "provider",
            model = "model",
            workflowState = null,
            permissionMode = com.bysqh.guru.feature.agent.domain.model.AgentMode.BUILD,
            persistence = TurnPersistence.Noop
        )

        val events = collectEvents(
            context.copy(
                sessionId = "session",
                history = listOf(
                    AgentMessage.UserMessage(id = "user", content = "prompt"),
                    AgentMessage.AssistantMessage(id = "assistant", content = "old", signature = "sig", thinkingBlocksJson = "snapshot")
                ),
                turn = turn
            )
        )

        assertEquals(1, requests.size)
        assertEquals(1, events.filterIsInstance<AgentEvent.Failed>().size)
        io.mockk.coVerify(exactly = 1) { messagePersistence.clearThinkingSnapshots("session", any()) }
    }

    @Test
    fun cancellationDuringModelStreamPropagatesWithoutWorkflowFailureEvents() = runTest {
        val streamStarted = kotlinx.coroutines.CompletableDeferred<Unit>()
        every { provider.completeStream(any(), any(), any(), any()) } returns flow {
            streamStarted.complete(Unit)
            kotlinx.coroutines.awaitCancellation()
        }

        val events = mutableListOf<AgentEvent>()
        val job = launch {
            workflow.executeEvents("request", context, emptyList()).collect { events.add(it) }
        }
        streamStarted.await()
        job.cancel()
        job.join()

        assertTrue(events.none { it is AgentEvent.Failed || it is AgentEvent.Completed })
    }

    @Test
    fun interruptedResponsePersistsPartialTextAndReasoningWithStreamId() = runTest {
        every { provider.completeStream(any(), any(), any(), any()) } returns flow {
            emit(AIStreamChunk.ReasoningDelta("partial thinking"))
            emit(AIStreamChunk.TextDelta("partial text"))
            throw IllegalStateException("connection lost")
        }

        val events = collectEvents()
        val response = events.filterIsInstance<AgentEvent.AssistantText>().single()

        assertEquals("partial text", response.content)
        assertEquals("partial thinking", response.reasoning)
        assertEquals(response.messageId, events.filterIsInstance<AgentEvent.AssistantDelta>().single().messageId)
        assertEquals(response.messageId, events.filterIsInstance<AgentEvent.ReasoningDelta>().single().messageId)
        assertEquals(1, events.filterIsInstance<AgentEvent.Failed>().size)
    }

    @Test
    fun accumulatorDoesNotMaterializeTextOrReasoningWithinTheThrottleWindow() = runTest {
        var now = 1_000L
        every { SystemClock.elapsedRealtime() } answers { now }
        var materializations = 0
        val events = mutableListOf<AgentEvent>()
        val stream = StatefulAgentWorkflow.StreamAccumulator(
            callStartElapsed = now,
            responseMessageId = "response",
            materialize = { materializations++; it.toString() }
        ) { events.add(it) }

        stream.onChunk(AIStreamChunk.TextDelta("a"))
        stream.onChunk(AIStreamChunk.ReasoningDelta("r"))
        assertEquals(2, materializations)
        repeat(59) {
            now++
            stream.onChunk(AIStreamChunk.TextDelta("b"))
            stream.onChunk(AIStreamChunk.ReasoningDelta("s"))
        }
        assertEquals(2, materializations)
        assertEquals(2, events.size)

        now = 1_060
        stream.onChunk(AIStreamChunk.TextDelta("c"))
        stream.onChunk(AIStreamChunk.ReasoningDelta("t"))
        assertEquals(4, materializations)
        assertEquals("a" + "b".repeat(59) + "c", events.filterIsInstance<AgentEvent.AssistantDelta>().last().accumulated)
        assertEquals("r" + "s".repeat(59) + "t", events.filterIsInstance<AgentEvent.ReasoningDelta>().last().accumulated)
        stream.flush()
        assertEquals(4, materializations)
    }

    @Test
    fun finalFlushMaterializesOnlyDirtyBuffersInTextThenReasoningOrder() = runTest {
        var now = 1_000L
        every { SystemClock.elapsedRealtime() } answers { now }
        var materializations = 0
        val events = mutableListOf<AgentEvent>()
        val stream = StatefulAgentWorkflow.StreamAccumulator(
            now, "response", materialize = { materializations++; it.toString() }
        ) { events.add(it) }
        stream.onChunk(AIStreamChunk.TextDelta("a"))
        stream.onChunk(AIStreamChunk.ReasoningDelta("r"))
        now++
        stream.onChunk(AIStreamChunk.ReasoningDelta("s"))
        stream.onChunk(AIStreamChunk.TextDelta("b"))
        stream.onChunk(AIStreamChunk.Final(AIResponse("ab")))
        assertEquals(2, materializations)
        stream.flush()
        assertEquals(4, materializations)
        assertEquals(AgentEvent.AssistantDelta("ab", "response"), events[2])
        assertEquals(AgentEvent.ReasoningDelta("rs", "response"), events[3])
        stream.flush()
        assertEquals(4, materializations)
        assertEquals("ab", stream.finalResponse?.content)
    }

    @Test
    fun retryAndKeySwitchDiscardDirtyBuffersWithoutMaterializingThem() = runTest {
        var now = 1_000L
        every { SystemClock.elapsedRealtime() } answers { now }
        var materializations = 0
        val events = mutableListOf<AgentEvent>()
        val stream = StatefulAgentWorkflow.StreamAccumulator(
            now, "response", materialize = { materializations++; it.toString() }
        ) { events.add(it) }
        stream.onChunk(AIStreamChunk.TextDelta("old"))
        stream.onChunk(AIStreamChunk.ReasoningDelta("old reasoning"))
        now++
        stream.onChunk(AIStreamChunk.TextDelta(" discarded"))
        stream.onChunk(AIStreamChunk.ReasoningDelta(" discarded"))
        stream.onChunk(AIStreamChunk.Retrying(1, 3, RetryErrorInfo(RetryErrorKind.UNKNOWN)))
        stream.flush()
        assertEquals(2, materializations)
        assertTrue(stream.text.isEmpty())
        assertTrue(stream.reasoning.isEmpty())
        stream.onChunk(AIStreamChunk.TextDelta("retry"))
        stream.onChunk(AIStreamChunk.ReasoningDelta("retry reasoning"))
        now++
        stream.onChunk(AIStreamChunk.TextDelta(" discarded"))
        stream.onChunk(AIStreamChunk.ReasoningDelta(" discarded"))
        stream.onChunk(AIStreamChunk.KeySwitched(2, 2))
        stream.flush()
        assertEquals(4, materializations)
        stream.onChunk(AIStreamChunk.TextDelta("final"))
        stream.onChunk(AIStreamChunk.ReasoningDelta("final reasoning"))
        stream.flush()
        assertEquals(6, materializations)
        assertEquals(listOf("old", "retry", "final"), events.filterIsInstance<AgentEvent.AssistantDelta>().map { it.accumulated })
        assertEquals(listOf("old reasoning", "retry reasoning", "final reasoning"), events.filterIsInstance<AgentEvent.ReasoningDelta>().map { it.accumulated })
        assertEquals(1, stream.retryAttempts)
    }

    @Test
    fun interruptedResponseUsesDirtyWindowTextAndReasoningForPartialPersistence() = runTest {
        var now = 1_000L
        every { SystemClock.elapsedRealtime() } answers { now }
        every { provider.completeStream(any(), any(), any(), any()) } returns flow {
            emit(AIStreamChunk.ReasoningDelta("partial thinking"))
            emit(AIStreamChunk.TextDelta("partial text"))
            now++
            emit(AIStreamChunk.ReasoningDelta(" tail"))
            emit(AIStreamChunk.TextDelta(" tail"))
            throw IllegalStateException("connection lost")
        }
        val events = collectEvents()
        val partial = events.filterIsInstance<AgentEvent.AssistantText>().single()
        assertEquals("partial text tail", partial.content)
        assertEquals("partial thinking tail", partial.reasoning)
        assertEquals("partial text", events.filterIsInstance<AgentEvent.AssistantDelta>().single().accumulated)
        assertEquals("partial thinking", events.filterIsInstance<AgentEvent.ReasoningDelta>().single().accumulated)
    }

    @Test
    fun interruptedReasoningOnlyResponsePersistsWithStreamId() = runTest {
        every { provider.completeStream(any(), any(), any(), any()) } returns flow {
            emit(AIStreamChunk.ReasoningDelta("partial thinking"))
            throw IllegalStateException("connection lost")
        }

        val events = collectEvents()
        val response = events.filterIsInstance<AgentEvent.AssistantText>().single()

        assertEquals("", response.content)
        assertEquals("partial thinking", response.reasoning)
        assertEquals(response.messageId, events.filterIsInstance<AgentEvent.ReasoningDelta>().single().messageId)
        assertTrue(events.none { it is AgentEvent.AssistantDelta })
        assertEquals(1, events.filterIsInstance<AgentEvent.Failed>().size)
    }

    @Test
    fun exitingPlanWithTurnContextSyncsPermissionModeToAutoForSubsequentBash() = runTest {
        every { prompts.resolvePrompt(any()) } returns ""
        every { outputStore.process(any(), any(), any()) } answers { thirdArg() }
        coEvery { hooks.beforeToolCall(any(), any(), any(), any(), any(), any(), any(), any()) } returns
            com.bysqh.guru.feature.plugin.runtime.ToolBeforeHookResult()

        val planTool = mockk<com.bysqh.guru.feature.agent.domain.tool.AgentTool>(relaxed = true)
        every { planTool.name } returns "planMode"
        coEvery { planTool.executeWithContext(any(), any()) } returns
            com.bysqh.guru.feature.agent.domain.tool.ToolResult.Success(kotlinx.serialization.json.JsonPrimitive("exited"))

        val bashTool = mockk<com.bysqh.guru.feature.agent.domain.tool.AgentTool>(relaxed = true)
        every { bashTool.name } returns "Bash"
        coEvery { bashTool.executeWithContext(any(), any()) } returns
            com.bysqh.guru.feature.agent.domain.tool.ToolResult.Success(kotlinx.serialization.json.JsonPrimitive("ok"))

        every { tools.getTool("planMode") } returns planTool
        every { tools.getTool("Bash") } returns bashTool
        coEvery {
            planApprovalManager.awaitApproval(any(), any())
        } returns com.bysqh.guru.feature.agent.domain.tool.mode.PlanApprovalChoice.APPROVE

        val evaluatedModes = mutableListOf<com.bysqh.guru.feature.agent.domain.model.AgentMode>()
        coEvery { policy.evaluate(bashTool, "Bash", any(), capture(evaluatedModes)) } answers {
            val mode = arg<com.bysqh.guru.feature.agent.domain.model.AgentMode>(3)
            if (mode == com.bysqh.guru.feature.agent.domain.model.AgentMode.PLAN) {
                com.bysqh.guru.feature.agent.domain.permission.ToolPermissionPolicyEngine.EvalResult(
                    com.bysqh.guru.feature.agent.domain.permission.ToolPermissionPolicyEngine.Verdict.DENY,
                    emptyList(),
                    denyReason = "denied in plan"
                )
            } else {
                com.bysqh.guru.feature.agent.domain.permission.ToolPermissionPolicyEngine.EvalResult(
                    com.bysqh.guru.feature.agent.domain.permission.ToolPermissionPolicyEngine.Verdict.ALLOW,
                    emptyList()
                )
            }
        }

        val exitArgs = mapOf(
            "action" to kotlinx.serialization.json.JsonPrimitive("exit"),
            "reason" to kotlinx.serialization.json.JsonPrimitive("ready")
        )
        val bashArgs = mapOf("command" to kotlinx.serialization.json.JsonPrimitive("ls"))
        every { provider.completeStream(any(), any(), any(), any()) } returnsMany listOf(
            flowOf(AIStreamChunk.Final(AIResponse("", toolCalls = listOf(ToolCall("c1", "planMode", exitArgs))))),
            flowOf(AIStreamChunk.Final(AIResponse("", toolCalls = listOf(ToolCall("c2", "Bash", bashArgs))))),
            flowOf(AIStreamChunk.Final(AIResponse("done")))
        )

        val runContext = context.copy(
            sessionId = "sess-1",
            mode = com.bysqh.guru.feature.agent.domain.model.AgentMode.PLAN,
            modeBeforePlan = com.bysqh.guru.feature.agent.domain.model.AgentMode.AUTO,
            turn = WorkflowTurnContext(
                runId = "run-1",
                sessionRef = SessionRef.Room("sess-1"),
                providerId = null,
                model = null,
                workflowState = null,
                permissionMode = com.bysqh.guru.feature.agent.domain.model.AgentMode.PLAN,
                persistence = TurnPersistence.Noop
            )
        )

        val events = collectEvents(runContext)
        val finished = events.filterIsInstance<AgentEvent.ToolCallFinished>()
        assertEquals(listOf(com.bysqh.guru.feature.agent.domain.model.AgentMode.AUTO), evaluatedModes)
        assertTrue(finished.none { it.isError })
    }

    @Test
    fun pendingManualModeChangeToAutoSyncsTurnPermissionBeforeRequestPermission() = runTest {
        every { prompts.resolvePrompt(any()) } returns ""
        every { outputStore.process(any(), any(), any()) } answers { thirdArg() }
        every { eventInjector.inject(any(), any()) } answers { firstArg() }
        coEvery { hooks.beforeToolCall(any(), any(), any(), any(), any(), any(), any(), any()) } returns
            com.bysqh.guru.feature.plugin.runtime.ToolBeforeHookResult()

        val bashTool = mockk<com.bysqh.guru.feature.agent.domain.tool.AgentTool>(relaxed = true)
        every { bashTool.name } returns "Bash"
        coEvery { bashTool.executeWithContext(any(), any()) } returns
            com.bysqh.guru.feature.agent.domain.tool.ToolResult.Success(kotlinx.serialization.json.JsonPrimitive("ok"))
        every { tools.getTool("Bash") } returns bashTool

        val pendingModeChange = com.bysqh.guru.feature.agent.domain.notification.PendingNotification(
            kind = com.bysqh.guru.feature.agent.domain.notification.AgentNotificationKind.MODE_CHANGE,
            sourceId = "user",
            title = "AUTO",
            outcome = com.bysqh.guru.feature.agent.domain.notification.NotificationOutcome.COMPLETED,
            newMode = com.bysqh.guru.feature.agent.domain.model.AgentMode.AUTO,
            seq = 1L
        )
        every { notificationCenter.peek("sess-1") } returns listOf(pendingModeChange)

        val evaluatedModes = mutableListOf<com.bysqh.guru.feature.agent.domain.model.AgentMode>()
        coEvery { policy.evaluate(bashTool, "Bash", any(), capture(evaluatedModes)) } returns
            com.bysqh.guru.feature.agent.domain.permission.ToolPermissionPolicyEngine.EvalResult(
                com.bysqh.guru.feature.agent.domain.permission.ToolPermissionPolicyEngine.Verdict.ALLOW,
                emptyList()
            )

        val bashArgs = mapOf("command" to kotlinx.serialization.json.JsonPrimitive("ls"))
        every { provider.completeStream(any(), any(), any(), any()) } returnsMany listOf(
            flowOf(AIStreamChunk.Final(AIResponse("", toolCalls = listOf(ToolCall("c1", "Bash", bashArgs))))),
            flowOf(AIStreamChunk.Final(AIResponse("done")))
        )

        val runContext = context.copy(
            sessionId = "sess-1",
            mode = com.bysqh.guru.feature.agent.domain.model.AgentMode.PLAN,
            turn = WorkflowTurnContext(
                runId = "run-1",
                sessionRef = SessionRef.Room("sess-1"),
                providerId = null,
                model = null,
                workflowState = null,
                permissionMode = com.bysqh.guru.feature.agent.domain.model.AgentMode.PLAN,
                persistence = TurnPersistence.Noop
            )
        )

        val events = collectEvents(runContext)
        val finished = events.filterIsInstance<AgentEvent.ToolCallFinished>().single()
        assertEquals(listOf(com.bysqh.guru.feature.agent.domain.model.AgentMode.AUTO), evaluatedModes)
        assertTrue(!finished.isError)
        io.mockk.verify(exactly = 1) { notificationCenter.ack("sess-1", listOf(1L)) }
    }

    @Test
    fun rejectedPlanExitRollsBackPermissionModeToPlanAndPreservesModeBeforePlan() = runTest {
        every { prompts.resolvePrompt(any()) } returns ""
        every { outputStore.process(any(), any(), any()) } answers { thirdArg() }
        coEvery { hooks.beforeToolCall(any(), any(), any(), any(), any(), any(), any(), any()) } returns
            com.bysqh.guru.feature.plugin.runtime.ToolBeforeHookResult()

        val planTool = mockk<com.bysqh.guru.feature.agent.domain.tool.AgentTool>(relaxed = true)
        every { planTool.name } returns "planMode"
        coEvery { planTool.executeWithContext(any(), any()) } returns
            com.bysqh.guru.feature.agent.domain.tool.ToolResult.Success(kotlinx.serialization.json.JsonPrimitive("ok"))

        val bashTool = mockk<com.bysqh.guru.feature.agent.domain.tool.AgentTool>(relaxed = true)
        every { bashTool.name } returns "Bash"
        coEvery { bashTool.executeWithContext(any(), any()) } returns
            com.bysqh.guru.feature.agent.domain.tool.ToolResult.Success(kotlinx.serialization.json.JsonPrimitive("ok"))

        every { tools.getTool("planMode") } returns planTool
        every { tools.getTool("Bash") } returns bashTool
        coEvery {
            planApprovalManager.awaitApproval(any(), any())
        } returnsMany listOf(
            com.bysqh.guru.feature.agent.domain.tool.mode.PlanApprovalChoice.REFINE,
            com.bysqh.guru.feature.agent.domain.tool.mode.PlanApprovalChoice.APPROVE
        )

        val evaluatedModes = mutableListOf<com.bysqh.guru.feature.agent.domain.model.AgentMode>()
        coEvery { policy.evaluate(bashTool, "Bash", any(), capture(evaluatedModes)) } answers {
            val mode = arg<com.bysqh.guru.feature.agent.domain.model.AgentMode>(3)
            if (mode == com.bysqh.guru.feature.agent.domain.model.AgentMode.PLAN) {
                com.bysqh.guru.feature.agent.domain.permission.ToolPermissionPolicyEngine.EvalResult(
                    com.bysqh.guru.feature.agent.domain.permission.ToolPermissionPolicyEngine.Verdict.DENY,
                    emptyList(),
                    denyReason = "denied in plan"
                )
            } else {
                com.bysqh.guru.feature.agent.domain.permission.ToolPermissionPolicyEngine.EvalResult(
                    com.bysqh.guru.feature.agent.domain.permission.ToolPermissionPolicyEngine.Verdict.ALLOW,
                    emptyList()
                )
            }
        }

        val enterArgs = mapOf(
            "action" to kotlinx.serialization.json.JsonPrimitive("enter"),
            "reason" to kotlinx.serialization.json.JsonPrimitive("plan")
        )
        val exitArgs = mapOf(
            "action" to kotlinx.serialization.json.JsonPrimitive("exit"),
            "reason" to kotlinx.serialization.json.JsonPrimitive("ready")
        )
        val bashArgs = mapOf("command" to kotlinx.serialization.json.JsonPrimitive("ls"))
        every { provider.completeStream(any(), any(), any(), any()) } returnsMany listOf(
            flowOf(AIStreamChunk.Final(AIResponse("", toolCalls = listOf(ToolCall("c1", "planMode", enterArgs))))),
            flowOf(AIStreamChunk.Final(AIResponse("", toolCalls = listOf(ToolCall("c2", "planMode", exitArgs))))),
            flowOf(AIStreamChunk.Final(AIResponse("", toolCalls = listOf(ToolCall("c3", "Bash", bashArgs))))),
            flowOf(AIStreamChunk.Final(AIResponse("", toolCalls = listOf(ToolCall("c4", "planMode", exitArgs))))),
            flowOf(AIStreamChunk.Final(AIResponse("", toolCalls = listOf(ToolCall("c5", "Bash", bashArgs))))),
            flowOf(AIStreamChunk.Final(AIResponse("done")))
        )

        val runContext = context.copy(
            sessionId = "sess-1",
            mode = com.bysqh.guru.feature.agent.domain.model.AgentMode.AUTO,
            turn = WorkflowTurnContext(
                runId = "run-1",
                sessionRef = SessionRef.Room("sess-1"),
                providerId = null,
                model = null,
                workflowState = null,
                permissionMode = com.bysqh.guru.feature.agent.domain.model.AgentMode.AUTO,
                persistence = TurnPersistence.Noop
            )
        )

        val events = collectEvents(runContext)
        val finished = events.filterIsInstance<AgentEvent.ToolCallFinished>()
        assertEquals(
            listOf(
                com.bysqh.guru.feature.agent.domain.model.AgentMode.PLAN,
                com.bysqh.guru.feature.agent.domain.model.AgentMode.AUTO
            ),
            evaluatedModes
        )
        assertTrue(finished.first { it.id == "c3" }.isError)
        assertTrue(!finished.first { it.id == "c5" }.isError)
    }
}
