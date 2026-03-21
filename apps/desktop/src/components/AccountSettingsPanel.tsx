import { useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  Clock3,
  Coins,
  ExternalLink,
  Fingerprint,
  Link2,
  LogIn,
  LogOut,
  Mail,
  QrCode,
  Receipt,
  RefreshCw,
  Shield,
  Smartphone,
  UserCircle2,
  Wallet,
} from "lucide-react";
import * as QRCode from "qrcode";
import { cn } from "@/lib/utils";
import { useAuthStore, type AccountUsageBucket, type AccountUsageSummary } from "@/state/authStore";

function fmtCny(amountCent: number) {
  const n = Number(amountCent);
  if (!Number.isFinite(n)) return "¥0.00";
  return `¥${(Math.max(0, Math.floor(n)) / 100).toFixed(2)}`;
}

function fmtTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function fmtInt(value: number) {
  return Math.max(0, Math.floor(Number(value) || 0)).toLocaleString();
}

function emptyUsageBucket(): AccountUsageBucket {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    chargedPoints: 0,
    runCount: 0,
  };
}

function emptyUsageSummary(): AccountUsageSummary {
  return {
    generatedAt: "",
    recentWindowDays: 30,
    recentWindowStart: "",
    lifetime: emptyUsageBucket(),
    recent30d: emptyUsageBucket(),
    byMode: {
      chat: emptyUsageBucket(),
      agent: emptyUsageBucket(),
    },
    recentRuns: [],
  };
}

function SectionCard(props: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-surface-alt/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-text">{props.title}</div>
          {props.description ? (
            <div className="mt-1 text-[12px] leading-relaxed text-text-muted">{props.description}</div>
          ) : null}
        </div>
        {props.actions ? <div className="flex max-w-full flex-wrap justify-end gap-2">{props.actions}</div> : null}
      </div>
      <div className="mt-4">{props.children}</div>
    </section>
  );
}

function StatCard(props: {
  icon: ReactNode;
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "accent";
}) {
  return (
    <div
      className={cn(
        "rounded-xl border p-3",
        props.tone === "accent"
          ? "border-accent/20 bg-accent-soft/40"
          : "border-border bg-surface",
      )}
    >
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.08em] text-text-faint">
        <span className={props.tone === "accent" ? "text-accent" : "text-text-muted"}>{props.icon}</span>
        {props.label}
      </div>
      <div className="mt-2 text-[24px] font-semibold tracking-tight text-text" style={{ fontVariantNumeric: "tabular-nums" }}>
        {props.value}
      </div>
      {props.hint ? <div className="mt-1 text-[11px] text-text-muted">{props.hint}</div> : null}
    </div>
  );
}

function KeyValueRow(props: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2.5">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-alt text-text-muted">
        {props.icon}
      </div>
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-[0.08em] text-text-faint">{props.label}</div>
        <div className="truncate text-[13px] font-medium text-text">{props.value}</div>
      </div>
    </div>
  );
}

function Banner(props: { tone: "error" | "warn"; text: string }) {
  return (
    <div
      className={cn(
        "rounded-xl border px-3 py-2 text-[12px] leading-relaxed",
        props.tone === "error"
          ? "border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-400"
          : "border-yellow-500/20 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300",
      )}
    >
      {props.text}
    </div>
  );
}

function ActionButton(props: {
  icon?: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "primary" | "secondary" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        props.tone === "primary" && "bg-accent text-white hover:bg-accent/90",
        props.tone === "danger" && "bg-red-500/10 text-red-600 hover:bg-red-500/15 dark:text-red-400",
        (!props.tone || props.tone === "secondary") && "bg-surface text-text-muted hover:bg-surface-alt hover:text-text border border-border",
      )}
    >
      {props.icon}
      {props.children}
    </button>
  );
}

export function AccountSettingsPanel() {
  const user = useAuthStore((s) => s.user);
  const busy = useAuthStore((s) => s.busy);
  const error = useAuthStore((s) => s.error);
  const userAvatarDataUrl = useAuthStore((s) => s.userAvatarDataUrl);
  const logout = useAuthStore((s) => s.logout);
  const openLoginModal = useAuthStore((s) => s.openLoginModal);
  const refreshMe = useAuthStore((s) => s.refreshMe);
  const refreshPoints = useAuthStore((s) => s.refreshPoints);
  const fetchUsageSummary = useAuthStore((s) => s.fetchUsageSummary);
  const listTransactions = useAuthStore((s) => s.listTransactions);
  const listRechargeProducts = useAuthStore((s) => s.listRechargeProducts);
  const createRechargeOrder = useAuthStore((s) => s.createRechargeOrder);
  const getRechargePayStatus = useAuthStore((s) => s.getRechargePayStatus);

  const [txOpen, setTxOpen] = useState(false);
  const [txBusy, setTxBusy] = useState(false);
  const [txs, setTxs] = useState<any[]>([]);
  const [usageBusy, setUsageBusy] = useState(false);
  const [usageError, setUsageError] = useState("");
  const [usageSummary, setUsageSummary] = useState<AccountUsageSummary>(() => emptyUsageSummary());
  const [rechargeBusy, setRechargeBusy] = useState(false);
  const [rechargeError, setRechargeError] = useState("");
  const [rechargeProducts, setRechargeProducts] = useState<
    Array<{ id: string; sku: string; name: string; amountCent: number; originalAmountCent: number | null; points: number }>
  >([]);
  const [rechargeMeta, setRechargeMeta] = useState<{ billingGroup: string; pointsPerCny: number; giftEnabled: boolean; giftMultiplier: number } | null>(null);
  const [activePay, setActivePay] = useState<null | { orderId: string; payUrl: string; expireAt: string; pointsToCredit: number; amountCent: number }>(null);
  const [qrUrl, setQrUrl] = useState("");

  const displayName = user?.phone ?? user?.email ?? "未登录";

  const refreshUsage = async () => {
    if (!user) {
      setUsageSummary(emptyUsageSummary());
      return;
    }
    setUsageBusy(true);
    setUsageError("");
    try {
      const summary = await fetchUsageSummary();
      setUsageSummary(summary);
    } catch (e: any) {
      setUsageError(String(e?.code ?? e?.message ?? e));
    } finally {
      setUsageBusy(false);
    }
  };

  const refreshRechargeProducts = async () => {
    if (!user) return;
    setRechargeBusy(true);
    setRechargeError("");
    try {
      const ret = await listRechargeProducts();
      setRechargeProducts(Array.isArray(ret.products) ? ret.products : []);
      setRechargeMeta({
        billingGroup: String(ret.billingGroup ?? "normal"),
        pointsPerCny: Number(ret.pointsPerCny ?? 0) || 0,
        giftEnabled: Boolean((ret as any).giftEnabled),
        giftMultiplier: Number((ret as any).giftMultiplier ?? 0) || 0,
      });
    } catch (e: any) {
      setRechargeError(String(e?.code ?? e?.message ?? e));
    } finally {
      setRechargeBusy(false);
    }
  };

  useEffect(() => {
    setTxOpen(false);
    setTxs([]);
    setTxBusy(false);
    void refreshMe().catch(() => void 0);
    void refreshPoints().catch(() => void 0);
  }, [refreshMe, refreshPoints]);

  useEffect(() => {
    setUsageError("");
    setUsageSummary(emptyUsageSummary());
    if (!user) return;
    void refreshUsage();
  }, [user?.id]);

  useEffect(() => {
    setRechargeBusy(false);
    setRechargeError("");
    setRechargeProducts([]);
    setRechargeMeta(null);
    setActivePay(null);
    setQrUrl("");
    if (!user) return;
    void refreshRechargeProducts();
  }, [user?.id, listRechargeProducts]);

  useEffect(() => {
    if (!user || !activePay?.orderId) return;
    let stopped = false;
    let tries = 0;
    const tick = async () => {
      if (stopped) return;
      tries += 1;
      if (tries > 45) return;
      try {
        const ret = await getRechargePayStatus({ orderId: activePay.orderId });
        if (ret?.paid) {
          await refreshPoints().catch(() => void 0);
          await refreshUsage().catch(() => void 0);
          return;
        }
        if (String(ret?.status ?? "") === "closed") return;
      } catch {
        // ignore
      }
      window.setTimeout(() => void tick(), 2000);
    };
    void tick();
    return () => {
      stopped = true;
    };
  }, [user?.id, activePay, getRechargePayStatus, refreshPoints]);

  const loadTransactions = async () => {
    setTxBusy(true);
    try {
      const list = await listTransactions();
      setTxs(list);
    } finally {
      setTxBusy(false);
    }
  };

  const startRecharge = async (productId: string) => {
    setRechargeBusy(true);
    setRechargeError("");
    setActivePay(null);
    setQrUrl("");
    try {
      const ret = await createRechargeOrder({ productId });
      const payUrl = String(ret.payUrl ?? "").trim();
      setActivePay({
        orderId: String(ret.orderId ?? ""),
        payUrl,
        expireAt: String(ret.expireAt ?? ""),
        pointsToCredit: Number(ret.pointsToCredit ?? 0) || 0,
        amountCent: Number(ret.amountCent ?? 0) || 0,
      });
      if (payUrl) {
        try {
          const dataUrl = await QRCode.toDataURL(payUrl, { margin: 1, width: 240 });
          setQrUrl(String(dataUrl ?? ""));
        } catch {
          setQrUrl("");
        }
      }
    } catch (e: any) {
      setRechargeError(String(e?.code ?? e?.message ?? e));
    } finally {
      setRechargeBusy(false);
    }
  };

  const refreshRechargePayment = async () => {
    if (!activePay?.orderId) return;
    setRechargeBusy(true);
    setRechargeError("");
    try {
      const ret = await getRechargePayStatus({ orderId: activePay.orderId });
      if (ret?.paid) {
        await refreshPoints().catch(() => void 0);
        await refreshUsage().catch(() => void 0);
      } else {
        setRechargeError(`未检测到支付成功（status=${String(ret?.status ?? "")}）`);
      }
    } catch (e: any) {
      setRechargeError(String(e?.code ?? e?.message ?? e));
    } finally {
      setRechargeBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="text-[12px] leading-relaxed text-text-muted">
        这里统一查看当前账号、积分余额、真实 usage 汇总和充值记录。积分不再挂在侧边头像旁，避免把主导航挤乱。
      </div>

      {error ? <Banner tone="error" text={error} /> : null}

      {!user ? (
        <SectionCard
          title="账号"
          description="当前还没有登录，登录后这里会显示积分余额、使用量和充值入口。"
          actions={
            <ActionButton tone="primary" onClick={() => openLoginModal()}>
              <LogIn size={13} />
              去登录
            </ActionButton>
          }
        >
          <div className="rounded-2xl border border-border bg-surface px-4 py-5">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                <UserCircle2 size={22} />
              </div>
              <div>
                <div className="text-[14px] font-medium text-text">未登录</div>
                <div className="mt-1 text-[12px] text-text-muted">登录后可查看账号信息、积分余额与 usage 汇总。</div>
              </div>
            </div>
          </div>
        </SectionCard>
      ) : (
        <>
          <SectionCard
            title="账号"
            description="账号身份、积分和核心使用量一屏查看。"
            actions={
              <div className="flex flex-wrap items-center justify-end gap-2">
                <ActionButton tone="secondary" disabled={busy} onClick={() => void refreshPoints()}>
                  <RefreshCw size={13} className={busy ? "animate-spin" : ""} />
                  刷新积分
                </ActionButton>
                <ActionButton tone="secondary" disabled={usageBusy} onClick={() => void refreshUsage()}>
                  <RefreshCw size={13} className={usageBusy ? "animate-spin" : ""} />
                  刷新用量
                </ActionButton>
                <ActionButton tone="danger" onClick={() => logout()}>
                  <LogOut size={13} />
                  退出
                </ActionButton>
              </div>
            }
          >
            <div className="flex flex-col gap-4">
              <div className="rounded-2xl border border-border bg-surface p-4">
                <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(260px,1fr))]">
                  <div className="flex min-w-0 items-center gap-4">
                    <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-2xl border border-border bg-accent-soft text-accent">
                      {userAvatarDataUrl ? (
                        <img src={userAvatarDataUrl} alt={displayName} className="h-full w-full object-cover" />
                      ) : (
                        <span className="text-[22px] font-semibold">{(displayName[0] ?? "我").toUpperCase()}</span>
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-[18px] font-semibold tracking-tight text-text">{displayName}</div>
                      <div className="mt-1 text-[12px] text-text-muted">
                        {usageSummary.generatedAt ? `上次汇总：${fmtTime(usageSummary.generatedAt)}` : "按 run 审计实时汇总"}
                      </div>
                    </div>
                  </div>
                  <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
                    <KeyValueRow icon={<Smartphone size={15} />} label="手机号" value={user.phone ?? "未绑定"} />
                    <KeyValueRow icon={<Mail size={15} />} label="邮箱" value={user.email ?? "未绑定"} />
                    <KeyValueRow icon={<Shield size={15} />} label="角色" value={user.role} />
                    <KeyValueRow icon={<Fingerprint size={15} />} label="用户 ID" value={user.id} />
                  </div>
                </div>
              </div>

              <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
                <StatCard icon={<Coins size={14} />} label="积分余额" value={fmtInt(user.pointsBalance)} tone="accent" />
                <StatCard
                  icon={<Activity size={14} />}
                  label="累计 Tokens"
                  value={fmtInt(usageSummary.lifetime.totalTokens)}
                  hint={`${fmtInt(usageSummary.lifetime.runCount)} 次 run`}
                />
                <StatCard
                  icon={<Clock3 size={14} />}
                  label={`近 ${usageSummary.recentWindowDays || 30} 天`}
                  value={fmtInt(usageSummary.recent30d.totalTokens)}
                  hint={`${fmtInt(usageSummary.recent30d.chargedPoints)} 积分`}
                />
              </div>
            </div>
          </SectionCard>

          <SectionCard
            title="使用量"
            description="展示 lifetime、近 30 天、Chat 与 Agent 的真实 usage 汇总。"
          >
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
              <StatCard
                icon={<Activity size={14} />}
                label="累计总览"
                value={fmtInt(usageSummary.lifetime.totalTokens)}
                hint={`输入 ${fmtInt(usageSummary.lifetime.promptTokens)} / 输出 ${fmtInt(usageSummary.lifetime.completionTokens)} / 消耗 ${fmtInt(usageSummary.lifetime.chargedPoints)} 积分`}
              />
              <StatCard
                icon={<Clock3 size={14} />}
                label={`近 ${usageSummary.recentWindowDays || 30} 天`}
                value={fmtInt(usageSummary.recent30d.totalTokens)}
                hint={`起点 ${usageSummary.recentWindowStart ? fmtTime(usageSummary.recentWindowStart) : "-"}`}
              />
              <StatCard
                icon={<Receipt size={14} />}
                label="Chat"
                value={fmtInt(usageSummary.byMode.chat.totalTokens)}
                hint={`${fmtInt(usageSummary.byMode.chat.runCount)} 次 run / ${fmtInt(usageSummary.byMode.chat.chargedPoints)} 积分`}
              />
              <StatCard
                icon={<Wallet size={14} />}
                label="Agent"
                value={fmtInt(usageSummary.byMode.agent.totalTokens)}
                hint={`${fmtInt(usageSummary.byMode.agent.runCount)} 次 run / ${fmtInt(usageSummary.byMode.agent.chargedPoints)} 积分`}
              />
            </div>
            {usageError ? <div className="mt-3"><Banner tone="error" text={usageError} /></div> : null}
          </SectionCard>

          <SectionCard
            title="最近 Run"
            description="按 run 审计汇总最近的使用记录，方便快速核对模型、tokens 和积分消耗。"
          >
            {usageBusy && usageSummary.recentRuns.length === 0 ? (
              <div className="text-[12px] text-text-muted">正在汇总使用量…</div>
            ) : usageSummary.recentRuns.length > 0 ? (
              <div className="flex flex-col gap-2">
                {usageSummary.recentRuns.map((run) => (
                  <div key={run.id} className="grid gap-3 rounded-xl border border-border bg-surface px-3 py-3 [grid-template-columns:minmax(0,1fr)]">
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-medium text-text">
                        {run.mode === "chat" ? "Chat" : "Agent"}
                        {run.model ? <span className="text-text-muted"> · {run.model}</span> : null}
                      </div>
                      <div className="mt-1 text-[11px] text-text-faint">
                        {fmtTime(run.startedAt)}
                        {run.kind ? ` · ${run.kind}` : ""}
                      </div>
                    </div>
                    <div className="min-w-0 text-left">
                      <div className="text-[13px] font-medium text-text" style={{ fontVariantNumeric: "tabular-nums" }}>
                        {fmtInt(run.totalTokens)} tokens
                      </div>
                      <div className="mt-1 text-[11px] text-text-faint">
                        输入 {fmtInt(run.promptTokens)} / 输出 {fmtInt(run.completionTokens)}
                        {run.chargedPoints > 0 ? ` · ${fmtInt(run.chargedPoints)} 积分` : ""}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[12px] text-text-muted">暂无使用记录</div>
            )}
          </SectionCard>

          <SectionCard
            title="积分流水"
            description="查看所有积分增减记录。仅在展开时请求数据，避免无意义拉取。"
            actions={
              <ActionButton
                tone="secondary"
                disabled={txBusy}
                onClick={() => {
                  setTxOpen((v) => !v);
                  if (!txOpen) void loadTransactions();
                }}
              >
                <Receipt size={13} />
                {txOpen ? "收起流水" : "查看流水"}
              </ActionButton>
            }
          >
            {txOpen ? (
              txBusy ? (
                <div className="text-[12px] text-text-muted">加载中…</div>
              ) : txs.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {txs.map((tx) => (
                    <div key={String(tx.id)} className="grid gap-3 rounded-xl border border-border bg-surface px-3 py-3 [grid-template-columns:minmax(0,1fr)]">
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-text">{String(tx.type ?? "")}</div>
                        <div className="mt-1 text-[11px] text-text-faint">
                          {fmtTime(String(tx.createdAt ?? ""))}
                          {tx.reason ? ` · ${String(tx.reason)}` : ""}
                        </div>
                      </div>
                      <div
                        className={cn(
                          "text-[13px] font-semibold",
                          Number(tx.delta) < 0 ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400",
                        )}
                        style={{ fontVariantNumeric: "tabular-nums" }}
                      >
                        {Number(tx.delta) < 0 ? "" : "+"}
                        {Number(tx.delta) || 0}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[12px] text-text-muted">暂无流水</div>
              )
            ) : (
              <div className="text-[12px] text-text-muted">点击右上角按钮后展开。</div>
            )}
          </SectionCard>

          <SectionCard
            title="充值积分"
            description="使用微信支付创建订单，二维码和支付链接都会在这里展示。"
            actions={
              <ActionButton tone="secondary" disabled={rechargeBusy} onClick={() => void refreshRechargeProducts()}>
                <RefreshCw size={13} className={rechargeBusy ? "animate-spin" : ""} />
                刷新档位
              </ActionButton>
            }
          >
            <div className="flex flex-col gap-3">
              <div className="rounded-xl border border-border bg-surface px-3 py-3 text-[12px] text-text-muted">
                当前分组：{rechargeMeta?.billingGroup ?? "normal"} · 兑换率：{rechargeMeta?.pointsPerCny ?? "?"} 积分/元
                {" · "}
                活动赠送：{rechargeMeta?.giftEnabled ? `+${Math.round((rechargeMeta?.giftMultiplier ?? 0) * 100)}%` : "关闭"}
              </div>
              {rechargeError ? <Banner tone="error" text={rechargeError} /> : null}

              {rechargeProducts.length > 0 ? (
                <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
                  {rechargeProducts.map((product) => (
                    <div key={product.id} className="rounded-xl border border-border bg-surface p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-[13px] font-medium text-text">{product.name}</div>
                          <div className="mt-1 text-[11px] text-text-faint">SKU: {product.sku}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-[14px] font-semibold text-text">{fmtCny(product.amountCent)}</div>
                          <div className="mt-1 text-[11px] text-text-muted">{fmtInt(product.points)} 积分</div>
                        </div>
                      </div>
                      <div className="mt-3">
                        <ActionButton tone="primary" disabled={rechargeBusy} onClick={() => void startRecharge(product.id)}>
                          <QrCode size={13} />
                          生成二维码
                        </ActionButton>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[12px] text-text-muted">暂无可用充值档位</div>
              )}

              {activePay ? (
                <div className="rounded-2xl border border-accent/20 bg-accent-soft/30 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold text-text">待支付订单</div>
                      <div className="mt-1 text-[12px] text-text-muted">
                        订单 {activePay.orderId} · 金额 {fmtCny(activePay.amountCent)} · 预计到账 {fmtInt(activePay.pointsToCredit)} 积分
                      </div>
                      {activePay.expireAt ? (
                        <div className="mt-1 text-[11px] text-text-faint">过期时间：{fmtTime(activePay.expireAt)}</div>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <ActionButton tone="secondary" onClick={() => { setActivePay(null); setQrUrl(""); }}>
                        取消本次
                      </ActionButton>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
                    <div className="flex h-[240px] w-full max-w-[240px] items-center justify-center overflow-hidden rounded-2xl border border-border bg-white">
                      {qrUrl ? (
                        <img src={qrUrl} alt="pay_qr" className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex flex-col items-center gap-2 text-center text-[12px] text-text-faint">
                          <QrCode size={18} />
                          二维码生成失败
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] uppercase tracking-[0.08em] text-text-faint">支付链接</div>
                      <div className="mt-2 rounded-xl border border-border bg-surface px-3 py-3 text-[12px] leading-relaxed text-text break-all">
                        {activePay.payUrl}
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <ActionButton
                          tone="secondary"
                          onClick={() => {
                            const text = String(activePay.payUrl ?? "");
                            if (!text) return;
                            void navigator.clipboard?.writeText?.(text).catch(() => void 0);
                          }}
                        >
                          <Link2 size={13} />
                          复制链接
                        </ActionButton>
                        <ActionButton tone="primary" disabled={rechargeBusy} onClick={() => void refreshRechargePayment()}>
                          <RefreshCw size={13} className={rechargeBusy ? "animate-spin" : ""} />
                          我已支付，刷新
                        </ActionButton>
                        <a
                          href={activePay.payUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-[12px] font-medium text-text-muted transition-colors hover:bg-surface-alt hover:text-text"
                        >
                          <ExternalLink size={13} />
                          浏览器打开
                        </a>
                      </div>
                      <div className="mt-3 text-[11px] leading-relaxed text-text-faint">
                        支付完成后会自动轮询一段时间；如果没及时到账，可以手动点“我已支付，刷新”。
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </SectionCard>
        </>
      )}
    </div>
  );
}
