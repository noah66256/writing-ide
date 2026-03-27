import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { requestPhoneCode, verifyPhoneCode } from "../api/gateway.ts";
import { setAccessToken } from "../api/client.ts";

type Step = "phone" | "code";

export default function LoginPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [error, setError] = useState("");

  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault();
    if (!phone.match(/^1[3-9]\d{9}$/)) {
      setError("请输入正确的手机号");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await requestPhoneCode(phone);
      setStep("code");
      // Start 60s countdown
      setCountdown(60);
      const timer = setInterval(() => {
        setCountdown((c) => {
          if (c <= 1) { clearInterval(timer); return 0; }
          return c - 1;
        });
      }, 1000);
    } catch (err: unknown) {
      const e = err as { code?: string };
      setError(e?.code === "RATE_LIMITED" ? "发送太频繁，请稍后再试" : "发送失败，请重试");
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (code.length < 4) { setError("请输入验证码"); return; }
    setLoading(true);
    setError("");
    try {
      const { token } = await verifyPhoneCode(phone, code);
      setAccessToken(token);
      navigate("/dashboard", { replace: true });
    } catch (err: unknown) {
      const e = err as { code?: string };
      setError(e?.code === "INVALID_CODE" ? "验证码错误，请重新输入" : "验证失败，请重试");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "linear-gradient(135deg, #FFF5EE 0%, #FFFDF9 100%)" }}>
      {/* Nav */}
      <nav className="nav-blur fixed top-0 left-0 right-0 z-50">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center">
          <Link to="/" className="flex items-center gap-2.5 font-bold text-[17px] text-gray-900 no-underline">
            <img src="/icon.png" className="w-7 h-7 rounded-lg" alt="logo" />
            <span>Oh My Crab</span>
          </Link>
        </div>
      </nav>

      {/* Card */}
      <div className="flex-1 flex items-center justify-center px-4 pt-20">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-8" style={{ border: "1px solid #F0EDE8" }}>
          {/* Logo */}
          <div className="text-center mb-8">
            <img src="/icon.png" className="w-14 h-14 rounded-2xl mx-auto mb-4" alt="logo" />
            <h1 className="text-2xl font-bold text-gray-900">登录 Oh My Crab</h1>
            <p className="text-sm text-gray-400 mt-1">使用手机号快速登录 / 注册</p>
          </div>

          {step === "phone" ? (
            <form onSubmit={handleSendCode} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">手机号</label>
                <div className="flex items-center border rounded-xl overflow-hidden" style={{ borderColor: "#E8E4DE" }}>
                  <span className="px-3 text-gray-400 text-sm border-r py-3" style={{ borderColor: "#E8E4DE", background: "#FAFAF8" }}>+86</span>
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 11))}
                    placeholder="请输入手机号"
                    className="flex-1 px-3 py-3 text-sm outline-none bg-white"
                    autoFocus
                  />
                </div>
              </div>
              {error && <p className="text-red-500 text-xs">{error}</p>}
              <button type="submit" disabled={loading} className="btn-brand w-full justify-center py-3">
                {loading ? <><i className="fa fa-spinner fa-spin" /> 发送中...</> : "获取验证码"}
              </button>
            </form>
          ) : (
            <form onSubmit={handleVerify} className="space-y-4">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-sm font-medium text-gray-700">验证码</label>
                  <button
                    type="button"
                    onClick={() => { setStep("phone"); setCode(""); setError(""); }}
                    className="text-xs text-gray-400 hover:text-gray-600"
                  >
                    换手机号
                  </button>
                </div>
                <p className="text-xs text-gray-400 mb-3">已发送至 +86 {phone}</p>
                <input
                  type="text"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="请输入 6 位验证码"
                  className="w-full border rounded-xl px-4 py-3 text-sm outline-none tracking-widest text-center text-lg font-bold"
                  style={{ borderColor: "#E8E4DE" }}
                  autoFocus
                />
              </div>
              {error && <p className="text-red-500 text-xs">{error}</p>}
              <button type="submit" disabled={loading} className="btn-brand w-full justify-center py-3">
                {loading ? <><i className="fa fa-spinner fa-spin" /> 验证中...</> : "登录 / 注册"}
              </button>
              <div className="text-center">
                {countdown > 0 ? (
                  <span className="text-xs text-gray-400">{countdown}s 后可重新发送</span>
                ) : (
                  <button
                    type="button"
                    onClick={(e) => { setCode(""); handleSendCode(e as unknown as React.FormEvent); }}
                    className="text-xs text-brand hover:underline"
                  >
                    重新发送验证码
                  </button>
                )}
              </div>
            </form>
          )}

          <p className="text-xs text-gray-400 text-center mt-6 leading-relaxed">
            登录即代表你同意{" "}
            <a href="#" className="text-brand hover:underline">服务条款</a>{" "}和{" "}
            <a href="#" className="text-brand hover:underline">隐私政策</a>
          </p>
        </div>
      </div>

      <div className="pb-8 text-center text-xs text-gray-400">
        © 2025 Oh My Crab
      </div>
    </div>
  );
}
