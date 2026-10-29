/**
 * keypool 设置页接口：状态快照与四个写操作。
 *
 * 运行：node --test test/
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { apply } from "../index.js"

function makeCtx(refs) {
  const routes = new Map()
  const cleanups = []
  const values = new Map(Object.entries(refs))
  const writes = []
  const ctx = {
    on() {
      return () => {}
    },
    effect(fn) {
      cleanups.push(fn())
    },
    get(name) {
      return name === "webServer" ? webServer : undefined
    },
    logger: { info() {}, warn() {}, error() {} },
    credentials: {
      async resolve(ref) {
        return values.has(ref) ? { value: values.get(ref) } : undefined
      },
      async set(ref, value) {
        writes.push([ref, value])
        values.set(ref, value)
      },
    },
  }
  const webServer = {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }
  return { ctx, routes, values, writes, cleanups }
}

function makeRes() {
  const res = {
    status: 0,
    body: "",
    writeHead(status) {
      res.status = status
    },
    end(body) {
      res.body = body ?? ""
    },
  }
  return res
}

const LOOPBACK = { socket: { remoteAddress: "127.0.0.1" } }

async function get(routes, pathname) {
  const res = makeRes()
  await routes.get(pathname)({ url: pathname, headers: {}, ...LOOPBACK }, res)
  return { status: res.status, json: res.body ? JSON.parse(res.body) : undefined }
}

async function post(routes, body, options = {}) {
  const res = makeRes()
  const payload = JSON.stringify(body)
  const req = {
    url: "/opencode-pool/action",
    headers: { "content-type": "application/json", "x-keypool-request": "1", ...(options.headers ?? {}) },
    socket: options.socket ?? LOOPBACK.socket,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(payload)
    },
  }
  await routes.get("/opencode-pool/action")(req, res)
  return { status: res.status, json: res.body ? JSON.parse(res.body) : undefined }
}

function setup(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keypool-web-"))
  const stateFile = path.join(dir, "state.json")
  const keysFile = path.join(dir, "keys.json")
  const env = makeCtx({ KEY_1: "sk-one", KEY_2: "sk-two", ACTIVE: "sk-one" })
  apply(env.ctx, {
    stateFile,
    keysFile,
    providers: {
      "opencode-go": {
        credentialRef: "ACTIVE",
        quotaUsage: false,
        keys: [
          { id: "k1", ref: "KEY_1", label: "主号" },
          { id: "k2", ref: "KEY_2", label: "备号" },
        ],
      },
    },
  })
  return { ...env, dir, stateFile, keysFile }
}

test("status 只回 configured，不回显 key 值", async () => {
  const env = setup()
  try {
    const { status, json } = await get(env.routes, "/opencode-pool/status")
    assert.equal(status, 200)
    const provider = json.snapshot.providers[0]
    assert.equal(provider.id, "opencode-go")
    assert.equal(provider.credentialRef, "ACTIVE")
    assert.equal(provider.keys.length, 2)
    assert.equal(provider.keys[0].label, "主号")
    assert.equal(provider.keys[0].configured, true)
    assert.equal(provider.keys[0].source, "config")
    assert.doesNotMatch(JSON.stringify(json), /sk-one|sk-two/, "状态里不能出现明文 key")
  } finally {
    fs.rmSync(env.dir, { recursive: true, force: true })
  }
})

test("reset 解除冷却，activate 切换生效槽位", async () => {
  const env = setup()
  try {
    // 先让 k1 冷却：直接走 plugin 的 llm/stream 太重，这里改状态文件
    const state = {
      version: 1,
      providers: { "opencode-go": { active: "k1", keys: { k1: { status: "quota", until: Date.now() + 3600_000, ts: Date.now() } } } },
    }
    fs.writeFileSync(env.stateFile, JSON.stringify(state))

    const reset = await post(env.routes, { action: "reset", provider: "opencode-go", key: "k1" })
    assert.equal(reset.status, 200)
    assert.equal(reset.json.snapshot.providers[0].keys[0].status, "ok")
    assert.equal(reset.json.snapshot.providers[0].keys[0].remainingMs, 0)

    const activate = await post(env.routes, { action: "activate", provider: "opencode-go", key: "k2" })
    assert.equal(activate.status, 200)
    assert.equal(env.values.get("ACTIVE"), "sk-two")
    assert.equal(activate.json.snapshot.providers[0].active, "k2")
  } finally {
    fs.rmSync(env.dir, { recursive: true, force: true })
  }
})

test("add 写 keys 文件后立刻出现在快照里，remove 只删文件里的 key", async () => {
  const env = setup()
  try {
    const added = await post(env.routes, {
      action: "add",
      provider: "opencode-go",
      ref: "KEY_3",
      label: "临时",
    })
    assert.equal(added.status, 200)
    const doc = JSON.parse(fs.readFileSync(env.keysFile, "utf8"))
    assert.deepEqual(doc.providers["opencode-go"], [{ id: "k3", ref: "KEY_3", label: "临时" }])

    const keys = added.json.snapshot.providers[0].keys
    const extra = keys.find((key) => key.ref === "KEY_3")
    assert.ok(extra, "新增的 key 应出现在快照里")
    assert.equal(extra.source, "file")
    assert.equal(extra.configured, false, "ref 还没有值")

    // 重复 ref 拒绝
    const dup = await post(env.routes, { action: "add", provider: "opencode-go", ref: "KEY_3" })
    assert.equal(dup.status, 409)

    // 删文件里的 key 可以，删 patch 里的 key 不行
    const removed = await post(env.routes, { action: "remove", provider: "opencode-go", key: extra.id })
    assert.equal(removed.status, 200)
    const configKey = await post(env.routes, { action: "remove", provider: "opencode-go", key: "k1" })
    assert.equal(configKey.status, 400)
    assert.match(configKey.json.error, /cordis\.patch\.yml/)
  } finally {
    fs.rmSync(env.dir, { recursive: true, force: true })
  }
})

test("新增不覆盖基线、拒绝双凭证与重复凭证；编辑可保留密钥并恢复配置", async () => {
  const env = setup()
  try {
    assert.equal((await post(env.routes, { action: "add", provider: "opencode-go", ref: "KEY_1" })).status, 409)
    assert.equal((await post(env.routes, { action: "add", provider: "opencode-go", ref: "KEY_3", value: "secret" })).status, 400)
    assert.equal((await post(env.routes, { action: "add", provider: "opencode-go", ref: "KEY_3", id: "k1" })).status, 409)
    assert.equal((await post(env.routes, { action: "add", provider: "opencode-go", ref: "ACTIVE" })).status, 400)
    const edit = await post(env.routes, { action: "edit", provider: "opencode-go", key: "k1", label: "改名" })
    assert.equal(edit.status, 200)
    const key = edit.json.snapshot.providers[0].keys[0]
    assert.equal(key.ref, "KEY_1")
    assert.equal(key.label, "改名")
    assert.equal(key.source, "file")
    assert.equal(key.overridesConfig, true)
    assert.equal(key.quota.status, "unavailable")
    const restore = await post(env.routes, { action: "remove", provider: "opencode-go", key: "k1" })
    assert.equal(restore.json.snapshot.providers[0].keys[0].label, "主号")
    assert.equal(restore.json.snapshot.providers[0].keys[0].source, "config")
    const replace = await post(env.routes, { action: "edit", provider: "opencode-go", key: "k1", value: "replacement-secret" })
    assert.equal(replace.status, 200)
    assert.doesNotMatch(JSON.stringify(replace.json), /replacement-secret/)
    assert.equal(replace.json.snapshot.providers[0].keys[0].inline, true)
    assert.equal(replace.json.snapshot.providers[0].keys[0].ref, "")
    assert.equal((await post(env.routes, { action: "reset", provider: "opencode-go", key: "missing" })).status, 404)
  } finally {
    for (const cleanup of env.cleanups) cleanup?.()
    fs.rmSync(env.dir, { recursive: true, force: true })
  }
})

test("损坏的 keys 文件不能被写操作静默覆盖", async () => {
  const env = setup()
  try {
    fs.writeFileSync(env.keysFile, "{broken")
    const result = await post(env.routes, { action: "add", provider: "opencode-go", ref: "KEY_3" })
    assert.equal(result.status, 500)
    assert.equal(fs.readFileSync(env.keysFile, "utf8"), "{broken")
  } finally {
    for (const cleanup of env.cleanups) cleanup?.()
    fs.rmSync(env.dir, { recursive: true, force: true })
  }
})

test("写接口的三道闸：来源、请求头、content-type", async () => {
  const env = setup()
  try {
    const remote = await post(env.routes, { action: "reset", provider: "opencode-go" }, {
      socket: { remoteAddress: "10.0.0.8" },
    })
    assert.equal(remote.status, 403)

    const noHeader = await post(env.routes, { action: "reset", provider: "opencode-go" }, {
      headers: { "x-keypool-request": "" },
    })
    assert.equal(noHeader.status, 403)

    const badType = await post(env.routes, { action: "reset", provider: "opencode-go" }, {
      headers: { "content-type": "text/plain" },
    })
    assert.equal(badType.status, 415)

    const unknown = await post(env.routes, { action: "reset", provider: "nope" })
    assert.equal(unknown.status, 404)
  } finally {
    fs.rmSync(env.dir, { recursive: true, force: true })
  }
})

test("没有 webServer 的 profile 不会因为注册接口而报错", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keypool-noweb-"))
  const env = makeCtx({ ACTIVE: "sk-one" })
  env.ctx.get = () => undefined
  try {
    apply(env.ctx, {
      stateFile: path.join(dir, "state.json"),
      keysFile: path.join(dir, "keys.json"),
      providers: { p: { credentialRef: "ACTIVE", keys: [{ id: "k1", ref: "ACTIVE" }] } },
    })
    assert.equal(env.routes.size, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
