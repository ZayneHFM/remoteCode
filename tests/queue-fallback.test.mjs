// Detached test: exercises the cross-writer queue fallback in engines.mjs with a fake RPC.
// No real Codex runtime, no frontend, no live panel restart.
import assert from 'node:assert/strict';
import { runCodex } from '../engines.mjs';

class FakeRpc {
  constructor(plan) {
    this.plan = plan;
    this.calls = [];
    this.closed = false;
    this.done = new Promise(() => {});
  }
  send(frame) { this.calls.push({ kind: 'send', frame }); return true; }
  request(method, params, timeout) {
    this.calls.push({ kind: 'request', method, params, timeout });
    const handler = this.plan[method];
    if (typeof handler === 'function') return handler(params, this);
    if (handler instanceof Error) return Promise.reject(handler);
    return Promise.resolve(handler ?? {});
  }
  unsupported() {}
  async close() { this.closed = true; }
}

const TASK_ID = 'e7a1c2d3-0000-4000-8000-000000000001';
const THREAD_ID = 'thread-owner-1';

const activeWriter = () => new Error('Thread ' + THREAD_ID + ' already has an active writer.');
const queued = (id) => ({ queuedSubmission: { id } });

function baseTask(extra = {}) {
  return { id: TASK_ID, engine: 'codex', prompt: '原始指令 keep me', resumeThreadId: THREAD_ID, cwd: 'D:\\work', ...extra };
}

function contextFor(log) {
  return {
    cwd: 'D:\\work', env: {}, dshHome: 'D:\\work\\.dsh',
    progress: (t) => log.push(['progress', t]),
    associateThread: (id) => log.push(['associateThread', id]),
    output() {}, command() {}, commandOutput() {}, finishCommand() {},
    approve() {}, resolveApproval() {}, clearApprovals() {},
  };
}

function rpcFor(queueResult) {
  return new FakeRpc({ initialize: {}, 'thread/resume': activeWriter(), 'thread/queue/add': queueResult });
}

const callsOf = (rpc, method) => rpc.calls.filter((call) => call.kind === 'request' && call.method === method);

const checks = [];
const test = (name, fn) => checks.push([name, fn]);

test('one add only, original thread id, default input, ack outcome', async () => {
  const log = [];
  const rpc = rpcFor(queued('sub-9001'));
  const result = await runCodex('codex.exe', baseTask(), contextFor(log), () => rpc);

  const adds = callsOf(rpc, 'thread/queue/add');
  assert.equal(adds.length, 1, 'exactly one thread/queue/add');
  assert.deepEqual(adds[0].params, {
    threadId: THREAD_ID,
    input: [{ type: 'text', text: '原始指令 keep me', text_elements: [] }],
    clientUserMessageId: TASK_ID,
  });
  assert.equal(Object.hasOwn(adds[0].params, 'model'), false, 'no model forwarded');
  assert.equal(Object.hasOwn(adds[0].params, 'effort'), false, 'no effort forwarded');
  assert.equal(callsOf(rpc, 'thread/resume').length, 1, 'no second resume');
  assert.equal(callsOf(rpc, 'turn/start').length, 0, 'no turn/start after add');
  assert.deepEqual(result, { delivery: 'queued_to_original', submissionId: 'sub-9001' });
  assert.deepEqual(log[0], ['associateThread', THREAD_ID], 'original thread associated');
});

test('ack without a real submission id is unconfirmed, single attempt only', async () => {
  const rpc = rpcFor({ queuedSubmission: {} });
  await assert.rejects(
    runCodex('codex.exe', baseTask(), contextFor([]), () => rpc),
    (error) => error.code === 'thread_queue_unconfirmed',
  );
  assert.equal(callsOf(rpc, 'thread/queue/add').length, 1, 'never retried');
});

test('duplicate acknowledgement for the same client id is unconfirmed, single attempt only', async () => {
  const rpc = rpcFor({ queuedSubmission: { duplicate: true } });
  await assert.rejects(
    runCodex('codex.exe', baseTask(), contextFor([]), () => rpc),
    (error) => error.code === 'thread_queue_unconfirmed',
  );
  assert.equal(callsOf(rpc, 'thread/queue/add').length, 1, 'never retried');
});

test('explicit model override is blocked, no queue add', async () => {
  const rpc = rpcFor(queued('should-not-happen'));
  await assert.rejects(
    runCodex('codex.exe', baseTask({ model: 'gpt-5' }), contextFor([]), () => rpc),
    (error) => error.code === 'thread_active_writer',
  );
  assert.equal(callsOf(rpc, 'thread/queue/add').length, 0);
});

test('explicit effort override is blocked, no queue add', async () => {
  const rpc = rpcFor(queued('should-not-happen'));
  await assert.rejects(
    runCodex('codex.exe', baseTask({ effort: 'high' }), contextFor([]), () => rpc),
    (error) => error.code === 'thread_active_writer',
  );
  assert.equal(callsOf(rpc, 'thread/queue/add').length, 0);
});

test('uncertain acknowledgement -> thread_queue_unconfirmed, single attempt only', async () => {
  const rpc = rpcFor(new Error('thread/queue/add 响应超时。'));
  await assert.rejects(
    runCodex('codex.exe', baseTask(), contextFor([]), () => rpc),
    (error) => error.code === 'thread_queue_unconfirmed',
  );
  assert.equal(callsOf(rpc, 'thread/queue/add').length, 1, 'never retried');
});

test('definitive rejection -> thread_queue_rejected, single attempt only', async () => {
  const refused = new Error('thread not found');
  refused.rpcError = true;
  const rpc = rpcFor(refused);
  await assert.rejects(
    runCodex('codex.exe', baseTask(), contextFor([]), () => rpc),
    (error) => error.code === 'thread_queue_rejected',
  );
  assert.equal(callsOf(rpc, 'thread/queue/add').length, 1, 'never retried');
});

test('unrelated resume failures still propagate without a queue add', async () => {
  const rpc = new FakeRpc({ initialize: {}, 'thread/resume': new Error('boom other') });
  await assert.rejects(
    runCodex('codex.exe', baseTask(), contextFor([]), () => rpc),
    (error) => error.message === 'boom other',
  );
  assert.equal(callsOf(rpc, 'thread/queue/add').length, 0);
});

let failed = 0;
for (const [name, fn] of checks) {
  try { await fn(); console.log('PASS ' + name); }
  catch (error) { failed += 1; console.log('FAIL ' + name + ': ' + error.message); }
}
console.log(failed ? '\n' + failed + '/' + checks.length + ' failed' : '\nall ' + checks.length + ' passed');
process.exit(failed ? 1 : 0);
