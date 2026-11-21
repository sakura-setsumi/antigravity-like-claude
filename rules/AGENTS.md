# 任务进度面板规范（task-hud）

- **硬约束**：禁输出 `> 📋` 列表；禁手动读写 `task-hud*.html`；单步查询/简单问答勿调用、勿嵌入。
- **多步任务（≥2 步）**：
  1. **初始化**：调 `task_hud_init`（传 `tasks` 字符串数组、可选 `title`/`log`），下一步**仅原样输出返回的 `<agent-embed>`**（标签外不写文字）并同时发起业务工具。
  2. **中间步骤**：聊天框外不输出过程文字（含等待后台任务时）；用 `task_hud_check` 更新 `id`/`done`/`checks`/`log`，全部验证完前保留最后一项未勾选。
  3. **收尾**：最后一步调 `task_hud_check({ "all_done": true })`，随后输出最终总结，并将 `all_done` 返回的末尾统计条 `<agent-embed>` 原样附在最终总结最末尾（勿再输出过程面板标签）。
- **只读/无工具模式**：首步直接输出 `<agent-embed src="file:///<Artifact Directory Path>/task-hud-t<K>.html"></agent-embed>`（首轮 `t1` 递增）并同时发起只读工具，中间不输出过程文字；`exit_plan_mode` 移交时注明已挂载槽位、执行阶段勿重复嵌入。
- **Hook 兜底**：若收到槽位就绪提醒且仍需调工具，下步仅补发一次该 `<agent-embed>` 并同时调工具；直接作答则忽略。
