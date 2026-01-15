import type { KbCard, KbScoredResult, KbSearchOptions, KbSemanticUnderstanding } from "./types.js";
import { scoreCardsByEmbeddingAndSignals } from "./scoring.js";

export function buildSearchQuery(query: string, understanding?: KbSemanticUnderstanding | null): string {
  const rewritten = String(understanding?.rewrittenQuery ?? "").trim();
  const original = String(query ?? "").trim();
  if (!rewritten) return original;
  // keep both for recall
  return `${rewritten}\n${original}`;
}

export function kbSearch(params: {
  query: string;
  candidates: KbCard[];
  queryEmbedding: number[];
  understanding?: KbSemanticUnderstanding | null;
  options?: KbSearchOptions;
}): { results: KbScoredResult[] } {
  const topK = params.options?.topK ?? 10;
  const scored = scoreCardsByEmbeddingAndSignals({
    cards: params.candidates,
    queryEmbedding: params.queryEmbedding,
    understanding: params.understanding,
    options: params.options
  });
  return { results: scored.slice(0, topK) };
}









