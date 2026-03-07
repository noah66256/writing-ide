import { useState, useMemo } from "react";
import { type SubAgentDefinition } from "@ohmycrab/agent-core";
import { TOOL_LIST } from "@ohmycrab/tools";
import {
  useTeamStore,
  getEffectiveAgents,
  validateCustomAgent,
  generateCustomAgentId,
  type CommunicationMode,
} from "../state/teamStore";

type FormData = {
  name: string;
  avatar: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  model: string;
  toolPolicy: "readonly" | "proposal_first" | "auto_apply";
  maxTurns: number;
  maxToolCalls: number;
  timeoutMs: number;
  triggerPatterns: string;
  priority: number;
};

const DEFAULT_FORM: FormData = {
  name: "",
  avatar: "🤖",
  description: "",
  systemPrompt: "",
  tools: [],
  model: "haiku",
  toolPolicy: "proposal_first",
  maxTurns: 10,
  maxToolCalls: 20,
  timeoutMs: 90000,
  triggerPatterns: "",
  priority: 50,
};

const AVAILABLE_TOOLS = TOOL_LIST.filter(
  (t) => t.name !== "agent.delegate" && !t.name.startsWith("agent.config."),
).map((t) => t.name);

function defToForm(def: SubAgentDefinition): FormData {
  return {
    name: def.name,
    avatar: def.avatar ?? "🤖",
    description: def.description,
    systemPrompt: def.systemPrompt,
    tools: [...def.tools],
    model: def.model,
    toolPolicy: def.toolPolicy,
    maxTurns: def.budget.maxTurns,
    maxToolCalls: def.budget.maxToolCalls,
    timeoutMs: def.budget.timeoutMs,
    triggerPatterns: (def.triggerPatterns ?? []).join("、"),
    priority: def.priority ?? 50,
  };
}

export function TeamModal({ onClose, embedded }: { onClose: () => void; embedded?: boolean }) {
  const agentOverrides = useTeamStore((s) => s.agentOverrides);
  const customAgents = useTeamStore((s) => s.customAgents);
  const communicationMode = useTeamStore((s) => s.communicationMode);
  const setAgentEnabled = useTeamStore((s) => s.setAgentEnabled);
  const setCommunicationMode = useTeamStore((s) => s.setCommunicationMode);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null); // null=list, "new"=create, agentId=edit
  const [form, setForm] = useState<FormData>(DEFAULT_FORM);
  const [formError, setFormError] = useState("");

  const effectiveAgents = useMemo(() => getEffectiveAgents(), [agentOverrides, customAgents]);

  const startCreate = () => {
    setForm(DEFAULT_FORM);
    setFormError("");
    setEditingId("new");
  };

  const startEdit = (agentId: string) => {
    const agent = customAgents[agentId];
    if (!agent) return;
    setForm(defToForm(agent));
    setFormError("");
    setEditingId(agentId);
  };

  const handleDelete = (agentId: string) => {
    if (!agentId.startsWith("custom_")) return;
    useTeamStore.getState().removeCustomAgent(agentId);
    if (editingId === agentId) setEditingId(null);
  };

  const handleSave = () => {
    setFormError("");
    const isCreate = editingId === "new";
    const id = isCreate ? generateCustomAgentId(form.name) : editingId!;

    if (isCreate && customAgents[id]) {
      setFormError(`ID "${id}" 已存在，请使用不同名称`);
      return;
    }

    const def: SubAgentDefinition = {
      id,
      name: form.name.trim(),
      avatar: form.avatar.trim() || "🤖",
      description: form.description.trim(),
      systemPrompt: form.systemPrompt.trim(),
      tools: form.tools,
      skills: [],
      mcpServers: [],
      model: form.model.trim() || "haiku",
      fallbackModels: [],
      toolPolicy: form.toolPolicy,
      budget: {
        maxTurns: form.maxTurns,
        maxToolCalls: form.maxToolCalls,
        timeoutMs: form.timeoutMs,
      },
      triggerPatterns: form.triggerPatterns
        .split(/[,，、\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
      priority: form.priority,
      enabled: true,
      version: "1.0.0",
    };

    const knownTools = new Set(TOOL_LIST.map((t) => t.name));
    const v = validateCustomAgent(def, knownTools);
    if (!v.ok) {
      setFormError(v.errors.join("；"));
      return;
    }

    if (isCreate) {
      useTeamStore.getState().addCustomAgent(def);
    } else {
      const { id: _, ...patch } = def;
      useTeamStore.getState().updateCustomAgent(id, patch);
    }
    setEditingId(null);
  };

  // ── Form view ──
  if (editingId) {
    const isCreate = editingId === "new";
    return (
      <div className="teamModalBody">
        <div className="teamSection">
          <div className="teamSectionTitle">{isCreate ? "创建团队成员" : "编辑团队成员"}</div>

          <div className="teamFormGroup">
            <label className="teamFormLabel">名称 *</label>
            <input className="teamFormInput" value={form.name} maxLength={32} placeholder="如：翻译助手"
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </div>

          <div className="teamFormGroup">
            <label className="teamFormLabel">头像</label>
            <input className="teamFormInput teamFormInputSmall" value={form.avatar} maxLength={4} placeholder="🤖"
              onChange={(e) => setForm((f) => ({ ...f, avatar: e.target.value }))} />
          </div>

          <div className="teamFormGroup">
            <label className="teamFormLabel">职责描述 *</label>
            <input className="teamFormInput" value={form.description} maxLength={200} placeholder="一句话描述职责"
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
          </div>

          <div className="teamFormGroup">
            <label className="teamFormLabel">System Prompt *</label>
            <textarea className="teamFormTextarea" value={form.systemPrompt} rows={6} placeholder="指导子 Agent 的行为..."
              onChange={(e) => setForm((f) => ({ ...f, systemPrompt: e.target.value }))} />
          </div>

          <div className="teamFormGroup">
            <label className="teamFormLabel">模型</label>
            <select className="teamFormSelect" value={form.model}
              onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}>
              <option value="haiku">haiku</option>
              <option value="sonnet">sonnet</option>
              <option value="opus">opus</option>
            </select>
          </div>

          <div className="teamFormGroup">
            <label className="teamFormLabel">工具策略</label>
            <select className="teamFormSelect" value={form.toolPolicy}
              onChange={(e) => setForm((f) => ({ ...f, toolPolicy: e.target.value as any }))}>
              <option value="readonly">只读 (readonly)</option>
              <option value="proposal_first">提案优先 (proposal_first)</option>
              <option value="auto_apply">自动执行 (auto_apply)</option>
            </select>
          </div>

          <div className="teamFormGroup">
            <label className="teamFormLabel">工具白名单</label>
            <div className="teamToolGrid">
              {AVAILABLE_TOOLS.map((tn) => (
                <label key={tn} className="teamToolItem">
                  <input type="checkbox" checked={form.tools.includes(tn)}
                    onChange={(e) => setForm((f) => ({
                      ...f,
                      tools: e.target.checked ? [...f.tools, tn] : f.tools.filter((t) => t !== tn),
                    }))} />
                  <span>{tn}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="teamFormGroup">
            <label className="teamFormLabel">预算</label>
            <div className="teamBudgetRow">
              <label>
                最大轮数
                <input type="number" className="teamFormInputSmall" value={form.maxTurns} min={1} max={30}
                  onChange={(e) => setForm((f) => ({ ...f, maxTurns: Number(e.target.value) || 10 }))} />
              </label>
              <label>
                最大工具调用
                <input type="number" className="teamFormInputSmall" value={form.maxToolCalls} min={1} max={100}
                  onChange={(e) => setForm((f) => ({ ...f, maxToolCalls: Number(e.target.value) || 20 }))} />
              </label>
              <label>
                超时(秒)
                <input type="number" className="teamFormInputSmall" value={Math.round(form.timeoutMs / 1000)} min={5} max={300}
                  onChange={(e) => setForm((f) => ({ ...f, timeoutMs: (Number(e.target.value) || 90) * 1000 }))} />
              </label>
            </div>
          </div>

          <div className="teamFormGroup">
            <label className="teamFormLabel">触发关键词</label>
            <input className="teamFormInput" value={form.triggerPatterns} placeholder="用顿号/逗号分隔，如：翻译、translate"
              onChange={(e) => setForm((f) => ({ ...f, triggerPatterns: e.target.value }))} />
          </div>

          <div className="teamFormGroup">
            <label className="teamFormLabel">优先级</label>
            <input type="number" className="teamFormInputSmall" value={form.priority} min={0} max={200}
              onChange={(e) => setForm((f) => ({ ...f, priority: Number(e.target.value) || 50 }))} />
          </div>

          {formError && <div className="teamFormError">{formError}</div>}

          <div className="teamFormActions">
            <button className="btn btnSecondary" onClick={() => setEditingId(null)}>取消</button>
            <button className="btn btnPrimary" onClick={handleSave}>{isCreate ? "创建" : "保存"}</button>
          </div>
        </div>
      </div>
    );
  }

  // ── List view ──
  const body = (
    <div className="teamModalBody">
          {/* Communication mode */}
          <div className="teamSection">
            <div className="teamSectionTitle">通信模式</div>
            <div className="teamModeRow">
              <label className="teamModeOption">
                <input
                  type="radio"
                  name="commMode"
                  value="relay"
                  checked={communicationMode === "relay"}
                  onChange={() => setCommunicationMode("relay")}
                />
                <span className="teamModeLabel">中转模式</span>
                <span className="teamModeDesc">默认。用户 → 负责人 → 子 Agent → 负责人 → 用户</span>
              </label>
              <label className="teamModeOption">
                <input
                  type="radio"
                  name="commMode"
                  value="broadcast"
                  checked={communicationMode === "broadcast"}
                  onChange={() => setCommunicationMode("broadcast")}
                />
                <span className="teamModeLabel">广播模式 <span className="teamBadgeExp">实验性</span></span>
                <span className="teamModeDesc">所有活跃 Agent 共享完整对话上下文，按相关性发言。Token 消耗较高。</span>
              </label>
            </div>
          </div>

          {/* Agent list */}
          <div className="teamSection">
            <div className="teamSectionTitleRow">
              <div className="teamSectionTitle">团队成员（{effectiveAgents.length}）</div>
              <button className="btn btnSmall btnPrimary" onClick={startCreate}>+ 创建成员</button>
            </div>
            <div className="teamAgentList">
              {effectiveAgents.map((agent) => {
                const isCustom = agent.source === "custom";
                const isExpanded = expandedId === agent.id;
                return (
                  <div key={agent.id} className={"teamAgentCard" + (agent.effectiveEnabled ? "" : " teamAgentDisabled")}>
                    <div className="teamAgentRow" onClick={() => setExpandedId(isExpanded ? null : agent.id)}>
                      <span className="teamAgentAvatar">{agent.avatar ?? "🤖"}</span>
                      <div className="teamAgentInfo">
                        <div className="teamAgentName">
                          {agent.name}
                          {isCustom && <span className="teamBadgeCustom">自定义</span>}
                        </div>
                        <div className="teamAgentMeta">{agent.model} · {agent.tools.length} 工具</div>
                      </div>
                      <div className="teamAgentActions" onClick={(e) => e.stopPropagation()}>
                        {isCustom && (
                          <>
                            <button className="btn btnIcon btnSmall" title="编辑" onClick={() => startEdit(agent.id)}>✎</button>
                            <button className="btn btnIcon btnSmall teamBtnDanger" title="删除"
                              onClick={() => { if (confirm(`确定删除「${agent.name}」？`)) handleDelete(agent.id); }}>✕</button>
                          </>
                        )}
                        <label className="teamToggle">
                          <input
                            type="checkbox"
                            checked={agent.effectiveEnabled}
                            onChange={(e) => setAgentEnabled(agent.id, e.target.checked)}
                          />
                          <span className="teamToggleSlider" />
                        </label>
                      </div>
                    </div>
                    {isExpanded && (
                      <div className="teamAgentDetail">
                        <div className="teamDetailRow"><span className="teamDetailLabel">ID</span><span>{agent.id}</span></div>
                        <div className="teamDetailRow"><span className="teamDetailLabel">职责</span><span>{agent.description}</span></div>
                        <div className="teamDetailRow"><span className="teamDetailLabel">工具</span><span>{agent.tools.join(", ") || "无"}</span></div>
                        <div className="teamDetailRow"><span className="teamDetailLabel">模型</span><span>{agent.model}{agent.fallbackModels?.length ? " → " + agent.fallbackModels.join(" → ") : ""}</span></div>
                        <div className="teamDetailRow"><span className="teamDetailLabel">工具策略</span><span>{agent.toolPolicy}</span></div>
                        <div className="teamDetailRow"><span className="teamDetailLabel">预算</span><span>最多 {agent.budget.maxTurns} 轮 / {agent.budget.maxToolCalls} 次工具 / {Math.round(agent.budget.timeoutMs / 1000)}s 超时</span></div>
                        <div className="teamDetailRow"><span className="teamDetailLabel">触发词</span><span>{agent.triggerPatterns?.join("、") || "无"}</span></div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
    </div>
  );

  if (embedded) return body;

  return (
    <div className="modalMask" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="teamModal">
        <div className="teamModalHeader">
          <h2 className="teamModalTitle">团队管理</h2>
          <button className="btn btnIcon" type="button" onClick={onClose} title="关闭">✕</button>
        </div>
        {body}
      </div>
    </div>
  );
}
