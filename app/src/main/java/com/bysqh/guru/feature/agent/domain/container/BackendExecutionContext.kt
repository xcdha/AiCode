package com.bysqh.guru.feature.agent.domain.container

import com.bysqh.guru.feature.workspace.domain.FileAccessProvider
import com.bysqh.guru.feature.terminal.domain.TerminalSessionProvider
import kotlinx.coroutines.ThreadContextElement
import kotlinx.coroutines.asContextElement

class BackendExecutionBinding(
    backend: ExecutionBackend
) {
    val instanceId: String = backend.instanceId
    val commandEngine: CommandEngine = backend.commandEngine
    val fileAccess: FileAccessProvider = backend.fileAccess
    val terminalSessionProvider: TerminalSessionProvider? = backend.terminalSessionProvider

    fun checkActive(registry: ExecutionBackendRegistry) {
        check(registry.currentBackend().instanceId == instanceId) {
            "Execution backend changed during the operation"
        }
    }
}

object BackendExecutionContext {
    private val current = ThreadLocal<BackendExecutionBinding?>()

    fun binding(): BackendExecutionBinding? = current.get()

    fun bind(backend: ExecutionBackend): ThreadContextElement<BackendExecutionBinding?> =
        current.asContextElement(BackendExecutionBinding(backend))
}
