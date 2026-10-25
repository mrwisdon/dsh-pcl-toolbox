# PCL 功能移植路线图（PCL 工具箱）

目标：把 [PCL 2.14](https://github.com/Meloong-Git/PCL) 的功能尽可能完整地搬进 DSH 的「MC 工具箱」插件。
> **状态：23/23 已实现（另 2 条标为不适用）。** 最终交付说明见 [DELIVERY.md](DELIVERY.md)。

本文件是**可追踪的清单**：每条都标了状态与验证方式。状态图例：

- ✅ **已完成**：有实现 + 实测证据（写在 README / 本文件的「证据」列）
- 🟡 **部分完成**
- ⬜ **待做**
- ⛔ **不适用**：依赖 PCL 自家服务或与 DSH 形态冲突

## 已覆盖

| # | PCL 功能（源码位置） | 状态 | 本插件实现 | 状态 |
|---|---|---|---|---|
| 1 | 启动实例 `ModLaunch.vb` | ✅ | `lib/launch.js` `lib/args.js` `lib/versions.js` `lib/java.js` | 4 个真实实例出计划；Forge 1.20.1 与 26.2 真启动 `booted=true` |
| 2 | 版本下载 `ModDownload.vb` | ✅ | `lib/download.js` `lib/downloader.js` `lib/mirror.js` | 1.21.4 全量 4126 文件 / 499.4MB，逐文件 sha1 全对 |
| 3 | 正版登录 `ModLaunch.vb:880-1090` | ✅ | `lib/msa.js` `lib/ms-routes.js` | 授权页 URL + 真实往返（假 code 换回 invalid_grant）；账号卡端到端渲染 |
| 4 | 离线账号 / 皮肤名 | ✅ | `lib/args.js buildAccount` | 离线 UUID 稳定 |
| 5 | 实例内容管理 `PageInstanceMod` | ✅ | `lib/instance.js` `lib/inst-routes.js` | 真实实例：16 模组（7/9）、22 存档、27 崩溃、657 日志 |
| 6 | 模组启用/禁用 | ✅ | `instance.js toggleMod` | 真实 `*.jar.disabled` 文件可识别；临时目录往返测试通过 |
| 7 | 存档信息（level.dat） | ✅ | `instance.js readLevelDat`（自带 NBT 解析） | 真实存档读出 `1.20.1 · 创造` / 最后游玩时间 |
| 8 | 崩溃分析 `ModCrash.vb` | ✅ | `instance.js analyzeText/enrichSuspects` | 真实报告 → 点名 `battlefield-0.1.0.jar` + 缺失类在 jar 内的判定 |
| 9 | 日志查看 | ✅ | `instance.js readLog` | 支持 `latest.log`、`.log.gz`、`hs_err_pid*.log` |
| 10 | Java 检测与选择 `ModJava.vb` | ✅ | `lib/java.js` | 自动发现 8 个 Java（含新装的 3 个 Mojang runtime），按版本要求匹配 |
| 11 | **Java 运行时下载** `ModJava.vb:381` | ✅ | `lib/javaruntime.js` `lib/java-routes.js` | `java-runtime-delta` 94.5MB / 402 文件 **15 秒**装完、sha1+release 校验通过；`gamma 17.0.15` 同法装好 |
| 12 | **Fabric / Quilt 安装** `ModDownloadLib:1630` | ✅ | `lib/loaders.js installFabricLike` | Fabric 0.20.1+26.2 装出实例 → 计划缺失 0 → 真启动 `booted=true` |
| 13 | **Forge / NeoForge 安装** `ModDownloadLib:903/1118` | ✅ | `lib/loaders.js installForgeLike` | NeoForge 26.2.0.93：installer 失败→镜像预置→重试→exit 0 → 真启动 `booted=true` |
| 14 | **模组市场（Modrinth）** `PageDownloadMod` | ✅ | `lib/modrinth.js` `lib/mod-routes.js` | 「资源」页签：搜索 82 条、依赖解析出 mezz_config、6.9MB 文件 sha1 全对；活体 `/mc/mod/*` 全 200 |
| 15 | **整合包安装（.mrpack）** `ModModpack.vb` | ✅ | `lib/modpack.js` `lib/pack-routes.js` | Fabulously Optimized 14.1.1 @26.2：加载器+51 文件 42.8MB+57 overrides 全过（临时目录端到端） |
| 16 | **实例导出（zip）** `PageInstanceExport` | ✅ | `lib/export.js` + `zip.js writeZip` | Forge 实例 196 条目 / 198MB → 192.7MB zip / 8.7s，回读抽查 jar 字节一致 |
| 17 | **设置页** `PageSetup*` | ✅ | `lib/settings.js` + 「设置」页签 | 12 字段表单；越界夹住（99999→32768）、非法枚举忽略；accessToken 不回传 |
| 18 | **下载源测速** | ✅ | `lib/network.js` + 设置页按钮 | 实测：官方 4.59MB/s vs 镜像 0.66MB/s → 建议 official-first |
| 19 | **存档备份 / 还原** | ✅ | `lib/backup.js` + 存档分类 UI | 合成存档端到端：备份 4 条目 → 破坏 → 还原后字节一致 → 旧档进回收站；活体 20 存档列表 + 备份/删除全通 |
| 20 | **模组更新检查** | ✅ | `lib/updates.js` + 模组分类 UI | 真实实例：7 检查 / 4 命中 / **3 可更新**（JEI 15.21→15.74 等），1.9s |
| 21 | **崩溃报告脱敏分享** | ✅ | `lib/crashshare.js` + 崩溃分类按钮 | 真实报告 → 3773 字 Markdown，泄漏检查全空；修 IPv6 误伤时间的正则 |
| 22 | **皮肤管理（正版）** | ✅ | `lib/skin.js` `lib/skin-routes.js` + 皮肤卡 | 路由可用（未登录 409）；面板预览/换肤/恢复默认；jsdom 端到端通过 |
| 23 | **多账号管理** | ✅ | `lib/msa.js`（accounts.json + 迁移）+ 账号卡下拉 | 数据层 6 项单测全过（迁移/切换/移除/无令牌泄漏）；UI 切换 POST 正确 |

## 待做（建议顺序）

| # | 功能 | 说明 | 依赖 |
|---|---|---|---|
| 17 | 皮肤管理（正版） | ✅ 宿主 API + 「皮肤（正版）」卡（预览/换肤/恢复默认） | 3 |

## 不适用 / 低优先级

| # | 功能 | 原因 |
|---|---|---|
| — | 联机（PCL Link） | ⛔ 依赖 PCL 自家的联机房间服务器与账号体系，无法在第三方插件里复刻 |
| — | 内置音乐播放器 `ModMusic.vb` | ⚪ 可选彩蛋，与本目标核心无关 |
| — | 公告/更新检查/关于页 | ⚪ DSH 的插件管理已经承担了版本与更新 |

## 设计约定（避免后续越做越乱）

1. **host 侧一个域一个文件**：`versions/java/args/launch`（启动）、`mirror/download/http/downloader`（下载）、
   `msa/ms-routes`（账号）、`instance/inst-routes`（实例）、`zip`（工具）。
   新功能按域加文件，不要往 `index.js` 里塞逻辑——它只做路由委派。
2. **路由单前缀 `/mc` 下的子目录**：`/mc/dl/*`、`/mc/ms/*`、`/mc/inst/*`。
   （不要用 `/mc-xx`：webserver 的 prefix 是字符串前缀匹配，`/mc-xx` 会被 `/mc` 截胡。）
3. **纯逻辑与 HTTP 分离**：`*.js` 不 import 宿主模块、可被 `scripts/selftest.mjs` 直接跑；
   `*-routes.js` 只做参数校验与 JSON 包装。
4. **一切删除走回收站**（`.dsh-trash/<时间戳>/`），不做硬删。
5. **token 不出站**：GET 只回展示字段；账号文件 0600。
6. 每个域都要有**真实数据**的验证（本机 4 个真实实例 + 真实崩溃报告 + 真实镜像），不要只测合成数据。

## round 13 落点（合规改造）

用户确认「未来开源到 GitHub、允许改名」，遂按《PCL 存储库合理使用指南》二·重度使用 5 条逐项落实：

- **改名**：软件名 → 「PCL 工具箱（第三方修改版）」；包名 `@dsh-external/dsh-pcl-launch` → `@dsh-external/pcl-toolbox`；
  插件 id → `pcl-toolbox`；侧栏 → 「PCL 工具箱」；目录 → `Desktop\blender\pcl-toolbox`（已重新安装到 profile）
- **合规文件**：`NOTICE`（第三方声明 + 署名 + 赞助链接 + 无 PCL 源码说明）、`LICENSE`（CC BY-SA 4.0）、
  `PCL-LICENCE.md`（PCL 原 `LICENCE` 原文）
- **关于页**：新增第 6 个页签，**首位**即龙腾猫跃署名 + 赞助/官网按钮
- **启动前检查**：`lib/precheck.js` 实现 `McLaunchPrecheck` 等价逻辑 —— `!`/`;` 路径拒绝；
  按 PCL 次数表劝买正版（第 3/8/15… 次，正版登录后免劝）与赞助（第 10/20/40… 次）
- **BMCLAPI 规范**：统一 UA、下载并发默认 8（原 16 曾触发 429）
- 实测：路径校验放行/拒绝各 2 例；`launches` 预置 2 → 启动一次返回 `hints=[('buy',3)]`；
  `selftest` 14 组 + 8 个 jsdom 套件全绿；`/mc/advice` 返回署名与两个链接

## round 12 落点（收口）

- 整体回归：`selftest` **14 组**全过；前端 **8 个 jsdom 套件**全 PASS（React warning 0）；
  真实启动（原版 26.2）`booted=true`；下载诊断 + 计划正常（一次 maven 抖动，重跑即绿）；
  Fabric/NeoForge 实例计划缺失均为 0；**11 个路由域活体全通**（皮肤 409 属未登录预期）
- 产出 `DELIVERY.md`：功能对照表（PCL 模块 → 本插件 → 证据）、路由总表、验证矩阵、已知边界、代码结构
- 结论：Roadmap 23/23 完成，目标达成

## round 11 落点

- **皮肤面板入口**：LaunchUI 里新增 `SkinCard`（当前皮肤贴图预览 / 图片直链 / 经典·细手臂 / 应用 / 恢复默认），
  未登录时明确说明离线做不了换肤（顺手修了 `Btn` 用法：要 `label` 而不是 children）
- **多账号**：`msa.js` 存储重构为 `accounts.json`（含旧 `account.json` 自动迁移）+
  `readStore/writeStore/listAccounts/setActiveAccount/clearAccount(uuid)`；路由 `/mc/ms/{accounts,switch,remove}`；
  账号卡加多账号下拉
- 实测：数据层 6 项单测（迁移/两账号/切换/移除活动账号/描述无令牌泄漏）；UI 端到端 6 项、
  皮肤换肤 POST 正确、React warning 0

## round 10 落点

- 新增 `lib/crashshare.js`：脱敏（用户路径/玩家名/UUID/令牌/IP）+ 概要表 + 诊断 + 关键堆栈 → Markdown，
  写到实例 `.dsh-crash-share/`；`POST /mc/inst/shareCrash`；UI 崩溃分类加「生成脱敏报告」（自动复制剪贴板）
- 新增 `lib/skin.js` + `lib/skin-routes.js`：读皮肤/披风、按 URL 换肤、恢复默认（令牌不出站；离线 409）
- 修：IPv6 正则把 `23:27:38` 误判成地址；32 位无连字符 UUID 未脱敏
- 实测：真实报告脱敏后零泄漏、点名肇事模组；10 个路由域活体全通（皮肤 409 属预期）

## round 9 落点

- 新增 `lib/backup.js`：存档列表（level.dat 摘要）/ 备份 / 还原（先移回收站）/ 删备份
- 新增 `lib/updates.js`：sha1 批量反查 Modrinth → 按 MC 版本+加载器比对最新版本
- `inst-routes` 加 `/saves · /backups · /backup · /restore · /backupDelete`；`mod-routes` 加 `/updates`
- UI：存档分类多一张**存档备份卡**（还原备份/删除备份，二次确认）；模组分类多一张**模组更新卡**（版本对比）
- 修 bug：单存档还原的解压目标错误（文件散到 `saves/` 根上）
- 实测：活体 20 存档列表、备份→列表→删除全通；更新检查 3 个可更新

## round 8 落点

- 新增 `lib/settings.js`：字段元数据 + 服务端校验（越界夹住/非法枚举忽略）+ 保存后 needs.rescan
- 新增 `lib/network.js`：镜像 vs 官方三项真实探测 → 成功率/吞吐/延迟排序 → 推荐 sourcePreference
- `lib/index.js`：`/mc/settings`（GET/POST）、`/mc/net/speedtest`
- UI：新增**「设置」页签**（表单 + 测速面板 + 一键采用建议）；修掉一处 React key warning
- 实测：越界值 99999→32768、非法枚举被忽略；活体测速给出 official-first；UI 端到端 5 项、0 warning

## round 7 落点

- `lib/zip.js` 补**写侧**：`writeZip` + 自实现 `crc32`（不依赖 node 版本是否提供 zlib.crc32）
- 新增 `lib/export.js`：预览 / 导出实例为 zip（含 `dsh-export.json` 清单、体积上限、跳过规则）、`modsListText`
- `lib/inst-routes.js`：`/mc/inst/exportPreview`、`/mc/inst/export`
- UI：「版本」页签列表卡加「导出 zip」按钮（jsdom 断言 POST body 正确、0 warning）
- 实测：真实 1.20.1-Forge 实例 196 条目 / 198MB → 192.7MB / 8.7s，回读核对字节一致

## round 6 落点

- 新增 `lib/modpack.js`：`.mrpack` 索引读取/预览、安装（装加载器 → 下 files → 铺 overrides → 写标记）、标记读取
- 新增 `lib/pack-routes.js`：`/mc/pack/{list,versions,inspect,install,state,marker}`
- `lib/zip.js`：新增 `readZipEntry`；修掉 `stripPrefix` 语义 bug（非该前缀的条目原本会按原名解压，导致实例里冒出游离的 `overrides/` 目录）
- `lib/modrinth.js`：`search` 支持 `projectType`；新增 `packVersions`
- UI：「资源」页签加 **模组 / 整合包** 模式切换（整合包安装会轮询阶段进度）
- 实测：Fabulously Optimized 14.1.1 @26.2 在临时目录完整装好（51 文件 / 42.8MB / 57 overrides），活体 `/mc/pack/*` 全 200

## round 4 / round 5 落点

- round 4：**加载器安装 UI 卡**（「版本」页签，三个联动下拉 + 进度 + 已装实例；jsdom 7 项验证、0 warning）。
  期间修掉一个只有真渲染才暴露的错：`onChanged` 误用了不在 `build()` 作用域的 `refreshAll`，改成 `v.onRefresh`
- round 5：**模组市场**（新「资源」页签）：`lib/modrinth.js`（搜索/版本/依赖 BFS/下载/sha1）+ `lib/mod-routes.js` + ModUI 面板
  - 实测：搜索 jei@1.20.1/forge → 82 条；依赖解析出 `mezz_config`；两文件 6.9MB sha1 全对
  - UI 端到端（jsdom）：页签切换 / 搜索 URL 带 mc+loader / 安装 POST body / 成功提示 / 0 warning

## round 3 落点

- 新增 `lib/loaders.js`：fabric/quilt 列表+profile 安装、forge/neoforge installer 下载+执行、
  `parseFailedArtifacts`（从 installer 输出里抠失败坐标）、`seedArtifacts`（镜像预置）、`repairLibraries`、`findLoaderInstances`
- 新增 `lib/loader-routes.js`：`/mc/loader/{list,state,instances,install,repair,cancel}`
- 修两个继承链 bug：jar 取继承链根、loader 实例继承父版本 javaVersion
- 实测：Fabric 0.20.1@26.2 与 NeoForge 26.2.0.93 **都真启动成功**
- UI：**「版本」页签新增「安装加载器」卡**（三联动下拉 + 进度 + 已装实例；jsdom 端到端 7 项验证，0 warning）

## round 2 落点

- 新增 `lib/javaruntime.js`：组件索引（`/v1/products/java-runtime/.../all.json`）、平台映射、按版本选组件、
  文件树计划（403 个文件）、安装、`release` 校验
- 新增 `lib/java-routes.js`：`/mc/java/{runtimes,state,plan,install,cancel,forVersion,installed}`
- 踩到并修掉的坑：**BMCLAPI 不镜像 piston-data 的 `/v1/objects/`**（404/429）。拿它当首选会让 400 个文件
  每个都白等一次退避 —— 实测同一组件从 **7 分钟 / 94 次换源** 降到 **15 秒 / 0 次换源**（改「官方优先、镜像兜底」）
- 实机结果：`.minecraft/runtime/` 现有 epsilon(25.0.1) / delta(21.0.7) / gamma(17.0.15) / gamma-snapshot(17.0.8)，
  `java.js` 自动把它们纳入候选列表

## round 1 落点

- 新增 `lib/instance.js`：内容清点（7 类）、模组启停、回收站删除、level.dat NBT 解析、日志读取（含 .gz / hs_err）、崩溃分析（13 条特征规则 + 疑似 jar/缺失类定位）
- 新增 `lib/inst-routes.js`：`/mc/inst/{summary,content,toggle,delete,open,log,analyze}`
- 新增「版本」页签 UI（与宿主同步进行）
- 真实数据验证：概览/模组/存档/崩溃分析全部走本机 `.minecraft`
