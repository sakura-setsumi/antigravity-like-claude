import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  classifyTool,
  createEmptyStats,
  ensureArtifactHudTemplate,
  formatDuration,
  isHudInternalTool,
  loadConversationState,
  loadSettings,
  normalizeAndAdvanceTasks,
  normalizeHudFileName,
  normalizeToolArgs,
  parseArtifactHudHtml,
  parseMarkdownTaskHud,
  recordActiveConversation,
  resetArtifactHudSlots,
  resolveDataDir,
  sanitizeConversationId,
  saveConversationState,
  summarizeToolStats,
  syncArtifactHudFile,
} from './state-store.mjs';

function readStdinText() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function resolveCompactTranscriptPath(transcriptPath) {
  if (!transcriptPath) return '';
  if (basename(transcriptPath) === 'transcript_full.jsonl') {
    const compact = join(dirname(transcriptPath), 'transcript.jsonl');
    if (existsSync(compact)) return compact;
  }
  return existsSync(transcriptPath) ? transcriptPath : '';
}

function inspectTranscript(transcriptPath) {
  const target = resolveCompactTranscriptPath(transcriptPath);
  if (!target) return { latestUser: null, latestHud: null, activeHudFile: '', usedSlots: [] };
  try {
    const raw = readFileSync(target, 'utf-8');
    const lines = raw.trim().split('\n');
    let latestUser = null;
    let latestHud = null;
    let activeHudFile = '';
    const usedSlots = [];

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const createdMs = Date.parse(obj?.created_at || '');
      const ts = Number.isFinite(createdMs) ? createdMs : Date.now();

      if (obj?.type === 'PLANNER_RESPONSE') {
        if (!latestUser) {
          if (typeof obj?.content === 'string') {
            const matches = [...obj.content.matchAll(/task-hud(?:-t\d+|-\d+|-end)?\.html/gi)];
            for (let mIdx = matches.length - 1; mIdx >= 0; mIdx--) {
              const slotName = normalizeHudFileName(matches[mIdx][0]);
              if (slotName) {
                if (!activeHudFile) activeHudFile = slotName;
                if (!usedSlots.includes(slotName)) {
                  usedSlots.unshift(slotName);
                }
              }
            }
          }
          if (Array.isArray(obj.tool_calls)) {
            for (let tIdx = obj.tool_calls.length - 1; tIdx >= 0; tIdx--) {
              const tc = obj.tool_calls[tIdx];
              const args = normalizeToolArgs(tc?.args);
              const candidate = normalizeHudFileName(args.Path || args.path || args.TargetFile || '');
              if (candidate) {
                if (!activeHudFile) activeHudFile = candidate;
                if (!usedSlots.includes(candidate)) {
                  usedSlots.unshift(candidate);
                }
              }
            }
          }
          if (!latestHud && typeof obj?.content === 'string') {
            const parsed = parseMarkdownTaskHud(obj.content, ts);
            if (parsed) {
              latestHud = parsed;
            }
          }
        }
      }

      if (!latestUser && obj?.type === 'USER_INPUT') {
        latestUser = {
          stepIndex: Number(obj.step_index),
          createdMs: Number.isFinite(createdMs) ? createdMs : null,
        };
        break;
      }
    }
    return { latestUser, latestHud, activeHudFile, usedSlots };
  } catch {
    return { latestUser: null, latestHud: null, activeHudFile: '', usedSlots: [] };
  }
}

function applyParsedHudToState(
  state,
  latestHud,
  { turnFinished = false, now = Date.now(), preferredFileName = '' } = {}
) {
  const targetFile = preferredFileName || state.activeTurn?.hudFileName || (turnFinished ? state.lastCompletedTurn?.hudFileName : '') || '';
  const artifactHud = targetFile ? parseArtifactHudHtml(state.artifactDirectoryPath, now, targetFile) : null;
  const chosen = artifactHud || latestHud;
  if (chosen) {
    if (chosen.taskTitle) state.taskTitle = chosen.taskTitle;
    if (chosen.summary) state.summary = chosen.summary;
    if (Array.isArray(chosen.logs) && chosen.logs.length > 0) {
      state.logs = chosen.logs;
    }
    if (Array.isArray(chosen.tasks) && chosen.tasks.length > 0) {
      state.tasks = chosen.tasks;
    }
  }
  if (Array.isArray(state.tasks) && state.tasks.length > 0) {
    state.tasks = normalizeAndAdvanceTasks(state.tasks, { turnFinished, now });
  }
}

function cleanUserText(raw) {
  const s = String(raw || '').trim();
  const match = s.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  const body = match ? match[1] : s;
  return body.replace(/\s+/g, ' ').trim().slice(0, 140);
}

function finalizeActiveTurn(state, { terminationReason = 'NO_TOOL_CALL', now = Date.now() } = {}) {
  if (!state.activeTurn) return null;
  const t = state.activeTurn;
  const endedAt = Math.max(now, t.startedAt || now);
  const completed = {
    turnIndex: t.turnIndex,
    userStepIndex: t.userStepIndex ?? null,
    userInput: t.userInput || '',
    hudFileName: t.hudFileName || '',
    startedAt: t.startedAt,
    endedAt,
    elapsedMs: endedAt - t.startedAt,
    terminationReason,
    stats: t.stats || createEmptyStats(),
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

function handleSessionStart(payload, state) {
  if (payload.transcriptPath) state.transcriptPath = payload.transcriptPath;
  if (payload.artifactDirectoryPath) {
    state.artifactDirectoryPath = payload.artifactDirectoryPath;
    ensureArtifactHudTemplate(state.artifactDirectoryPath);
  }
  return {};
}

function handlePreInvocation(payload, state, settings) {
  const now = Date.now();
  if (payload.transcriptPath) state.transcriptPath = payload.transcriptPath;
  if (payload.artifactDirectoryPath) {
    state.artifactDirectoryPath = payload.artifactDirectoryPath;
    ensureArtifactHudTemplate(state.artifactDirectoryPath);
  }
  const { latestUser, latestHud, activeHudFile } = inspectTranscript(state.transcriptPath);

  const userText = cleanUserText(payload.lastUserInput);

  if (
    !state.activeTurn &&
    latestUser &&
    state.lastCompletedTurn &&
    state.lastCompletedTurn.userStepIndex !== null &&
    state.lastCompletedTurn.userStepIndex === latestUser.stepIndex
  ) {
    const resumed = state.turns.pop() || state.lastCompletedTurn;
    state.activeTurn = {
      turnIndex: resumed.turnIndex,
      userStepIndex: resumed.userStepIndex,
      userInput: resumed.userInput || userText,
      hudFileName: resumed.hudFileName || activeHudFile || '',
      startedAt: resumed.startedAt || now,
      invocationCount: 2,
      stats: resumed.stats || createEmptyStats(),
      recentTools: [],
      lastAnnouncedToolCount: resumed.stats?.totalTools || 0,
    };
    state.lastCompletedTurn = state.turns[state.turns.length - 1] || null;
  }

  const isNewTurn =
    !state.activeTurn ||
    (latestUser && state.activeTurn.userStepIndex !== null && latestUser.stepIndex !== state.activeTurn.userStepIndex) ||
    (!latestUser && userText && state.activeTurn.userInput && userText !== state.activeTurn.userInput);

  if (isNewTurn) {
    if (state.activeTurn) {
      finalizeActiveTurn(state, { terminationReason: 'TURN_REPLACED', now });
    }
    state.taskTitle = '';
    state.summary = '';
    state.logs = [];
    state.tasks = [];
    if (state.artifactDirectoryPath) {
      resetArtifactHudSlots(state.artifactDirectoryPath);
    }
    const nextIndex = (state.turns[state.turns.length - 1]?.turnIndex || 0) + 1;
    let startedAt = now;
    if (latestUser?.createdMs && now - latestUser.createdMs >= 0 && now - latestUser.createdMs <= 120000) {
      startedAt = latestUser.createdMs;
    }
    state.activeTurn = {
      turnIndex: nextIndex,
      userStepIndex: latestUser ? latestUser.stepIndex : null,
      userInput: userText,
      hudFileName: activeHudFile || '',
      startedAt,
      invocationCount: 1,
      stats: createEmptyStats(),
      recentTools: [],
      lastAnnouncedToolCount: 0,
    };
  } else {
    state.activeTurn.invocationCount = (state.activeTurn.invocationCount || 0) + 1;
    if (!state.activeTurn.hudFileName && activeHudFile) {
      state.activeTurn.hudFileName = activeHudFile;
    }
    applyParsedHudToState(state, latestHud, {
      turnFinished: false,
      now,
      preferredFileName: state.activeTurn.hudFileName,
    });
  }

  // 仅当本轮已明确绑定独立槽位文件名时同步刷新该文件
  if (state.activeTurn?.hudFileName) {
    syncArtifactHudFile(state.artifactDirectoryPath, state, {
      turnFinished: false,
      now,
      targetFileName: state.activeTurn.hudFileName,
    });
  }

  return {};
}

function handlePreToolUse(payload) {
  const toolName = String(payload.toolCall?.name || '').toLowerCase();
  if (toolName === 'run_command') {
    return { decision: 'ask' };
  }
  return { decision: 'allow' };
}

function handlePostToolUse(payload, state) {
  const tool = payload.toolCall || {};
  const toolName = String(tool.name || '');
  const toolArgs = tool.args && typeof tool.args === 'object' ? tool.args : {};
  const normArgs = normalizeToolArgs(toolArgs);
  const now = Date.now();
  if (payload.transcriptPath) state.transcriptPath = payload.transcriptPath;
  if (payload.artifactDirectoryPath) state.artifactDirectoryPath = payload.artifactDirectoryPath;

  const { latestUser, latestHud, activeHudFile } = inspectTranscript(state.transcriptPath);
  const isStaleTool =
    latestUser &&
    state.activeTurn &&
    state.activeTurn.userStepIndex !== null &&
    latestUser.stepIndex !== state.activeTurn.userStepIndex;

  const hitHudFile = normalizeHudFileName(normArgs.Path || normArgs.path || normArgs.TargetFile || '');

  if (!isStaleTool) {
    const resolvedHud = hitHudFile || state.activeTurn?.hudFileName || activeHudFile || '';
    if (!state.activeTurn) {
      const nextIndex = (state.turns[state.turns.length - 1]?.turnIndex || 0) + 1;
      state.activeTurn = {
        turnIndex: nextIndex,
        userStepIndex: latestUser ? latestUser.stepIndex : null,
        userInput: cleanUserText(payload.lastUserInput),
        hudFileName: resolvedHud,
        startedAt: now,
        invocationCount: 1,
        stats: createEmptyStats(),
        recentTools: [],
      };
    } else if (hitHudFile) {
      state.activeTurn.hudFileName = hitHudFile;
    } else if (!state.activeTurn.hudFileName && activeHudFile) {
      state.activeTurn.hudFileName = activeHudFile;
    }

    if (resolvedHud) {
      applyParsedHudToState(state, latestHud, {
        turnFinished: false,
        now,
        preferredFileName: resolvedHud,
      });
    }
  }

  if (isHudInternalTool(toolName, normArgs)) {
    if (!isStaleTool && state.activeTurn?.hudFileName) {
      syncArtifactHudFile(state.artifactDirectoryPath, state, {
        turnFinished: false,
        now,
        targetFileName: state.activeTurn.hudFileName,
      });
    }
    return {};
  }

  if (!state.activeTurn) {
    const nextIndex = (state.turns[state.turns.length - 1]?.turnIndex || 0) + 1;
    state.activeTurn = {
      turnIndex: nextIndex,
      userStepIndex: latestUser ? latestUser.stepIndex : null,
      userInput: cleanUserText(payload.lastUserInput),
      hudFileName: (!isStaleTool && activeHudFile) ? activeHudFile : '',
      startedAt: now,
      invocationCount: 1,
      stats: createEmptyStats(),
      recentTools: [],
    };
  }
  const info = classifyTool(toolName, normArgs);
  const stats = state.activeTurn.stats || createEmptyStats();
  stats[info.category] = (stats[info.category] || 0) + 1;
  stats.totalTools = (stats.totalTools || 0) + 1;
  if (payload.error) {
    stats.failures = (stats.failures || 0) + 1;
  }
  state.activeTurn.stats = stats;

  state.activeTurn.recentTools = [
    ...(Array.isArray(state.activeTurn.recentTools) ? state.activeTurn.recentTools : []),
    {
      name: toolName,
      label: info.label,
      failed: Boolean(payload.error),
      finishedAt: now,
    },
  ].slice(-15);

  if (state.activeTurn?.hudFileName) {
    syncArtifactHudFile(state.artifactDirectoryPath, state, {
      turnFinished: false,
      now,
      targetFileName: state.activeTurn.hudFileName,
    });
  }
  return {};
}

function handlePostInvocation(payload, state) {
  const now = Date.now();
  if (payload.transcriptPath) state.transcriptPath = payload.transcriptPath;
  if (payload.artifactDirectoryPath) state.artifactDirectoryPath = payload.artifactDirectoryPath;

  const { latestUser, latestHud, activeHudFile } = inspectTranscript(state.transcriptPath);
  const isStale =
    latestUser &&
    state.activeTurn &&
    state.activeTurn.userStepIndex !== null &&
    latestUser.stepIndex !== state.activeTurn.userStepIndex;

  if (!isStale && state.activeTurn && !state.activeTurn.hudFileName && activeHudFile) {
    state.activeTurn.hudFileName = activeHudFile;
  }

  const targetFileName = state.activeTurn?.hudFileName || (!isStale ? activeHudFile : '') || '';
  if (targetFileName) {
    applyParsedHudToState(state, latestHud, {
      turnFinished: false,
      now,
      preferredFileName: targetFileName,
    });
    syncArtifactHudFile(state.artifactDirectoryPath, state, {
      turnFinished: false,
      now,
      isPreToolUse: true,
      targetFileName,
    });
  }
  return {};
}

function handleStop(payload, state) {
  const now = Date.now();
  if (payload.transcriptPath) state.transcriptPath = payload.transcriptPath;
  if (payload.artifactDirectoryPath) state.artifactDirectoryPath = payload.artifactDirectoryPath;

  const { latestUser, latestHud, activeHudFile } = inspectTranscript(state.transcriptPath);
  const fullyDone = payload.fullyIdle !== false && (payload.terminationReason || 'NO_TOOL_CALL') === 'NO_TOOL_CALL';

  const isStale =
    latestUser &&
    state.activeTurn &&
    state.activeTurn.userStepIndex !== null &&
    latestUser.stepIndex !== state.activeTurn.userStepIndex;

  if (!isStale && state.activeTurn && !state.activeTurn.hudFileName && activeHudFile) {
    state.activeTurn.hudFileName = activeHudFile;
  }

  let completed = null;
  if (state.activeTurn) {
    completed = finalizeActiveTurn(state, {
      terminationReason: payload.terminationReason || 'NO_TOOL_CALL',
      now,
    });
  }

  const targetFileName =
    completed?.hudFileName ||
    state.lastCompletedTurn?.hudFileName ||
    (!isStale ? activeHudFile : '') ||
    '';

  if (targetFileName) {
    applyParsedHudToState(state, latestHud, {
      turnFinished: fullyDone,
      now,
      preferredFileName: targetFileName,
    });
    syncArtifactHudFile(state.artifactDirectoryPath, state, {
      turnFinished: fullyDone,
      now,
      targetFileName,
    });
  }
  return {};
}

async function main() {
  const raw = await readStdinText();
  let payload = {};
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    process.stdout.write('{}\n');
    return;
  }

  const dataDir = resolveDataDir();
  const convId = sanitizeConversationId(payload.conversationId);
  const eventName = String(payload.hookEventName || '');

  if (!convId) {
    process.stdout.write('{}\n');
    return;
  }

  recordActiveConversation(convId, { lastEvent: eventName }, dataDir);
  const state = loadConversationState(convId, dataDir);
  const settings = loadSettings(dataDir);

  let output = {};
  if (eventName === 'SessionStart') {
    output = handleSessionStart(payload, state);
  } else if (eventName === 'PreInvocation') {
    output = handlePreInvocation(payload, state, settings);
  } else if (eventName === 'PreToolUse') {
    output = handlePreToolUse(payload);
  } else if (eventName === 'PostToolUse') {
    output = handlePostToolUse(payload, state);
  } else if (eventName === 'PostInvocation') {
    output = handlePostInvocation(payload, state);
  } else if (eventName === 'Stop') {
    output = handleStop(payload, state);
  }

  saveConversationState(state, dataDir);
  process.stdout.write(JSON.stringify(output) + '\n');
}

main().catch(() => {
  process.stdout.write('{}\n');
});
