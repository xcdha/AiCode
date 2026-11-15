# 二开改动与上游同步指南

本仓库是 [jieapi/AiCode](https://github.com/jieapi/AiCode) 的二开版本（fork：`xcdha/AiCode`）。
**上游会持续更新，二开不能丢同步能力**，所以所有自定义改动都遵循同一套约定。

## 一、二开约定（加新功能前先读）

1. **优先新增文件，少改上游文件**。新功能尽量独立成文件（如 `AnimatedBackground.kt`），
   上游文件里只做「最少行的接入」。
2. **所有自定义代码打 `[二开]` 注释标记**。用 `grep -rn "\[二开\]" app/src` 可一次看全改动面，
   同步上游出现冲突时，按标记保留本地实现即可。
3. **不改上游 DataStore key 语义**。新增字段用新 key（如 `background_image_kind`），
   老数据缺失时给默认值兜底，保证升级无感。
4. **不动上游的构建脚本 / CI / 迁移编号**。这些是最容易和上游打架的地方。
5. **文档同步**：用户可见行为变了就更新 `docs-site/docs/`，用户可见文案必须进
   `values/strings.xml` 与 `values-en/strings.xml` 两份。

## 二、当前已实现的二开功能：动态背景（GIF / MP4）

上游背景只支持静态图片（叠加在所有页面之上的水印层，透明度 0~20%）。
二开在此基础上增加 **GIF 动图** 与 **MP4 视频** 两种背景，机制对齐 VantaCode 2.0。

### 涉及文件

| 文件 | 改动性质 | 说明 |
| --- | --- | --- |
| `feature/settings/presentation/component/AnimatedBackground.kt` | **新增** | GIF / MP4 背景渲染（`GifBackgroundView` / `VideoBackgroundView`） |
| `feature/settings/data/repository/BackgroundSettingsRepository.kt` | 小改 | 新增 `Kind{IMAGE,GIF,MP4}`、`kindFlow`、`mimeToKind`；`setBackgroundImage` 增加 `mime` 参数（默认 null，向后兼容） |
| `feature/settings/presentation/SettingsViewModel.kt` | 小改 | 新增 `backgroundKind` 状态与采集；`setBackgroundImage(uri, mime)` |
| `feature/settings/presentation/component/BackgroundImageSheet.kt` | 小改 | 选择器由 `ImageOnly` 改为 `ImageAndVideo`；MP4 用首帧做缩略图；新增类型说明文案 |
| `feature/settings/presentation/component/SettingsScreen.kt` | 小改 | 透传 `backgroundKind`，设置首页显示 `MP4 视频 · 15%` 之类的类型前缀 |
| `MainActivity.kt` | 小改 | 全局背景层按 `Kind` 分发：GIF / MP4 走动态渲染，IMAGE 保持上游原逻辑 |
| `res/values/strings.xml`、`res/values-en/strings.xml` | 小改 | 新增 3 条文案 |

### 数据存储

沿用上游的 `background_prefs` DataStore：

- `background_image_path`：媒体文件绝对路径（复制到 `filesDir/backgrounds/bg_<ts>.<ext>`）
- `background_alpha`：透明度（0~0.2）
- `background_image_kind`：**二开新增**，`IMAGE` / `GIF` / `MP4`；键缺失时按 `IMAGE` 处理

类型由选择器返回的 MIME 判定：`image/gif → GIF`、`video/mp4 → MP4`、其余 → `IMAGE`。

### 渲染实现

- **静态图**：上游逻辑不变，`decodeBackgroundBitmap` 采样解码后 `Image(ContentScale.Crop)`。
- **GIF**：`android.graphics.Movie` 解码整段动画，`LaunchedEffect` 起 33ms 帧循环，
  `elapsed % duration` 取当前帧，`Canvas` 手绘并按「短边铺满 + 居中裁剪」缩放
  （等价 `ContentScale.Crop`），外层 `Modifier.alpha()` 控制水印透明度。
- **MP4**：`AndroidView` 包一个 `TextureView`（不是 `SurfaceView`，这样才能参与 Compose 图层合成、
  透明度才生效），`SurfaceTextureListener` 拿到 `Surface` 后交给 `MediaPlayer`：
  `setLooping(true)`、`setVolume(0f, 0f)`（静音）、`prepareAsync()` → `onPrepared` 起播；
  `DisposableEffect` 在离开页面时 `stop()` + `release()`，不留后台解码。

### 已验证 / 未验证

- 逻辑与 VantaCode 2.0 反编译结果逐条对齐（`BackgroundSettingsRepository.mimeToKind`、
  `AnimatedBackground.VideoBackgroundView` / `GifBackgroundView`）。
- **未在本容器内编译**：当前环境没有 Android SDK，无法执行 `./gradlew :app:assembleUniversalDebug`。
  合入前请在本地或 CI 跑一次冒烟编译。

## 三、同步上游

```bash
# 只看上游有没有新提交（不修改本地分支）
scripts/sync-upstream.sh

# 把当前分支变基到 upstream/main 之上（推荐，提交历史干净）
scripts/sync-upstream.sh --rebase

# 或者用 merge 方式合入（保留二开分支的提交图）
scripts/sync-upstream.sh --merge
```

脚本会自动：`git remote add upstream https://github.com/jieapi/AiCode.git` → `fetch` →
变基/合并 → 打印结果。等价的纯手工命令：

```bash
git remote add upstream https://github.com/jieapi/AiCode.git   # 只需一次
git fetch upstream main
git rebase upstream/main            # 或 git merge upstream/main
```

### 冲突处理

冲突几乎只会出现在上面表格里那 6 个「小改」文件，处理原则：

- 看到 `[二开]` 注释：保留本地实现，把上游新逻辑融合进来。
- 新增文件（`AnimatedBackground.kt`）不会有冲突。
- 若上游重构了背景相关代码（比如自己加了视频背景），**优先删掉本地重复实现、改用上游版本**，
  只需保证 `Kind` 与 UI 文案仍在。

放弃本次同步、回到操作前：

```bash
git rebase --abort     # 变基模式
git merge --abort      # 合并模式
```

### 推送

变基会重写提交，需要非快进推送：

```bash
git push --force-with-lease origin <branch>
```

`--force-with-lease` 会在远端被别人改动过时拒绝推送，比 `--force` 安全。脚本不会自动强推。


## 四、发版签名（GitHub Actions）

`.github/workflows/android-release.yml` 用 4 个 Secret 现场组装签名，**仓库里不存任何密钥文件**
（`*.jks` / `keystore.properties` 都已在 `.gitignore` 里）。

| Secret | 内容 | 说明 |
| --- | --- | --- |
| `AICODE_KEYSTORE_BASE64` | `app/aicode.jks` 的 **单行** base64 | 约 5.8 KB |
| `AICODE_KEYSTORE_PASSWORD` | keystore 口令 | PKCS12 |
| `AICODE_KEY_ALIAS` | 证书别名 | 如 `aicode` |
| `AICODE_KEY_PASSWORD` | 私钥口令 | PKCS12 下与 store 口令相同 |

### 重新生成 keystore

```bash
keytool -genkeypair -keystore aicode.jks -alias aicode \
  -keyalg RSA -keysize 4096 -validity 10950 -storetype PKCS12 \
  -storepass '<口令>' -keypass '<口令>' \
  -dname "CN=AiCode, OU=Personal, O=AiCode, L=Beijing, ST=Beijing, C=CN"

# 必须单行（-w0），否则贴进 Secret 后解码可能出问题
base64 -w0 aicode.jks > aicode.jks.b64
```

然后把 4 个值填进 `Settings → Secrets and variables → Actions`。

### 踩过的坑：`Tag number over 30 is not supported`

构建跑到 `packageXxxRelease` 才失败，报：

```
KeytoolException: Failed to read key  from store ".../app/aicode.jks": Tag number over 30 is not supported
```

两个信息点：

1. `Failed to read key `（别名是**空的**）→ `AICODE_KEY_ALIAS` 没配；
2. `Tag number over 30 is not supported` 是 ASN.1 解析报错，意思是**这个文件根本不是 keystore**——
   最常见原因是把 `.jks` **二进制**直接粘进了 Secret（Secret 只能存文本，二进制会被破坏），
   或者 base64 复制不全。

现在 workflow 里加了一步预检（`Restore release keystore & generate signing config`）：
Secret 缺失、base64 解码失败、口令不对、别名不存在，都会在 **10 秒内**明确报错，
不会再等到打包阶段才炸。

### 换签名的影响

Android 要求升级包的签名与已安装版本一致。**换 keystore 后，老用户必须先卸载再装新包**。
本仓库在换成当前这套密钥之前没有发布过任何 Release，所以不存在这个问题；
以后如需再换，务必先在 Release 说明里写清楚。

## 五、已落地的二开功能清单

| 功能 | 入口 | 主要文件 |
| --- | --- | --- |
| 品牌 Guru / 包名 `com.bysqh.guru` | 全局 | `app/build.gradle.kts`、`app/src/main/res/values*/strings.xml` |
| 容器内部路径 `.guru` | 全局 | `assets/guru/**`、`ContainerInstaller`、`LinuxContainerEngine` |
| 动态背景（GIF / MP4） | 设置 → 背景图 | `AnimatedBackground.kt`、`BackgroundSettingsRepository` |
| 桌宠（表情随 Agent 状态） | 设置 → 桌宠 / 聊天页悬浮层 | `feature/pet/**` |
| 记忆页 | 设置 → 记忆 | `MemorySection`、`MemoryViewModel` |
| 角色 | 设置 → 角色 / 聊天侧边栏 | `feature/agent/domain/role/**`、`RolesSection` |
| 系统规则片段开关 | 设置 → 系统规则 | `PromptFragmentToggleRepository`、`PromptFragmentCatalog` |
| 外观与主题整页（含 Miuix / 强调色 / 色彩风格 / 缩放 / 纯黑） | 设置 → 外观主题 | `AppearanceSettingsSection.kt`、`AppearanceOptions.kt`、`AIEditorTheme.kt` |

> 容器内部路径改名是唯一会波及 `provision.sh` 等 17 个脚本的改动；
> 升级到本版本后，旧 `~/.aicode` 下的配置（技能、记忆、MCP、凭据）不会自动迁移，
> 需要用户重新配置或手动把 `filesDir/aicode` 改名为 `filesDir/guru`。
