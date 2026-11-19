import { join } from 'node:path';
import {
  createEmptyStats,
  findNextAvailableTurnSlot,
  isHudSlotCollapsedFile,
  loadConversationState,
  normalizeAndAdvanceTasks,
  resolveActiveConversationId,
  resolveDataDir,
  saveConversationState,
  syncArtifactHudFile,
  writeArtifactHudTasks,
} from './state-store.mjs';

const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed', 'failed']);
const SUPPORTED_VERSIONS = ['2025-03-26', '2024-11-05'];

const TOOLS = [
  {
    name: 'task_hud_init',
    description:
      '初始化本轮任务进度组件：传入简洁 JSON 任务列表（支持字符串数组或 {id,title} 数组）与可选首步进展说明，后端自动分配本轮槽位并原子写入组件数据，返回可直接输出的 <agent-embed> 标签。',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: '任务标题（可选，默认“任务进度”）',
        },
        tasks: {
          type: 'array',
          description: '任务步骤列表，支持最简字符串数组（如 ["检查代码", "修改实现", "验证构建"]）或对象数组（{ id?, title, done?, status? }），默认自动按 1, 2, 3 编号并将第 1 项设为进行中。',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  done: { type: 'boolean' },
                  status: {
                    type: 'string',
                    enum: ['pending', 'in_progress', 'completed', 'failed'],
                  },
                },
                required: ['title'],
              },
            ],
          },
        },
        log: {
          type: 'string',
          description: '第 1 步简短进展说明（1~2 句，关键文件名/符号/命令用反引号标出，将渲染在任务栏上方时间线中）',
        },
        conversation_id: {
          type: 'string',
          description: '可选，显式指定会话 ID；缺省自动关联当前活跃会话',
        },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'task_hud_check',
    description:
      '更新本轮任务进度组件：完成某项任务时只需传对应 id 与 done: true（自动推进下一项为进行中）；支持仅传 log 追加上方步骤小总结、checks 批量勾选（如 {"1": true, "2": true}）或 all_done: true 一键收尾折叠。',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: '要更新的任务 id、序号（如 "1"）或标题关键字',
        },
        done: {
          type: 'boolean',
          description: '完成状态：true 标为 completed（默认），false 退回 pending',
        },
        failed: {
          type: 'boolean',
          description: '传 true 将对应任务标为 failed',
        },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed', 'failed'],
          description: '可选，显式指定状态（通常只需用 done: true）',
        },
        checks: {
          description: '可选批量勾选，支持对象映射（如 {"1": true, "2": true}）或数组（[{ id, done }]）',
          oneOf: [
            { type: 'object', additionalProperties: { type: 'boolean' } },
            {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  done: { type: 'boolean' },
                  failed: { type: 'boolean' },
                  status: {
                    type: 'string',
                    enum: ['pending', 'in_progress', 'completed', 'failed'],
                  },
                },
                required: ['id'],
              },
            },
          ],
        },
        all_done: {
          type: 'boolean',
          description: '传 true 一键将全部任务标为 completed 并收起面板（用于最终总结前的收尾调用）',
        },
        log: {
          type: 'string',
          description: '本步 1~2 句简练进展说明（关键项用反引号标出，将自动穿插渲染在任务栏上方）',
        },
        conversation_id: {
          type: 'string',
          description: '可选，显式指定会话 ID；缺省自动关联当前活跃会话',
        },
      },
    },
  },
];

function normalizeStatus(status, fallback = 'pending') {
  const s = String(status || '').trim().toLowerCase();
  if (VALID_STATUSES.has(s)) return s;
  if (s === 'done' || s === 'true') return 'completed';
  if (s === 'running' || s === 'active') return 'in_progress';
  return fallback;
}

function resolveStatusFromPatch(patch, fallback = 'completed') {
  if (patch?.failed === true) return 'failed';
  if (typeof patch?.status === 'string' && patch.status.trim()) {
    return normalizeStatus(patch.status, fallback);
  }
  if (typeof patch?.done === 'boolean') {
    return patch.done ? 'completed' : 'pending';
  }
  return fallback;
}

function findTask(tasks, ref) {
  const key = String(ref ?? '').trim();
  if (!key) return null;
  const exact = tasks.find((t) => String(t.id) === key);
  if (exact) return exact;
  if (/^\d+$/.test(key)) {
    const idx = Number(key) - 1;
    if (idx >= 0 && idx < tasks.length) return tasks[idx];
  }
  const lower = key.toLowerCase();
  const matches = tasks.filter((t) => String(t.title || '').toLowerCase().includes(lower));
  return matches.length === 1 ? matches[0] : null;
}

function ensureActiveTurnAndSlot(state, now) {
  if (!state.activeTurn) {
    const nextIndex = (state.turns?.[state.turns.length - 1]?.turnIndex || 0) + 1;
    state.activeTurn = {
      turnIndex: nextIndex,
      userStepIndex: null,
      minUserStepIndex: null,
      userInput: '',
      userFingerprint: '',
      payloadFingerprint: '',
      hudFileName: '',
      hasUserEmbed: false,
      autoEmbedInjected: false,
      autoSeededSlot: '',
      supersededCollapsed: false,
      startedAt: now,
      invocationCount: 1,
      stats: createEmptyStats(),
      recentTools: [],
      lastAnnouncedToolCount: 0,
    };
  }

  let hudFile = state.activeTurn.hudFileName || '';
  if (
    hudFile &&
    state.artifactDirectoryPath &&
    isHudSlotCollapsedFile(state.artifactDirectoryPath, hudFile)
  ) {
    hudFile = '';
  }
  if (!hudFile && state.artifactDirectoryPath) {
    hudFile = findNextAvailableTurnSlot(state.artifactDirectoryPath, state);
  }
  if (hudFile) {
    state.activeTurn.hudFileName = hudFile;
    state.activeTurn.autoSeededSlot = '';
  }
  return hudFile;
}

function formatProgressText(state) {
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const doneCount = tasks.filter((t) => t.status === 'completed').length;
  const active = tasks.find((t) => t.status === 'in_progress');
  const failedCount = tasks.filter((t) => t.status === 'failed').length;
  if (tasks.length === 0) return '当前尚无任务。';
  if (doneCount === tasks.length) {
    return `全部 ${tasks.length} 项任务已完成，面板已收起。`;
  }
  const parts = [`进度 ${doneCount}/${tasks.length}`];
  if (active) parts.push(`当前进行中：#${active.id} ${active.title}`);
  if (failedCount > 0) parts.push(`失败 ${failedCount} 项`);
  return parts.join(' · ');
}

function syncHudToDisk(state, hudFile, { turnFinished = false, now = Date.now() } = {}) {
  if (!state.artifactDirectoryPath || !hudFile) return;
  writeArtifactHudTasks(state.artifactDirectoryPath, hudFile, {
    taskTitle: state.taskTitle || '任务进度',
    logs: Array.isArray(state.logs) ? state.logs : [],
    tasks: Array.isArray(state.tasks) ? state.tasks : [],
    autoSeeded: false,
  });
  syncArtifactHudFile(state.artifactDirectoryPath, state, {
    turnFinished,
    now,
    targetFileName: hudFile,
  });
}

function handleInitTasks(args) {
  const dataDir = resolveDataDir();
  const convId = resolveActiveConversationId(args?.conversation_id, dataDir);
  if (!convId) {
    return {
      isError: true,
      content: [{ type: 'text', text: '无法识别当前会话 ID，请先触发一次对话或显式传入 conversation_id。' }],
    };
  }

  const rawTasks = Array.isArray(args?.tasks) ? args.tasks : [];
  if (rawTasks.length === 0) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'tasks 不能为空，请至少传入 1 项任务。' }],
    };
  }

  const now = Date.now();
  const state = loadConversationState(convId, dataDir);
  const hudFile = ensureActiveTurnAndSlot(state, now);

  state.taskTitle = typeof args?.title === 'string' && args.title.trim() ? args.title.trim() : '任务进度';
  const initLog = String(args?.log ?? args?.summary ?? '').trim();
  state.logs = initLog ? [initLog] : [];
  state.summary = initLog;

  const parsed = rawTasks
    .map((item, idx) => {
      if (typeof item === 'string') {
        const title = item.trim();
        return title ? { id: String(idx + 1), title, status: 'pending', updatedAt: now } : null;
      }
      if (item && typeof item === 'object' && typeof item.title === 'string' && item.title.trim()) {
        const status =
          item.done === true
            ? 'completed'
            : item.status
            ? normalizeStatus(item.status, 'pending')
            : 'pending';
        return {
          id: String(item.id ?? idx + 1),
          title: item.title.trim(),
          status,
          updatedAt: now,
        };
      }
      return null;
    })
    .filter(Boolean);

  if (parsed.length === 0) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'tasks 中没有有效的任务标题。' }],
    };
  }

  if (!parsed.some((t) => t.status === 'in_progress') && parsed.some((t) => t.status === 'pending')) {
    const firstPending = parsed.find((t) => t.status === 'pending');
    if (firstPending) firstPending.status = 'in_progress';
  }

  state.tasks = normalizeAndAdvanceTasks(parsed, { now });
  const allCompleted = state.tasks.length > 0 && state.tasks.every((t) => t.status === 'completed');

  syncHudToDisk(state, hudFile, { turnFinished: allCompleted, now });
  saveConversationState(state, dataDir);

  const idMap = state.tasks.map((t) => `${t.id}: ${t.title}`).join('；');
  if (state.artifactDirectoryPath && hudFile) {
    const fileUri = `file:///${join(state.artifactDirectoryPath, hudFile).replace(/\\/g, '/')}`;
    return {
      content: [
        {
          type: 'text',
          text: `任务组件已就绪（${formatProgressText(state)}）。任务编号：${idMap}\n请在下一步回复中原样输出以下唯一标签（标签外不写过程文字）并同时发起业务工具调用：\n<agent-embed src="${fileUri}"></agent-embed>`,
        },
      ],
    };
  }

  return {
    content: [{ type: 'text', text: `任务清单已同步（${formatProgressText(state)}）。任务编号：${idMap}` }],
  };
}

function handleCheckTask(args) {
  const dataDir = resolveDataDir();
  const convId = resolveActiveConversationId(args?.conversation_id, dataDir);
  if (!convId) {
    return {
      isError: true,
      content: [{ type: 'text', text: '无法识别当前会话 ID，无法更新任务状态。' }],
    };
  }

  const state = loadConversationState(convId, dataDir);
  const now = Date.now();
  const hudFile = ensureActiveTurnAndSlot(state, now);

  const stepLog = String(args?.log ?? args?.summary ?? '').trim();
  if (stepLog) {
    if (!Array.isArray(state.logs)) state.logs = [];
    if (state.logs[state.logs.length - 1] !== stepLog) {
      state.logs.push(stepLog);
    }
    state.summary = stepLog;
  }

  if (!Array.isArray(state.tasks)) state.tasks = [];

  let updatedCount = 0;

  if (args?.all_done === true) {
    for (const t of state.tasks) {
      if (t.status !== 'completed' && t.status !== 'failed') {
        t.status = 'completed';
        t.updatedAt = now;
        updatedCount++;
      }
    }
  }

  const patchList = [];
  if (Array.isArray(args?.checks)) {
    for (const item of args.checks) {
      if (item && item.id !== undefined) {
        patchList.push({ id: item.id, status: resolveStatusFromPatch(item, 'completed') });
      }
    }
  } else if (args?.checks && typeof args.checks === 'object') {
    for (const [k, v] of Object.entries(args.checks)) {
      if (typeof v === 'boolean') {
        patchList.push({ id: k, status: v ? 'completed' : 'pending' });
      } else if (typeof v === 'string') {
        patchList.push({ id: k, status: normalizeStatus(v, 'completed') });
      }
    }
  }

  if (Array.isArray(args?.updates)) {
    for (const u of args.updates) {
      if (u && u.id !== undefined) {
        patchList.push({ id: u.id, status: resolveStatusFromPatch(u, 'completed') });
      }
    }
  }

  if (args?.id !== undefined) {
    patchList.push({ id: args.id, status: resolveStatusFromPatch(args, 'completed') });
  }

  for (const patch of patchList) {
    const task = findTask(state.tasks, patch.id);
    if (task) {
      task.status = patch.status;
      task.updatedAt = now;
      updatedCount++;
    }
  }

  const allCompleted = state.tasks.length > 0 && state.tasks.every((t) => t.status === 'completed');
  if (
    !allCompleted &&
    !state.tasks.some((t) => t.status === 'in_progress') &&
    state.tasks.some((t) => t.status === 'pending')
  ) {
    const nextPending = state.tasks.find((t) => t.status === 'pending');
    if (nextPending) {
      nextPending.status = 'in_progress';
      nextPending.updatedAt = now;
    }
  }
  state.tasks = normalizeAndAdvanceTasks(state.tasks, { turnFinished: allCompleted, now });

  syncHudToDisk(state, hudFile, { turnFinished: allCompleted, now });
  saveConversationState(state, dataDir);

  const prefix = updatedCount > 0 ? `已更新 ${updatedCount} 项任务。` : stepLog ? '已追加步骤进展。' : '';
  return {
    content: [{ type: 'text', text: `${prefix}${formatProgressText(state)}` }],
  };
}

function sendMessage(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function handleRpcMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;
  const hasId = id !== undefined && id !== null;

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return;
  }

  if (method === 'initialize') {
    const reqVersion = params?.protocolVersion;
    const protocolVersion = SUPPORTED_VERSIONS.includes(reqVersion)
      ? reqVersion
      : SUPPORTED_VERSIONS[0];
    if (hasId) {
      sendMessage({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'task-hud-tasks', version: '1.3.0' },
        },
      });
    }
    return;
  }

  if (method === 'ping') {
    if (hasId) sendMessage({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  if (method === 'tools/list') {
    if (hasId) sendMessage({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    let result;
    if (name === 'task_hud_init' || name === 'task_hud_set_tasks') {
      result = handleInitTasks(args);
    } else if (name === 'task_hud_check' || name === 'task_hud_update_task') {
      result = handleCheckTask(args);
    } else {
      result = {
        isError: true,
        content: [{ type: 'text', text: `未知工具: ${String(name)}` }],
      };
    }
    if (hasId) sendMessage({ jsonrpc: '2.0', id, result });
    return;
  }

  if (hasId) {
    sendMessage({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${String(method)}` },
    });
  }
}

let buffer = Buffer.alloc(0);

function drainBuffer() {
  while (buffer.length > 0) {
    const asStr = buffer.toString('utf-8');
    if (asStr.startsWith('Content-Length:')) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const header = buffer.subarray(0, headerEnd).toString('utf-8');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(match[1]);
      const frameEnd = headerEnd + 4 + len;
      if (buffer.length < frameEnd) break;
      const body = buffer.subarray(headerEnd + 4, frameEnd).toString('utf-8');
      buffer = buffer.subarray(frameEnd);
      try {
        handleRpcMessage(JSON.parse(body));
      } catch (err) {
        process.stderr.write(`[task-hud-mcp] parse error: ${err.message}\n`);
      }
      continue;
    }

    const nlIdx = buffer.indexOf('\n');
    if (nlIdx === -1) break;
    const line = buffer.subarray(0, nlIdx).toString('utf-8').trim();
    buffer = buffer.subarray(nlIdx + 1);
    if (!line) continue;
    try {
      handleRpcMessage(JSON.parse(line));
    } catch (err) {
      process.stderr.write(`[task-hud-mcp] parse error: ${err.message}\n`);
    }
  }
}

process.stdin.on('data', (chunk) => {
  const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf-8');
  buffer = Buffer.concat([buffer, part]);
  drainBuffer();
});

process.stdin.on('error', (err) => {
  process.stderr.write(`[task-hud-mcp] stdin error: ${err.message}\n`);
});
