#!/usr/bin/env node
/**
 * dsh-opencode-pool 命令行：查看/解除冷却。
 *
 *   node cli.mjs status                 # 每个 key 的状态、冷却、cache 命中率
 *   node cli.mjs active                 # 当前生效的 key
 *   node cli.mjs reset --key k1         # 解除冷却（比如刚充值）
 *   node cli.mjs reset --provider opencode-go
 *   node cli.mjs add --provider opencode-go --ref OPENCODE_GO_KEY_3 [--label 备号2]
 *                                      # 把一把 key 追加进 ~/.dsh/keypool-keys.json（热加载，不用重启）
 *   node cli.mjs log                    # 打印状态文件路径
 *
 * 只读写 keypool-state.json：运行中的 dsh 会在下一次派发前检测到 mtime 变化并重新读取。
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { cacheHitRate } from "./lib/stats.js"

const HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh")
const DEFAULT_STATE = path.join(HOME, "keypool-state.json")

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  return value && !value.startsWith("--") ? value : fallback
}

const stateFile = arg("--state", process.env.KEYPOOL_STATE || DEFAULT_STATE)

function read() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"))
  } catch {
    return { version: 1, providers: {} }
  }
}

function write(data) {
  const tmp = `${stateFile}.tmp.${process.pid}`
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, stateFile)
}

function duration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "-"
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${minutes % 60}m`
  return `${Math.floor(hours / 24)}d${hours % 24}h`
}

function pad(text, width) {
  const value = String(text ?? "")
  return value.length >= width ? value : value + " ".repeat(width - value.length)
}

const command = process.argv[2] ?? "status"
const data = read()
const providers = data.providers ?? {}

if (command === "status") {
  if (!Object.keys(providers).length) {
    console.log(`还没有运行记录（状态文件: ${stateFile}）`)
  }
  for (const [pid, pool] of Object.entries(providers)) {
    console.log(`\nprovider: ${pid}   active: ${pool.active ?? "(未选择)"}`)
    console.log(`  ${pad("key", 10)}${pad("status", 12)}${pad("reset in", 10)}${pad("req", 6)}${pad("ok", 6)}${pad("fail", 6)}${pad("cache", 8)}`)
    for (const [kid, state] of Object.entries(pool.keys ?? {})) {
      const status = state.status === "ok" ? "ok" : `${state.status}${state.until > Date.now() ? "" : " (expired)"}`
      const rate = cacheHitRate(state)
      const cache = rate === undefined ? "-" : `${Math.round(rate * 100)}%`
      console.log(
        `  ${pad(kid, 10)}${pad(status, 12)}${pad(state.status === "ok" ? "-" : duration(state.until - Date.now()), 10)}${pad(state.req ?? 0, 6)}${pad(state.ok ?? 0, 6)}${pad(state.fail ?? 0, 6)}${pad(cache, 8)}`,
      )
      if (state.lastError && state.status !== "ok") console.log(`      ↳ ${state.lastError}`)
    }
  }
  console.log(`\n状态文件: ${stateFile}`)
} else if (command === "active") {
  for (const [pid, pool] of Object.entries(providers)) console.log(`${pid}: ${pool.active ?? "(未选择)"}`)
} else if (command === "reset") {
  const onlyProvider = arg("--provider")
  const onlyKey = arg("--key")
  let count = 0
  for (const [pid, pool] of Object.entries(providers)) {
    if (onlyProvider && onlyProvider !== pid) continue
    for (const [kid, state] of Object.entries(pool.keys ?? {})) {
      if (onlyKey && onlyKey !== kid) continue
      state.status = "ok"
      state.until = 0
      state.reason = ""
      state.lastError = ""
      state.ts = Date.now()
      count += 1
    }
  }
  data.updatedAt = Date.now()
  write(data)
  console.log(`已重置 ${count} 个 key 的冷却状态（运行中的 dsh 会在下一次请求前生效）`)
} else if (command === "add") {
  const provider = arg("--provider", "opencode-go")
  const ref = arg("--ref")
  const value = arg("--value")
  const label = arg("--label")
  const id = arg("--id", `k${Date.now().toString(36).slice(-4)}`)
  if (!ref && !value) {
    console.error("用法: node cli.mjs add --provider <路由名> (--ref <凭证引用> | --value <sk-...>) [--id k3] [--label 备号]")
    process.exit(1)
  }
  const keysFile = arg("--keys-file", process.env.KEYPOOL_KEYS || path.join(HOME, "keypool-keys.json"))
  let doc = {}
  try {
    doc = JSON.parse(fs.readFileSync(keysFile, "utf8"))
  } catch {}
  // 兼容两种写法：{ providers: { ... } } 或直接 { provider: [...] }
  const legacy = {}
  for (const [key, entry] of Object.entries(doc)) {
    if (Array.isArray(entry)) {
      legacy[key] = entry
      delete doc[key]
    }
  }
  doc.providers = { ...legacy, ...(doc.providers ?? {}) }
  const source = doc.providers
  source[provider] = Array.isArray(source[provider]) ? source[provider] : []
  if (source[provider].some((item) => (typeof item === "string" ? item : item?.id) === id)) {
    console.error(`id 已存在: ${id}`)
    process.exit(1)
  }
  source[provider].push({ id, ...(ref ? { ref } : {}), ...(value ? { value } : {}), ...(label ? { label } : {}) })
  fs.mkdirSync(path.dirname(keysFile), { recursive: true })
  fs.writeFileSync(keysFile, JSON.stringify(doc, null, 2), { mode: 0o600 })
  console.log(`已加入 ${provider}/${id} -> ${keysFile}（下一个请求即生效）`)
  if (ref && !value) console.log(`别忘了给 ${ref} 放值：~/.dsh/.credentials.yaml 的 refs 段`)
} else if (command === "log") {
  console.log(stateFile)
} else {
  console.log(`dsh-opencode-pool
用法:
  node cli.mjs status [--state <file>]
  node cli.mjs active
  node cli.mjs reset [--provider <id>] [--key <id>]
  node cli.mjs add --provider <id> (--ref <ref> | --value <sk-...>) [--id k3] [--label 备号]`)
}
