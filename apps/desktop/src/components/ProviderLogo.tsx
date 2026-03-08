import { cn } from "@/lib/utils";

export type ProviderBrand = {
  key: string;
  label: string;
  className: string;
  textClassName?: string;
};

function normalizeToken(value?: string | null): string {
  return String(value ?? "").trim().toLowerCase();
}

export function resolveProviderBrand(args: {
  providerId?: string | null;
  providerName?: string | null;
  modelId?: string | null;
  label?: string | null;
}): ProviderBrand {
  const haystack = [args.providerId, args.providerName, args.modelId, args.label]
    .map((item) => normalizeToken(item))
    .filter(Boolean)
    .join(" ");

  if (/(anthropic|claude|sonnet|opus|haiku)/.test(haystack)) {
    return {
      key: "anthropic",
      label: "Anthropic",
      className: "bg-[#F4E7D3] text-[#191919] border-[#E7D3B8]",
    };
  }
  if (/(openai|gpt|o1|o3|o4|chatgpt)/.test(haystack)) {
    return {
      key: "openai",
      label: "OpenAI",
      className: "bg-[#101010] text-white border-[#101010]",
    };
  }
  if (/(google|gemini)/.test(haystack)) {
    return {
      key: "google",
      label: "Google",
      className: "bg-white text-[#1A73E8] border-[#DADCE0]",
      textClassName: "font-semibold",
    };
  }
  if (/(xai|grok)/.test(haystack)) {
    return {
      key: "xai",
      label: "xAI",
      className: "bg-[#111111] text-white border-[#2A2A2A]",
    };
  }
  if (/(openrouter)/.test(haystack)) {
    return {
      key: "openrouter",
      label: "OpenRouter",
      className: "bg-[#6D5EF7] text-white border-[#6D5EF7]",
    };
  }
  return {
    key: normalizeToken(args.providerId) || normalizeToken(args.providerName) || "other",
    label: String(args.providerName ?? args.providerId ?? "其它") || "其它",
    className: "bg-surface-alt text-text-muted border-border",
  };
}

function Glyph({ brand }: { brand: ProviderBrand }) {
  switch (brand.key) {
    case "anthropic":
      return (
        <svg viewBox="0 0 24 24" className="h-[72%] w-[72%]" fill="currentColor" aria-hidden="true">
          <path d="M12.1 4 18 20h-2.9l-1.15-3.3H9.98L8.8 20H6L11.88 4h.22Zm1.08 10.3L12 10.62 10.8 14.3h2.38Z" />
        </svg>
      );
    case "openai":
      return (
        <svg viewBox="0 0 24 24" className="h-[76%] w-[76%]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 4.3 16.8 7v5.4L12 15.1 7.2 12.4V7L12 4.3Z" />
          <path d="M7.2 7 12 9.7 16.8 7" />
          <path d="M7.2 12.4 12 9.7l4.8 2.7" />
          <path d="M12 15.1V9.7" />
        </svg>
      );
    case "google":
      return (
        <svg viewBox="0 0 24 24" className="h-[76%] w-[76%]" aria-hidden="true">
          <path fill="#4285F4" d="M21 12.25c0-.78-.07-1.52-.2-2.25H12v4.26h5.03a4.3 4.3 0 0 1-1.87 2.82v2.34h3.03A9.15 9.15 0 0 0 21 12.25Z" />
          <path fill="#34A853" d="M12 21a8.97 8.97 0 0 0 6.19-2.28l-3.03-2.34c-.84.56-1.92.9-3.16.9-2.43 0-4.48-1.64-5.22-3.84H3.64v2.42A9 9 0 0 0 12 21Z" />
          <path fill="#FBBC05" d="M6.78 13.44A5.39 5.39 0 0 1 6.5 12c0-.5.1-.98.28-1.44V8.14H3.64A9 9 0 0 0 3 12c0 1.45.35 2.82.97 4.06l2.81-2.62Z" />
          <path fill="#EA4335" d="M12 6.72c1.32 0 2.5.45 3.43 1.32l2.57-2.57A8.94 8.94 0 0 0 12 3a9 9 0 0 0-8.36 5.14l3.14 2.42C7.52 8.36 9.57 6.72 12 6.72Z" />
        </svg>
      );
    case "xai":
      return (
        <svg viewBox="0 0 24 24" className="h-[76%] w-[76%]" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <path d="M6 5 18 19" />
          <path d="M18 5 6 19" />
        </svg>
      );
    case "openrouter":
      return (
        <svg viewBox="0 0 24 24" className="h-[76%] w-[76%]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 12h14" />
          <path d="m12 5 7 7-7 7" />
        </svg>
      );
    default:
      return <span className="text-[70%] leading-none">·</span>;
  }
}

export function ProviderLogo({
  brand,
  size = 18,
  className,
}: {
  brand: ProviderBrand;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full border leading-none",
        brand.className,
        brand.textClassName,
        className,
      )}
      style={{ width: size, height: size }}
      aria-hidden="true"
      title={brand.label}
    >
      <Glyph brand={brand} />
    </span>
  );
}
