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
        <svg viewBox="0 0 256 176" className="h-[68%] w-[68%]" fill="currentColor" aria-hidden="true">
          <path d="m147.487 0l70.081 175.78H256L185.919 0zM66.183 106.221l23.98-61.774l23.98 61.774zM70.07 0L0 175.78h39.18l14.33-36.914h73.308l14.328 36.914h39.179L110.255 0z" />
        </svg>
      );
    case "openai":
      return (
        <svg viewBox="0 0 256 260" className="h-[74%] w-[74%]" fill="currentColor" aria-hidden="true">
          <path d="M239.184 106.203a64.72 64.72 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.72 64.72 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.67 64.67 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.77 64.77 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483m-97.56 136.338a48.4 48.4 0 0 1-31.105-11.255l1.535-.87l51.67-29.825a8.6 8.6 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601M37.158 197.93a48.35 48.35 0 0 1-5.781-32.589l1.534.921l51.722 29.826a8.34 8.34 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803M23.549 85.38a48.5 48.5 0 0 1 25.58-21.333v61.39a8.29 8.29 0 0 0 4.195 7.316l62.874 36.272l-21.845 12.636a.82.82 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405zm179.466 41.695l-63.08-36.63L161.73 77.86a.82.82 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.54 8.54 0 0 0-4.4-7.213m21.742-32.69l-1.535-.922l-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.72.72 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391zM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87l-51.67 29.825a8.6 8.6 0 0 0-4.246 7.367zm11.868-25.58L128.067 97.3l28.188 16.218v32.434l-28.086 16.218l-28.188-16.218z" />
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
