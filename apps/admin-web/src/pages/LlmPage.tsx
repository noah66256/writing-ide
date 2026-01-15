import { useEffect, useMemo, useState } from "react";
import type { ApiError } from "../api/client";
import {
  aiConfigCreateModel,
  aiConfigDeleteModel,
  aiConfigDedupeModels,
  aiConfigGetStages,
  aiConfigTestModel,
  aiConfigUpdateModel,
  aiConfigUpdateStages,
  type AiModelDto,
  type AiStageDto,
} from "../api/gateway";

type ModelDraft = AiModelDto & { apiKeyInput?: string; clearApiKey?: boolean };
type StageDraft = Pick<AiStageDto, "stage" | "name" | "description" | "modelId" | "temperature" | "maxTokens" | "isEnabled">;

type ModelDraftUi = ModelDraft & {
  priceInInput?: string;
  priceOutInput?: string;
};

function endpointLabel(endpoint: string) {
  const e = String(endpoint || "");
  if (/\/embeddings/i.test(e)) return "Embeddings";
  if (/chat\/completions/i.test(e)) return "Chat";
  return e || "-";
}

export function LlmPage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [models, setModels] = useState<ModelDraftUi[]>([]);
  const [stages, setStages] = useState<StageDraft[]>([]);
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [bulkTest, setBulkTest] = useState<{ done: number; total: number } | null>(null);

  // 创建模型表单
  const [newModel, setNewModel] = useState("");
  const [newBaseURL, setNewBaseURL] = useState("");
  const [newEndpoint, setNewEndpoint] = useState("/v1/chat/completions");
  const [newApiKey, setNewApiKey] = useState("");
  const [newPriceIn, setNewPriceIn] = useState("");
  const [newPriceOut, setNewPriceOut] = useState("");
  const [newBillingGroup, setNewBillingGroup] = useState("");
  const [newEnabled, setNewEnabled] = useState(true);
  const [newSortOrder, setNewSortOrder] = useState("0");
  const [newDesc, setNewDesc] = useState("");

  const refresh = async () => {
    setError("");
    setBusy(true);
    try {
      const res = await aiConfigGetStages();
      setStages(
        (res.stages ?? []).map((s) => ({
          stage: s.stage,
          name: s.name,
          description: s.description,
          modelId: s.modelId,
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

  const modelOptions = useMemo(() => {
    const arr = models.slice();
    arr.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.model.localeCompare(b.model));
    return arr;
  }, [models]);

  const create = async () => {
    setError("");
    setNotice("");
    const priceIn = Number(newPriceIn);
    const priceOut = Number(newPriceOut);
    const sortOrder = Number(newSortOrder);
    if (!newModel.trim()) return setError("model 不能为空");
    if (!newBaseURL.trim()) return setError("baseURL 不能为空");
    if (!newApiKey.trim()) return setError("apiKey 不能为空");
    if (!Number.isFinite(priceIn) || priceIn < 0) return setError("输入单价必须是 >=0 的数字（元/1,000,000 tokens）");
    if (!Number.isFinite(priceOut) || priceOut < 0) return setError("输出单价必须是 >=0 的数字（元/1,000,000 tokens）");
    if (!Number.isFinite(sortOrder) || !Number.isInteger(sortOrder)) return setError("sortOrder 必须是整数");

    setBusy(true);
    try {
      await aiConfigCreateModel({
        model: newModel.trim(),
        baseURL: newBaseURL.trim(),
        endpoint: newEndpoint.trim(),
        apiKey: newApiKey.trim(),
        priceInCnyPer1M: priceIn,
        priceOutCnyPer1M: priceOut,
        billingGroup: newBillingGroup.trim() || undefined,
        isEnabled: newEnabled,
        sortOrder,
        description: newDesc.trim() || undefined,
      });
      setNotice("模型已创建（热生效）");
      setNewApiKey("");
      await refresh();
    } catch (e: any) {
      const err = e as ApiError;
      setError(`创建失败：${err.code}`);
    } finally {
      setBusy(false);
    }
  };

  const saveModel = async (m: ModelDraftUi) => {
    setError("");
    setNotice("");

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
        baseURL: m.baseURL.trim(),
        endpoint: m.endpoint.trim(),
        priceInCnyPer1M: priceIn,
        priceOutCnyPer1M: priceOut,
        billingGroup: (m.billingGroup ?? null) ? String(m.billingGroup).trim() : null,
        isEnabled: Boolean(m.isEnabled),
        sortOrder: Number(m.sortOrder),
        description: m.description ?? null,
        ...(m.clearApiKey ? { clearApiKey: true } : {}),
        ...(m.apiKeyInput?.trim() ? { apiKey: m.apiKeyInput.trim() } : {}),
      });
      setNotice(`已保存：${m.model}`);
      await refresh();
    } catch (e: any) {
      const err = e as ApiError;
      setError(`保存失败：${err.code}`);
    } finally {
      setBusy(false);
    }
  };

  const testOne = async (id: string) => {
    setError("");
    setNotice("");
    setTesting((prev) => ({ ...prev, [id]: true }));
    try {
      setNotice("测速中…（单个模型超时 20 秒）");
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
      setNotice(`测速完成：${tr.ok ? "OK" : "FAIL"} · ${tr.latencyMs ?? "-"}ms · ${String(tr.testedAt).slice(0, 19).replace("T", " ")}`);
    } catch (e: any) {
      const err = e as ApiError;
      setError(`测速失败：${err.code}`);
    } finally {
      setTesting((prev) => ({ ...prev, [id]: false }));
    }
  };

  const testAll = async () => {
    setError("");
    setNotice("");
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
      setNotice(`一键测速中… 0/${ids.length}`);
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      setNotice(`一键测速完成：${ids.length}/${ids.length}`);
      await refresh();
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

      <div className="tableWrap" style={{ padding: 14, marginBottom: 14 }}>
        <div style={{ fontWeight: 900, marginBottom: 10 }}>新建模型（价格必填，用于按 token 扣积分）</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <label className="field">
            <div className="label">model</div>
            <input className="input" value={newModel} onChange={(e) => setNewModel(e.target.value)} placeholder="deepseek-v3.2" />
          </label>
          <label className="field">
            <div className="label">baseURL</div>
            <input className="input" value={newBaseURL} onChange={(e) => setNewBaseURL(e.target.value)} placeholder="https://xh.v1api.cc" />
          </label>
          <label className="field">
            <div className="label">endpoint</div>
            <select className="input" value={newEndpoint} onChange={(e) => setNewEndpoint(e.target.value)}>
              <option value="/v1/chat/completions">/v1/chat/completions</option>
              <option value="/v1/embeddings">/v1/embeddings</option>
            </select>
          </label>
          <label className="field">
            <div className="label">apiKey（服务端加密存储）</div>
            <input className="input" type="password" value={newApiKey} onChange={(e) => setNewApiKey(e.target.value)} placeholder="sk-..." />
          </label>
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
        <div style={{ marginTop: 10 }}>
          <button className="btn primary" type="button" onClick={() => void create()} disabled={busy}>
            创建
          </button>
        </div>
      </div>

      <div className="tableWrap" style={{ padding: 14, marginBottom: 14 }}>
        <div style={{ fontWeight: 900, marginBottom: 10 }}>AI 模型管理</div>
        <div className="modelList">
          {models.map((m) => {
            const isTesting = Boolean(testing[m.id]);
            const kind = endpointLabel(m.endpoint);
            const kindTag = kind === "Embeddings" ? "tagPurple" : "tagBlue";
            const keyTag = m.hasApiKey ? "tagGreen" : "tagRed";
            const keyText = m.hasApiKey ? `Key ${m.apiKeyMasked || "****"}` : "无 Key";

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
                    <span className={`tag ${kindTag}`}>{kind}</span>
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
                    <button className="btn" type="button" disabled={busy || isTesting} onClick={() => void delOne(m.id)}>
                      删除
                    </button>
                  </div>
                </div>

                <div className="modelFieldsGrid">
                  <label className="field">
                    <div className="label">BaseURL</div>
                    <input
                      className="input"
                      value={m.baseURL}
                      onChange={(e) => setModels((prev) => prev.map((x) => (x.id === m.id ? { ...x, baseURL: e.target.value } : x)))}
                    />
                  </label>

                  <label className="field">
                    <div className="label">Endpoint</div>
                    <select
                      className="input"
                      value={m.endpoint}
                      onChange={(e) => setModels((prev) => prev.map((x) => (x.id === m.id ? { ...x, endpoint: e.target.value } : x)))}
                    >
                      <option value="/v1/chat/completions">/v1/chat/completions</option>
                      <option value="/v1/embeddings">/v1/embeddings</option>
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
            {stages.map((s) => (
              <tr key={s.stage}>
                <td style={{ fontWeight: 900 }}>
                  {s.name}
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    {s.stage}
                  </div>
                </td>
                <td className="muted">{s.description}</td>
                <td>
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
                    {modelOptions
                      .filter((m) => m.isEnabled)
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.model} {m.hasApiKey ? "" : "(无key)"} {endpointLabel(m.endpoint) === "Embeddings" ? "[Emb]" : ""}
                        </option>
                      ))}
                  </select>
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
            ))}
          </tbody>
        </table>
      </div>

      <div className="hint" style={{ marginTop: 14 }}>
        说明：旧版 <code>/api/admin/llm/config</code>（BaseURL/Models JSON）仍保留但已视为过渡。新版本以 <code>/api/ai-config/*</code> 为准，
        key 服务端加密存储，定价挂在模型上，stage 统一路由，保存后秒级热生效。
      </div>
    </div>
  );
}
