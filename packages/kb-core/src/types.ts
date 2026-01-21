export type KbCardType =
  | "concept"
  | "principle"
  | "strategy"
  | "tactic"
  | "case"
  | "warning"
  | "faq";

export type KbCard = {
  id: string;
  knowledgeBaseId?: string | null;

  title: string;
  content: string; // Markdown

  // Optional structured fields (very helpful for writing agent + citations)
  surface?: string | null;
  essence?: string | null;
  pitfalls?: string[];
  principles?: string[];
  steps?: string[];
  oneLiners?: string[];
  examples?: string[];

  type?: KbCardType;
  tags?: string[];
  keywords?: string[];

  // For vector retrieval
  embedding?: number[];
  embeddingDone?: boolean;

  // For ranking / filtering
  priority?: number; // 1~10
  isEnabled?: boolean;
  isDeleted?: boolean;
};

export type KbSemanticUnderstanding = {
  // The rewritten query for better recall; keep original query as fallback.
  rewrittenQuery?: string;

  // Terms/topics extracted from query; used for lightweight matching.
  relatedTopics?: string[];

  // Prefer certain card types for this intent.
  priorityCardTypes?: KbCardType[];

  // Confidence 0~1 (optional)
  confidence?: number;
};

export type KbSearchOptions = {
  topK?: number;
  weights?: {
    embedding?: number; // default 0.4
    topicMatch?: number; // default 0.25
    typeMatch?: number; // default 0.15
    priority?: number; // default 0.1
  };
};

export type KbScoredResult = {
  card: KbCard;
  score: number;
  matchReasons: string[];
};












