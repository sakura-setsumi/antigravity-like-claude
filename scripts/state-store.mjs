import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_NAME = 'task-hud';
export const SAFE_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;
export const TURN_HUD_FILE_RE = /^task-hud(?:-t(\d+))?\.html$/i;
export const END_HUD_FILE_RE = /^task-hud-end-t(\d+)\.html$/i;

export function normalizeHudFileName(fileOrPath) {
  if (!fileOrPath) return '';
  const base = basename(String(fileOrPath).trim()).toLowerCase();
  return TURN_HUD_FILE_RE.test(base) ? base : '';
}

export function normalizeEndHudFileName(fileOrPath) {
  if (!fileOrPath) return '';
  const base = basename(String(fileOrPath).trim()).toLowerCase();
  return END_HUD_FILE_RE.test(base) ? base : '';
}

export function deriveEndHudFileName(hudFileName, fallbackIndex = 1) {
  const m = String(hudFileName || '').match(/^task-hud-t(\d+)\.html$/i);
  const idx = m ? Number(m[1]) : Math.max(1, Number(fallbackIndex) || 1);
  return `task-hud-end-t${idx}.html`;
}

export function listTurnSlotNames(maxCount = 24) {
  const out = [];
  for (let i = 1; i <= maxCount; i++) {
    out.push(`task-hud-t${i}.html`);
  }
  return out;
}

export function resolveDataDir() {
  const explicit = process.env.TASK_HUD_DATA_DIR || process.env.PLUGIN_DATA;
  if (explicit) return explicit;

  const execData = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (execData) {
    for (let d = execData; d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') {
        const appData = dirname(d);
        const underAppData = join(appData, 'plugin_data', PLUGIN_NAME);
        const underGemini = join(dirname(appData), 'plugin_data', PLUGIN_NAME);
        if (existsSync(underAppData) || !existsSync(underGemini)) {
          return underAppData;
        }
        return underGemini;
      }
    }
  }

  const agyCandidate = join(homedir(), '.gemini', 'antigravity', 'plugin_data', PLUGIN_NAME);
  if (existsSync(agyCandidate)) return agyCandidate;
  return join(homedir(), '.gemini', 'plugin_data', PLUGIN_NAME);
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

export function readJsonSafe(filePath, fallback = null) {
  try {
    if (!existsSync(filePath)) return fallback;
    const raw = readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(filePath, data) {
  ensureDir(dirname(filePath));
  const payload = JSON.stringify(data, null, 2) + '\n';
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, payload, { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmp, filePath);
  } catch {
    writeFileSync(filePath, payload, { encoding: 'utf-8' });
  } finally {
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

export function writeTextAtomic(filePath, content) {
  ensureDir(dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, content, { encoding: 'utf-8' });
    renameSync(tmp, filePath);
  } catch {
    writeFileSync(filePath, content, { encoding: 'utf-8' });
  } finally {
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

export function settingsPath(dataDir = resolveDataDir()) {
  return join(dataDir, 'settings.json');
}

export function defaultSettings() {
  return {
    injectPreviousTurnTimerInChat: true,
    injectProgressInChat: true,
  };
}

export function loadSettings(dataDir = resolveDataDir()) {
  const saved = readJsonSafe(settingsPath(dataDir), {});
  return { ...defaultSettings(), ...(saved && typeof saved === 'object' ? saved : {}) };
}

export function saveSettings(partial, dataDir = resolveDataDir()) {
  const next = { ...loadSettings(dataDir), ...partial };
  writeJsonAtomic(settingsPath(dataDir), next);
  return next;
}

export function activeSessionPath(dataDir = resolveDataDir()) {
  return join(dataDir, 'active-session.json');
}

export function conversationStatePath(conversationId, dataDir = resolveDataDir()) {
  const safeId = sanitizeConversationId(conversationId);
  return join(dataDir, 'conversations', `${safeId}.json`);
}

export function sanitizeConversationId(id) {
  const s = String(id ?? '').trim();
  if (!SAFE_ID_RE.test(s)) return '';
  return s;
}

export function createEmptyStats() {
  return {
    commands: 0,
    fileReads: 0,
    fileEdits: 0,
    searches: 0,
    subagents: 0,
    otherTools: 0,
    failures: 0,
    totalTools: 0,
  };
}

export function createEmptyTokens() {
  return {
    input: 0,
    cacheRead: 0,
    output: 0,
    total: 0,
    plugin: 0,
    main: 0,
  };
}

export function formatTokenCompact(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (v >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(v));
}

export function formatTokenText(tokens) {
  const total = Number(tokens?.total || 0);
  if (!Number.isFinite(total) || total <= 0) return '';
  const plugin = Math.max(0, Math.min(total, Number(tokens?.plugin || 0)));
  const main = Math.max(0, total - plugin);
  if (plugin > 0) {
    return `${formatTokenCompact(total)} tok（${formatTokenCompact(main)} / ${formatTokenCompact(plugin)}）`;
  }
  return `${formatTokenCompact(total)} tok`;
}

export function formatTokenDetail(tokens) {
  if (!tokens || Number(tokens.total || 0) <= 0) return '';
  const total = Number(tokens.total || 0);
  const plugin = Math.max(0, Math.min(total, Number(tokens.plugin || 0)));
  const main = Math.max(0, total - plugin);
  const splitPart = plugin > 0 ? `本体 ${formatTokenCompact(main)} · 插件 ${formatTokenCompact(plugin)}` : '';
  const parts = [];
  if (tokens.input > 0) parts.push(`输入 ${formatTokenCompact(tokens.input)}`);
  if (tokens.cacheRead > 0) parts.push(`缓存 ${formatTokenCompact(tokens.cacheRead)}`);
  if (tokens.output > 0) parts.push(`输出 ${formatTokenCompact(tokens.output)}`);
  const usagePart = parts.join(' · ');
  return splitPart && usagePart ? `${splitPart} | ${usagePart}` : splitPart || usagePart;
}

let cachedPluginRulesTokens = null;
function getPluginRulesTokens() {
  if (cachedPluginRulesTokens !== null) return cachedPluginRulesTokens;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const agentsPath = join(here, '..', 'rules', 'AGENTS.md');
    const txt = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf-8') : '';
    // 规则正文 + 懒加载工具名声明（约 15 tok）
    cachedPluginRulesTokens = estimateTextTokens(txt) + 15;
  } catch {
    cachedPluginRulesTokens = 0;
  }
  return cachedPluginRulesTokens;
}

export function estimateTextTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  const cjk = (s.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const ascii = s.length - cjk;
  return Math.max(1, Math.round(cjk * 1.1 + ascii / 3.8));
}

export function computeTurnTokensFromTranscript(transcriptPath, userStepIndex = null) {
  const out = createEmptyTokens();
  if (!transcriptPath || !existsSync(transcriptPath)) return out;
  try {
    const raw = readFileSync(transcriptPath, 'utf-8');
    const lines = raw.trim().split('\n');
    let startIdx = -1;
    let endIdx = lines.length;

    if (userStepIndex !== null && userStepIndex !== undefined && Number.isFinite(Number(userStepIndex))) {
      const targetStep = Number(userStepIndex);
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (obj?.type === 'USER_INPUT') {
            if (Number(obj.step_index) === targetStep) {
              startIdx = i;
              break;
            }
            endIdx = i;
          }
        } catch {
          continue;
        }
      }
    } else {
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (obj?.type === 'USER_INPUT') {
            startIdx = i;
            break;
          }
        } catch {
          continue;
        }
      }
    }

    if (startIdx === -1) return out;

    const turnObjs = [];
    for (let i = startIdx + 1; i < endIdx; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        turnObjs.push(JSON.parse(line));
      } catch {
        continue;
      }
    }

    const totalPlanners = turnObjs.filter((o) => o?.type === 'PLANNER_RESPONSE').length;
    let seenPlanners = 0;
    let pendingHudToolReturns = 0;
    let pluginEst = totalPlanners * getPluginRulesTokens();

    for (const obj of turnObjs) {
      if (obj?.type === 'PLANNER_RESPONSE') {
        seenPlanners++;
        const remainingPlanners = Math.max(0, totalPlanners - seenPlanners);
        const inTok = Number(obj.input_tokens);
        const cacheTok = Number(obj.cache_read_tokens);
        const outTok = Number(obj.output_tokens);
        if (Number.isFinite(inTok) && inTok > 0) out.input += inTok;
        if (Number.isFinite(cacheTok) && cacheTok > 0) out.cacheRead += cacheTok;
        if (Number.isFinite(outTok) && outTok > 0) out.output += outTok;

        // 估算本步产出的 <agent-embed ...task-hud...> 标签 token（产出 1 次 + 后续每轮上下文复用）
        if (typeof obj.content === 'string') {
          const embeds = obj.content.match(/<agent-embed\b[^>]*task-hud[^>]*><\/agent-embed>/gi);
          if (embeds) {
            for (const tag of embeds) {
              pluginEst += estimateTextTokens(tag) * (1 + remainingPlanners);
            }
          }
        }

        // 估算本步调用 task-hud 内部工具的参数 token（产出 1 次 + 后续每轮上下文复用）
        pendingHudToolReturns = 0;
        if (Array.isArray(obj.tool_calls)) {
          for (const tc of obj.tool_calls) {
            const normArgs = normalizeToolArgs(tc?.args);
            if (isHudInternalTool(tc?.name, normArgs)) {
              const callText = `${tc?.name || ''}${JSON.stringify(tc?.args || {})}`;
              pluginEst += estimateTextTokens(callText) * (1 + remainingPlanners);
              pendingHudToolReturns++;
            }
          }
        }
      } else if (obj?.type === 'SYSTEM_MESSAGE') {
        const content = String(obj.content || '');
        if (/task-hud/i.test(content)) {
          const remainingPlanners = Math.max(0, totalPlanners - seenPlanners);
          if (remainingPlanners > 0) {
            pluginEst += estimateTextTokens(content) * remainingPlanners;
          }
        }
      } else if (obj?.type === 'GENERIC' && pendingHudToolReturns > 0) {
        const content = String(obj.content || '');
        if (/task-hud|任务组件已就绪|已更新\s*\d+\s*项任务|任务清单已同步|^OK\s+\d+\/\d+/i.test(content)) {
          const remainingPlanners = Math.max(0, totalPlanners - seenPlanners);
          if (remainingPlanners > 0) {
            pluginEst += estimateTextTokens(content) * remainingPlanners;
          }
          pendingHudToolReturns--;
        }
      }
    }

    out.total = out.input + out.cacheRead + out.output;
    out.plugin = out.total > 0 ? Math.min(out.total, Math.round(pluginEst)) : 0;
    out.main = Math.max(0, out.total - out.plugin);
    return out;
  } catch {
    return out;
  }
}

export function createEmptyConversationState(conversationId) {
  return {
    version: 1,
    conversationId,
    transcriptPath: '',
    artifactDirectoryPath: '',
    updatedAt: Date.now(),
    summary: '',
    taskTitle: '',
    logs: [],
    tasks: [],
    activeTurn: null,
    lastCompletedTurn: null,
    turns: [],
  };
}

export function isTurnInterrupted(turn) {
  return Boolean(turn && (turn.interrupted || (turn.terminationReason && turn.terminationReason !== 'NO_TOOL_CALL')));
}

export function finalizeActiveTurn(state, { terminationReason = 'NO_TOOL_CALL', now = Date.now() } = {}) {
  if (!state.activeTurn) return null;
  const t = state.activeTurn;
  const startedAtNum = Number(t.startedAt) || now;
  const endedAt = Math.max(now, startedAtNum);
  const completed = {
    turnIndex: t.turnIndex,
    userStepIndex: t.userStepIndex ?? null,
    userInput: t.userInput || '',
    userFingerprint: t.userFingerprint || '',
    payloadFingerprint: t.payloadFingerprint || '',
    hudFileName: t.hudFileName || '',
    endHudFileName: t.endHudFileName || '',
    hasUserEmbed: Boolean(t.hasUserEmbed),
    autoEmbedInjected: Boolean(t.autoEmbedInjected),
    autoSeededSlot: t.autoSeededSlot || '',
    hudCollapsed: Boolean(t.hudCollapsed || t.supersededCollapsed),
    interrupted: terminationReason !== 'NO_TOOL_CALL',
    startedAt: startedAtNum,
    endedAt,
    elapsedMs: Math.max(0, endedAt - startedAtNum),
    terminationReason,
    stats: t.stats || createEmptyStats(),
    tokens: t.tokens || createEmptyTokens(),
    announcedInChat: false,
  };

  const lastIdx = state.turns.length - 1;
  if (
    lastIdx >= 0 &&
    completed.userStepIndex !== null &&
    state.turns[lastIdx].userStepIndex === completed.userStepIndex
  ) {
    const prev = state.turns[lastIdx];
    const startedAt = Math.min(prev.startedAt || completed.startedAt, completed.startedAt);
    completed.turnIndex = prev.turnIndex;
    completed.hudFileName = completed.hudFileName || prev.hudFileName || '';
    completed.endHudFileName = completed.endHudFileName || prev.endHudFileName || '';
    completed.hudCollapsed = Boolean(completed.hudCollapsed || prev.hudCollapsed);
    completed.interrupted = Boolean(completed.interrupted);
    completed.userFingerprint = completed.userFingerprint || prev.userFingerprint || '';
    completed.payloadFingerprint = completed.payloadFingerprint || prev.payloadFingerprint || '';
    if ((prev.tokens?.total || 0) > (completed.tokens?.total || 0)) {
      completed.tokens = prev.tokens;
    }
    completed.startedAt = startedAt;
    completed.elapsedMs = Math.max(0, endedAt - startedAt);
    state.turns[lastIdx] = completed;
  } else {
    state.turns.push(completed);
    if (state.turns.length > 50) {
      state.turns = state.turns.slice(-50);
    }
  }

  state.lastCompletedTurn = completed;
  state.activeTurn = null;
  return completed;
}

export function normalizeAndAdvanceTasks(tasks, { turnFinished = false, now = Date.now() } = {}) {
  if (!Array.isArray(tasks) || tasks.length === 0) return [];
  const cloned = tasks
    .map((t, idx) => {
      const rawTitle =
        typeof t === 'string'
          ? t
          : t?.title || t?.content || t?.text || t?.name || t?.label || t?.step || t?.description || '';
      return {
        id: String(t?.id ?? idx + 1),
        title: String(rawTitle).trim(),
        status: ['pending', 'in_progress', 'completed', 'failed'].includes(t?.status) ? t.status : 'pending',
        updatedAt: t?.updatedAt || now,
      };
    })
    .filter((t) => t.title);

  let latestActiveOrDoneIdx = -1;
  let latestActiveIdx = -1;
  for (let i = 0; i < cloned.length; i++) {
    if (cloned[i].status === 'in_progress' || cloned[i].status === 'completed') {
      latestActiveOrDoneIdx = i;
    }
    if (cloned[i].status === 'in_progress') {
      latestActiveIdx = i;
    }
  }

  for (let i = 0; i < cloned.length; i++) {
    if (cloned[i].status === 'in_progress') {
      if (i < latestActiveIdx || i < latestActiveOrDoneIdx) {
        cloned[i].status = 'completed';
        cloned[i].updatedAt = now;
      }
    }
  }

  const lastIdx = cloned.length - 1;
  const hasFailed = cloned.some((t) => t.status === 'failed');
  const hasPending = cloned.some((t) => t.status === 'pending');

  if (!hasFailed && ((lastIdx >= 0 && cloned[lastIdx].status === 'completed') || (turnFinished && !hasPending))) {
    for (const item of cloned) {
      if (item.status === 'in_progress') {
        item.status = 'completed';
        item.updatedAt = now;
      }
    }
  }

  return cloned;
}

function unwrapArgString(v) {
  if (typeof v !== 'string') return v;
  const trimmed = v.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return v;
    }
  }
  return v;
}

export function normalizeToolArgs(rawArgs) {
  if (!rawArgs || typeof rawArgs !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(rawArgs)) {
    out[k] = unwrapArgString(v);
  }
  return out;
}

function formatToolChainItem(toolName, rawArgs) {
  const args = normalizeToolArgs(rawArgs);
  if (isHudInternalTool(toolName, args)) return null;

  const name = String(toolName || '').toLowerCase();
  const filePath = String(args.Path || args.path || args.TargetFile || '');
  const fileName = filePath ? basename(filePath) : '';

  if (name === 'run_command') {
    const summary = String(args.toolSummary || args.CommandLine || '').replace(/\s+/g, ' ').trim();
    const rawCmd = String(args.CommandLine || '').trim();
    const cmd = rawCmd.length > 240 ? `${rawCmd.slice(0, 240)}…` : rawCmd;
    return {
      kind: 'command',
      text: summary ? `Ran ${summary}` : 'Ran command',
      detail: cmd,
    };
  }
  if (name === 'read_file' || name === 'view_file') {
    const sLine = args.StartLine ?? args.startLine;
    const eLine = args.EndLine ?? args.endLine;
    let range = '';
    if (sLine && eLine) range = ` #L${sLine}-${eLine}`;
    else if (sLine) range = ` #L${sLine}`;
    return {
      kind: 'read',
      text: fileName ? `Analyzed ${fileName}${range}` : 'Explored file',
      detail: filePath,
    };
  }
  if (name === 'edit_file' || name === 'write_file' || name === 'replace_file_content') {
    return {
      kind: 'edit',
      text: fileName ? `Edited ${fileName}` : 'Edited file',
      detail: filePath,
    };
  }
  if (name === 'grep_search' || name === 'find_by_name' || name === 'list_dir' || name === 'search_web') {
    const q = String(args.Query || args.query || args.Pattern || '').replace(/\s+/g, ' ').trim().slice(0, 36);
    return {
      kind: 'search',
      text: q ? `Searched ${q}` : 'Explored files',
      detail: q,
    };
  }
  if (name === 'exit_plan_mode') {
    return {
      kind: 'other',
      text: '完成规划并移交执行',
      detail: '',
    };
  }
  return {
    kind: 'other',
    text: `Ran ${toolName}`,
    detail: '',
  };
}

function extractStepLogFromHudEdit(toolCalls) {
  if (!Array.isArray(toolCalls)) return '';
  for (const tc of toolCalls) {
    const args = normalizeToolArgs(tc?.args);
    if (!isHudInternalTool(tc?.name, args)) continue;

    // 优先支持 MCP JSON 组件接口（task_hud_init / task_hud_check / call_mcp_tool）
    const toolNameLower = String(tc?.name || '').toLowerCase();
    let mcpArgs = args;
    if (toolNameLower === 'call_mcp_tool') {
      const inner = args.Arguments ?? args.arguments;
      if (typeof inner === 'string') {
        try {
          mcpArgs = normalizeToolArgs(JSON.parse(inner));
        } catch {
          mcpArgs = {};
        }
      } else if (inner && typeof inner === 'object') {
        mcpArgs = normalizeToolArgs(inner);
      }
    }
    const directLog = String(mcpArgs?.log || mcpArgs?.summary || '').trim();
    if (directLog) return directLog;

    // 兼容传统 edit_file / write_file 编辑 HTML 模板的方式
    const content = String(args.Replacement || args.Content || '');
    if (!content) continue;
    const m = content.match(/<script[^>]*id=["']task-hud-(?:tasks|data)["'][^>]*>([\s\S]*?)<\/script>/i);
    const jsonText = m ? m[1] : content;
    const { data: parsed } = parseHudTasksJsonText(jsonText);
    if (parsed) {
      if (Array.isArray(parsed.logs) && parsed.logs.length > 0) {
        return String(parsed.logs[parsed.logs.length - 1] || '').trim();
      }
      if (parsed.summary) return String(parsed.summary).trim();
    }
  }
  return '';
}

/**
 * 从当前会话 transcript.jsonl 中提取本轮对话已完成步骤的：
 * 思考耗时（Thought for Xs）+ 小总结文本 + 已执行完的工具链（Ran / Analyzed / Edited）
 */
export function buildTurnStepsFromTranscript(transcriptPath, { includeLatestTools = false } = {}) {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];
  try {
    const raw = readFileSync(transcriptPath, 'utf-8');
    const lines = raw.trim().split('\n');
    let userIdx = -1;
    let lastTs = Date.now();

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj?.type === 'USER_INPUT') {
          userIdx = i;
          const ms = Date.parse(obj.created_at || '');
          if (Number.isFinite(ms)) lastTs = ms;
          break;
        }
      } catch {
        continue;
      }
    }

    if (userIdx === -1) return [];

    const plannerSteps = [];
    for (let i = userIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const createdMs = Date.parse(obj?.created_at || '');
      const ts = Number.isFinite(createdMs) ? createdMs : lastTs;

      if (obj?.type === 'PLANNER_RESPONSE') {
        const thoughtSec = obj.thinking ? Math.max(1, Math.round((ts - lastTs) / 1000)) : 0;
        const cleanContent = String(obj.content || '')
          .replace(/<agent-embed[^>]*><\/agent-embed>/gi, '')
          .trim();
        const hudLog = extractStepLogFromHudEdit(obj.tool_calls);
        const hasToolCalls = Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0;
        let logText = hudLog || (hasToolCalls ? cleanContent : '');

        // Deduplicate identical consecutive log lines
        const prevLog = plannerSteps.length > 0 ? plannerSteps[plannerSteps.length - 1].log : '';
        if (logText && prevLog && logText === prevLog) {
          logText = '';
        }

        const tools = [];
        if (Array.isArray(obj.tool_calls)) {
          for (const tc of obj.tool_calls) {
            const item = formatToolChainItem(tc?.name, tc?.args);
            if (item) tools.push(item);
          }
        }

        plannerSteps.push({
          thoughtSec: thoughtSec > 0 && thoughtSec < 300 ? thoughtSec : obj.thinking ? 2 : 0,
          log: logText,
          tools,
        });
        lastTs = ts;
      } else if (obj?.type === 'GENERIC') {
        if (Number.isFinite(createdMs)) lastTs = createdMs;
      }
    }

    // 默认最后一步的业务工具正在下方宿主区显示 Running，仅在其完成后（进入下一步或本轮结束）才收入上方工具链
    if (!includeLatestTools && plannerSteps.length > 0) {
      plannerSteps[plannerSteps.length - 1].tools = [];
    }

    return plannerSteps;
  } catch {
    return [];
  }
}

function transformJsonOutsideStrings(text, transformFn) {
  const parts = [];
  const strRe = /"(?:\\[\s\S]|[^"\\])*"/g;
  let lastIdx = 0;
  for (const m of text.matchAll(strRe)) {
    parts.push(transformFn(text.slice(lastIdx, m.index)));
    parts.push(m[0]);
    lastIdx = m.index + m[0].length;
  }
  parts.push(transformFn(text.slice(lastIdx)));
  return parts.join('');
}

function cleanHudJsonStructureGaps(seg) {
  return seg
    .replace(/\]\s*\[\s*\]/g, ']')
    .replace(/\}\s*\{\s*\}/g, '}')
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/\}\s*\{/g, '}, {')
    .replace(/\]\s*\[/g, '], [');
}

/**
 * 容错解析 `#task-hud-tasks` JSON：当模型误编辑留下残余 `[]` 或尾逗号时自动在字符串外修复。
 */
export function parseHudTasksJsonText(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return { data: null, repaired: false };

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { data: parsed, repaired: false };
    }
    return { data: null, repaired: false };
  } catch {
    // fallback to structural repair outside string literals
  }

  try {
    const fixed = transformJsonOutsideStrings(text, cleanHudJsonStructureGaps);
    const parsed = JSON.parse(fixed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { data: parsed, repaired: true };
    }
  } catch {
    // ignore unrecoverable JSON syntax error
  }
  return { data: null, repaired: false };
}

export function parseArtifactHudHtml(artifactDir, now = Date.now(), preferredFileName = '') {
  if (!artifactDir) return null;
  const normalizedPref = normalizeHudFileName(preferredFileName);
  if (!normalizedPref) return null;

  const htmlPath = join(artifactDir, normalizedPref);
  if (!existsSync(htmlPath)) return null;

  try {
    const html = readFileSync(htmlPath, 'utf-8');
    const obj = parseHudTasksJson(html);
    if (!obj || !Array.isArray(obj.tasks) || obj.tasks.length === 0) return null;
    const runtimeObj = parseHudRuntimeJson(html);
    const runtimeStatus = typeof runtimeObj?.status === 'string' ? runtimeObj.status : '';
    const status =
      runtimeStatus === 'collapsed' || runtimeStatus === 'interrupted' || runtimeStatus === 'done'
        ? runtimeStatus
        : obj.status || runtimeStatus || 'running';
    const logs = Array.isArray(obj.logs)
      ? obj.logs.map((s) => String(s || '').trim()).filter(Boolean)
      : obj.summary
      ? [String(obj.summary).trim()]
      : [];
    const latestSummary = logs.length > 0 ? logs[logs.length - 1] : String(obj.summary || '').trim();
    return {
      fileName: normalizedPref,
      taskTitle: String(obj.taskTitle || '').trim(),
      summary: latestSummary,
      logs,
      status,
      tasks: normalizeAndAdvanceTasks(obj.tasks, { turnFinished: status === 'done', now }),
    };
  } catch {
    return null;
  }
}

const HUD_HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    :root {
      /* task-hud-font-v1 */
      --hud-font-sans: var(--font-sans, var(--vscode-font-family, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, Roboto, "PingFang SC", "PingFang TC", sans-serif));
      --hud-text-primary: #0b0b0b;
      --hud-text-secondary: #52514e;
      --hud-text-muted: #64748b;
      --hud-ring: rgba(11, 11, 11, 0.1);
      --hud-border: rgba(11, 11, 11, 0.12);
      --hud-code-bg: rgba(11, 11, 11, 0.06);
    }
    :root[data-hud-theme="dark"] {
      --hud-text-primary: #f0efec;
      --hud-text-secondary: #c3c2b7;
      --hud-text-muted: #94a3b8;
      --hud-ring: rgba(255, 255, 255, 0.1);
      --hud-border: rgba(255, 255, 255, 0.12);
      --hud-code-bg: rgba(255, 255, 255, 0.085);
    }
    @media (prefers-color-scheme: dark) {
      :root:not([data-hud-theme]) {
        --hud-text-primary: #f0efec;
        --hud-text-secondary: #c3c2b7;
        --hud-text-muted: #94a3b8;
        --hud-ring: rgba(255, 255, 255, 0.1);
        --hud-border: rgba(255, 255, 255, 0.12);
        --hud-code-bg: rgba(255, 255, 255, 0.085);
      }
    }
    html, body {
      margin: 0;
      padding: 0;
      background: transparent;
      color: var(--hud-text-primary);
      font-family: var(--hud-font-sans);
      font-size: 14px;
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
      overflow-x: hidden;
      scrollbar-width: none !important;
      -ms-overflow-style: none !important;
    }
    html::-webkit-scrollbar, body::-webkit-scrollbar, *::-webkit-scrollbar {
      display: none !important;
      width: 0 !important;
      height: 0 !important;
    }
    .hud-wrap { padding: 2px 46px 4px 0; }
    .hud-logs {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-bottom: 12px;
    }
    .hud-step-block {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .hud-thought-row, .hud-tool-row {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 14px;
      line-height: 1.55;
      color: var(--hud-text-muted);
      user-select: none;
    }
    .hud-fold {
      margin: 0;
      padding: 0;
    }
    .hud-fold > summary {
      list-style: none;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 14px;
      line-height: 1.55;
      color: var(--hud-text-muted);
      cursor: pointer;
      user-select: none;
    }
    .hud-fold > summary::-webkit-details-marker { display: none; }
    .hud-fold > summary:hover { color: var(--hud-text-primary); }
    .hud-fold-chevron {
      font-size: 14px;
      opacity: 0.72;
      transition: transform 0.15s ease;
      display: inline-block;
    }
    .hud-fold[open] > summary .hud-fold-chevron {
      transform: rotate(90deg);
    }
    .hud-fold-body {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 4px 0 2px 12px;
      margin-top: 2px;
      border-left: 1.5px solid var(--hud-border);
    }
    .hud-tool-badge {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      opacity: 0.78;
    }
    .hud-chevron {
      font-size: 14px;
      opacity: 0.72;
    }
    .hud-log-item {
      color: var(--hud-text-primary);
      font-size: 14px;
      line-height: 1.65;
      word-break: break-word;
    }
    .hud-code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12.5px;
      padding: 1.5px 5px;
      border-radius: 5px;
      background: var(--hud-code-bg);
      color: var(--hud-text-primary);
    }
    .hud-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      font-size: 12px;
      line-height: 1.5;
      margin-bottom: 6px;
      padding: 0 2px;
    }
    .hud-timer-box {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .hud-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      flex-shrink: 0;
    }
    @keyframes pulse-dot {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.45; transform: scale(0.88); }
    }
    .dot-running {
      background: #7c3aed;
      box-shadow: 0 0 0 3px rgba(124, 58, 237, 0.18);
      animation: pulse-dot 1.6s ease-in-out infinite;
    }
    .dot-done {
      background: #10b981;
      box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.16);
    }
    .dot-superseded {
      background: #94a3b8;
      box-shadow: 0 0 0 3px rgba(148, 163, 184, 0.18);
    }
    .hud-muted { color: var(--hud-text-muted); }
    .hud-timer-val {
      font-weight: 600;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-variant-numeric: tabular-nums;
      font-size: 13px;
      color: var(--hud-text-primary);
    }
    .hud-top-right {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      max-width: 100%;
    }
    .hud-stats {
      color: var(--hud-text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }
    .hud-theme-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      padding: 0;
      border: none;
      border-radius: 5px;
      background: transparent;
      color: var(--hud-text-muted);
      cursor: pointer;
      opacity: 0.55;
      flex-shrink: 0;
      transition: opacity 0.15s ease, color 0.15s ease, background-color 0.15s ease;
    }
    .hud-theme-btn:hover {
      opacity: 1;
      color: var(--hud-text-primary);
      background: var(--hud-code-bg);
    }
    /* 任务卡片：对齐 Claude Code 任务列表（卡片 ring、14/20 排版、16px 图标盒、12px spinner） */
    .hud-card {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 16px;
      border-radius: 12px;
      background: transparent;
      box-shadow: inset 0 0 0 1px var(--hud-ring);
      overflow: clip;
      overflow-wrap: break-word;
      color: var(--hud-text-primary);
      font-family: var(--hud-font-sans);
      font-size: 14px;
      line-height: 20px;
    }
    .hud-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
      -webkit-user-select: text;
      user-select: text;
    }
    .hud-item {
      display: flex;
      align-items: flex-start;
      gap: 4px;
      color: var(--hud-text-primary);
    }
    .hud-item.is-done { color: var(--hud-text-secondary); }
    .hud-item-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      width: 16px;
      height: 20px;
      color: var(--hud-text-primary);
    }
    .hud-item.is-done .hud-item-icon,
    .hud-item.is-pending .hud-item-icon { color: var(--hud-text-secondary); }
    .hud-item-icon > svg { flex: none; width: 16px; height: 16px; }
    .hud-item-icon > .hud-icon-paused { display: none; }
    .hud-card.is-paused .hud-spinner { display: none; }
    .hud-card.is-paused .hud-item-icon > .hud-icon-paused { display: block; }
    .hud-item-text {
      min-width: 0;
      flex: 1 1 0%;
      text-align: start;
      overflow-wrap: break-word;
    }
    .hud-item-code {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-size: 0.9em;
      line-height: 1;
      padding: 1px 4px;
      border-radius: 4px;
      background: var(--hud-code-bg);
      color: color-mix(in oklab, currentColor, var(--hud-text-primary));
    }
    .hud-spinner {
      position: relative;
      display: inline-block;
      flex-shrink: 0;
      vertical-align: middle;
      width: 12px;
      height: 12px;
    }
    .hud-spinner > span {
      position: absolute;
      inset: 0;
      border-radius: 9999px;
    }
    .hud-spinner-track { border: 1.5px solid var(--hud-border); }
    .hud-spinner-arc {
      /* task-hud-spinner-v3 */
      background: conic-gradient(transparent 25%, var(--hud-text-secondary));
      -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 1.5px), #000 calc(100% - 1.5px + 0.5px));
      mask: radial-gradient(farthest-side, transparent calc(100% - 1.5px), #000 calc(100% - 1.5px + 0.5px));
      animation: hud-spin 1.1s linear infinite;
      will-change: transform;
    }
    @keyframes hud-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    .hud-list-note {
      margin: 0;
      padding-inline-start: 24px;
      font-size: 12px;
      line-height: 17px;
      color: var(--hud-text-secondary);
    }
    /* 完成/中断折叠条：沿用任务卡片（ring、12px 圆角、16px 内边距、14/20、16px 图标盒、CaretRight 展开箭头） */
    .hud-done-fold {
      margin: 0;
      padding: 0;
    }
    .hud-done-summary {
      list-style: none;
      display: flex;
      align-items: flex-start;
      gap: 4px;
      padding: 16px;
      border-radius: 12px;
      background: transparent;
      box-shadow: inset 0 0 0 1px var(--hud-ring);
      overflow-wrap: break-word;
      color: var(--hud-text-secondary);
      font-family: var(--hud-font-sans);
      font-size: 14px;
      line-height: 20px;
      cursor: pointer;
      -webkit-user-select: none;
      user-select: none;
    }
    .hud-done-summary::-webkit-details-marker { display: none; }
    .hud-done-summary:hover { color: var(--hud-text-primary); }
    .hud-done-icon,
    .hud-done-chevron {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      width: 16px;
      height: 20px;
    }
    .hud-done-icon > svg,
    .hud-done-chevron > svg { flex: none; width: 16px; height: 16px; }
    .hud-done-text { min-width: 0; flex: 1 1 auto; }
    /* 窄宽度时统计信息优先收缩，保证主文案完整 */
    .hud-done-stats {
      flex: 0 1000 auto;
      min-width: 0;
      max-width: 45%;
      margin-inline-start: 8px;
      font-size: 12px;
      line-height: 20px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .hud-done-stats:empty { display: none; }
    .hud-done-chevron > svg { transition: transform 0.2s cubic-bezier(0, 0, 0.2, 1); }
    .hud-done-fold[open] > .hud-done-summary .hud-done-chevron > svg { transform: rotate(90deg); }
    @media (prefers-reduced-motion: reduce) {
      .hud-done-chevron > svg { transition: none; }
    }
    .hud-done-body {
      padding-top: 10px;
    }
    .hidden { display: none !important; }
    html.is-collapsed,
    html.is-collapsed body {
      margin: 0 !important;
      padding: 0 !important;
      height: 0 !important;
      min-height: 0 !important;
      max-height: 0 !important;
      line-height: 0 !important;
      font-size: 0 !important;
      border: 0 !important;
      overflow: hidden !important;
    }
  </style>
</head>
<body>
  <script id="task-hud-tasks" type="application/json">
{
  "taskTitle": "任务进度",
  "logs": [],
  "tasks": []
}
  </script>
  <script id="task-hud-runtime" type="application/json">
{
  "status": "running",
  "turnIndex": 1,
  "startedAt": 0,
  "elapsedMs": 0,
  "tokenText": "",
  "tokenDetail": "",
  "statsText": "",
  "steps": []
}
  </script>

  <div id="hud-root" class="hud-wrap hidden">
    <details id="hud-done-fold" class="hud-done-fold hidden">
      <summary class="hud-done-summary">
        <span id="hud-done-dot" class="hud-done-icon is-done"></span>
        <span id="hud-done-text" class="hud-done-text"></span>
        <span id="hud-done-stats" class="hud-done-stats"></span>
        <span class="hud-done-chevron" aria-hidden="true"><svg viewBox="0 0 16 16" width="16" height="16"><path d="M6 4L10 8L6 12" fill="none" stroke="currentColor" stroke-width="1.17" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      </summary>
      <div id="hud-done-body" class="hud-done-body"></div>
    </details>

    <div id="hud-live-body">
      <div id="hud-logs" class="hud-logs hidden"></div>

      <div id="hud-panel" class="hidden">
        <div class="hud-top">
          <div class="hud-timer-box">
            <span id="hud-dot" class="hud-dot dot-running"></span>
            <span id="hud-timer-label" class="hud-muted">本轮对话已用时</span>
            <span id="hud-timer-val" class="hud-timer-val">0s</span>
            <span id="hud-token-sep" class="hud-muted hidden">·</span>
            <span id="hud-token-val" class="hud-timer-val hidden"></span>
          </div>
          <div class="hud-top-right">
            <div id="hud-stats" class="hud-stats"></div>
            <button id="hud-theme-btn" class="hud-theme-btn" type="button" aria-label="切换主题" title="切换面板明暗主题"></button>
          </div>
        </div>

        <div id="hud-card" class="hud-card">
          <p id="hud-list-before" class="hud-list-note hidden"></p>
          <ul id="hud-list" class="hud-list"></ul>
          <p id="hud-list-after" class="hud-list-note hidden"></p>
        </div>
      </div>
    </div>
  </div>

  <script>
    (() => {
      /* task-hud-stop-fold-v1 */
      /* task-hud-token-v1 */
      const $ = (id) => document.getElementById(id);
      let currentData = null;

      function formatDuration(ms) {
        const totalSec = Math.max(0, Math.floor(Number(ms || 0) / 1000));
        if (totalSec < 60) return \`\${totalSec}s\`;
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        return h > 0 ? \`\${h}h \${m}m \${s}s\` : \`\${m}m \${s}s\`;
      }

      const THEME_STORAGE_KEY = 'task-hud-theme-override';
      const ICON_SUN = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="8" cy="8" r="3"/><path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M12.4 3.6l-1 1M4.6 11.4l-1 1"/></svg>';
      const ICON_MOON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M13.2 9.6A5.4 5.4 0 0 1 6.4 2.8a5.4 5.4 0 1 0 6.8 6.8Z"/></svg>';

      function readThemeOverride() {
        try {
          const v = localStorage.getItem(THEME_STORAGE_KEY);
          return v === 'light' || v === 'dark' ? v : '';
        } catch {
          return '';
        }
      }

      function writeThemeOverride(mode) {
        try {
          if (mode === 'light' || mode === 'dark') localStorage.setItem(THEME_STORAGE_KEY, mode);
          else localStorage.removeItem(THEME_STORAGE_KEY);
        } catch {}
      }

      function lumOfColorStr(c) {
        if (!c) return null;
        const body = c.slice(c.indexOf('(') + 1).replace(/^\\s*[a-z][\\w-]*\\s+/i, '');
        const nums = (body.match(/[\\d.]+/g) || []).map(Number);
        if (nums.length < 3 || (nums.length >= 4 && nums[3] === 0)) return null;
        const scale = c.startsWith('color(') ? 1 : 255;
        const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      }

      function detectExplicitTheme(el) {
        if (!el) return null;
        for (const attr of ['data-theme', 'data-color-mode', 'data-theme-mode', 'data-vscode-theme-kind']) {
          const v = (el.getAttribute && el.getAttribute(attr) || '').toLowerCase();
          if (/^(light|light-theme|vs|vscode-light|hc-light)$/.test(v)) return 'light';
          if (/^(dark|dark-theme|vs-dark|vscode-dark|hc-black|hc-dark)$/.test(v)) return 'dark';
        }
        if (el.classList) {
          const isLight = ['light', 'light-theme', 'theme-light', 'vscode-light', 'vs'].some((k) => el.classList.contains(k));
          const isDark = ['dark', 'dark-theme', 'theme-dark', 'vscode-dark', 'vs-dark', 'hc-black'].some((k) => el.classList.contains(k));
          if (isLight !== isDark) return isLight ? 'light' : 'dark';
        }
        return null;
      }

      function detectParentTheme() {
        try {
          if (!window.parent || window.parent === window) return null;
          const pDoc = window.parent.document;
          if (!pDoc) return null;
          const explicit = detectExplicitTheme(pDoc.body) || detectExplicitTheme(pDoc.documentElement);
          if (explicit) return explicit;
          for (const el of [pDoc.body, pDoc.documentElement]) {
            if (!el) continue;
            const lum = lumOfColorStr(window.parent.getComputedStyle(el).backgroundColor || '');
            if (lum !== null) return lum < 0.5 ? 'dark' : 'light';
          }
        } catch {}
        return null;
      }

      function updateThemeBtn(dark, override) {
        const btn = $('hud-theme-btn');
        if (!btn) return;
        btn.innerHTML = dark ? ICON_MOON : ICON_SUN;
        const modeLabel = override === 'light' ? '固定浅色' : override === 'dark' ? '固定深色' : '自动跟随';
        btn.title = '面板主题：' + modeLabel + '（点击切换）';
      }

      function syncParentFont() {
        try {
          if (!window.parent || window.parent === window) return;
          const pDoc = window.parent.document;
          if (!pDoc) return;
          for (const el of [pDoc.body, pDoc.documentElement]) {
            if (!el) continue;
            const ff = (window.parent.getComputedStyle(el).fontFamily || '').trim();
            if (ff && !/^serif$/i.test(ff)) {
              document.documentElement.style.setProperty('--hud-font-sans', ff);
              return;
            }
          }
        } catch {}
      }

      // 按用户覆盖 > 同源父级真实背景 > 显式属性/colorScheme > 宿主 CSS 变量 > 系统偏好切换面板深浅色令牌
      function syncHudTheme() {
        syncParentFont();
        try {
          const override = readThemeOverride();
          let dark = null;
          if (override === 'light' || override === 'dark') {
            dark = override === 'dark';
          } else {
            const parentTheme = detectParentTheme();
            if (parentTheme) {
              dark = parentTheme === 'dark';
            } else {
              const explicit = detectExplicitTheme(document.body) || detectExplicitTheme(document.documentElement);
              if (explicit) {
                dark = explicit === 'dark';
              } else {
                const probe = document.createElement('span');
                probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
                document.documentElement.appendChild(probe);
                const lumOfVar = (varName) => {
                  probe.style.color = 'transparent';
                  probe.style.color = 'var(' + varName + ', transparent)';
                  let lum = lumOfColorStr(getComputedStyle(probe).color || '');
                  if (lum === null) {
                    probe.style.color = 'transparent';
                    probe.style.color = 'hsl(var(' + varName + '))';
                    lum = lumOfColorStr(getComputedStyle(probe).color || '');
                  }
                  return lum;
                };
                const bgLum = lumOfVar('--background') ?? lumOfVar('--color-background') ?? lumOfVar('--vscode-editor-background');
                const fgLum = bgLum === null ? (lumOfVar('--foreground') ?? lumOfVar('--color-foreground')) : null;
                probe.remove();
                if (bgLum !== null) {
                  dark = bgLum < 0.5;
                } else if (fgLum !== null) {
                  dark = fgLum > 0.5;
                } else {
                  const scheme = (getComputedStyle(document.documentElement).colorScheme || '').trim();
                  if (scheme === 'light' || scheme === 'dark') dark = scheme === 'dark';
                  else dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                }
              }
            }
          }
          document.documentElement.dataset.hudTheme = dark ? 'dark' : 'light';
          updateThemeBtn(dark, override);
        } catch {}
      }

      syncHudTheme();
      try {
        const themeBtn = $('hud-theme-btn');
        if (themeBtn) {
          themeBtn.addEventListener('click', () => {
            const curDark = document.documentElement.dataset.hudTheme === 'dark';
            const override = readThemeOverride();
            let next = '';
            if (!override) next = curDark ? 'light' : 'dark';
            else if (override === 'light') next = 'dark';
            else next = '';
            writeThemeOverride(next);
            syncHudTheme();
          });
        }
        const themeAttrs = ['style', 'class', 'data-theme', 'data-color-mode', 'data-theme-mode', 'data-vscode-theme-kind'];
        const obs = new MutationObserver(syncHudTheme);
        obs.observe(document.documentElement, { attributes: true, attributeFilter: themeAttrs });
        if (document.body) obs.observe(document.body, { attributes: true, attributeFilter: themeAttrs });
        if (document.head) obs.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'media', 'disabled'] });
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncHudTheme);
        window.addEventListener('focus', syncHudTheme);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) syncHudTheme(); });
        window.addEventListener('storage', (e) => { if (!e.key || e.key === THEME_STORAGE_KEY) syncHudTheme(); });
      } catch {}

      // 16×16 图标，几何与 Claude 任务列表的 CheckCircleFilled / Placeholder / DotsCircle 一致
      const HUD_ICON_CHECK = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M1.333 8A6.667 6.667 0 1 0 14.667 8A6.667 6.667 0 1 0 1.333 8ZM4.849 8.505L6.949 10.795A0.585 0.585 0 0 0 7.86 10.734L11.2 5.934A0.585 0.585 0 0 0 10.24 5.266L7.317 9.466L5.711 7.715A0.585 0.585 0 0 0 4.849 8.505Z"/></svg>';
      const HUD_ICON_PENDING = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6.165" fill="none" stroke="currentColor" stroke-width="1.19" stroke-linecap="round" stroke-dasharray="1.868 2.974" stroke-dashoffset="3.355" transform="rotate(22.5 8 8)"/></svg>';
      const HUD_ICON_PAUSED = '<svg class="hud-icon-paused" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6.165" fill="none" stroke="currentColor" stroke-width="1.17"/><circle cx="5.49" cy="8" r="0.83" fill="currentColor"/><circle cx="8" cy="8" r="0.83" fill="currentColor"/><circle cx="10.51" cy="8" r="0.83" fill="currentColor"/></svg>';
      const HUD_ICON_SPINNER = '<span class="hud-spinner" aria-hidden="true"><span class="hud-spinner-track"></span><span class="hud-spinner-arc"></span></span>';
      const HUD_ICON_FAILED = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6.667" fill="#ef4444"/><path d="M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2" fill="none" stroke="#fff" stroke-width="1.17" stroke-linecap="round"/></svg>';

      // in_progress 同时放 spinner 与 DotsCircle：运行中显示 spinner，卡片冻结（.is-paused）后改显示 DotsCircle
      function iconSvg(status) {
        if (status === 'completed') return HUD_ICON_CHECK;
        if (status === 'in_progress') return HUD_ICON_SPINNER + HUD_ICON_PAUSED;
        if (status === 'failed') return HUD_ICON_FAILED;
        return HUD_ICON_PENDING;
      }

      function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      }

      function formatLogHtml(raw) {
        let s = esc(raw);
        s = s.replace(/\`([^\`]+)\`/g, '<code class="hud-code">$1</code>');
        s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
        s = s.replace(/\\n/g, '<br/>');
        return s;
      }

      function formatTaskTitleHtml(raw) {
        let s = esc(raw);
        s = s.replace(/\`([^\`]+)\`/g, '<code class="hud-item-code">$1</code>');
        s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
        return s;
      }

      function renderTaskItem(t) {
        const stateCls =
          t.status === 'completed' ? 'is-done' : t.status === 'in_progress' ? 'is-active' : t.status === 'failed' ? 'is-failed' : 'is-pending';
        return '<li class="hud-item ' + stateCls + '"><span class="hud-item-icon">' + iconSvg(t.status) + '</span><span class="hud-item-text">' + formatTaskTitleHtml(t.title) + '</span></li>';
      }

      // 与 Claude 任务列表相同的 12 条窗口：以首个 in_progress（否则首个未完成项）为锚，前面留 1 条已完成
      function windowTasks(list, size) {
        let focus = list.findIndex((t) => t.status === 'in_progress');
        if (focus < 0) focus = list.findIndex((t) => t.status !== 'completed');
        const anchor = focus >= 0 ? focus : list.length;
        const start = Math.max(0, Math.min(anchor - 1, list.length - size));
        const after = list.slice(start + size);
        return {
          visible: list.slice(start, start + size),
          hiddenBefore: start,
          openAfter: after.filter((t) => t.status !== 'completed').length,
        };
      }

      function setListNote(id, text) {
        const el = $(id);
        if (!el) return;
        el.textContent = text;
        el.classList.toggle('hidden', !text);
      }

      function renderTaskList(tasks) {
        const win = windowTasks(tasks, 12);
        $('hud-list').innerHTML = win.visible.map(renderTaskItem).join('');
        setListNote('hud-list-before', win.hiddenBefore > 0 ? (win.hiddenBefore === 1 ? '1 earlier step' : win.hiddenBefore + ' earlier steps') : '');
        setListNote('hud-list-after', win.openAfter > 0 ? win.openAfter + ' more to go' : '');
      }

      function renderToolRow(tool) {
        const badge = tool.kind === 'read' || tool.kind === 'edit' ? '<span class="hud-tool-badge">&lt;/&gt;</span>' : '';
        return \`<div class="hud-tool-row">\${badge}<span>\${esc(tool.text)}</span><span class="hud-chevron">›</span></div>\`;
      }

      function normalizeTasks(tasks, isDone) {
        if (!Array.isArray(tasks)) return [];
        const list = tasks.map((t, idx) => {
          const itemTitle =
            typeof t === 'string'
              ? t
              : t?.title || t?.content || t?.text || t?.name || t?.label || t?.step || t?.description || '';
          return {
            ...(typeof t === 'object' && t ? t : {}),
            id: String(t?.id ?? idx + 1),
            title: String(itemTitle).trim(),
            status: t?.status || 'pending',
          };
        });
        let lastActiveOrDone = -1;
        for (let i = 0; i < list.length; i++) {
          if (list[i].status === 'in_progress' || list[i].status === 'completed') lastActiveOrDone = i;
        }
        for (let i = 0; i < list.length; i++) {
          if (list[i].status === 'in_progress' && i < lastActiveOrDone) list[i].status = 'completed';
        }
        const lastIdx = list.length - 1;
        if (isDone || (lastIdx >= 0 && list[lastIdx].status === 'completed')) {
          for (const t of list) {
            if (t.status === 'in_progress') t.status = 'completed';
          }
        }
        return list;
      }

      function renderTimer() {
        if (!currentData) return;
        const isRunning = currentData.status === 'running';
        const isInterrupted = currentData.status === 'interrupted';
        const isUserCanceled = isInterrupted && currentData.terminationReason === 'USER_CANCELED';
        $('hud-dot').className = \`hud-dot \${isRunning ? 'dot-running' : isInterrupted ? 'dot-superseded' : 'dot-done'}\`;
        if (isRunning && currentData.startedAt) {
          $('hud-timer-label').textContent = '本轮对话已用时';
          $('hud-timer-val').textContent = formatDuration(Date.now() - currentData.startedAt);
        } else {
          $('hud-timer-label').textContent = isUserCanceled ? '停止前用时' : isInterrupted ? '中断前用时' : '本轮对话用时';
          const ms = currentData.hasExplicitElapsed
            ? Math.max(0, Number(currentData.elapsedMs))
            : currentData.elapsedMs || (currentData.startedAt ? Date.now() - currentData.startedAt : 0);
          $('hud-timer-val').textContent = formatDuration(ms);
        }
        const tokSep = $('hud-token-sep');
        const tokVal = $('hud-token-val');
        if (tokSep && tokVal) {
          const tokText = String(currentData.tokenText || '').trim();
          tokSep.classList.toggle('hidden', !tokText);
          tokVal.classList.toggle('hidden', !tokText);
          tokVal.textContent = tokText;
          tokVal.title = String(currentData.tokenDetail || '');
        }
      }

      function summarizeToolGroup(tools, thoughtSec) {
        const counts = { read: 0, edit: 0, command: 0, search: 0, other: 0 };
        const editedFiles = [];
        for (const t of tools) {
          const k = t.kind || 'other';
          counts[k] = (counts[k] || 0) + 1;
          if (k === 'edit' && t.text) {
            const fn = t.text.replace(/^Edited\\s+/, '');
            if (fn && !editedFiles.includes(fn)) editedFiles.push(fn);
          }
        }
        const parts = [];
        const exploredCount = counts.read + counts.search;
        if (exploredCount > 0) parts.push(exploredCount === 1 ? 'Explored 1 file' : \`Explored \${exploredCount} files\`);
        if (counts.edit > 0) {
          parts.push(editedFiles.length === 1 ? \`edited \${editedFiles[0]}\` : \`edited \${counts.edit} files\`);
        }
        if (counts.command > 0) parts.push(counts.command === 1 ? 'ran 1 command' : \`ran \${counts.command} commands\`);
        if (counts.other > 0) parts.push(\`ran \${counts.other} tools\`);

        let label = parts.join(', ');
        if (label) {
          label = label.charAt(0).toUpperCase() + label.slice(1);
        } else if (thoughtSec) {
          label = \`Thought for \${thoughtSec}s\`;
        }
        if (thoughtSec && parts.length > 0) {
          label = \`Thought for \${thoughtSec}s, \${label.charAt(0).toLowerCase() + label.slice(1)}\`;
        }
        return label;
      }

      function buildTimelineHtml(logs, steps) {
        const safeLogs = Array.isArray(logs) ? logs : [];
        const safeSteps = Array.isArray(steps) ? steps : [];

        // If steps from transcript exist, group consecutive tool/thought steps between distinct log messages
        const groups = [];
        const seenLogs = new Set();

        if (safeSteps.length > 0) {
          let pendingTools = [];
          let pendingThought = 0;

          for (let i = 0; i < safeSteps.length; i++) {
            const st = safeSteps[i] || {};
            const candidateLog = (st.log || '').trim();
            const isNewLog = candidateLog && !seenLogs.has(candidateLog);

            if (isNewLog) {
              if (pendingTools.length > 0 || pendingThought > 0) {
                groups.push({ type: 'fold', tools: pendingTools, thoughtSec: pendingThought });
                pendingTools = [];
                pendingThought = 0;
              }
              seenLogs.add(candidateLog);
              groups.push({ type: 'log', text: candidateLog, thoughtSec: i > 0 ? st.thoughtSec : 0 });
            } else if (st.thoughtSec) {
              pendingThought += st.thoughtSec;
            }

            if (Array.isArray(st.tools) && st.tools.length > 0) {
              pendingTools.push(...st.tools);
            }
          }

          if (pendingTools.length > 0 || pendingThought > 0) {
            groups.push({ type: 'fold', tools: pendingTools, thoughtSec: pendingThought });
          }

          // Append any logs from task-hud.html not yet captured in transcript steps
          for (const l of safeLogs) {
            const trimmed = String(l || '').trim();
            if (trimmed && !seenLogs.has(trimmed)) {
              seenLogs.add(trimmed);
              groups.push({ type: 'log', text: trimmed, thoughtSec: 0 });
            }
          }
        } else {
          for (const l of safeLogs) {
            const trimmed = String(l || '').trim();
            if (trimmed && !seenLogs.has(trimmed)) {
              seenLogs.add(trimmed);
              groups.push({ type: 'log', text: trimmed, thoughtSec: 0 });
            }
          }
        }

        if (groups.length === 0) return '';

        const htmlBlocks = [];
        for (let i = 0; i < groups.length; i++) {
          const g = groups[i];
          if (g.type === 'log') {
            const parts = [];
            if (i > 0 && g.thoughtSec) {
              const prev = groups[i - 1];
              if (!prev || prev.type !== 'fold') {
                parts.push(\`<div class="hud-thought-row"><span>Thought for \${g.thoughtSec}s</span><span class="hud-chevron">›</span></div>\`);
              }
            }
            parts.push(\`<div class="hud-log-item">\${formatLogHtml(g.text)}</div>\`);
            htmlBlocks.push(\`<div class="hud-step-block">\${parts.join('')}</div>\`);
          } else if (g.type === 'fold') {
            const next = groups[i + 1];
            const extraThought = next && next.type === 'log' ? next.thoughtSec : 0;
            const summaryLabel = summarizeToolGroup(g.tools, g.thoughtSec || extraThought);
            if (!summaryLabel) continue;
            if (g.tools.length === 0) {
              htmlBlocks.push(\`<div class="hud-step-block"><div class="hud-thought-row"><span>\${esc(summaryLabel)}</span><span class="hud-chevron">›</span></div></div>\`);
            } else {
              const inner = g.tools.map((t) => renderToolRow(t)).join('');
              htmlBlocks.push(\`<div class="hud-step-block"><details class="hud-fold"><summary><span>\${esc(summaryLabel)}</span><span class="hud-fold-chevron">›</span></summary><div class="hud-fold-body">\${inner}</div></details></div>\`);
            }
          }
        }
        return htmlBlocks.join('');
      }

      const myInstanceId = Math.random().toString(36).slice(2);
      const myMountedAt = Date.now();
      let isCollapsed = false;
      let isCompletedFrozen = false;
      let isSuperseded = false;
      let lastSig = '';
      let clockTimer = null;
      let pollTimer = null;
      let doneFreezeTimer = null;
      let bc = null;
      try {
        const rawPath = String(location.pathname || location.href || '').split(/[?#]/)[0];
        const pathParts = rawPath.split('/').filter(Boolean);
        const scopeKey = pathParts.length >= 2 ? pathParts[pathParts.length - 2] : 'default';
        bc = new BroadcastChannel('task_hud_live_slot:' + scopeKey);
        bc.onmessage = (ev) => {
          const msg = ev?.data;
          if (!msg || msg.type !== 'CLAIM' || msg.instanceId === myInstanceId) return;
          if (isCompletedFrozen || currentData?.status === 'done') return;
          if (currentData?.status === 'interrupted' && currentData?.terminationReason === 'USER_CANCELED') return;
          if ((msg.mountedAt || 0) >= myMountedAt) {
            collapseSelf();
          }
        };
      } catch {}

      function collapseSelf() {
        /* task-hud-collapse-v1 */
        if (isCollapsed) return;
        isCollapsed = true;
        if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (doneFreezeTimer) { clearTimeout(doneFreezeTimer); doneFreezeTimer = null; }
        try {
          if (bc) { bc.close(); bc = null; }
        } catch {}
        document.documentElement.classList.add('is-collapsed');
        const collapsedCss = 'margin:0!important;padding:0!important;height:0!important;min-height:0!important;max-height:0!important;line-height:0!important;font-size:0!important;border:0!important;overflow:hidden!important;';
        document.documentElement.style.cssText = collapsedCss;
        if (document.body) {
          document.body.style.cssText = collapsedCss;
          document.body.innerHTML = '';
        }
      }

      function freezeAsSuperseded() {
        if (isSuperseded || isCompletedFrozen || isCollapsed) return;
        isSuperseded = true;
        isCompletedFrozen = true;
        if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (doneFreezeTimer) { clearTimeout(doneFreezeTimer); doneFreezeTimer = null; }

        const rootEl = $('hud-root');
        const doneFoldEl = $('hud-done-fold');
        const doneBodyEl = $('hud-done-body');
        const liveBodyEl = $('hud-live-body');
        const dotEl = $('hud-done-dot');
        if (!rootEl || !doneFoldEl || !doneBodyEl || !liveBodyEl) return;
        const cardEl = $('hud-card');
        if (cardEl) cardEl.classList.add('is-paused');

        const rawTasks = Array.isArray(currentData?.tasks) ? currentData.tasks : [];
        const tasks = normalizeTasks(rawTasks, false);
        const doneCount = tasks.filter((t) => t.status === 'completed').length;
        const ms = currentData?.startedAt && currentData.startedAt > 1000000000000
          ? Math.max(0, Date.now() - currentData.startedAt)
          : Number(currentData?.elapsedMs || 0);
        const durationStr = formatDuration(ms);
        const taskPart = tasks.length > 0 ? \`已转入后续追问 · 已完成 \${doneCount}/\${tasks.length} 项\` : '已转入后续追问';

        if (dotEl) { dotEl.className = 'hud-done-icon is-superseded'; dotEl.innerHTML = HUD_ICON_PAUSED; }
        const tokPart = currentData?.tokenText ? \` · \${currentData.tokenText}\` : '';
        $('hud-done-text').textContent = ms > 0 ? \`中断前用时 \${durationStr}\${tokPart} · \${taskPart}\` : \`\${taskPart}\${tokPart}\`;
        $('hud-done-text').title = String(currentData?.tokenDetail || '');
        $('hud-done-stats').textContent = currentData?.statsText || '';
        doneBodyEl.appendChild(liveBodyEl);
        rootEl.classList.remove('hidden');
        doneFoldEl.classList.remove('hidden');
        doneFoldEl.open = false;
      }

      function render(data) {
        if (!data || isCollapsed) return;
        if (data.collapsed || data.status === 'collapsed') {
          collapseSelf();
          return;
        }
        if (isSuperseded) return;
        const sig = JSON.stringify({
          status: data.status,
          terminationReason: data.terminationReason || '',
          collapsed: Boolean(data.collapsed),
          tasks: data.tasks,
          logs: data.logs,
          steps: data.steps,
          statsText: data.statsText,
          tokenText: data.tokenText || '',
          elapsedMs: data.elapsedMs,
        });
        if (sig === lastSig) return;
        lastSig = sig;

        currentData = data;
        const rawTasks = Array.isArray(data.tasks) ? data.tasks : [];
        const allTasksCompleted = rawTasks.length > 0 && rawTasks.every((t) => t.status === 'completed');
        const isDone = Boolean(data.status === 'done' || allTasksCompleted);
        const isInterrupted = Boolean(!isDone && data.status === 'interrupted');
        currentData.status = isDone ? 'done' : isInterrupted ? 'interrupted' : 'running';

        const tasks = normalizeTasks(rawTasks, isDone);
        const rawLogs = Array.isArray(data.logs) && data.logs.length > 0
          ? data.logs
          : data.summary
          ? [data.summary]
          : [];
        const logs = rawLogs.map((l) => String(l || '').trim()).filter(Boolean);
        const steps = Array.isArray(data.steps) ? data.steps : [];

        $('hud-stats').textContent = data.statsText || '';

        const rootEl = $('hud-root');
        const doneFoldEl = $('hud-done-fold');
        const doneBodyEl = $('hud-done-body');
        const liveBodyEl = $('hud-live-body');
        const logsEl = $('hud-logs');
        const panelEl = $('hud-panel');
        const cardEl = $('hud-card');

        const timelineHtml = buildTimelineHtml(logs, steps);
        if (timelineHtml) {
          logsEl.classList.remove('hidden');
          logsEl.innerHTML = timelineHtml;
        } else {
          logsEl.classList.add('hidden');
          logsEl.innerHTML = '';
        }

        if (tasks.length > 0) {
          panelEl.classList.remove('hidden');
          renderTaskList(tasks);
        } else {
          panelEl.classList.add('hidden');
        }

        if (timelineHtml || tasks.length > 0) {
          rootEl.classList.remove('hidden');
          if (!isDone && !isInterrupted) {
            try {
              if (bc) bc.postMessage({ type: 'CLAIM', instanceId: myInstanceId, mountedAt: myMountedAt });
            } catch {}
          }
        } else if (data.status === 'running' && data.startedAt) {
          rootEl.classList.remove('hidden');
          panelEl.classList.remove('hidden');
          renderTaskList([{ status: 'in_progress', title: '正在分析并拆解执行步骤…' }]);
          if (!isDone && !isInterrupted) {
            try {
              if (bc) bc.postMessage({ type: 'CLAIM', instanceId: myInstanceId, mountedAt: myMountedAt });
            } catch {}
          }
        } else if ((isDone || isInterrupted) && (data.hasExplicitElapsed || Number(data.elapsedMs || 0) > 0 || Number(data.startedAt || 0) > 0)) {
          rootEl.classList.remove('hidden');
        } else {
          rootEl.classList.add('hidden');
          return;
        }

        if (isDone) {
          /* task-hud-unfreeze-v2 */
          if (cardEl) cardEl.classList.remove('is-paused');
          const dotEl = $('hud-done-dot');
          if (dotEl) { dotEl.className = 'hud-done-icon is-done'; dotEl.innerHTML = HUD_ICON_CHECK; }
          const doneCount = tasks.filter((t) => t.status === 'completed').length;
          let ms = Number(data.elapsedMs || 0);
          if (ms <= 0 && data.startedAt && data.startedAt > 1000000000000) {
            ms = Math.max(0, Date.now() - data.startedAt);
          }
          const durationStr = formatDuration(ms);
          const tokPart = data.tokenText ? \` · \${data.tokenText}\` : '';
          const taskPart = tasks.length > 0 ? \`已完成 \${doneCount}/\${tasks.length} 项任务\` : '已完成';
          $('hud-done-text').textContent = \`本轮用时 \${durationStr}\${tokPart} · \${taskPart}\`;
          $('hud-done-text').title = String(data.tokenDetail || '');
          $('hud-done-stats').textContent = data.statsText || '';
          doneBodyEl.appendChild(liveBodyEl);
          doneFoldEl.classList.remove('hidden');
          doneFoldEl.open = false;
          if (!doneFreezeTimer) {
            doneFreezeTimer = setTimeout(() => {
              isCompletedFrozen = true;
              if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
              if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
            }, 2500);
          }
        } else if (isInterrupted) {
          isCompletedFrozen = false;
          if (doneFreezeTimer) { clearTimeout(doneFreezeTimer); doneFreezeTimer = null; }
          if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
          if (cardEl) cardEl.classList.add('is-paused');
          const dotEl = $('hud-done-dot');
          if (dotEl) { dotEl.className = 'hud-done-icon is-superseded'; dotEl.innerHTML = HUD_ICON_PAUSED; }
          const doneCount = tasks.filter((t) => t.status === 'completed').length;
          let ms = data.hasExplicitElapsed ? Math.max(0, Number(data.elapsedMs)) : Number(data.elapsedMs || 0);
          if (!data.hasExplicitElapsed && ms <= 0 && data.startedAt && data.startedAt > 1000000000000) {
            ms = Math.max(0, Date.now() - data.startedAt);
          }
          const durationStr = formatDuration(ms);
          const tokPart = data.tokenText ? \` · \${data.tokenText}\` : '';
          const isUserCanceled = data.terminationReason === 'USER_CANCELED';
          if (isUserCanceled) {
            const taskPart = tasks.length > 0 ? \`已停止 · 用时 \${durationStr}\${tokPart} · 已完成 \${doneCount}/\${tasks.length} 项\` : \`已停止 · 用时 \${durationStr}\${tokPart}\`;
            $('hud-done-text').textContent = taskPart;
          } else {
            const taskPart = tasks.length > 0 ? \`已完成 \${doneCount}/\${tasks.length} 项\` : '已中断';
            $('hud-done-text').textContent = ms > 0 ? \`中断前用时 \${durationStr}\${tokPart} · \${taskPart}\` : \`\${taskPart}\${tokPart}\`;
          }
          $('hud-done-text').title = String(data.tokenDetail || '');
          $('hud-done-stats').textContent = data.statsText || '';
          doneBodyEl.appendChild(liveBodyEl);
          doneFoldEl.classList.remove('hidden');
          doneFoldEl.open = false;
          if (isUserCanceled && !doneFreezeTimer) {
            doneFreezeTimer = setTimeout(() => {
              isCompletedFrozen = true;
              if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
              if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
            }, 2500);
          }
        } else {
          isCompletedFrozen = false;
          if (cardEl) cardEl.classList.remove('is-paused');
          if (doneFreezeTimer) { clearTimeout(doneFreezeTimer); doneFreezeTimer = null; }
          if (!clockTimer) { clockTimer = setInterval(renderTimer, 1000); }
          if (liveBodyEl.parentElement !== rootEl) {
            rootEl.appendChild(liveBodyEl);
          }
          doneFoldEl.classList.add('hidden');

          // Keep total height under the 680px host embed cap by collapsing oldest step blocks into one expandable summary
          const stepBlocks = Array.from(logsEl.querySelectorAll('.hud-step-block'));
          const archived = [];
          let idx = 0;
          while (document.body.scrollHeight > 680 && idx < stepBlocks.length - 2) {
            archived.push(stepBlocks[idx]);
            stepBlocks[idx].style.display = 'none';
            idx++;
          }
          if (archived.length > 0) {
            const wrapDetails = document.createElement('details');
            wrapDetails.className = 'hud-fold';
            wrapDetails.innerHTML = \`<summary><span>Earlier steps (\${archived.length})</span><span class="hud-fold-chevron">›</span></summary><div class="hud-fold-body"></div>\`;
            const bodyEl = wrapDetails.querySelector('.hud-fold-body');
            for (const b of archived) {
              b.style.display = '';
              bodyEl.appendChild(b);
            }
            logsEl.prepend(wrapDetails);
          }
        }

        renderTimer();
      }

      function parseHudJsonBlock(rawText, allowRepair) {
        const text = String(rawText || '').trim();
        if (!text) return {};
        try {
          const obj = JSON.parse(text);
          return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
        } catch {
          if (!allowRepair) return {};
        }
        try {
          const parts = [];
          const strRe = /"(?:\\\\[\\s\\S]|[^"\\\\])*"/g;
          let lastIdx = 0;
          const cleanGap = (seg) => seg
            .replace(/\\]\\s*\\[\\s*\\]/g, ']')
            .replace(/\\}\\s*\\{\\s*\\}/g, '}')
            .replace(/,\\s*([}\\]])/g, '$1')
            .replace(/\\}\\s*\\{/g, '}, {')
            .replace(/\\]\\s*\\[/g, '], [');
          for (const m of text.matchAll(strRe)) {
            parts.push(cleanGap(text.slice(lastIdx, m.index)));
            parts.push(m[0]);
            lastIdx = m.index + m[0].length;
          }
          parts.push(cleanGap(text.slice(lastIdx)));
          const obj = JSON.parse(parts.join(''));
          return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
        } catch {
          return {};
        }
      }

      function parseMerged(docText) {
        let tRaw = '';
        let rRaw = '';
        if (docText) {
          const tm = docText.match(/<script[^>]*id=["']task-hud-(?:tasks|data)["'][^>]*>([\\s\\S]*?)<\\/script>/i);
          const rm = docText.match(/<script[^>]*id=["']task-hud-runtime["'][^>]*>([\\s\\S]*?)<\\/script>/i);
          tRaw = tm && tm[1] ? tm[1] : '{}';
          rRaw = rm && rm[1] ? rm[1] : '{}';
        } else {
          tRaw = ($('task-hud-tasks') || $('task-hud-data'))?.textContent || '{}';
          rRaw = $('task-hud-runtime')?.textContent || '{}';
        }
        const tObj = parseHudJsonBlock(tRaw, true);
        const rObj = parseHudJsonBlock(rRaw, false);
        const collapsed = Boolean(
          rObj.collapsed || tObj.collapsed || rObj.status === 'collapsed' || tObj.status === 'collapsed'
        );
        const rStatus = typeof rObj.status === 'string' ? rObj.status : '';
        const status = collapsed
          ? 'collapsed'
          : (rStatus === 'interrupted' || rStatus === 'done')
          ? rStatus
          : (tObj.status || rStatus || 'running');
        const terminationReason = String(rObj.terminationReason || tObj.terminationReason || '');
        const hasExplicitElapsed = typeof rObj.elapsedMs === 'number' && Number.isFinite(rObj.elapsedMs);
        return { ...rObj, ...tObj, collapsed, status, terminationReason, hasExplicitElapsed };
      }

      async function pollSelf() {
        if (isCollapsed || isSuperseded || isCompletedFrozen) return;
        try {
          if (!location.href || location.href.startsWith('about:') || location.href.startsWith('data:')) return;
          const res = await fetch(location.href, { cache: 'no-store' });
          if (!res.ok) return;
          const html = await res.text();
          const merged = parseMerged(html);
          if (merged) render(merged);
        } catch {}
      }

      const merged = parseMerged();
      if (merged) render(merged);
      if (!isCollapsed && currentData && currentData.status === 'running' && !clockTimer) {
        clockTimer = setInterval(renderTimer, 1000);
      }
      if (!isCollapsed && !isCompletedFrozen && !pollTimer) {
        pollTimer = setInterval(pollSelf, 600);
      }
    })();
  </script>
</body>
</html>
`;

const HUD_TASKS_SCRIPT_RE = /(<script[^>]*id=["']task-hud-(?:tasks|data)["'][^>]*>)([\s\S]*?)(<\/script>)/i;
const HUD_RUNTIME_SCRIPT_RE = /(<script[^>]*id=["']task-hud-runtime["'][^>]*>)([\s\S]*?)(<\/script>)/i;
const HUD_TASKS_BLOCK_ANCHORED_RE = /(<script[^>]*id=["']task-hud-(?:tasks|data)["'][^>]*>)([\s\S]*?)(<\/script>)(\s*<script[^>]*id=["']task-hud-runtime["'])/i;
const HUD_RUNTIME_BLOCK_ANCHORED_RE = /(<script[^>]*id=["']task-hud-runtime["'][^>]*>)([\s\S]*?)(<\/script>)(\s*<div[^>]*id=["']hud-root["'])/i;
const HUD_TEMPLATE_MARKER = 'freezeAsSuperseded';
const HUD_TEMPLATE_STYLE_MARKER = 'padding: 2px 46px 4px 0';
const HUD_TEMPLATE_RESILIENT_MARKER = 'parseHudJsonBlock';
const HUD_TEMPLATE_TASKCARD_MARKER = 'hud-spinner-arc';
const HUD_TEMPLATE_UNFREEZE_MARKER = 'task-hud-unfreeze-v2';
const HUD_TEMPLATE_SPINNER_MARKER = 'task-hud-spinner-v3';
const HUD_TEMPLATE_DONEBAR_MARKER = 'hud-done-chevron';
const HUD_TEMPLATE_COLLAPSE_MARKER = 'task-hud-collapse-v1';
const HUD_TEMPLATE_STOP_FOLD_MARKER = 'task-hud-stop-fold-v1';
const HUD_TEMPLATE_FONT_MARKER = 'task-hud-font-v1';
const HUD_TEMPLATE_TOKEN_MARKER = 'task-hud-token-v1';

function serializeJsonForHtmlScript(obj) {
  return JSON.stringify(obj, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeRawJsonForHtmlScript(rawText) {
  return String(rawText || '')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function replaceTasksScriptBlock(html, obj) {
  const json = serializeJsonForHtmlScript(obj);
  if (HUD_TASKS_BLOCK_ANCHORED_RE.test(html)) {
    return html.replace(
      HUD_TASKS_BLOCK_ANCHORED_RE,
      (_, open, _body, close, after) => `${open}\n${json}\n  ${close}${after}`
    );
  }
  if (HUD_TASKS_SCRIPT_RE.test(html)) {
    return html.replace(
      HUD_TASKS_SCRIPT_RE,
      (_, open, _body, close) => `${open}\n${json}\n  ${close}`
    );
  }
  return html;
}

function replaceRuntimeScriptBlock(html, obj) {
  const json = serializeJsonForHtmlScript(obj);
  if (HUD_RUNTIME_BLOCK_ANCHORED_RE.test(html)) {
    return html.replace(
      HUD_RUNTIME_BLOCK_ANCHORED_RE,
      (_, open, _body, close, after) => `${open}\n${json}\n  ${close}${after}`
    );
  }
  if (HUD_RUNTIME_SCRIPT_RE.test(html)) {
    return html.replace(
      HUD_RUNTIME_SCRIPT_RE,
      (_, open, _body, close) => `${open}\n${json}\n  ${close}`
    );
  }
  return html;
}

function extractTasksScriptBody(html) {
  const s = String(html || '');
  const anchored = s.match(HUD_TASKS_BLOCK_ANCHORED_RE);
  if (anchored && anchored[2]) return anchored[2];
  const fallback = s.match(HUD_TASKS_SCRIPT_RE);
  return fallback && fallback[2] ? fallback[2] : '';
}

function extractRuntimeScriptBody(html) {
  const s = String(html || '');
  const anchored = s.match(HUD_RUNTIME_BLOCK_ANCHORED_RE);
  if (anchored && anchored[2]) return anchored[2];
  const fallback = s.match(HUD_RUNTIME_SCRIPT_RE);
  return fallback && fallback[2] ? fallback[2] : '';
}

function isTemplateStructureBroken(html) {
  const s = String(html || '');
  const tasksSpan = s.match(/<script[^>]*id=["']task-hud-(?:tasks|data)["'][^>]*>([\s\S]*?)<script[^>]*id=["']task-hud-runtime["']/i);
  if (!tasksSpan || !tasksSpan[1]) return true;
  const tasksCloses = tasksSpan[1].match(/<\/script>/gi);
  if (!tasksCloses || tasksCloses.length !== 1) return true;

  const runtimeSpan = s.match(/<script[^>]*id=["']task-hud-runtime["'][^>]*>([\s\S]*?)<div[^>]*id=["']hud-root["']/i);
  if (!runtimeSpan || !runtimeSpan[1]) return true;
  const runtimeCloses = runtimeSpan[1].match(/<\/script>/gi);
  if (!runtimeCloses || runtimeCloses.length !== 1) return true;

  return false;
}

function parseHudTasksJson(html) {
  const body = extractTasksScriptBody(html);
  if (!body) return null;
  return parseHudTasksJsonText(body).data;
}

function parseHudRuntimeJson(html) {
  const body = extractRuntimeScriptBody(html);
  if (!body) return null;
  try {
    const parsed = JSON.parse(body.trim());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isHudSlotCollapsed(html) {
  const runtimeObj = parseHudRuntimeJson(html);
  if (runtimeObj && (runtimeObj.collapsed === true || runtimeObj.status === 'collapsed')) {
    return true;
  }
  const tasksObj = parseHudTasksJson(html);
  return Boolean(tasksObj && (tasksObj.collapsed === true || tasksObj.status === 'collapsed'));
}

export function isHudSlotCollapsedFile(artifactDir, fileName) {
  const norm = normalizeHudFileName(fileName);
  if (!artifactDir || !norm) return false;
  const htmlPath = join(artifactDir, norm);
  if (!existsSync(htmlPath)) return false;
  try {
    return isHudSlotCollapsed(readFileSync(htmlPath, 'utf-8'));
  } catch {
    return false;
  }
}

function hasNonEmptyHudTasks(html) {
  const obj = parseHudTasksJson(html);
  return Boolean(obj && Array.isArray(obj.tasks) && obj.tasks.length > 0);
}

function isHudSlotUsed(html) {
  return hasNonEmptyHudTasks(html) || isHudSlotCollapsed(html);
}

function upgradeTemplatePreservingData(filePath) {
  if (!existsSync(filePath)) {
    writeTextAtomic(filePath, HUD_HTML_TEMPLATE);
    return;
  }
  const origHtml = readFileSync(filePath, 'utf-8');
  const broken = isTemplateStructureBroken(origHtml);
  if (
    !broken &&
    origHtml.includes(HUD_TEMPLATE_MARKER) &&
    origHtml.includes('isCompletedFrozen') &&
    origHtml.includes(HUD_TEMPLATE_STYLE_MARKER) &&
    origHtml.includes(HUD_TEMPLATE_RESILIENT_MARKER) &&
    origHtml.includes(HUD_TEMPLATE_UNFREEZE_MARKER) &&
    origHtml.includes(HUD_TEMPLATE_SPINNER_MARKER) &&
    origHtml.includes(HUD_TEMPLATE_DONEBAR_MARKER) &&
    origHtml.includes(HUD_TEMPLATE_COLLAPSE_MARKER) &&
    origHtml.includes(HUD_TEMPLATE_STOP_FOLD_MARKER) &&
    origHtml.includes(HUD_TEMPLATE_FONT_MARKER) &&
    origHtml.includes(HUD_TEMPLATE_TOKEN_MARKER)
  ) {
    return;
  }
  let nextHtml = HUD_HTML_TEMPLATE;
  const parsedTasksObj = parseHudTasksJson(origHtml);
  if (parsedTasksObj) {
    nextHtml = replaceTasksScriptBlock(nextHtml, parsedTasksObj);
  } else {
    const oldTasksBody = extractTasksScriptBody(origHtml);
    if (oldTasksBody) {
      const safeRaw = escapeRawJsonForHtmlScript(oldTasksBody);
      nextHtml = nextHtml.replace(HUD_TASKS_SCRIPT_RE, (_, open, _body, close) => `${open}${safeRaw}${close}`);
    }
  }
  const runtimeSpan = origHtml.match(/<script[^>]*id=["']task-hud-runtime["'][^>]*>([\s\S]*?)<div[^>]*id=["']hud-root["']/i);
  const hasRuntimeGarbage = Boolean(runtimeSpan && (runtimeSpan[1].match(/<\/script>/gi)?.length || 0) > 1);
  const oldRuntimeBody = extractRuntimeScriptBody(origHtml);
  if (oldRuntimeBody && !hasRuntimeGarbage) {
    try {
      const parsedRuntimeObj = JSON.parse(oldRuntimeBody.trim());
      if (parsedRuntimeObj && typeof parsedRuntimeObj === 'object' && !Array.isArray(parsedRuntimeObj)) {
        nextHtml = replaceRuntimeScriptBlock(nextHtml, parsedRuntimeObj);
      }
    } catch {
      // ignore corrupted runtime json and keep clean default
    }
  }
  if (nextHtml !== origHtml) {
    writeTextAtomic(filePath, nextHtml);
  }
}

function resolveTargetTurnSlotCount(artifactDir, minCount = 24) {
  let maxUsed = 0;
  try {
    for (const entry of readdirSync(artifactDir)) {
      const m = entry.match(/^task-hud-t(\d+)\.html$/i);
      if (!m) continue;
      const idx = Number(m[1]);
      if (!Number.isFinite(idx) || idx <= 0) continue;
      try {
        const html = readFileSync(join(artifactDir, entry), 'utf-8');
        if (isHudSlotUsed(html) && idx > maxUsed) {
          maxUsed = idx;
        }
      } catch {
        // ignore read error
      }
    }
  } catch {
    // ignore readdir error
  }
  return Math.max(minCount, maxUsed + 8);
}

/**
 * 为尚未主动编辑槽位文件的轮次（例如处于只读 Plan mode 的 Orchestrator）分配下一个安全空闲槽位。
 */
export function findNextAvailableTurnSlot(artifactDir, state = {}) {
  let maxUsed = 0;
  try {
    for (const entry of readdirSync(artifactDir)) {
      const m = entry.match(/^task-hud-t(\d+)\.html$/i);
      if (!m) continue;
      const idx = Number(m[1]);
      if (!Number.isFinite(idx) || idx <= 0) continue;
      try {
        const html = readFileSync(join(artifactDir, entry), 'utf-8');
        if (isHudSlotUsed(html) && idx > maxUsed) {
          maxUsed = idx;
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  const stateFiles = [
    ...(Array.isArray(state.turns) ? state.turns.map((t) => t?.hudFileName) : []),
    state.lastCompletedTurn?.hudFileName,
  ];
  for (const fn of stateFiles) {
    const m = String(fn || '').match(/^task-hud-t(\d+)\.html$/i);
    if (m) {
      const idx = Number(m[1]);
      if (Number.isFinite(idx) && idx > maxUsed) maxUsed = idx;
    }
  }

  const nextIdx = maxUsed + 1;
  ensureArtifactHudTemplate(artifactDir, Math.max(24, nextIdx + 4));
  return `task-hud-t${nextIdx}.html`;
}

/**
 * 当目标槽位文件尚未填入任何任务（如只读 Plan mode 无 edit_file 工具时），自动填充默认追踪任务与首条进度说明。
 */
export function seedDefaultHudTasksIfEmpty(artifactDir, fileName, { userInput = '' } = {}) {
  const norm = normalizeHudFileName(fileName);
  if (!artifactDir || !norm) return false;
  const htmlPath = join(artifactDir, norm);
  upgradeTemplatePreservingData(htmlPath);
  if (!existsSync(htmlPath)) return false;

  try {
    const origHtml = readFileSync(htmlPath, 'utf-8');
    if (hasNonEmptyHudTasks(origHtml)) return false;

    const cleanReq = String(userInput || '').replace(/\s+/g, ' ').trim();
    const shortReq = cleanReq.length > 28 ? `${cleanReq.slice(0, 28)}…` : cleanReq;
    const initialLog = shortReq
      ? `正在检索上下文并分析请求（“${shortReq}”）。`
      : '正在检索上下文并分析当前任务。';

    const defaultObj = {
      taskTitle: '任务进度',
      autoSeeded: true,
      logs: [initialLog],
      tasks: [
        { id: '1', title: '检索上下文与关键信息', status: 'in_progress' },
        { id: '2', title: '分析定位并整理最终方案', status: 'pending' },
      ],
    };

    if (!HUD_TASKS_SCRIPT_RE.test(origHtml)) return false;
    const nextHtml = replaceTasksScriptBlock(origHtml, defaultObj);
    if (nextHtml !== origHtml) {
      writeTextAtomic(htmlPath, nextHtml);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 在 Plan mode 通过 exit_plan_mode 移交执行阶段时，将 autoSeeded 面板推进至执行阶段。
 */
export function advanceAutoSeededHudForPlanHandover(artifactDir, fileName) {
  const norm = normalizeHudFileName(fileName);
  if (!artifactDir || !norm) return false;
  const htmlPath = join(artifactDir, norm);
  if (!existsSync(htmlPath)) return false;

  try {
    const origHtml = readFileSync(htmlPath, 'utf-8');
    const obj = parseHudTasksJson(origHtml);
    if (!obj || obj.autoSeeded !== true) return false;

    const logs = Array.isArray(obj.logs)
      ? obj.logs.map((s) => String(s || '').trim()).filter(Boolean)
      : obj.summary
      ? [String(obj.summary).trim()]
      : [];
    const lastLog = logs.length > 0 ? logs[logs.length - 1] : '';
    if (!lastLog.includes('移交执行')) {
      logs.push('已完成只读规划，正在移交执行阶段。');
    }

    const nextObj = {
      taskTitle: String(obj.taskTitle || '').trim() || '任务进度',
      autoSeeded: true,
      logs,
      tasks: [
        { id: '1', title: '检索上下文并完成规划方案', status: 'completed' },
        { id: '2', title: '按规划执行修改与验证', status: 'in_progress' },
      ],
    };

    if (!HUD_TASKS_SCRIPT_RE.test(origHtml)) return false;
    const nextHtml = replaceTasksScriptBlock(origHtml, nextObj);
    if (nextHtml !== origHtml) {
      writeTextAtomic(htmlPath, nextHtml);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 清理未被真正嵌入聊天流中的 autoSeeded 孤儿槽位，避免影响下一轮槽位分配。
 */
export function clearAutoSeededHudSlot(artifactDir, fileName) {
  const norm = normalizeHudFileName(fileName);
  if (!artifactDir || !norm) return false;
  const htmlPath = join(artifactDir, norm);
  if (!existsSync(htmlPath)) return false;

  try {
    const origHtml = readFileSync(htmlPath, 'utf-8');
    const obj = parseHudTasksJson(origHtml);
    if (!obj || obj.autoSeeded !== true) return false;

    writeTextAtomic(htmlPath, HUD_HTML_TEMPLATE);
    return true;
  } catch {
    return false;
  }
}

/**
 * 当用户中途追加需求或切换到新任务栏时，彻底收起并隐藏上一个未完成的任务栏（0px 终态）。
 */
export function collapseArtifactHudFile(artifactDir, fileName, { now = Date.now(), turn = null } = {}) {
  const norm = normalizeHudFileName(fileName);
  if (!artifactDir || !norm) return false;
  const htmlPath = join(artifactDir, norm);
  upgradeTemplatePreservingData(htmlPath);
  if (!existsSync(htmlPath)) return false;

  try {
    const origHtml = readFileSync(htmlPath, 'utf-8');
    let html = origHtml;

    const prevTasks = parseHudTasksJson(origHtml);
    const nextTasksObj =
      prevTasks && typeof prevTasks === 'object'
        ? { ...prevTasks, collapsed: true, status: 'collapsed' }
        : { taskTitle: '任务进度', collapsed: true, status: 'collapsed', logs: [], tasks: [] };
    html = replaceTasksScriptBlock(html, nextTasksObj);

    const prevRuntime = parseHudRuntimeJson(origHtml);
    const startedAt = turn?.startedAt || prevRuntime?.startedAt || 0;
    const elapsedMs = turn?.elapsedMs || (startedAt ? Math.max(0, now - startedAt) : 0);
    const nextRuntimeObj = {
      status: 'collapsed',
      collapsed: true,
      turnIndex: turn?.turnIndex || prevRuntime?.turnIndex || 1,
      startedAt,
      elapsedMs,
      statsText: '',
      steps: [],
    };
    html = replaceRuntimeScriptBlock(html, nextRuntimeObj);

    if (html !== origHtml) {
      writeTextAtomic(htmlPath, html);
    }
    return true;
  } catch {
    return false;
  }
}

export function ensureArtifactHudTemplate(artifactDir, minTurnSlots = 24) {
  if (!artifactDir) return '';
  try {
    ensureDir(artifactDir);
    const basePath = join(artifactDir, 'task-hud.html');
    upgradeTemplatePreservingData(basePath);

    const slotCount = resolveTargetTurnSlotCount(artifactDir, minTurnSlots);
    for (const slotName of listTurnSlotNames(slotCount)) {
      upgradeTemplatePreservingData(join(artifactDir, slotName));
    }

    const oldStatePath = join(artifactDir, 'task-hud-state.html');
    if (existsSync(oldStatePath)) {
      try { rmSync(oldStatePath, { force: true }); } catch {}
    }
    return basePath;
  } catch {
    return '';
  }
}

export function resetArtifactHudSlots(artifactDir, { minTurnSlots = 24 } = {}) {
  if (!artifactDir) return;
  try {
    ensureDir(artifactDir);
    const slotCount = resolveTargetTurnSlotCount(artifactDir, minTurnSlots);
    const allNames = ['task-hud.html', ...listTurnSlotNames(slotCount)];

    for (const name of allNames) {
      const htmlPath = join(artifactDir, name);
      if (!existsSync(htmlPath)) {
        writeTextAtomic(htmlPath, HUD_HTML_TEMPLATE);
        continue;
      }
      const origHtml = readFileSync(htmlPath, 'utf-8');
      // 严禁清空已写入过任务或已收起的历史轮次文件，只对其执行无损外壳升级
      if (isHudSlotUsed(origHtml)) {
        upgradeTemplatePreservingData(htmlPath);
        continue;
      }
      if (origHtml !== HUD_HTML_TEMPLATE) {
        writeTextAtomic(htmlPath, HUD_HTML_TEMPLATE);
      }
    }

    const oldStatePath = join(artifactDir, 'task-hud-state.html');
    if (existsSync(oldStatePath)) {
      try { rmSync(oldStatePath, { force: true }); } catch {}
    }
  } catch {
    // ignore reset errors
  }
}

function resolveCompactPath(transcriptPath) {
  if (!transcriptPath) return '';
  if (basename(transcriptPath) === 'transcript_full.jsonl') {
    const compact = join(dirname(transcriptPath), 'transcript.jsonl');
    if (existsSync(compact)) return compact;
  }
  return existsSync(transcriptPath) ? transcriptPath : '';
}

export function writeArtifactHudTasks(
  artifactDir,
  fileName,
  { taskTitle = '任务进度', logs = [], tasks = [], autoSeeded = false } = {}
) {
  if (!artifactDir) return false;
  const norm = normalizeHudFileName(fileName);
  if (!norm) return false;

  const htmlPath = join(artifactDir, norm);
  upgradeTemplatePreservingData(htmlPath);
  if (!existsSync(htmlPath)) return false;

  try {
    const origHtml = readFileSync(htmlPath, 'utf-8');
    if (isHudSlotCollapsed(origHtml)) return false;

    const cleanLogs = Array.isArray(logs)
      ? logs.map((s) => String(s || '').trim()).filter(Boolean)
      : [];
    const cleanTasks = Array.isArray(tasks)
      ? tasks
          .filter((t) => t && typeof t.title === 'string' && t.title.trim())
          .map((t, idx) => ({
            id: String(t.id ?? idx + 1),
            title: t.title.trim(),
            status: t.status || 'pending',
          }))
      : [];

    const payloadObj = {
      taskTitle: String(taskTitle || '').trim() || '任务进度',
      ...(autoSeeded ? { autoSeeded: true } : {}),
      logs: cleanLogs,
      tasks: cleanTasks,
    };

    const nextHtml = replaceTasksScriptBlock(origHtml, payloadObj);
    if (nextHtml !== origHtml) {
      writeTextAtomic(htmlPath, nextHtml);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 将本轮实时计时（startedAt / elapsedMs）、工具统计、工具链 steps 与收尾对号状态直接写回对应轮次 HTML 文件的 #task-hud-runtime：
 * 严格只更新本轮显式绑定的目标槽位（targetFileName / activeTurn.hudFileName），绝不覆写历史轮次文件。
 */
export function syncArtifactHudFile(
  artifactDir,
  state,
  {
    turnFinished = false,
    turnInterrupted = false,
    terminationReason = '',
    now = Date.now(),
    isPreToolUse = false,
    targetFileName = '',
  } = {}
) {
  if (!artifactDir) return false;
  const fileName = normalizeHudFileName(
    targetFileName ||
      state.activeTurn?.hudFileName ||
      (turnFinished ? state.lastCompletedTurn?.hudFileName : '')
  );
  if (!fileName) return false;

  const htmlPath = join(artifactDir, fileName);
  upgradeTemplatePreservingData(htmlPath);
  if (!existsSync(htmlPath)) return false;

  const runtimeRegex = HUD_RUNTIME_SCRIPT_RE;

  try {
    const origHtml = readFileSync(htmlPath, 'utf-8');
    if (isHudSlotCollapsed(origHtml)) return false;
    let html = origHtml;

    const tasksBody = extractTasksScriptBody(html);
    let parsedTasks = [];
    let parsedLogs = [];
    if (tasksBody) {
      const hasUnescapedScriptTag = /<\/script/i.test(tasksBody);
      const { data: tJson, repaired } = parseHudTasksJsonText(tasksBody);
      if (tJson) {
        if (tJson.taskTitle) state.taskTitle = String(tJson.taskTitle).trim();
        parsedLogs = Array.isArray(tJson.logs)
          ? tJson.logs.map((s) => String(s || '').trim()).filter(Boolean)
          : tJson.summary
          ? [String(tJson.summary).trim()]
          : [];
        if (parsedLogs.length > 0) {
          state.logs = parsedLogs;
          state.summary = parsedLogs[parsedLogs.length - 1];
        } else if (tJson.summary) {
          state.summary = String(tJson.summary).trim();
        }
        let hadUnfinished = false;
        if (Array.isArray(tJson.tasks) && tJson.tasks.length > 0) {
          parsedTasks = normalizeAndAdvanceTasks(tJson.tasks, { turnFinished, now });
          if (turnFinished && tJson.autoSeeded === true && !parsedTasks.some((t) => t.status === 'failed')) {
            for (const item of parsedTasks) {
              if (item.status !== 'completed') {
                item.status = 'completed';
                item.updatedAt = now;
              }
            }
          }
          state.tasks = parsedTasks;
          hadUnfinished = tJson.tasks.some((t, idx) => t.status !== parsedTasks[idx]?.status);
        }
        if (repaired || hasUnescapedScriptTag || (turnFinished && hadUnfinished)) {
          const fixedObj = {
            taskTitle: state.taskTitle || '任务进度',
            ...(tJson.autoSeeded ? { autoSeeded: true } : {}),
            logs: parsedLogs.length > 0 ? parsedLogs : state.summary ? [state.summary] : [],
            ...(tJson.status ? { status: tJson.status } : {}),
            tasks: parsedTasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
          };
          html = replaceTasksScriptBlock(html, fixedObj);
        }
      }
    }

    const activeTurn = state.activeTurn;
    const lastTurn = state.lastCompletedTurn;
    const isInterrupted = Boolean(turnInterrupted && !turnFinished);
    const isDone = Boolean(turnFinished || (!activeTurn && !isInterrupted));
    const status = isInterrupted ? 'interrupted' : isDone ? 'done' : 'running';

    const compactTranscript = resolveCompactPath(state.transcriptPath);
    const steps = buildTurnStepsFromTranscript(compactTranscript, {
      includeLatestTools: Boolean((turnFinished || isInterrupted) && !isPreToolUse),
    });

    const turnIndex = activeTurn?.turnIndex || lastTurn?.turnIndex || 1;
    const startedAt = activeTurn?.startedAt || lastTurn?.startedAt || now;
    const elapsedMs = (isDone || isInterrupted)
      ? (typeof lastTurn?.elapsedMs === 'number' && Number.isFinite(lastTurn.elapsedMs)
          ? Math.max(0, lastTurn.elapsedMs)
          : Math.max(0, now - startedAt))
      : 0;
    const statsText = summarizeToolStats(activeTurn?.stats || lastTurn?.stats) || '';
    const resolvedReason = isInterrupted ? String(terminationReason || lastTurn?.terminationReason || '') : '';
    const targetUserStep = activeTurn?.userStepIndex ?? lastTurn?.userStepIndex ?? null;
    const txTokens = computeTurnTokensFromTranscript(compactTranscript, targetUserStep);
    const savedTokens = activeTurn?.tokens || lastTurn?.tokens || createEmptyTokens();
    const resolvedTokens = (txTokens.total || 0) >= (savedTokens.total || 0) ? txTokens : savedTokens;
    const tokenText = formatTokenText(resolvedTokens);
    const tokenDetail = formatTokenDetail(resolvedTokens);

    const runtimeObj = {
      status,
      ...(resolvedReason ? { terminationReason: resolvedReason } : {}),
      turnIndex,
      startedAt,
      elapsedMs,
      tokenText,
      tokenDetail,
      statsText,
      steps,
    };

    if (runtimeRegex.test(html) || HUD_RUNTIME_BLOCK_ANCHORED_RE.test(html)) {
      html = replaceRuntimeScriptBlock(html, runtimeObj);
    }

    if (html !== origHtml) {
      writeTextAtomic(htmlPath, html);
    }
    return true;
  } catch {
    return false;
  }
}

const HUD_END_DATA_SCRIPT_RE = /(<script[^>]*id=["']task-hud-end-data["'][^>]*>)([\s\S]*?)(<\/script>)/i;

const HUD_END_HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    :root {
      --hud-font-sans: var(--font-sans, var(--vscode-font-family, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, Roboto, "PingFang SC", sans-serif));
      --pill-bg: rgba(15, 23, 42, 0.045);
      --pill-border: rgba(15, 23, 42, 0.11);
      --pill-text: #475569;
      --pill-text-strong: #1e293b;
      --pill-icon: #64748b;
    }
    :root[data-hud-theme="dark"] {
      --pill-bg: rgba(255, 255, 255, 0.055);
      --pill-border: rgba(255, 255, 255, 0.11);
      --pill-text: #a1a1aa;
      --pill-text-strong: #e4e4e7;
      --pill-icon: #94a3b8;
    }
    @media (prefers-color-scheme: dark) {
      :root:not([data-hud-theme]) {
        --pill-bg: rgba(255, 255, 255, 0.055);
        --pill-border: rgba(255, 255, 255, 0.11);
        --pill-text: #a1a1aa;
        --pill-text-strong: #e4e4e7;
        --pill-icon: #94a3b8;
      }
    }
    html, body {
      margin: 0;
      padding: 0;
      background: transparent;
      font-family: var(--hud-font-sans);
      font-size: 12px;
      line-height: 1;
      -webkit-font-smoothing: antialiased;
      overflow: hidden;
      scrollbar-width: none !important;
    }
    html::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
    .end-bar {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      padding: 2px 0;
    }
    .end-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 24px;
      padding: 0 9px;
      border-radius: 6px;
      background: var(--pill-bg);
      border: 1px solid var(--pill-border);
      color: var(--pill-text);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      user-select: none;
    }
    .end-pill svg {
      width: 13px;
      height: 13px;
      color: var(--pill-icon);
      flex-shrink: 0;
    }
    .end-pill strong {
      font-weight: 500;
      color: var(--pill-text-strong);
    }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <script id="task-hud-end-data" type="application/json">
{
  "status": "finalizing",
  "durationText": "",
  "tokenText": "",
  "tokenDetail": ""
}
  </script>
  <div id="end-bar" class="end-bar hidden">
    <span id="pill-time" class="end-pill hidden">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8.5" r="5.5"/><path d="M8 5.5v3l2 1.2M6.2 1.8h3.6"/></svg>
      <span>用时</span><strong id="val-time"></strong>
    </span>
    <span id="pill-tok" class="end-pill hidden">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="8" cy="4" rx="4.8" ry="1.8"/><path d="M3.2 4v8c0 1 2.15 1.8 4.8 1.8s4.8-.8 4.8-1.8V4M3.2 8c0 1 2.15 1.8 4.8 1.8s4.8-.8 4.8-1.8"/></svg>
      <span>用量</span><strong id="val-tok"></strong>
    </span>
  </div>
  <script>
    (() => {
      const $ = (id) => document.getElementById(id);
      const THEME_STORAGE_KEY = 'task-hud-theme-override';
      function lumOf(c) {
        if (!c) return null;
        const body = c.slice(c.indexOf('(') + 1).replace(/^\\s*[a-z][\\w-]*\\s+/i, '');
        const nums = (body.match(/[\\d.]+/g) || []).map(Number);
        if (nums.length < 3 || (nums.length >= 4 && nums[3] === 0)) return null;
        const scale = c.startsWith('color(') ? 1 : 255;
        const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
        return 0.2126 * r + 0.7152 * g + 0.722 * 0 + 0.0722 * b;
      }
      function syncTheme() {
        try {
          const ov = localStorage.getItem(THEME_STORAGE_KEY);
          if (ov === 'light' || ov === 'dark') {
            document.documentElement.dataset.hudTheme = ov;
            return;
          }
        } catch {}
        try {
          if (window.parent && window.parent !== window) {
            const pDoc = window.parent.document;
            if (pDoc) {
              for (const el of [pDoc.body, pDoc.documentElement]) {
                if (!el) continue;
                const ff = (window.parent.getComputedStyle(el).fontFamily || '').trim();
                if (ff && !/^serif$/i.test(ff)) {
                  document.documentElement.style.setProperty('--hud-font-sans', ff);
                  break;
                }
              }
              for (const el of [pDoc.body, pDoc.documentElement]) {
                if (!el) continue;
                const bg = window.parent.getComputedStyle(el).backgroundColor || '';
                const nums = (bg.match(/[\\d.]+/g) || []).map(Number);
                if (nums.length >= 3 && !(nums.length >= 4 && nums[3] === 0)) {
                  const scale = bg.startsWith('color(') ? 1 : 255;
                  const lum = (0.2126 * nums[0] + 0.7152 * nums[1] + 0.0722 * nums[2]) / scale;
                  document.documentElement.dataset.hudTheme = lum < 0.5 ? 'dark' : 'light';
                  return;
                }
              }
            }
          }
        } catch {}
        const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.documentElement.dataset.hudTheme = dark ? 'dark' : 'light';
      }
      syncTheme();

      let lastSig = '';
      let timer = null;
      let pollCount = 0;

      function parseData(docText) {
        let raw = '';
        if (docText) {
          const m = docText.match(/<script[^>]*id=["']task-hud-end-data["'][^>]*>([\\s\\S]*?)<\\/script>/i);
          raw = m && m[1] ? m[1] : '{}';
        } else {
          raw = $('task-hud-end-data')?.textContent || '{}';
        }
        try { return JSON.parse(raw.trim()); } catch { return {}; }
      }

      function render(d) {
        if (!d || typeof d !== 'object') return;
        const sig = JSON.stringify(d);
        if (sig === lastSig) return;
        lastSig = sig;
        const dur = String(d.durationText || '').trim();
        const tok = String(d.tokenText || '').trim();
        const det = String(d.tokenDetail || '').trim();
        $('val-time').textContent = dur;
        $('pill-time').classList.toggle('hidden', !dur);
        $('val-tok').textContent = tok;
        $('pill-tok').title = det;
        $('pill-tok').classList.toggle('hidden', !tok);
        $('end-bar').classList.toggle('hidden', !dur && !tok);
        if (d.status === 'done' && timer) {
          clearInterval(timer);
          timer = null;
        }
      }

      render(parseData());
      const init = parseData();
      if (init.status !== 'done') {
        timer = setInterval(async () => {
          pollCount++;
          if (pollCount > 40) { clearInterval(timer); timer = null; return; }
          try {
            if (!location.href || location.href.startsWith('about:') || location.href.startsWith('data:')) return;
            const res = await fetch(location.href, { cache: 'no-store' });
            if (!res.ok) return;
            render(parseData(await res.text()));
          } catch {}
        }, 450);
      }
    })();
  </script>
</body>
</html>
`;

export function syncEndHudFile(
  artifactDir,
  state,
  { turnFinished = false, now = Date.now(), targetFileName = '' } = {}
) {
  if (!artifactDir) return '';
  const activeTurn = state.activeTurn;
  const lastTurn = state.lastCompletedTurn;
  const fallbackIdx = activeTurn?.turnIndex || lastTurn?.turnIndex || 1;
  const fileName =
    normalizeEndHudFileName(targetFileName) ||
    normalizeEndHudFileName(activeTurn?.endHudFileName) ||
    normalizeEndHudFileName(turnFinished ? lastTurn?.endHudFileName : '') ||
    deriveEndHudFileName(activeTurn?.hudFileName || lastTurn?.hudFileName || '', fallbackIdx);
  if (!fileName) return '';

  try {
    ensureDir(artifactDir);
    const htmlPath = join(artifactDir, fileName);
    const startedAt = activeTurn?.startedAt || lastTurn?.startedAt || now;
    const elapsedMs = turnFinished
      ? (typeof lastTurn?.elapsedMs === 'number' && Number.isFinite(lastTurn.elapsedMs)
          ? Math.max(0, lastTurn.elapsedMs)
          : Math.max(0, now - startedAt))
      : Math.max(0, now - startedAt);
    const compactTranscript = resolveCompactPath(state.transcriptPath);
    const targetUserStep = activeTurn?.userStepIndex ?? lastTurn?.userStepIndex ?? null;
    const txTokens = computeTurnTokensFromTranscript(compactTranscript, targetUserStep);
    const savedTokens = activeTurn?.tokens || lastTurn?.tokens || createEmptyTokens();
    const resolvedTokens = (txTokens.total || 0) >= (savedTokens.total || 0) ? txTokens : savedTokens;

    const payload = {
      status: turnFinished ? 'done' : 'finalizing',
      durationText: formatDuration(elapsedMs),
      tokenText: formatTokenText(resolvedTokens),
      tokenDetail: formatTokenDetail(resolvedTokens),
    };
    const json = serializeJsonForHtmlScript(payload);
    const nextHtml = HUD_END_HTML_TEMPLATE.replace(
      HUD_END_DATA_SCRIPT_RE,
      (_, open, _body, close) => `${open}\n${json}\n  ${close}`
    );
    const prevHtml = existsSync(htmlPath) ? readFileSync(htmlPath, 'utf-8') : '';
    if (nextHtml !== prevHtml) {
      writeTextAtomic(htmlPath, nextHtml);
    }
    return fileName;
  } catch {
    return '';
  }
}

export function parseMarkdownTaskHud(content, now = Date.now()) {
  const raw = String(content || '');
  if (!raw.includes('📋') && !raw.includes('✅') && !raw.includes('🔄')) return null;

  const lines = raw.split(/\r?\n/);
  let taskTitle = '';
  let summary = '';
  const tasks = [];
  let inCard = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/^\s*>\s?/, '').trim();
    if (!line) {
      if (inCard && tasks.length > 0) break;
      continue;
    }

    const headerMatch = line.match(/^(?:\*\*|#+\s*)?📋\s*(.+?)(?:\s*`?\(?(\d+)\s*\/\s*(\d+)\)?`?)?(?:\*\*)?$/);
    if (headerMatch) {
      inCard = true;
      taskTitle = headerMatch[1]
        .replace(/\*\*/g, '')
        .replace(/`?\(?\d+\s*\/\s*\d+\)?`?$/, '')
        .replace(/[·•].*$/, '')
        .trim();
      continue;
    }

    if (inCard && line.startsWith('💬')) {
      summary = line.replace(/^💬\s*/, '').replace(/^\*+|\*+$/g, '').trim();
      continue;
    }

    const itemMatch = line.match(/^[-*]\s*(✅|☑|✔|🔄|◉|⏳|◌|⬜|❌|✖)\s*(.+)$/);
    if (itemMatch) {
      inCard = true;
      const icon = itemMatch[1];
      let rest = itemMatch[2].trim();
      let itemSummary = '';

      const splitMatch = rest.match(/^(.*?)\s*(?:—|--|－|·)\s*(.+)$/);
      if (splitMatch) {
        rest = splitMatch[1].trim();
        itemSummary = splitMatch[2].replace(/^\*+|\*+$/g, '').trim();
      }

      const cleanTitle = rest.replace(/^\*\*|\*\*$/g, '').replace(/^~~|~~$/g, '').trim();
      let status = 'pending';
      if (icon === '✅' || icon === '☑' || icon === '✔') status = 'completed';
      else if (icon === '🔄' || icon === '◉') status = 'in_progress';
      else if (icon === '❌' || icon === '✖') status = 'failed';

      if (itemSummary && (status === 'in_progress' || !summary)) {
        summary = itemSummary;
      }

      if (cleanTitle) {
        tasks.push({
          id: String(tasks.length + 1),
          title: cleanTitle,
          status,
          updatedAt: now,
        });
      }
    }
  }

  if (tasks.length === 0) return null;
  return {
    taskTitle,
    summary,
    tasks: normalizeAndAdvanceTasks(tasks, { now }),
  };
}

export function loadConversationState(conversationId, dataDir = resolveDataDir()) {
  const safeId = sanitizeConversationId(conversationId);
  if (!safeId) return createEmptyConversationState('');
  const saved = readJsonSafe(conversationStatePath(safeId, dataDir), null);
  if (!saved || typeof saved !== 'object') {
    return createEmptyConversationState(safeId);
  }
  const rawTasks = Array.isArray(saved.tasks) ? saved.tasks : [];
  const turnFinished = !saved.activeTurn && !isTurnInterrupted(saved.lastCompletedTurn);
  return {
    ...createEmptyConversationState(safeId),
    ...saved,
    conversationId: safeId,
    tasks: normalizeAndAdvanceTasks(rawTasks, { turnFinished }),
    turns: Array.isArray(saved.turns) ? saved.turns : [],
  };
}

export function saveConversationState(state, dataDir = resolveDataDir()) {
  const safeId = sanitizeConversationId(state?.conversationId);
  if (!safeId) return;
  const turnFinished = !state.activeTurn && !isTurnInterrupted(state.lastCompletedTurn);
  if (Array.isArray(state.tasks) && state.tasks.length > 0) {
    state.tasks = normalizeAndAdvanceTasks(state.tasks, { turnFinished });
  }
  state.updatedAt = Date.now();
  writeJsonAtomic(conversationStatePath(safeId, dataDir), state);
}

export function recordActiveConversation(conversationId, extra = {}, dataDir = resolveDataDir()) {
  const safeId = sanitizeConversationId(conversationId);
  if (!safeId) return;
  writeJsonAtomic(activeSessionPath(dataDir), {
    conversationId: safeId,
    updatedAt: Date.now(),
    ...extra,
  });
}

export function resolveActiveConversationId(explicitId, dataDir = resolveDataDir()) {
  const direct = sanitizeConversationId(explicitId);
  if (direct) return direct;
  const active = readJsonSafe(activeSessionPath(dataDir), null);
  return sanitizeConversationId(active?.conversationId);
}

export function formatDuration(ms) {
  const totalSec = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  return `${mins}m ${secs}s`;
}

export function summarizeToolStats(stats) {
  if (!stats) return '';
  const parts = [];
  if (stats.commands > 0) parts.push(`运行 ${stats.commands} 条命令`);
  if (stats.searches > 0) parts.push(`检索 ${stats.searches} 次`);
  if (stats.fileReads > 0) parts.push(`读取 ${stats.fileReads} 个文件`);
  if (stats.fileEdits > 0) parts.push(`修改 ${stats.fileEdits} 个文件`);
  if (stats.subagents > 0) parts.push(`调度 ${stats.subagents} 个子代理`);
  if (stats.otherTools > 0 && parts.length === 0) parts.push(`调用 ${stats.otherTools} 次工具`);
  if (stats.failures > 0) parts.push(`失败 ${stats.failures} 次`);
  return parts.join('，');
}

export function isHudInternalTool(toolName, args = {}) {
  const n = String(toolName || '').toLowerCase();
  if (
    n.includes('task_hud_init') ||
    n.includes('task_hud_check') ||
    n.includes('task_hud_set_tasks') ||
    n.includes('task_hud_update_task')
  ) {
    return true;
  }
  const filePath = String(args?.Path || args?.path || args?.TargetFile || '').toLowerCase();
  if (/task-hud(?:-t\d+|-\d+|-end)?\.html$/.test(filePath)) {
    return true;
  }
  if (n === 'call_mcp_tool' && args && typeof args === 'object') {
    const subName = String(args.ToolName || args.toolName || '').toLowerCase();
    const serverName = String(args.ServerName || args.serverName || '').toLowerCase();
    if (
      subName.includes('task_hud_init') ||
      subName.includes('task_hud_check') ||
      subName.includes('task_hud_set_tasks') ||
      subName.includes('task_hud_update_task') ||
      serverName.includes('task-hud')
    ) {
      return true;
    }
  }
  return false;
}

export function classifyTool(toolName, args = {}) {
  const name = String(toolName || '').toLowerCase();
  const safeArgs = args && typeof args === 'object' ? args : {};
  const filePath = safeArgs.Path || safeArgs.path || safeArgs.TargetFile || '';
  const fileName = filePath ? basename(String(filePath)) : '';

  if (name === 'run_command') {
    const summary = safeArgs.toolSummary || safeArgs.CommandLine || '';
    const short = String(summary).replace(/\s+/g, ' ').trim().slice(0, 42);
    return { category: 'commands', label: short ? `运行命令: ${short}` : '运行命令' };
  }
  if (name === 'read_file' || name === 'view_file') {
    return { category: 'fileReads', label: fileName ? `读取文件 ${fileName}` : '读取文件' };
  }
  if (name === 'write_file' || name === 'edit_file' || name === 'replace_file_content') {
    return { category: 'fileEdits', label: fileName ? `编辑文件 ${fileName}` : '编辑文件' };
  }
  if (name === 'search_web' || name === 'grep_search' || name === 'find_by_name' || name === 'list_dir') {
    const q = safeArgs.query || safeArgs.Query || '';
    const short = String(q).replace(/\s+/g, ' ').trim().slice(0, 32);
    return { category: 'searches', label: short ? `检索: ${short}` : '检索信息' };
  }
  if (name === 'invoke_subagent' || name === 'swarm') {
    return { category: 'subagents', label: '调度子代理' };
  }
  if (name === 'exit_plan_mode') {
    return { category: 'otherTools', label: '完成规划并移交执行' };
  }
  return { category: 'otherTools', label: name ? `执行 ${name}` : '执行工具' };
}
