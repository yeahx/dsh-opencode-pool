# dsh-opencode-pool

[简体中文](README.md) | **English**

An API key pool for **OpenCode Go** routes in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It keeps one key sticky so the upstream prompt cache stays warm, and only fails over — then replays the same agent step — when the upstream reports exhausted quota or invalid credentials. The Settings page shows official **5-hour / weekly / monthly** usage for every key.

> Unofficial plugin, not affiliated with OpenCode or Anomaly. Usage comes from OpenCode's official endpoint and requires the key's account to have a Go subscription. The Settings UI is currently Simplified Chinese.

## Features

- **Official usage meters**: reads `rolling` / `weekly` / `monthly` from `GET https://opencode.ai/zen/go/v1/usage` and renders used percentage, progress bar, reset time, and last refresh. Failures keep the last known values and are clearly marked — unknown usage is never shown as 0%.
- **Sticky keys**: failover only on quota/credential errors, never per-request rotation, so the cache is not shredded.
- **Same-step replay**: returns `{ kind: "retry" }` from `agent/request-error`; the agent loop replays the step from the same durable history, leaving the session log untouched.
- **Settings management**: edit labels, replace credentials, reset cooldowns, confirm-then-activate, remove or revert overrides; a collapsed add form with an explicit `ref` vs. plaintext choice.
- **Hot reload**: changes to `~/.dsh/keypool-keys.json` apply immediately, no restart.
- **CLI**: `status`, `active`, `reset`, `add`.

## Quick start

### 1. Point the route at the managed credential slot

In your profile's `cordis.patch.yml` (usually `~/.dsh/profiles/<profile>/cordis.patch.yml`), make `llm-pi-ai`'s `opencode-go` route use `OPENCODE_GO_API_KEY`:

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      opencode-go:
        apiKeyEnv: OPENCODE_GO_API_KEY
```

That reference name must match the plugin's `credentialRef` exactly.

### 2. Add keys

Preferred: put them in the `refs:` section of `~/.dsh/.credentials.yaml` (mode 600):

```yaml
refs:
  OPENCODE_GO_KEY_1: sk-xxx
  OPENCODE_GO_KEY_2: sk-yyy
```

You can also set `value` directly in the plugin config, but plaintext is only meant for temporary debugging.

### 3. Install

Clone the repository anywhere, then install it with the Plugin Manager:

```text
plugin_manager { action: "install_bundle", target: "/absolute/path/to/dsh-opencode-pool" }
```

Installation adds the profile dependency and bundle selection. The bundled `cordis.patch.yml` inserts the `opencode-pool` row and defaults (`opencode-go`, k1 / k2). Changing key count or refs requires a plugin reload or restart; day-to-day key management happens in Settings.

### 4. Open Settings

**Settings → Key 池**: per-key official usage windows, the active marker, local request/success/failure counts, and cache hit rate.

## Usage semantics

- `percent` is **used**, not remaining.
- Quota belongs to the key's **account / workspace**. Keys on the same plan may show identical usage; this is not a per-key allowance.
- Responses are cached for 60 seconds (successes and failures alike), each request times out after 8 seconds, and concurrent lookups are coalesced. Manual refresh obeys the same 60-second window.
- Enabled by default only for `opencode-go`. Other OpenCode Go routes can set `quotaUsage: true`; never enable it for non-Go services, since that key would be sent to OpenCode.

## Failover rules

| Upstream error | Behavior |
| --- | --- |
| Quota exhausted (`QUOTA` / `ACCOUNT_QUOTA`, or English/Chinese quota text such as `insufficient_quota` or `余额不足`) | Cool the key → switch to the next one → replay the step |
| Invalid credentials (`INVALID_CREDENTIAL` / `MISSING_CREDENTIAL` / `AUTH`) | Same as above |
| 429 rate limit / 5xx / timeout / transport error | Keep the key; `dsh-llm-retry` backs off on the same account |
| Context-window overflow and other failures | Not this plugin's concern; delegated downstream |

At most `maxRetriesPerTurn` switches per turn (default 3). With no usable spare key, the original error is returned.

## Settings endpoints

| Route | Purpose |
| --- | --- |
| `GET /opencode-pool/status` | Pool snapshot; **never returns key material**, only `configured: true/false` |
| `POST /opencode-pool/action` | `{ action: "reset"\|"activate"\|"add"\|"edit"\|"remove"\|"refresh-usage", provider, key?, ref?, value?, label? }` |

Write endpoints accept loopback requests only and require `x-keypool-request: 1` plus `content-type: application/json`.

## CLI

```bash
node cli.mjs status
node cli.mjs active
node cli.mjs reset --key k1
node cli.mjs add --provider opencode-go --ref OPENCODE_GO_KEY_3 --label backup
```

`~/.dsh/keypool-state.json` is shared with the running harness: the plugin re-reads it by mtime before dispatching, so CLI changes apply immediately.

## Cache hit rate

```text
cache = cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)
```

`inputTokens` from `llm-pi-ai` is **uncached input**, not the full prompt, so `cacheReadTokens / inputTokens` can exceed 100%. Missing input is shown as `—` (CLI: `-`).

## Known limitations

- One active key per route at a time: optimal for cache hits, but no parallel throughput from multiple keys.
- Switching keys cold-starts the prefix cache for the replayed step.
- Depends on dsh's `llm/stream`, `agent/request-error`, and `credentials` contracts (verified on 0.2.1-rc.3); re-run the tests after a major upgrade.
- **Do not enable this alongside the earlier `@local/dsh-keypool`**: both share `~/.dsh/keypool-state.json` and `keypool-keys.json` and will overwrite each other's state. Slot ids and HTTP routes were renamed here, so routes no longer collide, but the state files still do.

## Development

```bash
node --test test/*.test.mjs
```

Covers: sticky dispatch, quota failover, Chinese quota text, 401 failover, 429 non-failover, exhausted pool, cache accounting, cooldown recovery, CLI state pickup, keys-file hot reload, usage parsing/caching/degradation, and the Settings endpoints with their request guards.

## License

[MIT](LICENSE) © lazydog (yeahx)
