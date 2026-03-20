import type { ThreadCapabilityState } from "@ohmycrab/shared";
import type { McpCapabilityCard } from "./capabilityIndex.js";

const MAX_ACTIVE_MCP_CAPABILITIES = 8;
const MAX_ACTIVE_SKILLS = 6;
const MAX_STICKY_CAPABILITIES = 8;
const MAX_STICKY_SKILLS = 6;
const MAX_RECENTLY_DESCRIBED_IDS = 16;

function normalizeId(raw: unknown): string {
  return String(raw ?? "").trim();
}

function dedupeBounded(raw: unknown, limit: number): string[] {
  const out: string[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const id = normalizeId(item);
    if (!id || out.includes(id)) continue;
    out.push(id);
  }
  if (out.length > limit) return out.slice(out.length - limit);
  return out;
}

function moveToTail(list: string[], id: string, limit: number): string[] {
  const next = list.filter((item) => item !== id);
  next.push(id);
  if (next.length > limit) return next.slice(next.length - limit);
  return next;
}

function trimActivationMap(
  map: Record<string, number> | undefined,
  keepIds: string[],
): Record<string, number> | undefined {
  const src = map && typeof map === "object" ? map : null;
  if (!src) return undefined;
  const keep = new Set(keepIds.map((id) => normalizeId(id)).filter(Boolean));
  const out: Record<string, number> = {};
  for (const [id, ts] of Object.entries(src)) {
    if (!keep.has(id)) continue;
    const value = Number(ts);
    if (!Number.isFinite(value)) continue;
    out[id] = Math.floor(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function createEmptyThreadCapabilityState(): ThreadCapabilityState {
  return {
    v: 1,
    activeMcpCapabilityIds: [],
    activeSkillIds: [],
    stickyCapabilityIds: [],
    stickySkillIds: [],
    recentlyDescribedIds: [],
  };
}

export function normalizeThreadCapabilityState(raw: unknown): ThreadCapabilityState {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const activeMcpCapabilityIds = dedupeBounded(src?.activeMcpCapabilityIds, MAX_ACTIVE_MCP_CAPABILITIES);
  const activeSkillIds = dedupeBounded(src?.activeSkillIds, MAX_ACTIVE_SKILLS);
  const stickyCapabilityIds = dedupeBounded(src?.stickyCapabilityIds, MAX_STICKY_CAPABILITIES);
  const stickySkillIds = dedupeBounded(src?.stickySkillIds, MAX_STICKY_SKILLS);
  const recentlyDescribedIds = dedupeBounded(src?.recentlyDescribedIds, MAX_RECENTLY_DESCRIBED_IDS);
  const keepIds = [
    ...activeMcpCapabilityIds,
    ...activeSkillIds,
    ...stickyCapabilityIds,
    ...stickySkillIds,
    ...recentlyDescribedIds,
  ];
  return {
    v: 1,
    activeMcpCapabilityIds,
    activeSkillIds,
    stickyCapabilityIds,
    stickySkillIds,
    recentlyDescribedIds,
    lastActivatedAt: trimActivationMap(src?.lastActivatedAt as Record<string, number> | undefined, keepIds),
  };
}

export function rememberDescribedCapability(args: {
  state: ThreadCapabilityState | null | undefined;
  id: string;
}): ThreadCapabilityState {
  const id = normalizeId(args.id);
  const base = normalizeThreadCapabilityState(args.state);
  if (!id) return base;
  return {
    ...base,
    recentlyDescribedIds: moveToTail(base.recentlyDescribedIds, id, MAX_RECENTLY_DESCRIBED_IDS),
  };
}

export function activateMcpCapability(args: {
  state: ThreadCapabilityState | null | undefined;
  capabilityId: string;
}): ThreadCapabilityState {
  const capabilityId = normalizeId(args.capabilityId);
  const base = normalizeThreadCapabilityState(args.state);
  if (!capabilityId) return base;
  const ts = Date.now();
  const keepIds = [
    ...base.activeSkillIds,
    ...base.stickySkillIds,
    ...moveToTail(base.activeMcpCapabilityIds, capabilityId, MAX_ACTIVE_MCP_CAPABILITIES),
    ...moveToTail(base.stickyCapabilityIds, capabilityId, MAX_STICKY_CAPABILITIES),
    ...moveToTail(base.recentlyDescribedIds, capabilityId, MAX_RECENTLY_DESCRIBED_IDS),
  ];
  return {
    ...base,
    activeMcpCapabilityIds: moveToTail(base.activeMcpCapabilityIds, capabilityId, MAX_ACTIVE_MCP_CAPABILITIES),
    stickyCapabilityIds: moveToTail(base.stickyCapabilityIds, capabilityId, MAX_STICKY_CAPABILITIES),
    recentlyDescribedIds: moveToTail(base.recentlyDescribedIds, capabilityId, MAX_RECENTLY_DESCRIBED_IDS),
    lastActivatedAt: trimActivationMap(
      { ...(base.lastActivatedAt ?? {}), [capabilityId]: ts },
      keepIds,
    ),
  };
}

export function activateSkillCapability(args: {
  state: ThreadCapabilityState | null | undefined;
  skillId: string;
}): ThreadCapabilityState {
  const skillId = normalizeId(args.skillId);
  const base = normalizeThreadCapabilityState(args.state);
  if (!skillId) return base;
  const ts = Date.now();
  const skillCardId = skillId.startsWith("skill:") ? skillId : `skill:${skillId}`;
  const keepIds = [
    ...base.activeMcpCapabilityIds,
    ...base.stickyCapabilityIds,
    ...moveToTail(base.activeSkillIds, skillId, MAX_ACTIVE_SKILLS),
    ...moveToTail(base.stickySkillIds, skillId, MAX_STICKY_SKILLS),
    ...moveToTail(base.recentlyDescribedIds, skillCardId, MAX_RECENTLY_DESCRIBED_IDS),
  ];
  return {
    ...base,
    activeSkillIds: moveToTail(base.activeSkillIds, skillId, MAX_ACTIVE_SKILLS),
    stickySkillIds: moveToTail(base.stickySkillIds, skillId, MAX_STICKY_SKILLS),
    recentlyDescribedIds: moveToTail(base.recentlyDescribedIds, skillCardId, MAX_RECENTLY_DESCRIBED_IDS),
    lastActivatedAt: trimActivationMap(
      { ...(base.lastActivatedAt ?? {}), [skillId]: ts },
      keepIds,
    ),
  };
}

export function clearThreadCapabilityStateForNewTask(
  state: ThreadCapabilityState | null | undefined,
): ThreadCapabilityState {
  const base = normalizeThreadCapabilityState(state);
  const keepIds = [...base.activeSkillIds, ...base.stickySkillIds, ...base.stickyCapabilityIds];
  return {
    ...base,
    activeMcpCapabilityIds: [],
    recentlyDescribedIds: [],
    lastActivatedAt: trimActivationMap(base.lastActivatedAt, keepIds),
  };
}

export function resolveMcpToolNamesForCapabilityIds(args: {
  capabilityIds: string[];
  cards: McpCapabilityCard[];
}): string[] {
  const wanted = new Set((args.capabilityIds ?? []).map((id) => normalizeId(id)).filter(Boolean));
  if (wanted.size === 0) return [];
  const out: string[] = [];
  for (const card of Array.isArray(args.cards) ? args.cards : []) {
    if (!wanted.has(card.id)) continue;
    for (const tool of Array.isArray(card.tools) ? card.tools : []) {
      const name = normalizeId(tool?.name);
      if (!name || out.includes(name)) continue;
      out.push(name);
    }
  }
  return out;
}

export function resolveMcpServerIdsForCapabilityIds(args: {
  capabilityIds: string[];
  cards: McpCapabilityCard[];
}): string[] {
  const wanted = new Set((args.capabilityIds ?? []).map((id) => normalizeId(id)).filter(Boolean));
  if (wanted.size === 0) return [];
  const out: string[] = [];
  for (const card of Array.isArray(args.cards) ? args.cards : []) {
    if (!wanted.has(card.id)) continue;
    const serverId = normalizeId(card.serverId);
    if (!serverId || out.includes(serverId)) continue;
    out.push(serverId);
  }
  return out;
}

export function findMcpCapabilityIdForToolName(args: {
  toolName: string;
  cards: McpCapabilityCard[];
}): string | null {
  const toolName = normalizeId(args.toolName);
  if (!toolName) return null;
  for (const card of Array.isArray(args.cards) ? args.cards : []) {
    if ((card.tools ?? []).some((tool) => normalizeId(tool?.name) === toolName)) {
      return card.id;
    }
  }
  return null;
}
