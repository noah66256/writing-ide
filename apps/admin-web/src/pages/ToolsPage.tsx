import { useEffect, useMemo, useState } from "react";
import type { ApiError } from "../api/client";
import { toolConfigGetWebSearch, toolConfigTestWebSearch, toolConfigUpdateWebSearch, type WebSearchConfigEffectiveDto, type WebSearchConfigStoredDto } from "../api/gateway";

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

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
      const res = await toolConfigGetWebSearch();
      setStored(res.stored);
      setEffective(res.effective);
      setIsEnabled(Boolean(res.stored.isEnabled));
      setEndpoint(res.stored.endpoint ?? "");
      setAllowDomainsText(domainsToText(res.stored.allowDomains ?? []));
      setDenyDomainsText(domainsToText(res.stored.denyDomains ?? []));
      setFetchUa(res.stored.fetchUa ?? "");
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

  return (
    <div className="usersPage">
      <div className="pageHeader">
        <div className="pageTitle">工具配置</div>
        <div className="pageActions">
          <button className="btn" type="button" onClick={() => void refresh()} disabled={busy}>
            刷新
          </button>
          <button className="btn primary" type="button" onClick={() => void save()} disabled={busy}>
            保存
          </button>
        </div>
      </div>

      {notice ? <div className="hint">{notice}</div> : null}
      {error ? <div className="error">{error}</div> : null}

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
    </div>
  );
}


