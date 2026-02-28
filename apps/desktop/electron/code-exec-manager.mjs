/**
 * 沙箱化代码执行管理器（Desktop Electron main process）
 *
 * 职责：
 * 1) 检测系统 Python3 + 管理 per-project venv
 * 2) 沙箱化 spawn 执行脚本（路径校验 + 超时 + 进程树清理）
 * 3) 收集执行产物（glob 匹配）
 * 4) 并发控制（全局最多 MAX_CONCURRENT 个执行）
 */
import path from "node:path";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

// ── 常量 ─────────────────────────────────────────

const MAX_CONCURRENT = 2;
const MAX_LOG_BYTES = 256 * 1024; // stdout/stderr 各 256KB
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const VENV_TIMEOUT_MS = 120_000;
const PYTHON_DETECT_TIMEOUT_MS = 8_000;

const DEFAULT_ARTIFACT_GLOBS = [
  "**/*.pptx",
  "**/*.docx",
  "**/*.xlsx",
  "**/*.pdf",
  "**/*.png",
  "**/*.jpg",
  "**/*.jpeg",
  "**/*.svg",
  "**/*.csv",
  "**/*.html",
];

// ── 工具函数 ─────────────────────────────────────

function norm(p) {
  return String(p ?? "").replaceAll("\\", "/");
}

function normGlob(p) {
  return norm(String(p ?? "").trim()).replace(/^\.\//, "");
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 检查 target 是否在 root 目录内（含 root 自身）。
 * Windows 大小写不敏感比较。
 */
function isPathInside(root, target) {
  const r = path.resolve(String(root ?? ""));
  const t = path.resolve(String(target ?? ""));
  if (!r || !t) return false;

  if (process.platform === "win32") {
    const rl = r.toLowerCase();
    const tl = t.toLowerCase();
    return tl === rl || tl.startsWith(`${rl}${path.sep}`);
  }
  return t === r || t.startsWith(`${r}${path.sep}`);
}

/**
 * 简易 glob → RegExp 转换（支持 ** / * / ?）。
 * 仅用于产物文件匹配，不支持 brace expansion。
 */
function globToRegExp(pattern) {
  const p = normGlob(pattern);
  let out = "^";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === "*") {
      if (p[i + 1] === "*") {
        // ** 匹配任意路径
        out += ".*";
        i++;
        // 跳过可能的 /
        if (p[i + 1] === "/") i++;
      } else {
        // * 匹配单层
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (".^$+{}()|[]\\".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  out += "$";
  return new RegExp(out, "i");
}

function makeRunId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `exec_${ts}_${rand}`;
}

/**
 * requirements 列表的哈希值，用于缓存避免重复安装。
 */
function hashRequirements(reqs) {
  const sorted = [...new Set(reqs.map((x) => String(x ?? "").trim()).filter(Boolean))].sort();
  return crypto.createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 16);
}

// ── 输出缓冲（ring buffer 语义：只保留尾部 MAX_LOG_BYTES） ──

function createLogBuffer() {
  return { text: "", bytes: 0, truncated: false };
}

function pushChunk(buf, chunk) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
  if (!text) return;
  const chunkBytes = Buffer.byteLength(text, "utf8");
  const remaining = MAX_LOG_BYTES - buf.bytes;
  if (remaining <= 0) {
    buf.truncated = true;
    return;
  }
  if (chunkBytes <= remaining) {
    buf.text += text;
    buf.bytes += chunkBytes;
  } else {
    // 截断到可用空间
    const partial = Buffer.from(text, "utf8").subarray(0, remaining).toString("utf8");
    buf.text += partial;
    buf.bytes += remaining;
    buf.truncated = true;
  }
}

// ── CodeExecManager ─────────────────────────────

export class CodeExecManager {
  constructor() {
    /** 缓存检测到的 python3 路径 */
    this._pythonPath = null;
    /** 正在运行的任务 Map<runId, { child, startedAt, timer }> */
    this._running = new Map();
  }

  // ── 公开方法 ──

  /**
   * 检测系统 Python3，结果缓存。
   * @returns {Promise<string>} python 可执行文件路径
   */
  async detectPython() {
    if (this._pythonPath) return this._pythonPath;

    const candidates =
      process.platform === "win32"
        ? [
            { cmd: "python", args: ["--version"] },
            { cmd: "python3", args: ["--version"] },
            { cmd: "py", args: ["-3", "--version"] },
          ]
        : [
            { cmd: "python3", args: ["--version"] },
            { cmd: "python", args: ["--version"] },
          ];

    for (const c of candidates) {
      const ret = await this._runSimple(c.cmd, c.args, PYTHON_DETECT_TIMEOUT_MS);
      const merged = `${ret.stdout}\n${ret.stderr}`.trim();
      if (ret.ok && /python\s+3\./i.test(merged)) {
        this._pythonPath = c.cmd;
        console.log(`[CodeExec] Python3 detected: ${c.cmd} → ${merged.split("\n")[0]}`);
        return this._pythonPath;
      }
    }
    throw new Error("PYTHON3_NOT_FOUND: 未找到 Python 3，请先安装 Python 3.8+");
  }

  /**
   * 确保项目有 venv，返回 venv 中的 python 路径。
   * @returns {{ venvDir: string, pythonPath: string, created: boolean }}
   */
  async ensureVenv(projectDir) {
    const root = path.resolve(String(projectDir ?? "").trim());
    if (!root) throw new Error("MISSING_PROJECT_DIR");

    const venvDir = path.join(root, ".writing-ide", "runtime", "venv");
    const existing = await this._findVenvPython(venvDir);
    if (existing) return { venvDir, pythonPath: existing, created: false };

    // 创建 venv
    await fsp.mkdir(path.dirname(venvDir), { recursive: true });
    const python = await this.detectPython();
    console.log(`[CodeExec] Creating venv at ${venvDir}`);

    const ret = await this._runSimple(python, ["-m", "venv", venvDir], VENV_TIMEOUT_MS);
    if (!ret.ok) {
      throw new Error(`VENV_CREATE_FAILED: ${ret.stderr || ret.stdout || "unknown"}`);
    }

    const venvPython = await this._findVenvPython(venvDir);
    if (!venvPython) throw new Error("VENV_PYTHON_NOT_FOUND");
    return { venvDir, pythonPath: venvPython, created: true };
  }

  /**
   * 安装 pip 依赖（带 hash 缓存，相同依赖集不重复安装）。
   */
  async installRequirements(projectDir, reqs) {
    const requirements = [...new Set((reqs ?? []).map((x) => String(x ?? "").trim()).filter(Boolean))];
    if (!requirements.length) return { ok: true, installed: false };

    const root = path.resolve(String(projectDir ?? "").trim());
    const { pythonPath, created } = await this.ensureVenv(root);

    // venv 刚新建，清理旧的依赖缓存（旧 marker 已失效）
    const cacheDir = path.join(root, ".writing-ide", "runtime", "req-cache");
    if (created) {
      console.log(`[CodeExec] Venv recreated, clearing req-cache`);
      await fsp.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
    }

    // 检查缓存
    const hash = hashRequirements(requirements);
    const marker = path.join(cacheDir, `${hash}.ok`);
    if (await pathExists(marker)) {
      console.log(`[CodeExec] Requirements cache hit: ${hash}`);
      return { ok: true, installed: false, hash };
    }

    // 安装
    console.log(`[CodeExec] Installing requirements: ${requirements.join(", ")}`);
    await fsp.mkdir(cacheDir, { recursive: true });

    const ret = await this._runSimple(
      pythonPath,
      ["-m", "pip", "install", "--disable-pip-version-check", "-q", ...requirements],
      MAX_TIMEOUT_MS,
    );
    if (!ret.ok) {
      throw new Error(`PIP_INSTALL_FAILED: ${ret.stderr || ret.stdout || "unknown"}`);
    }

    // 写入缓存标记
    await fsp.writeFile(marker, new Date().toISOString(), "utf8");
    return { ok: true, installed: true, hash };
  }

  /**
   * 执行代码。
   * @param {object} params
   * @returns {Promise<object>} 执行结果
   */
  async exec(params) {
    const rawProjectDir = String(params?.projectDir ?? "").trim();
    if (!rawProjectDir) return { ok: false, error: "MISSING_PROJECT_DIR" };
    const projectDir = path.resolve(rawProjectDir);
    if (!projectDir || projectDir === path.resolve("")) {
      return { ok: false, error: "MISSING_PROJECT_DIR" };
    }
    if (!(await pathExists(projectDir))) return { ok: false, error: "PROJECT_DIR_NOT_FOUND" };

    const stat = await fsp.stat(projectDir).catch(() => null);
    if (!stat?.isDirectory()) return { ok: false, error: "PROJECT_DIR_NOT_DIRECTORY" };

    // 并发检查（提前占位，防止异步间隙竞态）
    if (this._running.size >= MAX_CONCURRENT) {
      return { ok: false, error: "MAX_CONCURRENCY_REACHED", detail: `最多并发 ${MAX_CONCURRENT} 个执行任务` };
    }
    const runId = makeRunId();
    // 提前注册占位，后续失败时 delete
    this._running.set(runId, { child: null, startedAt: Date.now(), timer: null });

    try {
      return await this._execInner(params, projectDir, runId);
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e), runId };
    } finally {
      // 确保异常退出时清除占位
      const rec = this._running.get(runId);
      if (rec && !rec.child) this._running.delete(runId);
    }
  }

  /** exec 的内部实现，已有并发占位保护 */
  async _execInner(params, projectDir, runId) {

    // 参数解析
    const runtime = String(params?.runtime ?? "python").trim().toLowerCase() || "python";
    if (runtime !== "python") return { ok: false, error: "UNSUPPORTED_RUNTIME", detail: runtime, runId };

    const code = typeof params?.code === "string" ? params.code : "";
    const entryFile = typeof params?.entryFile === "string" ? params.entryFile.trim() : "";
    const hasCode = code.trim().length > 0;
    const hasEntry = entryFile.length > 0;

    if (!hasCode && !hasEntry) {
      return { ok: false, error: "MUST_PROVIDE_CODE_OR_ENTRYFILE", runId };
    }
    if (hasCode && hasEntry) {
      return { ok: false, error: "PROVIDE_ONLY_ONE_OF_CODE_ENTRYFILE", runId };
    }

    const args = Array.isArray(params?.args) ? params.args.map((x) => String(x ?? "")) : [];
    const requirements = Array.isArray(params?.requirements)
      ? params.requirements.map((x) => String(x ?? "").trim()).filter(Boolean)
      : [];
    const timeoutMs = clampInt(params?.timeoutMs, 1_000, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const artifactGlobs =
      Array.isArray(params?.artifactGlobs) && params.artifactGlobs.length
        ? params.artifactGlobs.map((x) => normGlob(x)).filter(Boolean)
        : DEFAULT_ARTIFACT_GLOBS;

    // 准备运行目录
    const runDir = path.join(projectDir, ".writing-ide", "exec", runId);
    await fsp.mkdir(runDir, { recursive: true });

    // 准备入口文件
    let entryAbs = "";
    if (hasCode) {
      entryAbs = path.join(runDir, "_entry.py");
      await fsp.writeFile(entryAbs, code, "utf8");
    } else {
      const resolved = path.resolve(projectDir, entryFile);
      if (!isPathInside(projectDir, resolved)) {
        return { ok: false, error: "ENTRYFILE_OUTSIDE_PROJECT", runId };
      }
      // realpath 校验：防止符号链接指向项目外
      let realResolved;
      try {
        realResolved = await fsp.realpath(resolved);
      } catch {
        return { ok: false, error: "ENTRYFILE_NOT_FOUND", detail: entryFile, runId };
      }
      if (!isPathInside(projectDir, realResolved)) {
        return { ok: false, error: "ENTRYFILE_SYMLINK_ESCAPE", runId };
      }
      entryAbs = realResolved;
    }

    // 准备 Python 环境
    let venvPython = "";
    try {
      const venv = await this.ensureVenv(projectDir);
      venvPython = venv.pythonPath;
    } catch (e) {
      return { ok: false, error: "VENV_PREPARE_FAILED", detail: String(e?.message ?? e), runId };
    }

    // 安装依赖
    try {
      await this.installRequirements(projectDir, requirements);
    } catch (e) {
      return { ok: false, error: "REQUIREMENTS_INSTALL_FAILED", detail: String(e?.message ?? e), runId };
    }

    // 执行
    const startedAt = Date.now();
    const stdout = createLogBuffer();
    const stderr = createLogBuffer();
    let timedOut = false;

    const child = spawn(venvPython, [entryAbs, ...args], {
      cwd: runDir,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    // 注册到运行表
    const timer = setTimeout(() => {
      timedOut = true;
      this._killTree(child);
    }, timeoutMs);

    this._running.set(runId, { child, startedAt, timer });

    child.stdout?.on("data", (chunk) => pushChunk(stdout, chunk));
    child.stderr?.on("data", (chunk) => pushChunk(stderr, chunk));

    // 等待完成
    const finished = await new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      child.on("error", (err) => done({ kind: "error", err }));
      child.on("close", (code, signal) => done({ kind: "close", code, signal }));
    });

    clearTimeout(timer);
    this._running.delete(runId);

    const durationMs = Math.max(0, Date.now() - startedAt);

    if (finished.kind === "error") {
      return {
        ok: false,
        runId,
        exitCode: -1,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        timedOut,
        durationMs,
        artifacts: [],
        error: `SPAWN_FAILED: ${String(finished.err?.message ?? finished.err)}`,
      };
    }

    const exitCode = Number.isFinite(Number(finished.code)) ? Number(finished.code) : -1;

    // 收集产物
    const artifacts = await this._collectArtifacts(runDir, artifactGlobs);

    return {
      ok: exitCode === 0 && !timedOut,
      runId,
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      timedOut,
      durationMs,
      artifacts,
    };
  }

  /**
   * 取消正在运行的任务。
   */
  cancel(runId) {
    const id = String(runId ?? "").trim();
    if (!id) return { ok: false, error: "MISSING_RUN_ID" };
    const rec = this._running.get(id);
    if (!rec) return { ok: false, error: "RUN_NOT_FOUND" };

    clearTimeout(rec.timer);
    this._killTree(rec.child);
    this._running.delete(id);
    return { ok: true, runId: id };
  }

  /**
   * 清理所有运行中的进程。
   */
  dispose() {
    for (const [id, rec] of this._running) {
      try {
        clearTimeout(rec.timer);
        this._killTree(rec.child);
      } catch {
        // ignore
      }
    }
    this._running.clear();
  }

  // ── 私有方法 ──

  /**
   * 查找 venv 中的 python 可执行文件。
   */
  async _findVenvPython(venvDir) {
    if (process.platform === "win32") {
      const p = path.join(venvDir, "Scripts", "python.exe");
      return (await pathExists(p)) ? p : "";
    }
    for (const name of ["python3", "python"]) {
      const p = path.join(venvDir, "bin", name);
      if (await pathExists(p)) return p;
    }
    return "";
  }

  /**
   * kill 整棵进程树。
   */
  _killTree(child) {
    const pid = Number(child?.pid ?? 0);
    if (!pid) return;

    if (process.platform === "win32") {
      // Windows: taskkill /T /F
      try {
        spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        // ignore
      }
      return;
    }

    // Unix: kill process group
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // ignore
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore
    }
  }

  /**
   * 简单地运行一个命令并收集输出（用于 python --version / pip install 等）。
   */
  async _runSimple(command, args, timeoutMs) {
    if (!command) return { ok: false, code: -1, stdout: "", stderr: "EMPTY_COMMAND", timedOut: false };

    const stdout = createLogBuffer();
    const stderr = createLogBuffer();
    let timedOut = false;

    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      detached: process.platform !== "win32",
    });

    const timer = setTimeout(() => {
      timedOut = true;
      this._killTree(child);
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => pushChunk(stdout, chunk));
    child.stderr?.on("data", (chunk) => pushChunk(stderr, chunk));

    const ret = await new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      child.on("error", (err) => done({ kind: "error", err }));
      child.on("close", (code) => done({ kind: "close", code }));
    });

    clearTimeout(timer);

    if (ret.kind === "error") {
      return { ok: false, code: -1, stdout: stdout.text, stderr: String(ret.err?.message ?? ret.err), timedOut };
    }
    const code = Number.isFinite(Number(ret.code)) ? Number(ret.code) : -1;
    return { ok: code === 0 && !timedOut, code, stdout: stdout.text, stderr: stderr.text, timedOut };
  }

  /**
   * 递归扫描 runDir，按 glob 匹配收集产物文件。
   */
  async _collectArtifacts(runDir, globs) {
    const patterns = globs.length ? globs : DEFAULT_ARTIFACT_GLOBS;
    const regexps = patterns.map(globToRegExp);

    const files = [];
    const walk = async (dir) => {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        // 跳过隐藏目录和 __pycache__
        if (ent.name.startsWith(".") || ent.name === "__pycache__") continue;

        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          await walk(full);
        } else if (ent.isFile()) {
          files.push(full);
        }
      }
    };
    await walk(runDir);

    const out = [];
    for (const absPath of files) {
      const relPath = norm(path.relative(runDir, absPath));
      if (!relPath || relPath.startsWith("..")) continue;
      // 跳过入口文件本身
      if (relPath === "_entry.py") continue;

      if (!regexps.some((r) => r.test(relPath))) continue;

      let sizeBytes = 0;
      try {
        sizeBytes = (await fsp.stat(absPath)).size ?? 0;
      } catch {
        sizeBytes = 0;
      }

      const name = path.basename(absPath);
      const ext = path.extname(name).replace(/^\./, "").toLowerCase();
      out.push({ name, ext, absPath, relPath, sizeBytes });
    }

    out.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return out;
  }
}
