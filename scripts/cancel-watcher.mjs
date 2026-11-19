import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { basename, dirname, join } from 'node:path';
import {
  clearAutoSeededHudSlot,
  finalizeActiveTurn,
  loadConversationState,
  normalizeAndAdvanceTasks,
  normalizeHudFileName,
  parseArtifactHudHtml,
  readJsonSafe,
  resolveDataDir,
  sanitizeConversationId,
  saveConversationState,
  syncArtifactHudFile,
} from './state-store.mjs';

export function normalizeTerminationReason(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (!s) return '';
  return s.startsWith('EXECUTOR_TERMINATION_REASON_')
    ? s.slice('EXECUTOR_TERMINATION_REASON_'.length)
    : s;
}

export function parseLsAddress(rawAddr) {
  const raw = String(rawAddr || '').trim();
  if (!raw) return null;
  const withProto = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withProto);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (!hostname || !Number.isInteger(port) || port <= 0 || port > 65535) {
      return null;
    }
    return { hostname, port };
  } catch {
    return null;
  }
}

export function fetchCascadeSummaries({
  lsAddress = process.env.ANTIGRAVITY_LS_ADDRESS || '',
  csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN || '',
  timeoutMs = 3000,
} = {}) {
  const parsedAddr = parseLsAddress(lsAddress);
  if (!parsedAddr || !csrfToken) {
    return Promise.reject(new Error('缺少有效的 ANTIGRAVITY_LS_ADDRESS 或 ANTIGRAVITY_CSRF_TOKEN'));
  }

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ excludeSubtrajectories: false });
    const req = httpRequest(
      {
        hostname: parsedAddr.hostname,
        port: parsedAddr.port,
        method: 'POST',
        path: '/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': csrfToken,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';
        let bytes = 0;
        let settled = false;
        const fail = (err) => {
          if (settled) return;
          settled = true;
          reject(err);
          req.destroy();
        };

        res.setEncoding('utf-8');
        res.on('error', fail);
        res.on('data', (chunk) => {
          if (settled) return;
          bytes += Buffer.byteLength(chunk);
          if (bytes > 16 * 1024 * 1024) {
            fail(new Error('GetAllCascadeTrajectories 响应超过大小上限'));
            return;
          }
          raw += chunk;
        });
        res.on('end', () => {
          if (settled) return;
          if (res.statusCode !== 200) {
            settled = true;
            reject(new Error(`GetAllCascadeTrajectories 返回 HTTP ${res.statusCode}`));
            return;
          }
          try {
            const data = JSON.parse(raw || '{}');
            settled = true;
            resolve(data?.trajectorySummaries && typeof data.trajectorySummaries === 'object' ? data.trajectorySummaries : {});
          } catch (err) {
            settled = true;
            reject(new Error(`GetAllCascadeTrajectories JSON 解析失败: ${err.message}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('GetAllCascadeTrajectories 请求超时'));
    });
    req.end(body);
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

function inspectLatestTurnTranscript(transcriptPath, targetHudFileName = '') {
  const target = resolveCompactTranscriptPath(transcriptPath);
  const normTarget = normalizeHudFileName(targetHudFileName);
  if (!target) {
    return { lastPlannerHasExitPlanMode: false, hasEmbeddedHud: false };
  }
  try {
    const raw = readFileSync(target, 'utf-8');
    const lines = raw.trim().split('\n');
    let sawLastPlanner = false;
    let lastPlannerHasExitPlanMode = false;
    let hasEmbeddedHud = false;

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj?.type === 'USER_INPUT') {
        break;
      }
      if (obj?.type === 'PLANNER_RESPONSE') {
        if (!sawLastPlanner) {
          sawLastPlanner = true;
          if (Array.isArray(obj.tool_calls)) {
            lastPlannerHasExitPlanMode = obj.tool_calls.some(
              (tc) => String(tc?.name || '').toLowerCase() === 'exit_plan_mode'
            );
          }
        }
        if (normTarget && typeof obj?.content === 'string') {
          const embedRe = /<agent-embed\b[^>]*\bsrc=["'][^"']*?(task-hud(?:-t\d+|-\d+|-end)?\.html)["'][^>]*>/gi;
          for (const m of obj.content.matchAll(embedRe)) {
            if (normalizeHudFileName(m[1]) === normTarget) {
              hasEmbeddedHud = true;
            }
          }
        }
      }
    }
    return { lastPlannerHasExitPlanMode, hasEmbeddedHud };
  } catch {
    return { lastPlannerHasExitPlanMode: false, hasEmbeddedHud: false };
  }
}

const INTERRUPTED_TERMINATION_REASONS = new Set([
  'ERROR',
  'MAX_INVOCATIONS',
  'MAX_FORCED_INVOCATIONS',
  'MAX_TOKEN_BUDGET_EXCEEDED',
  'TERMINAL_CUSTOM_HOOK',
]);

/**
 * 创建常驻取消监护器：轮询活跃会话在 LS 中的真实运行状态，在宿主未触发 Stop Hook 时兜底停止计时并折叠面板。
 */
export function createCancelWatcher(options = {}) {
  const {
    dataDir = resolveDataDir(),
    lsAddress = process.env.ANTIGRAVITY_LS_ADDRESS || '',
    csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN || '',
    pollIntervalMs = 1000,
    fetchSummaries: customFetchSummaries = null,
    logger = null,
  } = options;

  const fileCache = new Map();
  const seenRunning = new Map();
  const idleObserved = new Map();
  let rpcBackoffUntil = 0;
  let inFlight = null;
  let timer = null;

  function scanActiveStates() {
    const convDir = join(dataDir, 'conversations');
    if (!existsSync(convDir)) return [];

    let entries = [];
    try {
      entries = readdirSync(convDir);
    } catch {
      return [];
    }

    const presentFiles = new Set();
    const activeList = [];

    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      presentFiles.add(name);
      const filePath = join(convDir, name);
      let st;
      try {
        st = statSync(filePath);
      } catch {
        fileCache.delete(name);
        continue;
      }

      const cached = fileCache.get(name);
      // 非活跃历史文件未变化时跳过磁盘 JSON 解析；已知活跃的文件每次直接重读以防同毫秒写入漏检
      if (cached && !cached.hasActiveTurn && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        continue;
      }

      const parsed = readJsonSafe(filePath, null);
      const hasActiveTurn = Boolean(parsed && typeof parsed === 'object' && parsed.activeTurn);
      fileCache.set(name, { mtimeMs: st.mtimeMs, size: st.size, hasActiveTurn });

      if (!hasActiveTurn) continue;
      const convId = sanitizeConversationId(parsed.conversationId || name.slice(0, -5));
      if (!convId) continue;
      activeList.push({ convId, filePath, state: parsed });
    }

    for (const cachedName of fileCache.keys()) {
      if (!presentFiles.has(cachedName)) {
        fileCache.delete(cachedName);
      }
    }

    return activeList;
  }

  function settleConversation(convId, snapshotState, { terminationReason, turnFinished, endedAt }) {
    const freshState = loadConversationState(convId, dataDir);
    const freshTurn = freshState.activeTurn;
    if (
      !freshTurn ||
      freshTurn.turnIndex !== snapshotState.activeTurn?.turnIndex ||
      freshTurn.startedAt !== snapshotState.activeTurn?.startedAt ||
      freshState.updatedAt !== snapshotState.updatedAt
    ) {
      return false;
    }

    const hudFileName = freshTurn.hudFileName || '';
    let isOrphanAutoSlot = false;

    if (hudFileName && !freshTurn.hudCollapsed && freshState.artifactDirectoryPath) {
      const tCheck = inspectLatestTurnTranscript(freshState.transcriptPath, hudFileName);
      if (
        freshTurn.autoSeededSlot &&
        freshTurn.autoSeededSlot === hudFileName &&
        !freshTurn.hasUserEmbed &&
        !tCheck.hasEmbeddedHud
      ) {
        isOrphanAutoSlot = true;
      } else {
        const parsedHud = parseArtifactHudHtml(freshState.artifactDirectoryPath, endedAt, hudFileName);
        if (parsedHud) {
          if (parsedHud.taskTitle) freshState.taskTitle = parsedHud.taskTitle;
          if (parsedHud.summary) freshState.summary = parsedHud.summary;
          if (Array.isArray(parsedHud.logs) && parsedHud.logs.length > 0) {
            freshState.logs = parsedHud.logs;
          }
          if (Array.isArray(parsedHud.tasks) && parsedHud.tasks.length > 0) {
            freshState.tasks = normalizeAndAdvanceTasks(parsedHud.tasks, { turnFinished, now: endedAt });
          }
        }
      }
    }

    const completed = finalizeActiveTurn(freshState, { terminationReason, now: endedAt });
    if (!turnFinished && completed) {
      completed.interrupted = true;
    }

    if (isOrphanAutoSlot) {
      const cleaned = clearAutoSeededHudSlot(freshState.artifactDirectoryPath, hudFileName);
      if (cleaned) {
        if (completed) completed.hudFileName = '';
        if (freshState.lastCompletedTurn === completed) {
          freshState.lastCompletedTurn.hudFileName = '';
        }
        freshState.taskTitle = '';
        freshState.summary = '';
        freshState.logs = [];
        freshState.tasks = [];
      }
    } else if (hudFileName && !completed?.hudCollapsed && freshState.artifactDirectoryPath) {
      syncArtifactHudFile(freshState.artifactDirectoryPath, freshState, {
        turnFinished,
        turnInterrupted: !turnFinished,
        terminationReason,
        now: endedAt,
        targetFileName: hudFileName,
      });
    }

    saveConversationState(freshState, dataDir);
    seenRunning.delete(convId);
    idleObserved.delete(convId);
    fileCache.delete(`${convId}.json`);
    return true;
  }

  async function runTick(now = Date.now()) {
    const activeEntries = scanActiveStates();
    if (activeEntries.length === 0) {
      seenRunning.clear();
      idleObserved.clear();
      return { checked: 0, settled: [] };
    }

    const activeIds = new Set(activeEntries.map((item) => item.convId));
    for (const id of seenRunning.keys()) {
      if (!activeIds.has(id)) seenRunning.delete(id);
    }
    for (const id of idleObserved.keys()) {
      if (!activeIds.has(id)) idleObserved.delete(id);
    }

    if (now < rpcBackoffUntil) {
      return { checked: activeEntries.length, settled: [], skipped: 'backoff' };
    }

    if (!customFetchSummaries && (!parseLsAddress(lsAddress) || !csrfToken)) {
      return { checked: activeEntries.length, settled: [], skipped: 'no_credentials' };
    }

    let summaries;
    try {
      summaries = customFetchSummaries
        ? await customFetchSummaries()
        : await fetchCascadeSummaries({ lsAddress, csrfToken });
    } catch (err) {
      rpcBackoffUntil = now + 5000;
      if (typeof logger === 'function') {
        logger(`[cancel-watcher] RPC failed: ${err?.message || err}`);
      }
      return { checked: activeEntries.length, settled: [], error: err?.message || 'rpc_failed' };
    }

    const settled = [];

    for (const { convId, state } of activeEntries) {
      const activeTurn = state.activeTurn;
      if (!activeTurn) continue;
      const turnKey = `${activeTurn.turnIndex}:${activeTurn.startedAt}`;
      const summary = summaries && typeof summaries === 'object' ? summaries[convId] : undefined;

      const computeEndedAt = (lastModMs) => {
        const seen = seenRunning.get(convId);
        const recentlyRunning = Boolean(seen && seen.turnKey === turnKey && now - seen.at <= 10000);
        const freshActivity = now - Math.max(Number.isFinite(lastModMs) ? lastModMs : 0, state.updatedAt || 0) <= 15000;
        if (recentlyRunning || freshActivity) {
          return Math.max(now, activeTurn.startedAt || now);
        }
        return Math.max(
          Number.isFinite(lastModMs) ? lastModMs : 0,
          state.updatedAt || 0,
          activeTurn.startedAt || 0
        );
      };

      if (summary == null) {
        if (summaries && typeof summaries === 'object' && now - (state.updatedAt || 0) >= 60000) {
          const endedAt = Math.max(state.updatedAt || 0, activeTurn.startedAt || 0);
          if (settleConversation(convId, state, { terminationReason: 'SESSION_INACTIVE', turnFinished: false, endedAt })) {
            settled.push({ convId, terminationReason: 'SESSION_INACTIVE' });
          }
        }
        continue;
      }

      const runStatus = String(summary.status || '');
      if (/RUNNING/i.test(runStatus)) {
        seenRunning.set(convId, { turnKey, at: now });
        idleObserved.delete(convId);
        continue;
      }

      if (/WAITING/i.test(runStatus)) {
        idleObserved.delete(convId);
        continue;
      }

      if (/IDLE|CANCELED|CANCELLED|STOPPED/i.test(runStatus)) {
        if (
          activeTurn.userStepIndex !== null &&
          activeTurn.userStepIndex !== undefined &&
          summary.lastUserInputStepIndex !== undefined &&
          summary.lastUserInputStepIndex !== null &&
          Number(summary.lastUserInputStepIndex) < Number(activeTurn.userStepIndex)
        ) {
          continue;
        }
        if (
          (activeTurn.userStepIndex === null || activeTurn.userStepIndex === undefined) &&
          summary.lastUserInputTime
        ) {
          const inputMs = Date.parse(summary.lastUserInputTime);
          if (Number.isFinite(inputMs) && inputMs < (activeTurn.startedAt || 0) - 15000) {
            continue;
          }
        }

        const reason = normalizeTerminationReason(summary.latestExecutorTerminationReason);
        const lastModMs = Date.parse(summary.lastModifiedTime || '');
        const prevIdle = idleObserved.get(convId);
        const hasObservedIdle = Boolean(prevIdle && prevIdle.turnKey === turnKey && prevIdle.reason === reason);
        if (!hasObservedIdle) {
          idleObserved.set(convId, { turnKey, firstAt: now, reason });
        }

        if (reason === 'USER_CANCELED') {
          if (now - (state.updatedAt || 0) < 500 && !hasObservedIdle) {
            continue;
          }
          const endedAt = computeEndedAt(lastModMs);
          if (settleConversation(convId, state, { terminationReason: 'USER_CANCELED', turnFinished: false, endedAt })) {
            settled.push({ convId, terminationReason: 'USER_CANCELED' });
          }
        } else if (INTERRUPTED_TERMINATION_REASONS.has(reason)) {
          if (now - (state.updatedAt || 0) >= 2500 && hasObservedIdle) {
            const endedAt = computeEndedAt(lastModMs);
            if (settleConversation(convId, state, { terminationReason: reason, turnFinished: false, endedAt })) {
              settled.push({ convId, terminationReason: reason });
            }
          }
        } else if (reason === 'NO_TOOL_CALL') {
          if (now - (state.updatedAt || 0) >= 15000 && hasObservedIdle) {
            const tCheck = inspectLatestTurnTranscript(state.transcriptPath, activeTurn.hudFileName);
            if (!tCheck.lastPlannerHasExitPlanMode) {
              const endedAt = computeEndedAt(lastModMs);
              if (settleConversation(convId, state, { terminationReason: 'NO_TOOL_CALL', turnFinished: true, endedAt })) {
                settled.push({ convId, terminationReason: 'NO_TOOL_CALL' });
              }
            }
          }
        }
      }
    }

    return { checked: activeEntries.length, settled };
  }

  function tick(now = Date.now()) {
    if (inFlight) return inFlight;
    inFlight = runTick(now).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function start() {
    if (timer) return;
    tick().catch(() => {});
    timer = setInterval(() => {
      tick().catch(() => {});
    }, pollIntervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { tick, start, stop };
}
