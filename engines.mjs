import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createCodexHistory, commandItem } from './codex-history.mjs';

function findCodex() {
  const explicit = process.env.REMOTE_CODEX_EXE;
  if (explicit) return existsSync(explicit) ? explicit : null;
  const desktop = process.env.CODEX_APP_RUNTIME_CLI_PATH;
  if (desktop && existsSync(desktop)) return desktop;

  const directory = join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  if (existsSync(directory)) {
    const installed = readdirSync(directory)
      .map((version) => join(directory, version, 'codex.exe'))
      .filter(existsSync)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (installed.length) return installed[0];
  }
  return (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')
    .map((folder) => join(folder, process.platform === 'win32' ? 'codex.exe' : 'codex'))
    .find((path) => existsSync(path)) || null;
}

// Codex App Server user-input questions (item/tool/requestUserInput). The panel answers only
// questions delivered on its own live RPC for its own thread; runCodex registers them below.
const questionIdLimit = 200;
const questionHeaderLimit = 200;
const questionBodyLimit = 4_000;
const questionOptionLimit = 400;
const questionOptionNoteLimit = 1_000;
const questionAnswerLimit = 4_000;

export function normalizeQuestions(raw) {
  if (!Array.isArray(raw) || !raw.length) return null;
  const seen = new Set();
  const questions = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null;
    const id = typeof entry.id === 'string' ? entry.id : '';
    if (!id || id.length > questionIdLimit || seen.has(id)) return null;
    seen.add(id);
    let options = null;
    if (Array.isArray(entry.options) && entry.options.length) {
      options = [];
      for (const option of entry.options) {
        if (!option || typeof option !== 'object') return null;
        if (typeof option.label !== 'string' || !option.label || option.label.length > questionOptionLimit) return null;
        options.push({
          label: option.label,
          description: typeof option.description === 'string' ? option.description.slice(0, questionOptionNoteLimit) : '',
        });
      }
    }
    questions.push({
      id,
      header: typeof entry.header === 'string' ? entry.header.slice(0, questionHeaderLimit) : '',
      question: typeof entry.question === 'string' ? entry.question.slice(0, questionBodyLimit) : '',
      options,
      isOther: entry.isOther === true,
      isSecret: entry.isSecret === true,
    });
  }
  return questions;
}

// Builds the App Server result payload {answers:{[questionId]:{answers:[string]}}} from panel input.
// Every required id must be present with no extras; a fixed-choice question needs an exact label
// unless it allows other input. Outgoing keys come from the known questions, never from the request.
export function validateQuestionAnswers(questions, input) {
  if (!Array.isArray(questions) || !questions.length) return { error: '这个问题已无法回答。' };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: '请提交回答内容。' };
  if (Object.keys(input).length !== questions.length) return { error: '请回答全部问题，不要多填。' };
  const answers = Object.create(null);
  for (const question of questions) {
    if (!Object.prototype.hasOwnProperty.call(input, question.id)) return { error: '请回答全部问题。' };
    const value = input[question.id];
    if (typeof value !== 'string') return { error: '每项回答都需要文本。' };
    if (question.options && question.options.length && !question.isOther) {
      if (!question.options.some((option) => option.label === value)) return { error: '请选择题目给出的选项。' };
    } else if (!value.trim() || value.length > questionAnswerLimit) {
      return { error: `请输入 1 到 ${questionAnswerLimit} 个字符的回答。` };
    }
    answers[question.id] = { answers: [value] };
  }
  return { answers };
}

class Rpc {
  constructor(command, args, options, { version, message }) {
    this.version = version;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.done = new Promise((resolve) => { this.finish = resolve; });
    this.process = spawn(command, args, { ...options, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.process.stderr.resume();
    this.process.stdin.on('error', () => this.end(new Error('无法写入运行时输入。')));
    this.process.once('error', (error) => this.end(error));
    this.process.once('close', (code) => this.end(new Error(`运行时已退出（${code ?? '已终止'}）。`)));

    createInterface({ input: this.process.stdout }).on('line', (line) => {
      let frame;
      try { frame = JSON.parse(line); } catch { return; }
      if (!frame || typeof frame !== 'object') return;
      if (typeof frame.method === 'string') {
        try {
          message(frame);
        } catch {
          if (frame.id != null) this.unsupported(frame.id);
        }
        return;
      }
      const request = this.pending.get(frame.id);
      if (!request) return;
      this.pending.delete(frame.id);
      if (frame.error) {
        const error = new Error(frame.error.message || '运行时拒绝了请求。');
        error.code = frame.error.code;
        error.rpcError = true;
        request.reject(error);
      } else request.resolve(frame.result);
    });
  }

  send(frame) {
    if (this.closed || !this.process.stdin.writable) return false;
    this.process.stdin.write(JSON.stringify(this.version ? { jsonrpc: '2.0', ...frame } : frame) + '\n');
    return true;
  }

  request(method, params = {}, timeout = 45_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeout && setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 响应超时。`));
      }, timeout);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      if (!this.send({ id, method, params })) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error('运行时连接已关闭。'));
      }
    });
  }

  unsupported(id) {
    this.send({ id, error: { code: -32601, message: 'This client does not support this request.' } });
  }

  end(error) {
    this.closed = true;
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear();
    this.finish(error);
  }

  async close() {
    this.process.stdin.end();
    if (this.process.exitCode !== null || this.process.signalCode !== null || !this.process.pid) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => this.process.kill(), 1_500);
      this.process.once('close', () => { clearTimeout(timer); resolve(); });
    });
  }
}

function openCodex(command, options, message, extraArgs = []) {
  return new Rpc(command, [...extraArgs, 'app-server'], options, { message });
}

async function initializeCodex(rpc) {
  await rpc.request('initialize', {
    clientInfo: { name: 'personal_remote_panel', title: 'Personal Remote Panel', version: '0.2.0' },
    capabilities: { experimentalApi: true },
  });
  rpc.send({ method: 'initialized' });
}

function openCodexSession(codex, options) {
  const rpc = openCodex(codex, options, ({ id }) => { if (id != null) rpc.unsupported(id); });
  return initializeCodex(rpc).then(() => rpc, async (error) => { await rpc.close(); throw error; });
}

function normalizeModel(model) {
  const efforts = (Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [])
    .map((entry) => (typeof entry === 'string'
      ? { reasoningEffort: entry, description: '' }
      : { reasoningEffort: entry?.reasoningEffort, description: entry?.description || '' }))
    .filter((entry) => typeof entry.reasoningEffort === 'string' && entry.reasoningEffort);
  return {
    id: model.id || model.model || '',
    displayName: model.displayName || model.model || model.id || '',
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort: model.defaultReasoningEffort || null,
    isDefault: Boolean(model.isDefault),
  };
}

async function listCodexModels(codex, options) {
  const rpc = await openCodexSession(codex, options);
  try {
    const models = [];
    const seen = new Set();
    let cursor;
    for (let page = 0; page < 20; page++) {
      const result = await rpc.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      const data = Array.isArray(result?.data) ? result.data : [];
      for (const model of data) {
        if (model && !model.hidden) models.push(normalizeModel(model));
      }
      cursor = result?.nextCursor || null;
      if (!cursor || seen.has(cursor)) break;
      seen.add(cursor);
    }
    return { models };
  } finally {
    await rpc.close();
  }
}

// Read-only live activity for one local Codex thread: its single active goal and its pending
// submission queue. The two app-server calls are reported independently, so an unsupported or
// failing capability never hides the other; only the requested thread is ever read, and concurrent
// requests for that same thread share one in-flight read. Non-text queue input becomes a generic
// label, every string is bounded, and no raw upstream metadata is forwarded.
const activityObjectiveLimit = 1_000;
const activityStatusLimit = 64;
const activityPreviewLimit = 200;
const activityIdLimit = 128;
const activityQueueLimit = 30;
// The full queue is paged to completion with limit=30 before any reorder, so the mutation always
// carries the complete, current set of queued ids rather than a stale UI view.
const activityQueuePages = 50;

function activityClip(value, limit, redact) {
  if (typeof value !== 'string') return '';
  return redact ? redact(value, limit) : value.slice(0, limit);
}

function activityPreview(input, redact) {
  const parts = [];
  for (const entry of Array.isArray(input) ? input : []) {
    if (entry && typeof entry === 'object' && entry.type === 'text' && typeof entry.text === 'string') {
      parts.push(activityClip(entry.text, activityPreviewLimit, redact));
    } else {
      parts.push('[非文本内容]');
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, activityPreviewLimit);
}

function activityGoal(goal, redact) {
  if (!goal || typeof goal !== 'object') return null;
  return {
    objective: activityClip(goal.objective, activityObjectiveLimit, redact),
    status: typeof goal.status === 'string' ? goal.status.slice(0, activityStatusLimit) : '',
    timeUsedSeconds: Number.isFinite(goal.timeUsedSeconds) ? goal.timeUsedSeconds : null,
  };
}

function activityQueueItem(item, redact) {
  if (!item || typeof item !== 'object') return null;
  const id = activityClip(typeof item.id === 'string' ? item.id : item.clientUserMessageId, activityIdLimit, redact);
  return { id, preview: activityPreview(item.input, redact) };
}

export function createCodexActivity(connect) {
  let ready;
  const inflight = new Map();
  const client = (options) => {
    if (!ready) {
      ready = connect(options).then((rpc) => {
        rpc.done.then(() => { ready = undefined; });
        return rpc;
      }, (error) => { ready = undefined; throw error; });
    }
    return ready;
  };
  return {
    read(options, threadId, redact) {
      const existing = inflight.get(threadId);
      if (existing) return existing;
      const pending = (async () => {
        let rpc;
        try { rpc = await client(options); }
        catch { return { goalStatus: 'unavailable', goal: null, queueStatus: 'unavailable', queue: [], hasMore: false }; }
        const [goalResult, queueResult] = await Promise.allSettled([
          rpc.request('thread/goal/get', { threadId }),
          rpc.request('thread/queue/list', { threadId, limit: activityQueueLimit }),
        ]);
        const goal = goalResult.status === 'fulfilled'
          ? { goalStatus: 'available', goal: activityGoal(goalResult.value?.goal, redact) }
          : { goalStatus: 'unavailable', goal: null };
        const queue = queueResult.status === 'fulfilled'
          ? { queueStatus: 'available', queue: (Array.isArray(queueResult.value?.data) ? queueResult.value.data : []).map((item) => activityQueueItem(item, redact)).filter(Boolean), hasMore: Boolean(queueResult.value?.nextCursor) }
          : { queueStatus: 'unavailable', queue: [], hasMore: false };
        return { ...goal, ...queue };
      })();
      inflight.set(threadId, pending);
      const clear = () => { if (inflight.get(threadId) === pending) inflight.delete(threadId); };
      pending.then(clear, clear);
      return pending;
    },
    // Promote one already-queued submission to the front of the same thread's native queue over the
    // shared connection. The queue is paged to completion first so the reorder payload is the exact
    // permutation of every current id; the moved message never disturbs the relative order of the
    // others, and nothing is written when the target is missing, already first, or the list changed.
    async promote(options, threadId, itemId) {
      if (typeof itemId !== 'string' || !itemId || itemId.length > activityIdLimit) return { ok: false, conflict: true };
      let rpc;
      try { rpc = await client(options); }
      catch { return { ok: false, unavailable: true }; }
      const ids = [];
      const seen = new Set();
      let cursor = null;
      try {
        for (let page = 0; page < activityQueuePages; page++) {
          const result = await rpc.request('thread/queue/list', { threadId, limit: activityQueueLimit, ...(cursor ? { cursor } : {}) });
          const data = Array.isArray(result?.data) ? result.data : [];
          for (const item of data) {
            const id = typeof item?.id === 'string' ? item.id : (typeof item?.clientUserMessageId === 'string' ? item.clientUserMessageId : '');
            if (!id || id.length > activityIdLimit || seen.has(id)) return { ok: false, conflict: true };
            seen.add(id);
            ids.push(id);
          }
          cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
          if (!cursor) break;
        }
      } catch { return { ok: false, unavailable: true }; }
      if (cursor) return { ok: false, conflict: true };
      if (!seen.has(itemId)) return { ok: false, expired: true };
      if (ids[0] === itemId) return { ok: true, moved: false };
      try {
        await rpc.request('thread/queue/reorder', { threadId, queuedSubmissionIds: [itemId, ...ids.filter((id) => id !== itemId)] });
      } catch (error) {
        return error && error.rpcError ? { ok: false, conflict: true } : { ok: false, unavailable: true };
      }
      return { ok: true, moved: true };
    },
  };
}

function codexApproval(method, params, item) {
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      const available = params.availableDecisions;
      const refusal = available && !available.includes('decline') ? 'cancel' : 'decline';
      return {
        title: params.networkApprovalContext ? '网络连接' : '运行命令',
        details: [params.reason, params.networkApprovalContext?.host, params.command || item?.command, params.cwd],
        canAllow: !available || available.includes('accept'),
        decision: (allowed) => ({ decision: allowed ? 'accept' : refusal }),
      };
    }
    case 'item/fileChange/requestApproval':
      return {
        title: '写入文件',
        details: [params.reason, params.grantRoot, ...((item?.changes || []).map((change) => change.path))],
        canAllow: true,
        decision: (allowed) => ({ decision: allowed ? 'accept' : 'decline' }),
      };
    case 'item/permissions/requestApproval':
      return {
        title: '本轮额外权限',
        details: [params.reason, JSON.stringify(params.permissions || {}, null, 2)],
        canAllow: true,
        decision: (allowed) => ({ permissions: allowed ? params.permissions : {}, scope: 'turn' }),
      };
    default: return null;
  }
}

// Guard profile for an existing native thread whose cwd is the immediate non-drive parent of the panel
// installation root. It extends :workspace and adds an exact deny for the whole canonical panel root.
// Applied only to this job's own App Server process; no global Codex config is touched.
const guardProfile = 'panel_installation_guard';
const guardProfileName = /^[A-Za-z0-9_-]{1,64}$/;

function tomlString(value) {
  return `"${String(value).replace(/[\u0000-\u001f]/g, '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function guardConfigArgs(guardRoot) {
  const root = String(guardRoot || '').replace(/\\/g, '/');
  if (!guardProfileName.test(guardProfile) || !/^(?:[A-Za-z]:\/|\/)/.test(root)) {
    throw new Error('无法为所选项目目录建立防护规则。');
  }
  return [
    '-c', `permissions.${guardProfile}.extends=":workspace"`,
    '-c', `permissions.${guardProfile}.filesystem={${tomlString(root)}="deny"}`,
    '-c', `default_permissions=${tomlString(guardProfile)}`,
  ];
}

function isActiveWriterError(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  return message.includes('already has an active writer');
}

function hasExplicitCodexOverride(task) {
  return (typeof task.model === 'string' && task.model !== '')
    || (typeof task.effort === 'string' && task.effort !== '');
}

function activeWriterBusyError() {
  const busy = new Error('电脑端 Codex 正占用这条会话，消息尚未发送。');
  busy.code = 'thread_active_writer';
  return busy;
}

// Cross-writer fallback: enqueue the original prompt onto a thread the desktop Codex writer
// already owns. The queue inherits that thread's own model and effort, so it is offered only for
// the default configuration and never silently drops an explicit override. Exactly one RPC is
// sent and it is never retried. Only a real, nonempty submission id counts as an acknowledgement:
// upstream answers a repeat of the same client id with a duplicate (or otherwise empty) reply, so
// a missing id is reported as unconfirmed rather than resent.
async function queueOntoOriginalOwner(rpc, task) {
  try {
    const result = await rpc.request('thread/queue/add', {
      threadId: task.resumeThreadId,
      input: [{ type: 'text', text: task.prompt, text_elements: [] }],
      clientUserMessageId: task.id,
    });
    const submissionId = result?.queuedSubmission?.id;
    if (typeof submissionId !== 'string' || submissionId === '') {
      return { outcome: 'unconfirmed', detail: '上游未返回排队编号' };
    }
    return { outcome: 'queued', submissionId };
  } catch (error) {
    if (error?.rpcError === true) return { outcome: 'rejected', detail: error.message };
    return { outcome: 'unconfirmed', detail: error?.message };
  }
}

export async function runCodex(command, task, context, open = openCodex) {
  let threadId;
  let errorMessage;
  let complete;
  const items = new Map();
  const endTurn = new Promise((resolve) => { complete = resolve; });
  const rpc = open(command, { cwd: context.cwd, env: context.env }, ({ id, method, params = {} }) => {
      if (id != null) {
        // Answer only user-input questions that arrived on this panel-owned RPC for this thread.
        if (method === 'item/tool/requestUserInput') {
          const questions = normalizeQuestions(params.questions);
          if (!questions || !threadId || params.threadId !== threadId || typeof context.question !== 'function') { rpc.unsupported(id); return; }
          const accepted = context.question({
            requestId: id,
            threadId: params.threadId,
            itemId: typeof params.itemId === 'string' ? params.itemId : '',
            isBlocking: params.isBlocking === true,
            questions,
          }, (answers) => rpc.send({ id, result: { answers } }));
          if (accepted !== true) rpc.unsupported(id);
          return;
        }
        const approval = codexApproval(method, params, items.get(params.itemId));
        if (!approval || params.threadId !== threadId) { rpc.unsupported(id); return; }
        context.approve(id, approval.title, approval.details, (allowed) => {
          rpc.send({ id, result: approval.decision(allowed) });
        }, approval.canAllow);
        return;
      }
      if (method === 'serverRequest/resolved') {
        context.resolveApproval(params.requestId);
        if (typeof context.resolveQuestion === 'function') context.resolveQuestion(params.requestId);
      }
      if (params.threadId !== threadId || !threadId) return;

      if (method === 'item/agentMessage/delta') context.output(params.itemId, params.delta, true);
      if (method === 'item/started' && params.item) {
        const item = params.item;
        items.set(item.id, item);
        if (item.type === 'commandExecution') {
          context.progress('正在运行命令');
          context.command(commandItem(item));
        }
        if (item.type === 'fileChange') context.progress('正在修改文件');
      }
      if (method === 'item/completed' && params.item?.type === 'agentMessage') {
        context.output(params.item.id, params.item.text);
      }
      if (method === 'item/commandExecution/outputDelta') context.commandOutput(params.itemId, params.delta);
      if (method === 'item/completed' && params.item?.type === 'commandExecution') {
        context.command(commandItem(params.item));
      }
      if (method === 'error' && !params.willRetry) errorMessage = params.error?.message;
      if (method === 'turn/completed') complete(params.turn);
  }, task.guardRoot ? guardConfigArgs(task.guardRoot) : []);
  try {
    await initializeCodex(rpc);
    if (task.resumeThreadId) {
      let resumed;
      try {
        resumed = await rpc.request('thread/resume', {
          threadId: task.resumeThreadId,
          excludeTurns: true,
          cwd: context.cwd,
          approvalPolicy: 'on-request',
          ...(task.guardRoot ? { permissions: guardProfile } : { sandbox: 'workspace-write' }),
        });
      } catch (error) {
        if (!isActiveWriterError(error)) throw error;
        if (hasExplicitCodexOverride(task)) throw activeWriterBusyError();
        const queued = await queueOntoOriginalOwner(rpc, task);
        if (queued.outcome === 'queued') {
          context.associateThread(task.resumeThreadId);
          return { delivery: 'queued_to_original', submissionId: queued.submissionId };
        }
        if (queued.outcome === 'unconfirmed') {
          const pending = new Error(`消息可能已进入原会话队列，但未收到确认（${queued.detail || '响应超时'}），无法判定是否排队成功；本轮不会自动重试。`);
          pending.code = 'thread_queue_unconfirmed';
          throw pending;
        }
        const rejected = new Error('原会话正在被电脑端 Codex 占用，排队请求被拒绝，消息尚未发送。');
        rejected.code = 'thread_queue_rejected';
        throw rejected;
      }
      const { thread } = resumed;
      if (!thread || thread.id !== task.resumeThreadId) throw new Error('无法接续所选 Codex 会话。');
      threadId = thread.id;
      context.associateThread(threadId);
      context.progress('Codex 会话已接续');
    } else {
      const { thread } = await rpc.request('thread/start', {
        cwd: context.cwd,
        approvalPolicy: 'on-request',
        ...(task.guardRoot ? { permissions: guardProfile } : { sandbox: 'workspace-write' }),
      });
      threadId = thread.id;
      context.associateThread(threadId);
      context.progress('Codex 会话已创建');
    }
    await rpc.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: task.prompt }],
      ...(typeof task.model === 'string' && task.model ? { model: task.model } : {}),
      ...(typeof task.effort === 'string' && task.effort ? { effort: task.effort } : {}),
    });
    const turn = await Promise.race([endTurn, rpc.done.then((error) => { throw error; })]);
    if (turn.status !== 'completed') throw new Error(turn.error?.message || errorMessage || `Codex 结束状态为 ${turn.status}。`);
  } finally {
    context.clearApprovals();
    if (typeof context.clearQuestions === 'function') context.clearQuestions();
    await rpc.close();
  }
}

async function runHarness(exe, task, context) {
  const sessionId = randomUUID();
  let finishReason;
  let finishMessage;
  let messageIndex = 0;
  const calls = new Map();
  mkdirSync(context.dshHome, { recursive: true });
  const runtime = join(exe, '..', 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  const environment = {
    ...context.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: context.dshHome,
    DSH_PERMISSION_MODE: 'workspace-write',
  };
  const rpc = new Rpc(exe, ['--expose-internals', runtime, '--profile', 'sdk'], { cwd: context.cwd, env: environment }, {
    version: true,
    message({ id, method, params = {} }) {
      if (id != null) {
        // The runtime is dedicated to this task, including its descendant sessions.
        if (method !== 'approval/request') { rpc.unsupported(id); return; }
        const args = calls.get(`${params.sessionId}:${params.callId}`);
        context.approve(id, params.toolName || '工具操作', [params.reason, args], (allowed) => {
          rpc.send({ id, result: { outcome: allowed ? 'allowed-once' : 'rejected' } });
        });
        return;
      }
      if (method !== 'session.event') return;

      const event = params.event;
      if (event?.type === 'tool/call' && event.data?.callId) {
        calls.set(`${params.sessionId}:${event.data.callId}`, event.data.arguments);
        if (calls.size > 100) calls.delete(calls.keys().next().value);
        context.progress('正在调用工具');
      }
      if (params.sessionId !== sessionId) return;
      if (event?.type === 'tool/call' && /^(?:bash|pwsh|shell|exec_command)$/i.test(event.data?.name)) {
        let args;
        try { args = JSON.parse(event.data.arguments); } catch { args = {}; }
        if (typeof args?.command === 'string') {
          context.command({ id: event.data.callId, text: args.command, cwd: args.workdir, status: 'inProgress' });
        }
      }
      if (event?.type === 'tool/result') {
        const result = event.data?.message;
        const id = result?.callId || result?.toolCallId;
        const output = result?.content?.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
        if (id) context.finishCommand(id, result.isError ? 'failed' : 'completed', output);
      }
      if (event?.type === 'assistant/message') {
        const content = event.data?.message?.content || event.data?.content || [];
        const text = content.filter((block) => block.type === 'text').map((block) => block.text).join('');
        if (text) context.output(`message-${++messageIndex}`, text);
      }
      if (event?.type === 'turn/end') {
        finishReason = event.data?.reason?.kind;
        finishMessage = event.data?.reason?.error?.message || event.data?.reason?.message;
      }
    },
  });
  try {
    await rpc.request('initialize', {
      cwd: context.cwd,
      provider: 'deepseek-official',
      model: process.env.REMOTE_DSH_MODEL || 'deepseek-v4-flash',
      approvalRequests: true,
    });
    context.progress('DeepSeek Harness 会话已创建');
    await rpc.request('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text: task.prompt }] });
    await rpc.request('session/wait', { sessionId }, 0);
    if (finishReason !== 'completed') throw new Error(finishMessage || `DeepSeek Harness 结束状态为 ${finishReason || '未知'}。`);
  } finally {
    context.clearApprovals();
    if (!rpc.closed) await rpc.request('shutdown', {}, 2_000).catch(() => {});
    await rpc.close();
  }
}

export function engines() {
  const codex = findCodex();
  const harness = process.env.REMOTE_DSH_EXE || [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness'),
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'DeepSeek Harness'),
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'DeepSeekHarness'),
    'D:\\DSH',
  ].filter(Boolean).map((folder) => join(folder, 'DeepSeek Harness.exe')).find(existsSync);
  return {
    codex: {
      name: 'Codex',
      issue: codex ? null : '找不到 Codex CLI。可设置 REMOTE_CODEX_EXE。',
      run: (task, context) => runCodex(codex, task, context),
      history: codex ? createCodexHistory((options) => openCodexSession(codex, options)) : null,
      models: codex ? (options) => listCodexModels(codex, options) : null,
      activity: codex ? createCodexActivity((options) => openCodexSession(codex, options)) : null,
    },
    harness: {
      name: 'DeepSeek Harness',
      issue: !harness || !existsSync(harness) ? '找不到 DeepSeek Harness。可用“启用DeepSeek并启动”选择安装位置。'
        : !process.env.DEEPSEEK_API_KEY ? '请在电脑端设置 DEEPSEEK_API_KEY 后重启面板。' : null,
      run: (task, context) => runHarness(harness, task, context),
    },
  };
}
