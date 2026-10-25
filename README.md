# PCL 工具箱（第三方修改版）· DSH 插件

> **本插件是第三方基于 [Plain Craft Launcher (PCL)](https://meloong.com/pcl) 独立进行的二次创作**，
> 与 PCL 官方无隶属关系，也不代表 PCL 官方。名称按《PCL 存储库合理使用指南》二·重度使用 第 2 条命名。
>
> - PCL 作者署名：**龙腾猫跃（LTCat）** · 赞助：<https://meloong.com/afd/a/LTCat>
> - 本仓库**不含 PCL 的任何源代码、二进制或美术资源**（PCL 为 VB.NET，本插件为 JS 独立实现）
> - 许可证：**MIT**（见 [LICENSE](LICENSE)）；同时附带 PCL 的《LICENCE》原文（见 [PCL-LICENCE.md](PCL-LICENCE.md)）
> - 详见 [NOTICE](NOTICE) 与插件内「关于」页

源码仓库：<https://github.com/mrwisdon/dsh-pcl-toolbox>

包名 `@dsh-external/pcl-toolbox`，插件 id `pcl-toolbox`，侧栏入口「PCL 工具箱」，版本 0.4.0。

## 宣传片

61 秒，1080p30，**带中文配音**（合成语音）。所有数字都来自本机的真实验证，不是示意。
顺序按「下载 → 启动 → 诊断 → 资源 → 测速 → 可验证性 → 合规」走：先让你看到东西下下来，再谈启动。

[![宣传片](docs/promo/poster.png)](docs/promo/pcl-toolbox-promo.mp4)

- 视频：`docs/promo/pcl-toolbox-promo.mp4`（6.1 MB，配音 + 合成配乐）
- 分镜联排图：`docs/promo/frames.jpg`
- 分镜与旁白逐句对照：`docs/promo/narration.md`
- 分镜：开场 → **镜像下载** → 一键启动 → 崩溃诊断/脱敏 → 模组与整合包 → 下载源测速 → 可验证性 → 合规署名 → 尾帧

## 合规与许可（重要）

本插件按《PCL 存储库合理使用指南》中「重度使用」的要求逐条落实：

| 指南要求（二·重度使用） | 落实方式 |
|---|---|
| ① 明确表示是第三方基于 PCL 独立二创 | 本 README 首段、`NOTICE`、插件内「关于」页均写明 |
| ② 名称以 Plain Craft Launcher (PCL) 开头 + 第三方修改后缀 | 软件名 **「PCL 工具箱（第三方修改版）」**；未使用 PCL++ / PCL Pro 等禁用形式 |
| ③ 关于页首位署名龙腾猫跃 + 赞助链接、公开源代码、继续使用该 LICENCE | 「关于」页第一张卡就是署名 + 赞助按钮；仓库公开；`PCL-LICENCE.md` 为 PCL 原文件 |
| ④ 启动功能需实现 McLaunchPrecheck 一致（或更激进）的正版/赞助劝导 | `lib/precheck.js`：路径含 `!`/`;` 拒绝启动；按 PCL 的次数表（第 3/8/15… 次）提示买正版、第 10/20/40… 次提示赞助；正版登录后不再劝买 |
| ⑤ 不得有类似赞助解锁的功能；界面主色须为蓝色 | 无任何赞助解锁；主色 `#2563eb` / `#3b82f6`（蓝） |

另外两项对外部服务的合规：

- **BMCLAPI**（公益镜像）：所有请求统一带 `User-Agent`（`mirror.js` 的 `DEFAULT_USER_AGENT`），下载并发默认 8、
  上限 32，并对 429 做退避 —— 之前用 Node 默认 UA + 16 并发触发过限流。
- **Modrinth**：按其要求带 `user-agent`。

> 免责：以上为工程侧的合规实现，不构成法律意见；PCL 的《分发有限许可》正文见
> <https://shimo.im/docs/rGrd8pY8xWkt6ryW#anchor-X0bo>（需登录），对外分发 PCL 本体前请自行阅读。

## 为什么合并

分开时最别扭的一步是「下完还要去另一个入口找」。合并后：

- **下载默认落进启动器用的 `.minecraft`**（可改），下完的版本直接出现在启动页的版本下拉里。
- 从下载页签切回启动页签时，外壳会自动 `GET /mc/versions?refresh=1`，刚下好的版本立刻可见。
- 缺文件时启动页会拦住并列出清单，告诉你去下载页签补齐 —— 一个面板里闭环。

## 页签一：启动

- **实例自动发现**：扫 `versions/*/`，容忍目录名带空格（本机就有 `1.20.1-Fabric 0.19.5`），
  识别 `原版 / Forge / Fabric / NeoForge / OptiFine / LiteLoader`。
- **继承链合并**：`inheritsFrom` 递归展开（官方启动器、HMCL 装的实例会用到；PCL 写的是已合并 JSON）。
  库的顺序按 PCL 的规则：**子版本的库在前、父的在后**。
- **Java 自动选择**：扫 Mojang runtime（`.minecraft/runtime/*/release`）、PCL 实例强制 Java、
  PCL Java 列表、`Program Files` 下各厂商 JDK、`JAVA_HOME`、`PATH`；按 `javaVersion.majorVersion`
  匹配（先找相等，再找更大的）。**会真的跑 `java -version` 验证**（必须用 `java.exe`，`javaw.exe` 没有输出）。
- **参数拼装**：现代 `arguments.jvm/game` + 老版 `minecraftArguments`；rules 求值；占位符全表；
  classpath = 库（按 JSON 顺序）+ **客户端 jar 在最后**。补 `-Xmx/-Xms` 与 `-Dlog4j2.formatMsgNoLookups=true`。
- **natives**：现代（`natives-windows` classifier）与老式（`natives` + `classifiers`）都处理；
  **解压目标按实际 `-Djava.library.path` 解析**（26.x 是 `${natives_directory}/java`，1.20.1 是 `${natives_directory}`）。
  自带 100 行 ZIP 读取器，零依赖，带 marker 缓存。
- **账号**：离线（`OfflinePlayer:<name>` md5 → 稳定 UUID、`user_type=legacy`、token `0`）或正版令牌（`msa`）。
- **状态与日志**：pid / 运行时长 / 退出码 / 日志尾巴；「是否真的起来了」按日志 marker 判定
  （读**头尾各 256KB**，不是只看尾巴 —— 模组包日志会把启动标记冲掉）。手动停止不算崩溃退出码。
- **缺文件拦截**：检查客户端 jar / 库 / natives / 资源索引，缺就拒绝启动并列清单。

## 正版登录（Microsoft Account）

支持真·微软账号登录，不用手填 accessToken。链路与 PCL 完全一致（`ModLaunch.vb:880-1090`）：

```
微软 OAuth token → Xbox Live(XBL) → XSTS → api.minecraftservices.com/authentication/login_with_xbox
→ 权益校验(/entitlements/mcstore) → 档案(/minecraft/profile) → 拿到 { uuid, name, mc token }
```

两条前端流程，**只差第一步**：

| 流程 | 需要什么 | 体验 |
|---|---|---|
| **auth-code（默认，零配置）** | 无 | 点「微软登录」→ 浏览器登录 → 把回跳 URL 粘回面板 |
| device-code（高级） | 自己登记的 Entra `client id` | 面板显示一个 8 位代码 + 网址，自动轮询完成 |

为什么默认是 auth-code：设备码端点要求「已登记、接受个人账户、公共客户端」的 Entra 应用。
实测三个历史公共 id（`00000000402b5328` 等）在 `/consumers` 下**全部 `AADSTS700016`**，已经被关停；
而 `login.live.com` 的授权码入口仍返回 200，所以「公共 id + 授权码」是当下唯一零配置可用的路。

想要更顺的设备码流程，自己登记一个应用（免费，2 分钟）：

1. <https://portal.azure.com> → Microsoft Entra ID → 应用注册 → 新注册
2. 账户类型选 **「仅此组织目录中的账户」不行**，要选**「任何组织目录中的账户和个人 Microsoft 账户」**
3. 注册后在「身份验证」里：**允许公共客户端流 = 是**，勾上「设备代码流」
4. 把「应用程序(客户端) ID」填进配置 `msClientId`，`msFlow` 改成 `device-code`

安全说明：

- refresh token / MC access token 只落在 `<插件根>/.mc-launch/account.json`（写入时 0600），
  **任何 GET 路由都不回传 token**，面板只显示 `name` / `uuid` / 是否持有权益 / 过期时间。
- MC token 到期前会自动用 refresh token 重走一遍 2–6 步（`needsRefresh` 字段可看状态）。
- 「退出登录」= 清空本地账号文件，不影响微软账号本身。

## 页签二：版本（实例内容 + 诊断）

对应 PCL 的「版本设置 / 模组管理 / 崩溃分析」：

- **概览**：模组（启用/禁用）、资源包、光影、存档、配置、日志、崩溃报告各多少；实例占用；最后游玩时间；最新日志/崩溃。
- **内容管理**（7 个分类，全部本地文件操作）：
  - **模组**：启用 / 禁用（`X.jar` ↔ `X.jar.disabled`，**和 PCL 用同一个约定**，两边互相认）
  - **资源包 / 光影 / 存档 / 配置**：列表、打开位置、删除
  - **日志 / 崩溃报告**：点开预览尾巴（支持 `latest.log`、`.log.gz`、以及实例根目录的 `hs_err_pid*.log`）
  - 删除一律进 **`.dsh-trash/<时间戳>/`** 回收站，不硬删
- **存档信息**：解析 `level.dat`（自带最小 NBT 解析器）→ 存档名、MC 版本、游戏模式、最后游玩时间
- **崩溃分析**：13 类特征规则 + 两个杀手锏
  1. **从堆栈里揪肇事 jar**（`~[battlefield-0.1.0.jar%23164!/:0.1.0]` → `battlefield-0.1.0.jar`）
  2. **扫 `mods/` 判断缺失的类到底在不在某个 jar 里**：哪都不在 → 缺前置；在某个 jar 里 → 那个 jar 没被正常加载

本机实测（真实 1.20.1-Forge 实例）：

```
模组 7 启用 / 9 禁用 · 存档 22 · 配置 34 · 日志 657 · 崩溃报告 27 · 占用 1834 MB
崩溃分析 → 「崩溃原因：模组缺少类（jar 不完整或前置没装）」
           疑似 jar：battlefield-0.1.0.jar
           缺失类：io.github.littlebird.client.GroundViewMath
           扫了 16 个 jar → 该类确实存在于 battlefield-0.1.0.jar 里 → 那个 jar 没被正常加载
```

## Java 运行时管理

对应 PCL 的 `ModJava.vb`：**自己把 Java 下下来**，不用你手动装 JDK。

- 组件索引：`launchermeta/v1/products/java-runtime/<productId>/all.json`（走镜像也行）
- 每个组件先取 `manifest`（文件树，Windows 下约 400 个文件），再逐个下 `downloads.raw`
- 装到 `<minecraftDir>/runtime/<component>/`，装完读 `release` 校验 `JAVA_VERSION`
- 装好之后 `lib/java.js` 的扫描会**自动发现**它，`/mc/plan` 立刻能用新 Java

实测（2026-10，Windows 宿主）：

```
java-runtime-delta (Java 21)  94.5 MB / 402 文件 → 15 秒，换源 0 次，校验 21.0.7 ✓
java-runtime-gamma (Java 17)  86.9 MB / 403 文件 → 首版逻辑耗时 7 分钟（见下），修复后同法十几秒
```

**踩到的坑**：BMCLAPI **不镜像** `piston-data/v1/objects/`（404 / 429），但**镜像 `piston-meta/v1/packages/`**。
所以 manifest 走镜像、文件本身**官方优先、镜像兜底** —— 这一点写死在 `javaruntime.js` 里，
改回镜像优先会让每个文件都白等一次退避（94 次换源 → 整轮 7 分钟）。

相关路由：`GET /mc/java/runtimes` · `POST /mc/java/{plan,install,cancel,forVersion}` · `GET /mc/java/state`

## 设置页 + 下载源测速

「设置」页签把 `mc-launch.config.json` 做成表单（12 个字段：`.minecraft` 目录、实例隔离、默认内存、
离线玩家名、强制 Java、附加 JVM 参数、下载源偏好、下载并发、镜像地址、下载目录、正版登录流程、Entra client id）。

- **服务端校验**：越界数字被夹到范围内（`memoryMb:99999 → 32768`）、非法枚举被忽略并保留原值、
  `string[]` 支持「一行一个」
- 只有 `minecraftDir`/`gameDirMode` 改动会触发版本重扫
- **accessToken 永不出站**：GET 只回 `accessTokenSet: true/false`

**下载源测速**（PCL 的「下载源测速」）：对镜像与官方各打 3 个真实请求 —— 版本清单（JSON）、
客户端 jar（Range 1MB 看吞吐）、maven 库（Range 256KB）—— 按「成功率 → 吞吐 → 延迟」排序并给建议，
一键「采用建议」把 `downloadSourcePreference` 填好（仍需点保存生效）。

实测（本机）：

```
Mojang 官方    score 3  manifest 637ms  client 218ms(1MB)  maven 1059ms  → 4.59 MB/s
BMCLAPI 镜像   score 3  manifest 786ms  client 1510ms(1MB) maven  944ms  → 0.66 MB/s
推荐：official-first（镜像的 /assets 会 302 到签名 CDN）
```

## 多账号

- 存储从单账号文件升级成 `.mc-launch/accounts.json`（`{version, active, accounts:[...]}`），
  **旧 `account.json` 自动迁移**（读到时迁成多账号，active 指向它）
- 「启动」页签的账号卡：登录过 2 个以上账号时出现**账号下拉**，切换即生效（`POST /mc/ms/switch`）
- 启动时用**当前活动账号**的令牌；「退出登录」移除当前账号（令牌随账号一起删）
- 对外只给 `name/uuid/owned/过期时间/是否活动`，**令牌永不回传**

相关路由：`GET /mc/ms/accounts` · `POST /mc/ms/switch {uuid}` · `POST /mc/ms/remove {uuid}`

## 崩溃报告脱敏分享

「版本」页签 → **崩溃** 分类里，除了「分析崩溃」还有 **「生成脱敏报告」**：把它整理成一份可以安全贴到
论坛/issue 的 Markdown，并**自动复制到剪贴板**。

脱敏规则（宁多勿少）：

| 目标 | 替换 |
|---|---|
| Windows / Unix 用户目录 | `<USER_PATH>` |
| `Setting user: xxx` | `<PLAYER>` |
| UUID（36 位或有/无连字符的 32 位 hex） | `<UUID>` |
| `Bearer …` / `--accessToken …` / 长 base64 | `<TOKEN>` |
| IPv4 / IPv6 | `<IP>` |

保留的是排障必需的东西：异常类型、类名、模组 jar 名、Java/OS/显卡信息、诊断结论与建议。
报告写到实例的 `.dsh-crash-share/crash-share-<时间>.md`。

实测：真实崩溃报告 → 3773 字 Markdown，诊断出「模组缺少类」+ 点名 `battlefield-0.1.0.jar`，
**泄漏检查（用户名 / Windows 路径 / token / IP / UUID）全部为空**。
合成样例也验证过各种敏感串确实被替换（顺手修掉 IPv6 正则把时间 `23:27:38` 当地址误伤的问题）。

## 皮肤管理（正版）

`/mc/skin/{current,set,reset}`：读当前皮肤/披风、按 URL 换肤（`classic`/`slim`）、恢复默认。
令牌只在宿主侧使用，**任何响应都不含 token**。

离线账号没有这个能力（换肤是账号服务端行为）——未登录时接口如实返回：

```
409 {"ok":false,"error":"还没登录正版账号（换肤是账号服务端行为，离线账号做不了）"}
```

面板入口：**「启动」页签 → 「皮肤（正版）」卡**（当前皮肤贴图预览 + 图片直链 + 经典/细手臂 + 应用/恢复默认）。
未登录时卡片会说明「离线账号做不了换肤」。

## 存档备份 / 还原

「版本」页签 → **存档** 分类：列表卡右上角「备份全部存档」，下面多一张 **存档备份卡**。

- 备份打成 zip 放进实例的 `.dsh-backups/`，包里带 `.dsh-backup.json`（存档名/文件数/字节/时间）
- **还原**：目标存档已存在就先整目录移到 `.dsh-trash/<时间戳>/saves/`（可恢复），再解压；
  单个存档还原会**落回 `saves/<存档名>/`**（第一版把文件散在了 `saves/` 根上，已修）
- 备份卡里每行有「还原备份 / 删除备份」，两个都走二次确认

## 模组更新检查

「版本」页签 → **模组** 分类：列表卡右上角「检查更新」，下面出 **模组更新卡**。

原理：把 `mods/*.jar` 的 **sha1** 批量 POST 到 Modrinth `/version_files` 反查项目 → 再按
「当前实例的 MC 版本 + 加载器」查最新版本 → 逐行给出 `当前版本 → 最新版本`。
非 Modrinth 来源（国内站点/自建模组）不会被匹配，会如实计入「未知」。

实测（1.20.1-Forge，7 个启用模组）：

```
检查 7 · 命中 Modrinth 4 · 可更新 3 · 已最新 1 · 非 Modrinth 来源 3
↑ JEI   15.21.0.138 → 15.74.0.229
↑ TaCZ  1.1.8        → 1.1.8-hotfix2
↑ Jade  11.13.2      → 11.13.3
✓ Xaero 26.6.0       → 26.6.0
```

## 实例导出（zip）

「版本」页签的列表卡右上角有 **「导出 zip」**：把实例的 `mods/ config/ defaultconfigs/ options.txt servers.dat`
打包，并在包里写一份 `dsh-export.json` 清单（来源实例 / MC 版本 / 加载器 / 各分类文件数 / 导出时间）。

- 默认**不导出** `resourcepacks / shaderpacks / saves`（体积大且是个人数据），可用 `include` 打开
- 跳过 `logs / crash-reports / natives / libraries / assets / .dsh-trash`（这些不该进包）
- 单文件 >256MB 或总量 >4GB 会被跳过并如实回报（`skipped`）
- zip 由插件自己写（`lib/zip.js` 的 `writeZip`，自带 CRC32；不引依赖）

**实测**：1.20.1-Forge 实例 → 196 个条目、198.0 MB 原始 → **192.7 MB zip / 8.7 秒**，
用同一个 zip 读取器回读核对：条目数一致、抽查一个 1.4MB 的 mod jar **字节完全相同**、`options.txt` 在内。

## 整合包（.mrpack）

「资源」页签里点一下 **模组 → 整合包** 就切到整合包市场（同一个搜索框）。安装一个 `.mrpack` 会：

1. 读 `modrinth.index.json`（`dependencies.minecraft` + `fabric-loader`/`quilt-loader`/`forge`/`neoforge`）
2. 确认原版已装（没有就明确报错，告诉你去「下载」页签先下）
3. **按依赖装加载器**（Fabric/Quilt 走 meta；Forge/NeoForge 跑 installer，复用第 3 轮的「失败→镜像预置→重试」）
4. 把 `files[]` 下到实例目录（`mods/…` 等，带 sha1 校验）
5. 解压 `overrides/`（以及 `client-overrides/`）—— **只解开该前缀下的内容**，不会在实例里制造游离目录
6. 写 `.dsh-pack.json` 标记，以后可以据此判断「这个实例来自哪个整合包」

也支持装本地 `.mrpack`（`POST /mc/pack/install {source:"local", path:"D:\x.mrpack"}`）。

**实测（临时目录，不碰你的 .minecraft）**：

```
Fabulously Optimized 14.1.1 · MC 26.2 · fabric 0.19.5
预览：51 个文件 / 42.8 MB
安装：加载器库 7 个 → 51 个文件全下完（42.8MB）→ overrides 57 个文件 → 标记写入
落盘：versions/26.2-fabric-0.19.5/{json, mods(49 jar), config, resourcepacks, .dsh-pack.json}
```

## 模组市场（Modrinth）

「资源」页签：搜模组 → 一键装进当前实例的 `mods/`。

- **不用选游戏版本/加载器**：从当前实例推断（`base` + `loader`），搜出来的结果一定是能装的
- 搜索走 Modrinth facets：`project_type:mod` + `versions:<mc>` + `categories:<loader>`，三种排序（相关度/下载量/最新）
- 安装时**自动解析 required 依赖**（BFS，深度 2）：主文件 + 依赖一起下，`unresolved` 会如实回报
- 下载带 sha1 校验；已存在且大小一致的文件跳过
- 面板会显示该实例 `mods/` 里已有多少文件

实测（本机）：`jei` @1.20.1/forge → 82 个结果、JEI 8600 万下载；依赖解析出 `mezz_config`；
两文件 6.9MB 下到临时目录后 **sha1 全部对**。

## 加载器安装（Fabric / Quilt / Forge / NeoForge）

对应 PCL 的「安装 → Forge/Fabric」那块。两条完全不同路径：

| 类型 | 做法 | 依赖 |
|---|---|---|
| **Fabric / Quilt** | 从 meta 取 `profile/json`（`inheritsFrom` = 原版），写成 `versions/<id>/<id>.json`，再把 profile 引用的 7 个 maven 库下下来 | 原版版本已存在 |
| **Forge / NeoForge** | 下载官方 `*-installer.jar`，用选好的 Java 跑 `--installClient`；installer 自己写版本 JSON 并跑 processors | Java（本轮已能自动装） |

**Forge/NeoForge 的坑（本轮实测踩穿）**：installer 会从 `maven.neoforged.net` 等**官方 maven** 拉处理器依赖
（`installertools:4.0.17:fatjar`、`neoforge:…:universal`，这两个**不在版本 JSON 里**），国内必失败，
现象是 `These libraries failed to download` + 退出码 1。所以 installer 跑失败时会：

1. 从输出里解析出**失败坐标**（`parseFailedArtifacts`）
2. 用 **BMCLAPI maven 优先、官方兜底**把它们预置进 `libraries/`（`seedArtifacts`）
3. 重跑 installer（最多 3 轮）

另外 `POST /mc/loader/repair` 可以按版本 JSON 把缺的库补齐（同一个镜像策略）。

界面：**「版本」页签 → 「安装加载器」卡**（加载器 / 原版版本 / 加载器版本三个联动下拉 + 进度 + 已装实例）。

**实测证据（本机，2026-10）**：

```
Fabric 0.20.1 → 26.2    写版本 JSON + 7 个库 → /mc/plan 缺失 0 → 真启动 booted=true（日志里是 knot// 类加载器）
NeoForge 26.2.0.93      首轮 exit=1（官方 maven 失败，版本 JSON 已生成、缺 16 库）
                        → /repair 用镜像补齐 16/16 → 再跑 installer exit=0（Extracting client.lzma）
                        → /mc/plan 缺失 0、cp=115 → 真启动 booted=true（FML 加载 neoforge-26.2.0.93-universal.jar）
```

顺带修了两个继承链上的真 bug（都是装 Fabric 时暴露的）：
1. Fabric profile **没有 `jar` 字段** → 以前会去找 `<自定义实例名>.jar`；现在按继承链取**最底层原版 jar**
2. 加载器实例**没有 `javaVersion`** → 以前当成"无要求"随手挑了个 Java 21；现在从父版本继承（26.2 → Java 25）

## 页签三：下载

- 经 **BMCLAPI 镜像**下载任意版本：版本清单 / 版本 JSON / 客户端 jar / 库（maven）/ 资源索引 / 资源对象。
- **逐文件 SHA-1 校验**，先写 `.part` 再 rename，带断点续传（Range）。
- **多源回退**：每个文件带一组有序候选源，镜像失败顺延到官方源；429 先按 `Retry-After` 退避再换源。
- 并发默认 16（实测 32 也 0 失败，但 16 更稳）；实时进度（字节/s、ETA、按类别完成度、失败清单、日志）。

### BMCLAPI 实测（2026-10，本机）

| 端点 | 镜像路径 | 实测 |
|---|---|---|
| 版本清单 | `/mc/game/version_manifest_v2.json` | 200，278,138 B，920 个版本 |
| 版本 JSON | `/version/{v}/json` | 200 |
| 客户端 jar | `/version/{v}/client` | **28,335,587 B，sha1 与官方一致，10.5 MB/s** |
| 库 | `/maven/{artifact.path}` | 200 |
| 资源索引 | `/v1/packages/{sha1}/{id}.json` | 200，464,718 B |
| 资源对象 | `/assets/{hash[0:2]}/{hash}` | 200（**必须直连**，走本地代理会 000） |

三个坑：① 清单/版本 JSON 里的 URL 仍是 mojang 官方，**不会被改写**，得自己重建；
② `/version/{v}/{任意名}` 是 catch-all（`.json` 给版本 JSON，其余给 client.jar）；
③ `/assets/` 是 **302 到临时签名 URL + 429 限流**（`Retry-After-short ≈ 19s`），硬打必被限流。

**整版本实证**：1.21.4 → 4,126 文件 / 499.4 MB，0 失败、逐文件 sha1 全对。

## 侧栏入口

一个图标（方块 + 播放三角 + 下载箭头），运行中右下角带蓝点。点开是同一个面板，顶部切页签。

## 和 PCL 2.14 的对照

| 环节 | PCL（`ModLaunch.vb` / `ModMinecraft.vb` / `ModNet.vb`） | 本插件 |
|---|---|---|
| classpath | 库 → OptiFine 倒数第二 → client jar 最后 | 同 |
| natives | 看 JSON 有没有 `natives.windows` 决定解压还是进 classpath | 都处理，但解压目标按 `java.library.path` 实际值 |
| `--version` | 实例夹名 | 同 |
| Java 选择 | 实例强制 → 版本要求 → 全局列表 | 同 + 扫 Mojang runtime（26.x 要 Java 25，系统里没有，靠这条找到） |
| 停进程 | `Kill()` | `taskkill /PID /T /F`（连带 Java 子进程） |
| 镜像多源 | 每文件 `Sources[]`，bmclapi 的 403/429 不禁用源 | 同 |
| 429 退避 | `Thread.Sleep(10000)` | 按 `Retry-After`（1–30s 夹取） |
| 我们补的 | PCL 不填 `${clientid}`/`${auth_xuid}`、不处理 `logging.client.argument` | 都做了 |

## 路由

单前缀 `/mc`，下载页签挂在 `/mc/dl` 下（同一个 HTTP 前缀，避免 `'/mc'` 与 `'/mc-dl'` 互相截胡）。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/mc/state` | 启动页主数据源 |
| GET | `/mc/versions?refresh=1` | 版本列表（带缺失统计） |
| POST | `/mc/plan` | 出启动计划，不启动 |
| POST | `/mc/launch` | 真启动 |
| POST | `/mc/stop` | 停止 |
| GET | `/mc/status` | 运行状态 + 启动判定 |
| POST | `/mc/open` | 打开实例目录 |
| POST | `/mc/config` | 保存配置 |
| GET | `/mc/diag` | 启动侧体检 |
| GET | `/mc/dl/state` | 下载页主数据源 |
| GET | `/mc/dl/manifest` | 版本清单 |
| POST | `/mc/dl/plan` · `/mc/dl/start` · `/mc/dl/cancel` | 计划 / 开始 / 取消 |
| POST | `/mc/dl/open` | 打开下载目录 |
| GET | `/mc/dl/diag` | 下载侧体检（四个关键端点真实请求 + 耗时） |
| GET | `/mc/inst/summary` | 实例概览（模组/存档/日志/崩溃计数、占用、最后游玩） |
| GET | `/mc/inst/content` | 某个分类的内容列表（`kind=mods\|resourcepacks\|shaderpacks\|saves\|config\|logs\|crashReports`） |
| POST | `/mc/inst/toggle` · `/mc/inst/delete` · `/mc/inst/open` | 模组启停 / 删除到回收站 / 打开位置 |
| GET | `/mc/inst/log` | 读日志或崩溃报告（支持 `.gz` 与 `hs_err_pid*.log`，`tail` 控制行数） |
| POST | `/mc/inst/analyze` | 崩溃分析（返回 findings + suspects: 疑似 jar / 缺失类 / 扫描结论） |
| GET | `/mc/inst/saves` · `/mc/inst/backups` | 存档列表（带 level.dat 摘要）/ 备份列表 |
| POST | `/mc/inst/backup` · `/mc/inst/restore` · `/mc/inst/backupDelete` | 备份 / 还原 / 删备份 |
| POST | `/mc/mod/updates` | 用 sha1 反查 Modrinth 并比对最新版本 |
| POST | `/mc/inst/shareCrash` | 生成脱敏崩溃报告（Markdown） |
| GET/POST | `/mc/skin/{current,set,reset}` | 读皮肤 / 按 URL 换肤 / 恢复默认（需正版） |
| GET/POST | `/mc/settings` | 读写设置（读带字段元数据；写带服务端校验） |
| POST | `/mc/net/speedtest` | 镜像 vs 官方实测（manifest / client / maven）并给建议 |
| GET | `/mc/inst/exportPreview?instance=` · POST `/mc/inst/export` | 预览导出体积 / 真导出 zip |
| GET | `/mc/pack/list?mc=&q=` | 搜整合包（`project_type:modpack`） |
| POST | `/mc/pack/versions` · `/mc/pack/inspect` | 该包的 `.mrpack` 版本列表 / 本地包预览 |
| POST | `/mc/pack/install` | 装整合包（Modrinth 或本地路径），后台任务 |
| GET | `/mc/pack/state` · `/mc/pack/marker?instance=` | 安装进度 / 实例的整合包标记 |
| GET | `/mc/mod/search?q=&mc=&loader=&sort=` | Modrinth 搜索（facets 过滤） |
| GET | `/mc/mod/versions?id=&mc=&loader=` · `/mc/mod/project?id=` | 版本列表 / 项目详情 |
| POST | `/mc/mod/install` | 装进实例 `mods/`（含 required 依赖解析） |
| GET | `/mc/mod/installed?instance=` | 该实例已装的模组文件 |
| GET | `/mc/loader/list?type=&mc=` | 加载器可选版本（fabric/quilt/forge/neoforge） |
| POST | `/mc/loader/install` · `/mc/loader/repair` | 安装加载器 / 按版本 JSON 补齐缺库 |
| GET | `/mc/loader/state` · `/mc/loader/instances` | 安装进度 / 已装实例 |
| GET | `/mc/java/runtimes` | Java 组件索引 × 是否已安装（含索引版本与已装版本对比） |
| POST | `/mc/java/plan` · `/mc/java/install` · `/mc/java/cancel` | 计划 / 安装 / 取消 |
| POST | `/mc/java/forVersion` | 某个版本需要哪个 Java 组件、装没装 |
| GET | `/mc/java/state` | 安装进度（文件数/字节/速度/校验结果） |
| GET | `/mc/ms/state` | 正版登录状态（只回 name/uuid/权益，**不含 token**） |
| POST | `/mc/ms/start` | 开始登录：auth-code 返回授权页 URL；device-code 返回 user_code + flowId |
| POST | `/mc/ms/poll` | device-code 轮询 |
| POST | `/mc/ms/complete` | auth-code：把回跳 URL 或 code 交回来，换 token 并落盘 |
| POST | `/mc/ms/refresh` · `/mc/ms/logout` · `/mc/ms/ensure` | 续期 / 退出 / 启动前确保可用 |

排障：

```bash
curl -s http://127.0.0.1:14534/mc/diag
curl -s http://127.0.0.1:14534/mc/dl/diag
```

## 配置

`mc-launch.config.json`（包根目录；旧的 `pcl-launch.config.json` 仍会被读取用于迁移）：

```json
{
  "minecraftDir": "%APPDATA%\\.minecraft",
  "memoryMb": 4096,
  "username": "",
  "uuid": "",
  "accessToken": "",
  "java": "",
  "gameDirMode": "isolated",
  "extraJvmArgs": [],
  "selectedVersion": "",
  "downloadDir": "",
  "downloadConcurrency": 16,
  "downloadMirror": "",
  "downloadSourcePreference": "mirror-first",
  "msClientId": "",
  "msFlow": "auth-code"
}
```

- `gameDirMode`：`isolated`（版本隔离，PCL 默认）/ `shared`（`.minecraft` 根）。
- `downloadDir`：空 = 跟 `minecraftDir` 走（推荐，下完即可启动）。
- `downloadSourcePreference`：`mirror-first` / `official-first` / `mirror-only`。实测官方优先后比镜像优先快约 3.6 倍（镜像每文件多一跳 302），但默认仍按需求走镜像优先。

## 自检

```bash
node scripts/selftest.mjs          # 离线：rules/继承推断/账号/日志判定/ZIP 解压（6 组）
node scripts/selftest.mjs --real   # 真实 .minecraft：4 个实例逐个出计划（12 组）
node scripts/selftest.mjs --run    # 真启动一次，观测 marker 后自动停（13 组）
node scripts/selftest.mjs --run --version=26.2
```

**本机实测**：

```
4 个版本 / 10 个 Java 候选
26.3-Fabric 0.19.5   Java 25  cp=82  natives=21  缺失=0
1.20.1-Fabric 0.19.5 Java 17  cp=73  natives=21  缺失=0
26.2                 Java 25  cp=89  natives=34  缺失=0
1.20.1-Forge_47.4.20 Java 17  cp=94  natives=21  缺失=0   ← PCL 实例强制 Java
真启动 Forge 1.20.1 与 原版 26.2 均 booted=true（26.2 日志到 NVIDIA RTX 4060 / OpenGL）
```

## 已知边界

- **正版登录**：默认走「公共 id + 授权码」流程；设备码需要自备 Entra client id。
  登录链路本身已实测到「第一步真实往返 + 后 5 步端点可达」，但**完整登录需要你的微软账号**，
  我无法代替你完成最后一步 —— 面板里点一次就能验证。
- **不写 PCL 元数据**：`versions/<id>/PCL/config.json` 只读不改。
- 下载的版本若想带 Forge/Fabric，仍需对应加载器的安装步骤（本插件只下原版文件）。
- 主要按 Windows 做（`javaw.exe` / `taskkill`）；darwin/linux 分支未实机验证。
- `assets/log_configs/client-1.21.x.xml` 缺失只会让日志格式退化，不影响启动。

## 迁移说明

- 旧的 `dsh-mc-downloader` 插件已并入本包，profile 里那个 bundle 可以删除，目录也可删除。
- 路由：`/mc-dl/*` → `/mc/dl/*`；`/pcl-launch/*` → `/mc/*`。
- 状态目录：`.pcl-launch/`、`.mc-download/` → `.mc-launch/`（旧的可直接删）。
- 侧栏入口 id：`pcl-launch` / `mc-downloader` → **`mc-toolbox`**（一个入口）。

## 许可

MIT。图标为本项目自绘 SVG。
