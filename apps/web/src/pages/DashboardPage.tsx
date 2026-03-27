import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { fetchMe, fetchUsageSummary, fetchTransactions, fetchProducts, createOrder } from "../api/gateway.ts";
import { clearAccessToken } from "../api/client.ts";
import type { MeDto, UsageSummaryDto, PointsTxDto, RechargeProductDto } from "../api/gateway.ts";

export default function DashboardPage() {
  const navigate = useNavigate();
  const [me, setMe] = useState<MeDto | null>(null);
  const [usage, setUsage] = useState<UsageSummaryDto | null>(null);
  const [txs, setTxs] = useState<PointsTxDto[]>([]);
  const [products, setProducts] = useState<RechargeProductDto[]>([]);
  const [loadingOrder, setLoadingOrder] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([fetchMe(), fetchUsageSummary(), fetchTransactions(), fetchProducts()])
      .then(([m, u, t, p]) => {
        setMe(m);
        setUsage(u);
        setTxs(t.transactions.slice(0, 10));
        setProducts(p.products);
      })
      .catch((e) => {
        if ((e as { status?: number })?.status === 401) {
          clearAccessToken();
          navigate("/login", { replace: true });
        } else {
          setError("加载失败，请刷新重试");
        }
      });
  }, [navigate]);

  async function handleBuy(productId: string) {
    setLoadingOrder(productId);
    try {
      const res = await createOrder(productId);
      if (res.payUrl) window.open(res.payUrl, "_blank");
      else alert("订单创建成功，请按提示完成支付");
    } catch {
      alert("创建订单失败，请重试");
    } finally {
      setLoadingOrder(null);
    }
  }

  function logout() {
    clearAccessToken();
    navigate("/", { replace: true });
  }

  function fmtNum(n: number) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }

  function fmtDate(s: string) {
    const d = new Date(s);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  const balance = me?.user.pointsBalance ?? 0;

  return (
    <div className="min-h-screen" style={{ background: "#FAFAF8" }}>
      {/* Sidebar nav */}
      <div className="fixed top-0 left-0 bottom-0 w-56 bg-white flex flex-col" style={{ borderRight: "1px solid #F0EDE8" }}>
        <div className="px-5 py-4 flex items-center gap-2.5" style={{ borderBottom: "1px solid #F0EDE8" }}>
          <img src="/icon.png" className="w-7 h-7 rounded-lg" alt="logo" />
          <span className="font-bold text-[16px]">Oh My Crab</span>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1">
          <div className="text-xs font-medium text-gray-400 uppercase tracking-wide px-2 mb-2">控制台</div>
          <SideLink icon="fa-th-large" label="概览" active />
          <SideLink icon="fa-bar-chart" label="用量统计" />
          <SideLink icon="fa-credit-card" label="充值 / 升级" />
          <SideLink icon="fa-history" label="消费记录" />
        </nav>

        <div className="px-4 py-4 space-y-3" style={{ borderTop: "1px solid #F0EDE8" }}>
          <div className="text-xs text-gray-500 truncate">
            <i className="fa fa-user-circle mr-1.5" />
            {me?.user.phone ?? me?.user.email ?? "—"}
          </div>
          <div className="flex gap-2">
            <Link to="/" className="btn-outline text-xs py-1.5 px-3 flex-1 justify-center">
              <i className="fa fa-home" /> 首页
            </Link>
            <button onClick={logout} className="btn-outline text-xs py-1.5 px-3 flex-1 justify-center text-gray-500">
              <i className="fa fa-sign-out" /> 退出
            </button>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="ml-56 p-8">
        <div className="max-w-4xl">
          {error && (
            <div className="mb-6 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-600">
              {error}
            </div>
          )}

          <h1 className="text-2xl font-bold mb-2">控制台</h1>
          <p className="text-gray-400 text-sm mb-8">
            欢迎回来，{me?.user.phone ?? me?.user.email ?? ""}
          </p>

          {/* Top stat cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            {/* Points balance - featured */}
            <div className="stat-card-featured col-span-2">
              <div className="text-sm opacity-80 mb-1">积分余额</div>
              <div className="text-4xl font-bold mb-1">
                {me ? balance.toLocaleString() : <Skeleton w="6rem" />}
              </div>
              <div className="text-xs opacity-70">1 积分 ≈ 消耗约 1K tokens</div>
              <div className="mt-4">
                <a href="#recharge" className="inline-flex items-center gap-1.5 text-xs font-semibold bg-white text-brand rounded-lg px-3 py-1.5 hover:opacity-90 transition-opacity">
                  <i className="fa fa-plus" /> 充值积分
                </a>
              </div>
            </div>

            <div className="stat-card">
              <div className="text-xs text-gray-400 mb-1">本月 Runs</div>
              <div className="text-2xl font-bold text-gray-800">
                {usage ? usage.total.runCount : <Skeleton w="3rem" />}
              </div>
              <div className="text-xs text-gray-400 mt-1">近 30 天</div>
            </div>

            <div className="stat-card">
              <div className="text-xs text-gray-400 mb-1">消耗 Tokens</div>
              <div className="text-2xl font-bold text-gray-800">
                {usage ? fmtNum(usage.total.totalTokens) : <Skeleton w="3rem" />}
              </div>
              <div className="text-xs text-gray-400 mt-1">近 30 天</div>
            </div>
          </div>

          {/* Usage detail */}
          <div className="bg-white rounded-2xl p-6 mb-6" style={{ border: "1px solid #F0EDE8" }}>
            <h2 className="font-bold text-lg mb-5">近 30 天用量</h2>
            {usage ? (
              <div className="space-y-4">
                <UsageBar label="Prompt Tokens" value={usage.total.promptTokens} max={usage.total.totalTokens || 1} color="#E84A0A" />
                <UsageBar label="Completion Tokens" value={usage.total.completionTokens} max={usage.total.totalTokens || 1} color="#F5A623" />
                <div className="grid grid-cols-3 gap-4 pt-2">
                  {[
                    { label: "总 Tokens", value: fmtNum(usage.total.totalTokens) },
                    { label: "消耗积分", value: usage.total.chargedPoints.toLocaleString() },
                    { label: "执行次数", value: String(usage.total.runCount) },
                  ].map(({ label, value }) => (
                    <div key={label} className="text-center p-3 rounded-xl" style={{ background: "#FFF9F5" }}>
                      <div className="text-xl font-bold brand-text">{value}</div>
                      <div className="text-xs text-gray-400 mt-0.5">{label}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <Skeleton w="100%" h="1rem" />
                <Skeleton w="80%" h="1rem" />
                <Skeleton w="60%" h="1rem" />
              </div>
            )}
          </div>

          {/* Recharge */}
          {products.length > 0 && (
            <div id="recharge" className="bg-white rounded-2xl p-6 mb-6" style={{ border: "1px solid #F0EDE8" }}>
              <h2 className="font-bold text-lg mb-1">充值积分</h2>
              <p className="text-sm text-gray-400 mb-5">购买积分，用于 AI 模型调用消耗</p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {products.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => handleBuy(p.id)}
                    disabled={loadingOrder === p.id}
                    className="border rounded-xl p-4 text-left hover:border-brand transition-colors group"
                    style={{ borderColor: "#F0EDE8" }}
                  >
                    <div className="text-lg font-bold group-hover:brand-text">{p.points.toLocaleString()}</div>
                    <div className="text-xs text-gray-400 mb-2">积分</div>
                    {p.originalAmountCent && p.originalAmountCent > p.amountCent && (
                      <div className="text-xs text-gray-300 line-through">¥{(p.originalAmountCent / 100).toFixed(0)}</div>
                    )}
                    <div className="text-sm font-bold" style={{ color: "#E84A0A" }}>
                      ¥{(p.amountCent / 100).toFixed(0)}
                      {loadingOrder === p.id && <i className="fa fa-spinner fa-spin ml-1" />}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Transaction history */}
          {txs.length > 0 && (
            <div className="bg-white rounded-2xl p-6" style={{ border: "1px solid #F0EDE8" }}>
              <h2 className="font-bold text-lg mb-5">消费记录</h2>
              <div className="space-y-2">
                {txs.map((tx) => (
                  <div key={tx.id} className="flex items-center justify-between py-2.5 px-3 rounded-xl hover:bg-gray-50 transition-colors">
                    <div className="flex items-center gap-3">
                      <div
                        className="w-8 h-8 rounded-full flex items-center justify-center text-xs"
                        style={{
                          background: tx.type === "recharge" ? "#FFF5F0" : "#F5F5F5",
                          color: tx.type === "recharge" ? "#E84A0A" : "#666",
                        }}
                      >
                        <i className={`fa ${tx.type === "recharge" ? "fa-plus" : "fa-minus"}`} />
                      </div>
                      <div>
                        <div className="text-sm font-medium">
                          {tx.type === "recharge" ? "充值" : tx.type === "adjust" ? "调整" : "消耗"}
                          {tx.reason ? ` · ${tx.reason}` : ""}
                        </div>
                        <div className="text-xs text-gray-400">{fmtDate(tx.createdAt)}</div>
                      </div>
                    </div>
                    <div
                      className="text-sm font-bold"
                      style={{ color: tx.delta > 0 ? "#E84A0A" : "#666" }}
                    >
                      {tx.delta > 0 ? "+" : ""}{tx.delta.toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SideLink({ icon, label, active }: { icon: string; label: string; active?: boolean }) {
  return (
    <div
      className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm cursor-pointer transition-colors ${
        active ? "font-medium" : "text-gray-500 hover:text-gray-800 hover:bg-gray-50"
      }`}
      style={active ? { background: "#FFF5F0", color: "#E84A0A" } : undefined}
    >
      <i className={`fa ${icon} w-4 text-center`} />
      {label}
    </div>
  );
}

function UsageBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = Math.round((value / max) * 100);
  return (
    <div>
      <div className="flex justify-between text-xs text-gray-500 mb-1">
        <span>{label}</span>
        <span>{value.toLocaleString()}</span>
      </div>
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

function Skeleton({ w, h = "1.5rem" }: { w: string; h?: string }) {
  return (
    <span
      className="inline-block rounded animate-pulse"
      style={{ width: w, height: h, background: "#F0EDE8", verticalAlign: "middle" }}
    />
  );
}
