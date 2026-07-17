// BrowserPilot - JS 任务模块定义与校验

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function validateTaskId(id) {
  if (!TASK_ID_PATTERN.test(String(id || ''))) throw new Error('任务 ID 格式无效');
  return String(id);
}

/**
 * 任务文件是受信任的本地 ES 模块，必须默认导出一个任务对象。
 * run(ctx) 会由守护进程提供受控的浏览器能力。
 */
export function validateTaskDefinition(definition, id) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new Error('任务模块必须默认导出一个对象');
  }
  if (typeof definition.name !== 'string' || !definition.name.trim()) {
    throw new Error('任务模块缺少有效的 name');
  }
  if (typeof definition.schedule !== 'string' || !definition.schedule.trim() || definition.schedule.length > 200) {
    throw new Error('任务模块缺少有效的 schedule');
  }
  if (typeof definition.run !== 'function') {
    throw new Error('任务模块必须导出 async run(ctx) 函数');
  }
  if (definition.description !== undefined && typeof definition.description !== 'string') {
    throw new Error('description 必须是字符串');
  }
  if (definition.enabled !== undefined && typeof definition.enabled !== 'boolean') {
    throw new Error('enabled 必须是布尔值');
  }
  if (definition.options !== undefined && (!definition.options || typeof definition.options !== 'object' || Array.isArray(definition.options))) {
    throw new Error('options 必须是对象');
  }

  return Object.freeze({
    id: validateTaskId(id),
    name: definition.name.trim(),
    description: definition.description || '',
    schedule: definition.schedule.trim(),
    enabled: definition.enabled !== false,
    options: Object.freeze({ ...(definition.options || {}) }),
    run: definition.run,
  });
}

export function buildTaskTemplate({ name = '新建浏览器任务', description = '', schedule = '0 9 * * *', enabled = true } = {}) {
  return `// BrowserPilot 任务模块：此文件由本机守护进程加载，请只保存受信任的代码。\nexport default {\n  name: ${JSON.stringify(name)},\n  description: ${JSON.stringify(description)},\n  schedule: ${JSON.stringify(schedule)},\n  enabled: ${enabled !== false},\n  options: {\n    fallbackUrl: 'about:blank',\n    timeoutPerStep: 30_000,\n  },\n\n  async run(ctx) {\n    await ctx.navigate('https://example.com');\n    await ctx.waitForLoad();\n    // await ctx.click('.primary-action');\n    // await ctx.type('#keyword', 'BrowserPilot');\n    // await ctx.wait(1_000);\n  },\n};\n`;
}
