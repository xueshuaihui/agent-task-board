import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, errorCode, errorMessage, request, type Sender, type TestApp } from '../../__tests__/helpers/http-app';
import { API, anonSender, claimOk, clearReadyQueue, issueAgent, toReady, triple, uiSender } from '../../__tests__/helpers/seed';

/**
 * 0919 技能后端深化：8.6 测试用例版本化与两形态测试运行、8.4 人工块 BLOCKED 流转、
 * 8.7 SKILL.md / Cursor Rules 导入导出（往返一致性）、8.8 技能源。
 */

const RICH_CONTENT = {
  blocks: [
    { id: 'p1', kind: 'prompt', title: '开场', prompt: '分析需求', next: [{ when: '', to: 'd1' }] },
    {
      id: 'd1',
      kind: 'decision',
      title: '是否继续',
      condition: '需求明确',
      next: [
        { when: '是', to: 'l1' },
        { when: '否', to: 'o1' },
      ],
    },
    { id: 'l1', kind: 'loop', title: '逐项检查', while: '还有未检查项', steps: ['读文件', '记结果'], next: [{ when: '', to: 'par1' }] },
    { id: 'par1', kind: 'parallel', title: '并行验证', merge: 'any', branches: ['跑单测', '跑 lint'], next: [{ when: '', to: 't1' }] },
    { id: 't1', kind: 'tool', title: '查表', server: 'fs', tool: 'read', argsTemplate: '{"path":"{{input.file}}"}', next: [{ when: '', to: 'h1' }] },
    { id: 'h1', kind: 'human', title: '人工确认', humanInstruction: '等待人工确认结论', next: [{ when: '', to: 'o1' }] },
    { id: 'o1', kind: 'output', title: '结论', name: 'result', valueType: 'string', required: false },
  ],
  entryBlockId: 'p1',
};

const SIMPLE_CONTENT = {
  blocks: [
    { id: 's1', kind: 'step', title: '步骤', steps: ['读代码', '写测试'] },
  ],
  entryBlockId: 's1',
};

async function createSkill(ui: Sender, overrides: Record<string, unknown> = {}) {
  const res = await ui.post(`${API}/skills`, {
    name: `技能-${Math.random().toString(36).slice(2, 8)}`,
    type: 'flow',
    description: '',
    tags: [],
    content: SIMPLE_CONTENT,
    test_cases: [],
    mcp_dependencies: [],
    ...overrides,
  });
  if (res.status !== 201) throw new Error(`建技能失败：${res.status} ${res.text}`);
  return res.body;
}

describe('技能深化（8.4/8.6/8.7/8.8）', () => {
  let t: TestApp;
  let ui: Sender;
  let admin: Sender;
  let scanDir: string;

  beforeAll(async () => {
    t = await createTestApp();
    ui = uiSender(t);
    const anon = anonSender(t);
    await anon.post(`${API}/auth/init`, { username: 'boss2', password: 'secret66' });
    const a = await anon.post(`${API}/auth/login`, { username: 'boss2', password: 'secret66' });
    admin = request(t, a.body.token);
    scanDir = mkdtempSync(path.join(tmpdir(), 'atb-sources-'));
  });

  afterAll(async () => {
    rmSync(scanDir, { recursive: true, force: true });
    await t.close();
  });

  // ---------------------------------------------------------------- 8.6 测试用例

  it('无用例：test 走单次运行旧形态，补 mode 字段且 blocked 形状保留', async () => {
    const skill = await createSkill(ui, {
      content: {
        blocks: [
          { id: 'a', kind: 'prompt', title: '', prompt: '做事情', next: [{ when: '', to: 'h' }] },
          { id: 'h', kind: 'human', title: '确认', humanInstruction: '等人工' },
        ],
        entryBlockId: 'a',
      },
    });
    const res = await ui.post(`${API}/skills/${skill.id}/test`, { input: '单次输入' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      mode: 'single',
      ok: false,
      blocked: { blockId: 'h', instruction: '等人工' },
    });
    expect(res.body.output).toContain('做事情');
  });

  it('有用例：test 逐用例运行，human 块视为 blocked（用例不通过）', async () => {
    const skill = await createSkill(ui, {
      content: {
        blocks: [
          { id: 'a', kind: 'prompt', title: '', prompt: '做事情', next: [{ when: '', to: 'h' }] },
          { id: 'h', kind: 'human', title: '确认', humanInstruction: '等人工' },
        ],
        entryBlockId: 'a',
      },
      test_cases: [
        { id: 'c1', name: '用例一', input: '登录流程', expected: { contains: '做事情' } },
        { id: 'c2', name: '用例二', input: { query: '对象输入' } },
      ],
    });
    const res = await ui.post(`${API}/skills/${skill.id}/test`, { input: '' });
    expect(res.body).toMatchObject({ mode: 'cases', passed: 0, total: 2 });
    expect(res.body.results.map((row: any) => row.case_id)).toEqual(['c1', 'c2']);
    for (const row of res.body.results) {
      expect(row.ok).toBe(false);
      expect(row.logs.some((log: string) => log.includes('需人工处理'))).toBe(true);
    }
  });

  it('有用例且全部可跑完：passed/total 正确，对象输入按 JSON 字符串化', async () => {
    const skill = await createSkill(ui, {
      content: {
        blocks: [
          { id: 'p1', kind: 'prompt', title: '开场', prompt: '分析需求', next: [{ when: '', to: 'l1' }] },
          { id: 'l1', kind: 'loop', title: '逐项检查', while: '还有未检查项', steps: ['读文件'] },
        ],
        entryBlockId: 'p1',
      },
      test_cases: [
        { id: 'ok1', name: '正常输入', input: '直接跑', expected: '分析需求' },
        { id: 'ok2', name: '对象输入', input: { file: 'a.ts' } },
      ],
    });
    const res = await ui.post(`${API}/skills/${skill.id}/test`, { input: '' });
    expect(res.body).toMatchObject({ mode: 'cases', passed: 2, total: 2 });
    expect(res.body.results[0].output).toContain('分析需求');
    expect(res.body.results[1].logs).toContain('输入: {"file":"a.ts"}');
  });

  it('PATCH 支持 test_cases；发布版本随版本快照；回滚恢复用例', async () => {
    const skill = await createSkill(ui, {
      test_cases: [{ id: 'v1', name: '初始用例', input: 'x' }],
    });
    const patched = await ui.patch(`${API}/skills/${skill.id}`, {
      test_cases: [{ id: 'v2', name: '改后用例', input: 'y' }],
    });
    expect(patched.body.test_cases).toEqual([{ id: 'v2', name: '改后用例', input: 'y' }]);

    // 发布不带 test_cases：快照沿用当前草稿
    const next = await ui.post(`${API}/skills/${skill.id}/versions`, { content: SIMPLE_CONTENT });
    expect(next.body.current_version).toBe('v0.1.1');
    expect(next.body.test_cases[0].id).toBe('v2');
    const versionRow = await t.prisma.skillVersion.findUnique({
      where: { skillId_version: { skillId: skill.id, version: 'v0.1.1' } },
    });
    expect(JSON.parse(versionRow!.testCases)[0].id).toBe('v2');

    // 发布显式带 test_cases：覆盖
    const again = await ui.post(`${API}/skills/${skill.id}/versions`, {
      content: SIMPLE_CONTENT,
      test_cases: [{ id: 'v3', name: '显式用例' }],
    });
    expect(again.body.test_cases[0].id).toBe('v3');

    // 回滚到 v0.1.1：用例一并恢复
    const rolled = await ui.post(`${API}/skills/${skill.id}/rollback`, { version: 'v0.1.1' });
    expect(rolled.body.test_cases[0].id).toBe('v2');
  });

  it('创建时带 test_cases 落库，导出 .atskill 携带、导入带回', async () => {
    const skill = await createSkill(ui, {
      name: '用例导出技能',
      test_cases: [{ id: 'e1', name: '导出用例', input: 'in', expected: 'exp' }],
    });
    const res = await ui.send(`${API}/skills/${skill.id}/export`);
    const payload = JSON.parse(res.text);
    expect(payload.test_cases).toHaveLength(1);
    expect(payload.test_cases[0]).toMatchObject({ id: 'e1' });

    const form = new FormData();
    form.append('file', new Blob([JSON.stringify(payload)], { type: 'application/json' }), 'x.atskill');
    const imported = await ui.send(`${API}/skills/import`, { method: 'POST', raw: form });
    expect(imported.status).toBe(201);
    expect(imported.body.test_cases[0]).toMatchObject({ id: 'e1', name: '导出用例' });
  });

  // ---------------------------------------------------------------- 8.4 人工块 BLOCKED

  it('Agent 上报人工块：任务转 BLOCKED，Run 收口 FAILED，记 run 日志与审计', async () => {
    const taskId = await (async () => {
      const res = await ui.post(`${API}/tasks`, {
        title: '人工块任务',
        type: '需求',
        priority: 3,
        required_capabilities: [],
        custom_fields: {},
        depends_on: [],
        tags: [],
        pinned: false,
      });
      return res.body.id as string;
    })();
    await clearReadyQueue(t);
    await ui.patch(`${API}/tasks/${taskId}`, { required_capabilities: [`tool:${taskId}`] });
    await toReady(t, taskId);
    const agent = await issueAgent(t, `blocked-bot-${taskId.replace(/[^a-z0-9-]/gi, '').toLowerCase()}`, [
      `tool:${taskId}`,
    ]);
    const claimed = await claimOk(agent, taskId);

    const res = await agent.claims.post(`${API}/tasks/${taskId}/blocked`, {
      ...triple(claimed),
      block_id: 'h1',
      block_title: '人工确认',
      instruction: '请确认上线窗口',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ task_status: 'BLOCKED', idempotent: false });

    const detail = await ui.get(`${API}/tasks/${taskId}`);
    expect(detail.body.status).toBe('BLOCKED');
    expect(detail.body.status_label).toBe('人工阻塞');
    // 租约已清空
    expect(detail.body.lease_id ?? null).toBeNull();

    const run = await t.prisma.taskRun.findUnique({ where: { id: claimed.run_id } });
    expect(run?.status).toBe('FAILED');
    expect(run?.error).toContain('人工确认');

    const comments = await ui.get(`${API}/tasks/${taskId}/comments?type=status_change,log`);
    const contents = comments.body.items.map((row: any) => row.content).join('\n');
    expect(contents).toContain('人工块「人工确认」');
    expect(contents).toContain('请确认上线窗口');

    const audits = await t.prisma.auditLog.findMany({
      where: { targetId: claimed.run_id, action: 'run_writeback' },
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(audits[0]!.after!)).toMatchObject({ task_status: 'BLOCKED', blocked_by: 'h1' });
  });

  it('BLOCKED 可 transition 回 READY / BACKLOG；RUNNING→BLOCKED 不开放给 transition 端点', async () => {
    const { taskIn } = await import('../../__tests__/helpers/seed');
    const fixture = await taskIn(t, 'BLOCKED', '回流转夹具');
    const toReadyRes = await ui.post(`${API}/tasks/${fixture.id}/transition`, { to: 'READY' });
    expect(toReadyRes.status).toBe(201);
    expect(toReadyRes.body.status).toBe('READY');

    const fixture2 = await taskIn(t, 'BLOCKED', '回需求池夹具');
    const toBacklog = await ui.post(`${API}/tasks/${fixture2.id}/transition`, { to: 'BACKLOG' });
    expect(toBacklog.status).toBe(201);
    expect(toBacklog.body.status).toBe('BACKLOG');

    const running = await taskIn(t, 'RUNNING', '执行中不可手转阻塞');
    const illegal = await ui.post(`${API}/tasks/${running.id}/transition`, { to: 'BLOCKED' });
    expect(illegal.status).toBe(409);
    expect(errorCode(illegal)).toBe('ILLEGAL_TRANSITION');
  });

  it('人工块上报的租约校验：三元组不符 410，旧三元组重试也 410（租约已清空）', async () => {
    const { taskIn } = await import('../../__tests__/helpers/seed');
    const fixture = await taskIn(t, 'RUNNING', '租约校验夹具');
    const wrong = await fixture.agent.claims.post(`${API}/tasks/${fixture.id}/blocked`, {
      ...fixture.key!,
      lease_id: '00000000-0000-4000-8000-000000000000',
      block_id: 'h',
      instruction: 'x',
    });
    expect(wrong.status).toBe(410);

    const blocked = await fixture.agent.claims.post(`${API}/tasks/${fixture.id}/blocked`, {
      ...fixture.key!,
      block_id: 'h',
      block_title: '',
      instruction: '第一次上报',
    });
    expect(blocked.status).toBe(200);
    // 租约已随 BLOCKED 清空：同一三元组重试 410
    const retry = await fixture.agent.claims.post(`${API}/tasks/${fixture.id}/blocked`, {
      ...fixture.key!,
      block_id: 'h',
      instruction: '第一次上报',
    });
    expect(retry.status).toBe(410);
  });

  it('blocked 入参校验：缺 instruction / 空 block_id → 422', async () => {
    const { taskIn } = await import('../../__tests__/helpers/seed');
    const fixture = await taskIn(t, 'RUNNING', '入参校验夹具');
    const missing = await fixture.agent.claims.post(`${API}/tasks/${fixture.id}/blocked`, {
      ...fixture.key!,
      block_id: '',
      instruction: 'x',
    });
    expect(missing.status).toBe(422);
    const noInstruction = await fixture.agent.claims.post(`${API}/tasks/${fixture.id}/blocked`, {
      ...fixture.key!,
      block_id: 'h',
    });
    expect(noInstruction.status).toBe(422);
    await fixture.agent.claims.post(`${API}/tasks/${fixture.id}/fail`, {
      ...fixture.key!,
      error: '夹具收尾',
    });
  });

  // ---------------------------------------------------------------- 8.7 SKILL.md 导入导出

  it('SKILL.md 导入：frontmatter + 正文块 → v0.1.0 DRAFT，重名加后缀', async () => {
    const markdown = [
      '---',
      'name: 代码评审技能',
      'description: 逐项评审代码改动',
      'version: 2.0.0',
      'category: 研发',
      'tags: [评审, 研发]',
      '---',
      '',
      '入口块：开场',
      '',
      '### 开场',
      '',
      '<!-- atb:prompt -->',
      '',
      '请阅读改动',
      '',
      '### 步骤',
      '',
      '<!-- atb:step -->',
      '',
      '1. 读 diff',
      '2. 写意见',
    ].join('\n');
    const send = () =>
      ui.post(`${API}/skills/import-markdown`, { filename: 'SKILL.md', content: markdown });
    const first = await send();
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      name: '代码评审技能',
      status: 'DRAFT',
      current_version: 'v0.1.0',
      description: '逐项评审代码改动',
      type: 'flow',
    });
    expect(first.body.tags).toEqual(expect.arrayContaining(['评审', '研发']));
    expect(first.body.content.blocks).toHaveLength(2);
    expect(first.body.content.blocks[0]).toMatchObject({ kind: 'prompt', title: '开场', prompt: '请阅读改动' });
    expect(first.body.content.blocks[1]).toMatchObject({ kind: 'step', title: '步骤', steps: ['读 diff', '写意见'] });
    expect(first.body.content.entryBlockId).toBe(first.body.content.blocks[0].id);
    const second = await send();
    expect(second.status).toBe(201);
    expect(second.body.name).not.toBe('代码评审技能');
    expect(second.body.name.startsWith('代码评审技能')).toBe(true);
  });

  it('step 小节写成段落：整段正文兜底为一条步骤，不静默丢内容', async () => {
    const markdown = [
      '---',
      'name: 段落步骤技能',
      'description: 手写文档里 step 常见段落体',
      'version: 0.1.0',
      'category: 研发',
      'tags: [导入]',
      '---',
      '',
      '### 结论',
      '',
      '<!-- atb:step -->',
      '',
      '先汇总要点，再给出建议。',
    ].join('\n');
    const res = await ui.post(`${API}/skills/import-markdown`, { filename: 'SKILL.md', content: markdown });
    expect(res.status).toBe(201);
    const step = res.body.content.blocks.find((block: any) => block.kind === 'step');
    expect(step.steps).toEqual(['先汇总要点，再给出建议。']);
  });

  it('条件块终态分支 to 为空串合法；模拟运行按「终态」收口而不是报目标不存在', async () => {
    const content = {
      blocks: [
        {
          id: 'd1',
          kind: 'decision',
          title: '是否通过',
          condition: '结论非空',
          next: [
            { when: '是', to: '' },
            { when: '否', to: 'd1' },
          ],
        },
      ],
      entryBlockId: 'd1',
    };
    const created = await ui.post(`${API}/skills`, {
      name: `终态分支技能-${Math.random().toString(36).slice(2, 8)}`,
      type: 'flow',
      description: '',
      tags: [],
      content,
    });
    expect(created.status).toBe(201);
    const test = await ui.post(`${API}/skills/${created.body.id}/test`, { input: '跑一次' });
    expect(test.status).toBe(201);
    expect(test.body.logs.join('\n')).toContain('该分支为终态（无跳转），测试结束');
  });

  it('.mdc（Cursor Rules）导入：frontmatter 元数据头剥离，description 进描述', async () => {
    const mdc = [
      '---',
      'description: 检查提交信息规范',
      'globs: always_apply',
      'alwaysApply: true',
      '---',
      '',
      '# 提交规范',
      '',
      '### 检查提交信息',
      '',
      '<!-- atb:constraint -->',
      '',
      '规则：提交信息必须用祈使句',
    ].join('\n');
    const res = await ui.post(`${API}/skills/import-markdown`, { filename: 'commit.mdc', content: mdc });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('commit');
    expect(res.body.description).toBe('检查提交信息规范');
    expect(res.body.content.blocks[0]).toMatchObject({ kind: 'constraint', rule: '提交信息必须用祈使句' });
    // globs/alwaysApply 等 Cursor 专有键不进 tags / 描述
    expect(res.body.tags).toEqual([]);
  });

  it('无 ### 小节的正文整体作一个提示词块', async () => {
    const res = await ui.post(`${API}/skills/import-markdown`, {
      filename: 'plain.md',
      content: '这就是一段普通说明，没有小节标题。\n第二行也一样。',
    });
    expect(res.status).toBe(201);
    expect(res.body.content.blocks).toHaveLength(1);
    expect(res.body.content.blocks[0]).toMatchObject({
      kind: 'prompt',
      title: 'plain',
      prompt: '这就是一段普通说明，没有小节标题。\n第二行也一样。',
    });
    expect(res.body.content.entryBlockId).toBe(res.body.content.blocks[0].id);
  });

  it('导出 SKILL.md：text/markdown 附件 + frontmatter + atb 标记', async () => {
    const skill = await createSkill(ui, {
      name: 'export-ok',
      description: '导出用描述',
      content: RICH_CONTENT,
    });
    const res = await ui.send(`${API}/skills/${skill.id}/export-markdown`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('export-ok.md');
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(res.text).toContain('name: export-ok');
    expect(res.text).toContain('description: 导出用描述');
    expect(res.text).toContain('<!-- atb:decision -->');
    expect(res.text).toContain('<!-- atb:human -->');
    expect(res.text).toContain('入口块：开场');
  });

  it('往返一致性：blocks → markdown → blocks 逐块相等（decision/loop/parallel/tool/human 等）', async () => {
    const skill = await createSkill(ui, { name: 'round-trip', content: RICH_CONTENT });
    const exported = await ui.send(`${API}/skills/${skill.id}/export-markdown`);
    const imported = await ui.post(`${API}/skills/import-markdown`, {
      filename: 'round-trip.md',
      content: exported.text,
    });
    expect(imported.status).toBe(201);
    const before = (skill.content.blocks as any[]);
    const after = imported.body.content.blocks as any[];
    expect(after).toHaveLength(before.length);
    const idMap = new Map(before.map((block, index) => [block.id, after[index].id]));
    for (let index = 0; index < before.length; index += 1) {
      const source = before[index];
      const target = after[index];
      expect(target.id).toBe(idMap.get(source.id));
      const normalized: any = { ...target };
      const expected: any = { ...source };
      if (source.kind === 'decision') {
        // 条件块的分支按「- 当 … → 跳转：块标题」编码，导入按标题回解出新 id。
        normalized.next = normalized.next.map((next: any) => ({
          ...next,
          to: idMap.get(next.to) ?? (next.to === '' ? '' : next.to),
        }));
        expected.next = expected.next.map((next: any) => ({ ...next, to: idMap.get(next.to) ?? next.to }));
      } else {
        // 转换约定（与前端一致）：非条件块的 next 边不进 markdown（入口由「入口块：」行承担），
        // 这是记录在案的损失点，往返比较时跳过。
        delete normalized.next;
        delete expected.next;
      }
      for (const key of Object.keys(expected)) {
        if (expected[key] === undefined) delete expected[key];
      }
      delete normalized.id;
      delete expected.id;
      expect(normalized).toEqual(expected);
    }
    expect(imported.body.content.entryBlockId).toBe(idMap.get('p1'));
  });

  // ---------------------------------------------------------------- 8.8 技能源

  it('GET /skills/sources：无 builtin 条目时动态补一条（不落库）', async () => {
    const res = await ui.get(`${API}/skills/sources`);
    expect(res.status).toBe(200);
    const builtin = res.body.items.find((row: any) => row.type === 'builtin');
    expect(builtin).toMatchObject({ id: 'builtin', name: '内置技能', enabled: true });
    expect(builtin.unavailable).toBeUndefined();
  });

  it('PUT /skills/sources 存取；git/http 服务端类型响应标 unavailable:true', async () => {
    const res = await ui.send(`${API}/skills/sources`, {
      method: 'PUT',
      body: [
        { id: 'builtin', type: 'builtin', name: '内置技能', path: '', enabled: true },
        { id: 'repo', type: 'directory', name: '团队技能库', path: '/tmp/atb-skills', enabled: true },
        { id: 'gh', type: 'git', name: 'GitHub 技能源', path: 'https://github.com/x/y', enabled: false },
        { id: 'web', type: 'http', name: 'HTTP 源', path: 'https://example.com/skills', enabled: true },
      ],
    });
    expect(res.status).toBe(200);
    const again = await ui.get(`${API}/skills/sources`);
    const byId = Object.fromEntries(again.body.items.map((row: any) => [row.id, row]));
    expect(byId.repo).toMatchObject({ type: 'directory', path: '/tmp/atb-skills' });
    expect(byId.gh.unavailable).toBe(true);
    expect(byId.web.unavailable).toBe(true);
    expect(byId.builtin.unavailable).toBeUndefined();

    const bad = await ui.send(`${API}/skills/sources`, {
      method: 'PUT',
      body: [{ id: 'x', type: 'ftp', name: 'x', path: '', enabled: true }],
    });
    expect(bad.status).toBe(422);
  });

  it('POST /skills/sources/scan：directory 源扫描 atskill/md/mdc 并猜名', async () => {
    writeFileSync(path.join(scanDir, 'a.atskill'), JSON.stringify({ name: '扫描技能A' }));
    writeFileSync(path.join(scanDir, 'b.md'), '---\nname: 扫描文档B\ndescription: x\n---\n正文');
    writeFileSync(path.join(scanDir, 'c.mdc'), '---\ndescription: cursor 规则\n---\n规则正文');
    writeFileSync(path.join(scanDir, 'd.txt'), '忽略我');
    await ui.send(`${API}/skills/sources`, {
      method: 'PUT',
      body: [{ id: 'scan1', type: 'directory', name: '扫描源', path: scanDir, enabled: true }],
    });
    const res = await ui.post(`${API}/skills/sources/scan`, { source_id: 'scan1' });
    expect(res.status).toBe(201);
    expect(res.body.items).toEqual([
      { file: 'a.atskill', name_guess: '扫描技能A', kind: 'atskill' },
      { file: 'b.md', name_guess: '扫描文档B', kind: 'markdown' },
      { file: 'c.mdc', name_guess: 'c', kind: 'cursor-rule' },
    ]);
    // builtin 源扫描：不报错、空列表
    const builtin = await ui.post(`${API}/skills/sources/scan`, { source_id: 'builtin' });
    expect(builtin.status).toBe(201);
    expect(builtin.body.items).toEqual([]);
    // 未知源：404
    const missing = await ui.post(`${API}/skills/sources/scan`, { source_id: 'nope' });
    expect(missing.status).toBe(404);
  });

  it('scan 防穿越：相对路径 422、含 .. 的路径 422、不存在的目录 422；git 源 501 文案固定', async () => {
    const put = async (source: Record<string, unknown>) =>
      ui.send(`${API}/skills/sources`, { method: 'PUT', body: [source] });
    await put({ id: 'rel', type: 'directory', name: '相对', path: 'relative/dir', enabled: true });
    const rel = await ui.post(`${API}/skills/sources/scan`, { source_id: 'rel' });
    expect(rel.status).toBe(422);
    expect(rel.body.error.details[0].code).toBe('invalid_path');

    await put({ id: 'trav', type: 'directory', name: '穿越', path: '/tmp/../etc/../tmp/atb', enabled: true });
    const trav = await ui.post(`${API}/skills/sources/scan`, { source_id: 'trav' });
    expect(trav.status).toBe(422);
    expect(trav.body.error.details[0].code).toBe('path_traversal');

    await put({ id: 'gone', type: 'directory', name: '不存在', path: '/tmp/atb-definitely-missing', enabled: true });
    const gone = await ui.post(`${API}/skills/sources/scan`, { source_id: 'gone' });
    expect(gone.status).toBe(422);
    expect(gone.body.error.details[0].code).toBe('not_a_directory');

    // PUT 是整表覆盖：重新放一条 git 源再验证 501。
    await put({ id: 'gh', type: 'git', name: 'GitHub 技能源', path: 'https://github.com/x/y', enabled: true });
    const git = await ui.post(`${API}/skills/sources/scan`, { source_id: 'gh' });
    expect(git.status).toBe(501);
    expect(errorCode(git)).toBe('NOT_IMPLEMENTED');
    expect(errorMessage(git)).toBe('第三方远程源暂未开放');
  });

  it('账号隔离：sources 与导入按请求账号隔离（member 建的不串号）', async () => {
    // sources kv 是全局键（本地单租户桌面场景），此处验证技能导入归属正确账号
    const res = await ui.post(`${API}/skills/import-markdown`, {
      filename: 'owner.md',
      content: '### 块\n\n<!-- atb:prompt -->\n\n归属校验',
    });
    expect(res.status).toBe(201);
    // admin（另一个账号）看不到
    const list = await admin.get(`${API}/skills`);
    expect(list.body.items.some((row: any) => row.id === res.body.id)).toBe(false);
  });
});
