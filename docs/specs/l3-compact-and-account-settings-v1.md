# L3 自动压缩修复 + 设置内账号页收口 v1

日期：2026-03-19

## 1. 目标

本次收两个直接影响可用性的点：

1. 修复 L3 自动压缩长期不触发的问题。
2. 压缩后不再把工具调用轨迹带进模型可见历史，只保留用户/助手对话内容。
3. 把“积分”从左下头像旁移除，统一收进设置里的“账号”标签。
4. 账号页直接展示积分余额、真实 usage 汇总、最近 run、积分流水和充值入口。
5. 清理旧账户 modal / footer 遗留壳，避免同一能力出现两套 UI。

---

## 2. L3 压缩实现

### 2.1 触发阈值

旧实现的问题：

- 阈值按整模型窗口的 `75% / 80% / 85%` 算。
- 压力估算拿的是“工具 180 字符摘要”后的对话，严重低估真实上下文压力。

新实现：

- 阈值改为按 L3 对话预算触发：
  - `ctx >= 200k -> 0.42`
  - `ctx >= 100k -> 0.38`
  - `ctx >= 50k -> 0.34`
  - 其它 -> `0.30`
- 压力估算拆成两层：
  - 模型可见对话：只保留 `user / assistant`
  - 压缩触发压力：仍计入 tool input/output 的近真实体积

### 2.2 对话保留策略

- `RECENT_DIALOGUE` 与 `DIALOGUE_SUMMARY` 不再注入工具轨迹。
- `buildDialogueTurnsFromSteps()` 内部为每一轮额外累积 `pressureTokens`，供 compact 判定使用。
- 用户消息里的 `images` 会转成 `【附图 n 张】` 事实占位，避免图片轮次在摘要时彻底消失。

### 2.3 压缩游标

- 压缩判定只看：
  - `previousSummary`
  - `cursor` 之后尚未被摘要覆盖的完整回合
  - 当前可能尚未闭合的 pending user turn
- 避免“已经被摘要过的历史再次反复累计”，导致假高压或重复摘要。

---

## 3. 账号页收口实现

### 3.1 入口调整

- 左下头像旁不再展示积分。
- 设置弹层中的“设置”默认打开 `account` tab。
- `SettingsModal` 新增 `account` 标签，并排在最前。

### 3.2 新账号页内容

设置内账号页统一展示：

- 当前账号身份信息
- 积分余额
- lifetime usage
- recent 30d usage
- chat / agent 分模式 usage
- 最近 runs
- 积分流水
- 充值积分
- Gateway 覆盖地址

### 3.3 接口

新增用户侧接口：

- `GET /api/account/usage-summary`

返回：

- `lifetime`
- `recent30d`
- `byMode.chat`
- `byMode.agent`
- `recentRuns`

数据源：

- `db.runAudits`

---

## 4. 死代码清理

已删除：

- `apps/desktop/src/components/AccountFooter.tsx`
- 旧版 `apps/desktop/src/components/AccountModal.tsx`

已替换为：

- `apps/desktop/src/components/AccountSettingsPanel.tsx`

结果：

- 账号能力只剩“设置页内嵌面板”这一套 UI
- 不再维护 modal 旧壳
- 不再存在头像旁积分 + 设置页积分双入口

---

## 5. 验收结果

### 5.1 构建

已通过：

- `npm run -w @ohmycrab/gateway build`
- `npm run -w @ohmycrab/desktop build`

### 5.2 本地 UI smoke

方式：

- `npm run -w @ohmycrab/desktop preview -- --host 127.0.0.1 --port 4173`
- 用 Playwright 打开 preview
- 注入本地 mock 登录态与 mock `/api/*` 响应，验证设置-账号页的真实渲染与关键交互

已验证：

1. 左下设置菜单可打开设置页，默认进入“账号”标签。
2. 新账号页可展示账号、积分、usage、最近 run。
3. “查看流水”可展开并渲染积分流水。
4. “生成二维码”可渲染支付二维码与支付链接区块。

备注：

- preview 环境唯一 console error 为 `favicon.ico 404`，与本次改动无关。
- 本地 preview 使用 mock 接口做 UI smoke；真实接口将在部署后再做线上验证。

---

## 6. 关键文件

- `apps/desktop/src/agent/gatewayAgent.ts`
- `apps/desktop/src/state/authStore.ts`
- `apps/gateway/src/index.ts`
- `apps/desktop/src/ui/components/SettingsModal.tsx`
- `apps/desktop/src/ui/components/NavSidebar.tsx`
- `apps/desktop/src/components/AccountSettingsPanel.tsx`

---

## 7. 后续建议

如果后面继续做：

1. 可以把 usage 统计再补一个时间维度筛选（7d / 30d / all）。
2. 可以考虑把最近 run 支持点击跳转审计详情。
3. 若后续要做积分/账单体系，再从当前账号页拆出“账单”子 tab，而不是回退到 modal。
