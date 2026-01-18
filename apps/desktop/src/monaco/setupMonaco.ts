// Monaco 在 Vite 下需要显式配置 Worker，避免编辑器空白/报错
// 参考：monaco-editor ESM + Vite worker 打包方式
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

// 关键（打包/离线）：不要让 @monaco-editor/react 去拉 CDN（会导致打包版在部分网络环境下 Monaco 永远 loading）
// 直接使用本地依赖里的 monaco 实例。
try {
  loader.config({ monaco });
} catch {
  // ignore
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _self: any = self;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
_self.MonacoEnvironment = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getWorker: (_: any, label: string) => {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less")
      return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor")
      return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};









