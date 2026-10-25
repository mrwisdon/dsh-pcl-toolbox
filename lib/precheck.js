/**
 * precheck.js —— 启动前检查 + 正版购买 / 赞助劝导（对应 PCL 的 McLaunchPrecheck）。
 *
 * 《PCL 存储库合理使用指南》对「重度使用」的要求之一是：
 *   「软件若有 Minecraft 启动功能，则应实现与 McLaunchPrecheck 函数一致（或更激进）的
 *     Minecraft 正版购买劝导与赞助劝导。」
 * 这里按 PCL 的**触发次数表**实现，并且额外做得更显眼一点（提示不静默、可再次看到）。
 *
 * 数据落在 `<插件根>/.mc-launch/launch-stats.json`：启动次数 + 已经提示过的阈值。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** PCL 的「买正版」提示触发次数（离线/未正版时）。 */
export const BUY_HINT_AT = [3, 8, 15, 30, 50, 70, 90, 110, 130, 180, 220, 280, 330, 380, 450, 550, 660, 750, 880, 950, 1100, 1300, 1500, 1700, 1900]
/** PCL 的「赞助」提示触发次数。 */
export const DONATE_HINT_AT = [10, 20, 40, 60, 80, 100, 120, 150, 200, 250, 300, 350, 400, 500, 600, 700, 800, 900, 1000, 1200, 1400, 1600, 1800, 2000]

export const BUY_URL = 'https://www.xbox.com/zh-cn/games/store/minecraft-java-bedrock-edition-for-pc/9nxp44l49shj'
export const DONATE_URL = 'https://meloong.com/afd/a/LTCat'
export const AUTHOR_NAME = '龙腾猫跃（LTCat）'

function statsFile(root) {
  return path.join(root, '.mc-launch', 'launch-stats.json')
}

function readStats(root) {
  try {
    const j = JSON.parse(readFileSync(statsFile(root), 'utf8'))
    return {
      launches: Number(j?.launches) || 0,
      shown: { buy: Array.isArray(j?.shown?.buy) ? j.shown.buy : [], donate: Array.isArray(j?.shown?.donate) ? j.shown.donate : [] },
    }
  } catch {
    return { launches: 0, shown: { buy: [], donate: [] } }
  }
}

function writeStats(root, stats) {
  const file = statsFile(root)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(stats, null, 2), 'utf8')
}

/**
 * 启动前硬校验：路径里不能有 `!` 或 `;`（PCL 同样的规则；这两个字符会让 classpath/参数解析出错）。
 * @throws {Error}
 */
export function checkGamePath(gameDir) {
  const p = String(gameDir || '')
  if (!p) throw new Error('启动路径为空')
  if (p.includes('!')) throw new Error('游戏路径中不可包含 ! （' + p + '）')
  if (p.includes(';')) throw new Error('游戏路径中不可包含 ; （' + p + '）')
  return true
}

/**
 * 记一次启动，并返回本次应该展示的劝导。
 * @param {string} root 插件根
 * @param {{ onlineLegit: boolean }} opts 是否已登录正版（正版登录后不再劝买）
 * @returns {{ launches:number, hints:Array<{kind:'buy'|'donate', count:number}> }}
 */
export function noteLaunch(root, { onlineLegit } = {}) {
  const stats = readStats(root)
  stats.launches += 1
  const hints = []
  const count = stats.launches
  if (!onlineLegit && BUY_HINT_AT.includes(count) && !stats.shown.buy.includes(count)) {
    hints.push({ kind: 'buy', count, url: BUY_URL, name: AUTHOR_NAME })
    stats.shown.buy.push(count)
  }
  if (DONATE_HINT_AT.includes(count) && !stats.shown.donate.includes(count)) {
    hints.push({ kind: 'donate', count, url: DONATE_URL, name: AUTHOR_NAME })
    stats.shown.donate.push(count)
  }
  writeStats(root, stats)
  return { launches: count, hints }
}

/** 只读：当前统计（面板可以显示「你已启动 N 次」）。 */
export function launchStats(root) {
  return readStats(root)
}
