import { useEffect, useMemo, useState } from "react";
import type { ApiError } from "../api/client";
import {
  adminGetRechargeConfig,
  adminGetRechargeProducts,
  adminUpdateRechargeConfig,
  adminUpdateRechargeProducts,
  type RechargeConfigDto,
  type RechargeProductDto,
  toolConfigGetCapabilities,
  toolConfigGetSmsVerify,
  toolConfigGetWebSearch,
  toolConfigTestSmsVerify,
  toolConfigTestWebSearch,
  toolConfigUpdateCapabilities,
  toolConfigUpdateSmsVerify,
  toolConfigUpdateWebSearch,
  type CapabilitiesEffectiveDto,
  type CapabilitiesRegistryDto,
  type CapabilitiesStoredDto,
  type CapabilitiesToolDto,
  type CapabilitiesSkillDto,
  type SmsVerifyConfigEffectiveDto,
  type SmsVerifyConfigStoredDto,
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
  const [tab, setTab] = useState<"web" | "sms" | "tools" | "skills" | "recharge" | "rechargeProducts">("web");
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
  const [billPointsPerSearch, setBillPointsPerSearch] = useState("");
  const [billPointsPerFetch, setBillPointsPerFetch] = useState("");
  const [allowDomainsText, setAllowDomainsText] = useState("");
  const [denyDomainsText, setDenyDomainsText] = useState("");
  const [fetchUa, setFetchUa] = useState("");

  const [testQuery, setTestQuery] = useState("杭州 天气");
  const [testing, setTesting] = useState(false);

  const [smsStored, setSmsStored] = useState<SmsVerifyConfigStoredDto | null>(null);
  const [smsEffective, setSmsEffective] = useState<SmsVerifyConfigEffectiveDto | null>(null);
  const [smsIsEnabled, setSmsIsEnabled] = useState(true);
  const [smsEndpoint, setSmsEndpoint] = useState("");
  const [smsAccessKeyIdInput, setSmsAccessKeyIdInput] = useState("");
  const [smsAccessKeySecretInput, setSmsAccessKeySecretInput] = useState("");
  const [smsClearAccessKeyId, setSmsClearAccessKeyId] = useState(false);
  const [smsClearAccessKeySecret, setSmsClearAccessKeySecret] = useState(false);
  const [smsSchemeName, setSmsSchemeName] = useState("");
  const [smsSignName, setSmsSignName] = useState("");
  const [smsTemplateCode, setSmsTemplateCode] = useState("");
  const [smsTemplateMin, setSmsTemplateMin] = useState("5");
  const [smsCodeLength, setSmsCodeLength] = useState("6");
  const [smsValidTimeSeconds, setSmsValidTimeSeconds] = useState("300");
  const [smsIntervalSeconds, setSmsIntervalSeconds] = useState("60");
  const [smsDuplicatePolicy, setSmsDuplicatePolicy] = useState("1");
  const [smsCodeType, setSmsCodeType] = useState("1");
  const [smsAutoRetry, setSmsAutoRetry] = useState("1");
  const [smsTesting, setSmsTesting] = useState(false);

  const [rechargeStored, setRechargeStored] = useState<RechargeConfigDto | null>(null);
  const [rechargeDefaultGroup, setRechargeDefaultGroup] = useState("normal");
  const [rechargeMapText, setRechargeMapText] = useState("normal=250\nvip=500");
  const [rechargeGiftEnabled, setRechargeGiftEnabled] = useState(false);
  const [rechargeGiftDefaultMultiplier, setRechargeGiftDefaultMultiplier] = useState("0");
  // 留空=不做“分组覆盖”，统一使用 giftDefaultMultiplier（更符合“启用活动赠送”的直觉）
  const [rechargeGiftMapText, setRechargeGiftMapText] = useState("");
  const [rechargeSaving, setRechargeSaving] = useState(false);
  const [rechargeProductsStored, setRechargeProductsStored] = useState<RechargeProductDto[]>([]);
  const [rechargeProductsRows, setRechargeProductsRows] = useState<
    Array<{
      sku: string;
      name: string;
      amountYuan: string;
      originalAmountYuan: string;
      pointsFixed: string;
      status: "active" | "inactive";
    }>
  >([]);
  const [rechargeProductsSaving, setRechargeProductsSaving] = useState(false);

  const refresh = async () => {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const [web, sms, caps, recharge, rechargeProducts] = await Promise.all([
        toolConfigGetWebSearch(),
        toolConfigGetSmsVerify(),
        toolConfigGetCapabilities(),
        adminGetRechargeConfig(),
        adminGetRechargeProducts(),
      ]);
      setStored(web.stored);
      setEffective(web.effective);
      setIsEnabled(Boolean(web.stored.isEnabled));
      setEndpoint(web.stored.endpoint ?? "");
      setBillPointsPerSearch(web.stored.billPointsPerSearch === null ? "" : String(web.stored.billPointsPerSearch));
      setBillPointsPerFetch(web.stored.billPointsPerFetch === null ? "" : String(web.stored.billPointsPerFetch));
      setAllowDomainsText(domainsToText(web.stored.allowDomains ?? []));
      setDenyDomainsText(domainsToText(web.stored.denyDomains ?? []));
      setFetchUa(web.stored.fetchUa ?? "");

      setSmsStored(sms.stored);
      setSmsEffective(sms.effective);
      setSmsIsEnabled(Boolean(sms.stored.isEnabled));
      setSmsEndpoint(sms.stored.endpoint ?? "");
      setSmsSchemeName(sms.stored.schemeName ?? "");
      setSmsSignName(sms.stored.signName ?? "");
      setSmsTemplateCode(sms.stored.templateCode ?? "");
      setSmsTemplateMin(String(sms.stored.templateMin ?? 5));
      setSmsCodeLength(String(sms.stored.codeLength ?? 6));
      setSmsValidTimeSeconds(String(sms.stored.validTimeSeconds ?? 300));
      setSmsIntervalSeconds(String(sms.stored.intervalSeconds ?? 60));
      setSmsDuplicatePolicy(String(sms.stored.duplicatePolicy ?? 1));
      setSmsCodeType(String(sms.stored.codeType ?? 1));
      setSmsAutoRetry(String(sms.stored.autoRetry ?? 1));

      setCapsRegistry(caps.registry);
      setCapsStored(caps.stored);
      setCapsEffective(caps.effective);

      const cfg = recharge?.config ?? null;
      setRechargeStored(cfg);
      if (cfg) {
        setRechargeDefaultGroup(String(cfg.defaultGroup ?? "normal") || "normal");
        const pairs = Object.entries(cfg.pointsPerCnyByGroup ?? {}).map(([k, v]) => `${k}=${v}`);
        setRechargeMapText(pairs.length ? pairs.join("\n") : "normal=250\nvip=500");
        setRechargeGiftEnabled(Boolean((cfg as any).giftEnabled));
        setRechargeGiftDefaultMultiplier(String((cfg as any).giftDefaultMultiplier ?? 0));
        const gpairs = Object.entries((cfg as any).giftMultiplierByGroup ?? {}).map(([k, v]) => `${k}=${v}`);
        setRechargeGiftMapText(gpairs.length ? gpairs.join("\n") : "");
      } else {
        setRechargeDefaultGroup("normal");
        setRechargeMapText("normal=250\nvip=500");
        setRechargeGiftEnabled(false);
        setRechargeGiftDefaultMultiplier("0");
        setRechargeGiftMapText("");
      }

      const prods = Array.isArray(rechargeProducts?.products) ? (rechargeProducts.products as RechargeProductDto[]) : [];
      setRechargeProductsStored(prods);
      setRechargeProductsRows(
        prods.map((p) => ({
          sku: String(p.sku ?? ""),
          name: String(p.name ?? ""),
          amountYuan: p.amountCent ? String((Number(p.amountCent) / 100).toFixed(2)) : "",
          originalAmountYuan: p.originalAmountCent ? String((Number(p.originalAmountCent) / 100).toFixed(2)) : "",
          pointsFixed: p.pointsFixed === null || p.pointsFixed === undefined ? "" : String(p.pointsFixed),
          status: p.status === "inactive" ? "inactive" : "active",
        })),
      );
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

  const parseRechargeMap = (text: string) => {
    const out: Record<string, number> = {};
    const lines = String(text ?? "")
      .split(/\r?\n/g)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const line of lines) {
      const i = line.indexOf("=");
      if (i <= 0) continue;
      const k = line.slice(0, i).trim();
      const v = Number(line.slice(i + 1).trim());
      if (!k) continue;
      if (!Number.isFinite(v) || v <= 0) continue;
      out[k] = Math.floor(v);
    }
    return out;
  };

  const parseGiftMap = (text: string) => {
    const out: Record<string, number> = {};
    const lines = String(text ?? "")
      .split(/\r?\n/g)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const line of lines) {
      const i = line.indexOf("=");
      if (i <= 0) continue;
      const k = line.slice(0, i).trim();
      const v = Number(line.slice(i + 1).trim());
      if (!k) continue;
      if (!Number.isFinite(v) || v < 0) continue;
      out[k] = Math.min(10, v);
    }
    return out;
  };

  const saveRecharge = async () => {
    const def = rechargeDefaultGroup.trim() || "normal";
    const map = parseRechargeMap(rechargeMapText);
    if (!Object.keys(map).length) {
      setError("兑换率不能为空（至少一行：group=pointsPerCny）");
      return;
    }
    if (!map[def]) {
      setError(`默认分组 ${def} 未在兑换率表中定义`);
      return;
    }
    const giftDefault = Number(String(rechargeGiftDefaultMultiplier ?? "").trim() || "0");
    const giftDefaultMultiplier = Number.isFinite(giftDefault) && giftDefault >= 0 ? Math.min(10, giftDefault) : 0;
    const giftMultiplierByGroup = parseGiftMap(rechargeGiftMapText);
    setRechargeSaving(true);
    setError("");
    setNotice("");
    try {
      const res = await adminUpdateRechargeConfig({
        defaultGroup: def,
        pointsPerCnyByGroup: map,
        giftEnabled: rechargeGiftEnabled,
        giftDefaultMultiplier,
        giftMultiplierByGroup,
      });
      setRechargeStored(res.config);
      setNotice("已保存充值倍率（热生效）");
    } catch (e: any) {
      const err = e as ApiError;
      setError(`保存充值倍率失败：${err.code}`);
    } finally {
      setRechargeSaving(false);
    }
  };

  const saveRechargeProducts = async () => {
    setError("");
    setNotice("");
    setRechargeProductsSaving(true);
    try {
      const toCent = (s: string) => {
        const raw = String(s ?? "").trim();
        if (!raw) return null;
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) return null;
        return Math.floor(n * 100);
      };
      const toIntOrNull = (s: string) => {
        const raw = String(s ?? "").trim();
        if (!raw) return null;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) return null;
        return Math.floor(n);
      };
      const products = rechargeProductsRows.map((r) => ({
        sku: String(r.sku ?? "").trim(),
        name: String(r.name ?? "").trim(),
        amountCent: toCent(r.amountYuan) ?? 0,
        originalAmountCent: toCent(r.originalAmountYuan),
        pointsFixed: toIntOrNull(r.pointsFixed),
        status: (r.status === "inactive" ? "inactive" : "active") as "active" | "inactive",
      }));
      for (const p of products) {
        if (!p.sku) throw Object.assign(new Error("SKU_REQUIRED"), { code: "SKU_REQUIRED" });
        if (!p.name) throw Object.assign(new Error("NAME_REQUIRED"), { code: "NAME_REQUIRED" });
        if (!Number.isFinite(p.amountCent) || p.amountCent <= 0) throw Object.assign(new Error("AMOUNT_REQUIRED"), { code: "AMOUNT_REQUIRED" });
      }
      const res = await adminUpdateRechargeProducts({ products });
      setRechargeProductsStored(res.products ?? []);
      setNotice("已保存充值 SKU（热生效）");
      await refresh();
    } catch (e: any) {
      const err = e as ApiError;
      setError(`保存充值 SKU 失败：${err.code ?? e?.code ?? e?.message ?? e}`);
    } finally {
      setRechargeProductsSaving(false);
    }
  };

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
      const toIntOrNull = (s: string) => {
        const raw = String(s ?? "").trim();
        if (!raw) return null;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) return null;
        return Math.floor(n);
      };
      await toolConfigUpdateWebSearch({
        isEnabled,
        endpoint: endpoint.trim() ? endpoint.trim() : null,
        ...(apiKeyInput.trim() ? { apiKey: apiKeyInput.trim() } : {}),
        ...(clearApiKey ? { clearApiKey: true } : {}),
        billPointsPerSearch: toIntOrNull(billPointsPerSearch),
        billPointsPerFetch: toIntOrNull(billPointsPerFetch),
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

  const saveSms = async () => {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const nInt = (s: string) => {
        const n = Number(String(s ?? "").trim());
        return Number.isFinite(n) ? Math.floor(n) : null;
      };
      await toolConfigUpdateSmsVerify({
        isEnabled: smsIsEnabled,
        endpoint: smsEndpoint.trim() ? smsEndpoint.trim() : null,
        ...(smsAccessKeyIdInput.trim() ? { accessKeyId: smsAccessKeyIdInput.trim() } : {}),
        ...(smsAccessKeySecretInput.trim() ? { accessKeySecret: smsAccessKeySecretInput.trim() } : {}),
        ...(smsClearAccessKeyId ? { clearAccessKeyId: true } : {}),
        ...(smsClearAccessKeySecret ? { clearAccessKeySecret: true } : {}),
        schemeName: smsSchemeName.trim() ? smsSchemeName.trim() : null,
        signName: smsSignName.trim() ? smsSignName.trim() : null,
        templateCode: smsTemplateCode.trim() ? smsTemplateCode.trim() : null,
        templateMin: nInt(smsTemplateMin),
        codeLength: nInt(smsCodeLength),
        validTimeSeconds: nInt(smsValidTimeSeconds),
        intervalSeconds: nInt(smsIntervalSeconds),
        duplicatePolicy: nInt(smsDuplicatePolicy),
        codeType: nInt(smsCodeType),
        autoRetry: nInt(smsAutoRetry),
      });
      setNotice("已保存 SMS Verify 配置（热生效）");
      setSmsAccessKeyIdInput("");
      setSmsAccessKeySecretInput("");
      setSmsClearAccessKeyId(false);
      setSmsClearAccessKeySecret(false);
      await refresh();
    } catch (e: any) {
      const err = e as ApiError;
      setError(`保存失败：${err.code}`);
    } finally {
      setBusy(false);
    }
  };

  const testSms = async () => {
    setError("");
    setNotice("");
    setSmsTesting(true);
    try {
      const res = await toolConfigTestSmsVerify();
      setNotice(res.ok ? "测试通过：配置可用（未发送短信）" : "测试未通过");
    } catch (e: any) {
      const err = e as ApiError;
      setError(`测试失败：${err.code}`);
    } finally {
      setSmsTesting(false);
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
            <button className="btn" type="button" onClick={() => setTab("sms")} disabled={tab === "sms"}>
              SMS Verify
            </button>
            <button className="btn" type="button" onClick={() => setTab("recharge")} disabled={tab === "recharge"}>
              充值倍率
            </button>
            <button className="btn" type="button" onClick={() => setTab("rechargeProducts")} disabled={tab === "rechargeProducts"}>
              充值SKU
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
          ) : tab === "sms" ? (
            <button className="btn primary" type="button" onClick={() => void saveSms()} disabled={busy}>
              保存
            </button>
          ) : tab === "recharge" ? (
            <button className="btn primary" type="button" onClick={() => void saveRecharge()} disabled={busy || rechargeSaving}>
              {rechargeSaving ? "保存中…" : "保存"}
            </button>
          ) : tab === "rechargeProducts" ? (
            <button className="btn primary" type="button" onClick={() => void saveRechargeProducts()} disabled={busy || rechargeProductsSaving}>
              {rechargeProductsSaving ? "保存中…" : "保存"}
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

      {tab === "recharge" ? (
        <div className="tableWrap" style={{ padding: 14, marginBottom: 14 }}>
          <div style={{ fontWeight: 900, marginBottom: 8 }}>充值倍率（积分/元）</div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
            说明：配置按用户分组生效（热生效）。Desktop 侧“充值积分”会按该表计算“预计到账积分”。
          </div>

          <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <label className="field" style={{ minWidth: 260 }}>
              <div className="label">默认分组（defaultGroup）</div>
              <input className="input" value={rechargeDefaultGroup} onChange={(e) => setRechargeDefaultGroup(e.target.value)} placeholder="normal" />
            </label>
            <div className="muted" style={{ fontSize: 12 }}>
              {rechargeStored ? `updatedAt: ${rechargeStored.updatedAt}` : "（尚未保存，使用默认值）"}
            </div>
          </div>

          <div style={{ marginTop: 10 }}>
            <div className="label">兑换率表（每行：group=pointsPerCny）</div>
            <textarea
              className="input"
              style={{ width: "100%", height: 160, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}
              value={rechargeMapText}
              onChange={(e) => setRechargeMapText(e.target.value)}
            />
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              示例：normal=250（100元→25,000积分） / vip=500（100元→50,000积分）
            </div>
          </div>

          <div style={{ marginTop: 14 }}>
            <div style={{ fontWeight: 900, marginBottom: 8 }}>活动赠送（买一送一等，热生效）</div>
            <label className="row" style={{ gap: 8, alignItems: "center", marginBottom: 8 }}>
              <input type="checkbox" checked={rechargeGiftEnabled} onChange={(e) => setRechargeGiftEnabled(e.target.checked)} />
              <span>启用赠送</span>
            </label>
            <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <label className="field" style={{ minWidth: 260 }}>
                <div className="label">默认赠送倍率（giftDefaultMultiplier）</div>
                <input className="input" value={rechargeGiftDefaultMultiplier} onChange={(e) => setRechargeGiftDefaultMultiplier(e.target.value)} placeholder="0" />
              </label>
              <div className="muted" style={{ fontSize: 12 }}>
                说明：1=买一送一（赠送 100%），0.5=赠送 50%，0=不赠送
              </div>
            </div>
            <div style={{ marginTop: 10 }}>
              <div className="label">分组赠送倍率（每行：group=giftMultiplier）</div>
              <textarea
                className="input"
                style={{ width: "100%", height: 120, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}
                value={rechargeGiftMapText}
                onChange={(e) => setRechargeGiftMapText(e.target.value)}
              />
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                提示：留空=所有分组都按“默认赠送倍率”生效；填写某个 group 才会覆盖该分组（例如 normal=0 表示 normal 不参与赠送）。
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {tab === "rechargeProducts" ? (
        <div className="tableWrap" style={{ padding: 14, marginBottom: 14 }}>
          <div style={{ fontWeight: 900, marginBottom: 8 }}>充值 SKU（档位）配置</div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
            说明：保存后立即热生效。sku 建议保持稳定（我们用 sku 作为产品 id）。金额单位为“元”。
          </div>

          <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            <button
              className="btn"
              type="button"
              onClick={() => {
                setRechargeProductsRows([
                  ...rechargeProductsRows,
                  { sku: "", name: "", amountYuan: "100.00", originalAmountYuan: "", pointsFixed: "", status: "active" },
                ]);
              }}
            >
              新增一行
            </button>
            <span className="tag">rows {rechargeProductsRows.length}</span>
            <span className="tag">stored {rechargeProductsStored.length}</span>
          </div>

          <table className="table">
            <thead>
              <tr>
                <th>sku</th>
                <th>名称</th>
                <th>金额(元)</th>
                <th>划线价(元)</th>
                <th>固定积分(可选)</th>
                <th>状态</th>
                <th style={{ width: 80 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {rechargeProductsRows.map((r, idx) => (
                <tr key={`${r.sku}-${idx}`}>
                  <td>
                    <input className="input" value={r.sku} onChange={(e) => {
                      const next=[...rechargeProductsRows]; next[idx]={...next[idx], sku:e.target.value}; setRechargeProductsRows(next);
                    }} placeholder="points_100_cny" />
                  </td>
                  <td>
                    <input className="input" value={r.name} onChange={(e) => {
                      const next=[...rechargeProductsRows]; next[idx]={...next[idx], name:e.target.value}; setRechargeProductsRows(next);
                    }} placeholder="充值 ¥100" />
                  </td>
                  <td>
                    <input className="input" value={r.amountYuan} onChange={(e) => {
                      const next=[...rechargeProductsRows]; next[idx]={...next[idx], amountYuan:e.target.value}; setRechargeProductsRows(next);
                    }} placeholder="100.00" />
                  </td>
                  <td>
                    <input className="input" value={r.originalAmountYuan} onChange={(e) => {
                      const next=[...rechargeProductsRows]; next[idx]={...next[idx], originalAmountYuan:e.target.value}; setRechargeProductsRows(next);
                    }} placeholder="（可空）" />
                  </td>
                  <td>
                    <input className="input" value={r.pointsFixed} onChange={(e) => {
                      const next=[...rechargeProductsRows]; next[idx]={...next[idx], pointsFixed:e.target.value}; setRechargeProductsRows(next);
                    }} placeholder="（可空）" />
                  </td>
                  <td>
                    <select className="input" value={r.status} onChange={(e) => {
                      const next=[...rechargeProductsRows]; next[idx]={...next[idx], status:(e.target.value as any)}; setRechargeProductsRows(next);
                    }}>
                      <option value="active">active</option>
                      <option value="inactive">inactive</option>
                    </select>
                  </td>
                  <td>
                    <button className="btn" type="button" onClick={() => {
                      const next=rechargeProductsRows.slice(); next.splice(idx,1); setRechargeProductsRows(next);
                    }}>删除</button>
                  </td>
                </tr>
              ))}
              {!rechargeProductsRows.length ? (
                <tr>
                  <td colSpan={7} className="muted" style={{ padding: 16 }}>
                    暂无数据（可点“新增一行”）
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "tools" || tab === "skills" ? (
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

      {tab === "sms" ? (
        <div className="tableWrap" style={{ padding: 14, marginBottom: 14 }}>
          <div className="modelCard" style={{ marginBottom: 0 }}>
            <div className="modelCardTop">
              <div className="modelCardTitle">
                <div className="modelName">SMS Verify（阿里云 Dypnsapi）</div>
                <span className={`tag ${smsIsEnabled ? "tagGreen" : "tagRed"}`}>{smsIsEnabled ? "enabled" : "disabled"}</span>
                {smsStored?.hasAccessKeyId ? (
                  <span className="tag tagGreen">{smsStored.accessKeyIdMasked || "AK ****"}</span>
                ) : (
                  <span className="tag tagRed">无 AK</span>
                )}
                {smsStored?.hasAccessKeySecret ? (
                  <span className="tag tagGreen">{smsStored.accessKeySecretMasked || "SK ****"}</span>
                ) : (
                  <span className="tag tagRed">无 SK</span>
                )}
                {smsEffective ? (
                  <span className="tag">
                    {`endpoint:${smsEffective.source.endpoint} · ak:${smsEffective.source.accessKeyId}/${smsEffective.source.accessKeySecret} · tpl:${smsEffective.source.signName}/${smsEffective.source.templateCode}`}
                  </span>
                ) : null}
              </div>
            </div>

            <div className="modelFieldsGrid" style={{ gridTemplateColumns: "repeat(2, minmax(240px, 1fr))" }}>
              <label className="field">
                <div className="label">启用</div>
                <label className="toggleSm">
                  <input type="checkbox" checked={smsIsEnabled} onChange={(e) => setSmsIsEnabled(e.target.checked)} /> SMS Verify
                </label>
                <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  关闭后：手机号验证码登录不可用。
                </div>
              </label>

              <label className="field">
                <div className="label">Endpoint（可选覆盖）</div>
                <input className="input" value={smsEndpoint} onChange={(e) => setSmsEndpoint(e.target.value)} placeholder="dypnsapi.aliyuncs.com" />
                <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  留空表示使用 env 或默认值。
                </div>
              </label>

              <label className="field">
                <div className="label">AccessKeyId（留空=不改）</div>
                <input className="input" type="password" value={smsAccessKeyIdInput} onChange={(e) => setSmsAccessKeyIdInput(e.target.value)} placeholder="LTAI..." />
                <label className="muted" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 12 }}>
                  <input type="checkbox" checked={smsClearAccessKeyId} onChange={(e) => setSmsClearAccessKeyId(e.target.checked)} />
                  清空 AK（会回退到 env；若 env 也没配则不可用）
                </label>
              </label>

              <label className="field">
                <div className="label">AccessKeySecret（留空=不改）</div>
                <input className="input" type="password" value={smsAccessKeySecretInput} onChange={(e) => setSmsAccessKeySecretInput(e.target.value)} placeholder="****" />
                <label className="muted" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 12 }}>
                  <input type="checkbox" checked={smsClearAccessKeySecret} onChange={(e) => setSmsClearAccessKeySecret(e.target.checked)} />
                  清空 SK（会回退到 env；若 env 也没配则不可用）
                </label>
              </label>

              <label className="field">
                <div className="label">SchemeName（可选）</div>
                <input className="input" value={smsSchemeName} onChange={(e) => setSmsSchemeName(e.target.value)} placeholder="默认方案（留空）" />
                <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  若发送接口使用了 SchemeName，则校验接口必须一致。
                </div>
              </label>

              <label className="field">
                <div className="label">SignName（赠送签名）</div>
                <input className="input" value={smsSignName} onChange={(e) => setSmsSignName(e.target.value)} placeholder="速通互联验证码" />
              </label>

              <label className="field">
                <div className="label">TemplateCode（赠送模板）</div>
                <input className="input" value={smsTemplateCode} onChange={(e) => setSmsTemplateCode(e.target.value)} placeholder="100001" />
              </label>

              <label className="field">
                <div className="label">TemplateParam.min（分钟）</div>
                <input className="input" value={smsTemplateMin} onChange={(e) => setSmsTemplateMin(e.target.value)} placeholder="5" />
              </label>

              <label className="field">
                <div className="label">CodeLength（4~8）</div>
                <input className="input" value={smsCodeLength} onChange={(e) => setSmsCodeLength(e.target.value)} placeholder="6" />
              </label>

              <label className="field">
                <div className="label">ValidTime（秒）</div>
                <input className="input" value={smsValidTimeSeconds} onChange={(e) => setSmsValidTimeSeconds(e.target.value)} placeholder="300" />
              </label>

              <label className="field">
                <div className="label">Interval（秒）</div>
                <input className="input" value={smsIntervalSeconds} onChange={(e) => setSmsIntervalSeconds(e.target.value)} placeholder="60" />
              </label>

              <label className="field">
                <div className="label">DuplicatePolicy（1覆盖/2保留）</div>
                <input className="input" value={smsDuplicatePolicy} onChange={(e) => setSmsDuplicatePolicy(e.target.value)} placeholder="1" />
              </label>

              <label className="field">
                <div className="label">CodeType（1=纯数字）</div>
                <input className="input" value={smsCodeType} onChange={(e) => setSmsCodeType(e.target.value)} placeholder="1" />
              </label>

              <label className="field">
                <div className="label">AutoRetry（1开启/0关闭）</div>
                <input className="input" value={smsAutoRetry} onChange={(e) => setSmsAutoRetry(e.target.value)} placeholder="1" />
              </label>
            </div>

            <div className="row" style={{ gap: 8, marginTop: 12 }}>
              <button className="btn" type="button" onClick={() => void testSms()} disabled={busy || smsTesting}>
                {smsTesting ? "测试中…" : "测试配置"}
              </button>
              <div className="muted" style={{ fontSize: 12 }}>
                说明：测试不会发送短信，只校验配置完整性。
              </div>
            </div>
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
                <div className="label">计费：每次 web.search 扣积分（0/留空=不扣）</div>
                <input className="input" value={billPointsPerSearch} onChange={(e) => setBillPointsPerSearch(e.target.value)} placeholder="例如 10" />
                <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  说明：仅对 <code>web.search</code> 工具调用生效（按次数扣，避免按 token 计费）。
                </div>
              </label>

              <label className="field">
                <div className="label">计费：每次 web.fetch 扣积分（0/留空=不扣）</div>
                <input className="input" value={billPointsPerFetch} onChange={(e) => setBillPointsPerFetch(e.target.value)} placeholder="例如 5" />
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


