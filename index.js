/**
 * dsh-opencode-pool — API key 池 + 故障切换（cache 友好）
 *
 * 设计要点
 *   1. 同一 provider 只有一把「生效 key」。生效 key 不变时，上游 prompt cache 一直有效；
 *      每请求轮询会把 cache 前缀全部打散，反而更贵更慢。
 *   2. 只有当上游明确报「额度耗尽 / 凭证失效」时才换 key，并在同一个 open step 内重试：
 *      `agent/request-error` 返回 { kind: 'retry' }，loop 会用同样的持久化历史重放该步。
 *   3. 429 限流、5xx、超时不换 key —— 交给 dsh-llm-retry 退避重试，保持同一账号的 cache。
 *   4. key 只从 credential ref 读取，不落明文；生效槽位（路由的 apiKeyEnv）由本插件写。
 *
 * 挂钩点（均为 dsh 公开扩展点）
 *   - `llm/stream`（waterfall）：派发前把生效槽位写成选中的 key；顺带统计 cache 命中。
 *   - `agent/request-error`（waterfall）：额度/凭证失败时标记冷却、切换生效 key、返回 retry。
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { registerWeb } from "./lib/web.js"

export const name = "dsh-opencode-pool"
export const inject = ["credentials", "llm"]

const VERSION = "1.2.1"

/** 额度类失败：换 key 有意义 */
const QUOTA_CODES = new Set(["QUOTA", "ACCOUNT_QUOTA"])
/** 凭证类失败：换 key 有意义 */
const CREDENTIAL_CODES = new Set(["INVALID_CREDENTIAL", "MISSING_CREDENTIAL", "AUTH"])
/** 临时性失败：绝不换 key（换了也治不好，还会丢 cache） */
const TRANSIENT_CODES = new Set(["RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT", "EMPTY_RESPONSE"])

const QUOTA_TEXT =
  /insufficient[_\s-]?(?:quota|balance|credits?)|quota[_\s-]?(?:exceeded|exhausted|reached)|usage[_\s-]+limit|out of (?:credits?|budget)|余额(?:不足|用完|已用尽|为\s*0|已耗尽)|额度(?:不足|用完|耗尽|已用尽|超限|已达上限|已满)|配额(?:不足|用完|耗尽|超限)|(?:免费|试用)(?:额度|次数)(?:已)?(?:用完|用尽|耗尽)|欠费|积分不足/i
const CREDENTIAL_TEXT =
  /invalid[_\s-]?api[_\s-]?key|incorrect api key|invalid[_\s-]?token|unauthorized|api key (?:is )?(?:invalid|expired|disabled|revoked)|令牌(?:无效|过期)|密钥(?:无效|错误|已失效)|鉴权失败|认证失败/i

const DEFAULTS = {
  quotaCooldownMs: 6 * 60 * 60 * 1000,
  invalidCooldownMs: 60 * 60 * 1000,
  minCooldownMs: 15 * 1000,
  maxCooldownMs: 7 * 24 * 60 * 60 * 1000,
  maxRetriesPerTurn: 3,
  stats: true,
  verifyIntervalMs: 30 * 1000,
  logLevel: "info",
}

/* ------------------------------------------------------------------ *
 * 状态文件（多进程共享 + 防抖落盘 + 读-合并-写）
 * ------------------------------------------------------------------ */

function defaultStateFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh")
  return path.join(home, "keypool-state.json")
}

function emptyKeyState() {
  return {
    status: "ok",
    until: 0,
    reason: "",
    lastError: "",
    ts: 0,
    req: 0,
    ok: 0,
    fail: 0,
    lastUsed: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

function now() {
  return Date.now()
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(value, min), max)
}

function truncate(text, limit) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim()
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean
}

class Store {
  constructor(file, log) {
    this.file = file
    this.log = log
    this.data = this.load()
    this.mtime = this.statMtime()
    this.dirty = false
    this.timer = undefined
  }

  statMtime() {
    try {
      return fs.statSync(this.file).mtimeMs
    } catch {
      return 0
    }
  }

  load() {
    const raw = readJson(this.file)
    const data = { version: 1, updatedAt: now(), providers: {} }
    if (!raw || typeof raw !== "object") return data
    if (raw.providers && typeof raw.providers === "object") {
      for (const [pid, pool] of Object.entries(raw.providers)) {
        if (!pool || typeof pool !== "object") continue
        data.providers[pid] = {
          active: typeof pool.active === "string" ? pool.active : undefined,
          keys: {},
        }
        for (const [kid, value] of Object.entries(pool.keys ?? {})) {
          if (!value || typeof value !== "object") continue
          data.providers[pid].keys[kid] = { ...emptyKeyState(), ...value }
        }
      }
    }
    return data
  }

  /** 其他进程（CLI / 另一个 dsh 实例）改过状态就重新读，多开时也能共享冷却与统计 */
  refresh() {
    const mtime = this.statMtime()
    if (mtime === this.mtime || this.dirty) return
    this.mtime = mtime
    this.data = this.load()
  }

  provider(pid) {
    const data = this.data
    data.providers[pid] = data.providers[pid] ?? { active: undefined, keys: {} }
    data.providers[pid].keys = data.providers[pid].keys ?? {}
    return data.providers[pid]
  }

  keyState(pid, kid) {
    const pool = this.provider(pid)
    pool.keys[kid] = pool.keys[kid] ?? emptyKeyState()
    return pool.keys[kid]
  }

  touch() {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, 400)
    this.timer.unref?.()
  }

  flush() {
    if (!this.dirty) return
    this.dirty = false
    try {
      const remote = readJson(this.file)
      const merged = mergeStates(this.data, remote)
      merged.updatedAt = now()
      writeJsonAtomic(this.file, merged)
      this.data = merged
      this.mtime = this.statMtime()
    } catch (error) {
      this.log?.warn?.(`keypool: 状态写入失败: ${String(error)}`)
    }
  }
}

function mergeStates(local, remote) {
  const merged = { version: 1, updatedAt: now(), providers: {} }
  const remoteProviders = remote?.providers ?? {}
  for (const [pid, pool] of Object.entries(remoteProviders)) {
    merged.providers[pid] = { active: pool.active, keys: { ...(pool.keys ?? {}) } }
  }
  for (const [pid, pool] of Object.entries(local.providers)) {
    const target = (merged.providers[pid] = merged.providers[pid] ?? { active: undefined, keys: {} })
    target.keys = target.keys ?? {}
    for (const [kid, value] of Object.entries(pool.keys)) {
      const other = target.keys[kid]
      if (!other || (value.ts ?? 0) >= (other.ts ?? 0)) target.keys[kid] = value
    }
    target.active = pool.active
  }
  return merged
}

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

/** 校验并规范化一把 key：ref（推荐）或 value（明文） */
function normalizeKeys(raw, pid, problems) {
  const keys = []
  for (const [index, item] of (Array.isArray(raw) ? raw : []).entries()) {
    if (typeof item === "string" && item) {
      keys.push({ id: `k${index + 1}`, ref: item })
      continue
    }
    const ref = typeof item?.ref === "string" && item.ref ? item.ref : undefined
    const value = typeof item?.value === "string" && item.value ? item.value : undefined
    if (!ref && !value) {
      problems.push(`${pid}: 第 ${index + 1} 把 key 需要 ref（credential 引用）或 value（明文，不推荐）`)
      continue
    }
    keys.push({
      id: typeof item?.id === "string" && item.id ? item.id : `k${index + 1}`,
      ref,
      value,
      label: typeof item?.label === "string" ? item.label : undefined,
    })
  }
  return keys
}

function normalizeConfig(raw) {
  const config = raw && typeof raw === "object" ? raw : {}
  const providers = {}
  const problems = []
  for (const [pid, value] of Object.entries(config.providers ?? {})) {
    if (!value || typeof value !== "object") {
      problems.push(`${pid}: 配置必须是对象`)
      continue
    }
    if (typeof value.credentialRef !== "string" || !value.credentialRef) {
      problems.push(`${pid}: 缺少 credentialRef（应等于该路由 llm-pi-ai 配置里的 apiKeyEnv）`)
      continue
    }
    const keys = normalizeKeys(value.keys, pid, problems)
    if (!keys.length) problems.push(`${pid}: 没有配置任何 key`)
    providers[pid] = {
      id: pid,
      credentialRef: value.credentialRef,
      keys,
      quotaCooldownMs: clamp(Number(value.quotaCooldownMs ?? DEFAULTS.quotaCooldownMs), 100, DEFAULTS.maxCooldownMs),
      invalidCooldownMs: clamp(Number(value.invalidCooldownMs ?? DEFAULTS.invalidCooldownMs), 100, DEFAULTS.maxCooldownMs),
      minCooldownMs: clamp(Number(value.minCooldownMs ?? DEFAULTS.minCooldownMs), 0, 60 * 60 * 1000),
      maxCooldownMs: clamp(Number(value.maxCooldownMs ?? DEFAULTS.maxCooldownMs), 60 * 1000, DEFAULTS.maxCooldownMs),
      maxRetriesPerTurn: clamp(Number(value.maxRetriesPerTurn ?? DEFAULTS.maxRetriesPerTurn), 0, 10),
      stats: value.stats !== false,
      quotaUsage: value.quotaUsage ?? (pid === "opencode-go"),
      verifyIntervalMs: clamp(Number(value.verifyIntervalMs ?? DEFAULTS.verifyIntervalMs), 0, 10 * 60 * 1000),
    }
  }
  return {
    stateFile: typeof config.stateFile === "string" && config.stateFile ? config.stateFile.replace(/^~/, os.homedir()) : defaultStateFile(),
    keysFile:
      typeof config.keysFile === "string" && config.keysFile
        ? config.keysFile.replace(/^~/, os.homedir())
        : path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "keypool-keys.json"),
    logLevel: typeof config.logLevel === "string" ? config.logLevel : DEFAULTS.logLevel,
    providers,
    problems,
  }
}

/* ------------------------------------------------------------------ *
 * 运行时 key 目录（~/.dsh/keypool-keys.json，改完下一个请求即生效）
 * ------------------------------------------------------------------ */

class KeyCatalog {
  constructor(file, log) {
    this.file = file
    this.log = log
    this.mtime = -1
    this.data = {}
    this.missing = false
  }

  reload() {
    let mtime = 0
    try {
      mtime = fs.statSync(this.file).mtimeMs
    } catch {
      if (!this.missing) {
        this.missing = true
        this.mtime = -1
        this.data = {}
      }
      return
    }
    this.missing = false
    if (mtime === this.mtime) return
    this.mtime = mtime
    const raw = readJson(this.file)
    const source = raw && typeof raw === "object" ? (raw.providers ?? raw) : {}
    const next = {}
    for (const [pid, list] of Object.entries(source)) {
      if (!Array.isArray(list)) continue
      const problems = []
      const keys = normalizeKeys(list, pid, problems)
      if (problems.length) this.log?.warn?.(`keypool: keys 文件 ${pid}: ${problems.join("; ")}`)
      if (keys.length) next[pid] = keys
    }
    this.data = next
    this.log?.info?.(`keypool: 已加载 ${this.file}（${Object.keys(next).join(", ") || "空"}）`)
  }

  /** patch 里的 keys 是基线，keys 文件按 id 覆盖或追加（同名覆盖、新名追加） */
  /** 下一次 keysFor 强制重读（Web 端写完文件后调用） */
  invalidate() {
    this.mtime = -1
  }

  keysFor(pool) {
    this.reload()
    const extra = this.data[pool.id]
    if (!extra || !extra.length) return pool.keys
    const merged = pool.keys.map((key) => extra.find((item) => item.id === key.id) ?? key)
    for (const item of extra) if (!merged.some((key) => key.id === item.id)) merged.push(item)
    return merged
  }
}

/* ------------------------------------------------------------------ *
 * 插件
 * ------------------------------------------------------------------ */

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const logger = ctx.logger
  if (config.problems.length) logger?.warn?.(`keypool: 配置有问题 -> ${config.problems.join("; ")}`)
  logger?.info?.(
    `keypool ${VERSION}: ${Object.keys(config.providers).length} 个 provider, 状态文件 ${config.stateFile}`,
  )

  const store = new Store(config.stateFile, logger)
  const catalog = new KeyCatalog(config.keysFile, logger)
  /** keys 文件里的列表优先于 patch 里的配置，改文件即生效、不用重启 */
  const keysOf = (pool) => catalog.keysFor(pool)
  /** 上一轮写入槽位时的值，用来避免每请求重复 set */
  const slot = new Map()
  const verified = new Map()
  /** `${sessionId}|${turn}` -> 本轮已重试次数，防止同一步无限重试 */
  const budget = new Map()

  const ref = (name) => name

  function resolveRef(name) {
    return ctx.credentials.resolve(ref(name))
  }

  const warned = new Map()

  /** 同一个告警 10 分钟内只打一次，避免没配 key 时每请求刷屏 */
  function warnThrottled(pool, message) {
    const last = warned.get(pool.id) ?? 0
    if (now() - last < 10 * 60 * 1000) return
    warned.set(pool.id, now())
    logger?.warn?.(message)
  }

  function isHealthy(pool, keyId) {
    const state = store.keyState(pool.id, keyId)
    if (state.status === "ok") return true
    return state.until <= now()
  }

  function pickKey(pool, { exclude } = {}) {
    store.refresh()
    const healthy = keysOf(pool).filter((key) => !exclude?.has(key.id) && isHealthy(pool, key.id))
    if (!healthy.length) return undefined
    const active = store.provider(pool.id).active
    const current = healthy.find((key) => key.id === active)
    if (current) return current
    // 没有生效 key（或它刚失效）：按最久未用挑一把，切过去后长期不再变
    return [...healthy].sort((a, b) => {
      const sa = store.keyState(pool.id, a.id)
      const sb = store.keyState(pool.id, b.id)
      return (sa.lastUsed ?? 0) - (sb.lastUsed ?? 0)
    })[0]
  }

  async function activate(pool, key) {
    const value = key.value ?? (key.ref ? (await resolveRef(key.ref))?.value : undefined)
    if (!value) {
      warnThrottled(pool, `keypool: ${pool.id}/${key.id} 的 credential ref "${key.ref}" 为空，跳过`)
      return false
    }
    const poolState = store.provider(pool.id)
    poolState.active = key.id
    store.touch()
    const cached = slot.get(pool.id)
    if (cached === value) {
      verified.set(pool.id, now())
      return true
    }
    const current = (await resolveRef(pool.credentialRef))?.value
    if (current !== value) {
      await ctx.credentials.set(ref(pool.credentialRef), value)
      logger?.info?.(`keypool: ${pool.id} 生效 key -> ${key.id}${key.label ? ` (${key.label})` : ""}`)
    }
    slot.set(pool.id, value)
    verified.set(pool.id, now())
    return true
  }

  async function ensureActive(pool) {
    const state = store.provider(pool.id)
    const active = state.active ? keysOf(pool).find((key) => key.id === state.active) : undefined
    if (active && isHealthy(pool, active.id)) {
      const last = verified.get(pool.id) ?? 0
      if (now() - last < pool.verifyIntervalMs) return active
      const cached = slot.get(pool.id)
      if (cached) {
        verified.set(pool.id, now())
        return active
      }
      return (await activate(pool, active)) ? active : pickKey(pool)
    }
    const next = pickKey(pool)
    if (!next) {
      // 没有可用 key 时不动槽位：pi-ai 会继续用路由原本的 apiKeyEnv 值，退化为单 key 模式
      warnThrottled(pool, `keypool: ${pool.id} 没有可用 key（都在冷却或 ref 为空），暂时沿用现有凭证`)
      return undefined
    }
    return (await activate(pool, next)) ? next : undefined
  }

  function classify(failure) {
    const code = String(failure?.code ?? "")
    if (QUOTA_CODES.has(code)) return "quota"
    if (CREDENTIAL_CODES.has(code)) return "credential"
    // 中转经常把「额度耗尽」包成 429/5xx，正文比 code 更可信
    const text = String(failure?.message ?? "")
    if (QUOTA_TEXT.test(text)) return "quota"
    if (CREDENTIAL_TEXT.test(text)) return "credential"
    if (TRANSIENT_CODES.has(code)) return "transient"
    const status = Number(failure?.status)
    if (status === 429 || (status >= 500 && status < 600)) return "transient"
    return "other"
  }

  function cool(pool, keyId, failure, kind) {
    const state = store.keyState(pool.id, keyId)
    const ts = now()
    const message = truncate(failure?.message, 300)
    // 同一个失败会先被 finish chunk 看到一次、再被 agent/request-error 看到一次，只记一次
    if (state.status !== "ok" && state.until > ts && state.lastError === message && ts - (state.ts ?? 0) < 30_000) {
      return
    }
    const suggestion = Number(failure?.providerRetryAfterMs)
    const raw =
      kind === "quota"
        ? Number.isFinite(suggestion) && suggestion > 0
          ? suggestion
          : pool.quotaCooldownMs
        : pool.invalidCooldownMs
    const cooldown = clamp(raw, pool.minCooldownMs, pool.maxCooldownMs)
    state.status = kind === "quota" ? "quota" : "invalid"
    state.until = ts + cooldown
    state.reason = kind
    state.lastError = message
    state.fail = (state.fail ?? 0) + 1
    state.ts = ts
    store.touch()
    logger?.warn?.(
      `keypool: ${pool.id}/${keyId} 冷却 ${Math.round(cooldown / 1000)}s（${kind}: ${truncate(failure?.message, 160)}）`,
    )
  }

  function record(pool, keyId, usage, finish) {
    const state = store.keyState(pool.id, keyId)
    state.ts = now()
    if (usage && pool.stats) {
      state.inputTokens = (state.inputTokens ?? 0) + (usage.inputTokens ?? 0)
      state.cacheReadTokens = (state.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0)
      state.cacheWriteTokens = (state.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    }
    if (!finish) {
      store.touch()
      return
    }
    if (finish.kind === "error") {
      const kind = classify(finish.failure)
      if (kind === "quota" || kind === "credential") cool(pool, keyId, finish.failure, kind)
      else store.touch()
      return
    }
    if (finish.kind === "aborted") {
      store.touch()
      return
    }
    state.ok = (state.ok ?? 0) + 1
    state.fail = 0
    state.lastUsed = now()
    if (state.status !== "ok") {
      state.status = "ok"
      state.until = 0
      state.reason = ""
    }
    store.touch()
  }

  /* ---------------- llm/stream：派发前定 key ---------------- */

  ctx.on("llm/stream", (options, next) => {
    const pool = config.providers[options?.provider]
    if (!pool) return next()
    return withKey(pool, options, next)
  })

  async function* withKey(pool, options, next) {
    let key
    try {
      key = await ensureActive(pool)
    } catch (error) {
      logger?.warn?.(`keypool: ${pool.id} 选择 key 失败: ${String(error)}`)
    }
    if (key) {
      const state = store.keyState(pool.id, key.id)
      state.req = (state.req ?? 0) + 1
      state.lastUsed = now()
    }

    const inner = next()
    const iterable = inner && typeof inner.then === "function" ? await inner : inner
    let usage
    let finish
    try {
      for await (const chunk of iterable) {
        if (chunk?.type === "usage") usage = chunk.usage
        else if (chunk?.type === "finish") finish = chunk.reason
        yield chunk
      }
    } finally {
      if (key) {
        try {
          record(pool, key.id, usage, finish)
        } catch (error) {
          logger?.warn?.(`keypool: 记录统计失败: ${String(error)}`)
        }
      }
    }
  }

  /* ---------------- agent/request-error：额度/凭证失败时换 key 并重放 ---------------- */

  ctx.on("agent/request-error", async (payload, next) => {
    const pool = config.providers[payload?.provider]
    if (!pool) return next()
    let decision
    try {
      decision = await recover(pool, payload)
    } catch (error) {
      logger?.warn?.(`keypool: ${pool.id} 换 key 失败，交回下游: ${String(error)}`)
      return next()
    }
    // 未接管就交回下游（只调用一次 next，避免瀑布链被推进两次）
    return decision ?? next()
  })

  /** 返回 { kind: 'retry' } 表示本插件接管恢复；返回 undefined 表示交回下游 */
  async function recover(pool, payload) {
    const kind = classify(payload.failure)
    if (kind !== "quota" && kind !== "credential") {
      // 限流/5xx/超时：保持同一把 key，让 dsh-llm-retry 自己在原账号上退避
      return undefined
    }

    const state = store.provider(pool.id)
    const failing = state.active
    if (failing) cool(pool, failing, payload.failure, kind)

    const budgetKey = `${payload.agent?.id ?? "?"}|${payload.turn}`
    const used = budget.get(budgetKey) ?? 0
    const nextKey = pickKey(pool, { exclude: new Set(failing ? [failing] : []) })
    if (!nextKey || used >= pool.maxRetriesPerTurn) {
      logger?.warn?.(
        `keypool: ${pool.id} 无可用备用 key（已重试 ${used} 次，code=${payload.failure?.code}），本步失败`,
      )
      budget.delete(budgetKey)
      return undefined
    }

    if (!(await activate(pool, nextKey))) {
      budget.delete(budgetKey)
      return undefined
    }
    budget.set(budgetKey, used + 1)
    if (budget.size > 200) budget.delete(budget.keys().next().value)
    logger?.warn?.(
      `keypool: ${pool.id} ${failing ?? "(none)"} ${kind === "quota" ? "额度耗尽" : "凭证失效"} -> 切到 ${nextKey.id}，重放本步`,
    )
    return { kind: "retry" }
  }

  // 设置页（Web 半）用的接口；profile 没有 webServer 时自动跳过
  registerWeb(ctx, {
    logger,
    config,
    store,
    catalog,
    keysOf,
    activate,
    invalidate(providerId) { slot.delete(providerId); verified.delete(providerId) },
    pools: new Map(Object.entries(config.providers)),
  })

  ctx.effect(() => () => {
    store.flush()
    logger?.info?.("keypool: 已卸载，状态已落盘")
  }, "dsh-opencode-pool: flush state")
}
