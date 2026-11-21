import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  advanceAutoSeededHudForPlanHandover,
  classifyTool,
  clearAutoSeededHudSlot,
  collapseArtifactHudFile,
  computeTurnTokensFromTranscript,
  createEmptyStats,
  createEmptyTokens,
  ensureArtifactHudTemplate,
  finalizeActiveTurn,
  findNextAvailableTurnSlot,
  formatDuration,
  isHudInternalTool,
  isHudSlotCollapsedFile,
  isTurnInterrupted,
  loadConversationState,
  loadSettings,
  normalizeAndAdvanceTasks,
  normalizeEndHudFileName,
  normalizeHudFileName,
  normalizeToolArgs,
  parseArtifactHudHtml,
  parseMarkdownTaskHud,
  recordActiveConversation,
  resetArtifactHudSlots,
  resolveDataDir,
  sanitizeConversationId,
  saveConversationState,
  seedDefaultHudTasksIfEmpty,
  summarizeToolStats,
  syncArtifactHudFile,
  syncEndHudFile,
} from './state-store.mjs';

const WRITE_TOOLS = new Set(['edit_file', 'write_file', 'replace_file_content']);

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
  if (!target) {
    return {
      latestUser: null,
      latestHud: null,
      activeHudFile: '',
      embeddedHudFile: '',
      embeddedEndHudFile: '',
      usedSlots: [],
      lastPlannerText: '',
      lastToolNames: [],
      hasPlannerAfterLatestUser: false,
      turnTokens: createEmptyTokens(),
    };
  }
  try {
    const raw = readFileSync(target, 'utf-8');
    const lines = raw.trim().split('\n');
    let latestUser = null;
    let latestHud = null;
    let activeHudFile = '';
    let embeddedHudFile = '';
    let embeddedEndHudFile = '';
    let lastPlannerText = '';
    let lastToolNames = [];
    let sawLastPlanner = false;
    const usedSlots = [];
    const turnTokens = computeTurnTokensFromTranscript(target);

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
          if (!sawLastPlanner) {
            sawLastPlanner = true;
            lastPlannerText = typeof obj?.content === 'string' ? obj.content : '';
            lastToolNames = Array.isArray(obj.tool_calls)
              ? obj.tool_calls.map((tc) => String(tc?.name || '').toLowerCase()).filter(Boolean)
              : [];
          }
          if (typeof obj?.content === 'string') {
            if (!embeddedEndHudFile) {
              const endRe = /<agent-embed\b[^>]*\bsrc=["'][^"']*?(task-hud-end-t\d+\.html)["'][^>]*>/gi;
              const endMatches = [...obj.content.matchAll(endRe)];
              for (let mIdx = endMatches.length - 1; mIdx >= 0; mIdx--) {
                const endSlot = normalizeEndHudFileName(endMatches[mIdx][1]);
                if (endSlot) {
                  embeddedEndHudFile = endSlot;
                  break;
                }
              }
            }
            const embedRe = /<agent-embed\b[^>]*\bsrc=["'][^"']*?(task-hud(?:-t\d+|-\d+|-end)?\.html)["'][^>]*>/gi;
            const matches = [...obj.content.matchAll(embedRe)];
            for (let mIdx = matches.length - 1; mIdx >= 0; mIdx--) {
              const slotName = normalizeHudFileName(matches[mIdx][1]);
              if (slotName) {
                if (!embeddedHudFile) embeddedHudFile = slotName;
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
              const tcName = String(tc?.name || '').toLowerCase();
              if (!WRITE_TOOLS.has(tcName)) continue;
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
          userInput: cleanUserText(obj.content),
          fingerprint: buildUserInputFingerprint(obj.content, obj.media),
        };
        break;
      }
    }
    return {
      latestUser,
      latestHud,
      activeHudFile,
      embeddedHudFile,
      embeddedEndHudFile,
      usedSlots,
      lastPlannerText,
      lastToolNames,
      hasPlannerAfterLatestUser: sawLastPlanner,
      turnTokens,
    };
  } catch {
    return {
      latestUser: null,
      latestHud: null,
      activeHudFile: '',
      embeddedHudFile: '',
      embeddedEndHudFile: '',
      usedSlots: [],
      lastPlannerText: '',
      lastToolNames: [],
      hasPlannerAfterLatestUser: false,
      turnTokens: createEmptyTokens(),
    };
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

function buildUserInputFingerprint(raw, media = []) {
  const s = String(raw || '');
  const reqMatch = s.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  const bodyRaw = reqMatch
    ? reqMatch[1]
    : s.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '');
  const text = bodyRaw.replace(/\s+/g, ' ').trim();

  const fileSet = new Set();
  const metaMatch = s.match(/<ADDITIONAL_METADATA>([\s\S]*?)<\/ADDITIONAL_METADATA>/i);
  if (metaMatch) {
    const fileRe = /^\s*-\s+(.+?\.\w+)\s*$/gm;
    for (const m of metaMatch[1].matchAll(fileRe)) {
      const p = String(m[1] || '').trim().replace(/\\/g, '/');
      if (p) fileSet.add(p);
    }
  }
  if (Array.isArray(media)) {
    for (const item of media) {
      const uri = String(item?.uri || item?.path || '').trim().replace(/\\/g, '/');
      if (uri) fileSet.add(uri);
    }
  }
  const files = [...fileSet].sort();
  if (!text && files.length === 0) return '';
  return JSON.stringify({ text, files });
}

function pickUsableHudFile(artifactDir, ...candidates) {
  for (const c of candidates) {
    const norm = normalizeHudFileName(c);
    if (!norm) continue;
    if (artifactDir && isHudSlotCollapsedFile(artifactDir, norm)) continue;
    return norm;
  }
  return '';
}

function collapseSupersededTurnHud(state, turn, now = Date.now()) {
  if (!turn?.hudFileName || turn.hudCollapsed || !state.artifactDirectoryPath) return false;
  const ok = collapseArtifactHudFile(state.artifactDirectoryPath, turn.hudFileName, { now, turn });
  if (ok) {
    turn.hudCollapsed = true;
  }
  return ok;
}

function rotateToNewTurn(
  state,
  {
    latestUser = null,
    userText = '',
    userFingerprint = '',
    payloadFingerprint = '',
    embeddedHudFile = '',
    activeHudFile = '',
    now = Date.now(),
  } = {}
) {
  const prevUserStepIndex = state.activeTurn?.userStepIndex ?? null;
  if (state.activeTurn) {
    const prevTurn = finalizeActiveTurn(state, { terminationReason: 'TURN_REPLACED', now });
    collapseSupersededTurnHud(state, prevTurn, now);
  } else if (
    isTurnInterrupted(state.lastCompletedTurn) &&
    state.lastCompletedTurn?.terminationReason !== 'USER_CANCELED'
  ) {
    collapseSupersededTurnHud(state, state.lastCompletedTurn, now);
  }

  state.taskTitle = '';
  state.summary = '';
  state.logs = [];
  state.tasks = [];
  if (state.artifactDirectoryPath) {
    resetArtifactHudSlots(state.artifactDirectoryPath);
  }

  let nextUserStepIndex = null;
  let minUserStepIndex = null;
  if (latestUser && latestUser.stepIndex !== prevUserStepIndex) {
    nextUserStepIndex = latestUser.stepIndex;
  } else {
    minUserStepIndex = prevUserStepIndex;
  }

  const nextIndex = (state.turns[state.turns.length - 1]?.turnIndex || 0) + 1;
  let startedAt = now;
  if (
    nextUserStepIndex !== null &&
    latestUser?.createdMs &&
    now - latestUser.createdMs >= 0 &&
    now - latestUser.createdMs <= 120000
  ) {
    startedAt = latestUser.createdMs;
  }

  const usableEmbedded = pickUsableHudFile(state.artifactDirectoryPath, embeddedHudFile);
  const usableActive = pickUsableHudFile(state.artifactDirectoryPath, activeHudFile);
  const resolvedHud = usableEmbedded || usableActive || '';

  state.activeTurn = {
    turnIndex: nextIndex,
    userStepIndex: nextUserStepIndex,
    minUserStepIndex,
    userInput: userText || (nextUserStepIndex !== null ? latestUser?.userInput || '' : ''),
    userFingerprint: userFingerprint || (nextUserStepIndex !== null ? latestUser?.fingerprint || '' : ''),
    payloadFingerprint,
    hudFileName: resolvedHud,
    hasUserEmbed: Boolean(usableEmbedded),
    autoEmbedInjected: false,
    autoSeededSlot: '',
    supersededCollapsed: false,
    startedAt,
    invocationCount: 1,
    stats: createEmptyStats(),
    tokens: createEmptyTokens(),
    recentTools: [],
    lastAnnouncedToolCount: 0,
  };
  return state.activeTurn;
}

function reconcileTurnWithTranscript(state, tInfo, payload, now = Date.now()) {
  const { latestUser, embeddedHudFile, activeHudFile, hasPlannerAfterLatestUser } = tInfo;
  if (state.activeTurn && state.activeTurn.userStepIndex === null && latestUser) {
    if (
      state.activeTurn.minUserStepIndex === null ||
      state.activeTurn.minUserStepIndex === undefined ||
      latestUser.stepIndex > state.activeTurn.minUserStepIndex
    ) {
      state.activeTurn.userStepIndex = latestUser.stepIndex;
      state.activeTurn.minUserStepIndex = null;
      if (!state.activeTurn.userInput && latestUser.userInput) {
        state.activeTurn.userInput = latestUser.userInput;
      }
      if (!state.activeTurn.userFingerprint && latestUser.fingerprint) {
        state.activeTurn.userFingerprint = latestUser.fingerprint;
      }
    }
  }

  const hasNewerUser = Boolean(
    latestUser &&
      state.activeTurn &&
      state.activeTurn.userStepIndex !== null &&
      latestUser.stepIndex > state.activeTurn.userStepIndex
  );

  if (hasNewerUser) {
    if (hasPlannerAfterLatestUser) {
      const payloadFp = buildUserInputFingerprint(payload?.lastUserInput);
      rotateToNewTurn(state, {
        latestUser,
        userText: latestUser.userInput || cleanUserText(payload?.lastUserInput),
        userFingerprint: latestUser.fingerprint || payloadFp,
        payloadFingerprint: payloadFp,
        embeddedHudFile,
        activeHudFile,
        now,
      });
      return { isStaleInFlight: false, rotated: true };
    }

    if (!state.activeTurn.supersededCollapsed && state.activeTurn.hudFileName && state.artifactDirectoryPath) {
      collapseArtifactHudFile(state.artifactDirectoryPath, state.activeTurn.hudFileName, {
        now,
        turn: state.activeTurn,
      });
      state.activeTurn.supersededCollapsed = true;
    }
    return { isStaleInFlight: true, rotated: false };
  }

  if (
    embeddedHudFile &&
    state.activeTurn?.hudFileName &&
    embeddedHudFile !== state.activeTurn.hudFileName &&
    !isHudSlotCollapsedFile(state.artifactDirectoryPath, embeddedHudFile)
  ) {
    collapseArtifactHudFile(state.artifactDirectoryPath, state.activeTurn.hudFileName, {
      now,
      turn: state.activeTurn,
    });
    state.activeTurn.hudFileName = embeddedHudFile;
    state.activeTurn.hasUserEmbed = true;
    state.activeTurn.autoSeededSlot = '';
  }

  if (state.activeTurn && tInfo.turnTokens && tInfo.turnTokens.total > 0) {
    state.activeTurn.tokens = { ...tInfo.turnTokens };
  }

  return { isStaleInFlight: false, rotated: false };
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
  const { latestUser, latestHud, activeHudFile, embeddedHudFile, turnTokens } = inspectTranscript(state.transcriptPath);

  const userText = cleanUserText(payload.lastUserInput);
  const payloadFingerprint = buildUserInputFingerprint(payload.lastUserInput);
  const userFingerprint = latestUser?.fingerprint || payloadFingerprint;

  if (
    !state.activeTurn &&
    latestUser &&
    state.lastCompletedTurn &&
    !state.lastCompletedTurn.hudCollapsed &&
    !isTurnInterrupted(state.lastCompletedTurn) &&
    state.lastCompletedTurn.userStepIndex !== null &&
    state.lastCompletedTurn.userStepIndex === latestUser.stepIndex
  ) {
    const resumed = state.turns.pop() || state.lastCompletedTurn;
    state.activeTurn = {
      turnIndex: resumed.turnIndex,
      userStepIndex: resumed.userStepIndex,
      minUserStepIndex: null,
      userInput: resumed.userInput || userText,
      userFingerprint: resumed.userFingerprint || userFingerprint,
      payloadFingerprint: resumed.payloadFingerprint || payloadFingerprint,
      hudFileName: resumed.hudFileName || pickUsableHudFile(state.artifactDirectoryPath, activeHudFile) || '',
      hasUserEmbed: Boolean(resumed.hasUserEmbed || embeddedHudFile),
      autoEmbedInjected: Boolean(resumed.autoEmbedInjected),
      autoSeededSlot: resumed.autoSeededSlot || '',
      supersededCollapsed: false,
      startedAt: resumed.startedAt || now,
      invocationCount: 2,
      stats: resumed.stats || createEmptyStats(),
      tokens: resumed.tokens || createEmptyTokens(),
      recentTools: [],
      lastAnnouncedToolCount: resumed.stats?.totalTools || 0,
    };
    state.lastCompletedTurn = state.turns[state.turns.length - 1] || null;
  }

  if (state.activeTurn && state.activeTurn.userStepIndex === null && latestUser) {
    if (
      state.activeTurn.minUserStepIndex === null ||
      state.activeTurn.minUserStepIndex === undefined ||
      latestUser.stepIndex > state.activeTurn.minUserStepIndex
    ) {
      state.activeTurn.userStepIndex = latestUser.stepIndex;
      state.activeTurn.minUserStepIndex = null;
    }
  }

  const hasNewerUserStep = Boolean(
    latestUser &&
      state.activeTurn &&
      state.activeTurn.userStepIndex !== null &&
      latestUser.stepIndex > state.activeTurn.userStepIndex
  );
  const hasDifferentPayload = Boolean(
    payloadFingerprint &&
      state.activeTurn?.payloadFingerprint &&
      payloadFingerprint !== state.activeTurn.payloadFingerprint
  );

  const isNewTurn =
    !state.activeTurn ||
    hasNewerUserStep ||
    hasDifferentPayload ||
    (!latestUser && userText && state.activeTurn.userInput && userText !== state.activeTurn.userInput);

  if (isNewTurn) {
    rotateToNewTurn(state, {
      latestUser,
      userText,
      userFingerprint,
      payloadFingerprint,
      embeddedHudFile,
      activeHudFile,
      now,
    });
  } else {
    state.activeTurn.invocationCount = (state.activeTurn.invocationCount || 0) + 1;
    if (payloadFingerprint && !state.activeTurn.payloadFingerprint) {
      state.activeTurn.payloadFingerprint = payloadFingerprint;
    }
    if (userFingerprint && !state.activeTurn.userFingerprint) {
      state.activeTurn.userFingerprint = userFingerprint;
    }
    const usableEmbedded = pickUsableHudFile(state.artifactDirectoryPath, embeddedHudFile);
    const usableActive = pickUsableHudFile(state.artifactDirectoryPath, activeHudFile);
    if (
      usableEmbedded &&
      state.activeTurn.hudFileName &&
      usableEmbedded !== state.activeTurn.hudFileName
    ) {
      collapseArtifactHudFile(state.artifactDirectoryPath, state.activeTurn.hudFileName, {
        now,
        turn: state.activeTurn,
      });
      state.activeTurn.hudFileName = usableEmbedded;
      state.activeTurn.autoSeededSlot = '';
    }
    if (usableEmbedded) {
      state.activeTurn.hasUserEmbed = true;
    }
    if (!state.activeTurn.hudFileName && (usableEmbedded || usableActive)) {
      state.activeTurn.hudFileName = usableEmbedded || usableActive;
    }
    applyParsedHudToState(state, latestHud, {
      turnFinished: false,
      now,
      preferredFileName: state.activeTurn.hudFileName,
    });
  }

  if (state.activeTurn && turnTokens && turnTokens.total > 0) {
    state.activeTurn.tokens = { ...turnTokens };
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

function defaultPreToolUseOutput(payload) {
  const toolName = String(payload?.toolCall?.name || '').toLowerCase();
  if (toolName === 'run_command') {
    return { decision: 'ask' };
  }
  return { decision: 'allow' };
}

function handlePreToolUse(payload, state) {
  const decisionOutput = defaultPreToolUseOutput(payload);
  try {
    if (!state || typeof state !== 'object') {
      return decisionOutput;
    }
    const tool = payload.toolCall || {};
    const toolName = String(tool.name || '').toLowerCase();
    const normArgs = normalizeToolArgs(tool.args && typeof tool.args === 'object' ? tool.args : {});
    const now = Date.now();
    if (payload.transcriptPath) state.transcriptPath = payload.transcriptPath;
    if (payload.artifactDirectoryPath) state.artifactDirectoryPath = payload.artifactDirectoryPath;

    if (!isHudInternalTool(toolName, normArgs)) {
      const tInfo = inspectTranscript(state.transcriptPath);
      const { isStaleInFlight } = reconcileTurnWithTranscript(state, tInfo, payload, now);
      if (!isStaleInFlight) {
        const { latestUser, latestHud, embeddedHudFile } = tInfo;
        const usableEmbedded = pickUsableHudFile(state.artifactDirectoryPath, embeddedHudFile);
        if (usableEmbedded && state.artifactDirectoryPath) {
          if (!state.activeTurn) {
            const payloadFp = buildUserInputFingerprint(payload.lastUserInput);
            state.activeTurn = rotateToNewTurn(state, {
              latestUser,
              userText: cleanUserText(payload.lastUserInput),
              userFingerprint: latestUser?.fingerprint || payloadFp,
              payloadFingerprint: payloadFp,
              embeddedHudFile: usableEmbedded,
              now,
            });
          } else {
            state.activeTurn.hudFileName = usableEmbedded;
            state.activeTurn.hasUserEmbed = true;
          }
          const seeded = seedDefaultHudTasksIfEmpty(state.artifactDirectoryPath, usableEmbedded, {
            userInput: state.activeTurn.userInput,
          });
          if (seeded) {
            state.activeTurn.autoSeededSlot = usableEmbedded;
          }
          applyParsedHudToState(state, latestHud, {
            turnFinished: false,
            now,
            preferredFileName: usableEmbedded,
          });
          syncArtifactHudFile(state.artifactDirectoryPath, state, {
            turnFinished: false,
            now,
            isPreToolUse: true,
            targetFileName: usableEmbedded,
          });
        }

        if (toolName === 'exit_plan_mode' && state.activeTurn?.hudFileName && state.artifactDirectoryPath) {
          advanceAutoSeededHudForPlanHandover(state.artifactDirectoryPath, state.activeTurn.hudFileName);
          applyParsedHudToState(state, latestHud, {
            turnFinished: false,
            now,
            preferredFileName: state.activeTurn.hudFileName,
          });
          syncArtifactHudFile(state.artifactDirectoryPath, state, {
            turnFinished: false,
            now,
            isPreToolUse: true,
            targetFileName: state.activeTurn.hudFileName,
          });
        }
      }
    }
  } catch {
    // 防自锁兜底：PreToolUse 同步失败时仍返回标准工具决策，避免阻断模型调用任何工具
  }

  return decisionOutput;
}

function handlePostToolUse(payload, state) {
  const tool = payload.toolCall || {};
  const toolName = String(tool.name || '');
  const lowerName = toolName.toLowerCase();
  const toolArgs = tool.args && typeof tool.args === 'object' ? tool.args : {};
  const normArgs = normalizeToolArgs(toolArgs);
  const now = Date.now();
  if (payload.transcriptPath) state.transcriptPath = payload.transcriptPath;
  if (payload.artifactDirectoryPath) state.artifactDirectoryPath = payload.artifactDirectoryPath;

  const tInfo = inspectTranscript(state.transcriptPath);
  const { isStaleInFlight } = reconcileTurnWithTranscript(state, tInfo, payload, now);
  const { latestUser, latestHud, activeHudFile, embeddedHudFile } = tInfo;

  if (isStaleInFlight) {
    if (isHudInternalTool(toolName, normArgs)) {
      return {};
    }
    if (state.activeTurn) {
      const info = classifyTool(toolName, normArgs);
      const stats = state.activeTurn.stats || createEmptyStats();
      stats[info.category] = (stats[info.category] || 0) + 1;
      stats.totalTools = (stats.totalTools || 0) + 1;
      if (payload.error) {
        stats.failures = (stats.failures || 0) + 1;
      }
      state.activeTurn.stats = stats;
    }
    return {};
  }

  const hitHudFile = WRITE_TOOLS.has(lowerName)
    ? normalizeHudFileName(normArgs.Path || normArgs.path || normArgs.TargetFile || '')
    : '';
  const usableHitHud = pickUsableHudFile(state.artifactDirectoryPath, hitHudFile);
  const usableEmbedded = pickUsableHudFile(state.artifactDirectoryPath, embeddedHudFile);
  const usableActive = pickUsableHudFile(state.artifactDirectoryPath, activeHudFile);
  const resolvedHud = usableHitHud || usableEmbedded || state.activeTurn?.hudFileName || usableActive || '';

  if (!state.activeTurn) {
    const payloadFp = buildUserInputFingerprint(payload.lastUserInput);
    state.activeTurn = rotateToNewTurn(state, {
      latestUser,
      userText: cleanUserText(payload.lastUserInput),
      userFingerprint: latestUser?.fingerprint || payloadFp,
      payloadFingerprint: payloadFp,
      embeddedHudFile: usableEmbedded,
      activeHudFile: resolvedHud,
      now,
    });
    if (usableHitHud) {
      state.activeTurn.hudFileName = usableHitHud;
      state.activeTurn.autoSeededSlot = '';
    }
  } else {
    if (usableEmbedded) {
      state.activeTurn.hasUserEmbed = true;
    }
    if (usableHitHud) {
      if (state.activeTurn.hudFileName && state.activeTurn.hudFileName !== usableHitHud) {
        collapseArtifactHudFile(state.artifactDirectoryPath, state.activeTurn.hudFileName, {
          now,
          turn: state.activeTurn,
        });
      }
      state.activeTurn.hudFileName = usableHitHud;
      state.activeTurn.autoSeededSlot = '';
    } else if (usableEmbedded && !state.activeTurn.hudFileName) {
      state.activeTurn.hudFileName = usableEmbedded;
    } else if (!state.activeTurn.hudFileName && usableActive) {
      state.activeTurn.hudFileName = usableActive;
    }
  }

  if (
    resolvedHud &&
    state.artifactDirectoryPath &&
    !isHudInternalTool(toolName, normArgs) &&
    !parseArtifactHudHtml(state.artifactDirectoryPath, now, resolvedHud)
  ) {
    const seeded = seedDefaultHudTasksIfEmpty(state.artifactDirectoryPath, resolvedHud, {
      userInput: state.activeTurn.userInput,
    });
    if (seeded) {
      state.activeTurn.autoSeededSlot = resolvedHud;
    }
  }

  if (lowerName === 'exit_plan_mode' && state.activeTurn?.hudFileName && state.artifactDirectoryPath) {
    advanceAutoSeededHudForPlanHandover(state.artifactDirectoryPath, state.activeTurn.hudFileName);
  }

  if (resolvedHud) {
    applyParsedHudToState(state, latestHud, {
      turnFinished: false,
      now,
      preferredFileName: resolvedHud,
    });
  }

  if (isHudInternalTool(toolName, normArgs)) {
    if (state.activeTurn?.hudFileName) {
      const allCompleted =
        Array.isArray(state.tasks) &&
        state.tasks.length > 0 &&
        state.tasks.every((t) => t.status === 'completed');
      syncArtifactHudFile(state.artifactDirectoryPath, state, {
        turnFinished: allCompleted,
        now,
        targetFileName: state.activeTurn.hudFileName,
      });
    }
    return {};
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

  const tInfo = inspectTranscript(state.transcriptPath);
  const { isStaleInFlight } = reconcileTurnWithTranscript(state, tInfo, payload, now);
  if (isStaleInFlight) {
    return {};
  }

  const { latestHud, activeHudFile, embeddedHudFile, lastToolNames, turnTokens } = tInfo;
  const usableEmbedded = pickUsableHudFile(state.artifactDirectoryPath, embeddedHudFile);
  const usableActive = pickUsableHudFile(state.artifactDirectoryPath, activeHudFile);

  if (state.activeTurn) {
    if (turnTokens && turnTokens.total > 0) {
      state.activeTurn.tokens = { ...turnTokens };
    }
    if (usableEmbedded) {
      state.activeTurn.hasUserEmbed = true;
    }
    if (!state.activeTurn.hudFileName && (usableEmbedded || usableActive)) {
      state.activeTurn.hudFileName = usableEmbedded || usableActive;
    }
  }

  let targetFileName = state.activeTurn?.hudFileName || usableEmbedded || usableActive || '';
  let injectedOutput = null;

  // 仅当进入第 2 轮及以上工具调用且尚未嵌入 <agent-embed> 时才触发兜底提醒，避免单步查询产生额外 token 注入
  if (
    state.artifactDirectoryPath &&
    state.activeTurn &&
    !usableEmbedded &&
    !state.activeTurn.hasUserEmbed &&
    !state.activeTurn.autoEmbedInjected &&
    !lastToolNames.includes('exit_plan_mode') &&
    Number(state.activeTurn.invocationCount || 0) >= 2 &&
    Number(state.activeTurn.stats?.totalTools || 0) >= 2
  ) {
    const autoSlot = targetFileName || findNextAvailableTurnSlot(state.artifactDirectoryPath, state);
    if (autoSlot) {
      const seeded = seedDefaultHudTasksIfEmpty(state.artifactDirectoryPath, autoSlot, {
        userInput: state.activeTurn.userInput,
      });
      if (seeded) {
        state.activeTurn.autoSeededSlot = autoSlot;
      }
      state.activeTurn.hudFileName = autoSlot;
      state.activeTurn.autoEmbedInjected = true;
      targetFileName = autoSlot;

      const fileUri = `file:///${join(state.artifactDirectoryPath, autoSlot).replace(/\\/g, '/')}`;
      injectedOutput = {
        injectSteps: [
          {
            systemMessage: {
              systemMessage: `HUD ${autoSlot} 就绪：若还需调工具，下步仅输出 <agent-embed src="${fileUri}"></agent-embed> 并同时调工具；直接作答则忽略。`,
            },
          },
        ],
      };
    }
  }

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
  return injectedOutput || {};
}

function handleStop(payload, state) {
  const now = Date.now();
  if (payload.transcriptPath) state.transcriptPath = payload.transcriptPath;
  if (payload.artifactDirectoryPath) state.artifactDirectoryPath = payload.artifactDirectoryPath;

  const { latestUser, latestHud, activeHudFile, embeddedHudFile, embeddedEndHudFile, lastPlannerText, lastToolNames, turnTokens } = inspectTranscript(state.transcriptPath);
  const termReason = payload.terminationReason || 'NO_TOOL_CALL';
  const isPlanHandover =
    lastToolNames.includes('exit_plan_mode') &&
    termReason !== 'USER_CANCELED' &&
    termReason !== 'ERROR';
  const fullyDone =
    payload.fullyIdle !== false &&
    termReason === 'NO_TOOL_CALL' &&
    !isPlanHandover;

  if (state.activeTurn && state.activeTurn.userStepIndex === null && latestUser) {
    if (
      state.activeTurn.minUserStepIndex === null ||
      state.activeTurn.minUserStepIndex === undefined ||
      latestUser.stepIndex > state.activeTurn.minUserStepIndex
    ) {
      state.activeTurn.userStepIndex = latestUser.stepIndex;
      state.activeTurn.minUserStepIndex = null;
    }
  }

  const hasNewerUser = Boolean(
    latestUser &&
      state.activeTurn &&
      state.activeTurn.userStepIndex !== null &&
      latestUser.stepIndex > state.activeTurn.userStepIndex
  );

  if (hasNewerUser) {
    if (state.activeTurn) {
      const completed = finalizeActiveTurn(state, { terminationReason: 'TURN_REPLACED', now });
      collapseSupersededTurnHud(state, completed, now);
    }
    return {};
  }

  const usableEmbedded = pickUsableHudFile(state.artifactDirectoryPath, embeddedHudFile);
  const usableActive = pickUsableHudFile(state.artifactDirectoryPath, activeHudFile);

  if (state.activeTurn) {
    if (turnTokens && turnTokens.total > 0) {
      state.activeTurn.tokens = { ...turnTokens };
    }
    if (usableEmbedded) {
      state.activeTurn.hasUserEmbed = true;
    }
    if (!state.activeTurn.hudFileName && (usableEmbedded || usableActive)) {
      state.activeTurn.hudFileName = usableEmbedded || usableActive;
    }
  }

  // 防提前中断兜底：若模型仅输出了 <agent-embed> 而未同时调用下一步业务工具，且任务尚未完成，则自动阻塞 Stop 并续跑 1 次
  const preStopFile = state.activeTurn?.hudFileName || usableEmbedded || usableActive || '';
  if (
    fullyDone &&
    !payload.continuationActive &&
    state.activeTurn &&
    !state.activeTurn.stopContinuedOnce &&
    preStopFile &&
    typeof lastPlannerText === 'string' &&
    /<agent-embed\b/i.test(lastPlannerText) &&
    lastPlannerText.replace(/<agent-embed[\s\S]*?<\/agent-embed>/gi, '').trim() === ''
  ) {
    let preParsed = parseArtifactHudHtml(state.artifactDirectoryPath, now, preStopFile);
    if (!preParsed && state.artifactDirectoryPath) {
      const seeded = seedDefaultHudTasksIfEmpty(state.artifactDirectoryPath, preStopFile, {
        userInput: state.activeTurn.userInput,
      });
      if (seeded) {
        state.activeTurn.autoSeededSlot = preStopFile;
      }
      preParsed = parseArtifactHudHtml(state.artifactDirectoryPath, now, preStopFile);
    }
    const hasUnfinished = !preParsed || Boolean(preParsed?.tasks?.some((t) => t.status !== 'completed'));
    if (hasUnfinished) {
      state.activeTurn.stopContinuedOnce = true;
      applyParsedHudToState(state, latestHud, {
        turnFinished: false,
        now,
        preferredFileName: preStopFile,
      });
      syncArtifactHudFile(state.artifactDirectoryPath, state, {
        turnFinished: false,
        now,
        targetFileName: preStopFile,
      });
      return {
        decision: 'continue',
        reason: `仅输出了 <agent-embed> 未调工具，请继续执行 ${preStopFile} 未完成任务后再总结。`,
      };
    }
  }

  if (isPlanHandover && state.activeTurn?.hudFileName && state.artifactDirectoryPath) {
    advanceAutoSeededHudForPlanHandover(state.artifactDirectoryPath, state.activeTurn.hudFileName);
  }

  let completed = null;
  if (state.activeTurn && !isPlanHandover) {
    completed = finalizeActiveTurn(state, {
      terminationReason: termReason,
      now,
    });
    if (!fullyDone && completed) {
      completed.interrupted = true;
    }
  }

  let cleanedOrphan = false;
  if (
    (fullyDone || termReason === 'USER_CANCELED') &&
    !isPlanHandover &&
    completed?.autoSeededSlot &&
    !usableEmbedded &&
    !completed?.hasUserEmbed
  ) {
    cleanedOrphan = clearAutoSeededHudSlot(state.artifactDirectoryPath, completed.autoSeededSlot);
    if (cleanedOrphan) {
      completed.hudFileName = '';
      if (state.lastCompletedTurn === completed) {
        state.lastCompletedTurn.hudFileName = '';
      }
      state.taskTitle = '';
      state.summary = '';
      state.logs = [];
      state.tasks = [];
    }
  }

  const sameTurnLastFile =
    !state.activeTurn &&
    !completed &&
    state.lastCompletedTurn &&
    !isTurnInterrupted(state.lastCompletedTurn) &&
    !state.lastCompletedTurn.hudCollapsed &&
    latestUser &&
    state.lastCompletedTurn.userStepIndex === latestUser.stepIndex
      ? state.lastCompletedTurn.hudFileName
      : '';

  const targetFileName = cleanedOrphan
    ? ''
    : state.activeTurn?.hudFileName ||
      completed?.hudFileName ||
      usableEmbedded ||
      usableActive ||
      sameTurnLastFile ||
      '';

  if (targetFileName && !completed?.hudCollapsed) {
    if (!fullyDone && !isPlanHandover) {
      applyParsedHudToState(state, latestHud, {
        turnFinished: false,
        now,
        preferredFileName: targetFileName,
      });
      syncArtifactHudFile(state.artifactDirectoryPath, state, {
        turnFinished: false,
        turnInterrupted: true,
        terminationReason: termReason,
        now,
        targetFileName,
      });
    } else {
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
  }
  const endTargetFile =
    normalizeEndHudFileName(embeddedEndHudFile) ||
    normalizeEndHudFileName(state.activeTurn?.endHudFileName) ||
    normalizeEndHudFileName(completed?.endHudFileName);
  if (endTargetFile && state.artifactDirectoryPath) {
    syncEndHudFile(state.artifactDirectoryPath, state, {
      turnFinished: true,
      now,
      targetFileName: endTargetFile,
    });
  }
  return {};
}

let currentPayload = null;
let currentRawInput = '';

function fallbackOutputOnHookError(payload, rawInput = '') {
  if (payload?.hookEventName === 'PreToolUse') {
    return defaultPreToolUseOutput(payload);
  }
  if (/"hookEventName"\s*:\s*"PreToolUse"/.test(rawInput)) {
    return {
      decision: /"name"\s*:\s*"run_command"/i.test(rawInput) ? 'ask' : 'allow',
    };
  }
  return {};
}

async function main() {
  const raw = await readStdinText();
  currentRawInput = raw;
  let payload = {};
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
    currentPayload = payload;
  } catch {
    process.stdout.write(JSON.stringify(fallbackOutputOnHookError(null, raw)) + '\n');
    return;
  }

  const dataDir = resolveDataDir();
  const convId = sanitizeConversationId(payload.conversationId);
  const eventName = String(payload.hookEventName || '');

  if (!convId) {
    const out = eventName === 'PreToolUse' ? defaultPreToolUseOutput(payload) : {};
    process.stdout.write(JSON.stringify(out) + '\n');
    return;
  }

  let output = {};
  try {
    recordActiveConversation(convId, { lastEvent: eventName }, dataDir);
    const state = loadConversationState(convId, dataDir);
    const settings = loadSettings(dataDir);

    if (eventName === 'SessionStart') {
      output = handleSessionStart(payload, state);
    } else if (eventName === 'PreInvocation') {
      output = handlePreInvocation(payload, state, settings);
    } else if (eventName === 'PreToolUse') {
      output = handlePreToolUse(payload, state);
    } else if (eventName === 'PostToolUse') {
      output = handlePostToolUse(payload, state);
    } else if (eventName === 'PostInvocation') {
      output = handlePostInvocation(payload, state);
    } else if (eventName === 'Stop') {
      output = handleStop(payload, state);
    }

    saveConversationState(state, dataDir);
  } catch {
    output = eventName === 'PreToolUse' ? defaultPreToolUseOutput(payload) : {};
  }

  process.stdout.write(JSON.stringify(output) + '\n');
}

main().catch(() => {
  process.stdout.write(JSON.stringify(fallbackOutputOnHookError(currentPayload, currentRawInput)) + '\n');
});
