import { commandDetails, createHistory, expandedCommands } from './history.js';
import { createHistoryCache, clearHistoryCache } from './history-cache.js';
import { createModelChoices } from './model-picker.js';
import { createAgentQuestions } from './agent-questions.js';

const byId = (id) => document.getElementById(id);
const labels = { running: '运行中', completed: '已完成', failed: '失败', waiting: '待审批', interrupted: '已中断' };
const folderName = (p) => String(p || '').replace(/[\\\\/]+$/, '').split(/[\\\\/]/).pop() || String(p || '');
const deviceStorage = 'remote-panel-device-v2';
const themeStorage = 'remote-panel-theme-v1';

let token = localStorage.getItem(deviceStorage) || '';
const historyCache = createHistoryCache(() => token);
let selectedTask = '';
let polling;
let nextPoll = 0;
let renderedPoll = 0;
let online = false;
let submitting = false;
let current = null;
let historyKey = '';
let approvalKey = '';
let questionsKey = '';
const questionDrafts = new Map();
const pendingQuestionIds = new Set();
let agentQuestions = null;
let commandKey = '';
let submission;
let stageMode = 'task'; // 'new' | 'task' | 'thread'
let latestUnread = false; // dock "back to latest" unread state (original thread mode)
const LATEST_SLACK = 64; // shared near-bottom threshold for the dock latest button
let resumeTarget = null;
let resumePending = false;
let activeThread = null;
let sidebarTab = 'tasks'; // 'tasks' | 'codex'
let drawerOpen = false;
let returnToTaskAfterThread = '';
let threadHistoryPushed = false;
let activityHost = null;
let activityThreadId = '';
let activityPayload = null;
let activityKey = '';
let activityInflight = null;
let activityInflightId = '';
let activityNextAt = 0;
const promoteInflight = new Set();
let threadDeliveryPending = null;
let threadDeliveryOwnTaskId = '';
let threadDeliveryReceiptTimer;
let threadDeliveryKey = '';
let threadDeliveryDraft = '';

/* ---------- Model & Effort Choices ---------- */
const modelChoices = createModelChoices();
let modelsRequested = false;

function modelContext() {
  return workspacePayload(resumeTarget, project).resumeThreadId ?? null;
}

function renderModelControls() {
  const choice = modelChoices.get(modelContext());
  const catalog = modelChoices.models();
  const modelSelect = byId('model-select');
  const effortSelect = byId('effort-select');
  modelSelect.replaceChildren(...catalog.map((entry) => new Option(entry.displayName, entry.id)));
  const fallback = catalog.find((entry) => entry.isDefault)?.id || catalog[0]?.id || '';
  const selectedId = choice.model || fallback;
  if (selectedId) modelSelect.value = selectedId;
  const entry = catalog.find((item) => item.id === modelSelect.value) || null;
  const efforts = entry ? entry.supportedReasoningEfforts : [];
  effortSelect.replaceChildren(...efforts.map((value) => new Option(value, value)));
  const effort = choice.effort && efforts.includes(choice.effort) ? choice.effort : (entry?.defaultReasoningEffort || efforts[0] || '');
  if (effort) effortSelect.value = effort;
  effortSelect.disabled = !efforts.length;
  byId('engine-label').textContent = entry ? `${entry.displayName} · ${choice.effort || '随电脑端设置'}` : '随电脑端设置';
}

async function ensureModels() {
  if (modelsRequested) return;
  modelsRequested = true;
  try {
    modelChoices.setModels(await api('/api/codex/models'));
  } catch (error) {
    modelsRequested = false;
    if (error.status === 401) { logout(error.message); return; }
  }
  renderModelControls();
}
let threadReturn = null;
let project = null;
let taskPage = [];
let moreTaskOffset;
let pendingApprovalIds = new Set();

const mqWide = matchMedia('(min-width: 1200px)');

/* ---------- Theme & Android Bridge ---------- */
function applyTheme(next) {
  const theme = next === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem(themeStorage, theme); } catch {}
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'dark' ? '#1A1C22' : '#FFFFFF';
  const label = byId('popover-theme-text');
  if (label) label.textContent = theme === 'dark' ? '切换浅色外观' : '切换深色外观';
}
applyTheme(localStorage.getItem(themeStorage) || 'light');

function toggleTheme() {
  applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
}

const hasAndroidBridge = typeof window.AndroidBridge === 'object' && window.AndroidBridge !== null;
if (hasAndroidBridge) {
  byId('menu-change-host').hidden = false;
  byId('login-change-host').hidden = false;
  byId('menu-change-host').onclick = () => window.AndroidBridge.openSetup();
  byId('login-change-host').onclick = () => window.AndroidBridge.openSetup();
}

/* ---------- API & Helpers ---------- */
async function api(path, data) {
  const response = await fetch(path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const value = await response.json();
  if (!response.ok) {
    const error = new Error(value.error || '连接失败。');
    error.status = response.status;
    throw error;
  }
  return value;
}

function errorAt(id, message = '') {
  const el = byId(id);
  if (!el) return;
  el.textContent = message;
  el.hidden = !message;
}

function formatTime(ts) {
  if (!Number.isFinite(ts)) return '';
  const ms = ts < 1e12 ? ts * 1000 : ts;
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function showConnection(connected, label, reconnecting = false) {
  online = connected;
  const conn = byId('connection');
  if (conn) {
    conn.textContent = `● ${label}`;
    conn.classList.toggle('online', connected);
    conn.classList.toggle('reconnecting', !connected && reconnecting);
  }
  const loginConn = byId('login-connection');
  if (loginConn) loginConn.textContent = label;
  const pill = byId('engine-trigger');
  if (pill) {
    pill.classList.toggle('online', connected);
    pill.classList.toggle('reconnecting', !connected && reconnecting);
  }
  byId('offline-banner').hidden = !(!connected && reconnecting && !byId('panel').hidden);
  updateSubmit();
}

/* ---------- Drawer, Stage Mode & Android Back ---------- */
function setDrawer(open) {
  drawerOpen = open;
  byId('panel').classList.toggle('drawer-open', open);
}

function clearResume() {
  resumeTarget = null;
  resumePending = false;
  activeThread = null;
}

function syncResumeContext() {
  const inThread = stageMode === 'thread';
  const hasTarget = Boolean(resumeTarget?.id);
  const loading = inThread && resumePending && !resumeTarget;
  byId('resume-banner').hidden = !inThread;
  byId('resume-banner-text').textContent = hasTarget ? '接续此会话' : '正在确认会话…';
  byId('new-from-thread').textContent = '新建任务';
  const chip = byId('resume-loading-chip');
  if (loading) {
    if (chip) return;
    const pending = document.createElement('span');
    pending.id = 'resume-loading-chip';
    pending.className = 'attached-chip';
    pending.textContent = '正在载入会话…';
    byId('composer-context').append(pending);
  } else if (chip) {
    chip.remove();
  }
}

/* ---------- Original-Thread Delivery ---------- */
// Pure state model for the in-thread delivery notice. Server truth wins for the exact
// thread; a local optimistic 已提交 marker covers the gap before the next poll confirms
// the submitted task. Unknown statuses and other threads render nothing.
/* thread-delivery:model:start */
function threadDeliveryModel(delivery, currentThreadId, pendingTaskId) {
  if (!currentThreadId) return null;
  const mine = delivery && typeof delivery === 'object' && delivery.threadId === currentThreadId ? delivery : null;
  if (mine && (!pendingTaskId || mine.id === pendingTaskId)) {
    const status = typeof mine.status === 'string' ? mine.status : '';
    const detail = typeof mine.error === 'string' ? mine.error : '';
    if (mine.delivery === 'queued_to_original' || status === 'forwarded') return { key: 'queued', text: '已交给原会话队列', tone: 'ok' };
    if (status === 'failed') {
      if (mine.failureCode === 'thread_queue_unconfirmed') return { key: 'unconfirmed', text: '送达待确认', tone: 'warn', detail };
      const draft = typeof mine.draft === 'string' ? mine.draft : '';
      const desktopRetry = mine.failureCode === 'thread_active_writer';
      return { key: 'failed', text: '发送失败', tone: 'error', detail: desktopRetry ? '电脑端正在使用这条会话，暂时无法应用所选模型或推理强度。' : detail, draft, desktopRetry };
    }
    if (status === 'running') return { key: 'running', text: '正在处理', tone: '' };
    if (status === 'completed') return { key: 'done', text: '本次回复已完成', tone: 'ok' };
    return null;
  }
  return pendingTaskId ? { key: 'submitted', text: '已提交', tone: '' } : null;
}
/* thread-delivery:model:end */

function renderThreadDelivery() {
  const slot = byId('thread-delivery');
  if (!slot) return;
  const threadId = stageMode === 'thread' && activeThread?.id ? activeThread.id : '';
  const delivery = current?.resumeDelivery && typeof current.resumeDelivery === 'object' ? current.resumeDelivery : null;
  if (threadDeliveryPending && (!threadId || threadDeliveryPending.threadId !== threadId)) threadDeliveryPending = null;
  if (threadDeliveryPending && delivery && delivery.threadId === threadId && delivery.id === threadDeliveryPending.taskId) threadDeliveryPending = null;
  let model = threadDeliveryModel(delivery, threadId, threadDeliveryPending ? threadDeliveryPending.taskId : '');
  const receipt = byId('thread-delivery-receipt');
  if (!threadId) threadDeliveryOwnTaskId = '';
  if (receipt.dataset.threadId && (receipt.dataset.threadId !== threadId || (model && model.tone !== 'ok'))) {
    clearTimeout(threadDeliveryReceiptTimer);
    receipt.textContent = '';
    delete receipt.dataset.threadId;
  }
  if (model?.tone === 'ok') {
    if (delivery?.id && delivery.id === threadDeliveryOwnTaskId) {
      threadDeliveryOwnTaskId = '';
      clearTimeout(threadDeliveryReceiptTimer);
      receipt.textContent = model.text;
      receipt.dataset.threadId = threadId;
      threadDeliveryReceiptTimer = setTimeout(() => {
        receipt.textContent = '';
        delete receipt.dataset.threadId;
      }, 3000);
    }
    model = null;
  }
  const key = model ? [threadId, delivery?.id || '', model.key, model.tone, model.detail || '', model.draft ? 1 : 0, model.desktopRetry ? 1 : 0].join('\u0000') : '';
  if (key === threadDeliveryKey) return;
  threadDeliveryKey = key;
  threadDeliveryDraft = model?.draft || '';
  slot.hidden = !model;
  slot.className = model?.tone ? `thread-delivery is-${model.tone}` : 'thread-delivery';
  byId('thread-delivery-text').textContent = model ? model.text : '';
  const detail = byId('thread-delivery-detail');
  detail.textContent = model?.detail || '';
  detail.hidden = !detail.textContent;
  byId('thread-delivery-draft').hidden = !threadDeliveryDraft;
  byId('thread-delivery-desktop').hidden = !(model?.desktopRetry && threadDeliveryDraft);
}

function readingConversationStage() {
  return stageMode === 'thread' || (stageMode === 'task' && Boolean(current?.task));
}

/* Single source of truth for the dock's native #scroll-latest button. */
function syncLatestControl() {
  const button = byId('scroll-latest');
  if (!button) return;
  const box = byId('stream-scroll');
  const active = Boolean(box) && readingConversationStage();
  const dist = box ? box.scrollHeight - box.clientHeight - box.scrollTop : 0;
  if (!active || dist < LATEST_SLACK) latestUnread = false;
  const show = active && (latestUnread || dist >= LATEST_SLACK);
  button.hidden = !show;
  const label = latestUnread ? '有新消息，回到最新' : '回到最新';
  button.setAttribute('aria-label', latestUnread ? '有新消息，回到最新' : '回到最新输出');
  const text = byId('scroll-latest-label');
  if (text && text.textContent !== label) text.textContent = label;
}

function syncLayout() {
  byId('empty').hidden = stageMode !== 'new' && !(stageMode === 'task' && !current?.task);
  byId('task-detail').hidden = stageMode !== 'task' || !current?.task;
  byId('thread-detail').hidden = stageMode !== 'thread';

  byId('sidebar-tasks-pane').hidden = sidebarTab !== 'tasks';
  byId('sidebar-codex-pane').hidden = sidebarTab !== 'codex';
  for (const tab of document.querySelectorAll('[data-sidebar-tab]')) {
    tab.setAttribute('aria-selected', String(tab.dataset.sidebarTab === sidebarTab));
  }

  const hasApprovals = Boolean(current?.approvals?.length);
  const useRail = mqWide.matches && hasApprovals && stageMode === 'task';
  byId('panel').classList.toggle('has-rail', useRail);
  byId('approval-rail').hidden = !useRail;
  byId('approvals-inline').hidden = useRail || !hasApprovals;
  syncResumeContext();
  renderThreadDelivery();
  updateSubmit();
  syncLatestControl();
}

/* ---------- Browser History (thread view) ---------- */
function enterThreadHistory() {
  if (threadHistoryPushed) return;
  threadReturn = {
    stageMode,
    selectedTask,
    sidebarTab,
    query: byId('thread-query').value,
    archived: byId('archived').checked,
    codexScroll: byId('sidebar-codex-pane').scrollTop,
    tasksScroll: byId('sidebar-tasks-pane').scrollTop,
  };
  try {
    window.history.pushState({ remotePanelThread: true }, '', location.href);
    threadHistoryPushed = true;
  } catch {
    threadReturn = null;
  }
}

function consumeThreadHistory() {
  threadReturn = null;
  if (!threadHistoryPushed) return;
  threadHistoryPushed = false;
  try { window.history.back(); } catch {}
}

function closeThreadView() {
  const snapshot = threadReturn;
  threadReturn = null;
  clearResume();
  returnToTaskAfterThread = '';
  byId('return-from-thread').hidden = true;
  stageMode = snapshot && snapshot.stageMode && snapshot.stageMode !== 'thread' ? snapshot.stageMode : 'task';
  if (snapshot) {
    if (snapshot.selectedTask) selectedTask = snapshot.selectedTask;
    if (snapshot.sidebarTab) sidebarTab = snapshot.sidebarTab;
    if (snapshot.query != null) byId('thread-query').value = snapshot.query;
    if (snapshot.archived != null) byId('archived').checked = snapshot.archived;
  }
  syncLayout();
  if (snapshot) {
    byId('sidebar-codex-pane').scrollTop = snapshot.codexScroll || 0;
    byId('sidebar-tasks-pane').scrollTop = snapshot.tasksScroll || 0;
  }
  void refresh();
}

window.addEventListener('popstate', () => {
  if (!threadHistoryPushed) return;
  threadHistoryPushed = false;
  closeThreadView();
});

window.__remotePanelBack = () => {
  if (!byId('settings-dialog').hidden) { setSettings(false); return true; }
  if (!byId('engine-popover').hidden) { byId('engine-popover').hidden = true; return true; }
  if (drawerOpen) { setDrawer(false); return true; }
  if (stageMode === 'thread') {
    const owned = threadHistoryPushed;
    threadHistoryPushed = false;
    closeThreadView();
    if (owned) { try { window.history.back(); } catch {} }
    return true;
  }
  return false;
};

/* ---------- Logout ---------- */
function logout(message = '') {
  clearTimeout(polling);
  historyCache.invalidate();
  void clearHistoryCache();
  localStorage.removeItem(deviceStorage);
  token = '';
  current = null;
  selectedTask = '';
  project = null;
  clearResume();
  resetActivity();
  modelChoices.reset();
  modelChoices.setModels([]);
  modelsRequested = false;
  taskPage = [];
  moreTaskOffset = undefined;
  setDrawer(false);
  history.reset();
  questionsKey = '';
  questionDrafts.clear();
  pendingQuestionIds.clear();
  const questionsHost = byId('questions-host');
  if (questionsHost) { questionsHost.replaceChildren(); questionsHost.hidden = true; }
  showConnection(false, '尚未连接', false);
  byId('login-view').hidden = false;
  byId('panel').hidden = true;
  errorAt('login-error', message);
}

/* ---------- Session Runtime Read (Codex activity) ---------- */
// Read-only live status for the open original Codex thread: its single active goal and the
// pending submission queue. Only the active thread id is ever requested, a read already in
// flight is reused, and a response for a previously open thread is dropped. This is kept
// separate from conversation history and never synthesized from earlier sent tasks.
const activityPollMs = 5_000;

function activityStatusLabel(status) {
  const labels = { running: '进行中', completed: '已完成', failed: '失败', paused: '已暂停', active: '进行中', done: '已完成' };
  return labels[status] || (typeof status === 'string' ? status : '');
}

function activityDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours) return `${hours} 小时 ${minutes} 分`;
  if (minutes) return `${minutes} 分 ${rest} 秒`;
  return `${rest} 秒`;
}

function activityHostEl() {
  if (activityHost && activityHost.isConnected) return activityHost;
  const form = byId('task-form');
  if (!form || !form.parentNode) return null;
  const details = document.createElement('details');
  details.id = 'thread-activity';
  details.className = 'thread-activity';
  details.hidden = true;
  const summary = document.createElement('summary');
  summary.className = 'thread-activity-summary';
  const label = document.createElement('span');
  label.className = 'thread-activity-label';
  label.textContent = '会话状态';
  const state = document.createElement('span');
  state.className = 'thread-activity-state';
  const hint = document.createElement('span');
  hint.className = 'thread-activity-hint';
  hint.textContent = '展开 ▾';
  summary.append(label, state, hint);
  const body = document.createElement('div');
  body.className = 'thread-activity-body';
  const promoteNote = document.createElement('p');
  promoteNote.className = 'thread-activity-note thread-activity-promote-note';
  promoteNote.hidden = true;
  details.append(summary, body, promoteNote);
  form.parentNode.insertBefore(details, form);
  activityHost = details;
  return details;
}

function resetActivity() {
  activityThreadId = '';
  activityPayload = null;
  activityKey = '';
  activityInflight = null;
  activityInflightId = '';
  activityNextAt = 0;
  setPromoteNote('');
  if (activityHost) activityHost.hidden = true;
}

function promoteNoteEl() {
  return activityHost && activityHost.isConnected ? activityHost.querySelector('.thread-activity-promote-note') : null;
}

function setPromoteNote(message, tone) {
  const note = promoteNoteEl();
  if (!note) return;
  note.textContent = message || '';
  note.classList.toggle('is-ok', tone === 'ok');
  note.classList.toggle('is-error', tone === 'error');
  note.hidden = !message;
}

function activityThreadIsCurrent(threadId) {
  return stageMode === 'thread' && Boolean(activeThread) && activeThread.id === threadId;
}

const promoteLabels = { idle: '移到队首', busy: '移动中…' };

// Moves one queued submission to the head of the original Codex queue. Explicit user action
// only, never synthesized; one flight per thread (the queue is single, so a second promote for
// the same thread must not start a conflicting reorder), and a response for a thread that is no
// longer open is dropped. The refreshed queue comes from the existing activity poll.
async function promoteQueueItem(itemId, button) {
  const threadId = stageMode === 'thread' && activeThread?.id ? activeThread.id : '';
  if (!threadId || typeof itemId !== 'string' || !itemId) return;
  if (promoteInflight.has(threadId)) return;
  const identity = token;
  promoteInflight.add(threadId);
  button.disabled = true;
  button.textContent = promoteLabels.busy;
  setPromoteNote('正在移到队首…');
  try {
    const result = await api(`/api/codex/activity/${encodeURIComponent(threadId)}/queue/${encodeURIComponent(itemId)}/promote`, {});
    if (identity !== token || !activityThreadIsCurrent(threadId)) return;
    setPromoteNote(result && result.moved ? '已移到队首。' : '这条消息已在队首。', 'ok');
    activityNextAt = 0;
    activityPoll();
  } catch (error) {
    if (identity !== token || !activityThreadIsCurrent(threadId)) return;
    const stale = error && error.status === 409;
    const message = stale ? (error.message || '排队顺序已改变，请刷新后重试。') : (error && error.message) || '移动失败，请重试。';
    setPromoteNote(message, 'error');
  } finally {
    promoteInflight.delete(threadId);
    if (button.isConnected) { button.disabled = false; button.textContent = promoteLabels.idle; }
  }
}

function renderActivity() {
  const host = activityHostEl();
  if (!host) return;
  const id = stageMode === 'thread' && activeThread?.id ? activeThread.id : '';
  if (!id || !activityPayload) { host.hidden = true; return; }

  const payload = activityPayload;
  const key = JSON.stringify([payload.goalStatus, payload.goal, payload.queueStatus, payload.queue, payload.hasMore]);
  if (key === activityKey) return;
  activityKey = key;

  const goal = payload.goalStatus === 'available' ? payload.goal : null;
  const queue = payload.queueStatus === 'available' && Array.isArray(payload.queue) ? payload.queue : [];
  const degraded = payload.goalStatus !== 'available' || payload.queueStatus !== 'available';
  const hasGoal = Boolean(goal && (goal.objective || goal.status));
  if (!hasGoal && !queue.length && !degraded) { host.hidden = true; return; }

  const body = host.querySelector('.thread-activity-body');
  body.replaceChildren();

  if (hasGoal) {
    const section = document.createElement('section');
    section.className = 'thread-activity-goal';
    const title = document.createElement('span');
    title.className = 'thread-activity-goal-title';
    title.textContent = '当前目标';
    const objective = document.createElement('p');
    objective.className = 'thread-activity-objective';
    objective.textContent = goal.objective || '（无描述）';
    const meta = document.createElement('span');
    meta.className = 'thread-activity-meta';
    const bits = [activityStatusLabel(goal.status)].filter(Boolean);
    const used = activityDuration(goal.timeUsedSeconds);
    if (used) bits.push(`已用 ${used}`);
    meta.textContent = bits.join(' · ');
    section.append(title, objective, meta);
    body.append(section);
  }

  const queueSection = document.createElement('section');
  queueSection.className = 'thread-activity-queue';
  const queueHead = document.createElement('span');
  queueHead.className = 'thread-activity-queue-title';
  if (queue.length) queueHead.textContent = `排队中 ${queue.length} 项${payload.hasMore ? '（还有更多）' : ''}`;
  else if (payload.queueStatus === 'available') queueHead.textContent = '队列空闲';
  else queueHead.textContent = '队列状态暂不可用';
  queueSection.append(queueHead);
  if (queue.length) {
    const list = document.createElement('ol');
    list.className = 'thread-activity-list';
    queue.forEach((item, index) => {
      const row = document.createElement('li');
      row.className = 'thread-activity-item';
      const text = document.createElement('span');
      text.className = 'thread-activity-item-text';
      text.textContent = (item && (item.preview || item.id)) || '（无内容预览）';
      row.append(text);
      if (index === 0) {
        const head = document.createElement('span');
        head.className = 'thread-activity-item-head';
        head.textContent = '队首';
        row.append(head);
      } else if (item && typeof item.id === 'string' && item.id) {
        const promote = document.createElement('button');
        promote.type = 'button';
        promote.className = 'thread-activity-promote';
        promote.textContent = promoteLabels.idle;
        promote.setAttribute('aria-label', '将这条排队消息移到队首');
        promote.addEventListener('click', () => promoteQueueItem(item.id, promote));
        row.append(promote);
      }
      list.append(row);
    });
    queueSection.append(list);
  }
  body.append(queueSection);

  if (degraded && !hasGoal && !queue.length) {
    const note = document.createElement('p');
    note.className = 'thread-activity-note';
    note.textContent = '运行时状态暂不可用，稍后自动重试。';
    body.append(note);
  }

  const state = host.querySelector('.thread-activity-state');
  const chips = [];
  if (hasGoal) chips.push(activityStatusLabel(goal.status) || '目标进行中');
  if (queue.length) chips.push(`排队 ${queue.length}`);
  state.textContent = chips.join(' · ') || (degraded ? '暂不可用' : '空闲');
  host.hidden = false;
}

function activityPoll() {
  const id = stageMode === 'thread' && activeThread?.id ? activeThread.id : '';
  if (!id) { resetActivity(); return; }

  if (id !== activityThreadId) {
    activityThreadId = id;
    activityPayload = null;
    activityKey = '';
    activityInflight = null;
    activityInflightId = '';
    activityNextAt = 0;
    renderActivity();
  }

  const now = Date.now();
  if (now < activityNextAt || activityInflight) return;
  activityNextAt = now + activityPollMs;

  const identity = token;
  activityInflightId = id;
  const pending = api(`/api/codex/activity/${encodeURIComponent(id)}`).then((payload) => {
    if (identity !== token || activityThreadId !== id || activityInflightId !== id) return;
    activityPayload = payload;
    renderActivity();
  }).catch(() => {
    if (identity !== token || activityThreadId !== id || activityInflightId !== id) return;
    activityPayload = { goalStatus: 'unavailable', goal: null, queueStatus: 'unavailable', queue: [], hasMore: false };
    renderActivity();
  });
  activityInflight = pending;
  pending.finally(() => { if (activityInflight === pending) activityInflight = null; });
}

/* ---------- Live Agent Questions (user-input prompts) ---------- */
// Cards for the task/thread currently on screen only; the DOM is owned by ./agent-questions.js.
// Switching away filters to an empty list, so a stale prompt never lingers in the composer.
function questionScope() {
  if (stageMode === 'new') return {};
  if (stageMode === 'thread') return { threadId: activeThread?.id || '' };
  return { taskId: current?.task?.id || '' };
}

function visibleQuestions(list) {
  if (!Array.isArray(list)) return [];
  const { taskId, threadId } = questionScope();
  if (threadId) return list.filter((item) => item && item.threadId === threadId);
  if (taskId) return list.filter((item) => item && item.taskId === taskId);
  return [];
}

// Structural signature so an unchanged poll never re-appends nodes (keeps focus and typed answers).
function questionSignature(list) {
  return JSON.stringify(list.map((item) => [
    item.id, item.isBlocking === true,
    (Array.isArray(item.questions) ? item.questions : []).map((question) => [
      question?.id, question?.header, question?.question,
      question?.isOther === true, question?.isSecret === true,
      Array.isArray(question?.options)
        ? question.options.map((option) => (option && typeof option === 'object' ? [option.label, option.description] : option))
        : null,
    ]),
  ]));
}

async function answerQuestion(id, answers) {
  pendingQuestionIds.add(id);
  try {
    return await api(`/api/questions/${encodeURIComponent(id)}`, { answers });
  } catch (error) {
    // agent-questions.js treats 404/409 as settled; keep the numeric status even if dropped upstream.
    const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
    if (Number.isFinite(status)) error.status = status;
    throw error;
  } finally {
    pendingQuestionIds.delete(id);
  }
}

function renderQuestions(list) {
  const host = byId('questions-host');
  if (!host) return;
  if (!agentQuestions) {
    agentQuestions = createAgentQuestions(host, {
      answer: answerQuestion,
      onSettled: () => { questionsKey = ''; void refresh(); },
    });
  }
  const filtered = visibleQuestions(list);
  const key = questionSignature(filtered);
  host.hidden = filtered.length === 0;
  if (key === questionsKey) return;
  questionsKey = key;
  agentQuestions(filtered);
}

/* ---------- Polling ---------- */
async function refresh() {
  clearTimeout(polling);
  const credentials = token;
  const id = ++nextPoll;
  const requestedThreadId = stageMode === 'thread' && activeThread?.id ? activeThread.id : '';
  const pendingAtRequest = threadDeliveryPending;
  try {
    const resumePoll = requestedThreadId ? `&resumeThreadId=${encodeURIComponent(requestedThreadId)}` : '';
    const snapshot = await api(`/api/state?task=${encodeURIComponent(selectedTask)}&summary=${stageMode === 'task' ? '0' : '1'}${resumePoll}`);
    if (id < renderedPoll || credentials !== token) return;
    renderedPoll = id;
    if (pendingAtRequest && pendingAtRequest === threadDeliveryPending && requestedThreadId && pendingAtRequest.threadId === requestedThreadId) threadDeliveryPending = null;
    showConnection(true, '电脑在线', false);
    byId('login-view').hidden = true;
    byId('panel').hidden = false;
    current = snapshot;
    render(snapshot);
    activityPoll();
  } catch (error) {
    if (id < renderedPoll || credentials !== token) return;
    renderedPoll = id;
    if (error.status === 401) { logout(error.message); return; }
    if (byId('panel').hidden) errorAt('login-error', '电脑暂时离线，正在重新连接。');
    showConnection(false, '重连中', true);
    for (const button of document.querySelectorAll('.approval-btns button')) button.disabled = true;
    approvalKey = '';
  } finally {
    if (token && credentials === token && id === nextPoll) polling = setTimeout(refresh, 1_250);
  }
}

/* ---------- Engine Popover & Bottom Composer ---------- */
function syncEngines(engines) {
  const selector = byId('engine');
  if (!selector.options.length) selector.add(new Option('Codex', 'codex'));
  selector.value = 'codex';
  const engineName = current?.engines?.codex?.name || 'Codex';
  byId('prompt').placeholder = online ? `给电脑上的 ${engineName} 发指令…` : '电脑重连中，暂不可发送…';
  renderModelControls();
}

function updateSubmit() {
  const issue = current?.engines[byId('engine').value]?.issue;
  const busy = current?.busy;
  const promptText = byId('prompt').value.trim();
  const resumeLoading = stageMode === 'thread' && resumePending;
  byId('engine-note').textContent = resumeLoading ? '正在载入会话历史…' : (issue || '');
  byId('send').disabled = !online || submitting || busy || Boolean(issue) || !promptText || (stageMode === 'thread' && !resumeTarget?.id);
  byId('thread-delivery-desktop').disabled = !online || submitting || Boolean(busy) || Boolean(issue);
}

/* ---------- Render Pipeline ---------- */
function describeWorkspace(snapshot, project, resumeTarget) {
  const defaultWs = snapshot?.defaultWorkspace || snapshot?.cwd || '';
  const resuming = stageMode === 'thread' && Boolean(resumeTarget?.id);
  if (resuming && resumeTarget?.cwd) return { path: resumeTarget.cwd, label: `接续会话：${resumeTarget.cwd}`, source: 'resume' };
  if (project?.cwd) return { path: project.cwd, label: `所选项目：${project.cwd}`, source: 'project' };
  if (resumeTarget?.cwd) return { path: resumeTarget.cwd, label: `接续会话：${resumeTarget.cwd}`, source: 'resume' };
  return { path: defaultWs, label: defaultWs ? `桌面默认：${defaultWs}` : '', source: 'default' };
}

function workspaceKey(path) { return String(path || '').trim().toLowerCase().replace(/[\\/]+$/, ''); }
function workspaceOptions(snapshot, threads, project) {
  const def = { path: snapshot?.defaultWorkspace || snapshot?.cwd || '', label: '', source: 'default' };
  const byKey = new Map(), order = [];
  for (const t of Array.isArray(threads) ? threads : []) {
    if (!t?.cwd) continue;
    const k = workspaceKey(t.cwd);
    if (!k) continue;
    if (!byKey.has(k)) { byKey.set(k, { path: t.cwd, thread: t, label: `项目：${t.cwd}`, source: 'project' }); order.push(k); }
  }
  const pk = project?.cwd ? workspaceKey(project.cwd) : '';
  if (pk && !byKey.has(pk)) { byKey.set(pk, { path: project.cwd, thread: project, label: `项目：${project.cwd}`, source: 'project' }); order.push(pk); }
  const seen = new Set([workspaceKey(def.path)]);
  const projects = [];
  for (const k of order) { if (seen.has(k)) continue; seen.add(k); projects.push(byKey.get(k)); }
  return { def, projects };
}
function applyWorkspacePick(value, threads, project) {
  const want = workspaceKey(value);
  if (!want || want === workspaceKey(threads?.default?.path)) return null;
  const found = (threads?.projects || []).find((o) => workspaceKey(o.path) === want);
  if (found?.thread) return found.thread;
  if (project?.cwd && workspaceKey(project.cwd) === want) return project;
  return null;
}
function workspaceStageModel(snapshot, threads, project, resumeTarget, stage) {
  const nodes = Array.isArray(threads) ? threads : [];
  const { def, projects } = workspaceOptions(snapshot, nodes, project);
  const selectedKey = project?.cwd ? workspaceKey(project.cwd) : workspaceKey(def.path);
  const items = [{
    key: workspaceKey(def.path),
    path: def.path,
    name: folderName(def.path) || '默认目录',
    isDefault: true,
    thread: null,
  }];
  for (const o of projects) {
    if (o.source === 'default' || !o.path) continue;
    items.push({
      key: workspaceKey(o.path),
      path: o.path,
      name: folderName(o.path) || o.path,
      isDefault: false,
      thread: o.thread || null,
    });
  }
  for (const item of items) item.selected = item.key === selectedKey;
  const current = items.find((item) => item.selected) || items[0];
  const visible = stage === 'new' || (stage === 'task' && !snapshot?.task);
  return { def, projects, items, selectedKey, current, visible };
}

function syncWorkspaceStage(snapshot, threads, project, resumeTarget) {
  const stage = byId('workspace-stage');
  const list = byId('workspace-stage-list');
  const model = workspaceStageModel(snapshot, threads, project, resumeTarget, stageMode);
  if (!stage || !list) return model;
  stage.hidden = !model.visible;
  if (!model.visible) return model;
  const current = byId('workspace-stage-current');
  if (current) {
    const ws = describeWorkspace(snapshot, project, resumeTarget);
    current.textContent = model.current?.path || '';
    current.title = ws.label || model.current?.path || '';
  }
  list.replaceChildren(...model.items.map((item) => {
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'workspace-stage-item';
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(item.selected));
    button.dataset.key = item.key;
    button.title = item.path;
    const check = document.createElement('span');
    check.className = 'workspace-stage-check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = '\u2713';
    const main = document.createElement('span');
    main.className = 'workspace-stage-main';
    const name = document.createElement('span');
    name.className = 'workspace-stage-name';
    name.textContent = item.name;
    const path = document.createElement('span');
    path.className = 'workspace-stage-path';
    path.textContent = item.path;
    main.append(name, path);
    button.append(check, main);
    if (item.isDefault) {
      const tag = document.createElement('span');
      tag.className = 'workspace-stage-tag';
      tag.textContent = '默认';
      button.append(tag);
    }
    button.onclick = () => pickWorkspace(item.key);
    row.append(button);
    return row;
  }));
  ensureWorkspaceProjects();
  return model;
}

function pickWorkspace(key) {
  const opts = workspaceOptions(current, workspaceProjectThreads(), project);
  project = applyWorkspacePick(key, { default: opts.def, projects: opts.projects }, project);
  if (current) render(current);
  else updateSubmit();
}
function render(snapshot, projectArg, resumeArg) {
  const activeProject = projectArg !== undefined ? projectArg : project;
  const activeResume = resumeArg !== undefined ? resumeArg : resumeTarget;
  const { cwd, engines, tasks, task, approvals, questions } = snapshot;
  syncEngines(engines);

  syncWorkspaceStage(snapshot, workspaceProjectThreads(), activeProject, activeResume);
  updateSubmit();

  const count = approvals.length;
  byId('drawer-notif-dot').hidden = !count;
  byId('rail-approval-count').textContent = String(count);
  byId('list-approval-strip').hidden = !count;
  if (count) {
    byId('list-approval-text').textContent = count === 1 ? `待审批：${approvals[0].title}` : `有 ${count} 项待审批`;
    byId('list-approval-strip').onclick = () => {
      if (approvals[0].taskId) selectedTask = approvals[0].taskId;
      stageMode = 'task';
      setDrawer(false);
      syncLayout();
      void refresh();
    };
  }

  renderHistory(tasks, task?.id, approvals, engines);
  if (stageMode === 'task') renderTask(task, approvals, engines);
  renderApprovals(approvals, tasks, engines);
  renderQuestions(questions);
  syncLayout();
}

function renderTask(task, approvals, engines) {
  if (!task) return;
  const hasApproval = approvals.some(({ taskId }) => taskId === task.id);
  const state = hasApproval ? 'waiting' : task.status;
  const forwarded = task.delivery === 'queued_to_original' || state === 'forwarded';
  const progress = hasApproval ? '等待你允许或拒绝操作' : (task.progress || '');
  const engName = engines[task.engine]?.name || task.engine;

  byId('task-status').hidden = false;
  byId('task-status').className = `status-tag ${state}`;
  byId('task-status').textContent = forwarded ? '已加入原会话队列' : (labels[state] || state);
  byId('task-engine').textContent = engName;
  byId('ai-turn-engine').textContent = engName;
  byId('task-time').textContent = formatTime(task.created);
  byId('task-prompt').textContent = task.prompt || '';
  if (byId('progress').textContent !== progress) byId('progress').textContent = progress;

  errorAt('run-error', task.error);
  errorAt('storage-error', task.storageIssue);

  const output = byId('output');
  const scrollBox = byId('stream-scroll');
  output.hidden = !task.output;
  byId('output-actions').hidden = !task.output;
  if (task.output && output.textContent !== task.output) {
    const atEnd = scrollBox.scrollHeight - scrollBox.clientHeight - scrollBox.scrollTop < LATEST_SLACK;
    output.textContent = task.output;
    if (atEnd) scrollBox.scrollTop = scrollBox.scrollHeight;
    syncLatestControl();
  }

  const commands = task.commands || [];
  const nextKey = JSON.stringify([task.id, commands]);
  byId('task-commands').hidden = !commands.length;
  byId('command-summary-label').textContent = `已执行 ${commands.length} 条电脑命令`;
  if (nextKey !== commandKey) {
    commandKey = nextKey;
    const list = byId('command-list');
    const expanded = expandedCommands(list);
    list.replaceChildren(...commands.map((command) => commandDetails(command, expanded)));
  }

  byId('open-task-thread').hidden = !task.threadId;
  byId('open-task-thread').onclick = () => {
    enterThreadHistory();
    returnToTaskAfterThread = task.id;
    byId('return-from-thread').hidden = false;
    stageMode = 'thread';
    sidebarTab = 'codex';
    history.activate();
    void history.open(task.threadId);
    syncLayout();
  };
}

function renderHistory(tasks, active, approvals, engines) {
  const aprTaskIds = new Set(approvals.map((a) => a.taskId));
  const combined = [...new Map([...taskPage, ...tasks].map((task) => [task.id, task])).values()]
    .sort((a, b) => b.created - a.created);

  byId('tasks-list-state').hidden = combined.length > 0;
  if (!combined.length) byId('tasks-list-state').textContent = '暂无任务，直接在下方输入指令开始';
  byId('more-tasks').hidden = moreTaskOffset === null || (moreTaskOffset === undefined && tasks.length < 24);

  const key = JSON.stringify([combined, active, [...aprTaskIds]]);
  if (key === historyKey) return;
  historyKey = key;

  const rows = combined.map((task) => {
    const st = aprTaskIds.has(task.id) ? 'waiting' : task.status;
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'nav-item';
    button.setAttribute('aria-current', String(stageMode === 'task' && task.id === active));

    const dot = document.createElement('span');
    dot.className = `status-dot ${st}`;
    const main = document.createElement('div');
    main.className = 'nav-item-main';
    const title = document.createElement('span');
    title.className = 'nav-item-title';
    title.textContent = task.title || task.prompt || '未命名任务';
    const sub = document.createElement('span');
    sub.className = 'nav-item-sub';
    sub.textContent = `${engines[task.engine]?.name || task.engine} · ${labels[st] || st} · ${formatTime(task.created)}`;
    main.append(title, sub);

    button.append(dot, main);
    button.onclick = () => {
      selectedTask = task.id;
      consumeThreadHistory();
      stageMode = 'task';
      setDrawer(false);
      syncLayout();
      void refresh();
    };
    row.append(button);
    return row;
  });
  byId('task-list').replaceChildren(...rows);
}

function buildApprovalCard(approval, tasks, engines) {
  const box = document.createElement('section');
  box.className = 'approval-card';
  const task = tasks.find(({ id }) => id === approval.taskId);

  const head = document.createElement('div');
  head.className = 'approval-head';
  head.innerHTML = `<span class="status-dot waiting"></span><span class="approval-title"></span>`;
  head.querySelector('.approval-title').textContent = `${task ? (engines[task.engine]?.name || task.engine) : '任务'} 请求审批 · ${approval.title}`;

  const details = document.createElement('pre');
  details.className = 'approval-code';
  details.textContent = (approval.details || []).join('\n');
  details.hidden = !details.textContent;

  const buttons = document.createElement('div');
  buttons.className = 'approval-btns';
  const message = document.createElement('p');
  message.className = 'form-error';
  message.setAttribute('role', 'alert');
  message.hidden = true;

  const busy = pendingApprovalIds.has(approval.id);
  for (const allow of (approval.canAllow ? [true, false] : [false])) {
    const choice = document.createElement('button');
    choice.type = 'button';
    choice.className = allow ? 'pill-btn primary' : 'pill-btn secondary';
    choice.disabled = !online || busy;
    const label = allow ? (approval.title === '本轮额外权限' ? '允许本轮' : '允许这次') : '拒绝';
    choice.textContent = busy ? '处理中…' : label;
    choice.onclick = async () => {
      pendingApprovalIds.add(approval.id);
      for (const b of buttons.children) b.disabled = true;
      choice.innerHTML = '<span class="spinner" aria-hidden="true"></span><span>处理中…</span>';
      message.hidden = true;
      try {
        await api(`/api/approvals/${approval.id}`, { allow });
      } catch (error) {
        if (error.status !== 409) { message.textContent = error.message; message.hidden = false; }
      } finally {
        pendingApprovalIds.delete(approval.id);
        approvalKey = '';
        await refresh();
      }
    };
    buttons.append(choice);
  }

  box.append(head, details, buttons, message);
  return box;
}

function renderApprovals(approvals, tasks, engines) {
  const key = JSON.stringify([approvals, online, [...pendingApprovalIds]]);
  if (key === approvalKey) return;
  approvalKey = key;
  byId('approvals-inline').replaceChildren(...approvals.map((a) => buildApprovalCard(a, tasks, engines)));
  byId('approvals-rail').replaceChildren(...approvals.map((a) => buildApprovalCard(a, tasks, engines)));
}

/* ---------- Codex History Integration ---------- */
function useProject(thread) {
  if (thread?.id) project = thread;
  byId('engine').value = 'codex';
  clearResume();
  consumeThreadHistory();
  stageMode = 'new';
  modelChoices.resetDraft();
  setDrawer(false);
  syncEngines();
  syncLayout();
  byId('prompt').focus();
  if (current) render(current);
}

const history = createHistory(api, {
  useProject,
  cache: historyCache,
  onNewMessages(unread) { latestUnread = Boolean(unread); syncLatestControl(); },
  onOpen(threadObj, ready) {
    if (!threadHistoryPushed) enterThreadHistory();
    stageMode = 'thread';
    activeThread = threadObj || null;
    resumeTarget = threadObj?.id ? threadObj : null;
    resumePending = Boolean(resumeTarget && !ready);
    if (threadObj?.cwd) project = threadObj;
    setDrawer(false);
    syncLayout();
    if (current) render(current);
  },
  onClose() {
    consumeThreadHistory();
    clearResume();
    stageMode = 'task';
    syncLayout();
  },
});
window.__remotePanelClearHistoryCache = () => clearHistoryCache();

/* ---------- Workspace Project List ---------- */
let workspaceProjects = { threads: [], token: null, pendingToken: null };
function workspaceProjectThreads() {
  const byKey = new Map();
  const listed = workspaceProjects.token === token ? workspaceProjects.threads : [];
  for (const t of Array.isArray(listed) ? listed : []) if (t?.cwd) byKey.set(workspaceKey(t.cwd), t);
  const currentList = history.list();
  for (const t of Array.isArray(currentList) ? currentList : []) if (t?.cwd) byKey.set(workspaceKey(t.cwd), t);
  if (project?.cwd) byKey.set(workspaceKey(project.cwd), project);
  return [...byKey.values()];
}
async function loadWorkspaceProjects() {
  const identity = token;
  if (!identity || workspaceProjects.pendingToken === identity) return;
  workspaceProjects.pendingToken = identity;
  try {
    const page = await api('/api/codex/threads?archived=0&q=');
    if (identity !== token) return;
    workspaceProjects.token = identity;
    workspaceProjects.threads = (Array.isArray(page?.threads) ? page.threads : []).filter((t) => t?.cwd);
    if (current) render(current);
  } catch {
  } finally {
    if (workspaceProjects.pendingToken === identity) workspaceProjects.pendingToken = null;
  }
}
function ensureWorkspaceProjects() {
  if (!token) return;
  if (workspaceProjects.token === token || workspaceProjects.pendingToken === token) return;
  void loadWorkspaceProjects();
}

/* ---------- Events ---------- */
byId('open-drawer-btn').onclick = () => setDrawer(true);
byId('drawer-close').onclick = () => setDrawer(false);
byId('drawer-backdrop').onclick = () => setDrawer(false);

const startFresh = () => {
  clearResume();
  modelChoices.resetDraft();
  consumeThreadHistory();
  stageMode = 'new';
  setDrawer(false);
  syncLayout();
  renderModelControls();
  void loadWorkspaceProjects();
  if (current) render(current);
  byId('prompt').focus();
};
byId('sidebar-new').onclick = startFresh;
byId('header-new-btn').onclick = startFresh;
byId('new-from-thread').onclick = () => useProject(activeThread || project);

for (const tab of document.querySelectorAll('[data-sidebar-tab]')) {
  tab.onclick = () => {
    sidebarTab = tab.dataset.sidebarTab;
    if (sidebarTab === 'codex') history.activate();
    syncLayout();
  };
}

byId('engine-trigger').onclick = (e) => {
  e.stopPropagation();
  const popover = byId('engine-popover');
  popover.hidden = !popover.hidden;
  if (!popover.hidden) void ensureModels();
};
byId('model-select').onchange = () => {
  modelChoices.choose(modelContext(), byId('model-select').value, '');
  renderModelControls();
};
byId('effort-select').onchange = () => {
  modelChoices.choose(modelContext(), byId('model-select').value, byId('effort-select').value);
  renderModelControls();
};
byId('popover-theme').onclick = () => { toggleTheme(); byId('engine-popover').hidden = true; };
document.addEventListener('click', (e) => {
  if (!byId('engine-popover').hidden && !byId('engine-popover').contains(e.target)) byId('engine-popover').hidden = true;
});

/* ---------- Settings Dialog (opened from sidebar footer) ---------- */
const settingsTrigger = byId('settings-trigger');
const settingsDialog = byId('settings-dialog');
let settingsFeedbackTimer = 0;

function setSettings(open) {
  if (open) {
    if (!settingsDialog.hidden) return;
    settingsDialog.hidden = false;
    settingsTrigger.setAttribute('aria-expanded', 'true');
    try { byId('settings-close').focus(); } catch {}
  } else {
    if (settingsDialog.hidden) return;
    settingsDialog.hidden = true;
    settingsTrigger.setAttribute('aria-expanded', 'false');
    try { settingsTrigger.focus(); } catch {}
  }
}

settingsTrigger.onclick = (e) => { e.stopPropagation(); setSettings(settingsDialog.hidden); };
byId('settings-close').onclick = () => setSettings(false);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsDialog.hidden) { e.preventDefault(); setSettings(false); }
});
document.addEventListener('click', (e) => {
  if (!settingsDialog.hidden && !settingsDialog.contains(e.target) && !settingsTrigger.contains(e.target)) setSettings(false);
});
byId('settings-clear-cache').onclick = async () => {
  const feedback = byId('settings-feedback');
  clearTimeout(settingsFeedbackTimer);
  feedback.hidden = false;
  feedback.textContent = '正在清除本地缓存…';
  try {
    await clearHistoryCache();
    feedback.textContent = '已清除本地缓存';
  } catch {
    feedback.textContent = '清除失败，请重试';
  }
  settingsFeedbackTimer = setTimeout(() => { feedback.hidden = true; }, 1800);
};

byId('return-from-thread').onclick = () => window.__remotePanelBack();

const scrollBox = byId('stream-scroll');
scrollBox.addEventListener('scroll', () => { syncLatestControl(); }, { passive: true });
byId('scroll-latest').onclick = () => {
  latestUnread = false;
  scrollBox.scrollTo({ top: scrollBox.scrollHeight, behavior: 'smooth' });
  syncLatestControl();
};

/* ---------- Composer reserve: keep transcript clear of the floating dock ---------- */
(() => {
  const dock = document.querySelector('.composer-dock');
  if (!dock || typeof ResizeObserver === 'undefined') return; // fallback: static CSS padding
  const root = document.documentElement;
  const NEAR_END = 60; // existing near-bottom semantics used elsewhere
  const nearEnd = () => scrollBox.scrollHeight - scrollBox.clientHeight - scrollBox.scrollTop < NEAR_END;
  let viewportHeight = scrollBox.clientHeight;
  let pinned = nearEnd();
  let reserve = -1;
  let queued = false;
  const measure = () => {
    queued = false;
    const height = scrollBox.clientHeight;
    if (!height) return;
    const next = Math.ceil(dock.getBoundingClientRect().height) + 12;
    const viewportChanged = height !== viewportHeight;
    const reserveChanged = next !== reserve;
    const keepLatest = viewportChanged ? pinned : nearEnd();
    viewportHeight = height;
    if (reserveChanged) {
      reserve = next;
      root.style.setProperty('--composer-reserve', next + 'px');
    }
    const readingConversation = stageMode === 'thread' || (stageMode === 'task' && current?.task);
    if (readingConversation && keepLatest && (viewportChanged || reserveChanged)) {
      const previousBehavior = scrollBox.style.scrollBehavior;
      scrollBox.style.scrollBehavior = 'auto';
      scrollBox.scrollTop = scrollBox.scrollHeight;
      scrollBox.style.scrollBehavior = previousBehavior;
    }
    pinned = nearEnd();
    syncLatestControl();
  };
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(measure); } };
  scrollBox.addEventListener('scroll', () => {
    if (scrollBox.clientHeight === viewportHeight) pinned = nearEnd();
  }, { passive: true });
  const resizeObserver = new ResizeObserver(schedule);
  resizeObserver.observe(dock);      // dock height (e.g. multi-line composer)
  resizeObserver.observe(scrollBox); // viewport/keyboard CSS resize
  measure();
})();

byId('copy-output').onclick = async () => {
  const text = byId('output').textContent || '';
  if (!text) return;
  try { await navigator.clipboard.writeText(text); } catch {}
  const btn = byId('copy-output');
  btn.textContent = '已复制';
  setTimeout(() => { btn.textContent = '复制回复'; }, 1400);
};

byId('prompt').addEventListener('input', () => {
  const inp = byId('prompt');
  inp.style.height = 'auto';
  inp.style.height = Math.min(inp.scrollHeight, 130) + 'px';
  updateSubmit();
});
byId('prompt').addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter' && !e.shiftKey && window.innerWidth >= 768) {
    e.preventDefault();
    byId('task-form').requestSubmit();
  }
});

byId('thread-delivery-draft').onclick = () => {
  const inp = byId('prompt');
  if (!threadDeliveryDraft || inp.value.trim()) return;
  inp.value = threadDeliveryDraft;
  inp.style.height = 'auto';
  inp.style.height = Math.min(inp.scrollHeight, 130) + 'px';
  updateSubmit();
  inp.focus();
};

byId('more-tasks').onclick = async () => {
  const button = byId('more-tasks');
  button.disabled = true;
  try {
    const page = await api(`/api/tasks?offset=${moreTaskOffset ?? 24}`);
    taskPage.push(...page.tasks);
    moreTaskOffset = page.next;
    if (current) render(current);
    button.textContent = '加载更早的任务';
  } catch { button.textContent = '重新加载更早的任务'; }
  finally { button.disabled = false; }
};

byId('login-form').onsubmit = async (event) => {
  event.preventDefault();
  errorAt('login-error');
  const code = byId('code').value.trim();
  byId('code').value = '';
  if (!code) return;
  const button = byId('login-submit');
  button.disabled = true;
  button.textContent = '正在连接…';
  try {
    token = code;
    const pair = await api('/api/pair', {});
    token = pair.token;
    localStorage.setItem(deviceStorage, token);
    await refresh();
  } catch (error) { logout(error.message); }
  finally { button.disabled = false; button.textContent = '连接电脑'; }
};

byId('disconnect').onclick = async () => {
  try { await api('/api/unpair', {}); logout(); }
  catch { logout('已在这台设备退出。如需撤销授权，请在电脑端重置设备配对。'); }
};

async function submitComposerTask(retryWithDesktop = false) {
  if (submitting || byId(retryWithDesktop ? 'thread-delivery-desktop' : 'send').disabled) return;
  const retry = retryWithDesktop ? current?.resumeDelivery : null;
  if (retryWithDesktop && (stageMode !== 'thread' || !resumeTarget?.id || retry?.threadId !== resumeTarget.id || retry.threadId !== activeThread?.id || retry.status !== 'failed' || retry.failureCode !== 'thread_active_writer' || typeof retry.draft !== 'string' || !retry.draft.trim())) return;
  errorAt('task-error');
  submitting = true;
  updateSubmit();
  try {
    const engine = 'codex';
    const prompt = retryWithDesktop ? retry.draft : byId('prompt').value;
    const originStage = stageMode;
    const originResumeId = resumeTarget?.id || '';
    const originTask = selectedTask;
    const { resumeThreadId, workspaceThread } = workspacePayload(resumeTarget, project);
    if (stageMode === 'thread' && !resumeThreadId) throw new Error('请先打开要接续的 Codex 会话。');
    const modelPayload = retryWithDesktop ? {} : modelChoices.payload(resumeThreadId);
    if (!submission || submission.engine !== engine || submission.prompt !== prompt || submission.resumeThreadId !== resumeThreadId || submission.workspaceThread !== workspaceThread || submission.model !== modelPayload.model || submission.effort !== modelPayload.effort) {
      submission = { id: crypto.randomUUID(), engine, prompt, resumeThreadId, workspaceThread, ...modelPayload };
    }
    const result = await api('/api/tasks', submission);
    const createdId = result?.task?.id || result?.id;
    submission = undefined;
    const stayedAtOrigin = stageMode === originStage
      && (originStage !== 'thread' || (resumeTarget?.id || '') === originResumeId)
      && (originStage !== 'task' || selectedTask === originTask);
    if (stayedAtOrigin) {
      const keepingThread = originStage === 'thread';
      if (createdId) selectedTask = createdId;
      if (keepingThread && createdId) {
        threadDeliveryPending = { threadId: resumeThreadId, taskId: createdId };
        threadDeliveryOwnTaskId = createdId;
      }
      if (!retryWithDesktop && byId('prompt').value === prompt) {
        byId('prompt').value = '';
        byId('prompt').style.height = 'auto';
      }
      if (!keepingThread) {
        clearResume();
        consumeThreadHistory();
        stageMode = 'task';
      }
      syncLayout();
      await refresh();
      if (!keepingThread) scrollBox.scrollTo({ top: scrollBox.scrollHeight, behavior: 'smooth' });
    }
  } catch (error) {
    if (error.status === 401) logout(error.message);
    else if (!retryWithDesktop || (stageMode === 'thread' && resumeTarget?.id === retry.threadId)) errorAt('task-error', error.message);
  } finally {
    submitting = false;
    updateSubmit();
  }
}

byId('task-form').onsubmit = (event) => {
  event.preventDefault();
  return submitComposerTask();
};
byId('thread-delivery-desktop').onclick = () => submitComposerTask(true);

mqWide.addEventListener('change', syncLayout);
if (token) void refresh();
function workspacePayload(resumeTarget, project) {
  const resuming = stageMode === 'thread' && Boolean(resumeTarget?.id);
  return { resumeThreadId: resuming ? resumeTarget.id : null, workspaceThread: resuming ? null : (project?.id || null) };
}
const _state = { get project() { return project; }, set project(v) { project = v; }, get resumeTarget() { return resumeTarget; }, set resumeTarget(v) { resumeTarget = v; }, get stageMode() { return stageMode; }, set stageMode(v) { stageMode = v; }, get current() { return current; }, set current(v) { current = v; }, list: () => history.list() };
export { describeWorkspace, workspaceOptions, workspaceStageModel, applyWorkspacePick, workspacePayload, _state, render };
