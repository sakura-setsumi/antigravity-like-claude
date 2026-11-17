import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const PLUGIN_NAME = 'task-hud';
export const SAFE_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;
export const TURN_HUD_FILE_RE = /^task-hud(?:-t(\d+))?\.html$/i;

export function normalizeHudFileName(fileOrPath) {
  if (!fileOrPath) return '';
  const base = basename(String(fileOrPath).trim()).toLowerCase();
  return TURN_HUD_FILE_RE.test(base) ? base : '';
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
    const cmd = String(args.CommandLine || '').trim();
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
    const content = String(args.Replacement || args.Content || '');
    const m = content.match(/<script[^>]*id=["']task-hud-(?:tasks|data)["'][^>]*>([\s\S]*?)<\/script>/i);
    const jsonText = m ? m[1] : content;
    try {
      const parsed = JSON.parse(jsonText.trim());
      if (Array.isArray(parsed.logs) && parsed.logs.length > 0) {
        return String(parsed.logs[parsed.logs.length - 1] || '').trim();
      }
      if (parsed.summary) return String(parsed.summary).trim();
    } catch {
      // ignore
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
        let logText = hudLog || cleanContent;

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

export function parseArtifactHudHtml(artifactDir, now = Date.now(), preferredFileName = '') {
  if (!artifactDir) return null;
  const normalizedPref = normalizeHudFileName(preferredFileName);
  const candidates = [];
  if (normalizedPref) {
    candidates.push(normalizedPref);
  } else {
    return null;
  }

  for (const name of candidates) {
    const htmlPath = join(artifactDir, name);
    if (!existsSync(htmlPath)) continue;
    try {
      const html = readFileSync(htmlPath, 'utf-8');
      const m = html.match(/<script[^>]*id=["']task-hud-(?:tasks|data)["'][^>]*>([\s\S]*?)<\/script>/i);
      if (!m || !m[1]) continue;
      const obj = JSON.parse(m[1].trim());
      if (!obj || !Array.isArray(obj.tasks) || obj.tasks.length === 0) continue;
      const logs = Array.isArray(obj.logs)
        ? obj.logs.map((s) => String(s || '').trim()).filter(Boolean)
        : obj.summary
        ? [String(obj.summary).trim()]
        : [];
      const latestSummary = logs.length > 0 ? logs[logs.length - 1] : String(obj.summary || '').trim();
      return {
        fileName: name,
        taskTitle: String(obj.taskTitle || '').trim(),
        summary: latestSummary,
        logs,
        status: obj.status || 'running',
        tasks: normalizeAndAdvanceTasks(obj.tasks, { turnFinished: obj.status === 'done', now }),
      };
    } catch {
      // ignore parse error
    }
  }
  return null;
}

const HUD_HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: transparent;
      color: var(--foreground, #1e293b);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
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
    .hud-wrap { padding: 2px 0 4px; }
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
      color: var(--muted-foreground, #64748b);
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
      color: var(--muted-foreground, #64748b);
      cursor: pointer;
      user-select: none;
    }
    .hud-fold > summary::-webkit-details-marker { display: none; }
    .hud-fold > summary:hover { color: var(--foreground, #1e293b); }
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
      border-left: 1.5px solid var(--card-border, rgba(148, 163, 184, 0.28));
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
      color: var(--foreground, #1e293b);
      font-size: 14px;
      line-height: 1.65;
      word-break: break-word;
    }
    .hud-code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12.5px;
      padding: 1.5px 5px;
      border-radius: 5px;
      background: var(--secondary, rgba(148, 163, 184, 0.18));
      color: var(--code-foreground, var(--foreground, #0f172a));
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
    .hud-muted { color: var(--muted-foreground, #64748b); }
    .hud-timer-val {
      font-weight: 600;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-variant-numeric: tabular-nums;
      font-size: 13px;
      color: var(--foreground, #0f172a);
    }
    .hud-stats {
      color: var(--muted-foreground, #64748b);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }
    .hud-card {
      border-radius: 12px;
      border: 1px solid var(--card-border, rgba(148, 163, 184, 0.28));
      background: var(--card, rgba(255, 255, 255, 0.78));
      padding: 12px 14px;
      font-size: 12.5px;
      line-height: 1.5;
    }
    .hud-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .hud-item {
      display: flex;
      align-items: center;
      gap: 8px;
      line-height: 1.4;
    }
    .hud-item-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      color: var(--muted-foreground, #64748b);
    }
    .hud-item-done { color: var(--muted-foreground, #64748b); }
    .hud-item-active { color: var(--foreground, #0f172a); }
    .hud-done-fold {
      margin: 0;
      padding: 0;
    }
    .hud-done-summary {
      list-style: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 6px 10px;
      border-radius: 9px;
      border: 1px solid var(--card-border, rgba(148, 163, 184, 0.24));
      background: var(--card, rgba(255, 255, 255, 0.55));
      font-size: 12.5px;
      line-height: 1.4;
      color: var(--muted-foreground, #64748b);
      cursor: pointer;
      user-select: none;
    }
    .hud-done-summary::-webkit-details-marker { display: none; }
    .hud-done-summary:hover { color: var(--foreground, #1e293b); }
    .hud-done-left {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
    }
    .hud-done-right {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
      font-size: 12px;
    }
    .hud-done-fold[open] > .hud-done-summary .hud-fold-chevron {
      transform: rotate(90deg);
    }
    .hud-done-body {
      padding-top: 10px;
    }
    .hidden { display: none !important; }
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
  "statsText": "",
  "steps": []
}
  </script>

  <div id="hud-root" class="hud-wrap hidden">
    <details id="hud-done-fold" class="hud-done-fold hidden">
      <summary class="hud-done-summary">
        <span class="hud-done-left">
          <span id="hud-done-dot" class="hud-dot dot-done"></span>
          <span id="hud-done-text"></span>
        </span>
        <span class="hud-done-right">
          <span id="hud-done-stats"></span>
          <span class="hud-fold-chevron">›</span>
        </span>
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
          </div>
          <div id="hud-stats" class="hud-stats"></div>
        </div>

        <div class="hud-card">
          <ul id="hud-list" class="hud-list"></ul>
        </div>
      </div>
    </div>
  </div>

  <script>
    (() => {
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

      function iconSvg(status) {
        if (status === 'completed') {
          return '<svg viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="8" r="6.5" fill="currentColor" opacity="0.82"/><path d="M5.2 8.2l2 2 3.8-4.2" fill="none" stroke="var(--card, #fff)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        }
        if (status === 'in_progress') {
          return '<svg viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4" opacity="0.72"/></svg>';
        }
        if (status === 'failed') {
          return '<svg viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="8" r="6.5" fill="#ef4444"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>';
        }
        return '<svg viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2.4 2.4" opacity="0.58"/></svg>';
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
        $('hud-dot').className = \`hud-dot \${isRunning ? 'dot-running' : 'dot-done'}\`;
        if (isRunning && currentData.startedAt) {
          $('hud-timer-label').textContent = '本轮对话已用时';
          $('hud-timer-val').textContent = formatDuration(Date.now() - currentData.startedAt);
        } else {
          $('hud-timer-label').textContent = '本轮对话用时';
          const ms = currentData.elapsedMs || (currentData.startedAt ? Date.now() - currentData.startedAt : 0);
          $('hud-timer-val').textContent = formatDuration(ms);
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
        bc = new BroadcastChannel('task_hud_live_slot');
        bc.onmessage = (ev) => {
          const msg = ev?.data;
          if (!msg || msg.type !== 'CLAIM' || msg.instanceId === myInstanceId) return;
          if (isCompletedFrozen || isSuperseded || currentData?.status === 'done') return;
          if ((msg.mountedAt || 0) >= myMountedAt) {
            freezeAsSuperseded();
          }
        };
      } catch {}

      function collapseSelf() {
        if (isCollapsed) return;
        isCollapsed = true;
        if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (doneFreezeTimer) { clearTimeout(doneFreezeTimer); doneFreezeTimer = null; }
        document.documentElement.style.cssText = 'margin:0!important;padding:0!important;height:0!important;min-height:0!important;max-height:0!important;overflow:hidden!important;display:none!important';
        if (document.body) {
          document.body.style.cssText = 'margin:0!important;padding:0!important;height:0!important;min-height:0!important;max-height:0!important;overflow:hidden!important;display:none!important';
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

        const rawTasks = Array.isArray(currentData?.tasks) ? currentData.tasks : [];
        const tasks = normalizeTasks(rawTasks, false);
        const doneCount = tasks.filter((t) => t.status === 'completed').length;
        const ms = currentData?.startedAt && currentData.startedAt > 1000000000000
          ? Math.max(0, Date.now() - currentData.startedAt)
          : Number(currentData?.elapsedMs || 0);
        const durationStr = formatDuration(ms);
        const taskPart = tasks.length > 0 ? \`已转入后续追问 · 已完成 \${doneCount}/\${tasks.length} 项\` : '已转入后续追问';

        if (dotEl) dotEl.className = 'hud-dot dot-superseded';
        $('hud-done-text').textContent = ms > 0 ? \`中断前用时 \${durationStr} · \${taskPart}\` : taskPart;
        $('hud-done-stats').textContent = currentData?.statsText || '';
        doneBodyEl.appendChild(liveBodyEl);
        rootEl.classList.remove('hidden');
        doneFoldEl.classList.remove('hidden');
        doneFoldEl.open = false;
      }

      function render(data) {
        if (!data || isCollapsed || isSuperseded) return;
        if (data.collapsed) {
          collapseSelf();
          return;
        }
        const sig = JSON.stringify({
          status: data.status,
          tasks: data.tasks,
          logs: data.logs,
          steps: data.steps,
          statsText: data.statsText,
          elapsedMs: data.elapsedMs,
        });
        if (sig === lastSig) return;
        lastSig = sig;

        currentData = data;
        const rawTasks = Array.isArray(data.tasks) ? data.tasks : [];
        const allTasksCompleted = rawTasks.length > 0 && rawTasks.every((t) => t.status === 'completed');
        const isDone = Boolean(data.status === 'done' || allTasksCompleted);
        currentData.status = isDone ? 'done' : 'running';

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
          $('hud-list').innerHTML = tasks
            .map((t) => {
              const textCls = t.status === 'completed' ? 'hud-item-done' : 'hud-item-active';
              return \`<li class="hud-item"><span class="hud-item-icon">\${iconSvg(t.status)}</span><span class="\${textCls}">\${esc(t.title)}</span></li>\`;
            })
            .join('');
        } else {
          panelEl.classList.add('hidden');
        }

        if (timelineHtml || tasks.length > 0) {
          rootEl.classList.remove('hidden');
          if (!isDone) {
            try {
              if (bc) bc.postMessage({ type: 'CLAIM', instanceId: myInstanceId, mountedAt: myMountedAt });
            } catch {}
          }
        } else if (data.status === 'running' && data.startedAt) {
          rootEl.classList.remove('hidden');
          panelEl.classList.remove('hidden');
          $('hud-list').innerHTML = '<li class="hud-item"><span class="hud-item-icon">' + iconSvg('in_progress') + '</span><span class="hud-item-active">正在分析并拆解执行步骤…</span></li>';
          if (!isDone) {
            try {
              if (bc) bc.postMessage({ type: 'CLAIM', instanceId: myInstanceId, mountedAt: myMountedAt });
            } catch {}
          }
        } else {
          rootEl.classList.add('hidden');
          return;
        }

        if (isDone) {
          isCompletedFrozen = true;
          const dotEl = $('hud-done-dot');
          if (dotEl) dotEl.className = 'hud-dot dot-done';
          const doneCount = tasks.filter((t) => t.status === 'completed').length;
          let ms = Number(data.elapsedMs || 0);
          if (ms <= 0 && data.startedAt && data.startedAt > 1000000000000) {
            ms = Math.max(0, Date.now() - data.startedAt);
          }
          const durationStr = formatDuration(ms);
          const taskPart = tasks.length > 0 ? \`已完成 \${doneCount}/\${tasks.length} 项任务\` : '已完成';
          $('hud-done-text').textContent = \`本轮用时 \${durationStr} · \${taskPart}\`;
          $('hud-done-stats').textContent = data.statsText || '';
          doneBodyEl.appendChild(liveBodyEl);
          doneFoldEl.classList.remove('hidden');
          doneFoldEl.open = false;
          if (!doneFreezeTimer && Number(data.elapsedMs || 0) > 0) {
            doneFreezeTimer = setTimeout(() => {
              if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
              if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
            }, 2500);
          }
        } else {
          if (doneFreezeTimer) { clearTimeout(doneFreezeTimer); doneFreezeTimer = null; }
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

      function parseMerged(docText) {
        try {
          if (docText) {
            const tm = docText.match(/<script[^>]*id=["']task-hud-(?:tasks|data)["'][^>]*>([\\s\\S]*?)<\\/script>/i);
            const rm = docText.match(/<script[^>]*id=["']task-hud-runtime["'][^>]*>([\\s\\S]*?)<\\/script>/i);
            const tObj = tm && tm[1] ? JSON.parse(tm[1]) : {};
            const rObj = rm && rm[1] ? JSON.parse(rm[1]) : {};
            return { ...rObj, ...tObj, status: tObj.status || rObj.status || 'running' };
          }
          const tRaw = ($('task-hud-tasks') || $('task-hud-data'))?.textContent || '{}';
          const rRaw = $('task-hud-runtime')?.textContent || '{}';
          const tObj = JSON.parse(tRaw);
          const rObj = JSON.parse(rRaw);
          return { ...rObj, ...tObj, status: tObj.status || rObj.status || 'running' };
        } catch {
          return null;
        }
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
      clockTimer = setInterval(renderTimer, 1000);
      pollTimer = setInterval(pollSelf, 600);
    })();
  </script>
</body>
</html>
`;

const HUD_TASKS_SCRIPT_RE = /(<script[^>]*id=["']task-hud-(?:tasks|data)["'][^>]*>)([\s\S]*?)(<\/script>)/i;
const HUD_RUNTIME_SCRIPT_RE = /(<script[^>]*id=["']task-hud-runtime["'][^>]*>)([\s\S]*?)(<\/script>)/i;
const HUD_TEMPLATE_MARKER = 'freezeAsSuperseded';

function parseHudTasksJson(html) {
  const m = String(html || '').match(HUD_TASKS_SCRIPT_RE);
  if (!m || !m[2]) return null;
  try {
    return JSON.parse(m[2].trim());
  } catch {
    return null;
  }
}

function hasNonEmptyHudTasks(html) {
  const obj = parseHudTasksJson(html);
  return Boolean(obj && Array.isArray(obj.tasks) && obj.tasks.length > 0);
}

function upgradeTemplatePreservingData(filePath) {
  if (!existsSync(filePath)) {
    writeFileSync(filePath, HUD_HTML_TEMPLATE, { encoding: 'utf-8' });
    return;
  }
  const origHtml = readFileSync(filePath, 'utf-8');
  if (origHtml.includes(HUD_TEMPLATE_MARKER) && origHtml.includes('isCompletedFrozen')) {
    return;
  }
  let nextHtml = HUD_HTML_TEMPLATE;
  const oldTasks = origHtml.match(HUD_TASKS_SCRIPT_RE);
  if (oldTasks && oldTasks[2]) {
    nextHtml = nextHtml.replace(HUD_TASKS_SCRIPT_RE, (_, open, _body, close) => `${open}${oldTasks[2]}${close}`);
  }
  const oldRuntime = origHtml.match(HUD_RUNTIME_SCRIPT_RE);
  if (oldRuntime && oldRuntime[2]) {
    nextHtml = nextHtml.replace(HUD_RUNTIME_SCRIPT_RE, (_, open, _body, close) => `${open}${oldRuntime[2]}${close}`);
  }
  if (nextHtml !== origHtml) {
    writeFileSync(filePath, nextHtml, { encoding: 'utf-8' });
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
        if (hasNonEmptyHudTasks(html) && idx > maxUsed) {
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
        writeFileSync(htmlPath, HUD_HTML_TEMPLATE, { encoding: 'utf-8' });
        continue;
      }
      const origHtml = readFileSync(htmlPath, 'utf-8');
      // 严禁清空已写入过任务的历史轮次或历史兼容文件，只对其执行无损外壳升级
      if (hasNonEmptyHudTasks(origHtml)) {
        upgradeTemplatePreservingData(htmlPath);
        continue;
      }
      if (origHtml !== HUD_HTML_TEMPLATE) {
        writeFileSync(htmlPath, HUD_HTML_TEMPLATE, { encoding: 'utf-8' });
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

/**
 * 将本轮实时计时（startedAt / elapsedMs）、工具统计、工具链 steps 与收尾对号状态直接写回对应轮次 HTML 文件的 #task-hud-runtime：
 * 严格只更新本轮显式绑定的目标槽位（targetFileName / activeTurn.hudFileName），绝不覆写历史轮次文件。
 */
export function syncArtifactHudFile(artifactDir, state, { turnFinished = false, now = Date.now(), isPreToolUse = false, targetFileName = '' } = {}) {
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

  const tasksRegex = HUD_TASKS_SCRIPT_RE;
  const runtimeRegex = HUD_RUNTIME_SCRIPT_RE;

  try {
    const origHtml = readFileSync(htmlPath, 'utf-8');
    let html = origHtml;

    const m = html.match(tasksRegex);
    let parsedTasks = [];
    let parsedLogs = [];
    if (m && m[2]) {
      try {
        const tJson = JSON.parse(m[2].trim());
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
        if (Array.isArray(tJson.tasks) && tJson.tasks.length > 0) {
          parsedTasks = normalizeAndAdvanceTasks(tJson.tasks, { turnFinished, now });
          state.tasks = parsedTasks;
          const hadUnfinished = tJson.tasks.some((t, idx) => t.status !== parsedTasks[idx]?.status);
          if (turnFinished && hadUnfinished) {
            const fixedObj = {
              taskTitle: state.taskTitle || '任务进度',
              logs: parsedLogs.length > 0 ? parsedLogs : state.summary ? [state.summary] : [],
              tasks: parsedTasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
            };
            html = html.replace(
              tasksRegex,
              (_, open, _body, close) => `${open}\n${JSON.stringify(fixedObj, null, 2)}\n  ${close}`
            );
          }
        }
      } catch {
        // ignore JSON parse error
      }
    }

    const compactTranscript = resolveCompactPath(state.transcriptPath);
    const steps = buildTurnStepsFromTranscript(compactTranscript, {
      includeLatestTools: Boolean(turnFinished && !isPreToolUse),
    });

    const activeTurn = state.activeTurn;
    const lastTurn = state.lastCompletedTurn;
    const isDone = Boolean(turnFinished || !activeTurn);
    const turnIndex = activeTurn?.turnIndex || lastTurn?.turnIndex || 1;
    const startedAt = activeTurn?.startedAt || lastTurn?.startedAt || now;
    const elapsedMs = isDone
      ? (lastTurn?.elapsedMs || Math.max(0, now - startedAt))
      : 0;
    const statsText = summarizeToolStats(activeTurn?.stats || lastTurn?.stats) || '';

    const runtimeObj = {
      status: isDone ? 'done' : 'running',
      turnIndex,
      startedAt,
      elapsedMs,
      statsText,
      steps,
    };

    if (runtimeRegex.test(html)) {
      html = html.replace(
        runtimeRegex,
        (_, open, _body, close) => `${open}\n${JSON.stringify(runtimeObj, null, 2)}\n  ${close}`
      );
    }

    if (html !== origHtml) {
      writeFileSync(htmlPath, html, { encoding: 'utf-8' });
    }
    return true;
  } catch {
    return false;
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
  return {
    ...createEmptyConversationState(safeId),
    ...saved,
    conversationId: safeId,
    tasks: normalizeAndAdvanceTasks(rawTasks, { turnFinished: !saved.activeTurn }),
    turns: Array.isArray(saved.turns) ? saved.turns : [],
  };
}

export function saveConversationState(state, dataDir = resolveDataDir()) {
  const safeId = sanitizeConversationId(state?.conversationId);
  if (!safeId) return;
  if (Array.isArray(state.tasks) && state.tasks.length > 0) {
    state.tasks = normalizeAndAdvanceTasks(state.tasks, { turnFinished: !state.activeTurn });
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
  if (n.includes('task_hud_set_tasks') || n.includes('task_hud_update_task')) {
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
  return { category: 'otherTools', label: name ? `执行 ${name}` : '执行工具' };
}
