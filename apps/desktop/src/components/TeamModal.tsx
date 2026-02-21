import { useState } from "react";
import { BUILTIN_SUB_AGENTS } from "@writing-ide/agent-core";
import { useTeamStore, type CommunicationMode } from "../state/teamStore";

export function TeamModal({ onClose }: { onClose: () => void }) {
  const agentOverrides = useTeamStore((s) => s.agentOverrides);
  const communicationMode = useTeamStore((s) => s.communicationMode);
  const setAgentEnabled = useTeamStore((s) => s.setAgentEnabled);
  const setCommunicationMode = useTeamStore((s) => s.setCommunicationMode);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="modalMask" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="teamModal">
        <div className="teamModalHeader">
          <h2 className="teamModalTitle">团队管理</h2>
          <button className="btn btnIcon" type="button" onClick={onClose} title="关闭">✕</button>
        </div>

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
            <div className="teamSectionTitle">团队成员（{BUILTIN_SUB_AGENTS.length}）</div>
            <div className="teamAgentList">
              {BUILTIN_SUB_AGENTS.map((agent) => {
                const eff = agentOverrides[agent.id]?.enabled ?? agent.enabled;
                const isExpanded = expandedId === agent.id;
                return (
                  <div key={agent.id} className={"teamAgentCard" + (eff ? "" : " teamAgentDisabled")}>
                    <div className="teamAgentRow" onClick={() => setExpandedId(isExpanded ? null : agent.id)}>
                      <span className="teamAgentAvatar">{agent.avatar ?? "🤖"}</span>
                      <div className="teamAgentInfo">
                        <div className="teamAgentName">{agent.name}</div>
                        <div className="teamAgentMeta">{agent.model} · {agent.tools.length} 工具 · {agent.skills.length} 技能</div>
                      </div>
                      <label className="teamToggle" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={eff}
                          onChange={(e) => setAgentEnabled(agent.id, e.target.checked)}
                        />
                        <span className="teamToggleSlider" />
                      </label>
                    </div>
                    {isExpanded && (
                      <div className="teamAgentDetail">
                        <div className="teamDetailRow"><span className="teamDetailLabel">ID</span><span>{agent.id}</span></div>
                        <div className="teamDetailRow"><span className="teamDetailLabel">职责</span><span>{agent.description}</span></div>
                        <div className="teamDetailRow"><span className="teamDetailLabel">工具</span><span>{agent.tools.join(", ") || "无"}</span></div>
                        <div className="teamDetailRow"><span className="teamDetailLabel">技能</span><span>{agent.skills.join(", ") || "无"}</span></div>
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
      </div>
    </div>
  );
}
