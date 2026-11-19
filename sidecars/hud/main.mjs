import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  classifyTool,
  createEmptyStats,
  isHudInternalTool,
  isTurnInterrupted,
  loadConversationState,
  loadSettings,
  normalizeAndAdvanceTasks,
  normalizeHudFileName,
  parseArtifactHudHtml,
  parseMarkdownTaskHud,
  resolveActiveConversationId,
  resolveDataDir,
  sanitizeConversationId,
  saveSettings,
} from '../../scripts/state-store.mjs';
import { createCancelWatcher } from '../../scripts/cancel-watcher.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadSidecarSdk() {
  try {
    return await import('sidecar_sdk');
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    try {
      const resolved = createRequire(import.meta.url).resolve('sidecar_sdk');
      return await import(pathToFileURL(resolved).href);
    } catch {
      const fallback = join(homedir(), '.gemini', 'config', 'node_modules', 'sidecar_sdk', 'index.mjs');
      return await import(pathToFileURL(fallback).href);
    }
  }
}

const { SidecarApp, Response } = await loadSidecarSdk();

function findAppDataDirs() {
  const execData = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (execData) {
    for (let d = execData; d !== dirname(d); d = dirname(d)) {
      if (basename(d) !== 'sidecar_data') continue;
      const appData = dirname(d);
      return existsSync(join(appData, 'brain')) ? [appData] : [];
    }
  }
  const root = join(homedir(), '.gemini');
  try {
    return readdirSync(root)
      .map((name) => join(root, name))
      .filter((dir) => existsSync(join(dir, 'brain')));
  } catch {
    return [];
  }
}

function findTranscriptPath(convId, preferredPath = '') {
  if (preferredPath) {
    if (basename(preferredPath) === 'transcript_full.jsonl') {
      const compactPath = join(dirname(preferredPath), 'transcript.jsonl');
      if (existsSync(compactPath)) return compactPath;
    }
    if (existsSync(preferredPath)) return preferredPath;
  }
  for (const appData of findAppDataDirs()) {
    const p = join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
    if (existsSync(p)) return p;
  }
  return '';
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

function normalizeToolArgs(rawArgs) {
  if (!rawArgs || typeof rawArgs !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(rawArgs)) {
    out[k] = unwrapArgString(v);
  }
  return out;
}

function extractCleanUserRequest(content) {
  const s = String(content || '');
  const m = s.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  const body = m ? m[1] : s;
  return body.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function extractBriefText(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const firstLine = s
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('```') && !l.startsWith('#') && !l.startsWith('>'));
  const target = firstLine || s.replace(/\s+/g, ' ').trim();
  return target.length > 140 ? target.slice(0, 139) + '…' : target;
}

const transcriptCache = new Map();

function parseTranscript(transcriptPath) {
  if (!transcriptPath) return null;
  let stat;
  try {
    stat = statSync(transcriptPath);
  } catch {
    return null;
  }
  const cacheKey = `${stat.mtimeMs}:${stat.size}`;
  const cached = transcriptCache.get(transcriptPath);
  if (cached && cached.key === cacheKey) return cached.data;

  let lines;
  try {
    lines = readFileSync(transcriptPath, 'utf-8').split('\n');
  } catch {
    return null;
  }

  const turns = [];
  let current = null;
  let latestNote = '';
  let latestHud = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let step;
    try {
      step = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const createdMs = Date.parse(step.created_at || '');
    const ts = Number.isFinite(createdMs) ? createdMs : null;

    if (step.type === 'USER_INPUT') {
      if (current) {
        current.isFinished = true;
        if (!current.endedAt) current.endedAt = ts || current.startedAt;
        turns.push(current);
      }
      current = {
        turnIndex: turns.length + 1,
        userStepIndex: Number(step.step_index),
        userInput: extractCleanUserRequest(step.content),
        hudFileName: '',
        startedAt: ts,
        endedAt: ts,
        isFinished: false,
        stats: createEmptyStats(),
        pendingTools: [],
        lastPlannerAt: null,
        lastStepAt: ts,
      };
      continue;
    }

    if (!current) continue;
    if (ts) current.lastStepAt = ts;

    if (step.type === 'PLANNER_RESPONSE') {
      current.lastPlannerAt = ts || current.lastPlannerAt;
      const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];

      if (typeof step.content === 'string' && step.content.trim()) {
        const fileMatches = [...step.content.matchAll(/task-hud(?:-t\d+|-\d+|-end)?\.html/gi)];
        if (fileMatches.length > 0) {
          const hit = normalizeHudFileName(fileMatches[fileMatches.length - 1][0]);
          if (hit) current.hudFileName = hit;
        }
        const parsedHud = parseMarkdownTaskHud(step.content, ts || Date.now());
        if (parsedHud) {
          latestHud = parsedHud;
          if (parsedHud.summary) latestNote = parsedHud.summary;
        }
        const note = extractBriefText(step.content);
        if (note) latestNote = note;
      } else if (typeof step.thinking === 'string' && step.thinking.trim()) {
        const note = extractBriefText(step.thinking);
        if (note) latestNote = note;
      }

      if (calls.length > 0) {
        const pending = [];
        for (const tc of calls) {
          const name = String(tc?.name || '');
          const args = normalizeToolArgs(tc?.args);
          if (isHudInternalTool(name, args)) {
            const hit = normalizeHudFileName(args.Path || args.path || args.TargetFile || '');
            if (hit) current.hudFileName = hit;
            continue;
          }
          const info = classifyTool(name, args);
          current.stats[info.category] = (current.stats[info.category] || 0) + 1;
          current.stats.totalTools += 1;
          pending.push({
            name,
            category: info.category,
            label: info.label,
            startedAt: ts || Date.now(),
          });
        }
        current.pendingTools = pending;
        current.isFinished = false;
      } else {
        current.pendingTools = [];
        if (step.status === 'DONE') {
          current.isFinished = true;
          current.endedAt = ts || current.lastStepAt;
        }
      }
    } else if (step.type === 'GENERIC') {
      if (current.pendingTools.length > 0) {
        current.pendingTools.shift();
      }
      if (step.status && step.status !== 'DONE') {
        current.endedAt = ts;
      } else if (ts) {
        current.endedAt = ts;
      }
    }
  }

  if (current) {
    turns.push(current);
  }

  const result = { turns, latestNote, latestHud };
  transcriptCache.set(transcriptPath, { key: cacheKey, data: result });
  if (transcriptCache.size > 30) {
    const firstKey = transcriptCache.keys().next().value;
    transcriptCache.delete(firstKey);
  }
  return result;
}

function mergeHudSnapshot(convId, dataDir) {
  const state = loadConversationState(convId, dataDir);
  const settings = loadSettings(dataDir);
  const transcriptPath = findTranscriptPath(convId, state.transcriptPath);
  const transcript = parseTranscript(transcriptPath);
  const now = Date.now();

  const hookTurns = Array.isArray(state.turns) ? state.turns : [];
  const transcriptTurns = Array.isArray(transcript?.turns) ? transcript.turns : [];

  const mergedByStep = new Map();
  const orderedTurns = [];

  for (const ht of hookTurns) {
    const key = ht.userStepIndex !== null && ht.userStepIndex !== undefined ? `step:${ht.userStepIndex}` : `prompt:${ht.userInput}:${Math.floor((ht.startedAt || 0) / 180000)}`;
    if (mergedByStep.has(key)) {
      const existing = mergedByStep.get(key);
      const startedAt = Math.min(existing.startedAt || ht.startedAt, ht.startedAt || existing.startedAt);
      const endedAt = Math.max(existing.endedAt || 0, ht.endedAt || 0);
      existing.startedAt = startedAt;
      existing.endedAt = endedAt;
      existing.elapsedMs = Math.max(0, endedAt - startedAt);
      continue;
    }
    const copy = { ...ht };
    mergedByStep.set(key, copy);
    orderedTurns.push(copy);
  }

  for (const tt of transcriptTurns) {
    if (!tt.isFinished) continue;
    const key = `step:${tt.userStepIndex}`;
    if (mergedByStep.has(key)) continue;
    const dupByTime = orderedTurns.some(
      (existing) => existing.startedAt && tt.startedAt && Math.abs(existing.startedAt - tt.startedAt) < 15000,
    );
    if (dupByTime) continue;
    orderedTurns.push({
      turnIndex: tt.turnIndex,
      userStepIndex: tt.userStepIndex,
      userInput: tt.userInput,
      hudFileName: tt.hudFileName || '',
      startedAt: tt.startedAt,
      endedAt: tt.endedAt || tt.startedAt,
      elapsedMs: Math.max(0, (tt.endedAt || tt.startedAt || 0) - (tt.startedAt || 0)),
      terminationReason: 'NO_TOOL_CALL',
      stats: tt.stats,
    });
  }

  orderedTurns.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  const numberedTurns = orderedTurns.map((t, idx) => ({ ...t, turnIndex: idx + 1 }));

  let activeTurn = state.activeTurn ? { ...state.activeTurn } : null;
  const latestTranscriptTurn = transcriptTurns[transcriptTurns.length - 1];
  const latestAlreadySettled = Boolean(
    latestTranscriptTurn &&
      numberedTurns.some(
        (t) =>
          (t.userStepIndex !== null &&
            t.userStepIndex !== undefined &&
            t.userStepIndex === latestTranscriptTurn.userStepIndex) ||
          (t.startedAt &&
            latestTranscriptTurn.startedAt &&
            Math.abs(t.startedAt - latestTranscriptTurn.startedAt) < 15000)
      )
  );

  if (!activeTurn && !latestAlreadySettled && latestTranscriptTurn && !latestTranscriptTurn.isFinished && latestTranscriptTurn.startedAt) {
    const ageMs = now - (latestTranscriptTurn.lastStepAt || latestTranscriptTurn.startedAt);
    if (ageMs < 15 * 60 * 1000) {
      activeTurn = {
        turnIndex: numberedTurns.length + 1,
        userStepIndex: latestTranscriptTurn.userStepIndex,
        userInput: latestTranscriptTurn.userInput,
        hudFileName: latestTranscriptTurn.hudFileName || '',
        startedAt: latestTranscriptTurn.startedAt,
        stats: latestTranscriptTurn.stats,
        recentTools: [],
      };
    }
  }

  let activeTool = null;
  if (activeTurn && latestTranscriptTurn && !latestTranscriptTurn.isFinished && latestTranscriptTurn.pendingTools.length > 0) {
    activeTool = latestTranscriptTurn.pendingTools[0];
  }
  if (activeTurn) {
    activeTurn.activeTool = activeTool;
  }

  const lastCompletedTurn = numberedTurns.length > 0 ? numberedTurns[numberedTurns.length - 1] : null;
  const status = activeTurn
    ? 'running'
    : lastCompletedTurn
    ? isTurnInterrupted(lastCompletedTurn)
      ? 'interrupted'
      : 'done'
    : 'idle';

  const artifactDir =
    state.artifactDirectoryPath ||
    (transcriptPath ? dirname(dirname(dirname(transcriptPath))) : '');
  const targetHudFile =
    activeTurn?.hudFileName ||
    lastCompletedTurn?.hudFileName ||
    latestTranscriptTurn?.hudFileName ||
    '';
  const hudFromArtifact = targetHudFile ? parseArtifactHudHtml(artifactDir, now, targetHudFile) : null;
  const hudFromTranscript = hudFromArtifact || transcript?.latestHud;
  const rawTasks =
    Array.isArray(hudFromTranscript?.tasks) && hudFromTranscript.tasks.length > 0
      ? hudFromTranscript.tasks
      : state.tasks || [];
  const tasks = normalizeAndAdvanceTasks(rawTasks, { turnFinished: status === 'done', now });
  const taskTitle = hudFromTranscript?.taskTitle || state.taskTitle || '';
  const summary =
    hudFromTranscript?.summary ||
    state.summary ||
    (activeTurn && transcript?.latestNote ? transcript.latestNote : '') ||
    transcript?.latestNote ||
    '';

  return {
    conversationId: convId,
    serverNow: now,
    status,
    summary,
    taskTitle,
    tasks,
    activeTurn,
    lastCompletedTurn,
    turns: [...numberedTurns].reverse(),
    settings,
  };
}

const STATIC = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

const app = new SidecarApp();

app.page('/', () => {
  return new Response(readFileSync(join(__dirname, 'index.html'), 'utf-8'), {
    contentType: 'text/html; charset=utf-8',
  });
});

for (const [route, [file, contentType]] of Object.entries(STATIC)) {
  app.api(
    route,
    () => new Response(readFileSync(join(__dirname, file), 'utf-8'), { contentType }),
    'GET',
  );
}

app.api(
  '/api/hud',
  (data) => {
    const dataDir = resolveDataDir();
    const convId =
      sanitizeConversationId(data.conversationId) ||
      sanitizeConversationId(app.config.conversationId) ||
      resolveActiveConversationId('', dataDir);

    if (!convId) {
      return {
        conversationId: null,
        serverNow: Date.now(),
        status: 'idle',
        summary: '',
        taskTitle: '',
        tasks: [],
        activeTurn: null,
        lastCompletedTurn: null,
        turns: [],
        settings: loadSettings(dataDir),
        etag: 'empty',
      };
    }

    const snap = mergeHudSnapshot(convId, dataDir);
    const sigObj = {
      conversationId: snap.conversationId,
      status: snap.status,
      summary: snap.summary,
      taskTitle: snap.taskTitle,
      tasks: snap.tasks,
      activeTurn: snap.activeTurn
        ? {
            turnIndex: snap.activeTurn.turnIndex,
            startedAt: snap.activeTurn.startedAt,
            stats: snap.activeTurn.stats,
            activeTool: snap.activeTurn.activeTool,
            recentLen: snap.activeTurn.recentTools?.length || 0,
          }
        : null,
      turnsCount: snap.turns.length,
      lastEndedAt: snap.lastCompletedTurn?.endedAt || 0,
      settings: snap.settings,
    };
    const etag = JSON.stringify(sigObj);
    if (data.etag && data.etag === etag) {
      return { conversationId: convId, unchanged: true, etag, serverNow: snap.serverNow };
    }
    return { ...snap, etag };
  },
  'GET',
);

app.api(
  '/api/settings',
  (data) => {
    const dataDir = resolveDataDir();
    const patch = {};
    if (typeof data.injectPreviousTurnTimerInChat === 'boolean') {
      patch.injectPreviousTurnTimerInChat = data.injectPreviousTurnTimerInChat;
    }
    if (typeof data.injectProgressInChat === 'boolean') {
      patch.injectProgressInChat = data.injectProgressInChat;
    }
    return { ok: true, settings: saveSettings(patch, dataDir) };
  },
  'POST',
);

const cancelWatcher = createCancelWatcher({
  dataDir: resolveDataDir(),
  logger: (msg) => console.error(msg),
});

app.run().then(() => {
  cancelWatcher.start();
});
