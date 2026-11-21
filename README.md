# task-hud（任务进度与计时）

Antigravity 插件：在多步骤任务执行过程中展示过程小总结、折叠工具链与实时计时任务面板，并在任务完成后自动折叠为单行耗时与完成摘要条；同时提供右侧 Sidecar 实时监控面板。

## 核心特性

- **按轮次独立面板隔离**：每轮多步骤任务自动使用独立 HTML 槽位（`task-hud-t1.html`、`task-hud-t2.html`……），避免同一会话内多轮互相覆盖。
- **过程透明化与工具链聚合**：通过 Hook 抽取本轮思考耗时、小总结与 `Ran / Analyzed / Edited` 工具链并默认折叠，面板内呈现当前步骤进度。
- **自动收起与追问接管**：任务全部完成后自动收起为单行完成条（`本轮用时 ... · 已完成 N/N 项任务`）；未完成时若用户中途追加需求，上一轮面板自动折叠为灰点接管条。
- **Sidecar 侧边栏面板**：提供实时任务状态、轮次计时与工具调用统计视图。
- **实时 Token 统计与回答末尾胶囊条**：自动读取本轮日志累加真实 Token 消耗并估算拆分主回答与插件开销（`总计 tok（主回答 / 插件）`），在最终回答末尾紧贴操作栏上方渲染独立的单行耗时与用量统计胶囊条。

## 目录结构

- `plugin.json`：插件清单与元信息
- `hooks.json`：生命周期 Hook 绑定（`SessionStart`、`PreInvocation`、`PreToolUse`、`PostToolUse`、`PostInvocation`、`Stop`）
- `rules/AGENTS.md`：任务进度面板使用与收尾规范
- `scripts/hook.mjs`：Hook 入口与每轮文件名追踪
- `scripts/state-store.mjs`：面板 HTML 模板生成、状态同步与会话数据持久化
- `scripts/mcp-server.mjs`：MCP 工具服务
- `sidecars/hud/`：右侧 Sidecar 面板前端与后端服务（`main.mjs`、`index.html`、`app.js`、`styles.css`、`sidecar.json`、`package.json`）
- `assets/logo.svg`：插件图标
- `mcp_config.json`：MCP 配置

## 安装方式

运行依赖 Node.js（支持 ESM，无需额外安装 `npm` 依赖）。

### 方式一：下载 Release 压缩包（推荐）

1. 前往仓库 [Releases](https://github.com/sakura-setsumi/antigravity-like-claude/releases) 页面，下载最新 `task-hud-v*.zip`；
2. 解压得到 `task-hud` 文件夹，将其放到 Antigravity 插件目录：
   - Windows：`C:\Users\<用户名>\.gemini\config\plugins\task-hud`
   - macOS / Linux：`~/.gemini/config/plugins/task-hud`
3. 在 Antigravity 插件管理中启用 **任务进度与计时 (`task-hud`)** 即可。

### 方式二：通过 Git 克隆

```bash
git clone https://github.com/sakura-setsumi/antigravity-like-claude.git ~/.gemini/config/plugins/task-hud
```

后续更新只需在插件目录执行 `git pull`。
