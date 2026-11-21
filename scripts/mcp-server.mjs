import { join } from 'node:path';
import {
  createEmptyStats,
  deriveEndHudFileName,
  findNextAvailableTurnSlot,
  isHudSlotCollapsedFile,
  loadConversationState,
  normalizeAndAdvanceTasks,
  resolveActiveConversationId,
  resolveDataDir,
  saveConversationState,
  syncArtifactHudFile,
  syncEndHudFile,
  writeArtifactHudTasks,
} from './state-store.mjs';

const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed', 'failed']);
const SUPPORTED_VERSIONS = ['2025-03-26', '2024-11-05'];

const TOOLS = [
  {
    name: 'task_hud_init',
    description: '初始化任务进度面板并返回 <agent-embed> 标签。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '任务标题' },
        tasks: {
          type: 'array',
          description: '步骤列表（字符串或 {id?,title,done?,status?}）',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  done: { type: 'boolean' },
                  status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed'] },
                },
                required: ['title'],
              },
            ],
          },
        },
        log: { type: 'string', description: '首步简短说明' },
        conversation_id: { type: 'string', description: '可选会话 ID' },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'task_hud_check',
    description: '更新任务进度、追加进展说明或收起面板。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 id/序号/标题关键字' },
        done: { type: 'boolean', description: 'true=completed，false=pending' },
        failed: { type: 'boolean', description: 'true=failed' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed'] },
        checks: {
          description: '批量更新（{"1":true} 或 [{id,done}]）',
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
                  status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed'] },
                },
                required: ['id'],
              },
            },
          ],
        },
        all_done: { type: 'boolean', description: '全部完成并收起面板' },
        log: { type: 'string', description: '本步简短进展' },
        conversation_id: { type: 'string', description: '可选会话 ID' },
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
  if (tasks.length === 0) return '0/0';
  if (doneCount === tasks.length) return `${doneCount}/${tasks.length} done`;
  const failedCount = tasks.filter((t) => t.status === 'failed').length;
  return failedCount > 0 ? `${doneCount}/${tasks.length} (${failedCount} failed)` : `${doneCount}/${tasks.length}`;
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

  if (state.artifactDirectoryPath && hudFile) {
    const fileUri = `file:///${join(state.artifactDirectoryPath, hudFile).replace(/\\/g, '/')}`;
    return {
      content: [
        {
          type: 'text',
          text: `OK ${formatProgressText(state)}\n<agent-embed src="${fileUri}"></agent-embed>`,
        },
      ],
    };
  }

  return {
    content: [{ type: 'text', text: `OK ${formatProgressText(state)}` }],
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

  let endEmbedTag = '';
  if (allCompleted && state.artifactDirectoryPath) {
    const endFile = deriveEndHudFileName(hudFile, state.activeTurn?.turnIndex || 1);
    if (state.activeTurn) state.activeTurn.endHudFileName = endFile;
    const syncedEnd = syncEndHudFile(state.artifactDirectoryPath, state, {
      turnFinished: false,
      now,
      targetFileName: endFile,
    });
    if (syncedEnd) {
      const endUri = `file:///${join(state.artifactDirectoryPath, syncedEnd).replace(/\\/g, '/')}`;
      endEmbedTag = `\n<agent-embed src="${endUri}"></agent-embed>`;
    }
  }

  saveConversationState(state, dataDir);

  return {
    content: [{ type: 'text', text: `OK ${formatProgressText(state)}${endEmbedTag}` }],
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
          serverInfo: { name: 'task-hud-tasks', version: '1.4.0' },
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
