(() => {
  const POLL_MS = 1400;
  const $ = (id) => document.getElementById(id);

  const state = {
    etag: '',
    snap: null,
    clockOffsetMs: 0,
    expandedTurns: new Set(),
  };

  function syncScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f8fafc)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    document.documentElement.dataset.theme = lum < 0.5 ? 'dark' : 'light';
  }
  syncScheme();
  new MutationObserver(syncScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  function formatDuration(ms) {
    const totalSec = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    if (totalSec < 60) return `${totalSec}s`;
    const hours = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
    return `${mins}m ${secs}s`;
  }

  function formatClock(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    return d.toLocaleTimeString('zh-CN', { hour12: false });
  }

  function summarizeStats(stats) {
    if (!stats) return '';
    const parts = [];
    if (stats.commands > 0) parts.push(`运行 ${stats.commands} 条命令`);
    if (stats.searches > 0) parts.push(`检索 ${stats.searches} 次`);
    if (stats.fileReads > 0) parts.push(`读取 ${stats.fileReads} 个文件`);
    if (stats.fileEdits > 0) parts.push(`编辑 ${stats.fileEdits} 个文件`);
    if (stats.subagents > 0) parts.push(`调度 ${stats.subagents} 个子代理`);
    if (stats.otherTools > 0 && parts.length === 0) parts.push(`执行 ${stats.otherTools} 次工具`);
    if (stats.failures > 0) parts.push(`失败 ${stats.failures} 次`);
    return parts.join('，');
  }

  function taskIconSvg(status) {
    if (status === 'completed') {
      return '<svg viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="8" r="6.5" fill="currentColor" opacity="0.72"/><path d="M5.2 8.2l2 2 3.8-4.2" fill="none" stroke="var(--hud-card, #fff)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
    if (status === 'in_progress') {
      return '<svg viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="8" r="6" fill="none" stroke="var(--hud-accent)" stroke-width="1.6"/><circle cx="8" cy="8" r="2.6" fill="var(--hud-accent)"/></svg>';
    }
    if (status === 'failed') {
      return '<svg viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="8" r="6.5" fill="var(--hud-error)"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>';
    }
    return '<svg viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2.5 2.5" opacity="0.55"/></svg>';
  }

  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  function renderTimers() {
    const snap = state.snap;
    if (!snap) return;

    const now = Date.now() + state.clockOffsetMs;
    const dot = $('status-dot');
    const prefix = $('timer-prefix');
    const value = $('timer-value');
    const statsLine = $('stats-line');
    const toolBar = $('active-tool-bar');
    const toolLabel = $('active-tool-label');
    const toolTimer = $('active-tool-timer');

    dot.className = `status-dot ${snap.status || 'idle'}`;

    if (snap.status === 'running' && snap.activeTurn) {
      const elapsed = Math.max(0, now - (snap.activeTurn.startedAt || now));
      prefix.textContent = `第 ${snap.activeTurn.turnIndex || 1} 轮进行中 · 已用时`;
      value.textContent = formatDuration(elapsed);
      const s = summarizeStats(snap.activeTurn.stats);
      statsLine.textContent = s || '正在分析并准备执行步骤…';
    } else if (snap.lastCompletedTurn) {
      prefix.textContent = `第 ${snap.lastCompletedTurn.turnIndex || 1} 轮 · 用时`;
      value.textContent = formatDuration(snap.lastCompletedTurn.elapsedMs);
      const s = summarizeStats(snap.lastCompletedTurn.stats);
      statsLine.textContent = s || '本轮直接回答，未调用外部工具';
    } else {
      prefix.textContent = '等待对话';
      value.textContent = '—';
      statsLine.textContent = '暂无工具执行记录';
    }

    const activeTool = snap.activeTurn?.activeTool;
    if (snap.status === 'running' && activeTool) {
      toolBar.classList.remove('hidden');
      toolLabel.textContent = activeTool.label || activeTool.name || '正在执行工具';
      toolTimer.textContent = formatDuration(Math.max(0, now - (activeTool.startedAt || now)));
    } else {
      toolBar.classList.add('hidden');
    }
  }

  function renderBody() {
    const snap = state.snap;
    if (!snap) return;

    const summaryEl = $('summary-line');
    if (snap.summary) {
      summaryEl.textContent = snap.summary;
      summaryEl.classList.remove('empty');
    } else {
      summaryEl.textContent = '开始多步骤任务或提问后，这里会实时显示阶段总结与进度。';
      summaryEl.classList.add('empty');
    }

    const tasks = Array.isArray(snap.tasks) ? snap.tasks : [];
    const headerEl = $('task-card-header');
    const titleEl = $('task-title');
    const badgeEl = $('task-progress-badge');
    const listEl = $('task-list');
    const emptyEl = $('task-empty');

    if (tasks.length > 0) {
      emptyEl.classList.add('hidden');
      const doneCount = tasks.filter((t) => t.status === 'completed').length;
      if (snap.taskTitle) {
        headerEl.classList.remove('hidden');
        titleEl.textContent = snap.taskTitle;
        badgeEl.textContent = `${doneCount}/${tasks.length}`;
      } else {
        headerEl.classList.remove('hidden');
        titleEl.textContent = '任务清单';
        badgeEl.textContent = `${doneCount}/${tasks.length}`;
      }
      listEl.innerHTML = tasks
        .map(
          (t) => `
          <li class="task-item ${esc(t.status)}">
            <span class="task-icon" aria-hidden="true">${taskIconSvg(t.status)}</span>
            <span class="task-item-text">${esc(t.title)}</span>
          </li>`,
        )
        .join('');
    } else {
      headerEl.classList.add('hidden');
      listEl.innerHTML = '';
      emptyEl.classList.remove('hidden');
    }

    const turns = Array.isArray(snap.turns) ? snap.turns : [];
    $('turns-count').textContent = String(turns.length);
    const turnsList = $('turns-list');
    const turnsEmpty = $('turns-empty');

    if (turns.length === 0) {
      turnsList.innerHTML = '';
      turnsEmpty.classList.remove('hidden');
    } else {
      turnsEmpty.classList.add('hidden');
      turnsList.innerHTML = turns
        .map((turn) => {
          const id = String(turn.turnIndex);
          const expanded = state.expandedTurns.has(id);
          const promptText = turn.userInput || '（无文本输入）';
          const statSummary = summarizeStats(turn.stats) || '纯文本回复';
          return `
            <div class="turn-card ${expanded ? 'expanded' : ''}" data-turn="${esc(id)}">
              <button class="turn-row" type="button">
                <span class="turn-index">#${esc(id)}</span>
                <span class="turn-duration">用时 ${esc(formatDuration(turn.elapsedMs))}</span>
                <span class="turn-prompt">${esc(promptText)}</span>
                <span class="turn-chevron">›</span>
              </button>
              <div class="turn-detail">
                <div class="turn-detail-prompt">${esc(promptText)}</div>
                <div>时间：${esc(formatClock(turn.startedAt))} → ${esc(formatClock(turn.endedAt))}</div>
                <div>统计：${esc(statSummary)}</div>
              </div>
            </div>`;
        })
        .join('');

      turnsList.querySelectorAll('.turn-row').forEach((btn) => {
        btn.addEventListener('click', () => {
          const card = btn.closest('.turn-card');
          const id = card?.dataset.turn;
          if (!id) return;
          if (state.expandedTurns.has(id)) {
            state.expandedTurns.delete(id);
            card.classList.remove('expanded');
          } else {
            state.expandedTurns.add(id);
            card.classList.add('expanded');
          }
        });
      });
    }

    $('btn-toggle-prev').classList.toggle('active', Boolean(snap.settings?.injectPreviousTurnTimerInChat));
    $('btn-toggle-mid').classList.toggle('active', Boolean(snap.settings?.injectProgressInChat));
  }

  function currentConversationId() {
    const params = new URLSearchParams(location.search);
    return window.sidecar?.conversationId || params.get('conversationId') || '';
  }

  async function apiGet(path) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function apiPost(path, body) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function poll() {
    try {
      const conv = currentConversationId();
      const qs = new URLSearchParams();
      if (conv) qs.set('conversationId', conv);
      if (state.etag) qs.set('etag', state.etag);
      const data = await apiGet(`/api/hud?${qs.toString()}`);
      if (data.serverNow) {
        state.clockOffsetMs = data.serverNow - Date.now();
      }
      if (data.unchanged) {
        renderTimers();
        return;
      }
      state.etag = data.etag || '';
      state.snap = data;
      renderTimers();
      renderBody();
    } catch {
      // ignore transient poll failure
    }
  }

  $('btn-toggle-prev').addEventListener('click', async () => {
    const cur = Boolean(state.snap?.settings?.injectPreviousTurnTimerInChat);
    const res = await apiPost('/api/settings', { injectPreviousTurnTimerInChat: !cur });
    if (res?.settings && state.snap) {
      state.snap.settings = res.settings;
      state.etag = '';
      renderBody();
    }
  });

  $('btn-toggle-mid').addEventListener('click', async () => {
    const cur = Boolean(state.snap?.settings?.injectProgressInChat);
    const res = await apiPost('/api/settings', { injectProgressInChat: !cur });
    if (res?.settings && state.snap) {
      state.snap.settings = res.settings;
      state.etag = '';
      renderBody();
    }
  });

  poll();
  setInterval(poll, POLL_MS);
  setInterval(renderTimers, 1000);
})();
