import { useEffect, useMemo, useState } from "react";
import type { ApiError } from "../api/client";
import {
  aiConfigCreateModel,
  aiConfigCreateProvider,
  aiConfigDeleteModel,
  aiConfigDeleteProvider,
  aiConfigDedupeModels,
  aiConfigGetStages,
  aiConfigToolCompat,
  aiConfigTestModel,
  aiConfigUpdateModel,
  aiConfigUpdateProvider,
  aiConfigUpdateStages,
  type AiModelDto,
  type AiProviderDto,
  type AiStageDto,
} from "../api/gateway";

type ModelDraft = AiModelDto & { apiKeyInput?: string; clearApiKey?: boolean };
type ProviderDraft = AiProviderDto & { apiKeyInput?: string; clearApiKey?: boolean };
type StageDraft = Pick<AiStageDto, "stage" | "name" | "description" | "modelId" | "modelIds" | "temperature" | "maxTokens" | "isEnabled">;

type ModelDraftUi = ModelDraft & {
  priceInInput?: string;
  priceOutInput?: string;
};

function endpointLabel(endpoint: string) {
  const e = String(endpoint || "");
  if (/\/embeddings/i.test(e)) return "Embeddings";
  if (/chat\/completions/i.test(e)) return "Chat";
  if (/:streamGenerateContent/i.test(e) || /:generateContent/i.test(e) || /\/v1beta\/models\//i.test(e)) return "Gemini";
  return e || "-";
}

const ENDPOINT_LAST_KEY = "writing-ide.admin.endpointLast.v1";
const ENDPOINT_HISTORY_KEY = "writing-ide.admin.endpointHistory.v1";
const ENDPOINT_HISTORY_MAX = 30;

function safeGetLocalStorage(key: string): string {
  try {
    return String(window.localStorage.getItem(key) ?? "");
  } catch {
    return "";
  }
}

function safeSetLocalStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function normalizeEndpointInput(raw: string): string {
  const t = String(raw ?? "").trim();
  if (!t) return "";
  return t.startsWith("/") ? t : `/${t}`;
}

function loadEndpointHistory(): string[] {
  const raw = safeGetLocalStorage(ENDPOINT_HISTORY_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return Array.from(new Set(arr.map((x) => normalizeEndpointInput(String(x))).filter(Boolean))).slice(0, ENDPOINT_HISTORY_MAX);
  } catch {
    return [];
  }
}

function rememberEndpoint(endpoint: string) {
  const ep = normalizeEndpointInput(endpoint);
  if (!ep) return;
  safeSetLocalStorage(ENDPOINT_LAST_KEY, ep);
  const cur = loadEndpointHistory();
  const next = [ep, ...cur.filter((x) => x !== ep)].slice(0, ENDPOINT_HISTORY_MAX);
  safeSetLocalStorage(ENDPOINT_HISTORY_KEY, JSON.stringify(next));
}

export function LlmPage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [providers, setProviders] = useState<ProviderDraft[]>([]);
  const [models, setModels] = useState<ModelDraftUi[]>([]);
  const [stages, setStages] = useState<StageDraft[]>([]);
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [compatTesting, setCompatTesting] = useState<Record<string, boolean>>({});
  const [bulkTest, setBulkTest] = useState<{ done: number; total: number } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);

  // 创建模型表单
  const [newProviderId, setNewProviderId] = useState("");
  const [newModel, setNewModel] = useState("");
  const [newBaseURL, setNewBaseURL] = useState("");
  const [newEndpoint, setNewEndpoint] = useState(() => safeGetLocalStorage(ENDPOINT_LAST_KEY) || "/v1/chat/completions");
  const [newToolResultFormat, setNewToolResultFormat] = useState<"xml" | "text">("xml");
  const [newApiKey, setNewApiKey] = useState("");
  const [newPriceIn, setNewPriceIn] = useState("");
  const [newPriceOut, setNewPriceOut] = useState("");
  const [newBillingGroup, setNewBillingGroup] = useState("");
  const [newEnabled, setNewEnabled] = useState(true);
  const [newSortOrder, setNewSortOrder] = useState("0");
  const [newDesc, setNewDesc] = useState("");

  // 创建供应商表单
  const [newProvName, setNewProvName] = useState("");
  const [newProvBaseURL, setNewProvBaseURL] = useState("");
  const [newProvApiKey, setNewProvApiKey] = useState("");
  const [newProvEnabled, setNewProvEnabled] = useState(true);
  const [newProvSortOrder, setNewProvSortOrder] = useState("0");
  const [newProvDesc, setNewProvDesc] = useState("");

  const refresh = async () => {
    setError("");
    setBusy(true);
    try {
      const res = await aiConfigGetStages();
      setProviders(
        (res.providers ?? []).map((p) => ({
          ...p,
          apiKeyInput: "",
          clearApiKey: false,
        })),
      );
      setStages(
        (res.stages ?? []).map((s) => ({
          stage: s.stage,
          name: s.name,
          description: s.description,
          modelId: s.modelId,
          modelIds: s.modelIds ?? null,
          temperature: s.temperature,
          maxTokens: s.maxTokens,
          isEnabled: s.isEnabled,
        })),
      );
      setModels(
        (res.models ?? []).map((m) => ({
          ...m,
          apiKeyInput: "",
          clearApiKey: false,
          priceInInput: m.priceInCnyPer1M === null ? "" : String(m.priceInCnyPer1M),
          priceOutInput: m.priceOutCnyPer1M === null ? "" : String(m.priceOutCnyPer1M),
        })),
      );
    } catch (e: any) {
      const err = e as ApiError;
      setError(`加载 AI 配置失败：${err.code}`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    const ep = normalizeEndpointInput(newEndpoint);
    if (ep) safeSetLocalStorage(ENDPOINT_LAST_KEY, ep);
  }, [newEndpoint]);

  const modelOptions = useMemo(() => {
    const arr = models.slice();
    arr.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.model.localeCompare(b.model));
    return arr;
  }, [models]);

  const endpointSuggestions = useMemo(() => {
    const defaults = [
      "/v1/chat/completions",
      "/v1/embeddings",
      // Gemini（示例）：用户可把 model 名替换成实际的 gemini-xxx
      "/v1beta/models/gemini-3-flash-preview:generateContent",
      "/v1beta/models/gemini-3-flash-preview:streamGenerateContent",
    ];
    const fromModels = models.map((m) => normalizeEndpointInput(m.endpoint)).filter(Boolean);
    const fromHistory = loadEndpointHistory();
    const set = new Set<string>();
    for (const x of [...defaults, ...fromHistory, ...fromModels]) {
      const ep = normalizeEndpointInput(x);
      if (ep) set.add(ep);
    }
    return Array.from(set).slice(0, 80);
  }, [models]);

  const create = async () => {
    setError("");
    setNotice("");
    const priceIn = Number(newPriceIn);
    const priceOut = Number(newPriceOut);
    const sortOrder = Number(newSortOrder);
    const selectedProvider = newProviderId ? providers.find((p) => p.id === newProviderId) || null : null;
    if (!newModel.trim()) return setError("model 不能为空");
    if (!newEndpoint.trim()) return setError("endpoint 不能为空");
    if (selectedProvider) {
      if (!selectedProvider.isEnabled) return setError("所选供应商未启用");
      if (!selectedProvider.hasApiKey) return setError("所选供应商未配置 apiKey");
    } else {
      if (!newBaseURL.trim()) return setError("baseURL 不能为空");
      if (!newApiKey.trim()) return setError("apiKey 不能为空");
    }
    if (!Number.isFinite(priceIn) || priceIn < 0) return setError("输入单价必须是 >=0 的数字（元/1,000,000 tokens）");
    if (!Number.isFinite(priceOut) || priceOut < 0) return setError("输出单价必须是 >=0 的数字（元/1,000,000 tokens）");
    if (!Number.isFinite(sortOrder) || !Number.isInteger(sortOrder)) return setError("sortOrder 必须是整数");

    setBusy(true);
    try {
      await aiConfigCreateModel({
        model: newModel.trim(),
        ...(selectedProvider ? { providerId: selectedProvider.id } : { baseURL: newBaseURL.trim(), apiKey: newApiKey.trim() }),
        endpoint: normalizeEndpointInput(newEndpoint),
        toolResultFormat: newToolResultFormat,
        priceInCnyPer1M: priceIn,
        priceOutCnyPer1M: priceOut,
        billingGroup: newBillingGroup.trim() || undefined,
        isEnabled: newEnabled,
        sortOrder,
        description: newDesc.trim() || undefined,
      });
      rememberEndpoint(newEndpoint);
      setNotice("模型已创建（热生效）");
      setCreateOpen(false);
      setNewProviderId("");
      setNewModel("");
      setNewBaseURL("");
      setNewToolResultFormat("xml");
      setNewApiKey("");
      setNewPriceIn("");
      setNewPriceOut("");
      setNewBillingGroup("");
      setNewEnabled(true);
      setNewSortOrder("0");
      setNewDesc("");
      await refresh();
    } catch (e: any) {
      const err = e as ApiError;
      setError(`创建失败：${err.code}`);
    } finally {
      setBusy(false);
    }
  };

  const createProvider = async () => {
    setError("");
    setNotice("");
    const sortOrder = Number(newProvSortOrder);
    if (!newProvName.trim()) return setError("供应商名称不能为空");
    if (!newProvBaseURL.trim()) return setError("供应商 baseURL 不能为空");
    if (!newProvApiKey.trim()) return setError("供应商 apiKey 不能为空");
    if (!Number.isFinite(sortOrder) || !Number.isInteger(sortOrder)) return setError("供应商 sortOrder 必须是整数");

    setBusy(true);
    try {
      await aiConfigCreateProvider({
        name: newProvName.trim(),
        baseURL: newProvBaseURL.trim(),
        apiKey: newProvApiKey.trim(),
        isEnabled: newProvEnabled,
        sortOrder,
        description: newProvDesc.trim() ? newProvDesc.trim() : null,
      });
      setNotice("供应商已创建（热生效）");
      setNewProvName("");
      setNewProvBaseURL("");
      setNewProvApiKey("");
      setNewProvEnabled(true);
      setNewProvSortOrder("0");
      setNewProvDesc("");
      await refresh();
    } catch (e: any) {
      const err = e as ApiError;
      setError(`创建供应商失败：${err.code}`);
    } finally {
      setBusy(false);
    }
  };

  const saveProvider = async (p: ProviderDraft) => {
    setError("");
    setNotice("");
    const sortOrder = Number(p.sortOrder);
    if (!p.name.trim()) return setError("供应商名称不能为空");
    if (!p.baseURL.trim()) return setError("供应商 baseURL 不能为空");
    if (!Number.isFinite(sortOrder) || !Number.isInteger(sortOrder)) return setError("供应商 sortOrder 必须是整数");

    setBusy(true);
    try {
      await aiConfigUpdateProvider(p.id, {
        name: p.name.trim(),
        baseURL: p.baseURL.trim(),
        isEnabled: Boolean(p.isEnabled),
        sortOrder,
        description: p.description ?? null,
        ...(p.clearApiKey ? { clearApiKey: true } : {}),
        ...(p.apiKeyInput?.trim() ? { apiKey: p.apiKeyInput.trim() } : {}),
      });
      setNotice(`已保存供应商：${p.name}`);
      await refresh();
    } catch (e: any) {
      const err = e as ApiError;
      setError(`保存供应商失败：${err.code}`);
    } finally {
      setBusy(false);
    }
  };

  const delProvider = async (id: string) => {
    setError("");
    setNotice("");
    if (!confirm("确认删除该供应商？（若有模型引用会拒绝）")) return;
    setBusy(true);
    try {
      await aiConfigDeleteProvider(id);
      setNotice("供应商已删除");
      await refresh();
    } catch (e: any) {
      const err = e as ApiError;
      setError(`删除供应商失败：${err.code}`);
    } finally {
      setBusy(false);
    }
  };

  const saveModel = async (m: ModelDraftUi) => {
    setError("");
    setNotice("");

    const endpoint = normalizeEndpointInput(m.endpoint);
    if (!endpoint) return setError("Endpoint 不能为空");
    const toolResultFormat = m.toolResultFormat === "text" ? "text" : "xml";

    const inStr = typeof m.priceInInput === "string" ? m.priceInInput.trim() : m.priceInCnyPer1M === null ? "" : String(m.priceInCnyPer1M);
    const outStr = typeof m.priceOutInput === "string" ? m.priceOutInput.trim() : m.priceOutCnyPer1M === null ? "" : String(m.priceOutCnyPer1M);

    if (!inStr) return setError("输入单价不能为空（元/1,000,000 tokens）");
    if (!outStr) return setError("输出单价不能为空（元/1,000,000 tokens）");

    const priceIn = Number(inStr);
    const priceOut = Number(outStr);
    if (!Number.isFinite(priceIn) || priceIn < 0) return setError("输入单价无效");
    if (!Number.isFinite(priceOut) || priceOut < 0) return setError("输出单价无效");

    setBusy(true);
    try {
      await aiConfigUpdateModel(m.id, {
        providerId: m.providerId ?? null,
        baseURL: m.baseURL.trim(),
        endpoint,
        toolResultFormat,
        priceInCnyPer1M: priceIn,
        priceOutCnyPer1M: priceOut,
        billingGroup: (m.billingGroup ?? null) ? String(m.billingGroup).trim() : null,
        isEnabled: Boolean(m.isEnabled),
        sortOrder: Number(m.sortOrder),
        description: m.description ?? null,
        ...(m.clearApiKey ? { clearApiKey: true } : {}),
        ...(m.apiKeyInput?.trim() ? { apiKey: m.apiKeyInput.trim() } : {}),
      });
      rememberEndpoint(endpoint);
      setNotice(`已保存：${m.model}`);
      await refresh();
    } catch (e: any) {
      const err = e as ApiError;
      setError(`保存失败：${err.code}`);
    } finally {
      setBusy(false);
    }
  };

  const toolCompat = async (m: ModelDraftUi) => {
    setError("");
    setNotice("");
    setCompatTesting((prev) => ({ ...prev, [m.id]: true }));
    try {
      const res = await aiConfigToolCompat(m.id);
      const xmlOk = Boolean(res.results?.xml?.ok);
      const textOk = Boolean(res.results?.text?.ok);
      const rec = res.recommended;

      const msg =
        `工具适配检测：XML ${xmlOk ? "OK" : "FAIL"} / 文本 ${textOk ? "OK" : "FAIL"}` +
        (rec ? `，建议：${rec === "xml" ? "XML" : "文本"}` : "");
      setNotice(msg);

      const curFmt = m.toolResultFormat === "text" ? "text" : "xml";
      if (rec && rec !== curFmt) {
        const ok = confirm(`检测建议将该模型的 tool_result 格式设置为「${rec === "xml" ? "XML" : "文本"}」。\n是否立即写入并热生效？`);
        if (ok) {
          await aiConfigUpdateModel(m.id, { toolResultFormat: rec });
          setNotice(`已写入 tool_result=${rec}（热生效）`);
          await refresh();
        }
      }
    } catch (e: any) {
      const err = e as ApiError;
      setError(`适配检测失败：${err.code}`);
    } finally {
      setCompatTesting((prev) => ({ ...prev, [m.id]: false }));
    }
  };

  const testOne = async (id: string) => {
    setTesting((prev) => ({ ...prev, [id]: true }));
    try {
      const res = await aiConfigTestModel(id);
      const tr = res.result;
      setModels((prev) =>
        prev.map((x) =>
          x.id === id
            ? {
                ...x,
                testResult: { ok: tr.ok, latencyMs: tr.latencyMs, status: tr.status, error: tr.error, testedAt: tr.testedAt, headers: tr.headers },
              }
            : x,
        ),
      );
    } catch (e: any) {
      const err = e as ApiError;
      const testedAt = new Date().toISOString();
      setModels((prev) =>
        prev.map((x) =>
          x.id === id
            ? {
                ...x,
                testResult: { ok: false, latencyMs: null, status: err.status, error: err.code, testedAt },
              }
            : x,
        ),
      );
    } finally {
      setTesting((prev) => ({ ...prev, [id]: false }));
    }
  };

  const testAll = async () => {
    setError("");
    const ids = models.map((m) => m.id);
    if (!ids.length) return setError("暂无模型可测速");
    if (!confirm(`确认对 ${ids.length} 个模型执行一键测速？\\n- 单个模型超时：20 秒\\n- 会写回并覆盖上次测速结果`)) return;

    setBusy(true);
    setBulkTest({ done: 0, total: ids.length });

    let done = 0;
    const queue = ids.slice();
    const concurrency = Math.max(1, Math.min(3, queue.length));

    const worker = async () => {
      while (queue.length) {
        const id = queue.shift();
        if (!id) return;
        setTesting((prev) => ({ ...prev, [id]: true }));
        try {
          const res = await aiConfigTestModel(id);
          const tr = res.result;
          setModels((prev) =>
            prev.map((x) =>
              x.id === id
                ? {
                    ...x,
                    testResult: { ok: tr.ok, latencyMs: tr.latencyMs, status: tr.status, error: tr.error, testedAt: tr.testedAt, headers: tr.headers },
                  }
                : x,
            ),
          );
        } catch (e: any) {
          const err = e as ApiError;
          const testedAt = new Date().toISOString();
          setModels((prev) =>
            prev.map((x) =>
              x.id === id
                ? {
                    ...x,
                    testResult: { ok: false, latencyMs: null, status: err.status, error: err.code, testedAt },
                  }
                : x,
            ),
          );
        } finally {
          setTesting((prev) => ({ ...prev, [id]: false }));
          done += 1;
          setBulkTest({ done, total: ids.length });
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
    } finally {
      setBulkTest(null);
      setBusy(false);
    }
  };

  const delOne = async (id: string) => {
    setError("");
    setNotice("");
    if (!confirm("确认删除该模型？（若被 stage 引用会拒绝）")) return;
    setBusy(true);
    try {
      await aiConfigDeleteModel(id);
      setNotice("已删除");
      await refresh();
    } catch (e: any) {
      const err = e as ApiError;
      setError(`删除失败：${err.code}`);
    } finally {
      setBusy(false);
    }
  };

  const dedupe = async () => {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await aiConfigDedupeModels();
      setNotice("已执行清理重复");
      await refresh();
    } catch (e: any) {
      const err = e as ApiError;
      setError(`清理失败：${err.code}`);
    } finally {
      setBusy(false);
    }
  };

  const saveStages = async () => {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await aiConfigUpdateStages(
        stages.map((s) => ({
          stage: s.stage,
          modelId: s.modelId ?? null,
          modelIds: s.modelIds ?? null,
          temperature: s.temperature ?? null,
          maxTokens: s.maxTokens ?? null,
          isEnabled: s.isEnabled,
        })),
      );
      setNotice("环节配置已保存（热生效）");
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
        <div className="pageTitle">AI 配置（对齐锦李2.0：模型管理 + stage 路由）</div>
        <div className="pageActions">
          <button className="btn" type="button" onClick={() => void refresh()} disabled={busy}>
            刷新
          </button>
          <button className="btn" type="button" onClick={() => setCreateOpen(true)} disabled={busy}>
            新建模型
          </button>
          <button className="btn" type="button" onClick={() => setProviderOpen(true)} disabled={busy}>
            供应商
          </button>
          <button className="btn" type="button" onClick={() => void testAll()} disabled={busy || models.length === 0}>
            {bulkTest ? `一键测速 ${bulkTest.done}/${bulkTest.total}` : "一键测速"}
          </button>
          <button className="btn" type="button" onClick={() => void dedupe()} disabled={busy}>
            清理重复
          </button>
          <button className="btn primary" type="button" onClick={() => void saveStages()} disabled={busy}>
            保存环节配置
          </button>
        </div>
      </div>

      {notice ? <div className="hint">{notice}</div> : null}
      {error ? <div className="error">{error}</div> : null}

      <datalist id="aiEndpointList">
        {endpointSuggestions.map((ep) => (
          <option key={ep} value={ep} />
        ))}
      </datalist>

      <div className="tableWrap" style={{ padding: 14, marginBottom: 14 }}>
        <div style={{ fontWeight: 900, marginBottom: 10 }}>AI 模型管理</div>
        <div className="modelList">
          {models.map((m) => {
            const isTesting = Boolean(testing[m.id]);
            const isCompat = Boolean(compatTesting[m.id]);
            const kind = endpointLabel(m.endpoint);
            const kindTag = kind === "Embeddings" ? "tagPurple" : "tagBlue";
            const keyTag = m.hasApiKey ? "tagGreen" : "tagRed";
            const keyText = m.hasApiKey ? `Key ${m.apiKeyMasked || "****"}` : "无 Key";
            const trf = m.toolResultFormat === "text" ? "tool:text" : "tool:xml";

            const testTagClass = isTesting ? "" : !m.testResult ? "" : m.testResult.ok ? "tagGreen" : "tagRed";
            const testText = isTesting
              ? "测速中…"
              : !m.testResult
                ? "未测速"
                : m.testResult.ok
                  ? `OK ${m.testResult.latencyMs ?? "-"}ms`
                  : `FAIL ${m.testResult.status ?? "-"}`;

            return (
              <div key={m.id} className="modelCard">
                <div className="modelCardTop">
                  <div className="modelCardTitle">
                    <div className="modelName">{m.model}</div>
                    {m.providerName ? <span className="tag">{m.providerName}</span> : m.providerId ? <span className="tag">{m.providerId}</span> : null}
                    <span className={`tag ${kindTag}`}>{kind}</span>
                    <span className="tag">{trf}</span>
                    <span className={`tag ${keyTag}`}>{keyText}</span>
                    <span className={`tag ${testTagClass}`}>{testText}</span>
                    {m.billingGroup ? <span className="tag">{`group ${m.billingGroup}`}</span> : null}
                  </div>

                  <div className="modelCardActions">
                    <label className="toggleSm">
                      <input
                        type="checkbox"
                        checked={Boolean(m.isEnabled)}
                        onChange={(e) => setModels((prev) => prev.map((x) => (x.id === m.id ? { ...x, isEnabled: e.target.checked } : x)))}
                      />
                      启用
                    </label>
                    <button className="btn primary" type="button" disabled={busy || isTesting} onClick={() => void saveModel(m)}>
                      保存
                    </button>
                    <button className="btn" type="button" disabled={busy || isTesting} onClick={() => void testOne(m.id)}>
                      {isTesting ? "测速中…" : "测速"}
                    </button>
                    <button className="btn" type="button" disabled={busy || isTesting || isCompat} onClick={() => void toolCompat(m)}>
                      {isCompat ? "检测中…" : "适配检测"}
                    </button>
                    <button className="btn" type="button" disabled={busy || isTesting} onClick={() => void delOne(m.id)}>
                      删除
                    </button>
                  </div>
                </div>

                <div className="modelFieldsGrid">
                  <label className="field">
                    <div className="label">供应商</div>
                    <select
                      className="input"
                      value={m.providerId ?? ""}
                      onChange={(e) => {
                        const pid = e.target.value || null;
                        const p = pid ? providers.find((x) => x.id === pid) || null : null;
                        setModels((prev) =>
                          prev.map((x) =>
                            x.id === m.id
                              ? {
                                  ...x,
                                  providerId: pid,
                                  providerName: p?.name ?? null,
                                  providerBaseURL: p?.baseURL ?? null,
                                  baseURL: p?.baseURL ?? x.baseURL,
                                }
                              : x,
                          ),
                        );
                      }}
                    >
                      <option value="">（手动填写）</option>
                      {providers
                        .slice()
                        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name))
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} {p.hasApiKey ? "" : "(无key)"}
                          </option>
                        ))}
                    </select>
                  </label>

                  <label className="field">
                    <div className="label">BaseURL</div>
                    <input
                      className="input"
                      value={m.providerId ? m.providerBaseURL || m.baseURL : m.baseURL}
                      disabled={Boolean(m.providerId)}
                      onChange={(e) =>
                        setModels((prev) =>
                          prev.map((x) => (x.id === m.id ? { ...x, baseURL: e.target.value } : x)),
                        )
                      }
                    />
                  </label>

                  <label className="field">
                    <div className="label">Endpoint</div>
                    <input
                      className="input"
                      list="aiEndpointList"
                      value={m.endpoint}
                      onChange={(e) => setModels((prev) => prev.map((x) => (x.id === m.id ? { ...x, endpoint: e.target.value } : x)))}
                      placeholder="/v1/chat/completions 或 /v1beta/models/...:generateContent"
                    />
                  </label>

                  <label className="field">
                    <div className="label">tool_result 格式（Agent）</div>
                    <select
                      className="input"
                      value={m.toolResultFormat === "text" ? "text" : "xml"}
                      onChange={(e) =>
                        setModels((prev) => prev.map((x) => (x.id === m.id ? { ...x, toolResultFormat: e.target.value === "text" ? "text" : "xml" } : x)))
                      }
                    >
                      <option value="xml">XML（system &lt;tool_result&gt;...CDATA...&lt;/tool_result&gt;）</option>
                      <option value="text">文本（user [tool_result] JSON [/tool_result]）</option>
                    </select>
                  </label>

                  <label className="field">
                    <div className="label">sortOrder</div>
                    <input
                      className="input"
                      value={String(m.sortOrder ?? 0)}
                      onChange={(e) =>
                        setModels((prev) =>
                          prev.map((x) => (x.id === m.id ? { ...x, sortOrder: Number(e.target.value || 0) } : x)),
                        )
                      }
                      placeholder="0"
                    />
                  </label>

                  <label className="field">
                    <div className="label">定价（元/1,000,000 tokens，in / out）</div>
                    <div className="modelDouble">
                      <input
                        className="input"
                        value={(m as any).priceInInput ?? (m.priceInCnyPer1M === null ? "" : String(m.priceInCnyPer1M))}
                        onChange={(e) =>
                          setModels((prev) =>
                            prev.map((x) => (x.id === m.id ? ({ ...x, priceInInput: e.target.value } as any) : x)),
                          )
                        }
                        placeholder="in"
                      />
                      <input
                        className="input"
                        value={(m as any).priceOutInput ?? (m.priceOutCnyPer1M === null ? "" : String(m.priceOutCnyPer1M))}
                        onChange={(e) =>
                          setModels((prev) =>
                            prev.map((x) => (x.id === m.id ? ({ ...x, priceOutInput: e.target.value } as any) : x)),
                          )
                        }
                        placeholder="out"
                      />
                    </div>
                  </label>

                  <label className="field">
                    <div className="label">billingGroup（可选）</div>
                    <input
                      className="input"
                      value={m.billingGroup ?? ""}
                      onChange={(e) => setModels((prev) => prev.map((x) => (x.id === m.id ? { ...x, billingGroup: e.target.value } : x)))}
                      placeholder="thirdparty-A"
                    />
                  </label>

                  <label className="field">
                    <div className="label">apiKey（留空=不改）</div>
                    <input
                      className="input"
                      type="password"
                      value={m.apiKeyInput || ""}
                      onChange={(e) => setModels((prev) => prev.map((x) => (x.id === m.id ? { ...x, apiKeyInput: e.target.value } : x)))}
                      placeholder="sk-..."
                    />
                    <label className="muted" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 12 }}>
                      <input
                        type="checkbox"
                        checked={Boolean(m.clearApiKey)}
                        onChange={(e) => setModels((prev) => prev.map((x) => (x.id === m.id ? { ...x, clearApiKey: e.target.checked } : x)))}
                      />
                      清空 apiKey
                    </label>
                  </label>

                  <label className="field spanAll">
                    <div className="label">description（可选）</div>
                    <input
                      className="input"
                      value={m.description ?? ""}
                      onChange={(e) => setModels((prev) => prev.map((x) => (x.id === m.id ? { ...x, description: e.target.value } : x)))}
                      placeholder="备注/渠道说明"
                    />
                  </label>
                </div>

                <div className="modelTest">
                  {!m.testResult ? (
                    <div className="muted">还未测速</div>
                  ) : (
                    <>
                      <div>
                        <span className={m.testResult.ok ? "modelTestOk" : "modelTestFail"}>{m.testResult.ok ? "OK" : "FAIL"}</span> ·{" "}
                        {m.testResult.latencyMs ?? "-"}ms · {m.testResult.status ?? "-"}
                      </div>
                      {m.testResult.error ? <div>{String(m.testResult.error).slice(0, 180)}</div> : null}
                      {m.testResult.testedAt ? <div>{String(m.testResult.testedAt).slice(0, 19).replace("T", " ")}</div> : null}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="tableWrap">
        <div style={{ padding: 14, borderBottom: "1px solid #e2e8f0", fontWeight: 900 }}>环节（stage）路由配置</div>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 220 }}>Stage</th>
              <th>说明</th>
              <th style={{ width: 260 }}>选择模型</th>
              <th style={{ width: 200 }}>参数</th>
              <th style={{ width: 120 }}>启用</th>
            </tr>
          </thead>
          <tbody>
            {stages.map((s) => {
              const allowMulti = s.stage === "llm.chat" || s.stage === "agent.run";
              const stageEndpointWant = allowMulti ? "Chat" : null;
              const selectableModels = modelOptions.filter((m) => {
                if (!m.isEnabled) return false;
                if (stageEndpointWant === "Chat") return endpointLabel(m.endpoint) !== "Embeddings";
                return true;
              });
              const multiValue = allowMulti
                ? Array.isArray(s.modelIds) && s.modelIds.length
                  ? s.modelIds
                  : s.modelId
                    ? [s.modelId]
                    : []
                : [];

              return (
                <tr key={s.stage}>
                <td style={{ fontWeight: 900 }}>
                  {s.name}
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    {s.stage}
                  </div>
                </td>
                <td className="muted">{s.description}</td>
                <td>
                  {allowMulti ? (
                    <div style={{ display: "grid", gap: 8 }}>
                      <select
                        className="input"
                        value={s.modelId ?? ""}
                        onChange={(e) => {
                          const v = e.target.value || null;
                          setStages((prev) =>
                            prev.map((x) => {
                              if (x.stage !== s.stage) return x;
                              const set = new Set<string>(Array.isArray(x.modelIds) ? x.modelIds : []);
                              if (v) set.add(v);
                              return { ...x, modelId: v, modelIds: set.size ? Array.from(set) : null };
                            }),
                          );
                        }}
                        title="默认模型（Desktop 默认选中）"
                      >
                        <option value="">（不设置）</option>
                        {selectableModels.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.model} {m.hasApiKey ? "" : "(无key)"}
                          </option>
                        ))}
                      </select>

                      <select
                        className="input"
                        multiple
                        size={Math.min(8, Math.max(4, selectableModels.length))}
                        value={multiValue}
                        onChange={(e) => {
                          const picked = Array.from(e.currentTarget.selectedOptions)
                            .map((o) => o.value)
                            .filter(Boolean);
                          setStages((prev) =>
                            prev.map((x) => {
                              if (x.stage !== s.stage) return x;
                              const set = new Set<string>(picked);
                              if (x.modelId) set.add(x.modelId);
                              const arr = Array.from(set).slice(0, 60);
                              return { ...x, modelIds: arr.length ? arr : null };
                            }),
                          );
                        }}
                        title="可选模型（Desktop 选择器列表）"
                      >
                        {selectableModels.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.model} {m.hasApiKey ? "" : "(无key)"}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <select
                      className="input"
                      value={s.modelId ?? ""}
                      onChange={(e) =>
                        setStages((prev) =>
                          prev.map((x) => (x.stage === s.stage ? { ...x, modelId: e.target.value || null } : x)),
                        )
                      }
                    >
                      <option value="">（不设置）</option>
                      {selectableModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.model} {m.hasApiKey ? "" : "(无key)"} {endpointLabel(m.endpoint) === "Embeddings" ? "[Emb]" : ""}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <input
                      className="input"
                      value={s.temperature === null ? "" : String(s.temperature ?? "")}
                      onChange={(e) =>
                        setStages((prev) =>
                          prev.map((x) =>
                            x.stage === s.stage ? { ...x, temperature: e.target.value ? Number(e.target.value) : null } : x,
                          ),
                        )
                      }
                      placeholder="temperature"
                    />
                    <input
                      className="input"
                      value={s.maxTokens === null ? "" : String(s.maxTokens ?? "")}
                      onChange={(e) =>
                        setStages((prev) =>
                          prev.map((x) =>
                            x.stage === s.stage ? { ...x, maxTokens: e.target.value ? Number(e.target.value) : null } : x,
                          ),
                        )
                      }
                      placeholder="maxTokens"
                    />
                  </div>
                </td>
                <td>
                  <label className="muted" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={Boolean(s.isEnabled)}
                      onChange={(e) => setStages((prev) => prev.map((x) => (x.stage === s.stage ? { ...x, isEnabled: e.target.checked } : x)))}
                    />
                    启用
                  </label>
                </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="hint" style={{ marginTop: 14 }}>
        说明：旧版 <code>/api/admin/llm/config</code>（BaseURL/Models JSON）仍保留但已视为过渡。新版本以 <code>/api/ai-config/*</code> 为准，
        key 服务端加密存储，定价挂在模型上，stage 统一路由，保存后秒级热生效。
      </div>

      {createOpen ? (
        <div className="drawerMask" onClick={() => setCreateOpen(false)} role="presentation">
          <div className="drawer" onClick={(e) => e.stopPropagation()} role="presentation">
            <div className="drawerHeader">
              <div style={{ fontWeight: 900 }}>新建模型</div>
              <button className="btn" type="button" onClick={() => setCreateOpen(false)} disabled={busy}>
                关闭
              </button>
            </div>

            <div className="muted" style={{ marginBottom: 12 }}>
              价格必填用于按 token 扣积分；apiKey 服务端加密存储；单个模型测速超时为 20 秒。
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <label className="field">
                <div className="label">model</div>
                <input className="input" value={newModel} onChange={(e) => setNewModel(e.target.value)} placeholder="deepseek-v3.2" />
              </label>
              <label className="field">
                <div className="label">供应商（可选）</div>
                <select
                  className="input"
                  value={newProviderId}
                  onChange={(e) => {
                    const v = e.target.value || "";
                    setNewProviderId(v);
                    const p = v ? providers.find((x) => x.id === v) || null : null;
                    if (p) {
                      setNewBaseURL(p.baseURL);
                      setNewApiKey("");
                    }
                  }}
                >
                  <option value="">（手动填写 baseURL + apiKey）</option>
                  {providers
                    .slice()
                    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name))
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} {p.hasApiKey ? "" : "(无key)"}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                <div className="label">baseURL</div>
                <input
                  className="input"
                  value={newProviderId ? providers.find((p) => p.id === newProviderId)?.baseURL ?? newBaseURL : newBaseURL}
                  onChange={(e) => setNewBaseURL(e.target.value)}
                  placeholder="https://api.openai.com"
                  disabled={Boolean(newProviderId)}
                />
              </label>
              <label className="field">
                <div className="label">endpoint</div>
                <input
                  className="input"
                  list="aiEndpointList"
                  value={newEndpoint}
                  onChange={(e) => setNewEndpoint(e.target.value)}
                  placeholder="/v1/chat/completions 或 /v1beta/models/...:generateContent"
                />
              </label>
              <label className="field">
                <div className="label">tool_result 格式（Agent）</div>
                <select className="input" value={newToolResultFormat} onChange={(e) => setNewToolResultFormat(e.target.value === "text" ? "text" : "xml")}>
                  <option value="xml">XML（默认）</option>
                  <option value="text">文本（兼容部分代理）</option>
                </select>
              </label>
              {newProviderId ? (
                <div className="field">
                  <div className="label">apiKey</div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                    使用供应商 apiKey（服务端加密存储）。如需更换请到「供应商」里修改。
                  </div>
                </div>
              ) : (
                <label className="field">
                  <div className="label">apiKey（服务端加密存储）</div>
                  <input className="input" type="password" value={newApiKey} onChange={(e) => setNewApiKey(e.target.value)} placeholder="sk-..." />
                </label>
              )}
              <label className="field">
                <div className="label">输入单价（元/1,000,000 tokens）</div>
                <input className="input" value={newPriceIn} onChange={(e) => setNewPriceIn(e.target.value)} placeholder="0.8" />
              </label>
              <label className="field">
                <div className="label">输出单价（元/1,000,000 tokens）</div>
                <input className="input" value={newPriceOut} onChange={(e) => setNewPriceOut(e.target.value)} placeholder="1.6" />
              </label>
              <label className="field">
                <div className="label">billingGroup（可选）</div>
                <input className="input" value={newBillingGroup} onChange={(e) => setNewBillingGroup(e.target.value)} placeholder="thirdparty-A" />
              </label>
              <label className="field">
                <div className="label">sortOrder</div>
                <input className="input" value={newSortOrder} onChange={(e) => setNewSortOrder(e.target.value)} />
              </label>
              <label className="field" style={{ gridColumn: "1 / span 2" }}>
                <div className="label">description（可选）</div>
                <input className="input" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="备注/渠道说明" />
              </label>
              <label className="field" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input type="checkbox" checked={newEnabled} onChange={(e) => setNewEnabled(e.target.checked)} />
                <div className="label" style={{ margin: 0 }}>
                  启用
                </div>
              </label>
            </div>

            <div style={{ marginTop: 10, display: "flex", gap: 10 }}>
              <button className="btn primary" type="button" onClick={() => void create()} disabled={busy}>
                创建
              </button>
              <button className="btn" type="button" onClick={() => setCreateOpen(false)} disabled={busy}>
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {providerOpen ? (
        <div className="drawerMask" onClick={() => setProviderOpen(false)} role="presentation">
          <div className="drawer" onClick={(e) => e.stopPropagation()} role="presentation">
            <div className="drawerHeader">
              <div style={{ fontWeight: 900 }}>供应商（Provider）</div>
              <button className="btn" type="button" onClick={() => setProviderOpen(false)} disabled={busy}>
                关闭
              </button>
            </div>

            <div className="muted" style={{ marginBottom: 12 }}>
              供应商保存 baseURL + apiKey（加密存储）。新建模型时可直接选择供应商，避免重复填写。
            </div>

            <div className="tableWrap" style={{ padding: 14, marginBottom: 14 }}>
              <div style={{ fontWeight: 900, marginBottom: 10 }}>新增供应商</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <label className="field">
                  <div className="label">名称</div>
                  <input className="input" value={newProvName} onChange={(e) => setNewProvName(e.target.value)} placeholder="openai / 智谱" />
                </label>
                <label className="field">
                  <div className="label">baseURL</div>
                  <input className="input" value={newProvBaseURL} onChange={(e) => setNewProvBaseURL(e.target.value)} placeholder="https://api.openai.com" />
                </label>
                <label className="field">
                  <div className="label">apiKey（服务端加密存储）</div>
                  <input className="input" type="password" value={newProvApiKey} onChange={(e) => setNewProvApiKey(e.target.value)} placeholder="sk-..." />
                </label>
                <label className="field">
                  <div className="label">sortOrder</div>
                  <input className="input" value={newProvSortOrder} onChange={(e) => setNewProvSortOrder(e.target.value)} placeholder="0" />
                </label>
                <label className="field spanAll">
                  <div className="label">description（可选）</div>
                  <input className="input" value={newProvDesc} onChange={(e) => setNewProvDesc(e.target.value)} placeholder="渠道/备注" />
                </label>
                <label className="field" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <input type="checkbox" checked={newProvEnabled} onChange={(e) => setNewProvEnabled(e.target.checked)} />
                  <div className="label" style={{ margin: 0 }}>
                    启用
                  </div>
                </label>
              </div>
              <div style={{ marginTop: 10 }}>
                <button className="btn primary" type="button" onClick={() => void createProvider()} disabled={busy}>
                  创建供应商
                </button>
              </div>
            </div>

            <div className="tableWrap" style={{ padding: 14 }}>
              <div style={{ fontWeight: 900, marginBottom: 10 }}>供应商列表</div>
              <div className="modelList">
                {providers.map((p) => {
                  const keyTag = p.hasApiKey ? "tagGreen" : "tagRed";
                  const keyText = p.hasApiKey ? `Key ${p.apiKeyMasked || "****"}` : "无 Key";
                  return (
                    <div key={p.id} className="modelCard">
                      <div className="modelCardTop">
                        <div className="modelCardTitle">
                          <div className="modelName">{p.name}</div>
                          <span className={`tag ${keyTag}`}>{keyText}</span>
                        </div>
                        <div className="modelCardActions">
                          <label className="toggleSm">
                            <input
                              type="checkbox"
                              checked={Boolean(p.isEnabled)}
                              onChange={(e) =>
                                setProviders((prev) => prev.map((x) => (x.id === p.id ? { ...x, isEnabled: e.target.checked } : x)))
                              }
                            />
                            启用
                          </label>
                          <button className="btn primary" type="button" disabled={busy} onClick={() => void saveProvider(p)}>
                            保存
                          </button>
                          <button className="btn" type="button" disabled={busy} onClick={() => void delProvider(p.id)}>
                            删除
                          </button>
                        </div>
                      </div>

                      <div className="modelFieldsGrid">
                        <label className="field">
                          <div className="label">名称</div>
                          <input
                            className="input"
                            value={p.name}
                            onChange={(e) => setProviders((prev) => prev.map((x) => (x.id === p.id ? { ...x, name: e.target.value } : x)))}
                          />
                        </label>
                        <label className="field">
                          <div className="label">BaseURL</div>
                          <input
                            className="input"
                            value={p.baseURL}
                            onChange={(e) => setProviders((prev) => prev.map((x) => (x.id === p.id ? { ...x, baseURL: e.target.value } : x)))}
                          />
                        </label>
                        <label className="field">
                          <div className="label">sortOrder</div>
                          <input
                            className="input"
                            value={String(p.sortOrder ?? 0)}
                            onChange={(e) =>
                              setProviders((prev) => prev.map((x) => (x.id === p.id ? { ...x, sortOrder: Number(e.target.value || 0) } : x)))
                            }
                          />
                        </label>
                        <label className="field">
                          <div className="label">apiKey（留空=不改）</div>
                          <input
                            className="input"
                            type="password"
                            value={p.apiKeyInput || ""}
                            onChange={(e) =>
                              setProviders((prev) => prev.map((x) => (x.id === p.id ? { ...x, apiKeyInput: e.target.value } : x)))
                            }
                            placeholder="sk-..."
                          />
                          <label className="muted" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 12 }}>
                            <input
                              type="checkbox"
                              checked={Boolean(p.clearApiKey)}
                              onChange={(e) =>
                                setProviders((prev) => prev.map((x) => (x.id === p.id ? { ...x, clearApiKey: e.target.checked } : x)))
                              }
                            />
                            清空 apiKey
                          </label>
                        </label>
                        <label className="field spanAll">
                          <div className="label">description（可选）</div>
                          <input
                            className="input"
                            value={p.description ?? ""}
                            onChange={(e) => setProviders((prev) => prev.map((x) => (x.id === p.id ? { ...x, description: e.target.value } : x)))}
                          />
                        </label>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
