import { useEffect, useMemo, useState } from "react";
import type { ApiError } from "../api/client";
import {
  toolConfigGetCapabilities,
  toolConfigGetWebSearch,
  toolConfigTestWebSearch,
  toolConfigUpdateCapabilities,
  toolConfigUpdateWebSearch,
  type CapabilitiesEffectiveDto,
  type CapabilitiesRegistryDto,
  type CapabilitiesStoredDto,
  type CapabilitiesToolDto,
  type CapabilitiesSkillDto,
  type WebSearchConfigEffectiveDto,
  type WebSearchConfigStoredDto,
} from "../api/gateway";

function normalizeDomainsText(text: string) {
  const t = String(text ?? "");
  return t
    .split(/[\n,]+/g)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 200);
}

function domainsToText(domains: string[]) {
  return (domains ?? []).map((x) => String(x ?? "").trim()).filter(Boolean).join("\n");
}

export function ToolsPage() {
  const [tab, setTab] = useState<"web" | "tools" | "skills">("web");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [capsRegistry, setCapsRegistry] = useState<CapabilitiesRegistryDto | null>(null);
  const [capsStored, setCapsStored] = useState<CapabilitiesStoredDto | null>(null);
  const [capsEffective, setCapsEffective] = useState<CapabilitiesEffectiveDto | null>(null);
  const [capsQuery, setCapsQuery] = useState("");
  const [capsSaving, setCapsSaving] = useState(false);
  const [drawerTool, setDrawerTool] = useState<CapabilitiesToolDto | null>(null);
  const [drawerSkill, setDrawerSkill] = useState<CapabilitiesSkillDto | null>(null);

  const [stored, setStored] = useState<WebSearchConfigStoredDto | null>(null);
  const [effective, setEffective] = useState<WebSearchConfigEffectiveDto | null>(null);

  const [isEnabled, setIsEnabled] = useState(true);
  const [endpoint, setEndpoint] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [allowDomainsText, setAllowDomainsText] = useState("");
  const [denyDomainsText, setDenyDomainsText] = useState("");
  const [fetchUa, setFetchUa] = useState("");

  const [testQuery, setTestQuery] = useState("杭州 天气");
  const [testing, setTesting] = useState(false);

  const refresh = async () => {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const [web, caps] = await Promise.all([toolConfigGetWebSearch(), toolConfigGetCapabilities()]);
      setStored(web.stored);
      setEffective(web.effective);
      setIsEnabled(Boolean(web.stored.isEnabled));
      setEndpoint(web.stored.endpoint ?? "");
      setAllowDomainsText(domainsToText(web.stored.allowDomains ?? []));
      setDenyDomainsText(domainsToText(web.stored.denyDomains ?? []));
      setFetchUa(web.stored.fetchUa ?? "");

      setCapsRegistry(caps.registry);
      setCapsStored(caps.stored);
      setCapsEffective(caps.effective);
    } catch (e: any) {
      const err = e as ApiError;
      setError(`加载工具配置失败：${err.code}`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const effectiveSummary = useMemo(() => {
    if (!effective) return null;
    const apiKey = effective.source.apiKey === "stored" ? "Key:已配置（B端）" : effective.source.apiKey === "env" ? "Key:来自 env" : "Key:未配置";
    const endpointSrc =
      effective.source.endpoint === "stored" ? "endpoint:已覆盖" : effective.source.endpoint === "env" ? "endpoint:来自 env" : "endpoint:默认";
    const allowSrc =
      effective.source.allowDomains === "stored" ? "allow:已设置" : effective.source.allowDomains === "env" ? "allow:来自 env" : "allow:未限制";
    const denySrc =
      effective.source.denyDomains === "stored" ? "deny:已设置" : effective.source.denyDomains === "env" ? "deny:来自 env" : "deny:未设置";
    return [apiKey, endpointSrc, allowSrc, denySrc].join(" · ");
  }, [effective]);

  const save = async () => {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await toolConfigUpdateWebSearch({
        isEnabled,
        endpoint: endpoint.trim() ? endpoint.trim() : null,
        ...(apiKeyInput.trim() ? { apiKey: apiKeyInput.trim() } : {}),
        ...(clearApiKey ? { clearApiKey: true } : {}),
        allowDomains: normalizeDomainsText(allowDomainsText),
        denyDomains: normalizeDomainsText(denyDomainsText),
        fetchUa: fetchUa.trim() ? fetchUa.trim() : null,
      });
      setNotice("已保存 Web Search 配置（热生效）");
      setApiKeyInput("");
      setClearApiKey(false);
      await refresh();
    } catch (e: any) {
      const err = e as ApiError;
      setError(`保存失败：${err.code}`);
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setError("");
    setNotice("");
    const q = testQuery.trim();
    if (!q) return setError("请输入测试 query");
    setTesting(true);
    try {
      const res = await toolConfigTestWebSearch({ query: q });
      setNotice(`测试成功：results=${res.resultCount}，latency=${res.latencyMs}ms`);
    } catch (e: any) {
      const err = e as ApiError;
      setError(`测试失败：${err.code}`);
    } finally {
      setTesting(false);
    }
  };

  const lockSet = useMemo(() => new Set((capsEffective?.lockedTools ?? capsStored?.lockedTools ?? []) as string[]), [capsEffective, capsStored]);

  const disabledByMode = useMemo(() => {
    const s = capsStored?.tools?.disabledByMode ?? {};
    return {
      chat: Array.isArray((s as any).chat) ? ((s as any).chat as string[]) : [],
      plan: Array.isArray((s as any).plan) ? ((s as any).plan as string[]) : [],
      agent: Array.isArray((s as any).agent) ? ((s as any).agent as string[]) : [],
    };
  }, [capsStored]);

  const isToolEnabledInMode = (name: string, mode: "chat" | "plan" | "agent") => {
    if (lockSet.has(name)) return true;
    return !(disabledByMode as any)[mode].includes(name);
  };

  const toggleToolMode = (name: string, mode: "chat" | "plan" | "agent", enabled: boolean) => {
    if (!capsStored) return;
    if (lockSet.has(name) && !enabled) return;
    const cur = (capsStored.tools?.disabledByMode ?? {}) as any;
    const arr = Array.isArray(cur[mode]) ? (cur[mode] as string[]) : [];
    const set = new Set(arr);
    if (enabled) set.delete(name);
    else set.add(name);
    const next = { ...cur, [mode]: Array.from(set) };
    setCapsStored({ ...capsStored, tools: { ...(capsStored.tools as any), disabledByMode: next } });
  };

  const isSkillEnabled = (id: string) => {
    const dis = new Set((capsStored?.skills?.disabled ?? []) as string[]);
    return !dis.has(id);
  };

  const toggleSkill = (id: string, enabled: boolean) => {
    if (!capsStored) return;
    const arr = Array.isArray(capsStored.skills?.disabled) ? (capsStored.skills.disabled as string[]) : [];
    const set = new Set(arr);
    if (enabled) set.delete(id);
    else set.add(id);
    setCapsStored({ ...capsStored, skills: { ...(capsStored.skills as any), disabled: Array.from(set) } });
  };

  const saveCapabilities = async () => {
    if (!capsStored) return;
    setError("");
    setNotice("");
    setCapsSaving(true);
    try {
      await toolConfigUpdateCapabilities({
        tools: { disabledByMode: capsStored.tools?.disabledByMode ?? {} },
        skills: { disabled: capsStored.skills?.disabled ?? [] },
      });
      setNotice("已保存 Tools/Skills 配置（热生效）");
      await refresh();
    } catch (e: any) {
      const err = e as ApiError;
      setError(`保存失败：${err.code}`);
    } finally {
      setCapsSaving(false);
    }
  };

  const toolsFiltered = useMemo(() => {
    const list = capsRegistry?.tools ?? [];
    const kw = capsQuery.trim().toLowerCase();
    if (!kw) return list;
    return list.filter((t) => String(t.name).toLowerCase().includes(kw) || String(t.module).toLowerCase().includes(kw) || String(t.description).toLowerCase().includes(kw));
  }, [capsRegistry, capsQuery]);

  const toolsGrouped = useMemo(() => {
    const map = new Map<string, CapabilitiesToolDto[]>();
    for (const t of toolsFiltered) {
      const k = t.module || "misc";
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(t);
    }
    const keys = Array.from(map.keys()).sort();
    return keys.map((k) => ({ module: k, tools: (map.get(k) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)) }));
  }, [toolsFiltered]);

  const skillsFiltered = useMemo(() => {
    const list = capsRegistry?.skills ?? [];
    const kw = capsQuery.trim().toLowerCase();
    if (!kw) return list;
    return list.filter((s) => String(s.id).toLowerCase().includes(kw) || String(s.name).toLowerCase().includes(kw) || String(s.stageKey).toLowerCase().includes(kw));
  }, [capsRegistry, capsQuery]);

  return (
    <div className="usersPage">
      <div className="pageHeader">
        <div className="pageTitle">工具配置</div>
        <div className="pageActions">
          <div className="row" style={{ gap: 6 }}>
            <button className="btn" type="button" onClick={() => setTab("web")} disabled={tab === "web"}>
              Web Search
            </button>
            <button className="btn" type="button" onClick={() => setTab("tools")} disabled={tab === "tools"}>
              Tools
            </button>
            <button className="btn" type="button" onClick={() => setTab("skills")} disabled={tab === "skills"}>
              Skills
            </button>
          </div>
          <button className="btn" type="button" onClick={() => void refresh()} disabled={busy}>
            刷新
          </button>
          {tab === "web" ? (
            <button className="btn primary" type="button" onClick={() => void save()} disabled={busy}>
              保存
            </button>
          ) : (
            <button className="btn primary" type="button" onClick={() => void saveCapabilities()} disabled={busy || capsSaving || !capsStored}>
              {capsSaving ? "保存中…" : "保存"}
            </button>
          )}
        </div>
      </div>

      {notice ? <div className="hint">{notice}</div> : null}
      {error ? <div className="error">{error}</div> : null}

      {tab !== "web" ? (
        <div className="tableWrap" style={{ padding: 14, marginBottom: 14 }}>
          <div className="row" style={{ gap: 8, marginBottom: 10 }}>
            <input className="input" placeholder="搜索（name/module/desc/skillId/stageKey）" value={capsQuery} onChange={(e) => setCapsQuery(e.target.value)} style={{ flex: 1 }} />
            <span className="tag">locked {lockSet.size}</span>
            <span className="tag">tools {capsRegistry?.tools?.length ?? 0}</span>
            <span className="tag">skills {capsRegistry?.skills?.length ?? 0}</span>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            说明：这里是“能力目录（Tools/Skills）”的 enable/disable（热生效）。锁定工具（LOCKED）不可禁用。
          </div>
        </div>
      ) : null}

      {tab === "tools" ? (
        <div className="tableWrap" style={{ padding: 14, marginBottom: 14 }}>
          {toolsGrouped.map((g) => (
            <div key={g.module} style={{ marginBottom: 14 }}>
              <div style={{ fontWeight: 900, marginBottom: 8 }}>
                {g.module} <span className="muted">({g.tools.length})</span>
              </div>
              <div className="modelList">
                {g.tools.map((t) => {
                  const locked = lockSet.has(t.name);
                  const chatOk = isToolEnabledInMode(t.name, "chat");
                  const planOk = isToolEnabledInMode(t.name, "plan");
                  const agentOk = isToolEnabledInMode(t.name, "agent");
                  return (
                    <div key={t.name} className="modelCard" style={{ cursor: "pointer" }} onClick={() => setDrawerTool(t)} role="presentation">
                      <div className="modelCardTop">
                        <div className="modelCardTitle">
                          <div className="modelName">{t.name}</div>
                          {locked ? <span className="tag tagPurple">LOCKED</span> : null}
                          <span className={`tag ${chatOk ? "tagGreen" : "tagRed"}`}>chat</span>
                          <span className={`tag ${planOk ? "tagGreen" : "tagRed"}`}>plan</span>
                          <span className={`tag ${agentOk ? "tagGreen" : "tagRed"}`}>agent</span>
                        </div>
                      </div>
                      <div className="muted" style={{ fontSize: 12, lineHeight: 1.4 }}>
                        {String(t.description ?? "").slice(0, 120)}
                        {String(t.description ?? "").length > 120 ? "…" : ""}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {tab === "skills" ? (
        <div className="tableWrap" style={{ padding: 14, marginBottom: 14 }}>
          <div className="modelList">
            {skillsFiltered.map((s) => {
              const enabled = isSkillEnabled(s.id);
              return (
                <div key={s.id} className="modelCard" style={{ cursor: "pointer" }} onClick={() => setDrawerSkill(s)} role="presentation">
                  <div className="modelCardTop">
                    <div className="modelCardTitle">
                      <div className="modelName">{s.name}</div>
                      <span className="tag">{s.id}</span>
                      <span className="tag">{s.stageKey}</span>
                      <span className={`tag ${enabled ? "tagGreen" : "tagRed"}`}>{enabled ? "enabled" : "disabled"}</span>
                    </div>
                  </div>
                  <div className="muted" style={{ fontSize: 12, lineHeight: 1.4 }}>
                    {String(s.description ?? "").slice(0, 140)}
                    {String(s.description ?? "").length > 140 ? "…" : ""}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {tab === "web" ? (
        <div className="tableWrap" style={{ padding: 14, marginBottom: 14 }}>
          <div className="modelCard" style={{ marginBottom: 0 }}>
            <div className="modelCardTop">
              <div className="modelCardTitle">
                <div className="modelName">Web Search（博查）</div>
                <span className={`tag ${isEnabled ? "tagGreen" : "tagRed"}`}>{isEnabled ? "enabled" : "disabled"}</span>
                {stored?.hasApiKey ? <span className="tag tagGreen">{stored.apiKeyMasked || "Key ****"}</span> : <span className="tag tagRed">无 Key</span>}
                {effectiveSummary ? <span className="tag">{effectiveSummary}</span> : null}
              </div>
            </div>

            <div className="modelFieldsGrid" style={{ gridTemplateColumns: "repeat(2, minmax(240px, 1fr))" }}>
              <label className="field">
                <div className="label">启用</div>
                <label className="toggleSm">
                  <input type="checkbox" checked={isEnabled} onChange={(e) => setIsEnabled(e.target.checked)} /> Web Search
                </label>
                <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  关闭后：web.search / web.fetch 会被拒绝（Chat/Agent 都不再可用）。
                </div>
              </label>

              <label className="field">
                <div className="label">Endpoint（可选覆盖）</div>
                <input className="input" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://api.bochaai.com/v1/web-search" />
                <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  留空表示使用 env 或默认值。
                </div>
              </label>

              <label className="field">
                <div className="label">BOCHA API Key（留空=不改）</div>
                <input className="input" type="password" value={apiKeyInput} onChange={(e) => setApiKeyInput(e.target.value)} placeholder="sk-..." />
                <label className="muted" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 12 }}>
                  <input type="checkbox" checked={clearApiKey} onChange={(e) => setClearApiKey(e.target.checked)} />
                  清空 Key（会回退到 env；若 env 也没配则无法联网）
                </label>
              </label>

              <label className="field">
                <div className="label">抓取 UA（可选）</div>
                <input className="input" value={fetchUa} onChange={(e) => setFetchUa(e.target.value)} placeholder="Mozilla/5.0 ..." />
              </label>

              <label className="field spanAll">
                <div className="label">域名 allowlist（可选；换行/逗号分隔）</div>
                <textarea className="input" style={{ minHeight: 110, resize: "vertical" }} value={allowDomainsText} onChange={(e) => setAllowDomainsText(e.target.value)} placeholder="example.com\n*.wikipedia.org" />
                <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  非空时：只允许匹配域名（支持 <code>example.com</code> / <code>*.example.com</code>）。
                </div>
              </label>

              <label className="field spanAll">
                <div className="label">域名 denylist（优先生效；换行/逗号分隔）</div>
                <textarea className="input" style={{ minHeight: 110, resize: "vertical" }} value={denyDomainsText} onChange={(e) => setDenyDomainsText(e.target.value)} placeholder="*.weibo.com" />
              </label>

              <div className="field spanAll">
                <div className="label">连通性测试</div>
                <div className="row" style={{ gap: 8 }}>
                  <input className="input" value={testQuery} onChange={(e) => setTestQuery(e.target.value)} style={{ flex: 1 }} />
                  <button className="btn" type="button" onClick={() => void test()} disabled={testing || busy}>
                    {testing ? "测试中…" : "测试"}
                  </button>
                </div>
                <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  该测试会实际请求博查一次（count=3，freshness=oneWeek）。
                </div>
              </div>
            </div>

            {effective ? (
              <div className="modelTest">
                <div>
                  <span className="modelTestOk">Effective</span> · provider={effective.provider} · endpoint={effective.endpoint}
                </div>
                <div className="muted">
                  allow={effective.allowDomains.length} · deny={effective.denyDomains.length} · ua={effective.fetchUa ? "set" : "default"}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {drawerTool ? (
        <div className="drawerMask" onClick={() => setDrawerTool(null)} role="presentation">
          <div className="drawer" onClick={(e) => e.stopPropagation()} role="presentation">
            <div className="drawerHeader">
              <div style={{ fontWeight: 900 }}>{drawerTool.name}</div>
              <button className="btn" type="button" onClick={() => setDrawerTool(null)}>
                关闭
              </button>
            </div>

            <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
              module={drawerTool.module} {lockSet.has(drawerTool.name) ? "· LOCKED（不可禁用）" : ""}
            </div>

            <div style={{ display: "grid", gap: 10 }}>
              <div>
                <div style={{ fontWeight: 800, marginBottom: 6 }}>启用（按 mode）</div>
                <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                  {(["chat", "plan", "agent"] as const).map((m) => {
                    const enabled = isToolEnabledInMode(drawerTool.name, m);
                    const locked = lockSet.has(drawerTool.name);
                    return (
                      <label key={m} className="toggleSm">
                        <input
                          type="checkbox"
                          checked={enabled}
                          disabled={locked}
                          onChange={(e) => toggleToolMode(drawerTool.name, m, e.target.checked)}
                        />{" "}
                        {m}
                      </label>
                    );
                  })}
                </div>
              </div>

              <div>
                <div style={{ fontWeight: 800, marginBottom: 6 }}>说明</div>
                <div className="muted" style={{ whiteSpace: "pre-wrap" }}>{drawerTool.description}</div>
              </div>

              <div>
                <div style={{ fontWeight: 800, marginBottom: 6 }}>参数</div>
                <pre className="codeBlock">{JSON.stringify(drawerTool.args ?? [], null, 2)}</pre>
              </div>

              <div>
                <div style={{ fontWeight: 800, marginBottom: 6 }}>inputSchema（只读）</div>
                <pre className="codeBlock">{JSON.stringify(drawerTool.inputSchema ?? null, null, 2)}</pre>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {drawerSkill ? (
        <div className="drawerMask" onClick={() => setDrawerSkill(null)} role="presentation">
          <div className="drawer" onClick={(e) => e.stopPropagation()} role="presentation">
            <div className="drawerHeader">
              <div style={{ fontWeight: 900 }}>{drawerSkill.name}</div>
              <button className="btn" type="button" onClick={() => setDrawerSkill(null)}>
                关闭
              </button>
            </div>

            <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
              id={drawerSkill.id} · stage={drawerSkill.stageKey}
            </div>

            <div style={{ display: "grid", gap: 10 }}>
              <div>
                <div style={{ fontWeight: 800, marginBottom: 6 }}>启用</div>
                <label className="toggleSm">
                  <input type="checkbox" checked={isSkillEnabled(drawerSkill.id)} onChange={(e) => toggleSkill(drawerSkill.id, e.target.checked)} /> enabled
                </label>
              </div>
              <div>
                <div style={{ fontWeight: 800, marginBottom: 6 }}>说明</div>
                <div className="muted" style={{ whiteSpace: "pre-wrap" }}>{drawerSkill.description}</div>
              </div>
              <div>
                <div style={{ fontWeight: 800, marginBottom: 6 }}>triggers</div>
                <pre className="codeBlock">{JSON.stringify(drawerSkill.triggers ?? [], null, 2)}</pre>
              </div>
              <div>
                <div style={{ fontWeight: 800, marginBottom: 6 }}>toolCaps</div>
                <pre className="codeBlock">{JSON.stringify(drawerSkill.toolCaps ?? null, null, 2)}</pre>
              </div>
              <div>
                <div style={{ fontWeight: 800, marginBottom: 6 }}>policies</div>
                <pre className="codeBlock">{JSON.stringify(drawerSkill.policies ?? [], null, 2)}</pre>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}


