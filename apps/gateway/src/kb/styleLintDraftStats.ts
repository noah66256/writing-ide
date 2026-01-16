function normalizeText(text: string) {
  return String(text ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function splitSentences(text: string) {
  const t = normalizeText(text);
  const parts = t
    .split(/[\n。！？!?]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : t.trim() ? [t.trim()] : [];
}

function countRegex(text: string, re: RegExp) {
  const m = text.match(re);
  return m ? m.length : 0;
}

function clamp01(x: number) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

export function computeDraftStatsForStyleLint(text: string) {
  const t = normalizeText(text);
  const chars = t.length;
  const sentences = splitSentences(t);
  const sentenceCount = sentences.length;

  const avgSentenceLen = sentenceCount ? sentences.reduce((a, s) => a + s.length, 0) / sentenceCount : 0;
  const shortSentenceRate = sentenceCount ? sentences.filter((s) => s.length <= 12).length / sentenceCount : 0;

  const questionSentences = sentenceCount
    ? sentences.filter((s) => /[？?]/.test(s) || /(吗|呢|为什么|怎么|何以|问题来了)/.test(s)).length
    : 0;
  const questionRatePer100Sentences = sentenceCount ? (questionSentences / sentenceCount) * 100 : 0;

  const exclaimSentences = sentenceCount ? sentences.filter((s) => /[！!]/.test(s)).length : 0;
  const exclaimRatePer100Sentences = sentenceCount ? (exclaimSentences / sentenceCount) * 100 : 0;

  const per1k = (n: number) => (chars ? (n / chars) * 1000 : 0);
  const firstPersonPer1kChars = per1k(countRegex(t, /我|咱|咱们|我们/g));
  const secondPersonPer1kChars = per1k(countRegex(t, /你|你们/g));
  const particlePer1kChars = per1k(countRegex(t, /啊|呢|吧|呀|哎|诶|呐/g));
  const digitPer1kChars = per1k(countRegex(t, /\d/g));

  return {
    chars,
    sentences: sentenceCount,
    stats: {
      questionRatePer100Sentences: Number(questionRatePer100Sentences.toFixed(2)),
      exclaimRatePer100Sentences: Number(exclaimRatePer100Sentences.toFixed(2)),
      avgSentenceLen: Number(avgSentenceLen.toFixed(2)),
      shortSentenceRate: Number(clamp01(shortSentenceRate).toFixed(4)),
      firstPersonPer1kChars: Number(firstPersonPer1kChars.toFixed(2)),
      secondPersonPer1kChars: Number(secondPersonPer1kChars.toFixed(2)),
      particlePer1kChars: Number(particlePer1kChars.toFixed(2)),
      digitPer1kChars: Number(digitPer1kChars.toFixed(2)),
    },
  };
}


