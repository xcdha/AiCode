package com.bysqh.guru.feature.settings.domain.service

import com.bysqh.guru.core.util.FileLogger
import com.bysqh.guru.feature.agent.domain.container.CommandEngine
import com.bysqh.guru.feature.settings.data.repository.ProviderKeyRotator
import com.bysqh.guru.feature.settings.domain.model.AIProviderConfig
import com.bysqh.guru.feature.settings.domain.model.AdaptiveCardAction
import com.bysqh.guru.feature.settings.domain.model.AdaptiveCardElement
import com.bysqh.guru.feature.settings.domain.model.AdaptiveCardRoot
import com.bysqh.guru.feature.settings.domain.parser.AdaptiveCardParser
import com.bysqh.guru.feature.settings.domain.model.ActionButtonElement
import com.bysqh.guru.feature.settings.domain.model.BadgeElement
import com.bysqh.guru.feature.settings.domain.model.CardColor
import com.bysqh.guru.feature.settings.domain.model.CardPadding
import com.bysqh.guru.feature.settings.domain.model.ColumnElement
import com.bysqh.guru.feature.settings.domain.model.ColumnSetElement
import com.bysqh.guru.feature.settings.domain.model.ColumnWidth
import com.bysqh.guru.feature.settings.domain.model.ContainerElement
import com.bysqh.guru.feature.settings.domain.model.ContainerStyle
import com.bysqh.guru.feature.settings.domain.model.DashboardContext
import com.bysqh.guru.feature.settings.domain.model.DividerElement
import com.bysqh.guru.feature.settings.domain.model.FactItem
import com.bysqh.guru.feature.settings.domain.model.FactSetElement
import com.bysqh.guru.feature.settings.domain.model.FlowRowElement
import com.bysqh.guru.feature.settings.domain.model.ImageElement
import com.bysqh.guru.feature.settings.domain.model.MetricElement
import com.bysqh.guru.feature.settings.domain.model.ProgressBarElement
import com.bysqh.guru.feature.settings.domain.model.ProviderDashboardResult
import com.bysqh.guru.feature.settings.domain.model.RowElement
import com.bysqh.guru.feature.settings.domain.model.ScrollRowElement
import com.bysqh.guru.feature.settings.domain.model.SpacerElement
import com.bysqh.guru.feature.settings.domain.model.SpacingSize
import com.bysqh.guru.feature.settings.domain.model.StatusDotElement
import com.bysqh.guru.feature.settings.domain.model.TabElement
import com.bysqh.guru.feature.settings.domain.model.TabSetElement
import com.bysqh.guru.feature.settings.domain.model.TextBlockElement
import com.bysqh.guru.feature.settings.domain.model.TextSize
import com.bysqh.guru.feature.settings.domain.model.TextWeight
import com.bysqh.guru.feature.workspace.data.repository.WorkspaceRepository
import com.bysqh.guru.feature.workspace.domain.FileAccessProvider
import com.bysqh.guru.feature.workspace.domain.PathHomeResolver
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class ProviderDashboardRunner @Inject constructor(
    private val commandEngine: CommandEngine,
    private val keyRotator: ProviderKeyRotator,
    private val workspaceRepository: WorkspaceRepository,
    private val fileAccess: FileAccessProvider,
    private val pathHomeResolver: PathHomeResolver
) {
    companion object {
        private const val TAG = "ProviderDashboardRunner"
        /** 自定义脚本参数写入环境变量的固定前缀，如 AICODE_KEY_ACCOUNT_ID。 */
        private const val PREFIX_SCRIPT_PARAM = "AICODE_KEY_"
        private const val SCRIPT_TIMEOUT_MS = 15_000L

        fun parseDashboardJson(rawOutput: String): ProviderDashboardResult {
            if (rawOutput.isBlank()) {
                return ProviderDashboardResult(AdaptiveCardRoot(), rawOutput)
            }
            val card = AdaptiveCardParser.parseAdaptiveCard(rawOutput)
            return ProviderDashboardResult(card = card, rawOutput = rawOutput)
        }

        fun parseElement(element: kotlinx.serialization.json.JsonElement): AdaptiveCardElement? =
            AdaptiveCardParser.parseElement(element)
    }

    /**
     * 获取脚本目录 `~/.guru/scripts` 下的所有可用脚本文件名列表。经 [FileAccessProvider] 访问，
     * 跟随当前执行环境（本地落 App 私有目录，远程落服务器 home 下的 `.guru/scripts`）。
     */
    fun listAvailableScripts(): List<String> {
        val scriptsDir = "${pathHomeResolver.guruRoot()}/scripts"
        fileAccess.mkdirs(scriptsDir)
        return fileAccess.listFiles(scriptsDir)
            .filter { !it.isDirectory && !it.name.startsWith(".") }
            .map { it.name }
            .sorted()
    }

    /**
     * 执行提供商的自定义面板脚本并解析返回结果。
     */
    suspend fun runScript(
        provider: AIProviderConfig,
        scriptPathOverride: String? = null,
        context: DashboardContext? = null
    ): Result<ProviderDashboardResult> = runCatching {
        val rawPath = (scriptPathOverride ?: provider.dashboardScriptPath).trim()
        if (rawPath.isBlank()) {
            return@runCatching ProviderDashboardResult()
        }

        // 解析容器内路径
        val targetPath = resolveContainerScriptPath(rawPath)

        // 构造环境变量与执行命令
        val envPrefix = buildEnvPrefix(provider, context)
        val execCmd = buildExecCommand(targetPath)
        val fullCommand = "$envPrefix $execCmd"

        FileLogger.i(TAG, "执行面板脚本 provider=${provider.name} targetPath=$targetPath model=${context?.model}")
        // 必须传工作区路径：proot 靠它把当前工作区 bind 到容器内 /root/workspace，
        // 否则脚本里访问工作区文件（如 .guru/progress.json）会落到 rootfs 的空目录。
        val result = commandEngine.runCommandSyncUnbounded(
            fullCommand,
            projectPath = workspaceRepository.currentPath(),
            timeoutMs = SCRIPT_TIMEOUT_MS
        )
        val output = result.output.trim()

        if (result.exitCode != null && result.exitCode != 0) {
            FileLogger.w(TAG, "自定义面板脚本执行非零退出 code=${result.exitCode} output=$output")
            throw IllegalStateException("脚本退出码: ${result.exitCode}\n$output")
        }

        parseDashboardJson(output)
    }

    /** 把用户/列表给的脚本路径解析为当前执行环境下的绝对路径（home 随本地/远程而变，不写死 /root）。 */
    private fun resolveContainerScriptPath(path: String): String {
        val root = pathHomeResolver.guruRoot()
        return when {
            path.startsWith("/") -> path
            path.startsWith("~/") -> pathHomeResolver.expandHome(path)
            path.startsWith(".guru/scripts/") -> "$root/${path.removePrefix(".guru/")}"
            path.startsWith("scripts/") -> "$root/$path"
            else -> "$root/scripts/$path"
        }
    }

    private fun buildEnvPrefix(provider: AIProviderConfig, context: DashboardContext? = null): String {
        fun escape(value: String): String {
            return "'" + value.replace("'", "'\\''") + "'"
        }
        val effectiveModel = context?.model?.ifBlank { null }
            ?: provider.selectedModel.ifBlank { provider.defaultModel }
        // 多 Key 模式下查当前活动的 Key，否则面板会报一个已被切走的 Key 的余额。
        val effectiveApiKey = keyRotator.currentKey(provider) ?: provider.apiKey
        // 面板请求跟随该 Key 自己的地址覆盖（不同 Key 走不同中转时，余额要查对应端点）。
        val effectiveBaseUrl = provider.effectiveBaseUrl(effectiveApiKey)

        val envs = mutableListOf(
            "GURU_PROVIDER_ID=${escape(provider.id)}",
            "GURU_PROVIDER_NAME=${escape(provider.name)}",
            "GURU_PROVIDER_TYPE=${escape(provider.type.name)}",
            "GURU_PROVIDER_API_KEY=${escape(effectiveApiKey)}",
            "GURU_PROVIDER_BASE_URL=${escape(effectiveBaseUrl)}",
            "GURU_PROVIDER_DEFAULT_MODEL=${escape(provider.defaultModel)}",
            "GURU_PROVIDER_SELECTED_MODEL=${escape(provider.selectedModel)}",
            "GURU_MODEL=${escape(effectiveModel)}"
        )

        // 自定义脚本参数：按提供商配置注入为 AICODE_KEY_<KEY> 环境变量，
        // 值支持 {{PROVIDER_API_KEY}} / {{BASE_URL}} 等占位符引用，避免敏感信息重复填写。
        provider.scriptParams.forEach { (key, rawValue) ->
            if (key.isBlank()) return@forEach
            val envKey = "AICODE_KEY_" + sanitizeEnvKey(key)
            if (envKey == PREFIX_SCRIPT_PARAM) return@forEach
            val resolved = resolveScriptParamPlaceholders(rawValue, provider, effectiveApiKey, effectiveModel)
            envs.add("$envKey=${escape(resolved)}")
        }

        if (context != null) {
            envs.add("AICODE_WORKSPACE=${escape(context.workspacePath)}")
            envs.add("AICODE_WORKSPACE_NAME=${escape(context.workspaceName)}")
            envs.add("GURU_SESSION_ID=${escape(context.sessionId)}")
            envs.add("GURU_LAST_INPUT_TOKENS=${context.lastInputTokens}")
            envs.add("GURU_LAST_OUTPUT_TOKENS=${context.lastOutputTokens}")
            envs.add("GURU_LAST_CACHED_TOKENS=${context.lastCachedTokens}")
            envs.add("GURU_TOTAL_INPUT_TOKENS=${context.totalInputTokens}")
            envs.add("GURU_TOTAL_OUTPUT_TOKENS=${context.totalOutputTokens}")
            envs.add("GURU_MODEL_CONTEXT_TOKENS=${context.modelContextTokens}")
            envs.add("GURU_MODEL_MAX_INPUT_TOKENS=${context.modelMaxInputTokens}")
            envs.add("GURU_MODEL_MAX_OUTPUT_TOKENS=${context.modelMaxOutputTokens}")
            envs.add("GURU_MODEL_INPUT_COST_USD_PER_M=${context.modelInputCostUsdPerM}")
            envs.add("GURU_MODEL_OUTPUT_COST_USD_PER_M=${context.modelOutputCostUsdPerM}")
            envs.add("GURU_MODEL_CACHE_READ_COST_USD_PER_M=${context.modelCacheReadCostUsdPerM}")
            envs.add("GURU_MODEL_SUPPORTS_TOOLS=${context.modelSupportsTools}")
            envs.add("GURU_MODEL_SUPPORTS_VISION=${context.modelSupportsVision}")
            envs.add("GURU_MODEL_SUPPORTS_REASONING=${context.modelSupportsReasoning}")
            envs.add("GURU_MESSAGE_COUNT=${context.messageCount}")
            envs.add("GURU_AGENT_STATE=${escape(context.agentState)}")
            envs.add("GURU_SESSION_MODE=${escape(context.sessionMode)}")
            envs.add("GURU_REASONING_EFFORT=${escape(context.reasoningEffort)}")
            envs.add("GURU_REFRESH_REASON=${escape(context.refreshReason)}")
        }

        return envs.joinToString(" ")
    }

    /** 把用户填写的参数 Key 规整为合法的环境变量名段（大写，仅保留字母/数字/下划线）。 */
    private fun sanitizeEnvKey(key: String): String =
        key.trim().uppercase().filter { it in 'A'..'Z' || it in '0'..'9' || it == '_' }

    /** 解析脚本参数值中的 {{...}} 占位符，引用当前提供商配置，避免敏感信息重复填写。 */
    private fun resolveScriptParamPlaceholders(
        raw: String,
        provider: AIProviderConfig,
        effectiveApiKey: String,
        effectiveModel: String
    ): String {
        var out = raw
        val placeholders = mapOf(
            "{{PROVIDER_API_KEY}}" to effectiveApiKey,
            "{{PROVIDER_ID}}" to provider.id,
            "{{PROVIDER_NAME}}" to provider.name,
            "{{PROVIDER_TYPE}}" to provider.type.name,
            "{{BASE_URL}}" to provider.effectiveBaseUrl(effectiveApiKey),
            "{{DEFAULT_MODEL}}" to provider.defaultModel,
            "{{SELECTED_MODEL}}" to provider.selectedModel,
            "{{MODEL}}" to effectiveModel
        )
        for ((token, value) in placeholders) {
            out = out.replace(token, value)
        }
        return out
    }

    private fun buildExecCommand(targetPath: String): String {
        val lower = targetPath.lowercase()
        return when {
            lower.endsWith(".py") -> "python3 \"$targetPath\""
            lower.endsWith(".js") -> "node \"$targetPath\""
            lower.endsWith(".sh") || lower.endsWith(".bash") -> "bash \"$targetPath\""
            else -> "if [ -x \"$targetPath\" ]; then \"$targetPath\"; else bash \"$targetPath\"; fi"
        }
    }
}
