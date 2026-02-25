/**
 * 应用级设置持久化
 *
 * 存储位置: <userData>/app-settings.json
 * 原子写入：tmp + rename，避免写到一半崩溃导致配置丢失。
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const FILENAME = "app-settings.json";

function settingsPath(userDataPath) {
  return path.join(userDataPath, FILENAME);
}

/**
 * 加载设置。文件不存在时返回空对象。
 * @param {string} userDataPath
 * @returns {Promise<Record<string, any>>}
 */
export async function loadSettings(userDataPath) {
  try {
    const raw = await readFile(settingsPath(userDataPath), "utf-8");
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch (e) {
    if (e?.code === "ENOENT") return {};
    // JSON 解析失败也返回空（防止损坏文件阻塞启动）
    return {};
  }
}

/**
 * 保存设置（原子写入）。
 * @param {string} userDataPath
 * @param {Record<string, any>} settings
 */
export async function saveSettings(userDataPath, settings) {
  const target = settingsPath(userDataPath);
  const tmp = `${target}.tmp.${Date.now()}`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(tmp, JSON.stringify(settings ?? {}, null, 2) + "\n", "utf-8");
  try {
    await rename(tmp, target);
  } catch (e) {
    try { await unlink(tmp); } catch { /* ignore */ }
    throw e;
  }
}
