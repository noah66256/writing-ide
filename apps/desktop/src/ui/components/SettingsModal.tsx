import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  X, Users, Plug, Sparkles, ChevronDown, ChevronRight, Plus,
  Bot, BookOpen, FolderOpen, RefreshCw, Pencil, Trash2, Terminal, Globe, Radio,
  Eye, EyeOff, Monitor, ExternalLink, Package, Link2, Wrench, Store,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { TeamModal } from "@/components/TeamModal";
import { listRegisteredSkills, type SkillManifest } from "@writing-ide/agent-core";
import { useSkillStore } from "@/state/skillStore";
import { usePersonaStore } from "@/state/personaStore";
import { useKbStore } from "@/state/kbStore";
import { useDialogStore } from "@/state/dialogStore";
import { useMcpStore, type McpServerState } from "@/state/mcpStore";
import { useMarketplaceStore, type MarketplaceCatalogItem } from "@/state/marketplaceStore";

type Tab = "persona" | "team" | "mcp" | "skill" | "kb" | "marketplace";

const TABS: { id: Tab; label: string; icon: typeof Users }[] = [
  { id: "persona", label: "负责人", icon: Bot },
  { id: "kb", label: "知识库", icon: BookOpen },
  { id: "team", label: "团队管理", icon: Users },
  { id: "mcp", label: "MCP", icon: Plug },
  { id: "skill", label: "技能", icon: Sparkles },
  { id: "marketplace", label: "市场", icon: Store },
];

export function SettingsModal({ onClose, initialTab, kbSelectMode }: {
  onClose: () => void;
  initialTab?: string;
  kbSelectMode?: { onSelect: (id: string) => void };
}) {
  const [tab, setTab] = useState<Tab>(() => {
    const t = initialTab as Tab;
    return TABS.some((x) => x.id === t) ? t : "persona";
  });

  // kbSelectMode 请求到达时强制切换到 KB tab
  useEffect(() => {
    if (kbSelectMode && initialTab === "kb") setTab("kb");
  }, [kbSelectMode, initialTab]);

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm overflow-y-auto py-8"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-[680px] max-h-[calc(100vh-4rem)] bg-surface rounded-2xl border border-border shadow-2xl flex overflow-hidden my-auto">
        {/* Left tabs */}
        <div className="w-[180px] shrink-0 border-r border-border bg-surface-alt py-4 px-2 flex flex-col gap-1">
          <div className="text-[11px] uppercase tracking-wider text-text-faint font-medium px-3 mb-2">
            设置
          </div>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] transition-colors w-full text-left",
                tab === t.id
                  ? "bg-accent-soft text-accent font-medium"
                  : "text-text-muted hover:bg-surface hover:text-text",
              )}
            >
              <t.icon size={16} />
              {t.label}
            </button>
          ))}
        </div>

        {/* Right content */}
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex items-center justify-between px-6 py-4 border-b border-border">
            <h2 className="text-[16px] font-semibold text-text">
              {TABS.find((t) => t.id === tab)?.label}
            </h2>
            <button
              onClick={onClose}
              className="w-7 h-7 flex items-center justify-center rounded-md text-text-faint hover:text-text hover:bg-surface-alt transition-colors"
            >
              <X size={16} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-6">
            {tab === "persona" && <PersonaTabContent />}
            {tab === "kb" && <KbTabContent kbSelectMode={kbSelectMode} onClose={onClose} />}
            {tab === "team" && <TeamTabContent />}
            {tab === "mcp" && <McpTabContent />}
            {tab === "skill" && <SkillTabContent />}
            {tab === "marketplace" && <MarketplaceTabContent />}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ─── Marketplace Tab ─── */

function MarketplaceTabContent() {
  const items = useMarketplaceStore((s) => s.items);
  const installedMap = useMarketplaceStore((s) => s.installedMap);
  const manifestMap = useMarketplaceStore((s) => s.manifestMap);
  const logs = useMarketplaceStore((s) => s.logs);
  const loadingCatalog = useMarketplaceStore((s) => s.loadingCatalog);
  const loadingInstalled = useMarketplaceStore((s) => s.loadingInstalled);
  const loadingLogs = useMarketplaceStore((s) => s.loadingLogs);
  const loadingManifestIds = useMarketplaceStore((s) => s.loadingManifestIds);
  const installingIds = useMarketplaceStore((s) => s.installingIds);
  const error = useMarketplaceStore((s) => s.error);
  const refreshAll = useMarketplaceStore((s) => s.refreshAll);
  const fetchManifest = useMarketplaceStore((s) => s.fetchManifest);
  const installItem = useMarketplaceStore((s) => s.installItem);
  const uninstallItem = useMarketplaceStore((s) => s.uninstallItem);
  const [typeFilter, setTypeFilter] = useState<"all" | "skill" | "mcp_server" | "sub_agent">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "not_installed" | "installed" | "upgradable">("all");
  const [selectedItemId, setSelectedItemId] = useState("");

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const filteredItems = items.filter((x) => {
    if (typeFilter !== "all" && x.type !== typeFilter) return false;
    const installed = installedMap[x.id];
    const upgradable = isUpgradableVersion(x.version, installed?.version);
    if (statusFilter === "not_installed") return !installed;
    if (statusFilter === "installed") return Boolean(installed) && !upgradable;
    if (statusFilter === "upgradable") return Boolean(installed) && upgradable;
    return true;
  });
  const selectedItem = items.find((x) => x.id === selectedItemId) ?? null;
  const selectedManifest = selectedItem ? manifestMap[selectedItem.id] : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-[12px] text-text-muted leading-relaxed">
        官方精选能力市场。支持 Skill / MCP / Sub-Agent 一键安装并即时生效；安装失败会自动回滚。
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          {([
            ["all", "全部"],
            ["skill", "Skill"],
            ["mcp_server", "MCP"],
            ["sub_agent", "Sub-Agent"],
          ] as const).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setTypeFilter(v)}
              className={cn(
                "px-2.5 py-1 rounded-md text-[11px] border transition-colors",
                typeFilter === v
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border text-text-muted hover:bg-surface-alt",
              )}
            >
              {label}
            </button>
          ))}
          <span className="mx-1 text-[11px] text-text-faint">|</span>
          {([
            ["all", "全部状态"],
            ["not_installed", "未安装"],
            ["installed", "已安装"],
            ["upgradable", "可升级"],
          ] as const).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setStatusFilter(v)}
              className={cn(
                "px-2.5 py-1 rounded-md text-[11px] border transition-colors",
                statusFilter === v
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border text-text-muted hover:bg-surface-alt",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          onClick={() => { void refreshAll(); }}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] border border-border text-text-muted hover:bg-surface-alt transition-colors"
        >
          <RefreshCw size={12} className={loadingCatalog || loadingInstalled || loadingLogs ? "animate-spin" : ""} />
          刷新
        </button>
      </div>

      {error ? (
        <div className="text-[12px] text-red-500 bg-red-500/10 border border-red-500/20 rounded-lg px-2.5 py-2">
          {error}
        </div>
      ) : null}

      {loadingCatalog && items.length === 0 ? (
        <div className="text-[12px] text-text-faint">正在加载市场列表...</div>
      ) : null}

      {!loadingCatalog && filteredItems.length === 0 ? (
        <div className="text-[12px] text-text-faint">当前筛选条件下暂无可用扩展。</div>
      ) : null}

      {filteredItems.length > 0 && (
        <div className="flex flex-col gap-2">
          {filteredItems.map((item) => (
            <MarketplaceItemCard
              key={`${item.id}@${item.version}`}
              item={item}
              installed={installedMap[item.id]}
              upgradable={isUpgradableVersion(item.version, installedMap[item.id]?.version)}
              detailLoaded={Boolean(manifestMap[item.id])}
              detailBusy={loadingManifestIds.includes(item.id)}
              busy={installingIds.includes(item.id)}
              onInstall={async () => { await installItem(item); }}
              onUpgrade={async () => { await installItem(item); }}
              onUninstall={async () => { await uninstallItem(item.id); }}
              onOpenDetail={async () => {
                setSelectedItemId(item.id);
                await fetchManifest(item);
              }}
            />
          ))}
        </div>
      )}

      {selectedItem ? (
        <MarketplaceDetailPanel
          item={selectedItem}
          manifest={selectedManifest}
          loading={loadingManifestIds.includes(selectedItem.id)}
          onClose={() => setSelectedItemId("")}
        />
      ) : null}

      <div className="border-t border-border pt-3">
        <div className="text-[12px] font-medium text-text mb-2">最近安装日志</div>
        {logs.length === 0 ? (
          <div className="text-[11px] text-text-faint">暂无记录</div>
        ) : (
          <div className="flex flex-col gap-1">
            {logs.slice(0, 8).map((row) => (
              <div key={row.id} className="text-[11px] text-text-muted flex items-center gap-2">
                <span className={row.ok ? "text-green-600 dark:text-green-400" : "text-red-500"}>
                  {row.ok ? "✓" : "✕"}
                </span>
                <span>{row.action === "install" ? "安装" : "卸载"}</span>
                <span className="font-mono">{row.itemId}</span>
                <span className="text-text-faint">v{row.version}</span>
                {!row.ok && row.error ? <span className="text-red-500 truncate">{row.error}</span> : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MarketplaceItemCard({
  item,
  installed,
  upgradable,
  detailLoaded,
  detailBusy,
  busy,
  onInstall,
  onUpgrade,
  onUninstall,
  onOpenDetail,
}: {
  item: MarketplaceCatalogItem;
  installed?: { version?: string; installedAt?: string } | null;
  upgradable: boolean;
  detailLoaded: boolean;
  detailBusy: boolean;
  busy: boolean;
  onInstall: () => Promise<void>;
  onUpgrade: () => Promise<void>;
  onUninstall: () => Promise<void>;
  onOpenDetail: () => Promise<void>;
}) {
  const isInstalled = Boolean(installed);
  const typeLabel =
    item.type === "skill" ? "Skill" :
    item.type === "mcp_server" ? "MCP" :
    "Sub-Agent";
  return (
    <div className="border border-border rounded-lg p-3 bg-surface">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-text truncate">{item.name}</span>
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] border border-border text-text-muted">
              {typeLabel}
            </span>
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] border border-accent/30 text-accent bg-accent-soft/40">
              {item.source === "official" ? "官方" : "审核"}
            </span>
            <span className="text-[10px] text-text-faint">v{item.version}</span>
          </div>
          <div className="text-[11px] text-text-muted mt-1 leading-relaxed">{item.description}</div>
          <div className="text-[10px] text-text-faint mt-1">
            {item.publisher} · 最低版本 {item.minAppVersion}
          </div>
          {isInstalled ? (
            <div className="text-[10px] text-green-600 dark:text-green-400 mt-1">
              已安装 {installed?.version ? `v${installed.version}` : ""} {installed?.installedAt ? `· ${formatIsoTime(installed.installedAt)}` : ""}
            </div>
          ) : null}
          {upgradable ? (
            <div className="text-[10px] text-amber-600 dark:text-amber-400 mt-1">
              可升级：v{installed?.version ?? "?"} → v{item.version}
            </div>
          ) : null}
        </div>

        <div className="shrink-0 flex flex-col gap-1.5">
          <button
            onClick={() => { void onOpenDetail(); }}
            disabled={detailBusy}
            className={cn(
              "px-3 py-1.5 rounded-md text-[11px] border transition-colors",
              "border-border text-text-muted hover:bg-surface-alt",
              detailBusy ? "cursor-wait opacity-70" : "",
            )}
          >
            {detailBusy ? "加载中..." : detailLoaded ? "详情（已缓存）" : "详情"}
          </button>
          {isInstalled ? (
            <div className="flex items-center gap-1.5">
              {upgradable ? (
                <button
                  onClick={() => { void onUpgrade(); }}
                  disabled={busy}
                  className={cn(
                    "px-2.5 py-1.5 rounded-md text-[11px] border transition-colors",
                    busy
                      ? "border-border text-text-faint cursor-not-allowed"
                      : "border-accent text-accent hover:bg-accent-soft",
                  )}
                >
                  {busy ? "处理中..." : "升级"}
                </button>
              ) : null}
              <button
                onClick={() => { void onUninstall(); }}
                disabled={busy}
                className={cn(
                  "px-2.5 py-1.5 rounded-md text-[11px] border transition-colors",
                  busy
                    ? "border-border text-text-faint cursor-not-allowed"
                    : "border-red-500/30 text-red-600 dark:text-red-400 hover:bg-red-500/10",
                )}
              >
                {busy ? "处理中..." : "卸载"}
              </button>
            </div>
          ) : (
            <button
              onClick={() => { void onInstall(); }}
              disabled={busy}
              className={cn(
                "px-3 py-1.5 rounded-md text-[11px] border transition-colors",
                busy
                  ? "border-border text-text-faint cursor-not-allowed"
                  : "border-accent text-accent hover:bg-accent-soft",
              )}
            >
              {busy ? "安装中..." : "一键安装"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MarketplaceDetailPanel({
  item,
  manifest,
  loading,
  onClose,
}: {
  item: MarketplaceCatalogItem;
  manifest: any;
  loading: boolean;
  onClose: () => void;
}) {
  const permissions = manifest?.permissions ?? {};
  const changelog = Array.isArray(manifest?.changelog) ? manifest.changelog : [];
  const hasPermission =
    (Array.isArray(permissions?.network) && permissions.network.length > 0) ||
    (Array.isArray(permissions?.fs) && permissions.fs.length > 0) ||
    (Array.isArray(permissions?.exec) && permissions.exec.length > 0);
  return (
    <div className="border border-border rounded-lg p-3 bg-surface-alt">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[12px] font-medium text-text">
          {item.name} · 详情
        </div>
        <button
          onClick={onClose}
          className="px-2 py-1 rounded-md text-[11px] border border-border text-text-muted hover:bg-surface"
        >
          关闭
        </button>
      </div>

      {loading ? (
        <div className="text-[11px] text-text-faint mt-2">正在加载详情...</div>
      ) : (
        <div className="mt-2 space-y-2">
          <div className="text-[11px] text-text-muted">
            {item.description}
          </div>
          <div>
            <div className="text-[11px] font-medium text-text">权限</div>
            {!hasPermission ? (
              <div className="text-[11px] text-text-faint mt-1">无额外权限</div>
            ) : (
              <div className="text-[11px] text-text-muted mt-1 space-y-1">
                {Array.isArray(permissions?.exec) && permissions.exec.length > 0 ? (
                  <div>执行命令：{permissions.exec.join(", ")}</div>
                ) : null}
                {Array.isArray(permissions?.network) && permissions.network.length > 0 ? (
                  <div>网络访问：{permissions.network.join(", ")}</div>
                ) : null}
                {Array.isArray(permissions?.fs) && permissions.fs.length > 0 ? (
                  <div>文件访问：{permissions.fs.join(", ")}</div>
                ) : null}
              </div>
            )}
          </div>
          <div>
            <div className="text-[11px] font-medium text-text">变更日志</div>
            {changelog.length === 0 ? (
              <div className="text-[11px] text-text-faint mt-1">暂无</div>
            ) : (
              <div className="text-[11px] text-text-muted mt-1 space-y-1">
                {changelog.map((line: string, idx: number) => (
                  <div key={`${idx}-${line}`}>- {line}</div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function toVersionParts(raw: string): number[] {
  return String(raw ?? "")
    .trim()
    .split(/[^\d]+/g)
    .filter(Boolean)
    .map((x) => Number.parseInt(x, 10))
    .filter((x) => Number.isFinite(x));
}

function compareVersionLike(aRaw?: string, bRaw?: string): number {
  const a = toVersionParts(String(aRaw ?? ""));
  const b = toVersionParts(String(bRaw ?? ""));
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function isUpgradableVersion(catalogVersion?: string, installedVersion?: string): boolean {
  if (!catalogVersion || !installedVersion) return false;
  return compareVersionLike(catalogVersion, installedVersion) > 0;
}

function formatIsoTime(raw?: string): string {
  const iso = String(raw ?? "").trim();
  if (!iso) return "";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  return t.toLocaleString();
}

/* ─── Persona Tab ─── */

function PersonaTabContent() {
  const agentName = usePersonaStore((s) => s.agentName);
  const personaPrompt = usePersonaStore((s) => s.personaPrompt);
  const setAgentName = usePersonaStore((s) => s.setAgentName);
  const setPersonaPrompt = usePersonaStore((s) => s.setPersonaPrompt);

  return (
    <div className="flex flex-col gap-5">
      <div className="text-[12px] text-text-muted leading-relaxed">
        个性化你的 AI 负责人，设定它的名字和性格。这不会影响系统能力，只是让体验更亲切。
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[13px] font-medium text-text">
          负责人名称
        </label>
        <input
          type="text"
          value={agentName}
          onChange={(e) => setAgentName(e.target.value)}
          placeholder="Friday"
          className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-[13px] text-text placeholder:text-text-faint focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors"
        />
        <div className="text-[11px] text-text-faint">
          留空默认为 Friday
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[13px] font-medium text-text">
          个性化描述
        </label>
        <textarea
          value={personaPrompt}
          onChange={(e) => setPersonaPrompt(e.target.value)}
          placeholder="例如：叫我老板，说话干练简洁，用幽默的语气，偏好口语化表达"
          rows={4}
          className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-[13px] text-text placeholder:text-text-faint focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors resize-none leading-relaxed"
        />
        <div className="text-[11px] text-text-faint">
          描述你希望的说话风格、称呼方式、性格特点等
        </div>
      </div>
    </div>
  );
}

/* ─── KB Tab ─── */

function KbTabContent({ kbSelectMode, onClose }: {
  kbSelectMode?: { onSelect: (id: string) => void };
  onClose?: () => void;
}) {
  const baseDir = useKbStore((s) => s.baseDir);
  const libraries = useKbStore((s) => s.libraries);
  const refreshLibraries = useKbStore((s) => s.refreshLibraries);
  const createLibrary = useKbStore((s) => s.createLibrary);
  const renameLibrary = useKbStore((s) => s.renameLibrary);
  const deleteLibraryToTrash = useKbStore((s) => s.deleteLibraryToTrash);
  const openKbManager = useKbStore((s) => s.openKbManager);
  const setCurrentLibrary = useKbStore((s) => s.setCurrentLibrary);

  const handlePickDir = async () => {
    const api = window.desktop?.fs;
    if (!api) return;
    const res = await api.pickDirectory();
    if (!res?.ok || !res.dir) return;
    useKbStore.getState().setBaseDir(res.dir);
    await refreshLibraries().catch(() => void 0);
  };

  const handleCreateLibrary = async () => {
    const name = await useDialogStore.getState().openPrompt({
      title: "新建知识库",
      placeholder: "请输入库名称",
      defaultValue: "",
    });
    if (!name) return;
    const ret = await createLibrary(name);
    if (!ret.ok) return;
    // kbSelectMode 下，新建后直接选中
    if (kbSelectMode && ret.id) {
      setCurrentLibrary(ret.id);
      kbSelectMode.onSelect(ret.id);
    }
  };

  const handleRenameLibrary = async (id: string, oldName: string) => {
    const newName = await useDialogStore.getState().openPrompt({
      title: "重命名知识库",
      placeholder: "请输入新名称",
      defaultValue: oldName,
    });
    if (!newName) return;
    await renameLibrary(id, newName);
  };

  const handleDeleteLibrary = async (id: string, name: string) => {
    const ok = await useDialogStore.getState().openConfirm({
      title: "删除知识库？",
      message: `确认删除「${name}」吗？该库会移入回收站，可在库管理中恢复。`,
      danger: true,
    });
    if (!ok) return;
    await deleteLibraryToTrash(id);
  };

  const handleSelectLibrary = (id: string) => {
    if (kbSelectMode) {
      setCurrentLibrary(id);
      kbSelectMode.onSelect(id);
      return;
    }
    // 非选择模式：关闭设置 → 打开库管理并展开目标库
    openKbManager("libraries", null, id);
    onClose?.();
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="text-[12px] text-text-muted leading-relaxed">
        {kbSelectMode
          ? "请选择一个目标库用于抽卡入库，也可新建库。选中后将自动继续导入流程。"
          : "知识库存储在本地磁盘，选择目录后自动发现库文件。在输入框 @ 提及库名即可在写作时检索。"}
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-[13px] font-medium text-text">库目录</label>
        <div className="flex items-center gap-2">
          <div className={cn(
            "flex-1 px-3 py-2 rounded-lg border border-border bg-surface text-[13px] truncate",
            baseDir ? "text-text" : "text-text-faint",
          )}>
            {baseDir || "未设置"}
          </div>
          <button
            onClick={() => void handlePickDir()}
            className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-medium bg-accent-soft text-accent hover:bg-accent-soft/80 transition-colors"
          >
            <FolderOpen size={14} />
            {baseDir ? "更换" : "选择目录"}
          </button>
        </div>
      </div>

      {baseDir && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-text">
              已发现的库 ({libraries.length})
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void handleCreateLibrary()}
                className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-accent-soft text-accent hover:bg-accent-soft/80 transition-colors"
              >
                <Plus size={12} />
                新建库
              </button>
              <button onClick={() => void refreshLibraries()} className="text-[11px] text-accent hover:underline">
                刷新
              </button>
            </div>
          </div>
          {libraries.length === 0 ? (
            <div className="text-[12px] text-text-faint py-4 text-center border border-dashed border-border rounded-lg">
              该目录下未发现知识库
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {libraries.map((lib) => (
                <div
                  key={lib.id}
                  onClick={() => handleSelectLibrary(lib.id)}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors cursor-pointer",
                    "border-border hover:bg-surface-alt/50 hover:border-accent/40",
                  )}
                >
                  <BookOpen size={16} className="text-text-muted" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium text-text truncate">{lib.name}</div>
                    <div className="text-[11px] text-text-muted">
                      {lib.purpose === "style" ? "风格库" : lib.purpose === "product" ? "产品库" : "素材库"}
                      {" · "}{lib.docCount}{" 篇"}
                      {kbSelectMode ? " · 点击选择" : " · 点击管理"}
                    </div>
                  </div>
                  {!kbSelectMode && (
                    <div className="shrink-0 flex items-center gap-1">
                      <button
                        onClick={(e) => { e.stopPropagation(); void handleRenameLibrary(lib.id, lib.name); }}
                        className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-text-muted hover:bg-surface-alt hover:text-text transition-colors"
                      >
                        <Pencil size={12} />
                        重命名
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); void handleDeleteLibrary(lib.id, lib.name); }}
                        className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-error hover:bg-error/10 transition-colors"
                      >
                        <Trash2 size={12} />
                        删除
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TeamTabContent() {
  return (
    <div className="-m-6">
      <TeamModal onClose={() => {}} embedded />
    </div>
  );
}

/* ─── Skill Tab（简化版） ─── */

const SKILL_DESCRIPTIONS: Record<string, string> = {
  style_imitate: "绑定风格库后自动启用，在写作时自动检索样例、lint 风格、写入",
};

function SkillTabContent() {
  const skillOverrides = useSkillStore((s) => s.skillOverrides);
  const setSkillEnabled = useSkillStore((s) => s.setSkillEnabled);
  const externalSkills = useSkillStore((s) => s.externalSkills);
  const externalErrors = useSkillStore((s) => s.externalErrors);
  const loadExternalSkills = useSkillStore((s) => s.loadExternalSkills);
  const builtinSkills = listRegisteredSkills();

  // 合并列表：内置在前，外部在后
  const allSkills = [
    ...builtinSkills.map((s) => ({ ...s, _isExternal: false as const })),
    ...externalSkills.map((s) => ({ ...s, _isExternal: true as const })),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="text-[12px] text-text-muted leading-relaxed">
        技能是 Agent 的增强模块，符合条件时自动激活。内置技能不可删除，仅可开关。
      </div>
      <div className="flex flex-col gap-2">
        {allSkills.map((skill) => {
          const enabled = skillOverrides[skill.id]?.enabled ?? skill.autoEnable;
          const friendlyDesc = SKILL_DESCRIPTIONS[skill.id] ?? skill.description;
          const isExt = skill._isExternal && !(skill as any).builtin;
          return (
            <div
              key={skill.id}
              className={cn(
                "flex items-center gap-3 px-4 py-3 rounded-lg border transition-all",
                enabled ? "border-accent/30 bg-accent-soft/10" : "border-border opacity-60",
              )}
            >
              <div className="w-2 h-2 rounded-full shrink-0" style={{
                backgroundColor: enabled ? "var(--color-accent)" : "var(--color-text-faint)",
              }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-text">{skill.name}</span>
                  {isExt ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-400 font-medium">扩展</span>
                  ) : (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent font-medium">内置</span>
                  )}
                  {isExt && skill.version && (
                    <span className="text-[10px] text-text-faint">v{skill.version}</span>
                  )}
                  {isExt && skill.mcp && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-400">MCP</span>
                  )}
                </div>
                <div className="text-[11px] text-text-muted mt-0.5 leading-relaxed">{friendlyDesc}</div>
              </div>
              <label className="teamToggle shrink-0" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setSkillEnabled(skill.id, e.target.checked)}
                />
                <span className="teamToggleSlider" />
              </label>
            </div>
          );
        })}
      </div>

      {/* 加载错误提示 */}
      {externalErrors.length > 0 && (
        <div className="flex flex-col gap-1 mt-1">
          {externalErrors.map((err, i) => (
            <div key={i} className="text-[11px] text-red-400 bg-red-500/10 px-3 py-1.5 rounded">
              <span className="font-medium">{err.dirName}：</span>{err.error}
            </div>
          ))}
        </div>
      )}

      {/* 底部操作栏 */}
      <div className="flex items-center gap-2 mt-2 pt-3 border-t border-border">
        <button
          className="text-[11px] text-text-muted hover:text-text flex items-center gap-1.5 transition-colors"
          onClick={() => window.desktop?.skills?.openDir()}
        >
          <FolderOpen size={13} />
          打开扩展目录
        </button>
        <button
          className="text-[11px] text-text-muted hover:text-text flex items-center gap-1.5 transition-colors"
          onClick={() => loadExternalSkills()}
        >
          <RefreshCw size={13} />
          刷新
        </button>
        <div className="flex-1" />
        <span className="text-[10px] text-text-faint">
          {(() => {
            const userCount = externalSkills.filter((s) => !(s as any).builtin).length;
            return userCount > 0
              ? `${userCount} 个扩展包已加载`
              : "在扩展目录中放入 skill 文件夹即可生效";
          })()}
        </span>
      </div>
    </div>
  );
}

/* ─── MCP Tab ─── */

type TransportType = "stdio" | "streamable-http" | "sse";
type DraftConfidence = "high" | "medium" | "low";
type McpDraft = {
  name: string;
  transport: TransportType;
  command?: string;
  args?: string[];
  endpoint?: string;
  env?: Record<string, string>;
  sourceRepo: string;
  notes: string[];
  confidence: DraftConfidence;
  confidenceReason: string;
};

const STATUS_COLORS: Record<string, string> = {
  connected: "bg-green-500",
  connecting: "bg-yellow-500 animate-pulse",
  error: "bg-red-500",
  disconnected: "bg-gray-400",
};

const TRANSPORT_ICONS: Record<TransportType, typeof Terminal> = {
  stdio: Terminal,
  "streamable-http": Globe,
  sse: Radio,
};

const TRANSPORT_LABELS: Record<TransportType, string> = {
  stdio: "stdio",
  "streamable-http": "HTTP",
  sse: "SSE",
};

function parseGithubRepoUrl(input: string): { owner: string; repo: string } | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const noHash = raw.split("#")[0] ?? raw;
  const noQuery = noHash.split("?")[0] ?? noHash;
  const m = noQuery.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/i);
  if (!m?.[1] || !m?.[2]) return null;
  return { owner: m[1], repo: m[2] };
}

function decodeGithubBase64(content: string): string {
  const b64 = String(content ?? "").replace(/\s+/g, "");
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function fetchGithubRepoJson(owner: string, repo: string): Promise<any> {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) {
    throw new Error(`GitHub 仓库信息获取失败（${res.status}）`);
  }
  return res.json();
}

async function fetchGithubRepoText(owner: string, repo: string, branch: string, filePath: string): Promise<string | null> {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${filePath}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  const payload = await res.json().catch(() => null as any);
  const content = String(payload?.content ?? "");
  if (!content) return null;
  try {
    return decodeGithubBase64(content);
  } catch {
    return null;
  }
}

function tokenizeCommandLine(line: string): string[] {
  const src = String(line ?? "").trim();
  if (!src) return [];
  const matches = src.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
  return matches
    .map((x) => x.replace(/^['"]|['"]$/g, ""))
    .map((x) => x.trim())
    .filter(Boolean);
}

function extractCommandHead(line: string): string {
  const tokens = tokenizeCommandLine(line);
  return String(tokens[0] ?? "").trim();
}

function pickCommandFromReadme(readme: string): { command: string; reason: string } | null {
  const text = String(readme ?? "");
  if (!text.trim()) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const re = /^(npx|uvx|python\s+-m|node|docker\s+run)\s+.+$/i;
  const candidates = lines.filter((line) => re.test(line));
  if (!candidates.length) return null;

  const scored = candidates
    .map((line) => {
      const l = line.toLowerCase();
      let score = 0;
      if (l.includes("mcp")) score += 3;
      if (l.includes("server")) score += 1;
      if (l.includes("install")) score -= 1;
      return { line, score };
    })
    .sort((a, b) => b.score - a.score);
  const picked = scored[0]?.line ?? "";
  if (!picked) return null;
  return { command: picked, reason: "README 命令推断" };
}

function detectReadmeCommandForPackage(readme: string, pkgName: string): { command: string; hasModeArg: boolean } | null {
  const text = String(readme ?? "");
  const pkg = String(pkgName ?? "").trim();
  if (!text.trim() || !pkg) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const escapedPkg = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`^uvx\\s+${escapedPkg}(?:\\s+(.+))?$`, "i"),
    new RegExp(`^npx(?:\\s+-y)?\\s+${escapedPkg}(?:\\s+(.+))?$`, "i"),
    new RegExp(`^python\\s+-m\\s+${escapedPkg}(?:\\s+(.+))?$`, "i"),
  ];

  for (const line of lines) {
    for (const re of patterns) {
      const m = line.match(re);
      if (!m) continue;
      const rest = String(m[1] ?? "").trim();
      const hasModeArg = /\b(stdio|sse|http|streamable-http)\b/i.test(rest);
      return { command: line, hasModeArg };
    }
  }
  return null;
}

const CONFIDENCE_META: Record<DraftConfidence, { label: string; className: string }> = {
  high: {
    label: "高置信度",
    className: "bg-green-500/12 text-green-600 dark:text-green-400 border-green-500/30",
  },
  medium: {
    label: "中置信度",
    className: "bg-amber-500/12 text-amber-600 dark:text-amber-400 border-amber-500/30",
  },
  low: {
    label: "低置信度",
    className: "bg-red-500/12 text-red-600 dark:text-red-400 border-red-500/30",
  },
};

function extractEnvKeysFromText(text: string): string[] {
  const s = String(text ?? "");
  const keys = Array.from(new Set(s.match(/\b[A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET)\b/g) ?? []));
  return keys.slice(0, 8);
}

async function buildMcpDraftFromGithubUrl(repoUrl: string): Promise<McpDraft> {
  const parsed = parseGithubRepoUrl(repoUrl);
  if (!parsed) throw new Error("请提供标准 GitHub 仓库地址（例如 https://github.com/owner/repo）");
  const { owner, repo } = parsed;
  const repoInfo = await fetchGithubRepoJson(owner, repo);
  const branch = String(repoInfo?.default_branch ?? "main").trim() || "main";
  const prettyName = String(repoInfo?.name ?? repo).trim() || repo;
  const notes: string[] = [];
  const sourceRepo = `https://github.com/${owner}/${repo}`;
  let confidence: DraftConfidence = "low";
  let confidenceReason = "仅基于 README 启发式推断，建议人工核对命令";

  const [pkgText, pyText, readmeText, readmeAltText] = await Promise.all([
    fetchGithubRepoText(owner, repo, branch, "package.json"),
    fetchGithubRepoText(owner, repo, branch, "pyproject.toml"),
    fetchGithubRepoText(owner, repo, branch, "README.md"),
    fetchGithubRepoText(owner, repo, branch, "readme.md"),
  ]);
  const readme = readmeText || readmeAltText || "";

  let draft: McpDraft | null = null;

  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText);
      const pkgName = String(pkg?.name ?? "").trim();
      if (pkgName) {
        const readmeCmd = detectReadmeCommandForPackage(readme, pkgName);
        const preferred = readmeCmd?.command
          ? tokenizeCommandLine(readmeCmd.command)
          : ["npx", "-y", pkgName];
        const [cmd, ...cmdArgs] = preferred;
        draft = {
          name: prettyName,
          transport: "stdio",
          command: cmd || "npx",
          args: cmdArgs.length > 0 ? cmdArgs : ["-y", pkgName],
          sourceRepo,
          notes: [
            `根据 package.json 推断 npm 包：${pkgName}`,
            ...(readmeCmd?.command ? [`已按 README 命令补全：${readmeCmd.command}`] : []),
          ],
          confidence: readmeCmd?.hasModeArg ? "high" : "medium",
          confidenceReason: readmeCmd?.hasModeArg
            ? "结合 package.json 与 README（含 stdio/sse/http 模式参数）"
            : "命令来自 package.json 结构化元数据",
        };
        confidence = draft.confidence;
        confidenceReason = draft.confidenceReason;
      }
    } catch {
      // ignore
    }
  }

  if (!draft && pyText) {
    const m = pyText.match(/\[project\][\s\S]*?\nname\s*=\s*["']([^"']+)["']/i) || pyText.match(/\nname\s*=\s*["']([^"']+)["']/i);
    const pyName = String(m?.[1] ?? "").trim();
    if (pyName) {
      const readmeCmd = detectReadmeCommandForPackage(readme, pyName);
      const preferred = readmeCmd?.command
        ? tokenizeCommandLine(readmeCmd.command)
        : ["uvx", pyName];
      const [cmd, ...cmdArgs] = preferred;
      draft = {
        name: prettyName,
        transport: "stdio",
        command: cmd || "uvx",
        args: cmdArgs.length > 0 ? cmdArgs : [pyName],
        sourceRepo,
        notes: [
          `根据 pyproject.toml 推断 Python 包：${pyName}`,
          ...(readmeCmd?.command ? [`已按 README 命令补全：${readmeCmd.command}`] : []),
        ],
        confidence: readmeCmd?.hasModeArg ? "high" : "medium",
        confidenceReason: readmeCmd?.hasModeArg
          ? "结合 pyproject.toml 与 README（含 stdio/sse/http 模式参数）"
          : "命令来自 pyproject.toml 结构化元数据",
      };
      confidence = draft.confidence;
      confidenceReason = draft.confidenceReason;
    }
  }

  if (!draft && readme) {
    const picked = pickCommandFromReadme(readme);
    if (picked) {
      const parts = tokenizeCommandLine(picked.command);
      const [command, ...args] = parts;
      if (command) {
        const lc = picked.command.toLowerCase();
        const conf: DraftConfidence = lc.includes("mcp") ? "medium" : "low";
        const confReason =
          conf === "medium"
            ? "命令来自 README，且包含 mcp 关键词"
            : "命令来自 README 启发式匹配，风险较高";
        draft = {
          name: prettyName,
          transport: "stdio",
          command,
          args,
          sourceRepo,
          notes: [picked.reason, "请在保存前确认命令参数与环境变量"],
          confidence: conf,
          confidenceReason: confReason,
        };
        confidence = conf;
        confidenceReason = confReason;
      }
    }
  }

  if (!draft) {
    throw new Error("未能从仓库自动推断启动命令，请手动添加 Server（该仓库可能不是 stdio 启动范式）");
  }

  const envKeys = extractEnvKeysFromText(readme);
  if (envKeys.length > 0) {
    draft.env = Object.fromEntries(envKeys.map((k) => [k, ""]));
    notes.push(`从 README 提取到 ${envKeys.length} 个可能的密钥变量`);
  }

  draft.notes = [...draft.notes, ...notes];
  draft.confidence = draft.confidence ?? confidence;
  draft.confidenceReason = draft.confidenceReason ?? confidenceReason;
  return draft;
}

// ── 浏览器状态栏（MCP 标签页顶部） ──────────────────
function BrowserStatusBar() {
  const [info, setInfo] = useState<{ path: string | null; name: string | null; autoDetected: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await (window as any).desktop?.browser?.getInfo?.();
      if (result) setInfo(result);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleResetDetect = async () => {
    setBusy(true);
    try {
      await (window as any).desktop?.browser?.resetDetect?.();
      await load();
    } catch { /* ignore */ }
    setBusy(false);
  };

  const handlePickPath = async () => {
    setBusy(true);
    try {
      const result = await (window as any).desktop?.browser?.pickPath?.();
      if (result?.ok && result.path) {
        await (window as any).desktop?.browser?.setPath?.(result.path);
        await load();
      }
    } catch { /* ignore */ }
    setBusy(false);
  };

  const handleOpenChromeDownload = () => {
    try {
      window.open("https://www.google.com/chrome/", "_blank");
    } catch { /* ignore */ }
  };

  if (!info) return null;

  const found = Boolean(info.path);
  // 截断过长路径
  const shortPath = info.path && info.path.length > 60
    ? "..." + info.path.slice(-55)
    : info.path;

  return (
    <div className={cn(
      "flex flex-col gap-1.5 px-3 py-2.5 rounded-lg border text-[12px]",
      found
        ? "border-border bg-surface"
        : "border-yellow-500/30 bg-yellow-500/5",
    )}>
      <div className="flex items-center gap-2">
        <Monitor size={14} className={found ? "text-green-500" : "text-yellow-500"} />
        <span className="font-medium text-text">
          {found ? `系统浏览器: ${info.name || "Chromium"}` : "未检测到 Chromium 系浏览器"}
        </span>
      </div>
      {found ? (
        <>
          <div className="text-text-faint ml-[22px] truncate" title={info.path ?? ""}>
            {shortPath}
          </div>
          <div className="flex items-center gap-2 ml-[22px]">
            <span className="text-text-faint">{info.autoDetected ? "自动检测" : "手动指定"}</span>
            <span className="text-text-faint">·</span>
            <button
              onClick={handleResetDetect}
              disabled={busy}
              className="text-accent hover:underline disabled:opacity-50"
            >
              重新检测
            </button>
            <button
              onClick={handlePickPath}
              disabled={busy}
              className="text-accent hover:underline disabled:opacity-50"
            >
              手动指定
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="text-text-faint ml-[22px]">
            部分 MCP Server 需要浏览器来抓取动态网页内容
          </div>
          <div className="flex items-center gap-2 ml-[22px]">
            <button
              onClick={handlePickPath}
              disabled={busy}
              className="text-accent hover:underline disabled:opacity-50"
            >
              手动指定路径
            </button>
            <button
              onClick={handleOpenChromeDownload}
              className="flex items-center gap-1 text-accent hover:underline"
            >
              安装 Chrome <ExternalLink size={11} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

type RuntimeHealthPayload = {
  ok: boolean;
  platform?: string;
  runtimeDirs?: string[];
  checks?: Array<{
    command: string;
    ok: boolean;
    source: "bundled" | "system" | "explicit" | "missing" | string;
    path?: string | null;
  }>;
  error?: string;
};

function McpRuntimeStatusBar() {
  const getRuntimeHealth = useMcpStore((s) => s.getRuntimeHealth);
  const repairRuntime = useMcpStore((s) => s.repairRuntime);
  const [busy, setBusy] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [payload, setPayload] = useState<RuntimeHealthPayload | null>(null);
  const [statusText, setStatusText] = useState("");
  const [statusTone, setStatusTone] = useState<"normal" | "success" | "warn" | "error">("normal");

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    const startedAt = Date.now();
    setBusy(true);
    try {
      const ret = await getRuntimeHealth();
      const normalized = (ret && typeof ret === "object")
        ? (ret as RuntimeHealthPayload)
        : { ok: false, error: "INVALID_PAYLOAD" };
      setPayload(normalized);
      if (!opts?.silent) {
        const cost = Math.max(1, Date.now() - startedAt);
        if (normalized.ok) {
          const checks = Array.isArray(normalized.checks) ? normalized.checks : [];
          const miss = checks.filter((x) => !x.ok).map((x) => x.command);
          if (miss.length > 0) {
            setStatusTone("warn");
            setStatusText(`检查完成（${cost}ms）：缺少 ${miss.join(", ")}`);
          } else {
            setStatusTone("success");
            setStatusText(`检查完成（${cost}ms）：运行时正常`);
          }
        } else {
          setStatusTone("error");
          setStatusText(`检查失败：${normalized.error ?? "UNKNOWN_ERROR"}`);
        }
      }
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      setPayload({ ok: false, error: msg });
      if (!opts?.silent) {
        setStatusTone("error");
        setStatusText(`检查失败：${msg}`);
      }
    } finally {
      setBusy(false);
    }
  }, [getRuntimeHealth]);

  useEffect(() => {
    void load({ silent: true });
  }, [load]);

  const checks = Array.isArray(payload?.checks) ? payload!.checks! : [];
  const missing = checks.filter((c) => !c.ok).map((c) => c.command);

  return (
    <div className={cn(
      "flex flex-col gap-2 px-3 py-2.5 rounded-lg border text-[12px]",
      missing.length > 0 || !payload?.ok
        ? "border-yellow-500/30 bg-yellow-500/5"
        : "border-border bg-surface",
    )}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Wrench size={14} className={missing.length > 0 ? "text-yellow-500" : "text-green-500"} />
          <span className="font-medium text-text">
            MCP 运行时环境 {payload?.platform ? `(${payload.platform})` : ""}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => { void load(); }}
            disabled={busy || repairing}
            className="inline-flex items-center gap-1 text-accent hover:underline disabled:opacity-50"
          >
            <RefreshCw size={12} className={busy ? "animate-spin" : ""} />
            {busy ? "检查中..." : "刷新检查"}
          </button>
          <button
            onClick={async () => {
              setRepairing(true);
              try {
                setStatusTone("normal");
                setStatusText("正在执行修复...");
                const ret = await repairRuntime();
                if (ret?.health && typeof ret.health === "object") {
                  setPayload(ret.health as RuntimeHealthPayload);
                } else {
                  await load({ silent: true });
                }
                const unsupported = Array.isArray(ret?.unsupportedMissing)
                  ? ret.unsupportedMissing.filter(Boolean)
                  : [];
                const installs = Array.isArray(ret?.installs) ? ret.installs : [];
                const okInstalls = installs.filter((x: any) => x?.ok).length;
                const failedInstalls = installs.filter((x: any) => !x?.ok).length;
                const detail: string[] = [];
                if (okInstalls > 0) detail.push(`成功 ${okInstalls} 项`);
                if (failedInstalls > 0) detail.push(`失败 ${failedInstalls} 项`);
                if (unsupported.length > 0) detail.push(`暂不支持自动修复：${unsupported.join(", ")}`);
                if (detail.length === 0) detail.push("无需修复");
                setStatusTone(failedInstalls > 0 ? "error" : (unsupported.length > 0 ? "warn" : "success"));
                setStatusText(`修复完成：${detail.join("；")}`);
              } finally {
                setRepairing(false);
              }
            }}
            disabled={busy || repairing}
            className="inline-flex items-center gap-1 text-accent hover:underline disabled:opacity-50"
          >
            <RefreshCw size={12} className={repairing ? "animate-spin" : ""} />
            {repairing ? "修复中..." : "一键修复"}
          </button>
        </div>
      </div>

      {!!statusText && (
        <div
          className={cn(
            "ml-[22px] text-[11px]",
            statusTone === "success" ? "text-green-600 dark:text-green-400" : "",
            statusTone === "warn" ? "text-yellow-600 dark:text-yellow-400" : "",
            statusTone === "error" ? "text-red-600 dark:text-red-400" : "",
            statusTone === "normal" ? "text-text-faint" : "",
          )}
        >
          {statusText}
        </div>
      )}

      {!payload?.ok && (
        <div className="text-text-faint ml-[22px]">
          环境检查失败：{payload?.error ?? "UNKNOWN_ERROR"}
        </div>
      )}

      {payload?.ok && (
        <>
          <div className="flex flex-wrap gap-1.5 ml-[22px]">
            {checks.map((c) => (
              <span
                key={c.command}
                className={cn(
                  "inline-flex items-center gap-1 px-2 py-0.5 rounded-md border",
                  c.ok
                    ? "border-green-500/30 text-green-600 dark:text-green-400 bg-green-500/10"
                    : "border-red-500/30 text-red-600 dark:text-red-400 bg-red-500/10",
                )}
                title={c.path ?? ""}
              >
                <span className="font-mono">{c.command}</span>
                <span className="text-[10px] opacity-80">{c.ok ? c.source : "missing"}</span>
              </span>
            ))}
          </div>
          {missing.length > 0 ? (
            <div className="text-text-faint ml-[22px]">
              缺少命令：{missing.join(", ")}。安装包会预置 uv/uvx/node/npx；一键修复当前优先补 uv/uvx。
            </div>
          ) : (
            <div className="text-text-faint ml-[22px]">
              stdio 启动会优先使用内置 runtime，再回退系统 PATH。
            </div>
          )}
        </>
      )}
    </div>
  );
}

function McpTabContent() {
  const servers = useMcpStore((s) => s.servers);
  const refresh = useMcpStore((s) => s.refresh);
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<McpDraft | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => { void refresh(); }, []);

  return (
    <div className="flex flex-col gap-4">
      {/* 浏览器状态栏 */}
      <BrowserStatusBar />
      <McpRuntimeStatusBar />

      <div className="flex items-center justify-between">
        <div className="text-[13px] font-semibold text-text">MCP Server</div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowImport(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-surface-alt text-text-muted hover:text-accent hover:bg-accent-soft/50 transition-colors"
          >
            <Link2 size={14} />
            GitHub 导入
          </button>
          <button
            onClick={() => { setDraft(null); setShowAdd(true); setEditingId(null); }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-accent-soft text-accent hover:bg-accent-soft/80 transition-colors"
          >
            <Plus size={14} />
            添加 Server
          </button>
        </div>
      </div>

      {showAdd && editingId === null && (
        <McpAddDialog
          key={`mcp-edit-new-${draft?.sourceRepo ?? ""}`}
          editId={null}
          initialDraft={draft}
          onClose={() => { setShowAdd(false); setEditingId(null); }}
        />
      )}

      {servers.length === 0 && !showAdd ? (
        <div className="flex flex-col items-center justify-center py-10 text-text-faint">
          <Plug size={32} className="mb-2 opacity-40" />
          <div className="text-[13px]">尚未配置 MCP Server</div>
          <div className="text-[11px] mt-1">点击上方「添加 Server」连接外部工具</div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {servers.map((server) => (
            <div key={server.id} className="flex flex-col gap-2">
              <McpServerCard
                server={server}
                expanded={expandedId === server.id}
                onExpand={() => setExpandedId(expandedId === server.id ? null : server.id)}
                onEdit={() => { setEditingId(server.id); setShowAdd(true); }}
              />
              {showAdd && editingId === server.id && (
                <McpAddDialog
                  key={`mcp-edit-${server.id}`}
                  editId={server.id}
                  initialDraft={null}
                  onClose={() => { setShowAdd(false); setEditingId(null); }}
                />
              )}
            </div>
          ))}
        </div>
      )}
      {showImport && (
        <McpGithubImportDialog
          onClose={() => setShowImport(false)}
          onUseDraft={(nextDraft) => {
            setDraft(nextDraft);
            setEditingId(null);
            setShowImport(false);
            setShowAdd(true);
          }}
        />
      )}
    </div>
  );
}

function McpServerCard({
  server,
  expanded,
  onExpand,
  onEdit,
}: {
  server: McpServerState;
  expanded: boolean;
  onExpand: () => void;
  onEdit: () => void;
}) {
  const removeServer = useMcpStore((s) => s.removeServer);
  const connect = useMcpStore((s) => s.connect);
  const disconnect = useMcpStore((s) => s.disconnect);
  const repairRuntime = useMcpStore((s) => s.repairRuntime);
  const refresh = useMcpStore((s) => s.refresh);
  const [busy, setBusy] = useState(false);

  const TIcon = TRANSPORT_ICONS[server.transport] ?? Terminal;
  const statusColor = STATUS_COLORS[server.status] ?? STATUS_COLORS.disconnected;

  const ensureRuntimeReady = async () => {
    if (server.transport !== "stdio" || server.bundled) return true;
    const head = extractCommandHead(server.config?.command ?? "");
    if (!head) return true;
    const ret = await repairRuntime({ commands: [head] });
    const checks = Array.isArray(ret?.health?.checks) ? ret.health.checks : [];
    const check = checks.find((c: any) => String(c?.command ?? "").toLowerCase() === head.toLowerCase()) ?? checks[0];
    if (check?.ok) return true;
    const unsupported = Array.isArray(ret?.unsupportedMissing) && ret.unsupportedMissing.includes(head);
    const installErr = Array.isArray(ret?.installs)
      ? ret.installs.filter((x: any) => x && x.ok === false).map((x: any) => String(x?.error ?? "")).filter(Boolean)[0]
      : "";
    await useDialogStore.getState().openAlert({
      title: "运行时缺失",
      message:
        `命令「${head}」仍不可用。` +
        (unsupported ? "当前版本不支持自动安装该运行时（node/npx 理应随安装包内置）。\n\n" : "已尝试自动修复但未成功。\n\n") +
        (installErr ? `错误：${installErr}\n\n` : "") +
        "请先尝试 MCP 设置页顶部「一键修复」，若仍失败请升级到最新安装包后重试。",
    });
    return false;
  };

  const handleToggle = async (enable: boolean) => {
    setBusy(true);
    try {
      if (enable) {
        const api = (window as any).desktop?.mcp;
        if (api) {
          const ok = await ensureRuntimeReady();
          if (!ok) return;
          await api.updateServer(server.id, { enabled: true });
          await api.connect(server.id);
        }
      } else {
        const api = (window as any).desktop?.mcp;
        if (api) {
          await api.disconnect(server.id);
          await api.updateServer(server.id, { enabled: false });
        }
      }
      await refresh();
    } catch { /* ignore */ }
    finally { setBusy(false); }
  };

  const handleRetry = async () => {
    setBusy(true);
    try {
      const ok = await ensureRuntimeReady();
      if (!ok) return;
      await connect(server.id);
    } catch { /* ignore */ }
    finally {
      await refresh();
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    await removeServer(server.id);
  };

  return (
    <div className={cn(
      "border rounded-lg overflow-hidden transition-colors",
      server.status === "connected" ? "border-green-500/30" :
      server.status === "error" ? "border-red-500/30" : "border-border",
    )}>
      {/* Header row */}
      <div className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-surface-alt/50" onClick={onExpand}>
        <div className={cn("w-2 h-2 rounded-full shrink-0", statusColor)} />
        <div className="flex-1 min-w-0 overflow-hidden">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[13px] font-medium text-text truncate">{server.name}</span>
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-surface-alt text-text-muted shrink-0">
              <TIcon size={10} />
              {TRANSPORT_LABELS[server.transport]}
            </span>
            {server.builtin && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-accent-soft text-accent shrink-0">
                <Package size={10} />
                内置
              </span>
            )}
          </div>
          {server.status === "connected" && server.tools.length > 0 && (
            <div className="text-[11px] text-text-muted mt-0.5">
              {server.tools.length} 个可用工具
            </div>
          )}
          {server.status === "error" && server.error && (
            <div className="text-[11px] text-red-500 mt-0.5 truncate" title={server.error}>
              {server.error}
            </div>
          )}
          {server.status === "connecting" && (
            <div className="text-[11px] text-yellow-600 dark:text-yellow-400 mt-0.5">
              正在连接...
            </div>
          )}
          {server.status === "disconnected" && !server.enabled && server.configFields?.length && (() => {
            const env = server.config?.env ?? {};
            const missing = server.configFields.filter((f) => f.required && !env[f.envKey]?.trim());
            const anyFilled = server.configFields.some((f) => env[f.envKey]?.trim());
            if (missing.length > 0) return (
              <div className="text-[11px] text-amber-600 dark:text-amber-400 mt-0.5">
                需要配置 {missing.map((f) => f.label).join("、")}
              </div>
            );
            if (!anyFilled && server.configFields.some((f) => !f.required)) return (
              <div className="text-[11px] text-amber-600 dark:text-amber-400 mt-0.5">
                需要至少配置一个 API Key
              </div>
            );
            return null;
          })()}
        </div>
        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          {server.status === "error" && (
            <button
              onClick={handleRetry}
              disabled={busy}
              className="w-7 h-7 flex items-center justify-center rounded-md text-text-muted hover:text-accent hover:bg-accent-soft/50 transition-colors"
              title="重试"
            >
              <RefreshCw size={13} className={busy ? "animate-spin" : ""} />
            </button>
          )}
          <label className="teamToggle shrink-0">
            <input
              type="checkbox"
              checked={server.enabled && server.status !== "disconnected"}
              disabled={busy}
              onChange={(e) => void handleToggle(e.target.checked)}
            />
            <span className="teamToggleSlider" />
          </label>
        </div>
        {expanded ? <ChevronDown size={14} className="text-text-faint shrink-0" /> : <ChevronRight size={14} className="text-text-faint shrink-0" />}
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-border bg-surface-alt/30">
          {/* Tools list */}
          {server.tools.length > 0 && (
            <div className="mb-2">
              <div className="text-[11px] text-text-faint mb-1">可用工具</div>
              <div className="flex flex-wrap gap-1">
                {server.tools.map((tool) => (
                  <span
                    key={tool.name}
                    className="inline-flex items-center px-2 py-0.5 rounded-md bg-surface text-[11px] text-text-muted font-mono border border-border"
                    title={tool.description}
                  >
                    {tool.name}
                  </span>
                ))}
              </div>
            </div>
          )}
          {/* Actions */}
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={onEdit}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-text-muted hover:text-accent hover:bg-accent-soft/50 transition-colors"
            >
              <Pencil size={11} /> 编辑
            </button>
            {!server.builtin && (
              <button
                onClick={() => void handleDelete()}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-text-muted hover:text-red-500 hover:bg-red-500/10 transition-colors"
              >
                <Trash2 size={11} /> 删除
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── MCP Add/Edit Dialog ─── */

function McpGithubImportDialog({
  onClose,
  onUseDraft,
}: {
  onClose: () => void;
  onUseDraft: (draft: McpDraft) => void;
}) {
  const [repoUrl, setRepoUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<McpDraft | null>(null);

  const handleParse = async () => {
    setBusy(true);
    setErr(null);
    setDraft(null);
    try {
      const parsed = await buildMcpDraftFromGithubUrl(repoUrl);
      setDraft(parsed);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-accent/30 rounded-lg bg-surface p-4 flex flex-col gap-3">
      <div className="text-[13px] font-semibold text-text">GitHub 导入（生成配置草案）</div>
      <div className="text-[12px] text-text-muted">
        仅解析并填充草案，不会自动安装或连接。请确认后再点「添加」。
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          placeholder="https://github.com/owner/repo"
          className="flex-1 px-3 py-1.5 rounded-lg border border-border bg-surface text-[12px] text-text placeholder:text-text-faint focus:outline-none focus:border-accent transition-colors"
        />
        <button
          onClick={() => void handleParse()}
          disabled={!repoUrl.trim() || busy}
          className={cn(
            "px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors",
            repoUrl.trim() && !busy
              ? "bg-accent text-white hover:bg-accent/90"
              : "bg-surface-alt text-text-faint cursor-not-allowed",
          )}
        >
          {busy ? "解析中..." : "解析"}
        </button>
      </div>
      {err && (
        <div className="text-[12px] text-red-500 bg-red-500/10 border border-red-500/20 rounded-lg px-2.5 py-2">
          {err}
        </div>
      )}
      {draft && (
        <div className="border border-border rounded-lg bg-surface-alt/40 p-3 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center px-2 py-0.5 rounded-md border text-[11px] font-medium",
                CONFIDENCE_META[draft.confidence].className,
              )}
            >
              {CONFIDENCE_META[draft.confidence].label}
            </span>
            <span className="text-[11px] text-text-muted">{draft.confidenceReason}</span>
          </div>
          <div className="text-[12px] text-text"><span className="text-text-faint">名称：</span>{draft.name}</div>
          <div className="text-[12px] text-text"><span className="text-text-faint">传输：</span>{TRANSPORT_LABELS[draft.transport]}</div>
          {draft.command && (
            <div className="text-[12px] text-text break-all">
              <span className="text-text-faint">命令：</span>
              <span className="font-mono">{[draft.command, ...(draft.args ?? [])].join(" ")}</span>
            </div>
          )}
          {draft.endpoint && (
            <div className="text-[12px] text-text break-all">
              <span className="text-text-faint">Endpoint：</span>
              <span className="font-mono">{draft.endpoint}</span>
            </div>
          )}
          {draft.notes.length > 0 && (
            <div className="text-[11px] text-text-muted leading-relaxed">
              {draft.notes.join("；")}
            </div>
          )}
          <div className="flex items-center gap-2 pt-1">
            <a
              href={draft.sourceRepo}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
              onClick={(e) => { e.preventDefault(); (window as any).desktop?.shell?.openExternal?.(draft.sourceRepo); }}
            >
              查看仓库 <ExternalLink size={11} />
            </a>
            <button
              onClick={() => onUseDraft(draft)}
              className="ml-auto px-3 py-1.5 rounded-lg text-[12px] font-medium bg-accent text-white hover:bg-accent/90 transition-colors"
            >
              填充到新增表单
            </button>
          </div>
        </div>
      )}
      <div className="flex justify-end">
        <button
          onClick={onClose}
          className="px-3 py-1.5 rounded-lg text-[12px] text-text-muted hover:bg-surface-alt transition-colors"
        >
          关闭
        </button>
      </div>
    </div>
  );
}

function McpAddDialog({
  editId,
  initialDraft,
  onClose,
}: {
  editId: string | null;
  initialDraft?: McpDraft | null;
  onClose: () => void;
}) {
  const servers = useMcpStore((s) => s.servers);
  const addServer = useMcpStore((s) => s.addServer);
  const updateServer = useMcpStore((s) => s.updateServer);
  const repairRuntime = useMcpStore((s) => s.repairRuntime);

  const existing = editId ? servers.find((s) => s.id === editId) : null;
  const isBundled = existing?.bundled === true;
  const configFields = existing?.configFields ?? [];
  const hasConfigFields = configFields.length > 0;

  const [transport, setTransport] = useState<TransportType>(existing?.transport ?? initialDraft?.transport ?? "stdio");
  const [name, setName] = useState(existing?.name ?? initialDraft?.name ?? "");
  const [command, setCommand] = useState(existing?.config?.command ?? initialDraft?.command ?? "");
  const [args, setArgs] = useState(existing?.config?.args?.join(" ") ?? initialDraft?.args?.join(" ") ?? "");
  const [endpoint, setEndpoint] = useState(existing?.config?.endpoint ?? initialDraft?.endpoint ?? "");
  const [envPairs, setEnvPairs] = useState<Array<{ key: string; value: string; visible: boolean }>>(
    () => {
      const env = existing?.config?.env;
      const envMap = (env && typeof env === "object") ? env : {};
      const draftEnv = (!existing && initialDraft?.env && typeof initialDraft.env === "object")
        ? initialDraft.env
        : {};
      // 有 configFields 时，按字段定义初始化（保留用户已填的值）
      if (configFields.length > 0) {
        return configFields.map((f) => ({ key: f.envKey, value: envMap[f.envKey] ?? "", visible: false }));
      }
      if (Object.keys(envMap).length > 0) {
        return Object.entries(envMap).map(([k, v]) => ({ key: k, value: v, visible: false }));
      }
      if (Object.keys(draftEnv).length > 0) {
        return Object.keys(draftEnv).map((k) => ({ key: k, value: "", visible: false }));
      }
      return [];
    },
  );
  const [saving, setSaving] = useState(false);

  const canSave = name.trim() && (
    isBundled ? true :
    transport === "stdio" ? command.trim() :
    transport === "streamable-http" || transport === "sse" ? endpoint.trim() : false
  );

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    const config: any = {
      name: name.trim(),
      transport,
      enabled: true,
    };
    if (transport === "stdio") {
      if (!isBundled) {
        config.command = command.trim();
        const head = extractCommandHead(config.command);
        if (head) {
          const ret = await repairRuntime({ commands: [head] });
          const checks = Array.isArray(ret?.health?.checks) ? ret.health.checks : [];
          const check = checks.find((c: any) => String(c?.command ?? "").toLowerCase() === head.toLowerCase()) ?? checks[0];
          if (!check?.ok) {
            const unsupported = Array.isArray(ret?.unsupportedMissing) && ret.unsupportedMissing.includes(head);
            const installErr = Array.isArray(ret?.installs)
              ? ret.installs.filter((x: any) => x && x.ok === false).map((x: any) => String(x?.error ?? "")).filter(Boolean)[0]
              : "";
            await useDialogStore.getState().openAlert({
              title: "保存失败：运行时缺失",
              message:
                `当前命令「${head}」不可用。` +
                (unsupported ? "当前版本不支持自动安装该运行时（node/npx 理应随安装包内置）。\n\n" : "自动修复未完成。\n\n") +
                (installErr ? `错误：${installErr}\n\n` : "") +
                "请先尝试 MCP 设置页顶部「一键修复」，若仍失败请升级到最新安装包后再保存。",
            });
            setSaving(false);
            return;
          }
        }
      }
      config.args = args.trim() ? args.trim().split(/\s+/) : [];
    } else {
      config.endpoint = endpoint.trim();
    }

    // 环境变量（空值不写入，避免覆盖系统环境变量）
    const envObj: Record<string, string> = {};
    for (const p of envPairs) {
      const k = p.key.trim();
      if (k && p.value.trim()) envObj[k] = p.value.trim();
    }
    if (Object.keys(envObj).length > 0) {
      config.env = envObj;
    }

    if (editId) {
      await updateServer(editId, config);
    } else {
      await addServer(config);
    }
    setSaving(false);
    onClose();
  };

  return (
    <div className="border border-accent/30 rounded-lg bg-surface p-4 flex flex-col gap-3">
      <div className="text-[13px] font-semibold text-text">
        {editId ? "编辑 Server" : "添加 MCP Server"}
      </div>
      {!editId && initialDraft?.sourceRepo && (
        <div className="text-[11px] text-text-muted flex flex-col gap-1">
          <div>
            草案来源：
            <button
              className="ml-1 text-accent hover:underline"
              onClick={() => (window as any).desktop?.shell?.openExternal?.(initialDraft.sourceRepo)}
            >
              {initialDraft.sourceRepo}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center px-2 py-0.5 rounded-md border text-[10px] font-medium",
                CONFIDENCE_META[initialDraft.confidence].className,
              )}
            >
              {CONFIDENCE_META[initialDraft.confidence].label}
            </span>
            <span>{initialDraft.confidenceReason}</span>
          </div>
        </div>
      )}

      {/* Transport selector */}
      <div className="flex flex-col gap-1.5">
        <label className="text-[12px] font-medium text-text">传输方式</label>
        <div className="flex gap-2">
          {(["stdio", "streamable-http", "sse"] as TransportType[]).map((t) => {
            const TIcon = TRANSPORT_ICONS[t];
            return (
              <button
                key={t}
                onClick={() => !isBundled && setTransport(t)}
                disabled={isBundled}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] border transition-colors",
                  transport === t
                    ? "border-accent bg-accent-soft text-accent font-medium"
                    : "border-border text-text-muted hover:bg-surface-alt",
                  isBundled && "opacity-60 cursor-not-allowed",
                )}
              >
                <TIcon size={13} />
                {TRANSPORT_LABELS[t]}
              </button>
            );
          })}
        </div>
      </div>

      {/* Name */}
      <div className="flex flex-col gap-1">
        <label className="text-[12px] font-medium text-text">名称</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如：文件系统助手"
          className="w-full px-3 py-1.5 rounded-lg border border-border bg-surface text-[12px] text-text placeholder:text-text-faint focus:outline-none focus:border-accent transition-colors"
        />
      </div>

      {/* Transport-specific fields */}
      {transport === "stdio" && (
        <>
          {!isBundled && (
            <div className="text-[11px] text-text-faint">
              保存时会自动检测并修复运行时环境（例如 uv/uvx）；若修复失败会阻止保存并提示。
            </div>
          )}
          {!isBundled && (
            <div className="flex flex-col gap-1">
              <label className="text-[12px] font-medium text-text">命令</label>
              <input
                type="text"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="例如：npx -y @anthropic/mcp-server-filesystem"
                className="w-full px-3 py-1.5 rounded-lg border border-border bg-surface text-[12px] text-text font-mono placeholder:text-text-faint focus:outline-none focus:border-accent transition-colors"
              />
            </div>
          )}
          {isBundled && (
            <div className="flex flex-col gap-1">
              <label className="text-[12px] font-medium text-text-muted">模块（内置，不可修改）</label>
              <div className="w-full px-3 py-1.5 rounded-lg border border-border bg-surface-alt/50 text-[12px] text-text-muted font-mono">
                {existing?.config?.modulePath ?? "bundled"}
              </div>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <label className="text-[12px] font-medium text-text">参数（空格分隔）</label>
            <input
              type="text"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="例如：/Users/me/Documents"
              className="w-full px-3 py-1.5 rounded-lg border border-border bg-surface text-[12px] text-text font-mono placeholder:text-text-faint focus:outline-none focus:border-accent transition-colors"
            />
          </div>
        </>
      )}
      {(transport === "streamable-http" || transport === "sse") && (
        <div className="flex flex-col gap-1">
          <label className="text-[12px] font-medium text-text">Endpoint URL</label>
          <input
            type="text"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://example.com/mcp"
            className="w-full px-3 py-1.5 rounded-lg border border-border bg-surface text-[12px] text-text font-mono placeholder:text-text-faint focus:outline-none focus:border-accent transition-colors"
          />
        </div>
      )}

      {/* 环境变量 / API Key 配置 */}
      {hasConfigFields ? (
        <div className="flex flex-col gap-2.5">
          <label className="text-[12px] font-medium text-text">API 密钥配置</label>
          {configFields.map((field, idx) => (
            <div key={field.envKey} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <label className="text-[12px] font-medium text-text-muted">{field.label}</label>
                {field.helpUrl && (
                  <a
                    href={field.helpUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 text-[11px] text-accent hover:underline"
                    onClick={(e) => { e.stopPropagation(); (window as any).desktop?.shell?.openExternal?.(field.helpUrl); e.preventDefault(); }}
                  >
                    {field.helpText || "获取密钥"}
                    <ExternalLink size={10} />
                  </a>
                )}
                {field.required && (
                  <span className="text-[10px] text-red-500/70 font-medium">必填</span>
                )}
              </div>
              <div className="relative">
                <input
                  type={envPairs[idx]?.visible ? "text" : "password"}
                  value={envPairs[idx]?.value ?? ""}
                  onChange={(e) => {
                    const next = [...envPairs];
                    next[idx] = { ...next[idx], value: e.target.value };
                    setEnvPairs(next);
                  }}
                  placeholder={field.placeholder || "请输入..."}
                  className="w-full px-3 py-1.5 pr-8 rounded-lg border border-border bg-surface text-[12px] text-text font-mono placeholder:text-text-faint focus:outline-none focus:border-accent transition-colors"
                />
                <button
                  type="button"
                  onClick={() => {
                    const next = [...envPairs];
                    next[idx] = { ...next[idx], visible: !next[idx]?.visible };
                    setEnvPairs(next);
                  }}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-faint hover:text-text-muted transition-colors"
                >
                  {envPairs[idx]?.visible ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
      <div className="flex flex-col gap-1.5">
        <label className="text-[12px] font-medium text-text">环境变量</label>
        {envPairs.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {envPairs.map((pair, idx) => (
              <div key={idx} className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={pair.key}
                  onChange={(e) => {
                    const next = [...envPairs];
                    next[idx] = { ...pair, key: e.target.value };
                    setEnvPairs(next);
                  }}
                  placeholder="KEY"
                  className="w-[40%] px-2.5 py-1.5 rounded-lg border border-border bg-surface text-[12px] text-text font-mono placeholder:text-text-faint focus:outline-none focus:border-accent transition-colors"
                />
                <div className="relative flex-1">
                  <input
                    type={pair.visible ? "text" : "password"}
                    value={pair.value}
                    onChange={(e) => {
                      const next = [...envPairs];
                      next[idx] = { ...pair, value: e.target.value };
                      setEnvPairs(next);
                    }}
                    placeholder="value"
                    className="w-full px-2.5 py-1.5 pr-8 rounded-lg border border-border bg-surface text-[12px] text-text font-mono placeholder:text-text-faint focus:outline-none focus:border-accent transition-colors"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const next = [...envPairs];
                      next[idx] = { ...pair, visible: !pair.visible };
                      setEnvPairs(next);
                    }}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-faint hover:text-text-muted transition-colors"
                  >
                    {pair.visible ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setEnvPairs(envPairs.filter((_, i) => i !== idx))}
                  className="w-7 h-7 flex items-center justify-center rounded-md text-text-faint hover:text-red-500 hover:bg-red-500/10 transition-colors shrink-0"
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => setEnvPairs([...envPairs, { key: "", value: "", visible: false }])}
          className="flex items-center gap-1.5 text-[12px] text-text-muted hover:text-accent transition-colors self-start"
        >
          <Plus size={12} />
          添加环境变量
        </button>
      </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 mt-1">
        <button
          onClick={onClose}
          className="px-3 py-1.5 rounded-lg text-[12px] text-text-muted hover:bg-surface-alt transition-colors"
        >
          取消
        </button>
        <button
          onClick={() => void handleSave()}
          disabled={!canSave || saving}
          className={cn(
            "px-4 py-1.5 rounded-lg text-[12px] font-medium transition-colors",
            canSave && !saving
              ? "bg-accent text-white hover:bg-accent/90"
              : "bg-surface-alt text-text-faint cursor-not-allowed",
          )}
        >
          {saving ? "保存中..." : editId ? "保存" : "添加"}
        </button>
      </div>
    </div>
  );
}
