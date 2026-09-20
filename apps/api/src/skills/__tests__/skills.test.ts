import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, request, type Sender, type TestApp } from '../../__tests__/helpers/http-app';
import { API, uiSender } from '../../__tests__/helpers/seed';

/**
 * 0919 技能管理（1.md 第八章 + 10.3 随任务下发）：CRUD / 版本 / 回滚 / 测试运行 /
 * 导入导出 / 任务绑定校验 / Agent 下发。
 */

const CONTENT = {
  blocks: [
    { id: 'b1', kind: 'prompt', title: '开场', prompt: '分析需求', next: [{ when: '', to: 'b2' }] },
    { id: 'b2', kind: 'step', title: '步骤', steps: ['读代码', '写测试'], next: [{ when: '', to: 'b3' }] },
    { id: 'b3', kind: 'human', title: '确认', humanInstruction: '等待人工确认', next: [{ when: '', to: 'b4' }] },
    { id: 'b4', kind: 'script', title: '脚本', script: 'echo hi' },
  ],
  entryBlockId: 'b1',
};

function skillContent(withHuman = true) {
  if (withHuman) return CONTENT;
  return {
    blocks: [
      CONTENT.blocks[0],
      { ...CONTENT.blocks[1], next: [{ when: '', to: 'b4' }] },
      CONTENT.blocks[3]!,
    ],
    entryBlockId: 'b1',
  };
}

async function createSkill(ui: Sender, overrides: Record<string, unknown> = {}) {
  const res = await ui.post(`${API}/skills`, {
    name: `技能-${Math.random().toString(36).slice(2, 8)}`,
    type: 'flow',
    description: '集成测试技能',
    tags: ['测试'],
    content: skillContent(),
    mcp_dependencies: [{ server: 'fs', tools: ['read'], required: true, reason: '读文件' }],
    ...overrides,
  });
  if (res.status !== 201) throw new Error(`建技能失败：${res.status} ${res.text}`);
  return res.body;
}

describe('技能管理', () => {
  let t: TestApp;
  let ui: Sender;
  let admin: Sender;

  beforeAll(async () => {
    t = await createTestApp();
    ui = uiSender(t);
    // W1a：账号体系移除后本地只有一份 UI 会话凭证，admin 就是 ui。
    admin = ui;
  });

  afterAll(async () => {
    await t.close();
  });

  it('创建即 v0.1.0 DRAFT，versions 里同步落一条', async () => {
    const skill = await createSkill(ui);
    expect(skill).toMatchObject({ type: 'flow', status: 'DRAFT', current_version: 'v0.1.0' });
    expect(skill.content.blocks).toHaveLength(4);
    expect(skill.mcp_dependencies[0]).toMatchObject({ server: 'fs', required: true });
    const detail = await ui.get(`${API}/skills/${skill.id}`);
    expect(detail.body.versions).toHaveLength(1);
    expect(detail.body.versions[0]).toMatchObject({ version: 'v0.1.0', current: true });
  });

  it('块内容无损往返：text 等业务字段在详情与 versions 中逐字保留', async () => {
    const text = '这是逐字保留的正文内容';
    const created = await createSkill(ui, {
      content: {
        blocks: [
          { id: 't1', kind: 'prompt', title: '正文块', text, next: [{ when: '完成', to: 't2' }] },
          { id: 't2', kind: 'knowledge', title: '知识块', text: '知识点' },
        ],
        entryBlockId: 't1',
      },
    });
    expect(created.content.blocks[0]).toMatchObject({ id: 't1', text, title: '正文块' });
    expect(created.content.blocks[0].next).toEqual([{ when: '完成', to: 't2' }]);

    const detail = await ui.get(`${API}/skills/${created.id}`);
    expect(detail.body.content.blocks[0]).toEqual(created.content.blocks[0]);
    expect(detail.body.content.blocks[1].text).toBe('知识点');

    // 版本发布同样无损
    await ui.post(`${API}/skills/${created.id}/versions`, {
      content: created.content,
      changelog: '保留 text 的版本',
    });
    const after = await ui.get(`${API}/skills/${created.id}`);
    expect(after.body.content.blocks[0].text).toBe(text);
    expect(after.body.versions[0]).toMatchObject({ version: 'v0.1.1', current: true });
  });

  it('列表：keyword/type/status/tag 过滤', async () => {
    const a = await createSkill(ui, { name: '独特关键词技能', type: 'prompt', tags: ['专属标签'] });
    await createSkill(ui, { type: 'script' });
    const byKeyword = await ui.get(`${API}/skills?keyword=独特关键词`);
    expect(byKeyword.body.items.some((row: any) => row.id === a.id)).toBe(true);
    expect(byKeyword.body.total).toBe(1);
    const byType = await ui.get(`${API}/skills?type=prompt`);
    expect(byType.body.items.every((row: any) => row.type === 'prompt')).toBe(true);
    expect(byType.body.items.some((row: any) => row.id === a.id)).toBe(true);
    const byTag = await ui.get(`${API}/skills?tag=专属标签`);
    expect(byTag.body.items.map((row: any) => row.id)).toContain(a.id);
    const all = await ui.get(`${API}/skills`);
    expect(all.body.total).toBeGreaterThanOrEqual(2);
  });

  it('PATCH：基础字段 + content 只写当前草稿，不动 versions', async () => {
    const skill = await createSkill(ui);
    const patched = await ui.patch(`${API}/skills/${skill.id}`, {
      description: '新描述',
      tags: ['新标签'],
      status: 'PUBLISHED',
      content: skillContent(false),
    });
    expect(patched.body).toMatchObject({ description: '新描述', status: 'PUBLISHED' });
    expect(patched.body.content.blocks).toHaveLength(3);
    // 版本记录里的 v0.1.0 内容仍是创建时的 4 块
    const detail = await ui.get(`${API}/skills/${skill.id}`);
    expect(detail.body.versions).toHaveLength(1);
  });

  it('发布新版本：patch 自增 + changelog + MCP 依赖随版本', async () => {
    const skill = await createSkill(ui);
    const next = await ui.post(`${API}/skills/${skill.id}/versions`, {
      content: skillContent(false),
      changelog: '去掉人工确认块',
      mcp_dependencies: [{ server: 'git', tools: [], required: false }],
    });
    expect(next.body.current_version).toBe('v0.1.1');
    expect(next.body.versions.map((row: any) => row.version)).toEqual(['v0.1.1', 'v0.1.0']);
    expect(next.body.versions[0]).toMatchObject({ changelog: '去掉人工确认块', current: true });
    expect(next.body.mcp_dependencies[0]).toMatchObject({ server: 'git' });
    // 空内容/缺 changelog 也可以（changelog 缺省为空串）
    const again = await ui.post(`${API}/skills/${skill.id}/versions`, {
      content: skillContent(false),
    });
    expect(again.body.current_version).toBe('v0.1.2');
  });

  it('回滚：内容与依赖复制为 current，不新增版本记录', async () => {
    const skill = await createSkill(ui);
    await ui.post(`${API}/skills/${skill.id}/versions`, {
      content: skillContent(false),
      changelog: 'v2',
      mcp_dependencies: [],
    });
    const rolled = await ui.post(`${API}/skills/${skill.id}/rollback`, { version: 'v0.1.0' });
    expect(rolled.body.current_version).toBe('v0.1.0');
    expect(rolled.body.content.blocks).toHaveLength(4);
    expect(rolled.body.mcp_dependencies[0]).toMatchObject({ server: 'fs' });
    expect(rolled.body.versions).toHaveLength(2);
    const missing = await ui.post(`${API}/skills/${skill.id}/rollback`, { version: 'v9.9.9' });
    expect(missing.status).toBe(404);
  });

  it('测试运行：文本块拼接、human 中断标记、script 不执行', async () => {
    const skill = await createSkill(ui);
    const blocked = await ui.post(`${API}/skills/${skill.id}/test`, { input: '登录流程' });
    expect(blocked.body.ok).toBe(false);
    expect(blocked.body.blocked).toMatchObject({ blockId: 'b3', instruction: '等待人工确认' });
    expect(blocked.body.logs.some((log: string) => log.includes('需人工处理'))).toBe(true);

    const noHuman = await createSkill(ui, { name: '无人工块技能' });
    await ui.patch(`${API}/skills/${noHuman.id}`, { content: skillContent(false) });
    const ok = await ui.post(`${API}/skills/${noHuman.id}/test`, { input: '' });
    expect(ok.body.ok).toBe(true);
    expect(ok.body.blocked).toBeUndefined();
    expect(ok.body.output).toContain('分析需求');
    expect(ok.body.output).toContain('读代码');
    expect(ok.body.logs.some((log: string) => log.includes('本地不执行脚本（桌面端测试环境）'))).toBe(true);
  });

  it('导出：附件头 + .atskill 载荷字段齐全', async () => {
    const skill = await createSkill(ui, { name: 'export-ok' });
    const res = await ui.send(`${API}/skills/${skill.id}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('export-ok.atskill');
    const payload = JSON.parse(res.text);
    expect(payload).toMatchObject({
      name: 'export-ok',
      type: 'flow',
      version: 'v0.1.0',
      description: '集成测试技能',
    });
    expect(payload.content.blocks).toHaveLength(4);
    expect(payload.mcp_dependencies[0].server).toBe('fs');
    expect(typeof payload.exported_at).toBe('string');
  });

  it('导入：multipart 建 v0.1.0 DRAFT，重名加后缀', async () => {
    const payload = {
      name: '导入技能',
      type: 'steps',
      description: '来自文件',
      tags: ['导入'],
      content: { blocks: [{ id: 'x', kind: 'prompt', title: '', prompt: 'hi' }], entryBlockId: 'x' },
      version: 'v3.2.1',
      mcp_dependencies: [{ server: 'web', tools: [], required: true }],
      exported_at: new Date().toISOString(),
    };
    const sendImport = async () => {
      const form = new FormData();
      form.append('file', new Blob([JSON.stringify(payload)], { type: 'application/json' }), 'x.atskill');
      return ui.send(`${API}/skills/import`, { method: 'POST', raw: form });
    };
    const first = await sendImport();
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ name: '导入技能', status: 'DRAFT', current_version: 'v0.1.0' });
    expect(first.body.mcp_dependencies[0].server).toBe('web');
    // 重名：不冲突，加后缀
    const second = await sendImport();
    expect(second.status).toBe(201);
    expect(second.body.name).not.toBe('导入技能');
    expect(second.body.name.startsWith('导入技能')).toBe(true);
    // 缺 file：422
    const none = await ui.send(`${API}/skills/import`, { method: 'POST' });
    expect(none.status).toBe(422);
  });

  it('任务绑定：PATCH tasks/:id 写入引用，详情带回，绑定列表与统计正确', async () => {
    const skill = await createSkill(admin);
    const taskRes = await admin.post(`${API}/tasks`, {
      title: '绑定技能的任务',
      type: '需求',
      priority: 3,
      required_capabilities: [],
      custom_fields: {},
      depends_on: [],
      tags: [],
      pinned: false,
    });
    const taskId = taskRes.body.id as string;
    const patched = await admin.patch(`${API}/tasks/${taskId}`, {
      skills: [{ skill_id: skill.id }],
    });
    expect(patched.status).toBe(200);
    expect(patched.body.skills[0]).toMatchObject({ skill_id: skill.id, version: 'v0.1.0' });
    // 版本引用显式化
    await admin.post(`${API}/skills/${skill.id}/versions`, { content: skillContent(false) });
    const rebound = await admin.patch(`${API}/tasks/${taskId}`, {
      skills: [{ skill_id: skill.id, version: 'v0.1.0' }],
    });
    expect(rebound.body.skills[0].version).toBe('v0.1.0');

    const detail = await admin.get(`${API}/tasks/${taskId}`);
    expect(detail.body.skills[0].skill_id).toBe(skill.id);

    const bound = await admin.get(`${API}/skills/${skill.id}/tasks`);
    expect(bound.body.total).toBe(1);
    expect(bound.body.items[0]).toMatchObject({ id: taskId, title: '绑定技能的任务' });

    const stats = await admin.get(`${API}/skills/${skill.id}`);
    expect(stats.body.stats.bound_task_count).toBe(1);
  });

  it('绑定校验：未知技能 / 未知版本 422', async () => {
    const taskRes = await admin.post(`${API}/tasks`, {
      title: '校验用任务',
      type: '需求',
      priority: 3,
      required_capabilities: [],
      custom_fields: {},
      depends_on: [],
      tags: [],
      pinned: false,
    });
    const taskId = taskRes.body.id as string;
    const unknown = await admin.patch(`${API}/tasks/${taskId}`, {
      skills: [{ skill_id: 'skl_not_exist' }],
    });
    expect(unknown.status).toBe(422);
    const skill = await createSkill(admin);
    const badVersion = await admin.patch(`${API}/tasks/${taskId}`, {
      skills: [{ skill_id: skill.id, version: 'v7.7.7' }],
    });
    expect(badVersion.status).toBe(422);
    const ok = await admin.patch(`${API}/tasks/${taskId}`, { skills: [] });
    expect(ok.status).toBe(200);
    expect(ok.body.skills).toEqual([]);
  });

  it('删除：有绑定时 409，解绑后可删', async () => {
    const skill = await createSkill(admin);
    const taskRes = await admin.post(`${API}/tasks`, {
      title: '删除拦截任务',
      type: '需求',
      priority: 3,
      required_capabilities: [],
      custom_fields: {},
      depends_on: [],
      tags: [],
      pinned: false,
    });
    const taskId = taskRes.body.id as string;
    await admin.patch(`${API}/tasks/${taskId}`, { skills: [{ skill_id: skill.id }] });
    const blocked = await admin.del(`${API}/skills/${skill.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('SKILL_BOUND');
    await admin.patch(`${API}/tasks/${taskId}`, { skills: [] });
    const gone = await admin.del(`${API}/skills/${skill.id}`);
    expect(gone.status).toBe(200);
    expect((await admin.get(`${API}/skills/${skill.id}`)).status).toBe(404);
  });

  it('Agent 下发：ready 与 claim 的任务都带 skills 载荷（内容/版本/MCP 依赖）', async () => {
    const skill = await createSkill(admin);
    await admin.post(`${API}/skills/${skill.id}/versions`, {
      content: skillContent(false),
      changelog: 'agent 版',
      mcp_dependencies: [{ server: 'git', tools: ['commit'], required: true }],
    });
    const taskRes = await admin.post(`${API}/tasks`, {
      title: '带技能的任务',
      type: '需求',
      priority: 3,
      required_capabilities: [],
      custom_fields: {},
      depends_on: [],
      tags: [],
      pinned: false,
    });
    const taskId = taskRes.body.id as string;
    await admin.patch(`${API}/tasks/${taskId}`, {
      skills: [{ skill_id: skill.id, version: 'v0.1.1' }],
    });
    await admin.post(`${API}/tasks/${taskId}/transition`, { to: 'READY' });

    const { token } = await (await admin.post(`${API}/tokens`, { name: 'skill-bot', capabilities: [] })).body;
    const agent = request(t, token);
    const ready = await agent.get(`${API}/tasks/ready`);
    const readyTask = ready.body.items.find((row: any) => row.id === taskId);
    expect(readyTask).toBeDefined();
    expect(readyTask.skills[0]).toMatchObject({
      skill_id: skill.id,
      version: 'v0.1.1',
      name: skill.name,
    });
    expect(readyTask.skills[0].content.blocks).toHaveLength(3);
    expect(readyTask.skills[0].mcp_dependencies[0]).toMatchObject({ server: 'git', tools: ['commit'] });

    const claim = await agent.post(`${API}/tasks/claim`, { capabilities: [] });
    expect(claim.body.task.id).toBe(taskId);
    expect(claim.body.task.skills[0]).toMatchObject({ skill_id: skill.id, version: 'v0.1.1' });
    expect(claim.body.task.skills[0].content.blocks).toHaveLength(3);
  });

  it('重名：创建返回 409（uniq_skills_name 单列唯一保留，去唯一是 W2）', async () => {
    const skill = await createSkill(admin);
    const dup = await admin.post(`${API}/skills`, {
      name: skill.name,
      type: 'prompt',
      description: '',
      tags: [],
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('SKILL_NAME_TAKEN');
  });

  it('Agent Token 不能调用技能接口（UI 凭证组跨组拒绝）', async () => {
    const { token } = await (await admin.post(`${API}/tokens`, { name: 'no-skill-bot', capabilities: [] })).body;
    const agent = request(t, token);
    const res = await agent.get(`${API}/skills`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});
