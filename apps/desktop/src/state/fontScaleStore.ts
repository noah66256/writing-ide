import { create } from "zustand";
import { persist } from "zustand/middleware";

export const MIN_FONT_SCALE = 0.85;
export const MAX_FONT_SCALE = 1.3;
export const DEFAULT_FONT_SCALE = 1;

const STORAGE_KEY = "writing-ide.fontScale";
const BASE_ATTR = "data-font-scale-base";
const ORIG_INLINE_ATTR = "data-font-scale-orig-inline";

let currentScale = DEFAULT_FONT_SCALE;
let observer: MutationObserver | null = null;
let isApplying = false;

type FontScaleState = {
  fontScale: number;
  setFontScale: (scale: number) => void;
};

function clampFontScale(scale: number) {
  if (!Number.isFinite(scale)) return DEFAULT_FONT_SCALE;
  const next = Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, scale));
  return Number(next.toFixed(2));
}

function applyFontScale(scale: number) {
  if (typeof document === "undefined") return;
  const next = clampFontScale(scale);
  currentScale = next;
  ensureObserver();
  applyTextScaleToDom(next);
}

function ensureObserver() {
  if (typeof document === "undefined" || observer || typeof MutationObserver === "undefined") return;
  const root = document.body;
  if (!root) return;
  observer = new MutationObserver((mutations) => {
    if (isApplying || currentScale === DEFAULT_FONT_SCALE) return;
    isApplying = true;
    try {
      for (const m of mutations) {
        if (m.type === "childList") {
          for (const node of Array.from(m.addedNodes)) {
            if (node instanceof HTMLElement) applyNodeTree(node, currentScale);
          }
        } else if (m.type === "attributes" && m.target instanceof HTMLElement) {
          // class/style 变化后，重新按当前 scale 应用，保证动态节点一致。
          applyNode(m.target, currentScale);
        }
      }
    } finally {
      isApplying = false;
    }
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style"],
  });
}

function shouldSkipElement(el: HTMLElement): boolean {
  const t = el.tagName;
  return t === "SCRIPT" || t === "STYLE" || t === "META" || t === "LINK" || t === "NOSCRIPT";
}

function getBaseFontPx(el: HTMLElement): number | null {
  const raw = Number(el.getAttribute(BASE_ATTR));
  if (Number.isFinite(raw) && raw > 0) return raw;
  const computedPx = Number.parseFloat(window.getComputedStyle(el).fontSize);
  if (!Number.isFinite(computedPx) || computedPx <= 0) return null;
  // 首次记录：把当前字号视为基线字号（scale=1）。
  el.setAttribute(BASE_ATTR, String(Number(computedPx.toFixed(4))));
  if (!el.hasAttribute(ORIG_INLINE_ATTR)) {
    el.setAttribute(ORIG_INLINE_ATTR, el.style.fontSize || "");
  }
  return computedPx;
}

function applyNode(el: HTMLElement, scale: number) {
  if (shouldSkipElement(el)) return;
  const base = getBaseFontPx(el);
  if (!base) return;

  if (scale === DEFAULT_FONT_SCALE) {
    const orig = el.getAttribute(ORIG_INLINE_ATTR) ?? "";
    if (orig) el.style.fontSize = orig;
    else el.style.removeProperty("font-size");
    return;
  }

  const next = Number((base * scale).toFixed(2));
  el.style.fontSize = `${next}px`;
}

function applyNodeTree(root: HTMLElement, scale: number) {
  applyNode(root, scale);
  const all = root.querySelectorAll<HTMLElement>("*");
  for (const el of Array.from(all)) applyNode(el, scale);
}

function applyTextScaleToDom(scale: number) {
  if (typeof document === "undefined") return;
  const root = document.body;
  if (!root) return;
  isApplying = true;
  try {
    if (scale === DEFAULT_FONT_SCALE) {
      const scaledNodes = root.querySelectorAll<HTMLElement>(`[${BASE_ATTR}]`);
      for (const el of Array.from(scaledNodes)) applyNode(el, scale);
      return;
    }
    applyNodeTree(root, scale);
  } finally {
    isApplying = false;
  }
}

export const useFontScaleStore = create<FontScaleState>()(
  persist(
    (set) => ({
      fontScale: DEFAULT_FONT_SCALE,
      setFontScale: (scale) => {
        const next = clampFontScale(scale);
        applyFontScale(next);
        set({ fontScale: next });
      },
    }),
    {
      name: STORAGE_KEY,
      onRehydrateStorage: () => (state) => {
        applyFontScale(state?.fontScale ?? DEFAULT_FONT_SCALE);
      },
    },
  ),
);

if (typeof document !== "undefined") {
  const stored = (() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const val = Number(parsed?.state?.fontScale);
      return Number.isFinite(val) ? val : null;
    } catch {
      return null;
    }
  })();
  applyFontScale(stored ?? DEFAULT_FONT_SCALE);
}
