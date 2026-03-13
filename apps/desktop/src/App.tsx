import { DialogHost } from "./components/DialogHost";
import { LoginModal } from "./components/LoginModal";
import { ConversationLayout } from "./ui/layouts/ConversationLayout";
import { LoginPage } from "./ui/components/LoginPage";
import { useEffect } from "react";
import { useProjectStore } from "./state/projectStore";
import { useProjectIndexStore } from "./state/projectIndexStore";
import { useMemoryStore } from "./state/memoryStore";
import { useWorkspaceStore } from "./state/workspaceStore";
import { useUpdateStore } from "./state/updateStore";
import { useAuthStore } from "./state/authStore";
import { useSkillStore } from "./state/skillStore";
import { getUpdateBaseUrl } from "./agent/updateBaseUrl";
import { getGatewayBaseUrl } from "./agent/gatewayUrl";
import { startGatewayRun } from "./agent/gatewayAgent";
import { useRunStore } from "./state/runStore";
import { useConversationStore } from "./state/conversationStore";
import { Loader2 } from "lucide-react";
import "./state/themeStore"; // side-effect: apply theme on load
import "./state/fontScaleStore"; // side-effect: apply font scale on load

export default function App() {
  const setUpdateCheckResult = useUpdateStore((s) => s.setCheckResult);
  const setDownload = useUpdateStore((s) => s.setDownload);

  const initStatus = useAuthStore((s) => s.initStatus);
  const user = useAuthStore((s) => s.user);
  const loginModalOpen = useAuthStore((s) => s.loginModalOpen);
  const closeLoginModal = useAuthStore((s) => s.closeLoginModal);

  // 启动时校验已保存的 token
  useEffect(() => {
    useAuthStore.getState().init();
  }, []);

  // 初始化外部 Skill 加载监听
  useEffect(() => {
    useSkillStore.getState().initListener();
  }, []);

  // 启动时加载全局记忆 L1
  useEffect(() => {
    void useMemoryStore.getState().loadGlobalMemory();
  }, []);

  // 启动时：尝试恢复上次打开的项目
  useEffect(() => {
    const last = useWorkspaceStore.getState().lastProjectDir;
    if (!last) return;
    void useProjectStore.getState().loadProjectFromDisk(last);
  }, []);

  // 最近项目：同步到主进程（用于动态菜单）
  const recentProjectDirs = useWorkspaceStore((s) => s.recentProjectDirs);
  useEffect(() => {
    void window.desktop?.workspace?.setRecentProjects?.(recentProjectDirs);
  }, [recentProjectDirs]);

  // 文件监听：主进程 fs watch -> renderer 刷新
  useEffect(() => {
    const off = window.desktop?.fs?.onFsEvent?.((payload: any) => {
      const rootDir = String(payload?.rootDir ?? "");
      const cur = useProjectStore.getState().rootDir;
      if (!rootDir || !cur || rootDir !== cur) return;
      void useProjectStore.getState().refreshFromDisk("fs.watch");
      void useProjectIndexStore.getState().refreshIfStale(rootDir);
    });
    return () => {
      try {
        off?.();
      } catch {
        // ignore
      }
    };
  }, []);

  // 菜单动作（Electron → renderer）
  useEffect(() => {
    const off = window.desktop?.onMenuAction?.((payload: any) => {
      if (!payload || typeof payload !== "object") return;
      if (payload.type === "help.checkUpdates") {
        const api = window.desktop?.update;
        if (!api) return;
        void api.checkInteractive({ baseUrl: getUpdateBaseUrl() });
        return;
      }
      if (payload.type === "file.openProject") {
        const api = window.desktop?.fs;
        if (!api) return;
        void (async () => {
          const res = await api.pickDirectory();
          if (!res.ok || !res.dir) return;
          useWorkspaceStore.getState().addRecentProjectDir(res.dir);
          await useProjectStore.getState().loadProjectFromDisk(res.dir);
        })();
        return;
      }
      if (payload.type === "file.openRecent") {
        const dir = String(payload.dir ?? "");
        if (!dir) return;
        void (async () => {
          useWorkspaceStore.getState().addRecentProjectDir(dir);
          await useProjectStore.getState().loadProjectFromDisk(dir);
        })();
        return;
      }
      if (payload.type === "workspace.clearRecent") {
        useWorkspaceStore.getState().clearRecent();
        void window.desktop?.workspace?.clearRecentProjects?.();
        return;
      }
      if (payload.type === "file.save") {
        void useProjectStore.getState().saveActiveNow();
        return;
      }
    });
    return () => {
      try {
        off?.();
      } catch {
        // ignore
      }
    };
  }, []);

  // Update（v0.2）：启动 + 每 6 小时 silent check → 自动后台下载
  useEffect(() => {
    const api = window.desktop?.update;
    if (!api) return;
    const run = async () => {
      const r = await api.check({ baseUrl: getUpdateBaseUrl() }).catch((e) => ({ ok: false, error: String(e?.message ?? e) } as any));
      if (!r?.ok) return setUpdateCheckResult({ updateAvailable: false, latestVersion: "", error: r?.error ?? "CHECK_FAILED" });
      setUpdateCheckResult({ updateAvailable: Boolean(r.updateAvailable), latestVersion: String(r.latestVersion ?? ""), error: "" });

      // 无感下载：检测到更新后自动后台下载
      if (r.updateAvailable && api.silentDownload) {
        const dl = await api.silentDownload({ baseUrl: getUpdateBaseUrl() }).catch(() => null);
        if (dl?.ok && dl?.downloaded) {
          useUpdateStore.getState().setDownloadReady(String(dl.version ?? r.latestVersion ?? ""));
        }
      }
    };
    const t0 = window.setTimeout(() => void run(), 8000);
    const id = window.setInterval(() => void run(), 6 * 60 * 60 * 1000);
    return () => {
      window.clearTimeout(t0);
      window.clearInterval(id);
    };
  }, [setUpdateCheckResult]);

  // Update download events（进度）
  useEffect(() => {
    const off = window.desktop?.update?.onEvent?.((evt: any) => {
      const t = String(evt?.type ?? "");
      if (t === "download.start") {
        setDownload({ running: true, transferred: 0, total: 0 });
        return;
      }
      if (t === "download.progress") {
        const transferred = Number(evt?.transferred ?? 0) || 0;
        const total = Number(evt?.total ?? 0) || 0;
        setDownload({ running: true, transferred, total });
        return;
      }
      if (t === "download.done") {
        setDownload(null);
        return;
      }
      if (t === "silent.ready") {
        useUpdateStore.getState().setDownloadReady(String(evt?.version ?? ""));
        return;
      }
    });
    return () => {
      try {
        off?.();
      } catch {
        // ignore
      }
    };
  }, [setDownload]);

  // Automation Cron：主进程 scheduler 到点后触发一次 Agent run
  useEffect(() => {
    const off = window.desktop?.automation?.onCronDue?.((payload: any) => {
      try {
        const promptRaw = String(payload?.prompt ?? "").trim();
        if (!promptRaw) return;

        const runState = useRunStore.getState();
        const mode = runState.mode || "agent";
        const opMode = runState.opMode || "creative";
        const model = String(runState.model || runState.agentModel || runState.chatModel || "").trim();
        if (!model) {
          // 没有选模型时，仅在对话里给出提示
          runState.addAssistant?.("（定时任务触发失败：当前未选择模型，请先在右上角选择一个模型。）");
          return;
        }

        const gatewayUrl = getGatewayBaseUrl();
        const runConvId = useConversationStore.getState().activeConvId ?? undefined;

        const baseline = {
          project: useProjectStore.getState().snapshot(),
          mainDoc: JSON.parse(JSON.stringify(runState.mainDoc ?? {})),
          todoList: JSON.parse(JSON.stringify(runState.todoList ?? [])),
          ctxRefs: JSON.parse(JSON.stringify(runState.ctxRefs ?? [])),
        };

        // 在当前对话里追加一条“系统用户消息”，方便溯源
        const userText = promptRaw;
        runState.addUser(userText, baseline as any, undefined, undefined);

        const c = startGatewayRun({
          gatewayUrl,
          mode,
          model,
          prompt: promptRaw,
          opMode,
          ...(runConvId ? { convId: runConvId } : {}),
        });
        void c.done;
      } catch (e) {
        console.warn("[App] automation.cronDue handler failed:", e);
      }
    });
    return () => {
      try {
        off?.();
      } catch {
        // ignore
      }
    };
  }, []);

  // 初始化中：居中 loading
  if (initStatus !== "done") {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-bg">
        <div
          className="fixed top-0 left-0 right-0 h-[52px] z-50"
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        />
        <Loader2 size={24} className="animate-spin text-text-faint" />
      </div>
    );
  }

  // 未登录：全屏登录页
  if (!user) {
    return <LoginPage />;
  }

  // 已登录：正常应用
  return (
    <>
      <ConversationLayout />
      <DialogHost />
      <LoginModal open={loginModalOpen} onClose={() => closeLoginModal()} />
    </>
  );
}
