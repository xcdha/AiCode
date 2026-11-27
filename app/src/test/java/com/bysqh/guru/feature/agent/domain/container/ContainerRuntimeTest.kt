package com.bysqh.guru.feature.agent.domain.container

import android.app.Application
import android.content.Context
import com.bysqh.guru.feature.settings.data.repository.ContainerSettingsRepository
import com.bysqh.guru.feature.workspace.domain.PathHomeResolver
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.flow.flowOf
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], manifest = Config.NONE, application = Application::class)
class ContainerRuntimeTest {

    @get:Rule
    val tempFolder = TemporaryFolder()

    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun containerProfile_legacyJsonWithoutRuntime_defaultsToProot() {
        val raw = """
            {
              "id": "custom-1",
              "name": "Debian",
              "rootfsSource": {"type": "com.bysqh.guru.feature.agent.domain.container.RootfsSource.LocalFile", "uri": "file:///tmp/debian.tar.gz"},
              "shellPath": "/bin/bash",
              "isBuiltin": false
            }
        """.trimIndent()

        val decoded = json.decodeFromString(ContainerProfile.serializer(), raw)
        assertEquals(ContainerRuntime.PROOT, decoded.runtime)
    }

    @Test
    fun containerProfile_withTawcrootRuntime_roundTrips() {
        val profile = ContainerProfile(
            id = "custom-tawc",
            name = "Arch",
            rootfsSource = RootfsSource.LocalFile("file:///tmp/arch.tar.gz"),
            shellPath = "/bin/bash",
            isBuiltin = false,
            runtime = ContainerRuntime.TAWCROOT
        )

        val encoded = json.encodeToString(ContainerProfile.serializer(), profile)
        val decoded = json.decodeFromString(ContainerProfile.serializer(), encoded)
        assertEquals(ContainerRuntime.TAWCROOT, decoded.runtime)
    }

    @Test
    fun tawcrootPtyDoesNotRequestAnotherSession() {
        val rootfs = tempFolder.newFolder("rootfs")
        val guruDir = tempFolder.newFolder("guru")
        val nativeDir = tempFolder.newFolder("native")
        val installer = mockk<ContainerInstaller>(relaxed = true)
        val settingsRepo = mockk<ContainerSettingsRepository>(relaxed = true)
        every { settingsRepo.activeProfileFlow } returns flowOf(ContainerProfile.BUILTIN_ALPINE)
        every { settingsRepo.customProfilesFlow } returns flowOf(emptyList())
        every { installer.rootfsDirFor(any()) } returns rootfs
        every { installer.guruDir } returns guruDir
        every { installer.tawcrootBin } returns File(nativeDir, "libtawcroot.so")
        val engine = LinuxContainerEngine(
            mockk<Context>(relaxed = true),
            installer,
            mockk<ContainerOsDetector>(relaxed = true),
            settingsRepo,
            mockk<PathHomeResolver>(relaxed = true)
        )

        val profile = ContainerProfile.BUILTIN_ALPINE.copy(runtime = ContainerRuntime.TAWCROOT)
        val command = engine.buildBaseTawcrootArgv(projectPath = null, profile = profile)
        val pty = engine.buildBaseTawcrootArgv(projectPath = null, profile = profile, newSession = false)

        assertTrue(command.contains("-s"))
        assertFalse(pty.contains("-s"))
        assertTrue(command.contains("/root/.guru"))
        assertFalse(command.contains("--link2symlink"))
    }

    @Test
    fun resolveEffectiveRuntime_withoutTawcrootBinary_fallsBackToProot() {
        val rootfs = tempFolder.newFolder("rootfs")
        val guruDir = tempFolder.newFolder("guru")
        val nativeDir = tempFolder.newFolder("native")
        val engine = createEngine(rootfs, guruDir, nativeDir)
        val tawcProfile = ContainerProfile.BUILTIN_ALPINE.copy(runtime = ContainerRuntime.TAWCROOT)

        assertEquals(
            ContainerRuntime.PROOT,
            engine.resolveEffectiveRuntime(tawcProfile, apiLevel = 29, supports64BitAbi = true)
        )

        val invocation = engine.buildProotInvocation("echo ok", projectPath = null)
        assertEquals(File(nativeDir, "libproot.so").absolutePath, invocation.executable)
        assertTrue(invocation.argv.contains("--link2symlink"))
        assertTrue(invocation.env.containsKey("PROOT_LOADER"))
        assertFalse(invocation.argv.contains("--"))
    }

    @Test
    fun resolveEffectiveRuntime_withSupportedDeviceAndBinaryUsesTawcroot() {
        val rootfs = tempFolder.newFolder("rootfs")
        val guruDir = tempFolder.newFolder("guru")
        val nativeDir = tempFolder.newFolder("native")
        File(nativeDir, "libtawcroot.so").writeText("test-binary-present")
        val engine = createEngine(rootfs, guruDir, nativeDir)

        assertEquals(
            ContainerRuntime.TAWCROOT,
            engine.resolveEffectiveRuntime(
                ContainerProfile.BUILTIN_ALPINE.copy(runtime = ContainerRuntime.TAWCROOT),
                apiLevel = 29,
                supports64BitAbi = true
            )
        )
    }

    @Test
    fun resolveEffectiveRuntime_without64BitAbiFallsBackToProot() {
        val rootfs = tempFolder.newFolder("rootfs")
        val guruDir = tempFolder.newFolder("guru")
        val nativeDir = tempFolder.newFolder("native")
        File(nativeDir, "libtawcroot.so").writeText("test-binary-present")
        val engine = createEngine(rootfs, guruDir, nativeDir)

        assertEquals(
            ContainerRuntime.PROOT,
            engine.resolveEffectiveRuntime(
                ContainerProfile.BUILTIN_ALPINE.copy(runtime = ContainerRuntime.TAWCROOT),
                apiLevel = 29,
                supports64BitAbi = false
            )
        )
    }

    @Test
    fun resolveEffectiveRuntime_belowAndroid10FallsBackToProot() {
        val rootfs = tempFolder.newFolder("rootfs")
        val guruDir = tempFolder.newFolder("guru")
        val nativeDir = tempFolder.newFolder("native")
        File(nativeDir, "libtawcroot.so").writeText("test-binary-present")
        val engine = createEngine(rootfs, guruDir, nativeDir)

        assertEquals(
            ContainerRuntime.PROOT,
            engine.resolveEffectiveRuntime(
                ContainerProfile.BUILTIN_ALPINE.copy(runtime = ContainerRuntime.TAWCROOT),
                apiLevel = 28,
                supports64BitAbi = true
            )
        )
    }

    private fun createEngine(rootfs: File, guruDir: File, nativeDir: File): LinuxContainerEngine {
        val prootBin = File(nativeDir, "libproot.so").apply { writeText("") }
        val loader = File(nativeDir, "libproot-loader.so").apply { writeText("") }
        val loader32 = File(nativeDir, "libproot-loader32.so").apply { writeText("") }
        val installer = mockk<ContainerInstaller>(relaxed = true)
        every { installer.rootfsDirFor(any()) } returns rootfs
        every { installer.prootTmpDirFor(any()) } returns File(rootfs, "tmp")
        every { installer.guruDir } returns guruDir
        every { installer.prootBin } returns prootBin
        every { installer.prootLoader } returns loader
        every { installer.prootLoader32 } returns loader32
        every { installer.tawcrootBin } returns File(nativeDir, "libtawcroot.so")
        return LinuxContainerEngine(
            mockk<Context>(relaxed = true),
            installer,
            mockk<ContainerOsDetector>(relaxed = true),
            mockk<ContainerSettingsRepository> {
                every { activeProfileFlow } returns flowOf(ContainerProfile.BUILTIN_ALPINE)
            },
            mockk<PathHomeResolver>(relaxed = true)
        )
    }
}
