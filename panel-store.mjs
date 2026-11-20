import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function read(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function save(path, data) {
  const staging = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(staging, JSON.stringify(data), { mode: 0o600 });
    renameSync(staging, path);
  } finally {
    rmSync(staging, { force: true });
  }
}

const digest = (token) => createHash('sha256').update(token).digest('hex');

export function panelStore(directory) {
  const taskDir = join(directory, 'tasks');
  const deviceFile = join(directory, 'devices.json');
  mkdirSync(taskDir, { recursive: true });
  let devices = read(deviceFile, []);
  const taskPath = (id) => join(taskDir, `${id}.json`);

  return {
    paired(token) {
      return token.startsWith('panel_') && devices.includes(digest(token));
    },
    pair() {
      const token = `panel_${randomBytes(32).toString('base64url')}`;
      const next = [...devices.slice(-31), digest(token)];
      save(deviceFile, next);
      devices = next;
      return token;
    },
    unpair(token) {
      const current = digest(token);
      const next = devices.filter((device) => device !== current);
      if (next.length !== devices.length) save(deviceFile, next);
      devices = next;
    },
    resetDevices() {
      save(deviceFile, []);
      devices = [];
    },
    tasks() {
      const records = [];
      for (const name of readdirSync(taskDir)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
        try {
          const record = read(join(taskDir, name));
          if (!record || `${record.id}.json` !== name) continue;
          if (record.status === 'running') {
            record.status = 'interrupted';
            record.progress = '电脑端连接已中断';
          }
          records.push({ ...record, output: new Map(record.output), commands: new Map(record.commands) });
        } catch (error) {
          console.error(`读取任务记录失败（${error.code || '格式无效'}）。`);
        }
      }
      records.sort((a, b) => a.created - b.created);
      return new Map(records.map((record) => [record.id, record]));
    },
    saveTask(task) {
      save(taskPath(task.id), { ...task, output: [...task.output], commands: [...task.commands] });
    },
  };
}
