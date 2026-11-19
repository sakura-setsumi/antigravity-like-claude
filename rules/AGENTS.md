# 任务进度与过程透明化规范（task-hud）

1. **执行中展示「小总结 + 工具链 + 任务面板」，完成后自动收起只保留最终总结（且每轮使用独立文件防历史覆盖）**：
   - **禁止**输出 `> 📋 ...` Markdown 任务列表，**禁止**调用 `task_hud_set_tasks` / `task_hud_update_task` 工具，也**严禁在同一次回答中输出 2 个及以上 `<agent-embed>` 标签**。
   - 插件 Hook 已在当前会话的 `<Artifact Directory Path>/` 预先生成好按轮次隔离的空白面板模板：`task-hud-t1.html`、`task-hud-t2.html`、……、`task-hud-t24.html`（若超出也会自动顺延准备），每份初始 `#task-hud-tasks` 为：
     ```html
       <script id="task-hud-tasks" type="application/json">
     {
       "taskTitle": "任务进度",
       "logs": [],
       "tasks": []
     }
       </script>
     ```
   - 当收到需要 **2 个及以上步骤** 才能完成的任务时，严格按以下步骤执行：
     0. **选择本轮专属文件名（防多轮互相覆盖，严禁复用旧轮次文件）**：
        - 检查上文对话中已输出过的 `<agent-embed src=".../task-hud-t<K>.html">` 最高编号：
          - 若本会话此前尚未嵌入过 `task-hud-t*.html`（即使旧会话曾使用过无编号的 `task-hud.html`），本轮选 **`task-hud-t1.html`**；
          - 若上文已嵌入过的最高编号为 `task-hud-t<K>.html`，本轮严格顺延选 **`task-hud-t<K+1>.html`**（即使上一轮中途被打断或追加新需求，Hook 会自动移除上一个未完成的任务栏，新轮次仍必须严格顺延递增新编号 `t<K+1>`，绝不能复用或覆盖旧编号）。
     1. **第 1 步（先写好任务列表，返回成功后再输出唯一 1 次 `<agent-embed>`）**：
        - 无需先 `read_file`，先调用 `edit_file` 修改 `<Artifact Directory Path>/<本轮文件名>`（例如 `task-hud-t1.html`）中的 `#task-hud-tasks`（`Target` 必须完整包含初始模板中的 `"logs": []` 与 `"tasks": []` 两个空数组，切勿截断在 `"tasks":` 导致尾部残留多余 `[]` 破坏 JSON；全程所有步骤均必须带上 `ArtifactMetadata: { Summary: "任务进度面板", UserFacing: false, RequestFeedback: false }`，切勿设为 `UserFacing: true`，否则最终总结底部会多出多余的 Artifact 卡片）：
          - `"logs"` 数组写入第 1 条小总结（说明第一步要操作的目标文件、符号或命令，关键项用反引号 `` ` `` 标出）；
          - `"tasks"` 数组写入任务步骤列表（每项格式为 `{ "id": "1", "title": "步骤名称", "status": "in_progress" }`，第 1 项设为 `"in_progress"`，其余设为 `"pending"`）。
          *(注：仅当极少数情况下所选文件已意外存在内容导致 `edit_file` 不匹配时，先顺延换下一个 `t<K+1>` 或 `read_file` 后替换即可)*。
        - 待上述 `edit_file` 成功写入后，在紧接着的回复中**直接且仅输出唯一一次 `<agent-embed>`**（不要在 `<agent-embed>` 外面写过程文字），**并且必须在同一步响应中紧接着发起至少 1 个下一步的业务工具调用**（例如 `read_file`、`run_command`、`grep_search` 等；**严禁只输出 `<agent-embed>` 而不调用任何工具**，否则宿主会判定为结束并中断任务）：
          ```markdown
          <agent-embed src="file:///<Artifact Directory Path>/<本轮文件名>"></agent-embed>
          ```
     2. **中间每一步（仅在 `<本轮文件名>` 内追加小总结，聊天框外不输出任何过程文字）**：
        - 在最终总结之前的**所有中间步骤**（包括连续调用工具、排查代码、以及等待后台命令/定时器唤醒时），**严禁在聊天回复外面输出任何过程文字或等待提示（例如 `⏳ 正在等待...`）**，等待后台命令时直接空文本结束本步等系统唤醒即可（否则会在总结上方残留分段文本）；
        - 每一轮都通过调用 `edit_file` 更新 `<Artifact Directory Path>/<本轮文件名>` 中的 `#task-hud-tasks`：
          - 在 `"logs"` 数组末尾**追加**本步的 1～2 句简练小总结（插件 Hook 会自动将已完成的 `Thought for Xs ›` 与 `Ran / Analyzed / Edited` 工具链穿插渲染在每步小总结之间，并把底部的任务面板自然不断顶到最下方）；
          - 当阶段推进时，同步将 `"tasks"` 中已完成项设为 `"completed"`、当前进行项设为 `"in_progress"`（注意：在全部验证完成前，至少保留最后一项为 `"in_progress"` 或 `"pending"`，以保持面板处于展开状态）。
     3. **会话完成收尾（自动收起过程面板，只保留最后的总结）**：
        - 当所有代码修改与测试验证均已完成、准备结束本轮会话时：
          a) 先在最后一次工具调用中，通过 `edit_file` 将 `<Artifact Directory Path>/<本轮文件名>` 中的 `"tasks"` **全部设为 `"completed"`**（带上 `ArtifactMetadata: { Summary: "任务进度面板", UserFacing: false, RequestFeedback: false }`）。当 `"tasks"` 全部变为 `"completed"` 时，该独立文件会冻结并折叠成一行极简完成条（`本轮用时 ... · 已完成 N/N 项任务`），点击可展开查看本轮明细；
          b) 紧接着在**最后一轮纯文本回复**中，直接输出清晰完整的**最终总结**（切勿再次输出 `<agent-embed>`）。
2. **保持低开销**：简单问答或单步查询无需嵌入或修改任何 `task-hud*.html` 文件。
3. **只读模式（`Plan mode` / `Orchestrator`）与 Hook 自动兜底规范**：
   - 当处于只读规划模式导致 `edit_file` 工具不可用时，**不要尝试绕过只读限制或手动写文件**；收到需要 **2 个及以上步骤**（检索、分析、规划）的任务时，按以下流程执行：
     1. **第 1 步主动嵌入唯一 1 次 `<agent-embed>` 并同时发起只读工具调用**：按第 1 条第 0 步规则顺延选定本轮文件名 `<本轮文件名>`（首次为 `task-hud-t1.html`），直接在回复文本中输出唯一一次 `<agent-embed src="file:///<Artifact Directory Path>/<本轮文件名>"></agent-embed>`（标签外不要写过程文字），**并在同一步响应中发起至少 1 个只读业务工具调用**（如 `read_file`、`run_command` 等）。Hook 会在工具启动时自动初始化该槽位的默认任务、工具链与实时计时。
     2. **中间只读步骤保持聊天流干净**：嵌入面板后、最终回复或调用 `exit_plan_mode` 之前的所有中间步骤，**不要在聊天框外散落过程文字**，直接调用只读工具即可；执行 `run_command` 时在 `toolSummary` 中填写简练中文摘要，Hook 会自动聚合进面板的折叠工具链中。
     3. **收尾或移交执行（`exit_plan_mode`）**：
        - 若为纯排查/问答、无需修改代码：最后一轮纯文本直接输出完整结论即可，`Stop` Hook 会自动将面板中的默认任务全部标为 `"completed"` 并折叠成单行完成条；
        - 若需调用 `exit_plan_mode` 移交执行模型：在 `plan` 中明确注明“本轮已挂载的任务进度面板为 `<Artifact Directory Path>/<本轮文件名>`，执行阶段**切勿再输出新的 `<agent-embed>`**，请直接用 `edit_file` 更新该文件中的 `"logs"` 与 `"tasks"`（带上 `ArtifactMetadata: { Summary: "任务进度面板", UserFacing: false, RequestFeedback: false }`），全部验证完成后将 `"tasks"` 全部设为 `"completed"` 再输出最终总结”。
   - **Hook 自动兜底提醒衔接**：若某轮未在首步主动嵌入 `<agent-embed>`，收到 Hook 系统消息提示“任务进度面板槽位 `task-hud-t<K>.html` 已就绪，但当前对话界面尚未嵌入该面板”时：
     - 若后续仍需继续调用工具，在下一轮回复中补发唯一一次该槽位的 `<agent-embed>` 并同时发起业务工具调用；
     - 若已准备直接给出最终回答，则无需再嵌入（Hook 会在本轮结束后自动清理未嵌入的空跑槽位）。
