/**
 * modpack.js —— Modrinth 整合包（.mrpack）安装。
 *
 * .mrpack 就是一个 zip：
 *   modrinth.index.json   { formatVersion, game, versionId, name,
 *                           files: [{ path, hashes.sha1, fileSize, downloads: [url] }],
 *                           dependencies: { minecraft: "1.20.1", "fabric-loader": "0.16.9" | forge: "47.4.20" | neoforge: "21.1.77" } }
 *   overrides/            直接铺到实例目录的文件树
 *   client-overrides/     同上（仅客户端）
 *
 * 安装顺序（顺序不能乱）：
 *   ① 原版版本必须已存在（主 jar/资源都靠它）
 *   ② 按 dependencies 装加载器（Fabric/Quilt 走 meta，Forge/NeoForge 跑 installer）
 *   ③ 把 index.files 下到实例的游戏目录（隔离模式下就是 versions/<id>/）
 *   ④ 解压 overrides/ 与 client-overrides/（剥掉前缀）
 *   ⑤ 写一个 .dsh-pack.json 标记，便于以后"更新整合包"
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createRun } from './download.js'
import { installFabricLike, installForgeLike, defaultInstanceName } from './loaders.js'
import { readZipEntry, extractZip } from './zip.js'
import { resolveVersionJson } from './versions.js'
import { rulesAllow } from './args.js'

const INDEX_NAME = 'modrinth.index.json'

/** 读 .mrpack 的索引（不解压整个包）。 */
export function readIndex(mrpackPath) {
  if (!existsSync(mrpackPath)) throw new Error('整合包不存在: ' + mrpackPath)
  const raw = readZipEntry(mrpackPath, INDEX_NAME)
  if (!raw) throw new Error('这个 .mrpack 里没有 ' + INDEX_NAME + '（不是 Modrinth 格式？）')
  let index
  try {
    index = JSON.parse(raw.toString('utf8'))
  } catch (err) {
    throw new Error('modrinth.index.json 解析失败: ' + err.message)
  }
  const deps = index.dependencies || {}
  const loader = deps['fabric-loader']
    ? { type: 'fabric', version: String(deps['fabric-loader']) }
    : deps['quilt-loader']
      ? { type: 'quilt', version: String(deps['quilt-loader']) }
      : deps.forge
        ? { type: 'forge', version: String(deps.forge) }
        : deps.neoforge
          ? { type: 'neoforge', version: String(deps.neoforge) }
          : null
  return {
    name: index.name || path.basename(mrpackPath, path.extname(mrpackPath)),
    versionId: index.versionId || null,
    formatVersion: index.formatVersion ?? null,
    game: index.game || 'minecraft',
    minecraft: deps.minecraft ? String(deps.minecraft) : null,
    loader,
    dependencies: deps,
    files: Array.isArray(index.files) ? index.files : [],
    hasOverrides: Boolean(readZipEntry(mrpackPath, 'overrides/')),
  }
}

/** 只做预览：这个包要什么原版/加载器、多少个文件、多大。 */
export function inspectPack(mrpackPath) {
  const index = readIndex(mrpackPath)
  const bytes = index.files.reduce((s, f) => s + (Number(f.fileSize) || 0), 0)
  return { ...index, fileCount: index.files.length, bytes }
}

/**
 * 安装整合包。
 * @param {object} o
 * @param {string} o.mrpackPath
 * @param {string} o.minecraftDir
 * @param {string} [o.mirror]
 * @param {string} [o.name]        自定义实例名（默认 <mc>-<loader>-<ver>，与原版相同的命名）
 * @param {string} [o.javaExe]     Forge/NeoForge 需要
 * @param {(l:string)=>void} [o.onLog]
 * @param {(p:object)=>void} [o.onProgress]  阶段进度（{phase, done, total, bytesDone}）
 */
export async function installPack(o) {
  const log = o.onLog || (() => {})
  const report = o.onProgress || (() => {})
  const minecraftDir = o.minecraftDir
  const index = readIndex(o.mrpackPath)
  log(`整合包：${index.name} ${index.versionId || ''}（MC ${index.minecraft || '?'}，加载器 ${index.loader ? index.loader.type + ' ' + index.loader.version : '原版'}）`)

  if (!index.minecraft) throw new Error('整合包没有写 minecraft 依赖，无法确定原版版本')
  const baseJson = path.join(minecraftDir, 'versions', index.minecraft, index.minecraft + '.json')
  if (!existsSync(baseJson)) {
    throw new Error(`原版 ${index.minecraft} 还没装（缺 ${baseJson}）。先去「下载」页签把 ${index.minecraft} 下下来，再装整合包。`)
  }

  // ② 加载器
  let instanceId
  if (index.loader) {
    instanceId = o.name || defaultInstanceName(index.loader.type, index.minecraft, index.loader.version)
    report({ phase: 'loader', detail: index.loader.type })
    if (index.loader.type === 'fabric' || index.loader.type === 'quilt') {
      const out = await installFabricLike({
        type: index.loader.type,
        minecraftDir,
        mcVersion: index.minecraft,
        loaderVersion: index.loader.version,
        name: instanceId,
        mirror: o.mirror,
        concurrency: 6,
        onLog: log,
      })
      instanceId = out.id
    } else {
      if (!o.javaExe) throw new Error('装 Forge/NeoForge 需要 Java（内部错误：调用方应先用 selectJava）')
      const out = await installForgeLike({
        type: index.loader.type,
        minecraftDir,
        mcVersion: index.minecraft,
        build: index.loader.version,
        mirror: o.mirror,
        javaExe: o.javaExe,
        onLog: log,
      })
      const created = out.created && out.created.length ? out.created[0] : null
      if (created) instanceId = created
      else if (!existsSync(path.join(minecraftDir, 'versions', instanceId, instanceId + '.json'))) {
        throw new Error('Forge/NeoForge 安装失败，没有生成版本目录')
      }
    }
  } else {
    instanceId = o.name || index.minecraft
    if (!existsSync(path.join(minecraftDir, 'versions', instanceId, instanceId + '.json'))) {
      throw new Error('原版整合包应该直接用原版实例，但找不到 ' + instanceId)
    }
  }

  // ③ 文件
  const gameDir = path.join(minecraftDir, 'versions', instanceId)
  const files = []
  for (const f of index.files) {
    if (!f || !f.path) continue
    const downloads = Array.isArray(f.downloads) ? f.downloads.filter(Boolean) : []
    if (!downloads.length) continue
    files.push({
      rel: String(f.path).replace(/\\/g, '/'),
      url: downloads[0],
      sources: downloads,
      size: Number(f.fileSize) || 0,
      sha1: f.hashes?.sha1 || null,
      kind: 'packfiles',
    })
  }
  log(`下载 ${files.length} 个整合包文件 → ${gameDir}`)
  report({ phase: 'files', total: files.length })
  let run = null
  if (files.length) {
    run = createRun({
      dir: gameDir,
      files,
      concurrency: 8,
      onLog: log,
    })
    await run.start()
  }

  // ④ overrides
  report({ phase: 'overrides' })
  let overridesExtracted = 0
  for (const prefix of ['overrides/', 'client-overrides/']) {
    try {
      const r = extractZip(o.mrpackPath, gameDir, { stripPrefix: prefix, skipPrefixes: ['META-INF/', INDEX_NAME, 'modrinth.index.json'] })
      overridesExtracted += r.extracted
      if (r.extracted) log(`铺 ${prefix} → ${r.extracted} 个文件`)
    } catch (err) {
      log(`解压 ${prefix} 失败（可能没有这个目录）：${String(err?.message || err).slice(0, 120)}`)
    }
  }

  // ⑤ 标记
  const marker = path.join(gameDir, '.dsh-pack.json')
  try {
    writeFileSync(
      marker,
      JSON.stringify(
        {
          name: index.name,
          versionId: index.versionId,
          formatVersion: index.formatVersion,
          minecraft: index.minecraft,
          loader: index.loader,
          mrpackPath: o.mrpackPath,
          installedAt: Date.now(),
        },
        null,
        2,
      ),
      'utf8',
    )
  } catch {
    /* 标记写不上不影响使用 */
  }

  // 复核：加载器与库是否齐全
  let missing = 0
  try {
    const resolved = resolveVersionJson(minecraftDir, instanceId)
    const libDir = path.join(minecraftDir, 'libraries')
    for (const lib of resolved.json.libraries || []) {
      if (!rulesAllow(lib.rules)) continue
      const rel = lib.downloads?.artifact?.path
      if (!rel) continue
      if (!existsSync(path.join(libDir, ...rel.split('/')))) missing += 1
    }
  } catch {
    missing = 0
  }

  const summary = {
    ok: !run || run.stats.filesFailed === 0,
    name: index.name,
    versionId: index.versionId,
    minecraft: index.minecraft,
    loader: index.loader,
    instanceId,
    gameDir,
    files: files.length,
    downloaded: run ? run.stats.filesDone : 0,
    skipped: run ? run.stats.filesSkipped : 0,
    failed: run ? run.stats.filesFailed : 0,
    bytes: run ? run.stats.bytesDone : 0,
    overridesExtracted,
    libraryMissing: missing,
    marker,
  }
  log(
    summary.ok
      ? `整合包装好了：实例 ${instanceId}（${summary.downloaded} 下载 / ${summary.skipped} 跳过，overrides ${overridesExtracted} 个文件${missing ? `，库还缺 ${missing}` : ''}）`
      : `整合包装了但有 ${summary.failed} 个文件失败`,
  )
  return summary
}

/** 读实例上的整合包标记（判断这个实例是不是整合包、来自哪个包）。 */
export function readPackMarker(minecraftDir, instanceId) {
  const file = path.join(minecraftDir, 'versions', instanceId, '.dsh-pack.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
