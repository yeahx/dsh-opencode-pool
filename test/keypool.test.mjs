/**
 * dsh-opencode-pool 单测：用假的 ctx 模拟 dsh 的扩展点，验证
 *   - 粘性：同一 provider 保持同一把生效 key，不轮询
 *   - 额度/凭证失败：标记冷却 + agent/request-error 返回 retry + 切到下一把
 *   - 限流/5xx：不换 key（保护 cache）
 *   - 全池耗尽：不返回 retry，交给上层失败
 *   - cache 统计、冷却恢复、状态文件跨进程可见
 *
 * 运行：node --test test/
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { apply } from "../index.js"

function makeCtx(initialRefs) {
  const handlers = new Map()
  const refs = new Map(Object.entries(initialRefs))
  const writes = []
  const logs = []
  const cleanups = []
  const ctx = {
    on(name, fn) {
      handlers.set(name, fn)
      return () => handlers.delete(name)
    },
    effect(fn) {
      cleanups.push(fn())
    },
    logger: {
      info: (message) => logs.push(["info", message]),
      warn: (message) => logs.push(["warn", message]),
      error: (message) => logs.push(["error", message]),
    },
    credentials: {
      async resolve(ref) {
        return refs.has(ref) ? { value: refs.get(ref), source: "test" } : undefined
      },
      async set(ref, value) {
        writes.push([ref, value])
        refs.set(ref, value)
      },
    },
  }
  return { ctx, handlers, refs, writes, logs }
}

function setup(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-opencode-pool-"))
  const stateFile = path.join(dir, "keypool-state.json")
  const env = makeCtx({
    KEY_1: "sk-one",
    KEY_2: "sk-two",
    ACTIVE: "sk-original",
    ...(options.refs ?? {}),
  })
  const keysFile = path.join(dir, "keys.json")
  const config = {
    stateFile,
    keysFile,
    providers: {
      "opencode-go": {
        credentialRef: "ACTIVE",
        keys: [
          { id: "k1", ref: "KEY_1" },
          { id: "k2", ref: "KEY_2" },
        ],
        quotaCooldownMs: options.quotaCooldownMs ?? 60_000,
        minCooldownMs: options.minCooldownMs ?? 15_000,
        invalidCooldownMs: 30_000,
        maxRetriesPerTurn: 3,
        verifyIntervalMs: 0,
      },
    },
  }
  apply(env.ctx, config)
  // 状态写盘有 400ms 防抖，读之前等文件出现
  const state = async () => {
    await new Promise((resolve) => setTimeout(resolve, 450)) // 等防抖落盘完成
    for (let i = 0; i < 80; i++) {
      try {
        return JSON.parse(fs.readFileSync(stateFile, "utf8"))
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
    throw new Error(`状态文件未写出: ${stateFile}`)
  }
  return { ...env, stateFile, keysFile, state, config, dir }
}

/** 跑一次 llm/stream，返回 (?next 的 chunk 序列) 结果 */
async function stream(handlers, provider, chunks = []) {
  const handler = handlers.get("llm/stream")
  const iterable = handler({ provider, model: "m", messages: [] }, async function* () {
    for (const chunk of chunks) yield chunk
  })
  const seen = []
  for await (const chunk of iterable) seen.push(chunk)
  return seen
}

async function requestError(handlers, payload, nextResult = undefined) {
  const handler = handlers.get("agent/request-error")
  let delegated = false
  const action = await handler(
    { agent: { id: "ses_1" }, turn: 1, step: 1, provider: "opencode-go", signal: new AbortController().signal, ...payload },
    async () => {
      delegated = true
      return nextResult
    },
  )
  return { action, delegated }
}

const finishError = (code, message, extra = {}) => ({
  type: "finish",
  reason: { kind: "error", failure: { code, message, ...extra } },
})

test("第一次派发写入生效槽位，之后保持同一把 key（不轮询）", async () => {
  const env = setup()
  try {
    await stream(env.handlers, "opencode-go")
    assert.deepEqual(env.writes, [["ACTIVE", "sk-one"]])
    assert.equal((await env.state()).providers["opencode-go"].active, "k1")

    await stream(env.handlers, "opencode-go")
    await stream(env.handlers, "opencode-go")
    assert.equal(env.writes.length, 1, "不应重复写入或轮换")
    assert.equal(env.refs.get("ACTIVE"), "sk-one")
  } finally {
    env.dir
  }
})

test("其他 provider 完全不受影响", async () => {
  const env = setup()
  const handler = env.handlers.get("llm/stream")
  let called = false
  const iterable = handler({ provider: "other", model: "m" }, async function* () {
    called = true
    yield { type: "finish", reason: { kind: "stop" } }
  })
  for await (const _ of iterable) {
  }
  assert.equal(called, true)
  assert.equal(env.writes.length, 0)
})

test("额度耗尽：标记冷却 + 返回 retry + 切到下一把 key", async () => {
  const env = setup()
  await stream(env.handlers, "opencode-go", [finishError("QUOTA", "You exceeded your current quota")])

  const state = await (await env.state())
  assert.equal(state.providers["opencode-go"].keys.k1.status, "quota")
  assert.ok(state.providers["opencode-go"].keys.k1.until > Date.now())

  const res = await requestError(env.handlers, { failure: { code: "QUOTA", message: "quota exceeded" } })
  assert.deepEqual(res.action, { kind: "retry" })
  assert.equal(res.delegated, false)
  assert.equal(env.refs.get("ACTIVE"), "sk-two")
  assert.equal((await env.state()).providers["opencode-go"].active, "k2")

  // 重放的那一步会走同一个瀑布，此时用 k2，且不再写槽位
  await stream(env.handlers, "opencode-go")
  assert.equal(env.writes.length, 2)
  assert.equal(env.writes.at(-1)[1], "sk-two")
})

test("中文额度文案也能识别（中转常见）", async () => {
  const env = setup()
  await stream(env.handlers, "opencode-go", [finishError("SERVER", "上游返回: 账户余额不足，请充值")])
  assert.equal((await env.state()).providers["opencode-go"].keys.k1.status, "quota")
  const res = await requestError(env.handlers, { failure: { code: "SERVER", message: "余额不足" } })
  assert.deepEqual(res.action, { kind: "retry" })
})

test("凭证失效：换 key；冷却时长用 invalidCooldownMs", async () => {
  const env = setup()
  await stream(env.handlers, "opencode-go", [finishError("INVALID_CREDENTIAL", "invalid api key")])
  const state = await (await env.state())
  const remaining = state.providers["opencode-go"].keys.k1.until - Date.now()
  assert.ok(remaining > 20_000 && remaining <= 31_000, `冷却应约 30s，实际 ${remaining}`)
  const res = await requestError(env.handlers, { failure: { code: "INVALID_CREDENTIAL", message: "invalid api key" } })
  assert.deepEqual(res.action, { kind: "retry" })
  assert.equal(env.refs.get("ACTIVE"), "sk-two")
})

test("429 限流不换 key：交给 dsh-llm-retry 自己退避", async () => {
  const env = setup()
  await stream(env.handlers, "opencode-go", [finishError("RATE_LIMIT", "rate limit exceeded")])
  assert.equal((await env.state()).providers["opencode-go"].keys.k1.status, "ok")
  const res = await requestError(env.handlers, { failure: { code: "RATE_LIMIT", message: "rate limit exceeded" } })
  assert.equal(res.action, undefined)
  assert.equal(res.delegated, true)
  assert.equal(env.writes.length, 1, "不应切换")
})

test("全池耗尽：不返回 retry，避免无意义的重复请求", async () => {
  const env = setup()
  await stream(env.handlers, "opencode-go", [finishError("QUOTA", "quota exceeded")])
  await requestError(env.handlers, { failure: { code: "QUOTA", message: "quota exceeded" } }) // -> k2
  await stream(env.handlers, "opencode-go", [finishError("QUOTA", "quota exceeded")]) // k2 也没额度
  const res = await requestError(env.handlers, { failure: { code: "QUOTA", message: "quota exceeded" } })
  assert.equal(res.action, undefined)
  assert.equal(res.delegated, true)
})

test("usage 里的 cache 命中记到 key 上", async () => {
  const env = setup()
  await stream(env.handlers, "opencode-go", [
    { type: "usage", usage: { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 800, cacheWriteTokens: 200 } },
    { type: "finish", reason: { kind: "stop" } },
  ])
  const key = (await env.state()).providers["opencode-go"].keys.k1
  assert.equal(key.inputTokens, 1000)
  assert.equal(key.cacheReadTokens, 800)
  assert.equal(key.cacheWriteTokens, 200)
  assert.equal(key.ok, 1)
})

test("冷却到期后自动恢复可用（无需重启）", async () => {
  const env = setup({ quotaCooldownMs: 50, minCooldownMs: 10 })
  await stream(env.handlers, "opencode-go", [finishError("QUOTA", "quota exceeded")])
  await requestError(env.handlers, { failure: { code: "QUOTA", message: "quota exceeded" } }) // -> k2
  await new Promise((resolve) => setTimeout(resolve, 120))
  // k1 冷却结束；k2 是当前 active，所以仍然用 k2（粘性优先，不来回跳）
  await stream(env.handlers, "opencode-go")
  assert.equal((await env.state()).providers["opencode-go"].active, "k2")

  // 把 k2 打掉后，k1 应该能被选回来
  await stream(env.handlers, "opencode-go", [finishError("QUOTA", "quota exceeded")])
  const res = await requestError(env.handlers, { failure: { code: "QUOTA", message: "quota exceeded" } })
  assert.deepEqual(res.action, { kind: "retry" })
  assert.equal((await env.state()).providers["opencode-go"].active, "k1")
})

test("CLI reset 清除冷却后插件能识别（多进程共享状态）", async () => {
  const env = setup()
  await stream(env.handlers, "opencode-go", [finishError("QUOTA", "quota exceeded")])
  assert.equal((await env.state()).providers["opencode-go"].keys.k1.status, "quota")

  const data = (await env.state())
  data.providers["opencode-go"].keys.k1.status = "ok"
  data.providers["opencode-go"].keys.k1.until = 0
  data.providers["opencode-go"].keys.k1.ts = Date.now() + 1000
  fs.writeFileSync(env.stateFile, JSON.stringify(data))
  fs.utimesSync(env.stateFile, new Date(), new Date(Date.now() + 1000))

  await stream(env.handlers, "opencode-go")
  assert.equal((await env.state()).providers["opencode-go"].keys.k1.status, "ok")
})

test("keys 文件热加载：新加的 key 不改配置、不重启即可参与轮换", async () => {
  const env = setup()
  await stream(env.handlers, "opencode-go", [finishError("QUOTA", "quota exceeded")])
  await requestError(env.handlers, { failure: { code: "QUOTA", message: "quota exceeded" } }) // -> k2

  // 运行时补一把 k3（模拟用户发现额度没了，直接加文件）
  fs.writeFileSync(env.keysFile, JSON.stringify({ "opencode-go": [{ id: "k3", value: "sk-three", label: "临时" }] }))
  await stream(env.handlers, "opencode-go") // 触发 reload（active k2 仍健康，不切）
  await stream(env.handlers, "opencode-go", [finishError("QUOTA", "quota exceeded")]) // k2 也挂
  const res = await requestError(env.handlers, { failure: { code: "QUOTA", message: "quota exceeded" } })
  assert.deepEqual(res.action, { kind: "retry" })
  assert.equal(env.refs.get("ACTIVE"), "sk-three")
  assert.equal((await env.state()).providers["opencode-go"].active, "k3")
})
