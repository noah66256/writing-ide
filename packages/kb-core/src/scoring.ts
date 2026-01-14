import type { KbCard, KbScoredResult, KbSearchOptions, KbSemanticUnderstanding } from "./types.js";

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function clamp01(x: number) {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

function defaultWeights(options?: KbSearchOptions) {
  const w = options?.weights ?? {};
  return {
    embedding: w.embedding ?? 0.4,
    topicMatch: w.topicMatch ?? 0.25,
    typeMatch: w.typeMatch ?? 0.15,
    priority: w.priority ?? 0.1
  };
}

function getCardTerms(card: KbCard): string[] {
  const terms: string[] = [];
  if (Array.isArray(card.keywords)) terms.push(...card.keywords);
  if (Array.isArray(card.tags)) terms.push(...card.tags);
  return terms.filter(Boolean);
}

function matchTopics(topics: string[], terms: string[]): string[] {
  const matched: string[] = [];
  for (const t of topics) {
    const topic = String(t || "").trim();
    if (!topic) continue;
    const hit = terms.some((term) => {
      const s = String(term || "").trim();
      if (!s) return false;
      return s.includes(topic) || topic.includes(s);
    });
    if (hit) matched.push(topic);
  }
  return matched;
}

export function scoreCardsByEmbeddingAndSignals(params: {
  cards: KbCard[];
  queryEmbedding: number[];
  understanding?: KbSemanticUnderstanding | null;
  options?: KbSearchOptions;
}): KbScoredResult[] {
  const { cards, queryEmbedding, understanding, options } = params;
  const weights = defaultWeights(options);

  const relatedTopics = Array.isArray(understanding?.relatedTopics) ? understanding!.relatedTopics! : [];
  const priorityTypes = new Set(understanding?.priorityCardTypes ?? []);

  const results: KbScoredResult[] = [];

  for (const card of cards) {
    if (card.isDeleted) continue;
    if (card.isEnabled === false) continue;
    if (card.embeddingDone === false) continue;

    const matchReasons: string[] = [];
    let score = 0;

    // embedding score
    const emb = Array.isArray(card.embedding) ? card.embedding : [];
    const embeddingScore = clamp01(cosineSimilarity(queryEmbedding, emb));
    score += embeddingScore * weights.embedding;
    if (embeddingScore > 0.3) matchReasons.push(`语义相似 ${(embeddingScore * 100).toFixed(0)}%`);

    // topic/term match
    if (relatedTopics.length > 0) {
      const terms = getCardTerms(card);
      const matched = matchTopics(relatedTopics, terms);
      if (matched.length > 0) {
        const topicScore = matched.length / relatedTopics.length;
        score += clamp01(topicScore) * weights.topicMatch;
        matchReasons.push(`主题匹配: ${matched.join(", ")}`);
      }
    }

    // type match
    if (priorityTypes.size > 0 && card.type && priorityTypes.has(card.type)) {
      score += weights.typeMatch;
      matchReasons.push(`类型匹配: ${card.type}`);
    }

    // priority boost
    const p = typeof card.priority === "number" ? card.priority : 5;
    score += clamp01(p / 10) * weights.priority;

    results.push({ card, score, matchReasons });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}




