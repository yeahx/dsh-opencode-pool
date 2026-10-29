import test from "node:test"
import assert from "node:assert/strict"
import { cacheHitRate } from "../lib/stats.js"

test("1545% regression: divide cache reads by all input categories", () => {
  assert.equal(cacheHitRate({ inputTokens: 100, cacheReadTokens: 1545 }), 1545 / 1645)
  assert.equal(cacheHitRate({ inputTokens: 100, cacheReadTokens: 700, cacheWriteTokens: 200 }), 0.7)
})
test("all cached, no cache, no usage and legacy states", () => {
  assert.equal(cacheHitRate({ inputTokens: 0, cacheReadTokens: 100 }), 1)
  assert.equal(cacheHitRate({ inputTokens: 100 }), 0)
  assert.equal(cacheHitRate({ cacheWriteTokens: 100 }), 0)
  assert.equal(cacheHitRate({}), undefined)
  assert.equal(cacheHitRate({ inputTokens: 100, cacheReadTokens: 900 }), 0.9)
})
test("malformed counters are unknown rather than impossible percentages", () => {
  for (const value of [-1, NaN, Infinity, "100"]) {
    assert.equal(cacheHitRate({ inputTokens: value, cacheReadTokens: 100 }), undefined)
    assert.equal(cacheHitRate({ inputTokens: 100, cacheReadTokens: value }), undefined)
    assert.equal(cacheHitRate({ inputTokens: 100, cacheWriteTokens: value }), undefined)
  }
})
