/**
 * 从 desktop profile 卸下本插件（包含 dsh.profile.bundles 登记）。
 * 用途：万一装回去之后 GUI 起不来，双击 uninstall.cmd 即可退回。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const NAME = '@dsh-external/dsh-pcl-launch'
const file = process.env.USERPROFILE.replace(/\\/g, '/') + '/.dsh/profiles/desktop/package.json'
const j = JSON.parse(readFileSync(file, 'utf8'))
let touched = 0

if (j.dependencies && j.dependencies[NAME] !== undefined) { delete j.dependencies[NAME]; touched++ }
const bundles = j.dsh && j.dsh.profile && j.dsh.profile.bundles
if (Array.isArray(bundles)) {
  const before = bundles.length
  j.dsh.profile.bundles = bundles.filter((b) => b !== NAME)
  if (j.dsh.profile.bundles.length !== before) touched++
}
writeFileSync(file, JSON.stringify(j, null, 2) + '\n')
console.log(touched ? '✓ 已从 profile 移除 ' + NAME + '（改了 ' + touched + ' 处）' : '（profile 里本来就没有 ' + NAME + '）')
console.log('接着请执行: pnpm -C "%USERPROFILE%\\.dsh\\profiles\\desktop" install')
console.log('然后重启 DSH。')
