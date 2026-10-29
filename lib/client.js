window.__ModuleLoader__.load({
  id: "dsh-opencode-pool",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;
    const POLL_MS = 5000;
    const css = `
      .kp { color:var(--dsw-alias-label-primary); font-size:13px; line-height:1.6; padding:20px; max-width:1080px; box-sizing:border-box; }
      .kp * { box-sizing:border-box; }
      .kp h2,.kp h3,.kp h4,.kp p { margin:0; }
      .kp h2 { font-size:20px; letter-spacing:-.3px; }
      .kp h3 { font-size:15px; }
      .kp h4 { font-size:14px; }
      .kp small,.kp .kp-muted { color:var(--dsw-alias-label-secondary); }
      .kp .kp-caption { color:var(--dsw-alias-label-secondary); font-size:12px; }
      .kp .kp-stack { display:flex; flex-direction:column; gap:12px; min-width:0; }
      .kp .kp-row { display:flex; align-items:center; flex-wrap:wrap; gap:8px; min-width:0; }
      .kp .kp-between { justify-content:space-between; }
      .kp .kp-wrap { overflow-wrap:anywhere; min-width:0; }
      .kp .kp-provider { margin-top:20px; border:1px solid var(--dsw-alias-border-l1); border-radius:14px; overflow:hidden; background:var(--dsw-alias-bg-base); }
      .kp .kp-provider-head { padding:16px 18px; border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); }
      .kp .kp-key { padding:18px; border-bottom:1px solid var(--dsw-alias-border-l1); }
      .kp .kp-key-active { border-inline-start:3px solid var(--dsw-alias-brand-primary); padding-inline-start:15px; }
      .kp .kp-badge { display:inline-flex; align-items:center; border:1px solid var(--dsw-alias-border-l1); border-radius:20px; padding:2px 8px; font-size:11px; font-weight:600; }
      .kp .kp-accent { color:var(--dsw-alias-brand-primary); }
      .kp .kp-danger { color:var(--dsw-alias-state-error-primary); }
      .kp .kp-quotas { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; }
      .kp .kp-quota { padding:12px; border:1px solid var(--dsw-alias-border-l1); border-radius:10px; min-width:0; }
      .kp .kp-percent { font-size:23px; line-height:1.3; font-weight:650; font-variant-numeric:tabular-nums; margin:7px 0 9px; }
      .kp .kp-track { height:5px; border-radius:8px; background:var(--dsw-alias-bg-layer-1); overflow:hidden; margin-bottom:8px; }
      .kp .kp-fill { height:100%; background:var(--dsw-alias-brand-primary); border-radius:8px; }
      .kp .kp-fill-full { background:var(--dsw-alias-state-error-primary); }
      .kp button,.kp input,.kp select { font:inherit; border-radius:7px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); }
      .kp button { min-height:34px; padding:5px 11px; cursor:pointer; }
      .kp button:hover:not(:disabled),.kp summary:hover { background:var(--dsw-alias-bg-layer-1); }
      .kp button:disabled { opacity:.5; cursor:not-allowed; }
      .kp :is(button,input,select,summary):focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:3px; }
      .kp .kp-primary { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); font-weight:600; }
      .kp label { display:flex; flex-direction:column; gap:5px; font-size:12px; font-weight:500; min-width:0; }
      .kp input,.kp select { width:100%; min-height:38px; padding:7px 10px; }
      .kp .kp-fields { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr)); gap:12px; }
      .kp fieldset { border:0; padding:0; margin:0; min-width:0; }
      .kp .kp-form,.kp .kp-confirm { padding:14px; border:1px solid var(--dsw-alias-border-l1); border-radius:10px; background:var(--dsw-alias-bg-layer-1); }
      .kp .kp-add { padding:14px 18px; }
      .kp summary { cursor:pointer; font-weight:600; padding:3px 0; }
      .kp details[open] > summary { margin-bottom:12px; }
      .kp .kp-message { margin-top:12px; padding:10px 12px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; overflow-wrap:anywhere; }
      .kp .kp-footer { margin-top:18px; overflow-wrap:anywhere; }
      @media (max-width:600px) { .kp { padding:12px; } .kp .kp-quotas { grid-template-columns:1fr; } .kp .kp-key,.kp .kp-provider-head { padding:14px; } .kp .kp-key-active { padding-inline-start:11px; } }
    `;

    function duration(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return "—";
      const minutes = Math.ceil(ms / 60000);
      if (minutes < 60) return minutes + " 分钟";
      if (minutes < 1440) return Math.floor(minutes / 60) + " 小时 " + minutes % 60 + " 分钟";
      return Math.floor(minutes / 1440) + " 天 " + Math.floor(minutes % 1440 / 60) + " 小时";
    }
    function date(value) {
      if (!Number.isFinite(value) || value <= 0) return null;
      const result = new Date(value);
      return Number.isNaN(result.getTime()) ? null : result.toLocaleString();
    }
    const message = (err) => String(err && err.message ? err.message : err);
    const button = (text, onClick, disabled, className = "") => h("button", { type: "button", onClick, disabled, className }, text);
    const badge = (text, className = "") => h("span", { className: "kp-badge " + className }, text);

    function Quota({ quota }) {
      const state = quota?.status || "unavailable";
      const outdated = state !== "ready" || quota?.stale === true;
      const statuses = { loading: "正在读取官方额度…", error: "额度刷新失败；已有数值仅供参考。", unavailable: "暂无官方额度数据；不以本地请求次数估算。" };
      return h("div", { className: "kp-stack" },
        h("div", { className: "kp-quotas" }, ...[["5h", "5 小时"], ["week", "每周"], ["month", "每月"]].map(([id, title]) => {
          const window = quota?.windows?.find((item) => item.id === id);
          const percent = Number.isFinite(window?.usedPercent) ? window.usedPercent : null;
          const reset = date(window?.resetAt);
          return h("div", { className: "kp-quota", key: id },
            h("div", { className: "kp-row kp-between" }, h("span", { className: "kp-muted" }, title), h("span", { className: "kp-caption" }, "已使用")),
            h("div", { className: "kp-percent" }, percent === null ? "—" : Math.round(percent * 10) / 10 + "%"),
            h("div", { className: "kp-track", ...(percent === null ? { "aria-hidden": true } : { role: "progressbar", "aria-label": title + "额度已使用", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.max(0, Math.min(100, percent)), "aria-valuetext": percent + "%" }) },
              percent === null ? null : h("div", { className: "kp-fill" + (percent >= 100 ? " kp-fill-full" : ""), style: { width: Math.max(0, Math.min(100, percent)) + "%" } })),
            h("div", { className: "kp-caption kp-wrap" }, percent === null ? "暂无数据" : outdated ? "上次已知用量" : "官方用量"),
            h("div", { className: "kp-caption kp-wrap" }, reset ? "重置于 " + reset : "重置时间未知"));
        })),
        statuses[state] ? h("p", { className: state === "error" ? "kp-danger kp-wrap" : "kp-caption", role: state === "error" ? "alert" : undefined }, statuses[state], quota?.error ? " " + quota.error : "") : null,
        h("div", { className: "kp-caption" }, "额度最后刷新：", date(quota?.fetchedAt) || "尚未刷新", quota?.stale ? " · 缓存数据，建议刷新" : ""));
    }

    function CredentialForm({ provider, entry, act, busy, onDone }) {
      const [label, setLabel] = useState(entry?.label || "");
      const [mode, setMode] = useState(entry ? "keep" : "ref");
      const [credentials, setCredentials] = useState({ ref: "", value: "" });
      const credential = credentials[mode] || "";
      const [error, setError] = useState("");
      const editing = Boolean(entry);
      async function submit(event) {
        event.preventDefault();
        if (busy || (mode !== "keep" && !credential.trim())) return;
        setError("");
        const payload = { action: editing ? "edit" : "add", provider: provider.id, label: label.trim() };
        if (editing) payload.key = entry.id;
        if (mode !== "keep") payload[mode] = credential.trim();
        const result = await act(payload, editing ? "修改已保存" : "Key 已添加");
        if (!result.ok) { if (!result.cancelled) setError(result.error); return; }
        setCredentials({ ref: "", value: "" }); setLabel(""); setMode(editing ? "keep" : "ref");
        onDone?.();
      }
      return h("form", { className: "kp-form kp-stack", onSubmit: submit },
        h("fieldset", { disabled: busy, className: "kp-stack" },
          h("div", { className: "kp-fields" },
            h("label", null, "备注名称", h("input", { value: label, onChange: (event) => setLabel(event.target.value), placeholder: "例如：工作账号", autoComplete: "off" })),
            h("label", null, "凭证方式", h("select", { value: mode, onChange: (event) => setMode(event.target.value) },
              editing ? h("option", { value: "keep" }, "保留现有凭证（仅修改名称）") : null,
              h("option", { value: "ref" }, "引用已存储的 ref（推荐）"), h("option", { value: "value" }, "直接输入密钥")))),
          mode === "keep" ? h("p", { className: "kp-caption" }, "不会读取或显示原始密钥。保存时保留现有凭证。") :
            h("label", null, mode === "ref" ? "凭证引用名（ref）" : "新密钥（value）",
              h("input", { type: mode === "value" ? "password" : "text", value: credential, required: true, autoComplete: "new-password", spellCheck: false, autoCapitalize: "none", onChange: (event) => setCredentials({ ...credentials, [mode]: event.target.value }), placeholder: mode === "ref" ? "OPENCODE_GO_KEY_2" : "输入新密钥；原始密钥不会回显" }),
              h("span", { className: "kp-caption" }, mode === "ref" ? "引用 credentials 文件中的 refs 名；不会把密钥复制到 keys 文件。" : "直接密钥将以明文存入本机 keys 文件（权限 600），不是加密存储。")),
          editing ? h("p", { className: "kp-caption" }, "修改配置来源的 key 会创建本地覆盖。替换生效凭证可能影响上游 prompt cache。") : null,
          h("div", { className: "kp-row" }, h("button", { type: "submit", className: "kp-primary", disabled: busy || (mode !== "keep" && !credential.trim()) }, busy ? "处理中…" : editing ? "保存修改" : "添加 Key"), editing ? button("取消", onDone, busy) : null)),
        error ? h("p", { role: "alert", className: "kp-danger kp-wrap" }, error) : null);
    }

    function KeyCard({ provider, entry, act, busy }) {
      const [editing, setEditing] = useState(false);
      const [confirm, setConfirm] = useState("");
      const active = provider.active === entry.id;
      const status = { ok: "可用", quota: "额度耗尽", invalid: "凭证失效" }[entry.status] || entry.status || "未知状态";
      const action = (name, text) => act({ action: name, provider: provider.id, key: entry.id }, text);
      return h("article", { className: "kp-key kp-stack" + (active ? " kp-key-active" : "") },
        h("div", { className: "kp-row kp-between" },
          h("div", { className: "kp-stack kp-wrap", style: { gap: 3 } },
            h("div", { className: "kp-row" }, h("h4", { className: "kp-wrap" }, entry.label || entry.id), active ? badge("生效中", "kp-accent") : null, badge(status, entry.status === "ok" ? "" : "kp-danger")),
            h("div", { className: "kp-caption kp-wrap" }, entry.id, " · ", entry.inline ? "直接密钥 · 已隐藏" : "ref: " + (entry.ref || "未设置"), " · ", entry.overridesConfig ? "本地覆盖配置" : entry.source === "config" ? "配置来源" : "本地文件")),
          button("刷新官方额度", () => action("refresh-usage", "额度状态已同步；请查看用量与刷新时间"), busy)),
        !entry.configured ? h("p", { className: "kp-danger" }, "凭证未配置或引用为空，无法设为生效。") : null,
        entry.lastError ? h("p", { className: "kp-danger kp-wrap" }, "最近请求错误：" + entry.lastError) : null,
        entry.status !== "ok" && entry.remainingMs > 0 ? h("p", { className: "kp-caption" }, "剩余冷却：" + duration(entry.remainingMs)) : null,
        h(Quota, { quota: entry.quota }),
        h("div", { className: "kp-row kp-between" },
          h("div", { className: "kp-caption" }, "本地请求 ", entry.req ?? 0, " · 成功 ", entry.ok ?? 0, " · 失败 ", entry.fail ?? 0, " · Cache 命中 ", Number.isFinite(entry.cacheRate) ? Math.round(entry.cacheRate * 100) + "%" : "—"),
          h("div", { className: "kp-row" },
            button("编辑", () => { setEditing(!editing); setConfirm(""); }, busy, "kp-primary"),
            button("重置冷却", () => action("reset", "冷却已重置（官方额度不变）"), busy),
            button(active ? "当前生效" : "设为生效", () => { setConfirm("activate"); setEditing(false); }, busy || active || !entry.configured),
            entry.source === "file" ? button(entry.overridesConfig ? "撤销覆盖" : "移除", () => { setConfirm("remove"); setEditing(false); }, busy, "kp-danger") : null)),
        confirm ? h("div", { className: "kp-confirm kp-stack", role: "group", "aria-label": "确认操作" },
          h("p", null, confirm === "activate" ? "切换生效 key 可能使上游 prompt cache 失效。确认切换？" : entry.overridesConfig ? "撤销本地覆盖后，将恢复配置文件中的原始凭证和名称，而不是删除该 key。若正在使用，可能影响 prompt cache。确认恢复？" : "将从本地 keys 文件中移除此 key；若正在使用，将改选其他 key，可能影响 prompt cache。确认移除？"),
          h("div", { className: "kp-row" }, button("确认" + (confirm === "activate" ? "切换" : entry.overridesConfig ? "恢复配置" : "移除"), async () => { const result = await action(confirm, "操作已完成"); if (result.ok) setConfirm(""); }, busy, confirm === "remove" ? "kp-danger" : "kp-primary"), button("取消", () => setConfirm(""), busy))) : null,
        editing ? h(CredentialForm, { provider, entry, act, busy, onDone: () => setEditing(false) }) : null);
    }

    function KeyPoolSection() {
      const [data, setData] = useState(null);
      const [error, setError] = useState("");
      const [notice, setNotice] = useState("");
      const [busy, setBusy] = useState(false);
      const lifecycle = useRef(0);
      const mutation = useRef(false);
      const version = useRef(0);
      const pollController = useRef(null);
      const actionController = useRef(null);

      useEffect(() => {
        const life = ++lifecycle.current;
        let timer;
        async function poll() {
          if (lifecycle.current !== life) return;
          if (!mutation.current) {
            const revision = version.current;
            const controller = new AbortController();
            pollController.current = controller;
            try {
              const response = await fetch("/opencode-pool/status", { headers: { accept: "application/json" }, signal: controller.signal });
              const body = await response.json();
              if (!response.ok || !body.ok || !body.snapshot) throw new Error(body.error || "读取状态失败");
              if (lifecycle.current === life && revision === version.current && !mutation.current) { setData(body.snapshot); setError(""); }
            } catch (err) {
              if (!controller.signal.aborted && lifecycle.current === life && revision === version.current) setError(message(err));
            } finally { if (pollController.current === controller) pollController.current = null; }
          }
          if (lifecycle.current === life) timer = setTimeout(poll, POLL_MS);
        }
        poll();
        return () => { ++lifecycle.current; clearTimeout(timer); pollController.current?.abort(); actionController.current?.abort(); mutation.current = false; };
      }, []);

      const act = useCallback(async (payload, success) => {
        if (mutation.current) return { ok: false, error: "请等待当前操作完成。" };
        const life = lifecycle.current;
        mutation.current = true;
        ++version.current;
        pollController.current?.abort();
        const controller = new AbortController();
        actionController.current = controller;
        setBusy(true); setNotice("");
        try {
          const response = await fetch("/opencode-pool/action", { method: "POST", headers: { "content-type": "application/json", "x-keypool-request": "1" }, body: JSON.stringify(payload), signal: controller.signal });
          const body = await response.json();
          if (lifecycle.current !== life) return { ok: false, cancelled: true };
          if (!response.ok || !body.ok || !body.snapshot) throw new Error(body.error || "操作失败");
          setData(body.snapshot); setError(""); setNotice(success);
          return { ok: true };
        } catch (err) {
          if (lifecycle.current !== life || controller.signal.aborted) return { ok: false, cancelled: true };
          const detail = message(err);
          setNotice("操作失败：" + detail);
          return { ok: false, error: detail };
        } finally {
          if (lifecycle.current === life) { mutation.current = false; actionController.current = null; setBusy(false); }
        }
      }, []);

      return h("section", { className: "kp", "aria-label": "Key 池", "aria-busy": busy },
        h("style", null, css),
        h("div", { className: "kp-stack", style: { gap: 6 } },
          h("div", { className: "kp-row kp-between" }, h("h2", null, "Key 池"), badge("自动同步 · 5 秒", "kp-muted")),
          h("p", { className: "kp-muted" }, "管理凭证与官方额度，让同一路由保持使用同一把 key。"),
          h("p", { className: "kp-caption" }, "仅在额度耗尽或凭证失效时自动切换，以保留上游 prompt cache。OpenCode Go 官方额度窗口：5 小时 / 周 / 月。本地请求统计不代表官方额度。")),
        error ? h("div", { className: "kp-message kp-danger", role: "alert" }, "状态同步失败：" + error, data ? "。正在显示上次状态，将自动重试。" : "。将自动重试。") : null,
        notice ? h("div", { className: "kp-message", role: "status", "aria-live": "polite" }, notice) : null,
        !data ? h("p", { className: "kp-message kp-muted", role: "status" }, error ? "等待重新连接…" : "正在读取 Key 池…") : null,
        data && !data.providers?.length ? h("div", { className: "kp-message" }, "暂无可管理的 provider。请先在插件配置中添加 provider。") : null,
        ...(data?.providers || []).map((provider) => h("section", { key: provider.id, className: "kp-provider", "aria-label": provider.id },
          h("header", { className: "kp-provider-head kp-row kp-between" },
            h("div", { className: "kp-wrap" }, h("h3", null, provider.id), h("p", { className: "kp-caption kp-wrap" }, "凭证槽位：" + (provider.credentialRef || "—"))),
            h("div", { className: "kp-row" }, badge((provider.keys || []).length + " 个 Key"), badge(provider.active ? "生效：" + provider.active : "尚无生效 Key", provider.active ? "kp-accent kp-wrap" : "kp-muted"))),
          ...(provider.keys || []).map((entry) => h(KeyCard, { key: entry.id, provider, entry, act, busy })),
          !provider.keys?.length ? h("p", { className: "kp-key kp-muted" }, "还没有 Key。添加一个凭证即可开始。") : null,
          h("details", { className: "kp-add" }, h("summary", null, "添加 Key"), h(CredentialForm, { provider, act, busy })))),
        data ? h("footer", { className: "kp-footer kp-caption" }, h("div", null, "状态每 5 秒同步；官方额度最多每分钟更新，刷新按钮也遵循此限制。同一账号 / 工作区的多个 Key 可能共享额度，并非每把 Key 都有独立额度。"), h("details", null, h("summary", null, "本地存储位置"), h("div", null, "状态：" + (data.stateFile || "—")), h("div", null, "凭证：" + (data.keysFile || "—")))) : null);
    }

    function apply(ctx) {
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register({ name: "settings.section", id: "opencode-pool", order: 30, label: () => "Key 池", inject: () => ({}) }, KeyPoolSection),
      );
    }
    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
