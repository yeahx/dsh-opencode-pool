# dsh-opencode-pool

**简体中文** | [English](README.en.md)

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 里为 **OpenCode Go** 路由挂一个 API Key 池：平时只粘住一把 Key，保住上游 prompt cache；额度耗尽或凭证失效时才自动换 Key，并在同一步重放。设置页直接显示每把 Key 的官方 **5 小时 / 每周 / 每月** 用量。

> 非官方插件，与 OpenCode / Anomaly 无隶属关系。额度来自 OpenCode 官方接口，需要 Key 所属账号开通 Go 套餐。设置页界面目前为简体中文。

## 功能

- **官方额度可视化**：读取 `GET https://opencode.ai/zen/go/v1/usage` 的 `rolling` / `weekly` / `monthly` 三档，显示已用百分比、进度条、重置时间和最后刷新时间。查询失败保留上次数据并明确标注，不会把未知用量显示成 0%。
- **粘性 Key**：只在额度/凭证错误时切换，不做每请求轮询，避免打散 cache。
- **同一步重放**：在 `agent/request-error` 返回 `{ kind: "retry" }`，agent loop 用同一份持久化历史重放本步，会话日志不受影响。
- **设置页管理**：编辑备注、替换凭证、重置冷却、确认后切换生效、移除或撤销覆盖；折叠式添加表单，`ref` 与明文二选一。
- **热加载**：`~/.dsh/keypool-keys.json` 变更即时生效，无需重启。
- **CLI**：`status` / `active` / `reset` / `add`。

## 快速开始

### 1. 路由使用插件管理的槽位

在 profile 的 `cordis.patch.yml`（通常是 `~/.dsh/profiles/<profile>/cordis.patch.yml`）中，让 `llm-pi-ai` 的 `opencode-go` 使用 `OPENCODE_GO_API_KEY`：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      opencode-go:
        apiKeyEnv: OPENCODE_GO_API_KEY
```

这个引用名必须与插件配置里的 `credentialRef` 完全一致。

### 2. 准备 Key

推荐写进 `~/.dsh/.credentials.yaml` 的 `refs:` 段（文件权限建议 600）：

```yaml
refs:
  OPENCODE_GO_KEY_1: sk-xxx
  OPENCODE_GO_KEY_2: sk-yyy
```

也可以直接在插件配置里写 `value`，但明文只建议临时排查使用。

### 3. 安装

把仓库克隆到任意目录，然后用 Plugin Manager 安装：

```text
plugin_manager { action: "install_bundle", target: "/绝对路径/dsh-opencode-pool" }
```

安装会写入 profile 的依赖与 bundle 选择；插件自带的 `cordis.patch.yml` 插入 `opencode-pool` 行和默认配置（`opencode-go`、k1 / k2）。修改 Key 数量或 ref 后需要重新加载插件或重启；日常增删 Key 直接在设置页操作即可。

### 4. 打开设置页

**Settings → Key 池**：每把 Key 的三档官方用量、生效标记，以及本地请求数、成功/失败数、cache 命中率。

## 用量口径

- `percent` 是**已使用百分比**，不是剩余百分比。
- 额度按 **Key 所属账号 / 工作区** 计算。同一套餐下的多把 Key 可能显示相同用量，这不是每把 Key 的独立额度。
- 查询结果缓存 60 秒（成功与失败都缓存），单次请求 8 秒超时，并发合并；手动刷新同样遵循 60 秒。
- 默认只对 `opencode-go` 开启。其他 OpenCode Go 路由可加 `quotaUsage: true`；非 Go 服务不要开启，否则会把该服务的 Key 发给 OpenCode。

## 故障切换规则

| 上游错误 | 行为 |
| --- | --- |
| 额度耗尽（`QUOTA` / `ACCOUNT_QUOTA`，或正文命中中英文额度文案，例如 `insufficient_quota`、`余额不足`） | 冷却当前 Key → 切下一把 → 重放本步 |
| 凭证失效（`INVALID_CREDENTIAL` / `MISSING_CREDENTIAL` / `AUTH`） | 同上 |
| 429 限流 / 5xx / 超时 / 传输错误 | 不换 Key，交给 `dsh-llm-retry` 在同一账号上退避 |
| 上下文超限等其它失败 | 与本插件无关，交回下游处理 |

每个 turn 最多切换 `maxRetriesPerTurn` 次（默认 3），防止死循环。没有可用备用 Key 时按原错误返回。

## 设置页接口

| 路由 | 说明 |
| --- | --- |
| `GET /opencode-pool/status` | 池快照；**不返回 Key 明文**，只给 `configured: true/false` |
| `POST /opencode-pool/action` | `{ action: "reset"\|"activate"\|"add"\|"edit"\|"remove"\|"refresh-usage", provider, key?, ref?, value?, label? }` |

写接口只接受 loopback 请求，必须带 `x-keypool-request: 1` 与 `content-type: application/json`。

## CLI

```bash
node cli.mjs status
node cli.mjs active
node cli.mjs reset --key k1
node cli.mjs add --provider opencode-go --ref OPENCODE_GO_KEY_3 --label 备号2
```

状态文件 `~/.dsh/keypool-state.json` 与运行中的 dsh 共享：插件在每次派发前检查 mtime，CLI 改完即时生效。

## 缓存命中率

```text
cache = cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)
```

`llm-pi-ai` 的 `inputTokens` 是**未缓存输入**，不是完整 prompt，所以命中率不能用 `cacheReadTokens / inputTokens`。没有输入记录时显示 `—`（CLI 为 `-`）。

## 已知限制

- 同一路由同时只有一把生效 Key：cache 命中最优，但不能靠多 Key 并行提升吞吐。
- 切换 Key 会让重放的那一步冷启动一次前缀 cache。
- 依赖 dsh 的 `llm/stream`、`agent/request-error`、`credentials` 契约（在 0.2.1-rc.3 上验证）；大版本升级后建议先跑测试。
- **不要与早期的 `@local/dsh-keypool` 同时启用**：两者共用 `~/.dsh/keypool-state.json` 与 `keypool-keys.json`，会互相覆盖状态。本仓库的插槽 id 和 HTTP 路由已经改名，不会再撞路由，但状态文件仍是同一份。

## 开发

```bash
node --test test/*.test.mjs
```

覆盖：粘性不轮询、额度切换、中文额度文案、401 切换、429 不切换、全池耗尽不重试、cache 统计、冷却到期恢复、CLI 改状态热识别、keys 文件热加载、额度解析与缓存/失败降级，以及设置页接口与安全闸。

## License

[MIT](LICENSE) © lazydog (yeahx)
