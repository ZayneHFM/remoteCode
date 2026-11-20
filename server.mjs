import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { engines, validateQuestionAnswers } from './engines.mjs';
import { panelStore } from './panel-store.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const dataDirectory = join(root, '.remote-data');
const port = Number(process.env.REMOTE_PORT || 8788);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('REMOTE_PORT 必须是有效端口。');

const workspace = process.env.REMOTE_WORKSPACE || join(root, '任务工作区');
if (!isAbsolute(workspace)) throw new Error('REMOTE_WORKSPACE 必须是绝对路径。');
mkdirSync(workspace, { recursive: true });
function contains(directory, path) {
  const difference = relative(directory, path);
  return !isAbsolute(difference) && !/^\.\.(?:[/\\]|$)/.test(difference);
}
const realRoot = realpathSync(root);
// Immediate non-drive parent of the panel installation root: the only ancestor an existing native
// Codex thread may legitimately use, and only through a server-side guard profile that denies realRoot.
const guardedParent = (() => {
  const parent = dirname(realRoot);
  return parent === dirname(parent) ? null : parent;
})();
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
function workspacePath(path, allowGuardedParent = false) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('任务工作区必须是本机目录。');
  const directory = realpathSync(path);
  const protectedFolders = ['.remote-data', 'public', 'android', 'runtime', '安装包', '官方安装入口', '发布包'];
  if (protectedFolders.some((name) => contains(join(realRoot, name), directory))) {
    throw new Error('请选择独立的项目目录作为任务工作区。');
  }
  if (contains(directory, realRoot) && !(allowGuardedParent && guardedParent && samePath(directory, guardedParent))) {
    throw new Error('请选择独立的项目目录作为任务工作区。');
  }
  if (!statSync(directory).isDirectory()) throw new Error('任务工作区必须是目录。');
  return directory;
}
const cwd = workspacePath(workspace);
const store = panelStore(dataDirectory);
if (process.argv.includes('--reset-pairing')) {
  store.resetDevices();
  console.log('已撤销保存的设备授权。');
  process.exit(0);
}

const code = randomBytes(24).toString('base64url');
const bearer = Buffer.from(`Bearer ${code}`);
const desktopMode = process.argv.includes('--desktop');
const pinLifetime = 10 * 60_000;
let pin;
let pinExpires;
let badPinAttempts = 0;
let attemptsResetAt = 0;
let stopping = false;
const catalog = engines();
const engineStatus = Object.fromEntries(Object.entries(catalog).map(([id, value]) => [id, { name: value.name, issue: value.issue }]));
const tasks = store.tasks();
const pending = new Map();
const questions = new Map();
const settledQuestions = new Set();
const saveTimers = new Map();
const androidPackage = join(root, '安装包', 'PersonalRemotePanel.apk');
const androidPackageCodex = join(root, '安装包', 'PersonalRemotePanel-Codex-v1.apk');
const androidPackageCodexV11 = join(root, '安装包', 'PersonalRemotePanel-Codex-v1.1.apk');
const androidPackageRemoteCode111 = join(root, '安装包', 'remoteCode-1.1.1.apk');
const androidPackageCandidates = [androidPackageRemoteCode111, androidPackageCodexV11, androidPackageCodex, androidPackage];
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/panel.js', ['panel.js', 'text/javascript; charset=utf-8']],
  ['/history.js', ['history.js', 'text/javascript; charset=utf-8']],
  ['/history-cache.js', ['history-cache.js', 'text/javascript; charset=utf-8']],
  ['/model-picker.js', ['model-picker.js', 'text/javascript; charset=utf-8']],
  ['/agent-questions.js', ['agent-questions.js', 'text/javascript; charset=utf-8']],
  ['/panel.css', ['panel.css', 'text/css; charset=utf-8']],
].map(([url, [file, type]]) => [url, [readFileSync(join(root, 'public', file)), type]]));

function renewPin() {
  const previous = pin;
  do { pin = String(randomInt(100_000_000)).padStart(8, '0'); } while (pin === previous);
  pinExpires = Date.now() + pinLifetime;
  badPinAttempts = 0;
  attemptsResetAt = 0;
}

const isBusy = () => [...tasks.values()].some((task) => task.status === 'running');

function desktopEvent(type) {
  if (!desktopMode) return;
  if (!pin || Date.now() >= pinExpires) renewPin();
  console.log(JSON.stringify({ type, pin, pinExpires, busy: isBusy() }));
}

function redact(value, limit = 3_000) {
  let result = String(value || '');
  for (const secret of [code, process.env.DEEPSEEK_API_KEY, process.env.OPENAI_API_KEY].filter(Boolean)) {
    result = result.replaceAll(secret, '［隐藏］');
  }
  return result.slice(0, limit);
}

function pairDevice(response, pairCode, device) {
  if (stopping) return json(response, 503, { error: '电脑端正在重新启动，请稍后再配对。' });
  if (pairCode) return json(response, 200, { token: store.pair() });
  if (!desktopMode || !/^\d{8}$/.test(device)) {
    return json(response, 401, { error: '请使用电脑窗口当前显示的配对码。' });
  }
  const now = Date.now();
  if (now >= attemptsResetAt) { badPinAttempts = 0; attemptsResetAt = now + 60_000; }
  if (badPinAttempts >= 8) {
    response.setHeader('Retry-After', Math.ceil((attemptsResetAt - now) / 1_000));
    return json(response, 429, { error: '尝试次数过多，请等一分钟，或在电脑上换一个配对码。' });
  }
  if (!pin || now >= pinExpires || !timingSafeEqual(Buffer.from(device), Buffer.from(pin))) {
    badPinAttempts++;
    return json(response, 401, { error: '配对码错误或已过期，请核对电脑窗口。' });
  }
  const token = store.pair();
  renewPin();
  desktopEvent('paired');
  return json(response, 200, { token });
}

function clearApproval(entry) {
  clearTimeout(entry.timer);
  pending.delete(entry.public.id);
}

// A live user-input question is removed from the answer map the moment it is answered, resolved,
// or its RPC ends; the id is remembered (bounded) so a later replay is refused as already handled
// rather than reported as unknown.
function settleQuestion(entry) {
  questions.delete(entry.public.id);
  if (settledQuestions.size >= 512) settledQuestions.delete(settledQuestions.values().next().value);
  settledQuestions.add(entry.public.id);
}

function engineEnvironment(engine) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('CODEX_APP_TOOLS_') || name.startsWith('REMOTE_') || ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_TOOL_CALL_ID'].includes(name)) delete env[name];
  }
  if (engine === 'codex') delete env.DEEPSEEK_API_KEY;
  if (engine === 'harness') delete env.OPENAI_API_KEY;
  return env;
}
const historyOptions = { cwd, env: engineEnvironment('codex') };

function saveTask(task) {
  clearTimeout(saveTimers.get(task.id));
  saveTimers.delete(task.id);
  try { store.saveTask(task); }
  catch (error) {
    task.storageIssue = '这项任务的记录暂时无法保存。';
    console.error(`写入任务记录失败（${error.code || '未知错误'}）。`);
  }
}

function saveSoon(task) {
  if (!saveTimers.has(task.id)) saveTimers.set(task.id, setTimeout(() => saveTask(task), 1_000));
}

async function runTask(task) {

  const context = {
    cwd: task.cwd,
    env: engineEnvironment(task.engine),
    dshHome: join(dataDirectory, 'harness'),
    progress: (text) => { task.progress = text; },
    associateThread(id) { task.threadId = id; saveSoon(task); },
    output(id, text, append = false) {
      if (typeof text !== 'string') return;
      const previous = append ? task.output.get(id) || '' : '';
      task.output.set(id, (previous + text).slice(-48_000));
      if (task.output.size > 12) task.output.delete(task.output.keys().next().value);
      saveSoon(task);
    },
    command(record) {
      if (!record.id) return;
      const previous = task.commands.get(record.id);
      task.commands.set(record.id, {
        id: record.id,
        text: redact(record.text || previous?.text, 20_000),
        cwd: redact(record.cwd || previous?.cwd, 4_000),
        status: record.status || previous?.status,
        exitCode: record.exitCode ?? previous?.exitCode,
        output: redact(record.output || previous?.output, 36_000),
      });
      saveSoon(task);
    },
    commandOutput(id, delta) {
      const record = task.commands.get(id);
      if (!record || typeof delta !== 'string') return;
      record.output = (record.output + delta).slice(-36_000);
      saveSoon(task);
    },
    finishCommand(id, status, output) {
      const record = task.commands.get(id);
      if (!record) return;
      record.status = status;
      if (output) record.output = redact(output.slice(-36_000), 36_000);
      saveSoon(task);
    },
    approve(requestId, title, details, respond, canAllow = true) {
      const id = randomUUID();
      const entry = {
        public: { id, taskId: task.id, title: redact(title), details: details.filter(Boolean).map((text) => redact(text, Infinity)), canAllow },
        requestId,
        respond,
        timer: setTimeout(() => {
          clearApproval(entry);
          respond(false);
          task.progress = '超时审批已拒绝';
        }, 5 * 60_000),
      };
      pending.set(id, entry);
    },
    resolveApproval(requestId) {
      for (const entry of pending.values()) {
        if (entry.public.taskId === task.id && entry.requestId === requestId) clearApproval(entry);
      }
    },
    clearApprovals() {
      for (const entry of pending.values()) {
        if (entry.public.taskId === task.id) clearApproval(entry);
      }
    },
    // Register a user-input question delivered on this task's live RPC. The public id is opaque and
    // per-panel; the answer is only ever pushed back through respond(), never stored or logged.
    question(record, respond) {
      const normalized = Array.isArray(record?.questions) ? record.questions : null;
      if (!normalized || !normalized.length) return false;
      const id = randomUUID();
      questions.set(id, {
        public: {
          id, taskId: task.id, threadId: record.threadId, itemId: record.itemId,
          isBlocking: record.isBlocking === true, questions: normalized,
        },
        requestId: record.requestId,
        respond,
      });
      return true;
    },
    resolveQuestion(requestId) {
      for (const entry of questions.values()) {
        if (entry.public.taskId === task.id && entry.requestId === requestId) settleQuestion(entry);
      }
    },
    clearQuestions() {
      for (const entry of questions.values()) {
        if (entry.public.taskId === task.id) settleQuestion(entry);
      }
    },
  };

  try {
    const outcome = await catalog[task.engine].run(task, context);
    if (outcome?.delivery === 'queued_to_original') {
      task.status = 'forwarded';
      task.progress = '已排队到原会话，由电脑端 Codex 继续处理；这里不会显示它的回答。';
      task.delivery = 'queued_to_original';
      if (outcome.submissionId) task.queuedSubmissionId = outcome.submissionId;
    } else {
      task.status = 'completed';
      task.progress = '任务已完成';
    }
  } catch (error) {
    task.status = 'failed';
    task.progress = '任务失败';
    task.error = redact(error.message);
    const failureCodes = ['thread_active_writer', 'thread_queue_rejected', 'thread_queue_unconfirmed'];
    if (failureCodes.includes(error?.code)) task.failureCode = error.code;
  } finally {
    saveTask(task);
    if (stopping && !isBusy()) closeListener();
  }
}

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

async function body(request) {
  if (request.headers['content-type'] !== 'application/json') throw new Error('请求必须是 JSON。');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65_536) throw new Error('请求内容过长。');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求格式无效。');
  return value;
}

function summarize(task) {
  return { id: task.id, engine: task.engine, status: task.status, title: redact(task.prompt, 80), created: task.created };
}

function describe(task) {
  return { ...summarize(task), prompt: redact(task.prompt, 12_000), cwd: task.cwd, threadId: task.threadId, resumeThreadId: task.resumeThreadId || null,
    progress: task.progress, error: task.error, failureCode: task.failureCode || null, storageIssue: task.storageIssue,
    delivery: task.delivery || null, queuedSubmissionId: task.queuedSubmissionId || null,
    output: [...task.output.values()].map((text) => redact(text, 48_000)).join('\n\n').slice(-48_000),
    commands: [...task.commands.values()].map((command) => ({ ...command, output: redact(command.output, 36_000) })),
  };
}

function resumeDelivery(task) {
  const failureCode = task.failureCode || null;
  const confirmedUnsent = task.status === 'failed' && (failureCode === 'thread_active_writer' || failureCode === 'thread_queue_rejected');
  const draft = confirmedUnsent ? redact(task.prompt, 12_000) : null;
  return { id: task.id, threadId: task.resumeThreadId || null, status: task.status,
    delivery: task.delivery || null, failureCode, error: task.error ? redact(task.error) : null,
    draft: draft !== null && draft === task.prompt ? draft : null };
}

const validThread = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const questionPublicId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const justCursor = (url) => url.searchParams.get('cursor')?.slice(0, 4_000);
const justRevision = (url) => url.searchParams.get('revision')?.slice(0, 128);

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  if (!request.url?.startsWith('/') || /^\/[\\/]/.test(request.url)) return json(response, 400, { error: '请求地址无效。' });
  const url = new URL(`http://127.0.0.1${request.url}`);
  const { pathname } = url;
  if (request.method === 'GET' && assets.has(pathname)) {
    const [data, type] = assets.get(pathname);
    response.writeHead(200, { 'Content-Type': type });
    response.end(data);
    return;
  }
  if (request.method === 'GET' && pathname === '/download/android.apk') {
    let streamSize;
    let selectedPackage;
    for (const candidate of androidPackageCandidates) {
      try { streamSize = statSync(candidate).size; selectedPackage = candidate; break; } catch {}
    }
    if (!selectedPackage) return json(response, 404, { error: 'Android 客户端安装包尚未就绪。' });
    response.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': `attachment; filename="${basename(selectedPackage)}"`,
      'Content-Length': streamSize,
    });
    const stream = createReadStream(selectedPackage);
    response.on('close', () => stream.destroy());
    stream.on('error', () => response.destroy());
    stream.pipe(response);
    return;
  }
  if (!pathname.startsWith('/api/')) return json(response, 404, { error: '页面不存在。' });

  // The browser sends the secret explicitly on every request; there are no ambient auth cookies.
  const authorization = request.headers.authorization || '';
  const presented = Buffer.from(authorization);
  const pairCode = presented.length === bearer.length && timingSafeEqual(presented, bearer);
  const device = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (request.method === 'POST' && pathname === '/api/pair') {
    request.resume();
    try { return pairDevice(response, pairCode, device); }
    catch { return json(response, 500, { error: '电脑端暂时无法保存配对，请重试。' }); }
  }
  if (!pairCode && !store.paired(device)) {
    return json(response, 401, { error: '设备授权已失效，请重新配对。' });
  }
  try {
    if (request.method === 'POST' && pathname === '/api/unpair') {
      if (!pairCode) store.unpair(device);
      return json(response, 200, { ok: true });
    }
    if (request.method === 'GET' && pathname === '/api/codex/threads') {
      if (!catalog.codex.history) return json(response, 409, { error: catalog.codex.issue });
      const list = await catalog.codex.history.list(historyOptions, {
        archived: url.searchParams.get('archived') === '1', cursor: justCursor(url), query: url.searchParams.get('q')?.trim().slice(0, 180),
      }, redact);
      return json(response, 200, list);
    }
    if (request.method === 'GET' && pathname === '/api/codex/models') {
      if (!catalog.codex.models) return json(response, 409, { error: catalog.codex.issue });
      return json(response, 200, await catalog.codex.models(historyOptions));
    }
    if (request.method === 'GET' && pathname.startsWith('/api/codex/activity/')) {
      const id = pathname.slice('/api/codex/activity/'.length);
      if (!validThread(id)) return json(response, 400, { error: '会话编号无效。' });
      if (!catalog.codex.activity) return json(response, 409, { error: catalog.codex.issue });
      return json(response, 200, await catalog.codex.activity.read(historyOptions, id, redact));
    }
    if (request.method === 'POST' && pathname.startsWith('/api/codex/activity/') && pathname.endsWith('/promote')) {
      const parts = pathname.slice('/api/codex/activity/'.length, -'/promote'.length).split('/');
      const id = parts.length === 3 && parts[1] === 'queue' ? parts[0] : null;
      const itemId = parts.length === 3 && parts[1] === 'queue' ? parts[2] : null;
      if (!validThread(id) || !validThread(itemId)) return json(response, 400, { error: '排队消息编号无效。' });
      if (!catalog.codex.activity) return json(response, 409, { error: catalog.codex.issue });
      await body(request);
      const result = await catalog.codex.activity.promote(historyOptions, id, itemId);
      if (!result.ok) {
        if (result.expired) return json(response, 409, { error: '这条排队消息已不存在或已开始执行。' });
        if (result.unavailable) return json(response, 409, { error: '本地 Codex 运行时暂时不可用。' });
        return json(response, 409, { error: '排队顺序已改变，请刷新后重试。' });
      }
      return json(response, 200, { ok: true, moved: result.moved });
    }
    if (request.method === 'GET' && pathname.startsWith('/api/codex/threads/')) {
      const id = pathname.slice('/api/codex/threads/'.length);
      if (!validThread(id)) return json(response, 400, { error: '会话编号无效。' });
      if (!catalog.codex.history) return json(response, 409, { error: catalog.codex.issue });
      return json(response, 200, await catalog.codex.history.read(historyOptions, id, justCursor(url), redact, justRevision(url)));
    }
    if (request.method === 'GET' && pathname === '/api/state') {
      const recent = [...tasks.values()].reverse();
      const summaryOnly = url.searchParams.get('summary') === '1';
      const task = summaryOnly ? null : tasks.get(url.searchParams.get('task')) || recent[0];
      const resumeThreadId = url.searchParams.get('resumeThreadId');
      const resumeTask = summaryOnly && validThread(resumeThreadId)
        ? recent.find((entry) => entry.resumeThreadId === resumeThreadId) : null;
      return json(response, 200, { cwd, engines: engineStatus, tasks: recent.slice(0, 24).map(summarize), task: task ? describe(task) : null,
        resumeDelivery: resumeTask ? resumeDelivery(resumeTask) : null,
        busy: isBusy(),
        approvals: [...pending.values()].map((entry) => entry.public),
        questions: [...questions.values()].map((entry) => entry.public) });
    }
    if (request.method === 'GET' && pathname === '/api/tasks') {
      const offset = Number(url.searchParams.get('offset') || 0);
      if (!Number.isSafeInteger(offset) || offset < 0) return json(response, 400, { error: '任务分页无效。' });
      const page = [...tasks.values()].reverse().slice(offset, offset + 24);
      return json(response, 200, { tasks: page.map(summarize), next: offset + page.length < tasks.size ? offset + page.length : null });
    }
    if (request.method === 'POST' && pathname === '/api/tasks') {
      if (stopping) return json(response, 503, { error: '电脑端正在重新启动，请稍后发送。' });
      const { id, engine, prompt, workspaceThread = null, resumeThreadId = null, model = null, effort = null } = await body(request);
      if (typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) {
        return json(response, 400, { error: '任务编号无效。' });
      }
      if (typeof engine !== 'string' || !Object.hasOwn(catalog, engine) || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12_000) {
        return json(response, 400, { error: '请选择工具，并输入 1 到 12000 个字符的任务。' });
      }
      const sameRequest = (task) => task.engine === engine && task.prompt === prompt.trim()
        && (task.workspaceThread || null) === workspaceThread && (task.resumeThreadId || null) === resumeThreadId
        && (task.model || null) === (typeof model === 'string' ? model.trim() : null)
        && (task.effort || null) === (typeof effort === 'string' ? effort.trim() : null);
      const existing = tasks.get(id);
      if (existing) {
        if (sameRequest(existing)) return json(response, 202, { id });
        return json(response, 409, { error: '任务编号已被另一项任务使用。' });
      }
      if (catalog[engine].issue) return json(response, 409, { error: catalog[engine].issue });
      let selectedModel = null;
      let selectedEffort = null;
      if (model !== null || effort !== null) {
        if (engine !== 'codex') return json(response, 400, { error: '只有 Codex 任务可以选择模型或推理强度。' });
        if (model !== null && (typeof model !== 'string' || !model.trim() || model.length > 120)) {
          return json(response, 400, { error: '选择的模型无效。' });
        }
        if (effort !== null && (typeof effort !== 'string' || !effort.trim() || effort.length > 40)) {
          return json(response, 400, { error: '选择的推理强度无效。' });
        }
        if (!catalog.codex.models) return json(response, 409, { error: catalog.codex.issue });
        let listing;
        try { listing = await catalog.codex.models(historyOptions); }
        catch (error) { return json(response, 409, { error: redact(error.message) }); }
        const available = Array.isArray(listing?.models) ? listing.models : [];
        if (model !== null) {
          const match = available.find((entry) => entry && entry.id === model.trim());
          if (!match) return json(response, 400, { error: '选择的模型当前不可用。' });
          selectedModel = match.id;
          if (effort !== null) {
            const allowed = (match.supportedReasoningEfforts || []).some((entry) => entry.reasoningEffort === effort.trim());
            if (!allowed) return json(response, 400, { error: '选择的推理强度不受该模型支持。' });
            selectedEffort = effort.trim();
          }
        } else {
          const fallback = available.find((entry) => entry && entry.isDefault);
          if (!fallback) return json(response, 400, { error: '请先选择模型，再指定推理强度。' });
          const allowed = (fallback.supportedReasoningEfforts || []).some((entry) => entry.reasoningEffort === effort.trim());
          if (!allowed) return json(response, 400, { error: '选择的推理强度不受默认模型支持。' });
          selectedEffort = effort.trim();
        }
      }
      let project = cwd;
      if (resumeThreadId !== null) {
        if (workspaceThread !== null) return json(response, 400, { error: '不能同时指定项目会话和要接续的会话。' });
        if (engine !== 'codex') return json(response, 400, { error: '只有 Codex 任务可以接续已有会话。' });
        if (!validThread(resumeThreadId) || !catalog.codex.history) return json(response, 400, { error: '要接续的会话编号无效。' });
        let info;
        try { info = await catalog.codex.history.info(historyOptions, resumeThreadId); }
        catch { return json(response, 409, { error: '找不到要接续的 Codex 会话。' }); }
        if (typeof info.cwd !== 'string' || !info.cwd) return json(response, 409, { error: '所选 Codex 会话缺少工作目录，无法接续。' });
        if (info.status === 'active') return json(response, 409, { error: '所选 Codex 会话正在运行，请等它结束后再接续。' });
        project = workspacePath(info.cwd, engine === 'codex');
      } else if (workspaceThread !== null) {
        if (!validThread(workspaceThread) || !catalog.codex.history) return json(response, 400, { error: '所选任务目录无效。' });
        project = workspacePath(await catalog.codex.history.workspace(historyOptions, workspaceThread), engine === 'codex');
      }
      // Derived server-side from an authenticated, server-resolved native thread cwd only; never read from the request body.
      const guardRoot = guardedParent && samePath(project, guardedParent) ? realRoot : null;
      if (tasks.has(id)) {
        const raced = tasks.get(id);
        if (sameRequest(raced)) return json(response, 202, { id });
        return json(response, 409, { error: '任务编号已被另一项任务使用。' });
      }
      if (stopping) return json(response, 503, { error: '电脑端正在重新启动，请稍后发送。' });
      if (isBusy()) {
        return json(response, 409, { error: '正在处理一项任务。完成后可以发送下一项。' });
      }
      const task = { id, engine, prompt: prompt.trim(), status: 'running', progress: '正在连接本地工具',
        created: Date.now(), cwd: project, workspaceThread, resumeThreadId, output: new Map(), commands: new Map(),
        ...(guardRoot ? { guardRoot } : {}),
        ...(selectedModel ? { model: selectedModel } : {}), ...(selectedEffort ? { effort: selectedEffort } : {}) };
      store.saveTask(task);
      tasks.set(task.id, task);
      void runTask(task);
      return json(response, 202, { id: task.id });
    }
    if (request.method === 'POST' && pathname.startsWith('/api/questions/')) {
      const id = pathname.slice('/api/questions/'.length);
      const entry = questionPublicId.test(id) ? questions.get(id) : undefined;
      if (!entry) {
        const handled = questionPublicId.test(id) && settledQuestions.has(id);
        return json(response, handled ? 409 : 404, { error: handled ? '这个问题已经处理过了。' : '这个问题已结束或不存在。' });
      }
      const { answers } = await body(request);
      const checked = validateQuestionAnswers(entry.public.questions, answers);
      if (checked.error) return json(response, 400, { error: checked.error });
      // Validate before consuming so a malformed submission can be corrected and resent.
      // Re-check against the live map after the body await: a concurrent submission or a
      // serverRequest/resolved may have settled this entry meanwhile, and only the handler that
      // still owns the live entry may answer, so exactly one response is delivered.
      if (questions.get(id) !== entry) {
        const handled = settledQuestions.has(id);
        return json(response, handled ? 409 : 404, { error: handled ? '这个问题已经处理过了。' : '这个问题已结束或不存在。' });
      }
      settleQuestion(entry);
      const delivered = entry.respond(checked.answers);
      if (delivered !== true) return json(response, 409, { error: '该问题所在的运行已结束，回答未送达。' });
      const task = tasks.get(entry.public.taskId);
      if (task) task.progress = '已回答提问';
      return json(response, 200, { ok: true });
    }
    if (request.method === 'POST' && pathname.startsWith('/api/approvals/')) {
      const { allow } = await body(request);
      if (typeof allow !== 'boolean') return json(response, 400, { error: '请选择允许或拒绝。' });
      const entry = pending.get(pathname.slice('/api/approvals/'.length));
      if (!entry) return json(response, 409, { error: '这条审批已处理或超时。' });
      if (allow && !entry.public.canAllow) return json(response, 400, { error: '此请求未提供单次授权。' });
      clearApproval(entry);
      entry.respond(allow);
      const task = tasks.get(entry.public.taskId);
      if (task) task.progress = allow ? '审批已允许' : '审批已拒绝';
      return json(response, 200, { ok: true });
    }
    return json(response, 404, { error: '接口不存在。' });
  } catch (error) {
    if (!response.destroyed) json(response, 400, { error: redact(error.message) });
  }
});

server.listen(port, '127.0.0.1', () => {
  if (desktopMode) {
    desktopEvent('ready');
    return;
  }
  console.log(`面板地址  http://127.0.0.1:${port}`);
  console.log(`连接码    ${code}`);
  console.log(`任务目录  ${cwd}`);
});

function closeListener() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
}

if (desktopMode) {
  const control = createInterface({ input: process.stdin, crlfDelay: Infinity });
  control.once('close', () => {
    if (stopping) return;
    stopping = true;
    if (!isBusy()) closeListener();
  });
  control.on('line', (action) => {
    if (action === 'status') desktopEvent('state');
    if (action === 'rotate') { renewPin(); desktopEvent('state'); }
    if (action !== 'stop' || stopping) return;
    if (isBusy()) { desktopEvent('busy'); return; }
    stopping = true;
    desktopEvent('stopping');
    control.close();
    closeListener();
  });
}
