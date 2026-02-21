import { PenLine, Search, BookOpen } from "lucide-react";
import { cn } from "@/lib/utils";

type Props = {
  onSuggest: (text: string) => void;
};

const capabilities = [
  {
    icon: PenLine,
    title: "写作",
    desc: "风格仿写、改稿润色",
    color: "text-accent",
    bg: "bg-accent-soft",
  },
  {
    icon: Search,
    title: "调研",
    desc: "全网搜索、热点追踪",
    color: "text-emerald-600 dark:text-emerald-400",
    bg: "bg-emerald-50 dark:bg-emerald-950/40",
  },
  {
    icon: BookOpen,
    title: "学风格",
    desc: "语料分析、抽卡建库",
    color: "text-amber-600 dark:text-amber-400",
    bg: "bg-amber-50 dark:bg-amber-950/40",
  },
] as const;

const suggestions = [
  "帮我写一篇关于 AI 趋势的公众号文章",
  "搜索今天科技圈的热点新闻",
  "学习这段文字的风格并仿写一篇",
];

export function WelcomePage({ onSuggest }: Props) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 pb-8 select-none">
      {/* Brand */}
      <div className="mb-10 text-center">
        <div className="text-[28px] font-semibold tracking-tight text-text mb-2">
          写作，从对话开始
        </div>
        <div className="text-[14px] text-text-muted leading-relaxed max-w-[360px]">
          AI 写作助手 — 风格仿写、全网调研、语料分析、批量创作
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
            <span className="text-text-faint mr-2">→</span>
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
