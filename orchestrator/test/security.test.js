import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Cron from 'croner';
import { TaskEngine } from '../src/task-engine.js';
import { TaskScheduler } from '../src/scheduler.js';
import { hostMatches } from '../src/security-policy.js';
import { TaskStore, validateSettings, validateTaskId } from '../src/storage.js';
import { WebUiServer } from '../src/web-server.js';
import { ApiTokenStore } from '../src/token-store.js';

test('task identifiers reject path traversal', () => {
  assert.equal(validateTaskId('task-1234-safe'), 'task-1234-safe');
  for (const id of ['../task', 'task/name', 'task.name', '', 'a'.repeat(129)]) {
    assert.throws(() => validateTaskId(id), /任务 ID 格式无效/);
  }
});

test('settings use a strict whitelist', () => {
  assert.deepEqual(validateSettings({
    approval: 'always', download: 'ask', upload: 'none', cdpEnabled: false,
    sitePermissions: [{ site: 'github.com', approval: 'none' }]
  }).sitePermissions, [{ site: 'github.com', approval: 'none' }]);
  assert.throws(() => validateSettings({ approval: 'none', arbitrary: true }), /不支持的设置项/);
  assert.throws(() => validateSettings({ sitePermissions: [{ site: 'github.com.evil', approval: 'invalid' }] }), /无效规则/);
});

test('site permission matching permits only exact hosts and dot subdomains', () => {
  assert.equal(hostMatches('github.com', 'github.com'), true);
  assert.equal(hostMatches('api.github.com', 'github.com'), true);
  assert.equal(hostMatches('github.com.evil.example', 'github.com'), false);
});

test('external listener does not trust a forged localhost Host header', () => {
  const server = new WebUiServer({
    webHost: '0.0.0.0', trustedHosts: ['console.example.test'],
    visualControlLeaseMs: 1, webUiDir: '.', apiToken: 'test-token',
    webPort: 9876, taskDir: '.', logDir: '.', wsPort: 9877, trustedOrigins: []
  }, { isConnected: () => false });
  assert.equal(server._isAllowedHost('localhost', '203.0.113.10'), false);
  assert.equal(server._isAllowedHost('console.example.test', '203.0.113.10'), true);
});

test('issued API tokens are verifiable and can be revoked', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'browserpilot-tokens-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ApiTokenStore({ tokenStorePath: join(directory, 'tokens.json'), apiToken: 'local-token' });
  const issued = await store.create('wsl');
  assert.equal(await store.verify(issued.token), true);
  assert.equal(await store.verify('invalid-token'), false);
  assert.equal(await store.revoke(issued.id), true);
  assert.equal(await store.verify(issued.token), false);
  assert.equal(await store.verify('local-token'), true);
});

test('transfer policies send real upload and download decisions to Chrome', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'browserpilot-transfer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const commands = [];
  const config = {
    webHost: '127.0.0.1', trustedHosts: [], trustedOrigins: [], visualControlLeaseMs: 1,
    webUiDir: '.', apiToken: 'test-token', tokenStorePath: join(directory, 'tokens.json'),
    webPort: 0, taskDir: directory, logDir: directory, settingsPath: join(directory, 'settings.json'), wsPort: 9877
  };
  const server = new WebUiServer(config, {
    isConnected: () => true,
    async sendCommand(action, params, tabId) {
      commands.push({ action, params, tabId });
      return { ok: true };
    }
  });

  await writeFile(config.settingsPath, JSON.stringify({
    approval: 'always', download: 'none', upload: 'always', cdpEnabled: false, sitePermissions: []
  }), 'utf8');
  await server._handleDownloadEvent({ downloadId: 11 });
  await server._handleUploadEvent({ uploadId: 'upload-11', tabId: 42, accept: '.pdf' });

  assert.deepEqual(commands, [
    { action: 'cancelDownload', params: { downloadId: 11 }, tabId: undefined },
    { action: 'approveUpload', params: { uploadId: 'upload-11' }, tabId: 42 }
  ]);
});

test('visual control leases cannot be claimed or stopped by another session', () => {
  const server = new WebUiServer({
    webHost: '127.0.0.1', trustedHosts: [], visualControlLeaseMs: 1,
    webUiDir: '.', apiToken: 'test-token', webPort: 9876, taskDir: '.', logDir: '.',
    wsPort: 9877, trustedOrigins: []
  }, { isConnected: () => false });

  server.visualLeases.leases.set(42, { sessionId: 'first-session', timer: null });

  assert.equal(server._canControlTab('claimTab', 42, {}, 'second-session'), false);
  assert.equal(server._canControlTab('visualStop', 42, {}, 'second-session'), false);
  assert.equal(server._canControlTab('claimTab', 42, {}, 'first-session'), true);
  assert.equal(server._canControlTab('visualStop', 42, {}, 'first-session'), true);
  assert.equal(server._canControlTab('visualStop', undefined, {}, 'first-session'), false);
  assert.equal(server._canControlTab('visualStop', 43, {}, 'second-session'), true);
});

test('scheduler reload removes an orphaned named Croner job', (t) => {
  const taskId = `scheduler-reload-${Date.now()}`;
  const scheduler = new TaskScheduler({ defaultTimeoutMs: 1000 }, {});
  const task = {
    id: taskId,
    name: '重载测试',
    schedule: '0 8 * * *',
    enabled: true,
    async run() {},
  };
  const orphanedJob = new Cron(task.schedule, { name: taskId }, () => {});
  t.after(() => {
    scheduler.stop();
    orphanedJob.stop();
  });

  scheduler.reloadTask(task);

  assert.equal(scheduler.jobs.has(taskId), true);
  assert.equal(Cron.scheduledJobs.filter(job => job.name === taskId).length, 1);
});

test('scheduler watches task files and reloads modified schedules', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'browserpilot-watch-'));
  const taskId = `watch-task-${Date.now()}`;
  const taskFile = join(directory, `${taskId}.task.mjs`);
  const config = { taskDir: directory, logDir: directory, defaultTimeoutMs: 1000 };
  const scheduler = new TaskScheduler(config, {});
  t.after(async () => {
    scheduler.stop();
    await rm(directory, { recursive: true, force: true });
  });

  await writeFile(taskFile, `export default {
    name: '文件监听测试', schedule: '0 8 * * *', enabled: true,
    async run() {},
  };\n`, 'utf8');
  await scheduler.start();

  await writeFile(taskFile, `export default {
    name: '文件监听测试', schedule: '*/10 * * * * *', enabled: true,
    async run() {},
  };\n`, 'utf8');

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const nextRun = scheduler.getNextRun(taskId);
    if (nextRun && nextRun.getTime() - Date.now() < 11000) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  const nextRun = scheduler.getNextRun(taskId);
  assert.ok(nextRun, '修改后的任务应保留下一次触发时间');
  assert.ok(nextRun.getTime() - Date.now() < 11000, '应使用每 10 秒的新规则');
});

test('invalid JS module update restores the previous source', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'browserpilot-task-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'task-rollback.task.mjs');
  const originalContent = `export default {
    name: 'previous', schedule: '0 8 * * *', async run() {},
  };\n`;
  await writeFile(file, originalContent, 'utf8');
  const store = new TaskStore({ taskDir: directory, logDir: directory });

  await assert.rejects(
    store.saveSource('task-rollback', 'export default { name: "next", schedule: "0 8 * * *" };\n'),
    /run/
  );

  assert.equal(await readFile(file, 'utf8'), originalContent);
});

test('task detail API adds runtime state without mutating the frozen task definition', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'browserpilot-task-detail-'));
  const taskId = 'task-detail';
  await writeFile(join(directory, `${taskId}.task.mjs`), `export default {
    name: '详情测试', schedule: '0 8 * * *', async run() {},
  };\n`, 'utf8');
  const server = new WebUiServer({
    webHost: '127.0.0.1', trustedHosts: [], visualControlLeaseMs: 1,
    webUiDir: '.', apiToken: 'test-token', webPort: 0, taskDir: directory,
    logDir: directory, wsPort: 9877, trustedOrigins: [], tokenStorePath: join(directory, 'tokens.json')
  }, { isConnected: () => false });
  server.setScheduler({
    setOperationPolicy() {},
    getNextRun: () => new Date('2026-07-16T00:00:00.000Z'),
    isRunning: () => false,
  });
  await server.start();
  t.after(async () => {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  });

  const port = server.server.address().port;
  const unauthorized = await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}`);
  assert.equal(unauthorized.status, 401);
  const response = await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}`, {
    headers: { Authorization: 'Bearer test-token' }
  });
  const body = await response.json();
  assert.equal(body.code, 0);
  assert.equal(body.data.name, '详情测试');
  assert.equal(body.data.isRunning, false);
  assert.equal(body.data.nextRun, '2026-07-16T00:00:00.000Z');
  assert.match(body.data.source, /export default/);
});

test('task cancellation interrupts a pending wait', async () => {
  const wsServer = {
    async sendCommand(action) {
      if (action === 'createTab') return { tabId: 7 };
      return { tabId: 7 };
    }
  };
  const store = { async appendLog() {} };
  const engine = new TaskEngine(wsServer, store, {
    defaultTimeoutMs: 1000,
    actionDelayMin: 0,
    actionDelayMax: 0
  });
  const controller = new AbortController();
  const run = engine.execute({
    id: 'task-cancel', name: 'cancel', options: {},
    async run(ctx) { await ctx.wait(10000); }
  }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(run, /任务已取消/);
});
