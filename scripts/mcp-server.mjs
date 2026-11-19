import {
  loadConversationState,
  normalizeAndAdvanceTasks,
  resolveActiveConversationId,
  resolveDataDir,
  saveConversationState,
} from './state-store.mjs';

const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed', 'failed']);
const SUPPORTED_VERSIONS = ['2025-03-26', '2024-11-05'];

const TOOLS = [
  {
    name: 'task_hud_set_tasks',
    description:
      '设置或替换当前会话的任务进度清单，供右侧 Task HUD 面板实时展示。多步骤任务开始时调用一次。',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: '任务总标题（可选，建议简短）',
        },
        summary: {
          type: 'string',
          description: '一句简短的当前阶段说明（可选，例如：应用已关闭，正在构建新的 exe）',
        },
        tasks: {
          type: 'array',
          description: '任务步骤列表',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '可选步骤标识，缺省自动按顺序编号 1, 2...' },
              title: { type: 'string', description: '步骤名称（建议 6-20 字）' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed', 'failed'],
                description: '步骤状态，默认为 pending',
              },
            },
            required: ['title'],
          },
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
    name: 'task_hud_update_task',
    description:
      '更新现有任务清单中的步骤状态或当前进度说明。支持单条更新（id + status）或批量更新（updates）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: '要更新的任务 id、序号（如 "1"）或标题关键字',
        },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed', 'failed'],
          description: '目标状态',
        },
        summary: {
          type: 'string',
          description: '同步更新的一句话进度说明（可选）',
        },
        updates: {
          type: 'array',
          description: '批量更新列表，每项包含 id 和 status',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed', 'failed'],
              },
            },
            required: ['id', 'status'],
          },
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
  if (s === 'done') return 'completed';
  if (s === 'running' || s === 'active') return 'in_progress';
  return fallback;
}

function findTask(tasks, ref) {
  const key = String(ref ?? '').trim();
  if (!key) return null;
  let found = tasks.find((t) => String(t.id) === key);
  if (found) return found;
  if (/^\d+$/.test(key)) {
    const idx = Number(key) - 1;
    if (idx >= 0 && idx < tasks.length) return tasks[idx];
  }
  const lower = key.toLowerCase();
  const matches = tasks.filter((t) => String(t.title || '').toLowerCase().includes(lower));
  return matches.length === 1 ? matches[0] : null;
}

function formatTaskSummaryText(state) {
  const counts = { completed: 0, in_progress: 0, pending: 0, failed: 0 };
  for (const t of state.tasks) {
    counts[t.status] = (counts[t.status] || 0) + 1;
  }
  return `任务清单已同步（共 ${state.tasks.length} 项：完成 ${counts.completed}、进行中 ${counts.in_progress}、待处理 ${counts.pending}${counts.failed ? `、失败 ${counts.failed}` : ''}）。`;
}

function handleSetTasks(args) {
  const dataDir = resolveDataDir();
  const convId = resolveActiveConversationId(args?.conversation_id, dataDir);
  if (!convId) {
    return {
      isError: true,
      content: [{ type: 'text', text: '无法识别当前会话 ID，请先触发一次对话或显式传入 conversation_id。' }],
    };
  }

  const rawTasks = Array.isArray(args?.tasks) ? args.tasks : [];
  const now = Date.now();
  const state = loadConversationState(convId, dataDir);

  if (typeof args?.title === 'string') {
    state.taskTitle = args.title.trim();
  }
  if (typeof args?.summary === 'string') {
    state.summary = args.summary.trim();
  }

  state.tasks = normalizeAndAdvanceTasks(
    rawTasks
      .filter((item) => item && typeof item.title === 'string' && item.title.trim())
      .map((item, idx) => ({
        id: String(item.id ?? idx + 1),
        title: item.title.trim(),
        status: normalizeStatus(item.status, 'pending'),
        updatedAt: now,
      })),
    { now },
  );

  saveConversationState(state, dataDir);
  return {
    content: [{ type: 'text', text: formatTaskSummaryText(state) }],
  };
}

function handleUpdateTask(args) {
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

  if (typeof args?.summary === 'string') {
    state.summary = args.summary.trim();
  }

  const patchList = [];
  if (Array.isArray(args?.updates)) {
    for (const u of args.updates) {
      if (u && u.id !== undefined && u.status !== undefined) {
        patchList.push({ id: u.id, status: u.status });
      }
    }
  }
  if (args?.id !== undefined && args?.status !== undefined) {
    patchList.push({ id: args.id, status: args.status });
  }

  let updatedCount = 0;
  for (const patch of patchList) {
    const task = findTask(state.tasks, patch.id);
    if (task) {
      task.status = normalizeStatus(patch.status, task.status);
      task.updatedAt = now;
      updatedCount++;
    }
  }

  state.tasks = normalizeAndAdvanceTasks(state.tasks, { now });
  saveConversationState(state, dataDir);
  return {
    content: [
      {
        type: 'text',
        text: `${updatedCount > 0 ? `已更新 ${updatedCount} 项任务。` : ''}${formatTaskSummaryText(state)}`,
      },
    ],
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
          serverInfo: { name: 'task-hud-tasks', version: '1.2.0' },
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
    if (name === 'task_hud_set_tasks') {
      result = handleSetTasks(args);
    } else if (name === 'task_hud_update_task') {
      result = handleUpdateTask(args);
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
