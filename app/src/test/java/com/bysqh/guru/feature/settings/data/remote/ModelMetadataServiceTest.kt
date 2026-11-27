package com.bysqh.guru.feature.settings.data.remote

import android.app.Application
import com.bysqh.guru.feature.settings.data.local.CustomModelMetadataStore
import com.bysqh.guru.feature.settings.domain.model.ProviderType
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE, application = Application::class)
class ModelMetadataServiceTest {

    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun resolveAutoReadsBundledCatalogWithoutCustomOverrides() = runTest {
        val custom = mockk<CustomModelMetadataStore>(relaxed = true)
        val service = ModelMetadataService(RuntimeEnvironment.getApplication(), custom)

        val metadata = service.resolveAuto(ProviderType.ANTHROPIC, "claude-opus-5-5")

        assertEquals("claude-opus-5-5", metadata.id)
        assertEquals(1_000_000, metadata.contextTokens)
        assertEquals(true, metadata.supportsReasoning)
        io.mockk.coVerify(exactly = 0) { custom.get(any(), any()) }
    }

    private fun parse(raw: String): List<String> =
        ModelMetadataService.parseReasoningOptions(json.parseToJsonElement(raw))

    @Test
    fun effortType_extractsValues() {
        assertEquals(
            listOf("none", "low", "medium", "high", "xhigh", "max"),
            parse("""[{"type":"effort","values":["none","low","medium","high","xhigh","max"]}]""")
        )
    }

    @Test
    fun mixedToggleThenEffort_extractsEffort() {
        assertEquals(
            listOf("low", "medium", "high", "xhigh", "max"),
            parse("""[{"type":"toggle"},{"type":"effort","values":["low","medium","high","xhigh","max"]}]""")
        )
    }

    @Test
    fun toggleOnly_returnsEmpty() {
        assertEquals(emptyList<String>(), parse("""[{"type":"toggle"}]"""))
    }

    @Test
    fun budgetTokens_returnsEmpty() {
        assertEquals(emptyList<String>(), parse("""[{"type":"budget_tokens","min":1024}]"""))
    }

    @Test
    fun emptyArray_returnsEmpty() {
        assertEquals(emptyList<String>(), parse("""[]"""))
    }

    @Test
    fun nullJson_returnsEmpty() {
        assertEquals(emptyList<String>(), parse("""null"""))
    }

    // ---- 模型 id 匹配：原名精确 → 忽略大小写 → 兜底剥 vendor 前缀 ----

    private val catalog = ModelMetadataService.parseCatalog(
        json.parseToJsonElement(
            """
            {
              "openrouter": {
                "models": {
                  "z-ai/glm-5.3-flash": {"id": "z-ai/glm-5.3-flash"},
                  "glm-5.3": {"id": "glm-5.3"},
                  "priority-model": {"id": "priority-model"},
                  "priority-model-preview": {"id": "priority-model-preview"},
                  "relay-model": {"id": "relay-model"}
                }
              },
              "zhipuai": {
                "models": {
                  "glm-5.3-flash": {"id": "glm-5.3-flash"},
                  "glm-5.3": {"id": "glm-5.3"},
                  "zai-org/GLM-5.3-Flash": {"id": "zai-org/GLM-5.3-Flash"},
                  "priority-model-high": {"id": "priority-model-high"},
                  "relay-model-channel": {"id": "relay-model-channel"},
                  "relay-model-preview-channel": {"id": "relay-model-preview-channel"}
                }
              },
              "some-relay": {
                "models": {
                  "myrelay/glm-5.3-flash": {"id": "myrelay/glm-5.3-flash"}
                }
              }
            }
            """.trimIndent()
        )
    )

    private fun matchedProvider(modelId: String, type: ProviderType = ProviderType.OPENAI): String? =
        ModelMetadataService.findMetadata(catalog, type, modelId)?.providerId

    @Test
    fun bareId_fallsBackToAnyProvider() {
        assertEquals("zhipuai", matchedProvider("glm-5.3-flash"))
    }

    @Test
    fun preferredProvider_winsOverCatalogOrder() {
        assertEquals("openrouter", matchedProvider("glm-5.3"))
    }

    @Test
    fun providerTypeMismatch_stillMatchesAnyProvider() {
        assertEquals("zhipuai", matchedProvider("glm-5.3-flash", ProviderType.ANTHROPIC))
    }

    @Test
    fun idCaseDiffersFromCatalog_stillMatches() {
        assertEquals("zhipuai", matchedProvider("GLM-5.3-Flash"))
    }

    @Test
    fun knownVendorPrefixedId_matchesExactEntry() {
        assertEquals("openrouter", matchedProvider("z-ai/glm-5.3-flash"))
        assertEquals("zhipuai", matchedProvider("zai-org/GLM-5.3-Flash"))
    }

    @Test
    fun knownVendorPrefixedId_ignoresCase() {
        assertEquals("openrouter", matchedProvider("Z-AI/GLM-5.3-Flash"))
        assertEquals("zhipuai", matchedProvider("zai-org/glm-5.3-flash"))
    }

    @Test
    fun unknownVendorPrefix_fallsBackToStrippedId() {
        assertEquals("zhipuai", matchedProvider("other-relay/glm-5.3-flash"))
    }

    @Test
    fun unknownVendorPrefix_stripsOneLayerAtATime() {
        assertEquals("zhipuai", matchedProvider("a/b/glm-5.3-flash"))
    }

    @Test
    fun matchedId_isNotReplacedByStrippedFallback() {
        assertEquals("some-relay", matchedProvider("myrelay/glm-5.3-flash"))
    }

    @Test
    fun modelsPrefix_isStrippedIgnoringCase() {
        assertEquals("zhipuai", matchedProvider("models/glm-5.3-flash"))
        assertEquals("zhipuai", matchedProvider("Models/GLM-5.3-Flash"))
    }

    @Test
    fun suffixStripping_ignoresCase() {
        assertEquals("zhipuai", matchedProvider("glm-5.3-flash-high"))
        assertEquals("zhipuai", matchedProvider("GLM-5.3-Flash-High"))
    }

    @Test
    fun fullNameExact_winsOverPreferredProviderSuffixMatch() {
        assertEquals("zhipuai", matchedProvider("priority-model-high"))
    }

    @Test
    fun fullNameIgnoringCase_winsOverExactSuffixMatch() {
        assertEquals("zhipuai", matchedProvider("priority-model-HIGH"))
    }

    @Test
    fun fullNameIgnoringCase_winsOverCaseInsensitiveSuffixMatch() {
        assertEquals("zhipuai", matchedProvider("PRIORITY-MODEL-HIGH"))
    }

    @Test
    fun unknownSuffix_stripsLastSegmentOnce() {
        assertEquals("openrouter", matchedProvider("glm-5.3-custom"))
        assertEquals("openrouter", matchedProvider("GLM-5.3-Custom"))
        assertEquals("openrouter", matchedProvider("other-relay/glm-5.3-custom"))
    }

    @Test
    fun unknownSuffix_doesNotRepeatedlyShortenName() {
        assertNull(matchedProvider("glm-5.3-custom-channel"))
    }

    @Test
    fun unknownSuffix_doesNotApplyKnownSuffixStrippingAfterFallback() {
        assertNull(matchedProvider("priority-model-thinking-channel"))
    }

    @Test
    fun vendorExactMatch_winsOverUnknownSuffixFallback() {
        assertEquals("zhipuai", matchedProvider("relay/relay-model-channel"))
    }

    @Test
    fun knownSuffixMatch_winsOverUnknownSuffixFallback() {
        assertEquals("zhipuai", matchedProvider("relay-model-channel-preview"))
    }

    @Test
    fun knownSuffixMatchAfterVendorStripping_winsOverUnknownSuffixFallback() {
        assertEquals("openrouter", matchedProvider("relay/priority-model-preview-high"))
    }

    @Test
    fun fallbackCandidateIgnoringCase_winsOverShorterKnownSuffixMatch() {
        assertEquals("zhipuai", matchedProvider("RELAY-MODEL-PREVIEW-CHANNEL-custom"))
    }

    @Test
    fun unrelatedId_returnsNull() {
        assertNull(matchedProvider("glm5.3flash"))
    }
}