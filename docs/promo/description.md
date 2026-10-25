# 宣传片发布文案（合规版）

> 用途：B 站 / 抖音 / 小红书 / GitHub Release 的视频简介与标题。
> 原则：**不混淆身份、署名到位、不暗示官方、不夸大**。改动任何一版时保持前三条不变。

---

## 一、标题（B 站）

**推荐**

```
PCL 工具箱（第三方修改版）｜把 Minecraft 启动器做进 DSH 侧栏
```

备选（同样合规）

```
用 12 轮把 PCL 的功能搬进 DSH：启动 / 下载 / 模组 / 整合包｜第三方修改版
```
```
DSH 插件演示：一个侧栏入口，管完 Minecraft 的启动与资源｜PCL 工具箱（第三方修改版）
```

**标题里必须保留「（第三方修改版）」或「第三方」字样**——这是名称规范的一部分，也是避免观众误以为是官方的第一道防线。

## 二、封面文案（两行内）

```
主标题：PCL 工具箱
副标题：第三方修改版 · DSH 插件
角标：非官方｜不含 PCL 源代码
```

封面**不要**使用 PCL 的图标、logo、官方截图或官方宣传语；用本项目的界面截图/静帧即可。

## 三、B 站简介（可直接粘贴，约 700 字）

```
这是一支 Minecraft 启动器插件的功能演示。

【这是什么】
「PCL 工具箱（第三方修改版）」是 DeepSeek Harness（DSH）的一个插件：一个侧栏入口，
六个页签，覆盖版本下载、实例启动、模组与整合包、崩溃诊断、设置与测速。

【与 PCL 的关系（请先看这段）】
本插件是第三方基于 Plain Craft Launcher（PCL）独立进行的二次创作，与 PCL 官方
无隶属关系，也未获其背书，不代表 PCL 官方。
· PCL 作者：龙腾猫跃（LTCat） https://meloong.com/pcl
· 赞助 PCL：https://meloong.com/afd/a/LTCat
· 本插件不含 PCL 的任何源代码、二进制或美术资源：PCL 以 VB.NET 实现，
  本插件以 TypeScript/JavaScript 独立重写，仅在功能行为与公开协议层面参考
  （Mojang 版本 JSON、BMCLAPI 镜像路径等）。名称与署名依据《PCL 存储库合理使用指南》。

【演示里出现的功能】
· 镜像下载：经 BMCLAPI 拉取版本，逐文件 sha1 校验（演示数据：4126 个文件 / 499.4 MB）
· 一键启动：自动匹配 Java、解压 natives、实时回传日志（四个实例实测 booted=true）
· 崩溃诊断：13 条规则定位到具体模组 jar，并可一键生成脱敏报告
· 模组与整合包：Modrinth 搜索、依赖自动解析、.mrpack 安装、模组更新检查
· 设置与测速：12 项设置 + 镜像/官方三项实测对比
· 合规：关于页首位的作者署名与赞助入口

【关于画面与声音（重要）】
本片不是录屏：画面是按本插件的真实界面设计与真实验证数据，用程序逐帧渲染的演示动画；
旁白为 AI 合成语音（edge-tts），配乐为程序合成，未使用任何第三方音乐或素材。
片中的数字（文件数、体积、耗时、可更新模组数等）均来自本机实测，脚本可复现。

【开源与反馈】
源码：https://github.com/mrwisdon/dsh-pcl-toolbox （MIT）
问题反馈请提到本仓库 Issue，不要打扰 PCL 作者。
如 PCL 作者认为本视频有不妥之处，请通过 Issue 联系，我们会配合修改或下架。

#Minecraft #启动器 #DSH #插件 #Modrinth #BMCLAPI
```

## 四、抖音 / 小红书（短版）

```
把 Minecraft 启动器做进 DSH 侧栏：镜像下载、一键启动、崩溃定位、模组与整合包，
一个入口全都有。

「PCL 工具箱（第三方修改版）」是第三方基于 Plain Craft Launcher 独立重实现的
DSH 插件，与 PCL 官方无关，不含 PCL 源代码。
PCL 作者：龙腾猫跃（LTCat）｜赞助：meloong.com/afd/a/LTCat

画面为程序化演示动画，旁白为 AI 合成语音，数据来自真实验证。
源码（MIT）：github.com/mrwisdon/dsh-pcl-toolbox

#Minecraft #我的世界 #启动器 #编程 #开源
```

## 五、GitHub Release 说明（0.4.0 · 视频附件）

```
Promo video (61s, 1080p30, Chinese VO) for PCL Toolbox (third-party modification).

A third-party reimplementation of Plain Craft Launcher's behaviour as a DSH plugin —
it contains none of PCL's source code, binaries or art assets. PCL by 龙腾猫跃 (LTCat):
https://meloong.com/pcl · https://meloong.com/afd/a/LTCat

The video is a programmatic motion-graphic re-creation of the plugin's UI driven by
real verification numbers (not a screen recording); narration is AI-synthesized.

Source (MIT): https://github.com/mrwisdon/dsh-pcl-toolbox
```

## 六、置顶评论

```
补充三点：
1) 这是第三方修改版，和 PCL 官方没有关系，也没有拿到官方背书；
   PCL 作者是龙腾猫跃（LTCat），觉得 PCL 好用可以赞助他：meloong.com/afd/a/LTCat
2) 本插件不含 PCL 的源码/二进制/美术资源，是独立重写的；功能上参考了它的做法。
3) 画面是程序化动画（不是录屏），旁白是 AI 合成；片里的数字都能在本机复现，脚本在仓库里。
```

## 七、自查清单（发之前逐条打勾）

必须做到：
- [ ] 标题/封面出现「第三方修改版」或「第三方」，没有单独用「PCL 工具箱」当品牌
- [ ] 简介里第一屏就能看到：第三方二创声明 + 作者署名 + 赞助链接 + 「不含 PCL 源代码」
- [ ] 明确写了「与 PCL 官方无隶属关系 / 未获背书」
- [ ] 标注了「画面为程序化演示，非录屏」与「旁白为 AI 合成」
- [ ] 反馈渠道指向本仓库 Issue，而不是 PCL 的仓库/群
- [ ] 封面与正片没有使用 PCL 的 logo、图标、官方截图、官方宣传语

禁止出现：
- [ ] 「PCL 官方」「PCL 团队出品」「官方授权」「联名」「官方推荐」
- [ ] 「PCL 手机版」「PCL++」「PCL Pro」「PCL 3」这类会被当成官方后续作品的叫法
- [ ] 「完整复刻 PCL」「基于 PCL 源码」「PCL 重制版」「官方替代品」
- [ ] 把 PCL 的赞助链接说成「支持我们」；要说「赞助 PCL 作者」
- [ ] 用「移植」描述代码关系（读起来像搬运作品）；改用「参考其功能行为，独立重写」

## 八、平台层面的额外注意

- B 站：投稿类型选「自制」；简介里保留 AI 合成语音说明（平台要求标注 AI 生成内容）
- 抖音/小红书：AI 生成内容同样需要标注；不要用「破解」「免费正版」等违规词
- 任何平台：不要在标题里蹭「PCL 官方停更/新版」这类误导性上下文

---

说明：以上文案用于降低「混淆来源」与「暗示官方」的风险，并满足《PCL 存储库合理使用指南》
对重度使用的署名与二创声明要求。它不是法律意见，也不能「保证」不侵权——真遇到异议，
最有效的处理是**立即配合改名或下架**，这也是本仓库在 Issue 里承诺过的。
