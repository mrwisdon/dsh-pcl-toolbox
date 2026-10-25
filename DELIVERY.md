# PCL 工具箱 · 交付说明

> 目标：把 [PCL 2.14](https://github.com/Meloong-Git/PCL) 的功能尽可能完整地移植进 DSH，
> 整理成一个插件（**一个侧栏入口，六个页签**）。

## 一、装在哪、怎么用

- 插件包：`@dsh-external/pcl-toolbox`（**0.4.0**，link 安装在 `desktop` profile）
- 软件名：**PCL 工具箱（第三方修改版）**（按《PCL 存储库合理使用指南》命名）
- 侧栏入口：**PCL 工具箱**（六个页签 + 「关于」）
- 页签：**启动 / 版本 / 资源 / 下载 / 设置**（皮肤在「启动」、备份在「版本」的存档分类）
- 配置：`mc-launch.config.json`（也可在「设置」页签改）
- 排障：`curl -s http://127.0.0.1:6569/mc/diag`（启动侧）、`/mc/dl/diag`（下载侧）

## 二、功能对照（PCL → 本插件）

| PCL 功能 | 状态 | 实现 | 关键证据 |
|---|---|---|---|
| 启动实例 `ModLaunch` | ✅ | `versions/args/java/launch` | 4 个真实实例出计划；**Forge 1.20.1 / 原版 26.2 / Fabric 26.2 / NeoForge 26.2 均真启动 `booted=true`** |
| 版本下载 `ModDownload` | ✅ | `download/downloader/mirror` | 1.21.4 全量 **4126 文件 / 499.4MB，逐文件 sha1 全对**；下载器实测装出 `26.1` |
| 正版登录 `ModLaunch:880-1090` | ✅ | `msa/ms-routes` | 授权页 URL + 假 code 真打 `login.live.com` 回 invalid_grant；账号卡端到端 |
| 多账号 | ✅ | `msa`（accounts.json + 迁移） | 迁移/双账号/切换/移除活动账号/无令牌泄漏 6 项单测 |
| Java 检测+下载 `ModJava` | ✅ | `java/javaruntime/java-routes` | 装成 `gamma 17.0.15`（403 文件）、`delta 21.0.7`（402 文件 94.5MB / **15 秒**） |
| 加载器安装 Fabric/Quilt | ✅ | `loaders.installFabricLike` | Fabric 0.20.1@26.2 → 计划缺失 0 → 真启动 |
| 加载器安装 Forge/NeoForge | ✅ | `loaders.installForgeLike` | NeoForge 26.2.0.93：installer 失败→镜像预置→重试→exit 0 → 真启动 |
| 实例内容管理 `PageInstanceMod` | ✅ | `instance/inst-routes` | 真实实例：7 启用/9 禁用模组、22 存档、27 崩溃、657 日志 |
| 崩溃分析 `ModCrash` | ✅ | `instance.analyzeText/enrichSuspects` | 真实报告 → 点名 `battlefield-0.1.0.jar` + 缺失类在 jar 内的判定 |
| 崩溃报告脱敏分享 | ✅ | `crashshare` | 真实报告脱敏后**零泄漏**；IPv6/时间误伤已修 |
| 存档备份/还原 | ✅ | `backup` | 合成存档端到端：备份→破坏→还原字节一致→旧档进回收站 |
| 模组市场 `PageDownloadMod` | ✅ | `modrinth/mod-routes` | 搜索 82 条、依赖解析出 `mezz_config`、6.9MB 文件 sha1 全对 |
| 整合包安装 `ModModpack` | ✅ | `modpack/pack-routes` | Fabulously Optimized 14.1.1@26.2：51 文件 42.8MB + 57 overrides 全过 |
| 实例导出 `PageInstanceExport` | ✅ | `export` + `zip.writeZip` | Forge 实例 196 条目 / 198MB → 192.7MB zip / 8.7s，回读字节一致 |
| 模组更新检查 | ✅ | `updates` | 7 检查 / 4 命中 / **3 可更新**（JEI 15.21→15.74 等） |
| 设置页 `PageSetup*` | ✅ | `settings` + 设置页签 | 越界夹住（99999→32768）、非法枚举忽略、token 不回传 |
| 下载源测速 | ✅ | `network` | 官方 4.59MB/s vs 镜像 0.66MB/s → 建议 official-first |
| 皮肤管理（正版） | ✅ | `skin/skin-routes` + 皮肤卡 | 未登录如实 409；换肤 POST/恢复默认 UI 端到端 |
| 联机（PCL Link） | ⛔ 不适用 | — | 依赖 PCL 自家房间服务器与账号体系，第三方插件无法复刻 |
| 内置音乐播放器 `ModMusic` | ⚪ 未做 | — | 与本目标（游戏管理）无关的彩蛋功能 |

## 三、路由总表（单前缀 `/mc`）

| 域 | 路由 |
|---|---|
| 启动 | `/mc/{state,versions,plan,launch,stop,status,open,config,settings,diag}` |
| 账号 | `/mc/ms/{state,start,poll,complete,refresh,logout,ensure,accounts,switch,remove}` |
| 皮肤 | `/mc/skin/{current,set,reset}` |
| 实例 | `/mc/inst/{summary,content,toggle,delete,open,log,analyze,files,saves,backups,backup,restore,backupDelete,exportPreview,export,shareCrash}` |
| Java | `/mc/java/{runtimes,state,plan,install,cancel,forVersion,installed}` |
| 加载器 | `/mc/loader/{list,state,instances,install,repair,cancel}` |
| 模组 | `/mc/mod/{search,project,versions,install,installed,updates,diag}` |
| 整合包 | `/mc/pack/{list,versions,inspect,install,state,marker}` |
| 下载 | `/mc/dl/{state,manifest,plan,start,cancel,open,diag,files}` |
| 测速 | `/mc/net/speedtest` |

## 四、验证矩阵（本机实测）

| 层 | 内容 | 结果 |
|---|---|---|
| 单元/集成（Node） | `scripts/selftest.mjs` | **14 组断言全过**（含真实 5 实例、真实崩溃、真实 runtime、多账号存储） |
| 前端（jsdom + React 18） | 8 个套件：合并壳 / 模组市场 / 整合包 / Java 卡 / 加载器卡 / 设置页 / 皮肤+账号 / 版本页 | **全部 PASS，React warning 0** |
| 真实启动 | 原版 26.2、Forge 1.20.1、Fabric 26.2、NeoForge 26.2 | `booted=true`（markers: LWJGL/账号注入/声音） |
| 真实下载 | 1.21.4 全量 | 4126/4126 文件，0 失败，sha1 全对 |
| 真实整合包 | Fabulously Optimized 14.1.1@26.2 | 51 文件 42.8MB + 57 overrides，实例可启动 |
| 活体路由 | 11 个域 | 全部 200（`/mc/skin/current` 未登录时 409 属预期） |

## 五、已知边界

- **联机**不复刻（依赖 PCL 自家服务）；**音乐播放器**未做。
- 皮肤换肤需要正版账号；未登录时接口/UI 会明确说明离线做不了。
- Forge/NeoForge 的 installer 依赖官方 maven，本插件用「失败→镜像预置→重试」兜底；个别极新版本若官方 maven 也拿不到，需要手动装。
- 主要面向 Windows（`javaw.exe`/`taskkill`）；darwin/linux 分支未实机验证。
- 整合包只支持 Modrinth 的 `.mrpack`（CurseForge 的 zip 格式未解析）。

## 六、合规（对 PCL《合理使用指南》重度使用的 5 条）

| # | 要求 | 落实 |
|---|---|---|
| 1 | 声明第三方独立二创 | README 首段 / `NOTICE` / 「关于」页 |
| 2 | 名称 PCL 开头 + 第三方后缀 | 「PCL 工具箱（第三方修改版）」，包名 `pcl-toolbox` |
| 3 | 关于页首位署名 + 赞助链接 + 公开源码 + 附 LICENCE | 「关于」页首卡署名「龙腾猫跃（LTCat）」+ 爱发电按钮；`PCL-LICENCE.md` 原文；仓库公开 |
| 4 | 与 `McLaunchPrecheck` 一致/更激进的劝导 | `lib/precheck.js`：`!`/`;` 路径拒绝、按 PCL 次数表劝买正版与赞助、正版登录后免劝；实测第 3 次启动精确触发 |
| 5 | 无赞助解锁 + 主色蓝色 | 无解锁功能；`#2563eb`/`#3b82f6` |

另：BMCLAPI 请求统一 UA、并发默认 8（曾 16 并发触发 429）；Modrinth 已带 UA。

**仓库**：已发布到 <https://github.com/mrwisdon/dsh-pcl-toolbox>（`main`，50 个文件，含
`LICENSE` / `NOTICE` / `PCL-LICENCE.md`）。`mirror.js` 的 `DEFAULT_USER_AGENT` 已指向该仓库。

## 七、代码结构（32 个 lib 模块 / 约 1.36 万行）

```
lib/
  versions.js java.js args.js launch.js      # 启动：版本/继承/Java/参数/进程
  mirror.js download.js http.js downloader.js# 下载：镜像改写/并发引擎/路径门面
  msa.js ms-routes.js skin.js skin-routes.js # 账号：OAuth/XBL/XSTS/多账号/皮肤
  instance.js inst-routes.js backup.js       # 实例：内容/诊断/备份
  javaruntime.js java-routes.js              # Java 运行时
  loaders.js loader-routes.js                # 加载器安装
  modrinth.js mod-routes.js updates.js       # 模组市场/更新检查
  modpack.js pack-routes.js                  # 整合包
  export.js crashshare.js zip.js             # 导出/脱敏分享/ZIP 读写
  settings.js network.js precheck.js         # 设置/测速/启动前检查与劝导
  index.js client.js                         # 路由入口 / 面板
```
