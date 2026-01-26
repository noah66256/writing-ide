## 使用说明视频公开链接 v0.1（Gateway）

### 目标
- 在未集成 Desktop 前，先提供一个“可直接观看”的公开视频链接，方便对外发使用说明。

### 路由
- `GET /help/tutorial`：播放页（内嵌 `<video controls>`）
- `GET /help/tutorial.mp4`：mp4 流式输出（支持 `Range`，可拖动/快进）

### 配置（环境变量）
- `TUTORIAL_VIDEO_PATH`（可选）：服务器上 mp4 的绝对路径
  - **未配置时默认**：项目根目录 `1月26日.mp4`
- `TUTORIAL_VIDEO_TITLE`（可选）：播放页标题
- `TUTORIAL_VIDEO_CACHE_CONTROL`（可选）：mp4 的 Cache-Control

### 部署步骤（示例）
1) 把 mp4 放到服务器（两种方式任选）
   - 方式 A：随 git 部署（确保仓库根目录存在 `1月26日.mp4`）
   - 方式 B：独立目录（推荐）：例如 `/data/writing-ide/media/1月26日.mp4`，并设置 `TUTORIAL_VIDEO_PATH`
2) 重启 gateway（pm2）
3) 验证：
   - 打开 `/help/tutorial` 能播放
   - 播放时拖动进度条不应从头重新下载（Range 生效）

### 回滚
- 删除上述路由代码并重新部署；或将 `TUTORIAL_VIDEO_PATH` 指向不存在文件以临时下线（会返回 404）。


