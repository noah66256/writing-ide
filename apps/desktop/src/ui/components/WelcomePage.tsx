import { PenLine, Search, BookOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePersonaStore } from "@/state/personaStore";

type Props = {
  onSuggest: (text: string) => void;
};

const capabilities = [
  {
    icon: PenLine,
    title: "\u5199\u4f5c",
    desc: "\u98ce\u683c\u4eff\u5199\u3001\u6539\u7a3f\u6da6\u8272",
    color: "text-accent",
    bg: "bg-accent-soft",
  },
  {
    icon: Search,
    title: "\u8c03\u7814",
    desc: "\u5168\u7f51\u641c\u7d22\u3001\u70ed\u70b9\u8ffd\u8e2a",
    color: "text-emerald-600 dark:text-emerald-400",
    bg: "bg-emerald-50 dark:bg-emerald-950/40",
  },
  {
    icon: BookOpen,
    title: "\u5b66\u98ce\u683c",
    desc: "\u8bed\u6599\u5206\u6790\u3001\u62bd\u5361\u5efa\u5e93",
    color: "text-amber-600 dark:text-amber-400",
    bg: "bg-amber-50 dark:bg-amber-950/40",
  },
] as const;

const suggestions = [
  "\u5e2e\u6211\u5199\u4e00\u7bc7\u5173\u4e8e AI \u8d8b\u52bf\u7684\u516c\u4f17\u53f7\u6587\u7ae0",
  "\u641c\u7d22\u4eca\u5929\u79d1\u6280\u5708\u7684\u70ed\u70b9\u65b0\u95fb",
  "\u5b66\u4e60\u8fd9\u6bb5\u6587\u5b57\u7684\u98ce\u683c\u5e76\u4eff\u5199\u4e00\u7bc7",
];

export function WelcomePage({ onSuggest }: Props) {
  const agentName = usePersonaStore((s) => s.agentName);
  const displayName = agentName.trim() || "Friday";

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 pb-8 select-none">
      {/* Brand */}
      <div className="mb-10 text-center">
        <div className="text-[28px] font-semibold tracking-tight text-text mb-2">
          {"\u6211\u662f "}{displayName}
        </div>
        <div className="text-[14px] text-text-muted leading-relaxed max-w-[360px]">
          {"\u4f60\u7684\u4e00\u4eba\u5185\u5bb9\u56e2\u961f"}
        </div>
      </div>

      {/* Capability cards */}
      <div className="flex gap-3 mb-10">
        {capabilities.map((cap) => (
          <button
            key={cap.title}
            className={cn(
              "flex flex-col items-center gap-2 px-6 py-4 rounded-xl",
              "border border-border-soft bg-surface/80 backdrop-blur-sm",
              "hover:border-border hover:shadow-sm",
              "transition-all duration-fast cursor-default",
              "w-[130px]",
            )}
          >
            <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center", cap.bg)}>
              <cap.icon size={18} className={cap.color} />
            </div>
            <span className="text-[13px] font-medium text-text">{cap.title}</span>
            <span className="text-[11px] text-text-faint leading-snug">{cap.desc}</span>
          </button>
        ))}
      </div>

      {/* Suggested prompts */}
      <div className="flex flex-col gap-2 w-full max-w-[460px]">
        {suggestions.map((s) => (
          <button
            key={s}
            onClick={() => onSuggest(s)}
            className={cn(
              "text-left px-4 py-2.5 rounded-lg",
              "text-[13px] text-text-muted",
              "border border-transparent hover:border-border-soft hover:bg-surface/60",
              "transition-all duration-fast",
            )}
          >
            <span className="text-text-faint mr-2">{"\u2192"}</span>
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
