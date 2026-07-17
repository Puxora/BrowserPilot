// Chrome Automation Plugin - Cron 调度器
// 基于 croner 的定时任务调度

import Cron from 'croner';
import { watch } from 'fs';
import { TaskStore } from './storage.js';
import { TaskEngine } from './task-engine.js';

export class TaskScheduler {
  constructor(config, wsServer) {
    this.config = config;
    this.store = new TaskStore(config);
    this.engine = new TaskEngine(wsServer, this.store, config);
    this.tabToTask = new Map();
    this.engine.setTabClaimHandler((taskId, tabId, claimed) => {
      if (claimed) this.tabToTask.set(tabId, taskId);
      else if (this.tabToTask.get(tabId) === taskId) this.tabToTask.delete(tabId);
    });
    this.jobs = new Map();   // taskId → CronJob
    this.running = new Map(); // taskId -> AbortController
    this._started = false;
    this._taskWatcher = null;
    this._taskReloadTimers = new Map();
  }

  get taskCount() {
    return this.jobs.size;
  }

  get activeJobs() {
    return Array.from(this.jobs.keys());
  }

  /** 启动调度器：加载所有任务并注册 cron job */
  async start() {
    if (this._started) return;
    this._started = true;
    const tasks = await this.store.list();

    for (const task of tasks) {
      if (task.enabled !== false) {
        try {
          this._scheduleTask(task);
        } catch {
          // 保留其余有效任务，损坏的历史任务由管理界面修复。
        }
      }
    }

    console.log(`[Scheduler] 已加载 ${tasks.length} 个任务, ${this.jobs.size} 个已激活`);
    this._watchTaskDirectory();
  }

  /** 添加新任务 */
  addTask(task) {
    if (task.enabled !== false) {
      this._scheduleTask(task);
    }
  }

  /** 重新加载已更新的任务 */
  reloadTask(task) {
    if (task.enabled === false) return this._cancelJob(task.id);

    // 1. 先验证 cron 表达式是否合法，防止因表达式无效导致旧的调度白白被停掉
    try {
      const temp = new Cron(task.schedule);
      temp.stop();
    } catch (err) {
      throw new Error(`Cron 表达式无效: ${err.message}`);
    }

    // 2. 同时清理调度器记录和 Croner 全局注册表。前者可能因异常重载、
    // 重复启动等边缘情况与后者不同步，不能只依赖 this.jobs。
    this._cancelJob(task.id);

    // 3. 构造并启动新的 job
    const nextJob = this._createJob(task);
    this.jobs.set(task.id, nextJob);
  }

  /** 移除任务 */
  removeTask(taskId) {
    this._cancelJob(taskId);
  }

  /** 立即执行任务 */
  async runNow(taskId, trigger = 'manual') {
    if (this.running.has(taskId)) {
      throw new Error('任务正在执行中');
    }

    const task = await this.store.get(taskId);
    if (!task) throw new Error('任务不存在');

    // 异步执行，不阻塞 API 响应
    this._executeTask(task, trigger).catch(err => {
      console.error(`[Scheduler] 任务 ${task.name} 执行失败:`, err.message);
    });
  }

  /** 获取下次运行时间 */
  getNextRun(taskId) {
    const job = this.jobs.get(taskId);
    return job ? job.nextRun() : null;
  }

  /** 检查任务是否正在运行 */
  isRunning(taskId) {
    return this.running.has(taskId);
  }

  cancel(taskId) {
    const controller = this.running.get(taskId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  cancelByTab(tabId) {
    const taskId = this.tabToTask.get(tabId);
    return taskId ? this.cancel(taskId) : false;
  }

  setOperationPolicy(policy) {
    this.engine.setOperationPolicy(policy);
  }

  /** 停止调度器 */
  stop() {
    this._started = false;
    this._taskWatcher?.close();
    this._taskWatcher = null;
    for (const timer of this._taskReloadTimers.values()) clearTimeout(timer);
    this._taskReloadTimers.clear();
    for (const [id, job] of this.jobs) {
      job.stop();
    }
    this.jobs.clear();
    for (const controller of this.running.values()) controller.abort();
    console.log('[Scheduler] 调度器已停止');
  }

  // ── 内部 ──────────────────────────

  _watchTaskDirectory() {
    if (this._taskWatcher) return;

    try {
      this._taskWatcher = watch(this.store.taskDir, (_eventType, filename) => {
        const name = String(filename || '');
        if (!name.endsWith('.task.mjs')) return;

        const taskId = name.slice(0, -'.task.mjs'.length);
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(taskId)) return;
        this._queueTaskFileSync(taskId);
      });
      this._taskWatcher.on('error', (error) => {
        console.error('[Scheduler] 任务目录监听失败:', error.message);
      });
      console.log(`[Scheduler] 正在监听任务目录: ${this.store.taskDir}`);
    } catch (error) {
      console.error('[Scheduler] 无法监听任务目录:', error.message);
    }
  }

  _queueTaskFileSync(taskId) {
    const previousTimer = this._taskReloadTimers.get(taskId);
    if (previousTimer) clearTimeout(previousTimer);

    const timer = setTimeout(() => {
      this._taskReloadTimers.delete(taskId);
      this._syncTaskFile(taskId).catch((error) => {
        console.error(`[Scheduler] 同步任务文件失败 (${taskId}):`, error.message);
      });
    }, 150);
    timer.unref?.();
    this._taskReloadTimers.set(taskId, timer);
  }

  async _syncTaskFile(taskId) {
    if (!this._started) return;

    let task;
    try {
      task = await this.store.get(taskId);
    } catch (error) {
      // 编辑过程中的短暂不完整 JS 不应破坏正在运行的旧调度。
      console.error(`[Scheduler] 任务文件无效，保留旧调度 (${taskId}):`, error.message);
      return;
    }

    if (!task) {
      this._cancelJob(taskId);
      console.log(`[Scheduler] 任务文件已删除，停止调度: ${taskId}`);
      return;
    }

    try {
      this.reloadTask(task);
      const next = this.getNextRun(taskId);
      console.log(`[Scheduler] 已同步任务文件: ${taskId} — 下次: ${next ? next.toLocaleString('zh-CN') : '已停用'}`);
    } catch (error) {
      console.error(`[Scheduler] 任务配置无效，保留旧调度 (${taskId}):`, error.message);
    }
  }

  _scheduleTask(task) {
    try {
      this._cancelJob(task.id);
      const job = this._createJob(task);
      this.jobs.set(task.id, job);
      const next = job.nextRun();
      console.log(`[Scheduler] ✓ "${task.name}" — ${task.schedule} — 下次: ${next ? next.toLocaleString('zh-CN') : 'N/A'}`);
    } catch (err) {
      console.error(`[Scheduler] ✗ "${task.name}" cron 表达式无效: ${task.schedule} — ${err.message}`);
      throw err;
    }
  }

  _createJob(task) {
    return new Cron(task.schedule, {
        name: task.id,
        protect: true, // 防止任务重叠（上一次未完成不触发下一次）
      }, () => {
        this._executeTask(task, 'scheduled').catch(err => {
          console.error(`[Scheduler] 任务 ${task.name} 执行失败:`, err.message);
        });
      });
  }

  _cancelJob(taskId) {
    const job = this.jobs.get(taskId);
    job?.stop();
    this.jobs.delete(taskId);

    // Croner 会将具名任务保存在模块级 scheduledJobs 中。若此前的任务
    // 未被 this.jobs 跟踪，仍需显式停止，否则同名任务无法重新注册。
    for (const namedJob of [...Cron.scheduledJobs]) {
      if (namedJob.name === taskId) {
        namedJob.stop();
      }
    }
  }

  async _executeTask(task, trigger) {
    if (this.running.has(task.id)) {
      console.warn(`[Scheduler] 任务已在执行，跳过重复触发: ${task.name}`);
      return;
    }
    if (this.running.size >= this.config.maxConcurrentTasks) {
      console.warn(`[Scheduler] 并发上限 (${this.config.maxConcurrentTasks})，跳过: ${task.name}`);
      return;
    }

    const controller = new AbortController();
    this.running.set(task.id, controller);
    const startTime = Date.now();

    await this.store.appendLog(task.id, {
      type: 'start',
      taskName: task.name,
      trigger,
    });

    try {
      const result = await this.engine.execute(task, { signal: controller.signal });
      const duration = Date.now() - startTime;

      await this.store.appendLog(task.id, {
        type: 'complete',
        taskName: task.name,
        durationMs: duration,
        stepsExecuted: result.stepsExecuted,
        stepsFailed: result.stepsFailed,
      });

      console.log(`[Scheduler] ✓ "${task.name}" 完成 — ${result.stepsExecuted} 步, ${duration}ms`);
    } catch (err) {
      const duration = Date.now() - startTime;

      await this.store.appendLog(task.id, {
        type: 'error',
        taskName: task.name,
        durationMs: duration,
        error: err.message,
      });

      console.error(`[Scheduler] ✗ "${task.name}" 失败 — ${err.message}`);
    } finally {
      this.running.delete(task.id);
    }
  }
}
