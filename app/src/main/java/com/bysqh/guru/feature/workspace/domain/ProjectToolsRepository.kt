package com.bysqh.guru.feature.workspace.domain

import com.bysqh.guru.core.util.FileLogger
import com.bysqh.guru.feature.plugin.domain.PluginContent
import com.bysqh.guru.feature.plugin.domain.PluginManager
import com.bysqh.guru.feature.plugin.domain.PluginWorkspaceTool
import com.bysqh.guru.feature.settings.data.repository.ExecutionModeHolder
import com.bysqh.guru.feature.workspace.data.repository.WorkspaceRepository
import java.io.File
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * 项目已启用工具项条目（保存在 `<workspace>/.guru/tools.json` 中）。
 */
@Serializable
data class ProjectToolItem(
    val toolKey: String,
    val pluginId: String,
    val localId: String,
    val title: String,
    val description: String = "",
    val icon: String = "play",
    val category: String = "通用"
)

@Serializable
internal data class ProjectToolsFile(
    val tools: List<ProjectToolItem> = emptyList()
)

/**
 * 当前项目的工具箱管理器：负责读取、持久化 `<workspace>/.guru/tools.json`，
 * 并与已安装的插件做动态对账。
 */
@Singleton
class ProjectToolsRepository @Inject constructor(
    private val projectAicodeRoot: ProjectAicodeRoot,
    private val pluginManager: PluginManager,
    private val workspaceRepository: WorkspaceRepository,
    private val executionModeHolder: ExecutionModeHolder
) {
    private val json = Json { ignoreUnknownKeys = true; prettyPrint = true }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _tools = MutableStateFlow<List<ProjectToolItem>>(emptyList())
    val tools: StateFlow<List<ProjectToolItem>> = _tools.asStateFlow()
    private val reloadMutex = Mutex()
    private var loadedConfigFile: File? = null

    init {
        scope.launch { reload() }
        // 插件启停、安装卸载或更新后自动对账。注册表损坏时保留现有项目工具配置，避免空快照清库。
        scope.launch {
            pluginManager.plugins
                .combine(pluginManager.isLoaded) { _, loaded -> loaded }
                .combine(pluginManager.registryReadSucceeded) { loaded, succeeded -> loaded && succeeded }
                .collect { ready -> if (ready) reload() }
        }
        // 切换工作区后 tools.json 换文件，必须跟着重读
        scope.launch {
            combine(
                workspaceRepository.current.map { it?.path }.distinctUntilChanged(),
                executionModeHolder.activeBackend.map { it.id }.distinctUntilChanged()
            ) { _, _ -> Unit }
                .collect { reload() }
        }
    }

    private fun configFile(): File = File(projectAicodeRoot.current(), CONFIG_FILE)

    /** 重新加载当前工作区的工具配置。 */
    suspend fun reload() = withContext(Dispatchers.IO) {
        reloadMutex.withLock { reloadLocked() }
    }

    private suspend fun reloadLocked() {
        val file = configFile()
        val loaded = runCatching {
            if (file.isFile) {
                json.decodeFromString<ProjectToolsFile>(file.readText()).tools
            } else {
                emptyList()
            }
        }.getOrElse {
            FileLogger.w(TAG, "读取 tools.json 失败: ${it.message}")
            emptyList()
        }
        if (file != configFile()) return
        // 插件停用、卸载或更新后不再提供的工具，直接从项目配置里删掉，抽屉里不能留下失效项。
        val activeKeys = if (pluginManager.isLoaded.value && pluginManager.registryReadSucceeded.value) {
            pluginManager.activeWorkspaceTools().mapTo(HashSet()) { it.key }
        } else {
            null
        }
        val tools = if (activeKeys == null) loaded else loaded.filter { it.toolKey in activeKeys }
        if (tools.size != loaded.size) write(file, tools)
        if (file == configFile()) {
            loadedConfigFile = file
            _tools.value = tools
        }
    }

    /** 向当前项目添加一个工具。 */
    suspend fun addTool(tool: PluginWorkspaceTool, languageTag: String = "zh-CN") = withContext(Dispatchers.IO) {
        reloadMutex.withLock {
            val file = configFile()
            if (file != loadedConfigFile) reloadLocked()
            if (file != loadedConfigFile || file != configFile()) return@withLock
            val current = _tools.value.toMutableList()
            if (current.none { it.toolKey == tool.key }) {
                current.add(
                    ProjectToolItem(
                        toolKey = tool.key,
                        pluginId = tool.pluginId,
                        localId = tool.localId,
                        title = tool.title.resolve(languageTag),
                        description = tool.description.resolve(languageTag),
                        icon = tool.icon,
                        category = tool.category
                    )
                )
                save(file, current)
            }
        }
    }

    /** 从当前项目移除工具。 */
    suspend fun removeTool(toolKey: String) = withContext(Dispatchers.IO) {
        reloadMutex.withLock {
            val file = configFile()
            if (file != loadedConfigFile) reloadLocked()
            if (file != loadedConfigFile || file != configFile()) return@withLock
            val current = _tools.value.filterNot { it.toolKey == toolKey }
            save(file, current)
        }
    }

    private fun save(file: File, items: List<ProjectToolItem>) {
        if (write(file, items) && file == configFile()) {
            loadedConfigFile = file
            _tools.value = items
        }
    }

    private fun write(file: File, items: List<ProjectToolItem>): Boolean = runCatching {
        file.parentFile?.mkdirs()
        file.writeText(json.encodeToString(ProjectToolsFile(items)))
    }.onFailure {
        FileLogger.e(TAG, "写入 tools.json 失败", it)
    }.isSuccess

    companion object {
        private const val TAG = "ProjectToolsRepo"
        private const val CONFIG_FILE = "tools.json"
    }
}
