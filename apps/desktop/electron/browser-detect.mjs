/**
 * 系统级 Chromium 浏览器自动检测
 *
 * 按优先级探测 macOS / Windows / Linux 上的 Chromium 系浏览器，
 * 返回第一个找到的可执行文件路径。供 MCP Server 等组件使用。
 */
import { access } from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";

/** @typedef {{ found: boolean, path: string | null, name: string | null }} BrowserResult */

const NOT_FOUND = /** @type {BrowserResult} */ ({ found: false, path: null, name: null });

// ── macOS ────────────────────────────────────────
const MAC_CANDIDATES = [
  { name: "Google Chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
  { name: "Chromium", path: "/Applications/Chromium.app/Contents/MacOS/Chromium" },
  { name: "Microsoft Edge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
  { name: "Brave Browser", path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" },
];

// ── Windows ──────────────────────────────────────
function getWindowsCandidates() {
  const roots = [
    process.env.PROGRAMFILES,
    process.env["PROGRAMFILES(X86)"],
    process.env.LOCALAPPDATA,
  ].filter(Boolean);
  const unique = [...new Set(roots)];
  /** @type {{ name: string, path: string }[]} */
  const list = [];
  for (const root of unique) {
    list.push({ name: "Google Chrome", path: path.join(root, "Google", "Chrome", "Application", "chrome.exe") });
    list.push({ name: "Microsoft Edge", path: path.join(root, "Microsoft", "Edge", "Application", "msedge.exe") });
    list.push({ name: "Brave Browser", path: path.join(root, "BraveSoftware", "Brave-Browser", "Application", "brave.exe") });
  }
  return list;
}

// ── Linux ────────────────────────────────────────
const LINUX_BINS = [
  { name: "Google Chrome", cmd: "google-chrome" },
  { name: "Google Chrome Stable", cmd: "google-chrome-stable" },
  { name: "Chromium", cmd: "chromium" },
  { name: "Chromium Browser", cmd: "chromium-browser" },
  { name: "Microsoft Edge", cmd: "microsoft-edge" },
  { name: "Brave Browser", cmd: "brave-browser" },
];

// ── 工具 ─────────────────────────────────────────
async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** @param {{ name: string, path: string }[]} candidates */
async function findFirst(candidates) {
  for (const c of candidates) {
    if (await pathExists(c.path)) {
      return /** @type {BrowserResult} */ ({ found: true, path: c.path, name: c.name });
    }
  }
  return NOT_FOUND;
}

function detectLinuxViaWhich() {
  for (const bin of LINUX_BINS) {
    try {
      const resolved = execSync(`which ${bin.cmd}`, { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
      if (resolved) return { name: bin.name, path: resolved };
    } catch {
      // 找不到，继续下一个
    }
  }
  return null;
}

// ── 导出 ─────────────────────────────────────────

/** 检测系统上第一个可用的 Chromium 系浏览器 */
export async function detectBrowser() {
  if (process.platform === "darwin") return findFirst(MAC_CANDIDATES);

  if (process.platform === "win32") return findFirst(getWindowsCandidates());

  if (process.platform === "linux") {
    const hit = detectLinuxViaWhich();
    if (hit && (await pathExists(hit.path))) {
      return /** @type {BrowserResult} */ ({ found: true, path: hit.path, name: hit.name });
    }
  }

  return NOT_FOUND;
}
