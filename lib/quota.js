// OpenCode Go's official usage endpoint. Never forward credentials to configurable URLs.
// https://github.com/anomalyco/opencode/blob/ed74ec82ce1fe3a36da6c0815a935473ef4bb0fb/packages/core/src/usage-limits.ts
import { createHash } from "node:crypto"

const ENDPOINT = "https://opencode.ai/zen/go/v1/usage"
const PERIODS = [["5h", "rolling"], ["week", "weekly"], ["month", "monthly"]]
export function parseQuota(body) {
  if (!body?.usage || typeof body.usage !== "object") throw new Error("额度响应格式不受支持")
  const windows = PERIODS.map(([id, name]) => {
    const meter = body.usage[name]
    const percent = meter?.percent
    const time = typeof meter?.resetsAt === "string" ? Date.parse(meter.resetsAt) : NaN
    return {
      id,
      usedPercent: typeof percent === "number" && Number.isFinite(percent) && percent >= 0 ? percent : null,
      resetAt: Number.isFinite(time) ? time : null,
    }
  })
  if (windows.every((window) => window.usedPercent === null)) throw new Error("未返回 Go 套餐额度，请确认此 Key 已开通 Go")
  return windows
}

export class QuotaClient {
  constructor({ fetcher = globalThis.fetch, clock = Date.now } = {}) {
    this.fetcher = fetcher
    this.clock = clock
    this.cache = new Map()
    this.controllers = new Set()
    this.closed = false
  }
  unavailable(message) {
    return { status: "unavailable", windows: [], fetchedAt: null, error: message }
  }
  async get(value, { enabled = true } = {}) {
    if (!enabled) return this.unavailable("此 provider 未启用 OpenCode Go 额度查询")
    if (!value) return this.unavailable("尚未配置凭证")
    if (this.closed) return this.unavailable("插件已卸载")
    // Cache identity changes immediately when a credential is replaced. No raw key in cache or response.
    const identity = createHash("sha256").update(value).digest("hex")
    const old = this.cache.get(identity)
    if (old?.pending) return old.pending
    if (old && this.clock() - old.checkedAt < 60_000) return old.result
    const entry = { ...old }
    const pending = this.query(value, old?.result).then((result) => {
      entry.result = result
      entry.checkedAt = this.clock()
      delete entry.pending
      return result
    })
    entry.pending = pending
    this.cache.set(identity, entry)
    // Bound inactive credential history, without evicting in-flight requests.
    if (this.cache.size > 256) {
      for (const [key, item] of this.cache) {
        if (key !== identity && !item.pending) this.cache.delete(key)
        if (this.cache.size <= 256) break
      }
    }
    return pending
  }
  async query(value, previous) {
    const controller = new AbortController()
    this.controllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), 8000)
    timeout.unref?.()
    try {
      const response = await this.fetcher(ENDPOINT, {
        headers: { authorization: `Bearer ${value}`, accept: "application/json" },
        redirect: "error", signal: controller.signal,
      })
      if (!response.ok) {
        const hint = response.status === 401 || response.status === 403
          ? "凭证无效或无权查询 Go 套餐"
          : response.status === 429 ? "额度查询频率受限，请稍后重试" : `上游额度查询失败（HTTP ${response.status}）`
        throw new Error(hint)
      }
      let body
      try { body = await response.json() } catch { throw new Error("额度响应不是有效 JSON") }
      return { status: "ready", windows: parseQuota(body), fetchedAt: this.clock() }
    } catch (error) {
      // Never expose response bodies or transport errors which could contain credentials.
      const safe = /^(凭证无效|额度查询频率|上游额度查询失败|额度响应|未返回 Go)/.test(error?.message ?? "")
      return {
        status: "error", windows: previous?.windows ?? [], fetchedAt: previous?.fetchedAt ?? null,
        error: safe ? error.message : "无法连接 OpenCode Go 额度服务，请稍后重试",
      }
    } finally {
      clearTimeout(timeout)
      this.controllers.delete(controller)
    }
  }
  dispose() {
    this.closed = true
    for (const controller of this.controllers) controller.abort()
    this.cache.clear()
  }
}
