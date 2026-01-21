export type TopicLabInput = {
  seed?: string;
  platformType?: "feed_preview" | "search_click" | "long_subscription";
  persona?: string;
  audience?: string;
  goal?: string;
  useKb?: boolean;
  useWebSearch?: boolean;
};

export type TopicCandidate = {
  topic: string;
  angle: string;
  titles: string[];
  hook: string;
  outline: string[];
  risks: string[];
};

export type TopicLabOutput = {
  topics: TopicCandidate[];
};

function pick<T>(arr: T[], i: number) {
  return arr[Math.abs(i) % arr.length];
}

export function generateTopicLab(input: TopicLabInput): TopicLabOutput {
  const seed = (input.seed ?? "").trim();
  const persona = input.persona ?? "普通创作者";
  const audience = input.audience ?? "大众";
  const goal = input.goal ?? "提升理解/转化";

  const topicBases = [
    "用 AI 把写作从“灵感驱动”变成“工程化生产”",
    "普通人如何用 AI 做个人知识库并持续输出",
    "如何写出能被平台推荐的开头与结构",
    "写作卡壳时的 10 个“结构化推进”方法",
    "从爆款拆解到仿写：一套可复用的写作 SOP",
  ];

  const angles = [
    "用一个最小闭环把效率拉满",
    "避开 5 个最常见坑，少走弯路",
    "用对比法：传统写法 vs AI 写法",
    "用案例拆解：从 0 到 1 写出可发布版本",
    "用清单法：照着做就能出稿",
  ];

  const platformHint =
    input.platformType === "feed_preview"
      ? "（前 3 秒钩子优先）"
      : input.platformType === "search_click"
        ? "（标题/封面优先）"
        : input.platformType === "long_subscription"
          ? "（章节结构优先）"
          : "";

  const topics: TopicCandidate[] = Array.from({ length: 8 }).map((_, idx) => {
    const base = pick(topicBases, seed.length + idx);
    const angle = pick(angles, seed.length * 3 + idx);
    const topic = seed ? `${seed}：${base}` : base;

    const titles = [
      `${base}：一套能每天稳定输出的最小闭环`,
      `${persona}也能用的写作 IDE 思路：从选题到成稿`,
      `别再靠灵感了：${base}（含模板）${platformHint}`,
      `${audience}最吃这一套：开头、结构、金句怎么来？`,
      `我把“选题→大纲→成稿”做成可回滚流程，效果惊人`,
    ];

    return {
      topic,
      angle,
      titles,
      hook: `先给你一句结论：选题对了，后面写作只是在“把结构填满”。${platformHint}`,
      outline: [
        "问题：为什么大多数人卡在选题/开头？",
        "方法：用平台画像+对标库做筛选",
        "产出：给出 1 个可直接套用的结构模板",
        "案例：把一个选题跑完整个闭环（含改写/校验）",
        `收尾：给 ${goal} 的行动清单`,
      ],
      risks: [
        input.useWebSearch ? "若使用联网趋势，请务必携带来源引用。" : "默认不联网，趋势判断可能偏保守。",
        input.useKb ? "若启用 KB，请注意去重按 source_doc 分组。" : "未启用 KB，对标可能不够贴合你的人设。",
      ],
    };
  });

  return { topics };
}












