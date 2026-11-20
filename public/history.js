const el = (id) => document.getElementById(id);
const commandStates = { inProgress: '运行中', completed: '已结束', failed: '失败', declined: '已拒绝', interrupted: '已中断' };

const BOTTOM_SLACK = 60;

function scrollHost() {
  return el('stream-scroll');
}

function jump(box, top) {
  const previous = box.style.scrollBehavior;
  box.style.scrollBehavior = 'auto';
  box.scrollTop = top;
  box.style.scrollBehavior = previous;
}

function nearBottom(box) {
  return box.scrollHeight - box.clientHeight - box.scrollTop < BOTTOM_SLACK;
}

function visibleTurn(box) {
  const top = box.getBoundingClientRect().top;
  for (const node of box.querySelectorAll('.turn[data-turn-id]')) {
    const rect = node.getBoundingClientRect();
    if (rect.bottom - top > 2) return { id: node.dataset.turnId, offset: rect.top - top };
  }
  return null;
}

function turnNode(box, id) {
  for (const node of box.querySelectorAll('.turn[data-turn-id]')) if (node.dataset.turnId === id) return node;
  return null;
}

function restoreAnchor(box, anchor) {
  if (!anchor) return false;
  const node = turnNode(box, anchor.id);
  if (!node) return false;
  const delta = (node.getBoundingClientRect().top - box.getBoundingClientRect().top) - anchor.offset;
  if (Math.abs(delta) > 0.5) jump(box, box.scrollTop + delta);
  return true;
}

function followLatest(box) {
  const apply = () => jump(box, box.scrollHeight);
  apply();
  requestAnimationFrame(apply);
}

export function commandDetails(command, expanded) {
  const card = document.createElement('details');
  card.className = 'command';
  card.dataset.command = String(command.id);
  card.open = expanded.has(card.dataset.command);
  const summary = document.createElement('summary');
  const parts = ['命令', commandStates[command.status] || command.status];
  if (Number.isInteger(command.exitCode)) parts.push(`退出码 ${command.exitCode}`);
  summary.textContent = parts.filter(Boolean).join(' · ');
  card.append(summary);
  if (command.text) {
    const code = document.createElement('pre');
    code.textContent = command.text;
    card.append(code);
  }
  if (command.cwd) {
    const directory = document.createElement('p');
    directory.className = 'meta-muted mono';
    directory.textContent = command.cwd;
    card.append(directory);
  }
  if (command.output) {
    const output = document.createElement('pre');
    output.className = 'command-output';
    output.textContent = command.output;
    card.append(output);
  }
  return card;
}

export function expandedCommands(root) {
  return new Set([...root.querySelectorAll('.command[open]')].map((item) => item.dataset.command));
}

function historyButton(thread, selected, open) {
  const row = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'nav-item';
  button.setAttribute('aria-current', String(thread.id === selected));

  const main = document.createElement('div');
  main.className = 'nav-item-main';
  const title = document.createElement('span');
  title.className = 'nav-item-title';
  title.textContent = thread.title || '未命名会话';
  const sub = document.createElement('span');
  sub.className = 'nav-item-sub mono';
  sub.textContent = thread.cwd || '默认目录';
  main.append(title, sub);
  button.append(main);

  button.onclick = () => void open(thread.id);
  row.append(button);
  return row;
}

function projectKey(cwd) {
  return String(cwd || '').trim().replace(/[\\/]+$/, '').toLowerCase();
}

function folderName(path) {
  const parts = String(path || '').replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function projectLabel(group) {
  if (!group.cwd) return '默认目录';
  return folderName(group.cwd) || group.cwd;
}

export function groupThreadsByProject(records) {
  const groups = [];
  const index = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const key = projectKey(record && record.cwd);
    let group = index.get(key);
    if (!group) {
      group = { key, cwd: (record && record.cwd) || '', threads: [] };
      index.set(key, group);
      groups.push(group);
    }
    group.threads.push(record);
  }
  return groups;
}

export function projectGroupElement(group, selected, openThread, newInProject, groupState) {
  const row = document.createElement('li');
  row.className = 'nav-group';
  row.dataset.projectKey = group.key;

  const details = document.createElement('details');
  details.className = 'nav-group-details';
  const containsSelected = group.threads.some((record) => record.id === selected);
  const stored = groupState.get(group.key);
  details.open = containsSelected || (stored === undefined ? false : stored);

  const summary = document.createElement('summary');
  summary.className = 'nav-item nav-group-summary';

  const caret = document.createElement('span');
  caret.className = 'nav-group-caret';
  caret.setAttribute('aria-hidden', 'true');
  caret.textContent = details.open ? '\u25BE' : '\u25B8';

  const main = document.createElement('div');
  main.className = 'nav-item-main';
  const title = document.createElement('span');
  title.className = 'nav-item-title';
  title.textContent = projectLabel(group);
  const sub = document.createElement('span');
  sub.className = 'nav-item-sub mono';
  sub.textContent = group.cwd || '默认目录';
  main.append(title, sub);

  const count = document.createElement('span');
  count.className = 'nav-group-count';
  count.textContent = String(group.threads.length);

  summary.append(caret, main, count);
  details.append(summary);

  const list = document.createElement('ul');
  list.className = 'nav-group-list';
  list.append(...group.threads.map((record) => historyButton(record, selected, openThread)));
  details.append(list);

  if (typeof newInProject === 'function' && group.cwd) {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'nav-item nav-group-new';
    const actionMain = document.createElement('div');
    actionMain.className = 'nav-item-main';
    const actionTitle = document.createElement('span');
    actionTitle.className = 'nav-item-title';
    actionTitle.textContent = '在此工作域新建';
    actionMain.append(actionTitle);
    action.append(actionMain);
    action.onclick = () => void newInProject(group.threads[0]);
    details.append(action);
  }

  details.addEventListener('toggle', () => {
    groupState.set(group.key, details.open);
    caret.textContent = details.open ? '\u25BE' : '\u25B8';
  });

  row.append(details);
  return row;
}

export function createHistory(api, callbacks) {
  const { onOpen, onClose, useProject, cache, onNewMessages } = callbacks;
  const newInProject = typeof useProject === 'function'
    ? useProject
    : (typeof callbacks.onNewInProject === 'function' ? callbacks.onNewInProject : null);
  let loaded = false;
  let remoteListed = false;
  let listGeneration = 0;
  let detailGeneration = 0;
  let threads = [];
  let threadCursor;
  let turnCursor;
  let selection = '';
  let thread;
  let turns = [];
  let headRevision = '';
  let headCursor = null;
  let pagedOlder = false;
  let headSyncTimer;
  let headSyncRunning = false;
  const HEAD_SYNC_MS = 5000;
  const groupState = new Map();

  function renderList() {
    el('thread-list').replaceChildren(...groupThreadsByProject(threads)
      .map((group) => projectGroupElement(group, selection, open, newInProject, groupState)));
    el('more-threads').hidden = !threadCursor;
  }

  async function list(older = false) {
    const generation = ++listGeneration;
    const archived = el('archived').checked;
    const search = el('thread-query').value.trim();
    const isDefault = !older && !archived && !search;
    const query = new URLSearchParams({ archived: archived ? '1' : '0', q: search });
    if (older && threadCursor) query.set('cursor', threadCursor);
    if (isDefault && !remoteListed && cache) {
      try {
        const snapshot = await cache.getSnapshot();
        if (snapshot && generation === listGeneration && !remoteListed && !el('archived').checked && !el('thread-query').value.trim()) {
          threads = snapshot.threads;
          threadCursor = snapshot.cursor ?? null;
          loaded = true;
          renderList();
        }
      } catch {}
    }
    el('threads-feedback').textContent = '正在读取电脑上的 Codex 会话…';
    el('more-threads').disabled = true;
    try {
      const page = await api(`/api/codex/threads?${query}`);
      if (generation !== listGeneration) return;
      loaded = true;
      remoteListed = true;
      threadCursor = page.cursor;
      threads = older ? [...new Map([...threads, ...page.threads].map((record) => [record.id, record])).values()] : page.threads;
      renderList();
      if (isDefault && cache) { try { void Promise.resolve(cache.putSnapshot(threads, threadCursor)).catch(() => {}); } catch {} }
      el('threads-feedback').textContent = threads.length ? '' : '没有符合条件的 Codex 会话。';
    } catch (error) {
      if (generation === listGeneration) el('threads-feedback').textContent = error.message;
    } finally {
      if (generation === listGeneration) el('more-threads').disabled = false;
    }
  }

  function renderTimeline() {
    const timeline = el('timeline');
    const expanded = expandedCommands(timeline);
    const sections = [...turns].reverse().map((turn) => {
      const section = document.createElement('section');
      section.className = 'turn';
      section.dataset.turnId = String(turn.id);
      for (const item of turn.items) {
        if (item.type === 'command') { section.append(commandDetails(item, expanded)); continue; }
        const message = document.createElement('article');
        message.className = `message ${item.type}`;
        const author = document.createElement('h3');
        author.textContent = item.type === 'user' ? '你' : 'Codex';
        const content = document.createElement('pre');
        content.textContent = item.text;
        message.append(author, content);
        section.append(message);
      }
      return section;
    });
    timeline.replaceChildren(...sections);
  }

  function detailVisible() {
    const detail = el('thread-detail');
    return Boolean(selection && thread) && !document.hidden && (!detail || !detail.hidden);
  }

  function setUnread(unread) { if (typeof onNewMessages === 'function') onNewMessages(Boolean(unread)); }

  function stopHeadSync() { clearTimeout(headSyncTimer); headSyncTimer = undefined; }

  function scheduleHeadSync(delay = HEAD_SYNC_MS) {
    clearTimeout(headSyncTimer);
    if (!detailVisible()) { headSyncTimer = undefined; return; }
    headSyncTimer = setTimeout(() => { void headSync(); }, delay);
  }

  function mergeHead(page) {
    const incoming = Array.isArray(page.turns) ? page.turns : [];
    const known = new Map(turns.map((turn) => [String(turn.id), turn]));
    const incomingIds = new Set(incoming.map((turn) => String(turn.id)));
    let contentChanged = false;
    for (const turn of incoming) {
      const previous = known.get(String(turn.id));
      if (!previous || JSON.stringify(previous) !== JSON.stringify(turn)) contentChanged = true;
    }
    const nextThread = page.thread || thread;
    const frameChanged = Boolean(nextThread) && (!thread || nextThread.title !== thread.title || nextThread.cwd !== thread.cwd || nextThread.status !== thread.status);
    if (!contentChanged && !frameChanged) return;
    const box = scrollHost();
    const anchor = box ? visibleTurn(box) : null;
    const atBottom = !box || nearBottom(box);
    turns = [...incoming, ...turns.filter((turn) => !incomingIds.has(String(turn.id)))];
    if (!pagedOlder) { turnCursor = page.cursor ?? turnCursor; headCursor = page.cursor ?? headCursor; }
    thread = nextThread;
    if (thread) {
      el('detail-title').textContent = thread.title;
      el('detail-cwd').textContent = thread.cwd || '';
    }
    el('more-turns').hidden = !turnCursor;
    if (turns.some((turn) => turn.items.length)) el('detail-feedback').textContent = '';
    renderTimeline();
    if (box) {
      if (atBottom) { followLatest(box); setUnread(false); }
      else { restoreAnchor(box, anchor); if (contentChanged) setUnread(true); }
    }
    saveThread();
  }

  function applyCached(cached) {
    if (!cached || !cached.thread) return false;
    thread = cached.thread;
    turns = Array.isArray(cached.turns) ? cached.turns : [];
    turnCursor = cached.cursor ?? null;
    headCursor = cached.headCursor ?? cached.cursor ?? null;
    pagedOlder = Boolean(cached.pagedOlder);
    headRevision = cached.revision || '';
    el('detail-title').textContent = thread.title || '未命名会话';
    el('detail-cwd').textContent = thread.cwd || '';
    el('more-turns').hidden = !turnCursor;
    el('detail-feedback').textContent = turns.some((turn) => turn.items.length) ? '' : '正在读取会话…';
    const newFromThread = el('new-from-thread');
    if (thread.cwd) { newFromThread.hidden = false; newFromThread.onclick = () => useProject(thread); }
    renderTimeline();
    const box = scrollHost();
    if (box) { followLatest(box); setUnread(false); }
    return true;
  }

  function saveThread() {
    if (!cache || !selection || !thread) return;
    try { void Promise.resolve(cache.putThread({ id: selection, thread, turns, cursor: turnCursor, headCursor, pagedOlder, revision: headRevision })).catch(() => {}); } catch {}
  }

  async function headSync(force = false) {
    if (!detailVisible() || headSyncRunning) return;
    const generation = detailGeneration;
    const id = selection;
    headSyncRunning = true;
    try {
      const query = !force && headRevision ? `?revision=${encodeURIComponent(headRevision)}` : '';
      const page = await api(`/api/codex/threads/${encodeURIComponent(id)}${query}`);
      if (generation !== detailGeneration || id !== selection) return;
      headRevision = page.revision || '';
      if (page.unchanged) return;
      mergeHead(page);
    } catch {
      // Keep the current content and retry on the next cadence.
    } finally {
      headSyncRunning = false;
      if (generation === detailGeneration && detailVisible()) scheduleHeadSync();
    }
  }

  async function open(id, older = false) {
    if (!id) return;
    const generation = ++detailGeneration;
    const box = scrollHost();
    const switching = selection !== id;
    const anchor = switching || !box ? null : visibleTurn(box);
    const atBottom = switching || !box ? true : nearBottom(box);
    const newFromThread = el('new-from-thread');
    newFromThread.hidden = true;
    newFromThread.onclick = null;
    if (switching) {
      thread = undefined;
      turns = [];
      turnCursor = null;
      headCursor = null;
      headRevision = '';
      el('timeline').replaceChildren();
      el('detail-title').textContent = threads.find((record) => record.id === id)?.title || 'Codex 会话';
      el('detail-cwd').textContent = '';
      el('more-turns').hidden = true;
      setUnread(false);
    }
    selection = id;
    if (onOpen) onOpen(threads.find((record) => record.id === id) || { id }, false);
    renderList();
    el('detail-feedback').textContent = '正在读取会话…';
    el('more-turns').disabled = true;
    let renderedCached = false;
    try {
      const path = `/api/codex/threads/${encodeURIComponent(id)}`;
      if (cache && !older) {
        let cached = null;
        try { cached = await cache.getThread(id); } catch { cached = null; }
        if (cached && generation === detailGeneration && id === selection) renderedCached = applyCached(cached);
      }
      const query = older && turnCursor
        ? `?cursor=${encodeURIComponent(turnCursor)}`
        : (!older && headRevision ? `?revision=${encodeURIComponent(headRevision)}` : '');
      const page = await api(`${path}${query}`);
      if (generation !== detailGeneration) return;
      if (page.unchanged) {
        headRevision = page.revision || headRevision;
        if (renderedCached) { saveThread(); scheduleHeadSync(); return; }
      } else if (older) {
        thread = page.thread || thread;
        turns = [...new Map([...turns, ...page.turns].map((turn) => [turn.id, turn])).values()];
        turnCursor = page.cursor;
        pagedOlder = true;
      } else {
        thread = page.thread;
        turns = page.turns;
        turnCursor = page.cursor;
        headCursor = page.cursor;
        pagedOlder = false;
        headRevision = page.revision || '';
      }
      el('detail-title').textContent = thread.title;
      el('detail-cwd').textContent = thread.cwd || '';
      el('more-turns').hidden = !turnCursor;
      el('detail-feedback').textContent = turns.some((turn) => turn.items.length) ? '' : '这段会话暂无可显示的已保存消息。';
      if (thread.cwd) {
        newFromThread.hidden = false;
        newFromThread.onclick = () => useProject(thread);
      }
      if (onOpen) onOpen(thread, true);
      renderTimeline();
      if (box) {
        if (switching || (atBottom && !older)) { followLatest(box); setUnread(false); }
        else restoreAnchor(box, anchor);
      }
      saveThread();
      scheduleHeadSync();
    } catch (error) {
      if (generation === detailGeneration) el('detail-feedback').textContent = error.message;
    } finally {
      if (generation === detailGeneration) el('more-turns').disabled = false;
    }
  }

  function close() {
    detailGeneration++;
    stopHeadSync();
    headRevision = '';
    pagedOlder = false;
    selection = '';
    thread = undefined;
    turns = [];
    turnCursor = null;
    headCursor = null;
    const newFromThread = el('new-from-thread');
    newFromThread.hidden = true;
    newFromThread.onclick = null;
    el('timeline').replaceChildren();
    setUnread(false);
    renderList();
    if (onClose) onClose();
  }

  el('thread-search').onsubmit = (event) => { event.preventDefault(); void list(); };
  el('archived').onchange = () => { close(); void list(); };
  el('refresh-threads').onclick = () => void list();
  el('more-threads').onclick = () => void list(true);
  el('refresh-thread').onclick = () => { setUnread(false); if (!thread) { void open(selection); return; } void headSync(true); };
  el('more-turns').onclick = () => void open(selection, true);

  const scrollNode = scrollHost();
  if (scrollNode) scrollNode.addEventListener('scroll', () => { if (nearBottom(scrollNode)) setUnread(false); }, { passive: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopHeadSync(); else if (detailVisible()) void headSync(); });
  window.addEventListener('online', () => { if (detailVisible()) void headSync(); });
  window.addEventListener('offline', () => stopHeadSync());

  return {
    activate() { if (!loaded) { loaded = true; void list(); } },
    list() { return threads; },
    open,
    close,
    reset() { listGeneration++; loaded = false; remoteListed = false; threads = []; threadCursor = null; close(); },
  };
}
