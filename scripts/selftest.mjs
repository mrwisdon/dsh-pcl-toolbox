#!/usr/bin/env node
/**
 * 自检。三种跑法：
 *
 *   node scripts/selftest.mjs           离线：纯逻辑（rules/继承/参数/离线 UUID/ZIP/日志判定）
 *   node scripts/selftest.mjs --real    对本机真实 .minecraft 跑：版本发现 → Java 选择 → 启动计划
 *   node scripts/selftest.mjs --run     真启动（会开游戏窗口，观测到启动 marker 后自动停）
 *
 * 在 WSL 里跑时自动找 /mnt/c 下的 .minecraft；在 Windows Node 下用 %APPDATA%。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listVersions, resolveVersionJson, mavenPathFromName, detectLoader, detectBaseVersion } from '../lib/versions.js'
import { rulesAllow, buildAccount, offlineUuid, buildLaunchPlan } from '../lib/args.js'
import { discoverJavas, selectJava } from '../lib/java.js'
import { extractZip } from '../lib/zip.js'
import { detectBoot, loadConfig, pluginRootFromLib, resolvePlan } from '../lib/launch.js'
import {
  buildAuthCodeUrl,
  parseAuthCode,
  describeAccount,
  LEGACY_CLIENT_ID,
  readAccount,
  writeAccount,
  listAccounts,
  setActiveAccount,
  clearAccount,
} from '../lib/msa.js'
import { analyzeText, extractSuspectJar, extractMissingClass, readLevelDat, listContent, toggleMod, KINDS } from '../lib/instance.js'
import { platformKey, MAJOR_TO_COMPONENT, mirrorize, listInstalled, verifyInstall } from '../lib/javaruntime.js'
import { defaultInstanceName, isValidLoaderType, parseFailedArtifacts, findLoaderInstances } from '../lib/loaders.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log('  ✔ ' + label)
}

function guessMinecraftDir() {
  if (process.env.APPDATA) return path.join(process.env.APPDATA, '.minecraft')
  const wsl = '/mnt/c/Users/19818/AppData/Roaming/.minecraft'
  return existsSync(wsl) ? wsl : null
}

function findNativesJar(mc) {
  const walk = (dir, depth) => {
    if (depth > 6) return null
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return null
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        const hit = walk(p, depth + 1)
        if (hit) return hit
      } else if (/natives-windows\.jar$/.test(e.name)) return p
    }
    return null
  }
  return walk(path.join(mc, 'libraries'), 0)
}

async function offline() {
  console.log('— 离线：rules 求值')
  const win = { osName: 'windows', arch: 'x86_64' }
  const linux = { osName: 'linux', arch: 'x86_64' }
  assert.equal(rulesAllow(undefined, win), true)
  assert.equal(rulesAllow([{ action: 'allow' }], win), true)
  assert.equal(rulesAllow([{ action: 'allow', os: { name: 'windows' } }], win), true)
  assert.equal(rulesAllow([{ action: 'allow', os: { name: 'windows' } }], linux), false)
  assert.equal(rulesAllow([{ action: 'allow' }, { action: 'disallow', os: { name: 'osx' } }], win), true)
  assert.equal(rulesAllow([{ action: 'allow', features: { is_demo_user: true } }], win, {}), false)
  ok('6 条 rules 场景')

  console.log('— 离线：继承与命名推断')
  assert.equal(detectBaseVersion('1.20.1-Fabric 0.19.5'), '1.20.1')
  assert.equal(detectBaseVersion('26.3-Fabric 0.19.5'), '26.3')
  assert.equal(detectBaseVersion('25w46a'), '25w46a')
  assert.equal(detectLoader('1.20.1-Forge_47.4.20', null), 'forge')
  assert.equal(detectLoader('x', 'net.fabricmc.loader.impl.launch.knot.KnotClient'), 'fabric')
  assert.equal(detectLoader('26.2', 'net.minecraft.client.main.Main'), 'vanilla')
  assert.equal(detectLoader('foo', 'cpw.mods.bootstraplauncher.BootstrapLauncher'), 'forge')
  assert.equal(mavenPathFromName('org.lwjgl:lwjgl:3.3.3'), 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar')
  assert.equal(mavenPathFromName('a:b:1:natives-windows'), 'a/b/1/b-1-natives-windows.jar')
  ok('9 条推断')

  console.log('— 离线：账号')
  const off = buildAccount({ username: 'Steve' })
  assert.equal(off.mode, '离线')
  assert.equal(off.accessToken, '0')
  assert.equal(off.userType, 'legacy')
  assert.match(off.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(offlineUuid('Steve'), off.uuid, '离线 UUID 必须稳定')
  assert.notEqual(offlineUuid('Steve'), offlineUuid('Alex'))
  assert.equal(buildAccount({ username: 'Real', accessToken: 'tok' }).userType, 'msa')
  ok('离线 UUID 稳定 + 正版模式')

  console.log('— 离线：启动/崩溃判定')
  assert.equal(detectBoot('').booted, false)
  assert.equal(detectBoot('Setting user: Steve').booted, false, '只命中 1 个 marker 不算起来了')
  assert.equal(detectBoot('Backend library: LWJGL 3.3.3\nSetting user: Steve\nOpenAL initialized.').booted, true)
  assert.equal(detectBoot('---- Minecraft Crash Report ----').crashed, true)
  assert.equal(detectBoot('Exception in thread "main" java.lang.NoClassDefFoundError').crashed, true)
  ok('启动/崩溃判定')

  console.log('— 离线：ZIP 解压（用真实 natives jar）')
  const mc = guessMinecraftDir()
  const jar = mc ? findNativesJar(mc) : null
  if (jar) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mc-zip-'))
    try {
      const r = extractZip(jar, dir)
      const files = readdirSync(dir)
      assert.ok(r.extracted > 0, '应至少解出一个文件')
      assert.ok(!files.some((f) => f.startsWith('META-INF')), 'META-INF 必须被跳过')
      assert.ok(files.some((f) => /\.(dll|so|dylib)$/.test(f)), 'natives jar 里应有原生库')
      ok(`解压 ${path.basename(jar)} → ${r.extracted} 个文件（跳过 ${r.skipped}）`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  } else {
    console.log('  · 跳过（本机没有 .minecraft 或没有 natives jar）')
  }

  console.log('— 离线：正版登录的纯逻辑')
  const authUrl = buildAuthCodeUrl()
  assert.ok(authUrl.startsWith('https://login.live.com/oauth20_authorize.srf?'), '授权页地址不对')
  assert.ok(authUrl.includes('client_id=' + LEGACY_CLIENT_ID), '应带公共 client id')
  assert.ok(authUrl.includes('response_type=code'), '应是授权码流程')
  assert.ok(authUrl.includes(encodeURIComponent('https://login.live.com/oauth20_desktop.srf')), '回跳地址不对')
  assert.equal(parseAuthCode('https://login.live.com/oauth20_desktop.srf?code=M.R3_BAY.abc%3D&lc=1033'), 'M.R3_BAY.abc=')
  assert.equal(parseAuthCode('M.R3_BAY.rawcode123'), 'M.R3_BAY.rawcode123', '纯 code 也要能认')
  assert.equal(parseAuthCode('https://example.com/no-code-here'), null)
  assert.equal(parseAuthCode(''), null)
  assert.equal(parseAuthCode('short'), null, '太短的不当 code')
  const emptyAcc = describeAccount('/tmp/definitely-no-account-here')
  assert.equal(emptyAcc.loggedIn, false)
  assert.equal(emptyAcc.count, 0)
  ok('授权 URL / code 解析 / 账号空态')

  console.log('— 离线：崩溃分析（真实崩溃的特征）')
  const t1 = analyzeText('java.lang.OutOfMemoryError: Java heap space')
  assert.equal(t1.findings[0].severity, 'error')
  assert.match(t1.summary, /内存不足/)
  const t2 = analyzeText('java.lang.UnsupportedClassVersionError: x has been compiled by a more recent version')
  assert.match(t2.summary, /Java 版本/)
  const crash = [
    '---- Minecraft Crash Report ----',
    'Description: Unexpected error',
    'java.lang.NoClassDefFoundError: io/github/littlebird/client/GroundViewMath',
    '\tat io.github.littlebird.client.GroundCamera.computeFov(GroundCamera.java:43) ~[battlefield-0.1.0.jar%23164!/:0.1.0]',
  ].join('\n')
  const t3 = analyzeText(crash)
  assert.equal(t3.findings[0].severity, 'error')
  assert.match(t3.summary, /模组缺少类/)
  assert.equal(extractSuspectJar(crash), 'battlefield-0.1.0.jar')
  assert.equal(extractMissingClass(crash), 'io/github/littlebird/client/GroundViewMath')
  const t4 = analyzeText('java.util.ConcurrentModificationException\n\tat a.b.C')
  assert.ok(t4.findings.some((f) => f.severity === 'warn'))
  const t5 = analyzeText('nothing to see here')
  assert.match(t5.summary, /没命中已知特征|没有识别出/)
  ok('4 类崩溃特征 + 肇事 jar/缺失类提取 + 兜底文案')

  console.log('— 离线：多账号存储（迁移 / 切换 / 移除）')
  const accRoot = mkdtempSync(path.join(os.tmpdir(), 'mc-acc-'))
  try {
    mkdirSync(path.join(accRoot, '.mc-launch'), { recursive: true })
    writeFileSync(
      path.join(accRoot, '.mc-launch', 'account.json'),
      JSON.stringify({ uuid: 'aaaa-1111', name: 'OldGuy', msRefreshToken: 'r1', mcAccessToken: 't1', mcExpiresAt: Date.now() + 7200000, owned: true }),
    )
    const migrated = readAccount(accRoot)
    assert.equal(migrated.name, 'OldGuy', '旧单账号文件应被迁移')
    assert.ok(existsSync(path.join(accRoot, '.mc-launch', 'accounts.json')), '应生成 accounts.json')
    writeAccount(accRoot, { uuid: 'bbbb-2222', name: 'NewGuy', msRefreshToken: 'r2', mcAccessToken: 't2', mcExpiresAt: Date.now() + 7200000, owned: false })
    const list = listAccounts(accRoot)
    assert.equal(list.accounts.length, 2)
    assert.equal(list.active, 'bbbb-2222', '写入新账号应成为活动账号')
    setActiveAccount(accRoot, 'aaaa-1111')
    assert.equal(readAccount(accRoot).name, 'OldGuy')
    const desc = JSON.stringify(describeAccount(accRoot))
    assert.ok(!/t1|r1|t2|r2/.test(desc), 'describeAccount 不得泄漏令牌')
    assert.equal(describeAccount(accRoot).count, 2)
    clearAccount(accRoot, 'bbbb-2222')
    assert.equal(listAccounts(accRoot).accounts.length, 1)
    clearAccount(accRoot)
    assert.equal(listAccounts(accRoot).accounts.length, 0)
    assert.equal(readAccount(accRoot), null)
    ok('账号迁移 / 双账号 / 切换 / 无令牌泄漏 / 移除（含移除活动账号）')
  } finally {
    rmSync(accRoot, { recursive: true, force: true })
  }

  console.log('— 离线：实例内容（真实实例，有则用）')
  const mcReal = guessMinecraftDir()
  if (mcReal && existsSync(mcReal)) {
    const cfgReal = { minecraftDir: mcReal, gameDirMode: 'isolated' }
    const vids = listVersions(mcReal).map((v) => v.id)
    let foundMods = 0
    let foundSaves = 0
    let lvOk = 0
    for (const vid of vids) {
      const mods = listContent(cfgReal, vid, 'mods')
      foundMods += mods.entries.length
      // 模组名里应有 .jar / .jar.disabled
      for (const e of mods.entries) assert.match(e.name, /\.jar(\.disabled)?$/i)
      const saves = listContent(cfgReal, vid, 'saves')
      for (const e of saves.entries) {
        foundSaves += 1
        if (e.isDir && e.note) lvOk += 1
      }
    }
    ok(`真实实例：${vids.length} 个版本 / ${foundMods} 个模组条目 / ${foundSaves} 个存档 / ${lvOk} 个 level.dat 解析成功`)
    assert.ok(foundMods > 0, '真实实例里应有模组')
    // KINDS 覆盖
    assert.deepEqual(Object.keys(KINDS).sort(), ['config', 'crashReports', 'logs', 'mods', 'resourcepacks', 'saves', 'shaderpacks'])
    // 存档 level.dat 直接测一个
    for (const vid of vids) {
      const saves = listContent(cfgReal, vid, 'saves')
      const d = saves.entries.find((e) => e.isDir && existsSync(`${e.path}/level.dat`))
      if (d) {
        const lv = readLevelDat(`${d.path}/level.dat`)
        assert.ok(lv && (lv.levelName || lv.versionName), 'level.dat 应能解出 LevelName/Version')
        ok(`level.dat：${d.name} → ${lv.versionName || '?'} / ${lv.gameType || '?'} / ${lv.levelName || '?'}`)
        break
      }
    }
  } else {
    console.log('  · 跳过（本机没有 .minecraft）')
  }

  console.log('— 离线：Java 运行时')
  assert.ok(['windows-x64', 'windows-x86', 'windows-arm64', 'mac-os', 'mac-os-arm64', 'linux', 'linux-i386'].includes(platformKey()))
  assert.equal(MAJOR_TO_COMPONENT[25], 'java-runtime-epsilon')
  assert.equal(MAJOR_TO_COMPONENT[21], 'java-runtime-delta')
  assert.equal(MAJOR_TO_COMPONENT[17], 'java-runtime-gamma')
  assert.equal(
    mirrorize('https://piston-data.mojang.com/v1/objects/aa/bb.jar', 'https://bmclapi2.bangbang93.com'),
    'https://bmclapi2.bangbang93.com/v1/objects/aa/bb.jar',
    '域替换 + 路径保持',
  )
  assert.equal(mirrorize('https://piston-meta.mojang.com/v1/packages/x/y.json', 'https://m.example/'), 'https://m.example/v1/packages/x/y.json')
  const fake = verifyInstall({ minecraftDir: '/tmp/definitely-missing-mc', component: 'java-runtime-gamma', expectedVersion: '17.0.15' })
  assert.equal(fake.ok, false, '目录不存在时必须判失败')
  const mcJ = guessMinecraftDir()
  if (mcJ && existsSync(mcJ)) {
    const inst = listInstalled(mcJ)
    if (inst.length) {
      for (const r of inst) assert.ok(r.dir && typeof r.installed === 'boolean')
      const real = inst.find((r) => r.installed && r.version)
      if (real) {
        const v = verifyInstall({ minecraftDir: mcJ, component: real.component, expectedVersion: real.version })
        assert.equal(v.ok, true, '已安装的 runtime 校验应通过')
        ok(`真机 runtime ${inst.length} 个：${inst.map((r) => r.component + '@' + (r.version || '?')).join(', ')}`)
      } else {
        ok(`真机 runtime 目录 ${inst.length} 个（都不含可执行文件）`)
      }
    } else {
      ok('真机没有 runtime 目录（跳过实机校验）')
    }
  } else {
    ok('无 .minecraft（跳过实机校验）')
  }

  console.log('— 离线：加载器')
  assert.equal(isValidLoaderType('fabric'), true)
  assert.equal(isValidLoaderType('neoforge'), true)
  assert.equal(isValidLoaderType('nope'), false)
  assert.equal(defaultInstanceName('fabric', '26.2', '0.20.1'), '26.2-fabric-0.20.1')
  const installerOut = [
    'Some downloads failed.',
    'These libraries failed to download. Try again.',
    ' net.neoforged.installertools:installertools:4.0.17:fatjar',
    ' net.neoforged:neoforge:26.2.0.93:universal',
    ' There was an error during installation',
  ].join('\n')
  const coords = parseFailedArtifacts(installerOut)
  assert.deepEqual(coords, ['net.neoforged.installertools:installertools:4.0.17:fatjar', 'net.neoforged:neoforge:26.2.0.93:universal'], '应解析失败坐标')
  assert.deepEqual(parseFailedArtifacts('no coordinates here at all'), [])
  ok('类型校验 / 实例命名 / installer 失败坐标解析')
  const mcL = guessMinecraftDir()
  if (mcL && existsSync(mcL)) {
    const fab = findLoaderInstances(mcL, 'fabric')
    const neo = findLoaderInstances(mcL, 'neoforge')
    ok(`真实目录里的加载器实例：fabric ${fab.length} 个（${fab.map((x) => x.id).join(', ') || '-'}）/ neoforge ${neo.length} 个（${neo.map((x) => x.id).join(', ') || '-'}）`)
    for (const inst of [...fab, ...neo]) assert.ok(inst.id && inst.json)
  }

  console.log('— 离线：配置')
  const cfg = loadConfig(pluginRootFromLib())
  assert.ok(path.isAbsolute(cfg.minecraftDir))
  assert.ok(cfg.memoryMb >= 256 && cfg.memoryMb <= 32768)
  assert.ok(['isolated', 'shared'].includes(cfg.gameDirMode))
  ok(`配置加载：${cfg.minecraftDir} / ${cfg.memoryMb}MB / ${cfg.gameDirMode}`)
}

async function real() {
  const mc = guessMinecraftDir()
  if (!mc || !existsSync(mc)) {
    console.log('\n（本机没有 .minecraft，跳过 --real）')
    return
  }
  console.log(`\n— 真实实例：${mc}`)
  const versions = listVersions(mc)
  assert.ok(versions.length > 0, '至少应发现一个版本')
  ok(`发现 ${versions.length} 个版本：${versions.map((v) => v.id).join(' / ')}`)

  const cands = discoverJavas(mc, { pclConfigDirs: [path.join(process.env.APPDATA || '', 'PCL')] })
  ok(`发现 ${cands.length} 个 Java 候选`)

  for (const v of versions) {
    const r = resolveVersionJson(mc, v.id)
    assert.ok(r.json.mainClass, v.id + ' 应有 mainClass')
    assert.ok(Array.isArray(r.json.libraries), v.id + ' 应有 libraries')
    const sel = selectJava({ forced: v.forcedJava, requiredMajor: v.javaMajor, candidates: cands })
    const plan = buildLaunchPlan({
      minecraftDir: mc,
      versionId: v.id,
      java: sel.java,
      memoryMb: 4096,
      account: buildAccount({ username: 'Steve' }),
      extractNatives: false,
    })
    const argText = plan.command.args.join(' ')
    assert.ok(!/\$\{[^}]+\}/.test(argText), v.id + ' 不应有未替换的占位符')
    assert.ok(plan.classpathEntries > 10, v.id + ' classpath 应有足够条目')
    assert.ok(/ -cp /.test(' ' + argText), v.id + ' 应有 -cp')
    assert.ok(argText.includes('java.library.path'), v.id + ' 应有 java.library.path')
    assert.ok(plan.command.args.includes(plan.mainClass), v.id + ' 参数里应有 mainClass')
    ok(
      `${v.id.padEnd(22)} Java ${String(plan.java.major).padEnd(2)} cp=${String(plan.classpathEntries).padEnd(3)} ` +
        `natives=${plan.nativesJars} 缺失=${plan.missing.length} 参数=${plan.command.args.length}`,
    )
  }
}

async function run() {
  const mc = guessMinecraftDir()
  if (!mc) return console.log('（没有 .minecraft，跳过 --run）')
  const cfg = { ...loadConfig(pluginRootFromLib()), minecraftDir: mc }
  const versions = listVersions(mc)
  const verArg = process.argv.slice(2).find((a) => a.startsWith('--version='))
  const target =
    (verArg ? verArg.slice('--version='.length) : null) ||
    process.env.RUN_VERSION ||
    versions.find((v) => /Forge/i.test(v.id))?.id ||
    versions[0]?.id
  console.log(`\n— 真启动：${target}`)
  const plan = resolvePlan(cfg, { versionId: target, memoryMb: 4096 })
  console.log(`  命令行：${plan.commandPreview.slice(0, 200)}…`)

  const { spawn } = await import('node:child_process')
  const logPath = path.join(os.tmpdir(), 'mc-launch-selftest.log')
  const fd = openSync(logPath, 'w')
  const child = spawn(plan.command.exe, plan.command.args, { cwd: plan.command.cwd, stdio: ['ignore', fd, fd] })
  console.log(`  已启动 pid=${child.pid}，日志 ${logPath}`)

  const deadline = Date.now() + 45000
  let booted = false
  let crashed = false
  let last = ''
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000))
    const d = detectBoot(readFileSync(logPath, 'utf8'))
    last = `markers=${d.markers.join(',') || '-'} crashed=${d.crashed}`
    if (d.crashed) {
      crashed = true
      break
    }
    if (d.booted) {
      booted = true
      break
    }
  }
  try {
    child.kill()
  } catch {
    /* 忽略 */
  }
  console.log(`  结果：booted=${booted} crashed=${crashed} ${last}`)
  const tail = readFileSync(logPath, 'utf8').slice(-1000)
  console.log(tail.split('\n').map((l) => '    ' + l).join('\n'))
  assert.equal(crashed, false, '启动期间不应崩溃')
  assert.equal(booted, true, '应观察到启动 marker')
  ok('真启动成功')
}

const args = new Set(process.argv.slice(2))
try {
  await offline()
  if (args.has('--real') || args.has('--run')) await real()
  if (args.has('--run')) await run()
  console.log(`\n全部通过：${passed} 组断言`)
} catch (err) {
  console.error('\n✘ 自检失败：', err?.stack || err)
  process.exitCode = 1
}
