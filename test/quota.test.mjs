import test from "node:test"
import assert from "node:assert/strict"
import { QuotaClient, parseQuota } from "../lib/quota.js"

const body = () => ({ usage: Object.fromEntries(["rolling", "weekly", "monthly"].map((name, i) => [name, { percent: i * 25, status: "ok", resetsAt: "2026-10-27T00:00:00Z" }])) })
test("official meters map to 5h/week/month; zero is real and missing is unknown", () => {
  const windows = parseQuota(body())
  assert.deepEqual(windows.map((v) => [v.id, v.usedPercent]), [["5h", 0], ["week", 25], ["month", 50]])
  assert.equal(windows[0].resetAt, Date.parse("2026-10-27T00:00:00Z"))
  assert.equal(parseQuota({ usage: { rolling: { percent: 0 } } })[1].usedPercent, null)
  assert.throws(() => parseQuota({ usage: { rolling: { percent: "20" } } }))
  assert.throws(() => parseQuota({}))
})
test("trusted endpoint, bearer, no redirects, single flight and cache keyed by credential", async () => {
  let calls = 0, time = 1000
  const client = new QuotaClient({ clock: () => time, fetcher: async (url, options) => {
    calls++
    assert.equal(url, "https://opencode.ai/zen/go/v1/usage")
    assert.match(options.headers.authorization, /^Bearer secret/)
    assert.equal(options.redirect, "error")
    return { ok: true, json: async () => body() }
  } })
  try {
    const [a, b] = await Promise.all([client.get("secret-one"), client.get("secret-one")])
    assert.equal(calls, 1)
    assert.deepEqual(a, b)
    assert.equal(a.status, "ready")
    await client.get("secret-one")
    assert.equal(calls, 1)
    await client.get("secret-two")
    assert.equal(calls, 2)
    time += 60001
    await client.get("secret-one")
    assert.equal(calls, 3)
    assert.doesNotMatch(JSON.stringify(a), /secret/)
  } finally { client.dispose() }
})
test("failed refresh retains stale meters, sanitizes errors and backs off", async () => {
  let time = 1000, fail = false, calls = 0
  const client = new QuotaClient({ clock: () => time, fetcher: async () => {
    calls++
    if (fail) throw new Error("secret-one https://untrusted/")
    return { ok: true, json: async () => body() }
  } })
  try {
    const good = await client.get("secret-one")
    fail = true; time += 60001
    const stale = await client.get("secret-one")
    assert.equal(stale.status, "error")
    assert.equal(stale.fetchedAt, good.fetchedAt)
    assert.deepEqual(stale.windows, good.windows)
    assert.doesNotMatch(JSON.stringify(stale), /secret|untrusted/)
    await client.get("secret-one")
    assert.equal(calls, 2)
  } finally { client.dispose() }
})
test("unsupported and missing credentials never query; 403 is explicit without body leakage", async () => {
  let calls = 0
  const client = new QuotaClient({ fetcher: async () => {
    calls++
    return { ok: false, status: 403, json: async () => ({ secret: "sensitive" }) }
  } })
  try {
    assert.equal((await client.get("key", { enabled: false })).status, "unavailable")
    assert.equal((await client.get("")).status, "unavailable")
    assert.equal(calls, 0)
    const result = await client.get("key")
    assert.equal(result.status, "error")
    assert.match(result.error, /无权/)
    assert.equal(result.fetchedAt, null)
    assert.deepEqual(result.windows, [])
  } finally { client.dispose() }
})
