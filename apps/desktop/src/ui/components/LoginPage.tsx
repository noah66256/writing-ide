import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/state/authStore";

export function LoginPage() {
  const busy = useAuthStore((s) => s.busy);
  const error = useAuthStore((s) => s.error);

  const requestPhoneCode = useAuthStore((s) => s.requestPhoneCode);
  const verifyPhoneCode = useAuthStore((s) => s.verifyPhoneCode);
  const requestEmailCode = useAuthStore((s) => s.requestEmailCode);
  const verifyEmailCode = useAuthStore((s) => s.verifyEmailCode);

  const [tab, setTab] = useState<"phone" | "email">("phone");

  const [phone, setPhone] = useState("");
  const [phoneReqId, setPhoneReqId] = useState("");
  const [phoneCode, setPhoneCode] = useState("");
  const [phoneDevCode, setPhoneDevCode] = useState("");

  const [email, setEmail] = useState("");
  const [emailReqId, setEmailReqId] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [emailDevCode, setEmailDevCode] = useState("");

  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setInterval(() => setCooldown((x) => Math.max(0, x - 1)), 1000);
    return () => window.clearInterval(id);
  }, [cooldown]);

  const handleRequestPhone = async () => {
    try {
      const r = await requestPhoneCode({ phoneNumber: phone.trim(), countryCode: "86" });
      setPhoneReqId(String(r.requestId ?? ""));
      setPhoneDevCode(String(r.devCode ?? ""));
      setCooldown(60);
    } catch {
      // error 已写入 store
    }
  };

  const handleVerifyPhone = async () => {
    try {
      await verifyPhoneCode({
        phoneNumber: phone.trim(),
        countryCode: "86",
        requestId: phoneReqId,
        code: phoneCode.trim(),
      });
    } catch {
      // error 已写入 store
    }
  };

  const handleRequestEmail = async () => {
    try {
      const r = await requestEmailCode(email.trim());
      setEmailReqId(String(r.requestId ?? ""));
      setEmailDevCode(String(r.devCode ?? ""));
      setCooldown(60);
    } catch {
      // error 已写入 store
    }
  };

  const handleVerifyEmail = async () => {
    try {
      await verifyEmailCode({
        email: email.trim(),
        requestId: emailReqId,
        code: emailCode.trim(),
      });
    } catch {
      // error 已写入 store
    }
  };

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-bg text-text font-sans select-none">
      {/* macOS titlebar drag region */}
      <div
        className="fixed top-0 left-0 right-0 h-[52px] z-50"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      />

      <div className="w-full max-w-[380px] px-6">
        {/* Brand */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-accent-soft mb-5">
            <span className="text-[24px] font-bold text-accent">F</span>
          </div>
          <h1 className="text-[22px] font-semibold tracking-tight text-text mb-1.5">
            欢迎回来
          </h1>
          <p className="text-[13px] text-text-muted">登录以继续使用</p>
        </div>

        {/* Tab 切换 */}
        <div className="flex gap-1 p-1 rounded-lg bg-surface-alt mb-6">
          <button
            onClick={() => setTab("phone")}
            className={cn(
              "flex-1 py-2 rounded-md text-[13px] font-medium transition-all duration-fast",
              tab === "phone"
                ? "bg-surface text-text shadow-sm"
                : "text-text-muted hover:text-text",
            )}
          >
            手机验证码
          </button>
          <button
            onClick={() => setTab("email")}
            className={cn(
              "flex-1 py-2 rounded-md text-[13px] font-medium transition-all duration-fast",
              tab === "email"
                ? "bg-surface text-text shadow-sm"
                : "text-text-muted hover:text-text",
            )}
          >
            邮箱验证码
          </button>
        </div>

        {/* 表单 */}
        {tab === "phone" ? (
          <div className="space-y-3">
            <div className="flex gap-2">
              <input
                className={cn(
                  "flex-1 h-10 px-3 rounded-lg text-[14px]",
                  "bg-surface border border-border-soft",
                  "text-text placeholder:text-text-faint",
                  "outline-none focus:border-accent focus:ring-1 focus:ring-accent/20",
                  "transition-colors duration-fast",
                )}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="手机号"
                type="tel"
                autoFocus
              />
              <button
                className={cn(
                  "shrink-0 h-10 px-4 rounded-lg text-[13px] font-medium",
                  "transition-colors duration-fast",
                  busy || cooldown > 0 || !phone.trim()
                    ? "bg-surface-alt text-text-faint cursor-not-allowed"
                    : "bg-surface-alt text-text hover:bg-border-soft",
                )}
                disabled={busy || cooldown > 0 || !phone.trim()}
                onClick={() => void handleRequestPhone()}
              >
                {busy ? "发送中" : cooldown > 0 ? `${cooldown}s` : "获取验证码"}
              </button>
            </div>

            <div className="flex gap-2">
              <input
                className={cn(
                  "flex-1 h-10 px-3 rounded-lg text-[14px]",
                  "bg-surface border border-border-soft",
                  "text-text placeholder:text-text-faint",
                  "outline-none focus:border-accent focus:ring-1 focus:ring-accent/20",
                  "transition-colors duration-fast",
                )}
                value={phoneCode}
                onChange={(e) => setPhoneCode(e.target.value)}
                placeholder="验证码"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && phoneReqId && phoneCode.trim()) void handleVerifyPhone();
                }}
              />
              <button
                className={cn(
                  "shrink-0 h-10 px-6 rounded-lg text-[13px] font-medium",
                  "transition-all duration-fast",
                  busy || !phoneReqId || !phoneCode.trim()
                    ? "bg-accent/40 text-white/60 cursor-not-allowed"
                    : "bg-accent text-white hover:bg-accent-hover shadow-sm",
                )}
                disabled={busy || !phoneReqId || !phoneCode.trim()}
                onClick={() => void handleVerifyPhone()}
              >
                {busy ? (
                  <Loader2 size={15} className="animate-spin mx-auto" />
                ) : (
                  "登录"
                )}
              </button>
            </div>

            {phoneDevCode && (
              <div className="text-[11px] text-text-faint px-1">
                devCode: {phoneDevCode}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex gap-2">
              <input
                className={cn(
                  "flex-1 h-10 px-3 rounded-lg text-[14px]",
                  "bg-surface border border-border-soft",
                  "text-text placeholder:text-text-faint",
                  "outline-none focus:border-accent focus:ring-1 focus:ring-accent/20",
                  "transition-colors duration-fast",
                )}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="邮箱地址"
                type="email"
                autoFocus
              />
              <button
                className={cn(
                  "shrink-0 h-10 px-4 rounded-lg text-[13px] font-medium",
                  "transition-colors duration-fast",
                  busy || cooldown > 0 || !email.trim()
                    ? "bg-surface-alt text-text-faint cursor-not-allowed"
                    : "bg-surface-alt text-text hover:bg-border-soft",
                )}
                disabled={busy || cooldown > 0 || !email.trim()}
                onClick={() => void handleRequestEmail()}
              >
                {busy ? "发送中" : cooldown > 0 ? `${cooldown}s` : "获取验证码"}
              </button>
            </div>

            <div className="flex gap-2">
              <input
                className={cn(
                  "flex-1 h-10 px-3 rounded-lg text-[14px]",
                  "bg-surface border border-border-soft",
                  "text-text placeholder:text-text-faint",
                  "outline-none focus:border-accent focus:ring-1 focus:ring-accent/20",
                  "transition-colors duration-fast",
                )}
                value={emailCode}
                onChange={(e) => setEmailCode(e.target.value)}
                placeholder="验证码"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && emailReqId && emailCode.trim()) void handleVerifyEmail();
                }}
              />
              <button
                className={cn(
                  "shrink-0 h-10 px-6 rounded-lg text-[13px] font-medium",
                  "transition-all duration-fast",
                  busy || !emailReqId || !emailCode.trim()
                    ? "bg-accent/40 text-white/60 cursor-not-allowed"
                    : "bg-accent text-white hover:bg-accent-hover shadow-sm",
                )}
                disabled={busy || !emailReqId || !emailCode.trim()}
                onClick={() => void handleVerifyEmail()}
              >
                {busy ? (
                  <Loader2 size={15} className="animate-spin mx-auto" />
                ) : (
                  "登录"
                )}
              </button>
            </div>

            {emailDevCode && (
              <div className="text-[11px] text-text-faint px-1">
                devCode: {emailDevCode}
              </div>
            )}
          </div>
        )}

        {/* 错误提示 */}
        {error && (
          <div className="mt-4 px-3 py-2.5 rounded-lg bg-error/8 border border-error/15 text-[12px] text-error leading-relaxed">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
