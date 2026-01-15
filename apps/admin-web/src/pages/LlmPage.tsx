import { useEffect, useMemo, useState } from "react";
import type { ApiError } from "../api/client";
import { adminGetLlmConfig, adminUpdateLlmConfig, type AdminLlmConfigStored, type AdminLlmConfigEffective } from "../api/gateway";

function csvToList(s: string) {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

export function LlmPage() {
  const [stored, setStored] = useState<AdminLlmConfigStored | null>(null);
  const [effective, setEffective] = useState<AdminLlmConfigEffective | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [llmBaseUrl, setLlmBaseUrl] = useState("");
  const [llmDefaultModel, setLlmDefaultModel] = useState("");
  const [llmModelsCsv, setLlmModelsCsv] = useState("");
  const [llmApiKey, setLlmApiKey] = useState("");

  const [embBaseUrl, setEmbBaseUrl] = useState("");
  const [embDefaultModel, setEmbDefaultModel] = useState("");
  const [embModelsCsv, setEmbModelsCsv] = useState("");
  const [embApiKey, setEmbApiKey] = useState("");

  const [cardBaseUrl, setCardBaseUrl] = useState("");
  const [cardDefaultModel, setCardDefaultModel] = useState("");
  const [cardApiKey, setCardApiKey] = useState("");

  const [linterBaseUrl, setLinterBaseUrl] = useState("");
  const [linterDefaultModel, setLinterDefaultModel] = useState("");
  const [linterTimeoutMs, setLinterTimeoutMs] = useState("60000");
  const [linterApiKey, setLinterApiKey] = useState("");

  const [pricingJson, setPricingJson] = useState("{}");

  const refresh = async () => {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const res = await adminGetLlmConfig();
      setStored(res.stored);
      setEffective(res.effective);

      // 预填：优先 stored（因为这是“你改过的”）；没有则 fallback effective
      setLlmBaseUrl(res.stored.llm.baseUrl || res.effective.llm.baseUrl || "");
      setLlmDefaultModel(res.stored.llm.defaultModel || res.effective.llm.defaultModel || "");
      setLlmModelsCsv((res.stored.llm.models?.length ? res.stored.llm.models : res.effective.llm.models).join(", "));

      setEmbBaseUrl(res.stored.embeddings.baseUrl || res.effective.embeddings.baseUrl || "");
      setEmbDefaultModel(res.stored.embeddings.defaultModel || res.effective.embeddings.defaultModel || "");
      setEmbModelsCsv((res.stored.embeddings.models?.length ? res.stored.embeddings.models : res.effective.embeddings.models).join(", "));

      setCardBaseUrl(res.stored.card.baseUrl || "");
      setCardDefaultModel(res.stored.card.defaultModel || "");

      setLinterBaseUrl(res.stored.linter.baseUrl || res.effective.linter.baseUrl || "");
      setLinterDefaultModel(res.stored.linter.defaultModel || res.effective.linter.defaultModel || "");
      setLinterTimeoutMs(String(res.stored.linter.timeoutMs || res.effective.linter.timeoutMs || 60000));

      setPricingJson(JSON.stringify(res.stored.pricing ?? {}, null, 2));
      setLlmApiKey("");
      setEmbApiKey("");
      setCardApiKey("");
      setLinterApiKey("");
    } catch (e: any) {
      const err = e as ApiError;
      setError(`加载 LLM 配置失败：${err.code}`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const parsedPricing = useMemo(() => {
    try {
      const j = JSON.parse(pricingJson);
      if (!j || typeof j !== "object") return { ok: false as const, error: "pricing 必须是 JSON 对象" };
      return { ok: true as const, value: j as Record<string, any> };
    } catch {
      return { ok: false as const, error: "pricing JSON 解析失败" };
    }
  }, [pricingJson]);

  const save = async () => {
    setError("");
    setNotice("");
    if (!parsedPricing.ok) {
      setError(`保存失败：${parsedPricing.error}`);
      return;
    }

    const timeoutMs = Number(linterTimeoutMs);
    if (linterTimeoutMs.trim() && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      setError("linter timeoutMs 必须是正整数");
      return;
    }

    setBusy(true);
    try {
      await adminUpdateLlmConfig({
        llm: {
          baseUrl: llmBaseUrl.trim() || undefined,
          defaultModel: llmDefaultModel.trim() || undefined,
          models: csvToList(llmModelsCsv),
          ...(llmApiKey.trim() ? { apiKey: llmApiKey.trim() } : {}),
        },
        embeddings: {
          baseUrl: embBaseUrl.trim() || undefined,
          defaultModel: embDefaultModel.trim() || undefined,
          models: csvToList(embModelsCsv),
          ...(embApiKey.trim() ? { apiKey: embApiKey.trim() } : {}),
        },
        card: {
          baseUrl: cardBaseUrl.trim() || undefined,
          defaultModel: cardDefaultModel.trim() || undefined,
          ...(cardApiKey.trim() ? { apiKey: cardApiKey.trim() } : {}),
        },
        linter: {
          baseUrl: linterBaseUrl.trim() || undefined,
          defaultModel: linterDefaultModel.trim() || undefined,
          ...(linterApiKey.trim() ? { apiKey: linterApiKey.trim() } : {}),
          ...(linterTimeoutMs.trim() ? { timeoutMs: Math.floor(timeoutMs) } : {}),
        },
        pricing: parsedPricing.value,
      });
      setNotice("已保存（热生效）");
      await refresh();
    } catch (e: any) {
      const err = e as ApiError;
      setError(`保存失败：${err.code}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="llmPage">
      <div className="pageHeader">
        <div className="pageTitle">LLM 管理（热生效）</div>
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
        <div style={{ fontWeight: 900, marginBottom: 8 }}>当前生效配置（运行中）</div>
        {!effective ? (
          <div className="muted">加载中…</div>
        ) : (
          <div className="muted" style={{ fontSize: 13 }}>
            <div>
              <b>LLM</b>：{effective.llm.baseUrl} · default={effective.llm.defaultModel} · models={effective.llm.models.join(", ")}
            </div>
            <div>
              <b>Embeddings</b>：{effective.embeddings.baseUrl} · default={effective.embeddings.defaultModel} · models=
              {effective.embeddings.models.join(", ")}
            </div>
            <div>
              <b>Linter</b>：{effective.linter.baseUrl} · default={effective.linter.defaultModel} · timeoutMs={effective.linter.timeoutMs}
            </div>
          </div>
        )}
      </div>

      <div className="tableWrap" style={{ padding: 14 }}>
        <div style={{ fontWeight: 900, marginBottom: 10 }}>更新配置（会落到 data/db.json）</div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>LLM（聊天/Agent）</div>
            <label className="field">
              <div className="label">Base URL</div>
              <input className="input" value={llmBaseUrl} onChange={(e) => setLlmBaseUrl(e.target.value)} placeholder="http://..." />
            </label>
            <label className="field">
              <div className="label">Models（逗号分隔）</div>
              <input className="input" value={llmModelsCsv} onChange={(e) => setLlmModelsCsv(e.target.value)} placeholder="gpt-5, deepseek-v3.2" />
            </label>
            <label className="field">
              <div className="label">Default Model</div>
              <input className="input" value={llmDefaultModel} onChange={(e) => setLlmDefaultModel(e.target.value)} placeholder="deepseek-v3.2" />
            </label>
            <label className="field">
              <div className="label">API Key（留空=不改）</div>
              <input className="input" type="password" value={llmApiKey} onChange={(e) => setLlmApiKey(e.target.value)} placeholder={stored?.llm.hasApiKey ? stored.llm.apiKeyMasked : ""} />
            </label>
          </div>

          <div>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>Embeddings</div>
            <label className="field">
              <div className="label">Base URL</div>
              <input className="input" value={embBaseUrl} onChange={(e) => setEmbBaseUrl(e.target.value)} placeholder="http://..." />
            </label>
            <label className="field">
              <div className="label">Models（逗号分隔）</div>
              <input className="input" value={embModelsCsv} onChange={(e) => setEmbModelsCsv(e.target.value)} placeholder="text-embedding-3-large, Embedding-V1" />
            </label>
            <label className="field">
              <div className="label">Default Model</div>
              <input className="input" value={embDefaultModel} onChange={(e) => setEmbDefaultModel(e.target.value)} placeholder="text-embedding-3-large" />
            </label>
            <label className="field">
              <div className="label">API Key（留空=不改）</div>
              <input className="input" type="password" value={embApiKey} onChange={(e) => setEmbApiKey(e.target.value)} placeholder={stored?.embeddings.hasApiKey ? stored.embeddings.apiKeyMasked : ""} />
            </label>
          </div>

          <div>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>Card（抽卡）</div>
            <label className="field">
              <div className="label">Base URL（可选）</div>
              <input className="input" value={cardBaseUrl} onChange={(e) => setCardBaseUrl(e.target.value)} placeholder="不填则继承 LLM baseUrl" />
            </label>
            <label className="field">
              <div className="label">Default Model（可选）</div>
              <input className="input" value={cardDefaultModel} onChange={(e) => setCardDefaultModel(e.target.value)} placeholder="不填则继承 LLM defaultModel" />
            </label>
            <label className="field">
              <div className="label">API Key（留空=不改）</div>
              <input className="input" type="password" value={cardApiKey} onChange={(e) => setCardApiKey(e.target.value)} placeholder={stored?.card.hasApiKey ? stored.card.apiKeyMasked : ""} />
            </label>
          </div>

          <div>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>Linter（风格对齐）</div>
            <label className="field">
              <div className="label">Base URL</div>
              <input className="input" value={linterBaseUrl} onChange={(e) => setLinterBaseUrl(e.target.value)} placeholder="http://..." />
            </label>
            <label className="field">
              <div className="label">Default Model</div>
              <input className="input" value={linterDefaultModel} onChange={(e) => setLinterDefaultModel(e.target.value)} placeholder="..." />
            </label>
            <label className="field">
              <div className="label">TimeoutMs</div>
              <input className="input" value={linterTimeoutMs} onChange={(e) => setLinterTimeoutMs(e.target.value)} placeholder="60000" />
            </label>
            <label className="field">
              <div className="label">API Key（留空=不改）</div>
              <input className="input" type="password" value={linterApiKey} onChange={(e) => setLinterApiKey(e.target.value)} placeholder={stored?.linter.hasApiKey ? stored.linter.apiKeyMasked : ""} />
            </label>
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 800, marginBottom: 6 }}>模型单价（元/1,000,000 tokens）→ 用于积分扣费</div>
          <div className="muted" style={{ marginBottom: 8, fontSize: 12 }}>
            对齐「锦李2.0」口径：points = ceil((prompt/1e6*in + completion/1e6*out) * 1000)。pricing JSON 的 key 是 modelId（比如 deepseek-v3.2）。
          </div>
          <textarea
            className="input"
            style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", minHeight: 240 }}
            value={pricingJson}
            onChange={(e) => setPricingJson(e.target.value)}
          />
          {!parsedPricing.ok ? <div className="error">pricing JSON 错误：{parsedPricing.error}</div> : null}
        </div>
      </div>
    </div>
  );
}


