/**
 * keypool Web 半的服务端：给设置页提供状态查询与写操作。
 *
 *   GET  /opencode-pool/status            池状态（key 列表、冷却、统计、官方额度）
 *   POST /opencode-pool/action             { action: reset|activate|add|edit|remove|refresh-usage, ... }
 *
 * 安全边界：
 *   - 只服务 loopback 请求（设置页永远是同源本地页面）；
 *   - POST 必须带 `x-keypool-request: 1`，强制走预检，挡住跨站表单提交；
 *   - 任何响应都不回显 key 值，只回 `configured: true/false`。
 */

import fs from "node:fs"
import path from "node:path"
import { QuotaClient } from "./quota.js"
import { cacheHitRate } from "./stats.js"

const MAX_BODY = 64 * 1024

function loopback(req) {
  const address = req?.socket?.remoteAddress ?? ""
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1"
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  })
  res.end(body)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error("请求体过大")
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString("utf8").trim()
  if (!text) return {}
  return JSON.parse(text)
}

function readKeysFile(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"))
    if (!raw || typeof raw !== "object") return { providers: {} }
    if (raw.providers && typeof raw.providers === "object") return raw
    // 兼容直接以 provider 为键的写法
    const providers = {}
    for (const [key, value] of Object.entries(raw)) if (Array.isArray(value)) providers[key] = value
    return { providers }
  } catch (error) {
    if (error?.code === "ENOENT") return { providers: {} }
    throw new Error("无法读取 keys 文件，已停止写入以保护现有凭证")
  }
}

function writeKeysFile(file, doc) {
  const tmp = `${file}.tmp.${process.pid}`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export function registerWeb(ctx, deps) {
  const web = typeof ctx.get === "function" ? ctx.get("webServer") : undefined
  if (!web || typeof web.register !== "function") {
    deps.logger?.info?.("keypool: 没有 webServer，跳过设置页接口")
    return
  }

  const { config, pools, store, catalog } = deps
  const quota = new QuotaClient()
  ctx.effect(() => () => quota.dispose(), "dsh-opencode-pool: quota requests")

  async function snapshot() {
    store.refresh()
    const providers = []
    for (const pool of pools.values()) {
      const merged = deps.keysOf(pool)
      const baseline = new Map(pool.keys.map((key) => [key.id, key]))
      const providerState = store.provider(pool.id)
      const keys = await Promise.all(merged.map(async (key) => {
        const state = store.keyState(pool.id, key.id)
        const value = key.value ?? (key.ref ? (await ctx.credentials.resolve(key.ref))?.value : undefined)
        const fromConfig = baseline.get(key.id) === key
        return {
          quota: await quota.get(value, { enabled: pool.quotaUsage }),
          id: key.id,
          label: key.label ?? "",
          ref: key.ref ?? "",
          inline: Boolean(key.value),
          configured: Boolean(value),
          source: fromConfig ? "config" : "file",
          overridesConfig: !fromConfig && baseline.has(key.id),
          status: state.status,
          until: state.until,
          remainingMs: Math.max(0, (state.until ?? 0) - Date.now()),
          req: state.req ?? 0,
          ok: state.ok ?? 0,
          fail: state.fail ?? 0,
          cacheRate: cacheHitRate(state),
          lastError: state.lastError ?? "",
          lastUsed: state.lastUsed ?? 0,
        }
      }))
      providers.push({
        id: pool.id,
        credentialRef: pool.credentialRef,
        active: providerState.active ?? "",
        keys,
      })
    }
    return {
      generatedAt: new Date().toISOString(),
      stateFile: store.file,
      keysFile: config.keysFile,
      providers,
    }
  }

  async function action(req, res) {
    if (!loopback(req)) return sendJson(res, 403, { ok: false, error: "仅允许本机访问" })
    if (String(req.headers["x-keypool-request"] ?? "") !== "1") {
      return sendJson(res, 403, { ok: false, error: "缺少 x-keypool-request 头" })
    }
    if (!String(req.headers["content-type"] ?? "").includes("application/json")) {
      return sendJson(res, 415, { ok: false, error: "需要 application/json" })
    }

    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
    }

    const providerId = String(body.provider ?? "")
    const pool = pools.get(providerId)
    if (!pool) return sendJson(res, 404, { ok: false, error: `未知 provider: ${providerId || "(空)"}` })
    const keyId = String(body.key ?? "")
    const findKey = () => deps.keysOf(pool).find((key) => key.id === keyId)

    try {
      switch (body.action) {
        case "refresh-usage": {
          if (keyId && !findKey()) return sendJson(res, 404, { ok: false, error: `未知 key: ${keyId}` })
          // snapshot queries the official endpoint; its 60s single-flight cache also bounds manual refresh.
          break
        }
        case "reset": {
          if (keyId && !findKey()) return sendJson(res, 404, { ok: false, error: `未知 key: ${keyId}` })
          const targets = keyId ? [keyId] : deps.keysOf(pool).map((key) => key.id)
          for (const id of targets) {
            const state = store.keyState(pool.id, id)
            state.status = "ok"
            state.until = 0
            state.reason = ""
            state.lastError = ""
            state.ts = Date.now()
          }
          store.dirty = true
          store.flush()
          deps.logger?.info?.(`keypool: 设置页重置冷却 ${providerId}/${keyId || "全部"}`)
          break
        }
        case "activate": {
          const key = findKey()
          if (!key) return sendJson(res, 404, { ok: false, error: `未知 key: ${keyId}` })
          const ok = await deps.activate(pool, key)
          if (!ok) return sendJson(res, 400, { ok: false, error: `${key.ref ?? key.id} 解析为空，无法生效` })
          break
        }
        case "add": {
          const ref = typeof body.ref === "string" ? body.ref.trim() : ""
          const value = typeof body.value === "string" ? body.value.trim() : ""
          const label = typeof body.label === "string" ? body.label.trim() : ""
          if (Boolean(ref) === Boolean(value)) return sendJson(res, 400, { ok: false, error: "请选择一种凭证方式：ref 或 value，不能同时填写" })
          if (ref === pool.credentialRef) return sendJson(res, 400, { ok: false, error: "不能引用生效槽位，请使用独立的凭证 ref" })
          const doc = readKeysFile(config.keysFile)
          const list = Array.isArray(doc.providers[providerId]) ? doc.providers[providerId] : []
          const existing = deps.keysOf(pool)
          if (existing.some((item) => (ref && item.ref === ref) || (value && item.value === value))) {
            return sendJson(res, 409, { ok: false, error: "该凭证已在池中" })
          }
          let sequence = 1
          while (existing.some((item) => item.id === `k${sequence}`)) sequence++
          const id = typeof body.id === "string" && body.id.trim() ? body.id.trim() : `k${sequence}`
          if (existing.some((item) => item.id === id)) {
            return sendJson(res, 409, { ok: false, error: `id 已存在: ${id}` })
          }
          list.push({ id, ...(ref ? { ref } : {}), ...(value ? { value } : {}), ...(label ? { label } : {}) })
          doc.providers[providerId] = list
          writeKeysFile(config.keysFile, doc)
          catalog.invalidate()
          deps.logger?.info?.(`keypool: 设置页新增 key ${providerId}/${id}`)
          break
        }
        case "edit": {
          const current = findKey()
          if (!current) return sendJson(res, 404, { ok: false, error: `未知 key: ${keyId}` })
          const updated = { ...current }
          if (typeof body.label === "string") updated.label = body.label.trim()
          if (body.ref !== undefined || body.value !== undefined) {
            const ref = typeof body.ref === "string" ? body.ref.trim() : ""
            const value = typeof body.value === "string" ? body.value.trim() : ""
            if (Boolean(ref) === Boolean(value)) return sendJson(res, 400, { ok: false, error: "请选择一种凭证方式：ref 或 value" })
            if (ref === pool.credentialRef) return sendJson(res, 400, { ok: false, error: "不能引用生效槽位" })
            if (deps.keysOf(pool).some((key) => key.id !== keyId && ((ref && key.ref === ref) || (value && key.value === value)))) {
              return sendJson(res, 409, { ok: false, error: "该凭证已在池中" })
            }
            delete updated.ref
            delete updated.value
            if (ref) updated.ref = ref
            else updated.value = value
          }
          const doc = readKeysFile(config.keysFile)
          const list = Array.isArray(doc.providers[providerId]) ? doc.providers[providerId] : []
          const index = list.findIndex((item) => item?.id === keyId)
          if (index < 0) list.push(updated)
          else list[index] = updated
          doc.providers[providerId] = list
          writeKeysFile(config.keysFile, doc)
          catalog.invalidate()
          deps.invalidate?.(pool.id)
          break
        }
        case "remove": {
          const doc = readKeysFile(config.keysFile)
          const list = Array.isArray(doc.providers[providerId]) ? doc.providers[providerId] : []
          const index = list.findIndex((item) => item?.id === keyId)
          if (index < 0) {
            return sendJson(res, 400, {
              ok: false,
              error: "这把 key 来自 cordis.patch.yml，请改配置文件；设置页只能删运行时 keys 文件里的 key",
            })
          }
          list.splice(index, 1)
          doc.providers[providerId] = list
          writeKeysFile(config.keysFile, doc)
          catalog.invalidate()
          deps.invalidate?.(pool.id)
          if (store.provider(pool.id).active === keyId) store.provider(pool.id).active = undefined
          const state = store.keyState(pool.id, keyId)
          state.status = "ok"
          state.until = 0
          store.dirty = true
          store.flush()
          deps.logger?.info?.(`keypool: 设置页移除 key ${providerId}/${keyId}`)
          break
        }
        default:
          return sendJson(res, 400, { ok: false, error: `未知 action: ${String(body.action)}` })
      }
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }

    return sendJson(res, 200, { ok: true, snapshot: await snapshot() })
  }

  async function status(req, res) {
    if (!loopback(req)) return sendJson(res, 403, { ok: false, error: "仅允许本机访问" })
    try {
      return sendJson(res, 200, { ok: true, snapshot: await snapshot() })
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }

  const disposers = [
    web.register({ kind: "exact", path: "/opencode-pool/status", handler: status }),
    web.register({ kind: "exact", path: "/opencode-pool/action", handler: action }),
  ]
  ctx.effect(
    () => () => {
      for (const dispose of disposers) dispose()
    },
    "dsh-opencode-pool: web routes",
  )
}
