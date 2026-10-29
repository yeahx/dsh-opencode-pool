/**
 * keypool Web 半：只做结构性检查（不渲染）
 *   - 模块能被 __ModuleLoader__ 装配（bundle id 必须等于包名）
 *   - 注册到 settings.section，id/order/label 正确
 *   - 组件在不渲染的前提下能被 require 出来
 *
 * 运行：node --test test/
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

function loadBundle() {
  const file = path.join(import.meta.dirname, "..", "lib", "client.js")
  const source = fs.readFileSync(file, "utf8")

  // Registration-only dependency stub: never emulate React or render the view.
  const React = {}

  let loaded
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        loaded = definition
      },
    },
  }
  try {
    new Function("window", source)(globalThis.window)
  } finally {
    delete globalThis.window
  }

  assert.ok(loaded, "client.js 应调用 window.__ModuleLoader__.load")
  assert.equal(loaded.id, "dsh-opencode-pool")
  const exports = loaded.factory((specifier) => {
    assert.equal(specifier, "react")
    return React
  })
  return exports
}

test("Web 半导出 apply / inject，且只依赖 slots", () => {
  const exports = loadBundle()
  assert.equal(typeof exports.apply, "function")
  assert.deepEqual(exports.inject, ["slots"])
})

test("注册到 settings.section：id=opencode-pool、order=30、label 是 Key 池", () => {
  const exports = loadBundle()
  const registrations = []
  let injected = null
  const ctx = {
    slots: {
      inject(name, factory) {
        injected = name
        factory()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  exports.apply(ctx)
  assert.equal(injected, "settings.section")
  assert.equal(registrations.length, 1)
  const { options, component } = registrations[0]
  assert.equal(options.name, "settings.section")
  assert.equal(options.id, "opencode-pool")
  assert.equal(options.order, 30)
  assert.equal(options.label(), "Key 池")
  assert.equal(typeof component, "function")
  assert.deepEqual(options.inject(), {})
})

test("UI styles use only inspected theme tokens, without literal colors", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "client.js"), "utf8")
  const allowed = new Set([
    "--dsw-alias-bg-base", "--dsw-alias-bg-layer-1", "--dsw-alias-border-l1",
    "--dsw-alias-brand-primary", "--dsw-alias-label-primary",
    "--dsw-alias-label-secondary", "--dsw-alias-state-error-primary",
  ])
  const tokens = [...source.matchAll(/var\((--[\w-]+)\)/g)].map((match) => match[1])
  assert.ok(tokens.length > 0)
  for (const token of tokens) assert.ok(allowed.has(token), `Uninspected token: ${token}`)
  assert.doesNotMatch(source, /#[\da-f]{3,8}\b|\brgba?\(|\bhsla?\(/i)
  assert.doesNotMatch(source, /@deepseek-ai\/dsh-client-/)
})
