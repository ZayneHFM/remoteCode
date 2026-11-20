import { createHash } from 'node:crypto';

const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';

export function commandItem(item) {
  return {
    id: item.id,
    text: text(item.command, 20_000),
    cwd: text(item.cwd, 4_000),
    status: item.status,
    exitCode: item.exitCode,
    output: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput.slice(-36_000) : undefined,
  };
}

export function createCodexHistory(connect) {
  let ready;
  function client(options) {
    if (!ready) {
      ready = connect(options).then((rpc) => {
        rpc.done.then(() => { ready = undefined; });
        return rpc;
      }, (error) => {
        ready = undefined;
        throw error;
      });
    }
    return ready;
  }

  function summary(thread, redact) {
    return {
      id: thread.id,
      title: redact(thread.name || thread.preview || '未命名会话', 160).replace(/\s+/g, ' '),
      cwd: redact(thread.cwd, 4_000),
      updatedAt: thread.updatedAt,
      status: thread.status?.type,
    };
  }

  function projectTurn(turn, redact) {
    const items = [];
    for (const item of turn.items || []) {
      if (item.type === 'userMessage') {
        const message = (item.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
        if (message) items.push({ type: 'user', id: item.id, text: redact(message, 32_000) });
      } else if (item.type === 'agentMessage' && item.text) {
        items.push({ type: 'assistant', id: item.id, text: redact(item.text, 64_000) });
      } else if (item.type === 'commandExecution') {
        const command = commandItem(item);
        items.push({ ...command, type: 'command', text: redact(command.text, 20_000), cwd: redact(command.cwd, 4_000), output: redact(command.output, 36_000) });
      }
    }
    return { id: turn.id, status: turn.status, items };
  }

  function presentationHash(thread, turns) {
    const stable = {
      id: thread.id,
      title: thread.title,
      cwd: thread.cwd,
      status: thread.status,
      turns: turns.map((turn) => ({
        id: turn.id,
        status: turn.status,
        items: (turn.items || []).map((item) => ({
          id: item.id, type: item.type, text: item.text, status: item.status, exitCode: item.exitCode, output: item.output,
        })),
      })),
    };
    return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 32);
  }

  return {
    async list(options, { archived, cursor, query }, redact) {
      const rpc = await client(options);
      const result = await rpc.request('thread/list', {
        limit: 24,
        archived,
        ...(cursor ? { cursor } : {}),
        ...(query ? { searchTerm: query } : {}),
      });
      return { threads: result.data.map((thread) => summary(thread, redact)), cursor: result.nextCursor || null };
    },

    async read(options, id, cursor, redact, revision) {
      const rpc = await client(options);
      const [metadata, page] = await Promise.all([
        rpc.request('thread/read', { threadId: id, includeTurns: false }),
        rpc.request('thread/turns/list', {
          threadId: id, limit: 8, sortDirection: 'desc', itemsView: 'full', ...(cursor ? { cursor } : {}),
        }),
      ]);
      const thread = summary(metadata.thread, redact);
      const turns = page.data.map((turn) => projectTurn(turn, redact));
      if (cursor) return { thread, turns, cursor: page.nextCursor || null };
      const head = presentationHash(thread, turns);
      if (revision && revision === head) return { unchanged: true, revision: head };
      return { thread, turns, cursor: page.nextCursor || null, revision: head };
    },

    async info(options, id) {
      const rpc = await client(options);
      const { thread } = await rpc.request('thread/read', { threadId: id, includeTurns: false });
      return { cwd: thread.cwd, status: thread.status?.type };
    },

    async workspace(options, id) {
      return (await this.info(options, id)).cwd;
    },
  };
}
