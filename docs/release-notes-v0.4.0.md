# PCL 工具箱（第三方修改版）v0.4.0

DSH 的 Minecraft 工具箱插件：一个侧栏入口、六个页签，把 PCL 2.14 的主要功能独立重实现了一遍。
**本仓库不含 PCL 的任何源代码、二进制或美术资源。**

## 功能

| 页签 | 能力 |
|---|---|
| 启动 | 版本发现、`inheritsFrom` 合并、按版本选 Java、参数拼装、natives 解压、实时日志、停止 |
| 版本 | 实例内容管理（模组启停/资源包/光影/存档/日志）、崩溃分析（13 条规则 + 定位到具体 jar）、脱敏报告、导出 zip、存档备份与还原、加载器安装 UI |
| 资源 | Modrinth 模组市场（含 required 依赖 BFS 解析）、`.mrpack` 整合包安装、模组更新检查（sha1 反查） |
| 下载 | BMCLAPI 镜像下载、逐文件 sha1 校验、多源回退、429 退避、断点续传 |
| 设置 | 12 项设置的带校验表单 + 下载源测速（镜像 vs 官方三项实测） |
| 关于 | 作者署名、赞助入口、许可证与合规说明（署名置于页面首位） |

账号：微软正版登录（授权码 / 设备码双流程）、多账号切换、皮肤换肤。
Java：检测 + 从 Mojang 下载运行时（自动加入候选）。
加载器：Fabric / Quilt / Forge / NeoForge，含 installer 失败→镜像预置→重试闭环。

## 验证（均为本机实测，非示意）

- 自检 **14 组断言**：`node scripts/selftest.mjs`
- 前端 **8 个 jsdom 套件** + 六页签冒烟：`node scripts/tabs-smoke.mjs`
- **真实启动**：原版 26.2 / Forge 1.20.1 / Fabric 26.2 / NeoForge 26.2 均 `booted=true`
- **真实下载**：1.21.4 全量 4126 文件 / 499.4 MB，逐文件 sha1 全对
- **真实整合包**：Fabulously Optimized 14.1.1 @ 26.2，51 文件 42.8 MB + 57 overrides
- **真实导出**：Forge 实例 196 条目 / 198 MB → 192.7 MB zip / 8.7 秒

## 安装

```bash
# 在 DSH 的插件管理里安装本地 link，或：
pnpm --dir ~/.dsh/profiles/desktop add link:"<本仓库路径>"
```
然后在 DSH 插件管理里启用 `include:pcl-toolbox`，刷新页面。

配置：`mc-launch.config.json`（也可在「设置」页签改）；状态目录 `.mc-launch/`（含账号令牌，已在 .gitignore 中）。

## 合规与许可

- 代码 **MIT**（见 `LICENSE`）；第三方关系与署名见 `NOTICE`；PCL 的《LICENCE》原文见 `PCL-LICENCE.md`
- 本插件是**第三方基于 PCL 独立进行的二次创作**，与 PCL 官方无隶属关系、未获背书
- PCL 作者：**龙腾猫跃（LTCat）** · <https://meloong.com/pcl> · 赞助：<https://meloong.com/afd/a/LTCat>
- 启动前实现了与 PCL `McLaunchPrecheck` 一致（且更显眼）的正版/赞助劝导；主色为蓝、无赞助解锁

## 宣传片

`docs/promo/pcl-toolbox-promo.mp4`（61 秒 / 1080p30 / 中文配音）。画面为程序化渲染的演示动画（非录屏），数字均来自上述实测。

## 已知限制

- 联机功能未实现（依赖 PCL 自家服务）；内置音乐播放器未实现
- 整合包仅支持 Modrinth `.mrpack`（未支持 CurseForge zip）
- 主要面向 Windows（`javaw.exe` / `taskkill`）；macOS/Linux 分支未实机验证
- 皮肤换肤需正版账号；Forge/NeoForge 个别极新版本若官方 maven 不可达需手动装
