import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import {
  CLIENT_ENTRY_MARKER_BEGIN,
  CLIENT_ENTRY_MARKER_END,
  CLIENT_ENTRY_CLIENTS,
  CLIENT_IDS,
} from '../contract/client-entry';
import {
  createTestApp,
  errorCode,
  mcpAccept,
  request,
  type Res,
  type TestApp,
} from './helpers/http-app';
import {
  API,
  issueAgent,
  uiSender,
  type IssuedAgent,
} from './helpers/seed';
import {
  ClientEntryRepository,
  type ClientEntryRecord,
} from '../client-entry/client-entry.repository';

/**
 * 设置 → 客户端入口的 API 端到端：真 HTTP + 临时 SQLite + 临时 workspace + 临时 client home。
 *
 * 这组用例刻意共用一套文件现场并按业务顺序推进（预览 → 安装 → 幂等 → 校验 → 漂移/卸载）：
 * 每一步都是下一个断言的前置，拆开就只能证明「某个请求回了 2xx」。冲突/过期/错误面
 * 各自造独立现场，互不影响。
 *
 * 绝不能碰真机 home：`ATB_CLIENT_HOME` 在 createTestApp 之前指向 mkdtemp 出来的目录，
 * 所有用户级路径（Cline Documents、Windsurf .codeium、Qoder .qoder-cn）都落在那里。
 */

const ORIGINAL_CLAUDE_MD = '# 用户自己的说明\n第二行\n';
const CURSOR_UNMANAGED = '# 用户自己的 Cursor 规则\n不要覆盖我\n';

let t: TestApp;
let ui: ReturnType<typeof uiSender>;
let http: ReturnType<typeof request>;
let agent: IssuedAgent;
let workspace: string;
let home: string;
let root: string;
let previousClientHome: string | undefined;

let qoderRuleId: string;
let qoderSkillId: string;
let qoderSkillPath: string;
let claudeRuleId: string;

/** MCP 无状态传输：initialize 之后每个请求都要带协商出的版本。 */
let negotiated = '';
let seq = 0;

interface RpcEnvelope {
  jsonrpc: string;
  id?: number | null;
  result?: any;
  error?: { code: number; message: string };
}

interface ToolResult {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function mcpPost(
  token: string | null,
  payload: Record<string, unknown>,
): Promise<Res<RpcEnvelope>> {
  return http.post<RpcEnvelope>('/mcp', payload, {
    token,
    headers: {
      ...mcpAccept(),
      ...(negotiated ? { 'mcp-protocol-version': negotiated } : {}),
    },
    skipEnvelopeCheck: true,
  });
}

function rpc(token: string | null, method: string, params?: Record<string, unknown>) {
  return mcpPost(token, { jsonrpc: '2.0', id: ++seq, method, ...(params ? { params } : {}) });
}

function callTool(token: string | null, name: string, args: Record<string, unknown> = {}) {
  return rpc(token, 'tools/call', { name, arguments: args });
}

function overviewUrl(workspacePath?: string): string {
  return workspacePath === undefined
    ? `${API}/client-entries`
    : `${API}/client-entries?workspace=${encodeURIComponent(workspacePath)}`;
}

function planBody(
  client: string,
  scope: 'project' | 'user',
  assets: string[],
): Record<string, unknown> {
  return {
    client,
    scope,
    ...(scope === 'project' ? { workspace } : {}),
    assets,
  };
}

function installBody(
  client: string,
  scope: 'project' | 'user',
  assets: string[],
  planHash: string,
): Record<string, unknown> {
  return { ...planBody(client, scope, assets), plan_hash: planHash, confirm: true };
}

async function plan(
  client: string,
  scope: 'project' | 'user',
  assets: string[],
): Promise<Res<any>> {
  return ui.post(`${API}/client-entries/plan`, planBody(client, scope, assets));
}

async function install(
  client: string,
  scope: 'project' | 'user',
  assets: string[],
  planHash: string,
): Promise<Res<any>> {
  // 控制器没有 @HttpCode 覆盖：Nest 的 @Post 默认 201，和其它写接口口径一致。
  return ui.post(
    `${API}/client-entries/install`,
    installBody(client, scope, assets, planHash),
  );
}

function findClient(overview: any, id: string): any {
  const client = overview.clients.find((item: any) => item.client === id);
  if (!client) throw new Error(`概览里缺少客户端 ${id}`);
  return client;
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'atb-client-entry-e2e-'));
  const rawWorkspace = path.join(root, 'workspace');
  const rawHome = path.join(root, 'home');
  fs.mkdirSync(rawWorkspace, { recursive: true });
  fs.mkdirSync(rawHome, { recursive: true });
  // service 会把 workspace/home 归一成 realpath（macOS 的 /var → /private/var），
  // 夹具先取 realpath，后面按常量拼的路径才与接口返回一致。
  workspace = fs.realpathSync(rawWorkspace);
  home = fs.realpathSync(rawHome);

  // 工作区现场：.qoder/.cursor 让检测为 true；CLAUDE.md 是「已有用户内容」的托管块样本。
  fs.mkdirSync(path.join(workspace, '.qoder'), { recursive: true });
  fs.mkdirSync(path.join(workspace, '.cursor', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), ORIGINAL_CLAUDE_MD, 'utf8');
  // 无托管标记的既有文件 → cursor 项目级规则的冲突样本。
  fs.writeFileSync(
    path.join(workspace, '.cursor', 'rules', 'jarvis-workbench.mdc'),
    CURSOR_UNMANAGED,
    'utf8',
  );

  // 用户 home 只建 Documents：Cline 用户级在这一步必须仍然是「未检测到」。
  fs.mkdirSync(path.join(home, 'Documents'), { recursive: true });

  previousClientHome = process.env.ATB_CLIENT_HOME;
  process.env.ATB_CLIENT_HOME = home;

  t = await createTestApp();
  ui = uiSender(t);
  http = request(t);
  agent = await issueAgent(t, 'client-entry-e2e');
}, 60_000);

afterAll(async () => {
  await t?.close();
  if (previousClientHome === undefined) delete process.env.ATB_CLIENT_HOME;
  else process.env.ATB_CLIENT_HOME = previousClientHome;
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

describe('客户端入口 API 端到端', () => {
  it('GET /client-entries：六端齐全，项目级按配置锚点检测，Cline 不被 Documents 误报', async () => {
    const res = await ui.get(overviewUrl(workspace));
    expect(res.status).toBe(200);

    // 六端 + 末尾追加的 custom 兜底卡。
    expect(res.body.clients).toHaveLength(7);
    expect(res.body.clients.map((item: any) => item.client)).toEqual([
      ...CLIENT_IDS,
      'custom',
    ]);
    expect(res.body.clients.map((item: any) => item.client).sort()).toEqual(
      [...CLIENT_ENTRY_CLIENTS].sort(),
    );

    const qoder = findClient(res.body, 'qoder');
    const cursor = findClient(res.body, 'cursor');
    const claude = findClient(res.body, 'claude_code');
    const cline = findClient(res.body, 'cline');
    const windsurf = findClient(res.body, 'windsurf');
    const codex = findClient(res.body, 'codex');

    expect(qoder.detected.project).toBe(true); // <workspace>/.qoder
    expect(cursor.detected.project).toBe(true); // <workspace>/.cursor
    expect(claude.detected.project).toBe(true); // <workspace>/CLAUDE.md
    expect(cline.detected.project).toBe(false); // 没有 .clinerules
    expect(windsurf.detected.project).toBe(false); // 没有 .windsurf
    expect(codex.detected.project).toBe(false); // 没有 AGENTS.md / 技能根

    // 用户 home 只有 Documents：Cline / Windsurf 都不能因此被判成已配置。
    expect(cline.detected.user).toBe(false);
    expect(windsurf.detected.user).toBe(false);
    expect(claude.detected.user).toBe(false);
    expect(qoder.detected.user).toBe(false);

    expect(res.body.selfTest.serverName).toBe('jarvis-workbench');
    expect(res.body.selfTest.mcpEndpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(res.body.selfTest.wakeMode).toBe('single');

    // 建出 Cline 自己的 Documents/Cline 之后才应翻成 true。
    fs.mkdirSync(path.join(home, 'Documents', 'Cline'), { recursive: true });
    const after = await ui.get(overviewUrl(workspace));
    expect(after.status).toBe(200);
    expect(findClient(after.body, 'cline').detected.user).toBe(true);
    expect(findClient(after.body, 'windsurf').detected.user).toBe(false);

    // custom 兜底卡：固定在末尾，没有固定落点可展示，检测恒 false，台账不按 workspace 过滤。
    const custom = findClient(res.body, 'custom');
    expect(custom).toMatchObject({
      label: '其他客户端（手动指定目录）',
      assets: ['rule', 'skill'],
      scopes: ['project'],
      targets: [],
      detected: { project: false, user: false },
      stability: { rule: 'experimental', skill: 'experimental' },
      effectHint: {
        project: '以所选客户端的规则加载机制为准，通常新开会话后生效',
        user: '以所选客户端的规则加载机制为准，通常新开会话后生效',
      },
    });
    expect(custom.notes[0]).toContain('兜底');
    expect(custom.entries).toEqual([]);
  });

  it('Qoder 项目级 rule + skill：预览两个 create，安装落盘并记账', async () => {
    const planRes = await plan('qoder', 'project', ['rule', 'skill']);
    expect(planRes.status).toBe(201);
    expect(planRes.body.actions.map((action: any) => action.action)).toEqual([
      'create',
      'create',
    ]);

    const ruleAction = planRes.body.actions.find((action: any) => action.assetType === 'rule');
    const skillAction = planRes.body.actions.find(
      (action: any) => action.assetType === 'skill',
    );
    expect(ruleAction.targetPath).toBe(
      path.join(workspace, '.qoder', 'rules', 'jarvis-workbench.md'),
    );
    expect(skillAction.targetPath).toBe(
      path.join(workspace, '.qoder', 'skills', 'jarvis-workbench', 'SKILL.md'),
    );

    // 规则要能唤醒、能自检、能定位客户端；绝不能把 URL / Token 写进任何一端。
    expect(ruleAction.content).toContain('贾维斯');
    expect(ruleAction.content).toContain('wake_probe');
    expect(ruleAction.content).toContain('qoder');
    expect(skillAction.content).toContain('贾维斯');
    for (const action of planRes.body.actions) {
      expect(action.content).not.toMatch(/https?:\/\//);
      expect(action.content).not.toContain('Bearer');
      expect(action.content).not.toContain(t.uiToken);
      expect(action.content).not.toContain(agent.token);
    }

    const installRes = await install(
      'qoder',
      'project',
      ['rule', 'skill'],
      planRes.body.planHash,
    );
    expect(installRes.status).toBe(201);
    expect(installRes.body.entries).toHaveLength(2);
    expect(
      installRes.body.entries.every((entry: any) => entry.status === 'installed'),
    ).toBe(true);

    const ruleEntry = installRes.body.entries.find(
      (entry: any) => entry.assetType === 'rule',
    );
    const skillEntry = installRes.body.entries.find(
      (entry: any) => entry.assetType === 'skill',
    );
    qoderRuleId = ruleEntry.id;
    qoderSkillId = skillEntry.id;
    qoderSkillPath = skillEntry.targetPath;

    expect(fs.existsSync(ruleEntry.targetPath)).toBe(true);
    expect(fs.existsSync(skillEntry.targetPath)).toBe(true);

    expect(await t.prisma.clientEntry.count()).toBe(2);
    expect(
      await t.prisma.auditLog.count({ where: { action: 'client_entry_install' } }),
    ).toBe(2);
  });

  it('幂等：再预览全 unchanged，再安装不新增台账行与安装审计', async () => {
    const planRes = await plan('qoder', 'project', ['rule', 'skill']);
    expect(planRes.status).toBe(201);
    expect(planRes.body.actions.map((action: any) => action.action)).toEqual([
      'unchanged',
      'unchanged',
    ]);

    const installsBefore = await t.prisma.auditLog.count({
      where: { action: 'client_entry_install' },
    });

    const installRes = await install(
      'qoder',
      'project',
      ['rule', 'skill'],
      planRes.body.planHash,
    );
    expect(installRes.status).toBe(201);
    expect(installRes.body.entries).toHaveLength(2);
    expect(await t.prisma.clientEntry.count()).toBe(2);
    expect(
      await t.prisma.auditLog.count({ where: { action: 'client_entry_install' } }),
    ).toBe(installsBefore);
  });

  it('业务唯一键：陈旧 id 的 upsert 命中既有行并保留原 id，不新增台账行', async () => {
    const repository = t.app.get(ClientEntryRepository);
    const filter = {
      client: 'qoder' as const,
      scope: 'project' as const,
      workspacePath: fs.realpathSync(workspace),
    };
    const rows = await repository.listFor(filter);
    const rowA = rows.find((row) => row.assetType === 'rule');
    if (rowA === undefined) throw new Error('安装后应存在 qoder 项目级 rule 台账行');

    // 模拟并发/陈旧台账：同一个 target 换一个 uuid 再写一次，必须命中复合唯一键。
    const record: ClientEntryRecord = { ...rowA, id: 'race-1' };
    const first = await repository.upsert(record);
    expect(first.id).toBe(rowA.id);

    const second = await repository.upsert({ ...rowA, id: 'race-2' });
    expect(second.id).toBe(rowA.id);

    const after = await repository.listFor(filter);
    expect(after.filter((row) => row.targetPath === rowA.targetPath)).toHaveLength(1);
    expect(after).toHaveLength(rows.length);
  });

  it('POST /verify：按 id 校验两条，全部 installed', async () => {
    const res = await ui.post(`${API}/client-entries/verify`, {
      ids: [qoderRuleId, qoderSkillId],
    });
    expect(res.status).toBe(201);
    expect(res.body.summary).toMatchObject({ installed: 2, drifted: 0, missing: 0 });
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries.every((entry: any) => entry.status === 'installed')).toBe(true);
  });

  it('漂移与卸载边界：改过的整文件不删、未改的技能文件连空目录一起清掉', async () => {
    const rulePath = path.join(workspace, '.qoder', 'rules', 'jarvis-workbench.md');
    fs.appendFileSync(rulePath, '\n用户自己追加的内容\n', 'utf8');

    const verified = await ui.post(`${API}/client-entries/verify`, {
      ids: [qoderRuleId, qoderSkillId],
    });
    expect(verified.status).toBe(201);
    expect(verified.body.summary).toMatchObject({ installed: 1, drifted: 1 });
    expect(
      verified.body.entries.find((entry: any) => entry.id === qoderRuleId).status,
    ).toBe('drifted');

    const drifted = await ui.post(`${API}/client-entries/${qoderRuleId}/uninstall`, {
      confirm: true,
    });
    expect(drifted.status).toBe(201);
    expect(drifted.body).toMatchObject({ removed: false, kept: 'drifted' });
    expect(fs.existsSync(rulePath)).toBe(true);
    expect(fs.readFileSync(rulePath, 'utf8')).toContain('用户自己追加的内容');

    const keptRow = await t.prisma.clientEntry.findUnique({ where: { id: qoderRuleId } });
    expect(keptRow?.status).toBe('drifted');

    const uninstallsBefore = await t.prisma.auditLog.count({
      where: { action: 'client_entry_uninstall' },
    });
    const removed = await ui.post(`${API}/client-entries/${qoderSkillId}/uninstall`, {
      confirm: true,
    });
    expect(removed.status).toBe(201);
    expect(removed.body).toEqual({ removed: true });
    expect(fs.existsSync(qoderSkillPath)).toBe(false);
    expect(fs.existsSync(path.dirname(qoderSkillPath))).toBe(false);
    expect(
      await t.prisma.clientEntry.findUnique({ where: { id: qoderSkillId } }),
    ).toBeNull();
    expect(
      await t.prisma.auditLog.count({ where: { action: 'client_entry_uninstall' } }),
    ).toBe(uninstallsBefore + 1);
  });

  it('接管既有整文件：install 记 createdFile=false，卸载只清台账（kept=unmanaged）', async () => {
    const target = path.join(workspace, '.windsurf', 'rules', 'jarvis-workbench.md');
    const firstPlan = await plan('windsurf', 'project', ['rule']);
    expect(firstPlan.status).toBe(201);
    const desired = firstPlan.body.actions[0];
    expect(desired).toMatchObject({ action: 'create', targetPath: target });

    // 安装前文件已存在且内容与模板逐字一致：预览应判 unchanged（安全接管）。
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, desired.content, 'utf8');
    const before = fs.readFileSync(target);

    const takeover = await plan('windsurf', 'project', ['rule']);
    expect(takeover.status).toBe(201);
    expect(takeover.body.actions[0]).toMatchObject({ action: 'unchanged', targetPath: target });

    const installRes = await install('windsurf', 'project', ['rule'], takeover.body.planHash);
    expect(installRes.status).toBe(201);
    expect(installRes.body.entries).toHaveLength(1);
    const entry = installRes.body.entries[0];
    expect(entry).toMatchObject({ status: 'installed', targetPath: target, writeMode: 'file' });

    const row = await t.prisma.clientEntry.findUnique({ where: { id: entry.id } });
    // SQLite 里 Int 存 0/1，repository 读出时才映射成 boolean。
    expect(Boolean(row?.createdFile)).toBe(false);

    const uninstallRes = await ui.post(`${API}/client-entries/${entry.id}/uninstall`, {
      confirm: true,
    });
    expect(uninstallRes.status).toBe(201);
    expect(uninstallRes.body).toEqual({ removed: true, kept: 'unmanaged' });
    // 接管来的文件不归我们删：字节不变，台账行消失。
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target).equals(before)).toBe(true);

    const overview = await ui.get(overviewUrl(workspace));
    expect(overview.status).toBe(200);
    expect(
      findClient(overview.body, 'windsurf').entries.some((item: any) => item.id === entry.id),
    ).toBe(false);
  });

  it('Claude Code 托管块：追加不改原文，卸载后逐字还原', async () => {
    const claudePath = path.join(workspace, 'CLAUDE.md');
    const planRes = await plan('claude_code', 'project', ['rule']);
    expect(planRes.status).toBe(201);
    expect(planRes.body.actions).toHaveLength(1);
    // 已有无标记 CLAUDE.md：应判为可追加（create），不是 conflict。
    expect(planRes.body.actions[0]).toMatchObject({
      action: 'create',
      writeMode: 'managed_block',
      targetPath: claudePath,
      backupRequired: true,
    });

    const installRes = await install(
      'claude_code',
      'project',
      ['rule'],
      planRes.body.planHash,
    );
    expect(installRes.status).toBe(201);
    const entry = installRes.body.entries.find((item: any) => item.assetType === 'rule');
    claudeRuleId = entry.id;

    const installed = fs.readFileSync(claudePath, 'utf8');
    expect(installed.startsWith(ORIGINAL_CLAUDE_MD)).toBe(true);
    expect(installed).toContain(CLIENT_ENTRY_MARKER_BEGIN);
    expect(installed).toContain(CLIENT_ENTRY_MARKER_END);
    // 原文未被改写：marker 之前必须逐字是原两行。
    expect(installed.slice(0, ORIGINAL_CLAUDE_MD.length)).toBe(ORIGINAL_CLAUDE_MD);

    const row = await t.prisma.clientEntry.findUnique({ where: { id: claudeRuleId } });
    expect(row?.backupPath).toBeTruthy();
    expect(row?.backupPath && fs.existsSync(row.backupPath)).toBe(true);

    const removed = await ui.post(`${API}/client-entries/${claudeRuleId}/uninstall`, {
      confirm: true,
    });
    expect(removed.status).toBe(201);
    expect(removed.body).toEqual({ removed: true });
    expect(fs.existsSync(claudePath)).toBe(true);
    expect(fs.readFileSync(claudePath, 'utf8')).toBe(ORIGINAL_CLAUDE_MD);
    expect(fs.readFileSync(claudePath, 'utf8')).not.toContain(CLIENT_ENTRY_MARKER_BEGIN);
    expect(
      await t.prisma.clientEntry.findUnique({ where: { id: claudeRuleId } }),
    ).toBeNull();
  });

  it('冲突：无托管标记的既有 Cursor 规则判 conflict，install 回 409 且原文件不动', async () => {
    const cursorPath = path.join(workspace, '.cursor', 'rules', 'jarvis-workbench.mdc');
    const planRes = await plan('cursor', 'project', ['rule']);
    expect(planRes.status).toBe(201);
    expect(planRes.body.actions[0]).toMatchObject({
      action: 'conflict',
      reason: 'file_exists_unmanaged',
      targetPath: cursorPath,
    });

    const installRes = await install(
      'cursor',
      'project',
      ['rule'],
      planRes.body.planHash,
    );
    expect(installRes.status).toBe(409);
    expect(errorCode(installRes)).toBe('CLIENT_ENTRY_CONFLICT');
    expect(fs.readFileSync(cursorPath, 'utf8')).toBe(CURSOR_UNMANAGED);
    expect(await t.prisma.clientEntry.count({ where: { client: 'cursor' } })).toBe(0);
  });

  it('过期计划：预览后目标被抢先创建，旧 plan_hash 安装回 409 且不写台账', async () => {
    const planRes = await plan('codex', 'project', ['skill']);
    expect(planRes.status).toBe(201);
    const action = planRes.body.actions[0];
    expect(action.action).toBe('create');

    fs.mkdirSync(path.dirname(action.targetPath), { recursive: true });
    fs.writeFileSync(action.targetPath, '# 用户抢先生成的技能\n', 'utf8');

    const installRes = await install(
      'codex',
      'project',
      ['skill'],
      planRes.body.planHash,
    );
    expect(installRes.status).toBe(409);
    expect(errorCode(installRes)).toBe('CLIENT_ENTRY_PLAN_STALE');
    expect(await t.prisma.clientEntry.count({ where: { client: 'codex' } })).toBe(0);
  });

  it('用户级：Qoder 规则落在临时 home 的 .qoder-cn，台账 workspace_path 为 null', async () => {
    const target = path.join(home, '.qoder-cn', 'rules', 'jarvis-workbench.md');
    const planRes = await plan('qoder', 'user', ['rule']);
    expect(planRes.status).toBe(201);
    expect(planRes.body.actions[0]).toMatchObject({
      action: 'create',
      targetPath: target,
    });

    const installRes = await install('qoder', 'user', ['rule'], planRes.body.planHash);
    expect(installRes.status).toBe(201);
    expect(fs.existsSync(target)).toBe(true);

    const row = await t.prisma.clientEntry.findFirst({
      where: { client: 'qoder', scope: 'user', targetPath: target },
    });
    expect(row).not.toBeNull();
    expect(row?.workspacePath).toBeNull();

    // 不传 workspace 也看得到用户级台账；项目级 targets 不展示。
    const overview = await ui.get(overviewUrl());
    expect(overview.status).toBe(200);
    const qoder = findClient(overview.body, 'qoder');
    expect(qoder.entries.some((entry: any) => entry.id === row!.id)).toBe(true);
    expect(qoder.targets.every((item: any) => item.scope === 'user')).toBe(true);
  });

  it('custom 兜底全链路：plan → install → verify → overview → uninstall 走 HTTP，台账记所选目录', async () => {
    // 目录选择器给的目录可能尚不存在（如 <workspace>/.codebuddy/rules）；
    // 已存在的父目录先取 realpath，避免 macOS /var → /private/var 与台账口径分叉。
    const base = fs.realpathSync(fs.mkdtempSync(path.join(root, 'custom-client-')));
    const targetDir = path.join(base, '.codebuddy', 'rules');

    // 校验面：custom 缺 target_dir / 六端多 target_dir → 422 字段错误；custom 传 user scope → 422 UNSUPPORTED。
    const missingDir = await ui.post(`${API}/client-entries/plan`, {
      client: 'custom',
      scope: 'project',
    });
    expect(missingDir.status).toBe(422);
    expect(errorCode(missingDir)).toBe('VALIDATION_FAILED');

    const builtinWithDir = await ui.post(`${API}/client-entries/plan`, {
      ...planBody('qoder', 'project', ['rule']),
      target_dir: targetDir,
    });
    expect(builtinWithDir.status).toBe(422);
    expect(errorCode(builtinWithDir)).toBe('VALIDATION_FAILED');

    const wrongScope = await ui.post(`${API}/client-entries/plan`, {
      client: 'custom',
      scope: 'user',
      target_dir: targetDir,
    });
    expect(wrongScope.status).toBe(422);
    expect(errorCode(wrongScope)).toBe('CLIENT_ENTRY_UNSUPPORTED');

    const planRes = await ui.post(`${API}/client-entries/plan`, {
      client: 'custom',
      scope: 'project',
      target_dir: targetDir,
      assets: ['rule', 'skill'],
    });
    expect(planRes.status).toBe(201);
    expect(planRes.body.client).toBe('custom');
    expect(planRes.body.actions.map((action: any) => action.action)).toEqual([
      'create',
      'create',
    ]);
    const ruleAction = planRes.body.actions.find((action: any) => action.assetType === 'rule');
    const skillAction = planRes.body.actions.find((action: any) => action.assetType === 'skill');
    expect(ruleAction.targetPath).toBe(path.join(targetDir, 'jarvis-workbench.md'));
    expect(skillAction.targetPath).toBe(path.join(targetDir, 'jarvis-workbench', 'SKILL.md'));
    // rule 是无 frontmatter 的通用 Markdown，自检来源传 custom；skill 沿用通用手册。
    expect(ruleAction.content.startsWith('---')).toBe(false);
    expect(ruleAction.content).toContain('`source` 传 `custom`');
    expect(skillAction.content).toContain('领取：');

    const installRes = await ui.post(`${API}/client-entries/install`, {
      client: 'custom',
      scope: 'project',
      target_dir: targetDir,
      assets: ['rule', 'skill'],
      plan_hash: planRes.body.planHash,
      confirm: true,
    });
    expect(installRes.status).toBe(201);
    expect(installRes.body.entries).toHaveLength(2);
    const ruleEntry = installRes.body.entries.find((entry: any) => entry.assetType === 'rule');
    const skillEntry = installRes.body.entries.find((entry: any) => entry.assetType === 'skill');
    // 目录尚不存在也照常落盘（writeFileAtomic 自建父目录）。
    expect(fs.existsSync(ruleAction.targetPath)).toBe(true);
    expect(fs.existsSync(skillAction.targetPath)).toBe(true);

    const rows = await t.prisma.clientEntry.findMany({ where: { client: 'custom' } });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.scope).toBe('project');
      expect(row.workspacePath).toBe(targetDir);
    }

    const verifyRes = await ui.post(`${API}/client-entries/verify`, {
      ids: [ruleEntry.id, skillEntry.id],
    });
    expect(verifyRes.status).toBe(201);
    expect(verifyRes.body.summary).toMatchObject({ installed: 2, drifted: 0, missing: 0 });

    // 兜底卡不按 workspace 过滤：不传 workspace 也看得到 custom 台账。
    const overview = await ui.get(overviewUrl());
    const custom = findClient(overview.body, 'custom');
    expect(custom.entries.map((entry: any) => entry.id).sort()).toEqual(
      [ruleEntry.id, skillEntry.id].sort(),
    );
    expect(custom.targets).toEqual([]);

    // 卸载：文件删除、台账清空、兜底卡 entries 归零。
    for (const id of [ruleEntry.id, skillEntry.id]) {
      const removed = await ui.post(`${API}/client-entries/${id}/uninstall`, { confirm: true });
      expect(removed.status).toBe(201);
      expect(removed.body).toEqual({ removed: true });
    }
    expect(fs.existsSync(ruleAction.targetPath)).toBe(false);
    expect(fs.existsSync(skillAction.targetPath)).toBe(false);
    expect(await t.prisma.clientEntry.count({ where: { client: 'custom' } })).toBe(0);
    const finalOverview = await ui.get(overviewUrl());
    expect(findClient(finalOverview.body, 'custom').entries).toEqual([]);
  });

  it('错误面：随机 id 404、缺 confirm 422、Agent Token 403', async () => {
    const missing = randomUUID();

    const verifyRes = await ui.post(`${API}/client-entries/verify`, { ids: [missing] });
    expect(verifyRes.status).toBe(404);
    expect(errorCode(verifyRes)).toBe('CLIENT_ENTRY_NOT_FOUND');

    const uninstallRes = await ui.post(
      `${API}/client-entries/${missing}/uninstall`,
      { confirm: true },
    );
    expect(uninstallRes.status).toBe(404);
    expect(errorCode(uninstallRes)).toBe('CLIENT_ENTRY_NOT_FOUND');

    const noConfirm = await ui.post(`${API}/client-entries/install`, {
      ...planBody('qoder', 'project', ['rule']),
      plan_hash: 'not-a-real-plan',
    });
    expect(noConfirm.status).toBe(422);
    expect(errorCode(noConfirm)).toBe('VALIDATION_FAILED');

    const forbidden = await agent.claims.get(overviewUrl(workspace));
    expect(forbidden.status).toBe(403);
    expect(errorCode(forbidden)).toBe('FORBIDDEN');
  });

  it('MCP 自测链路：wake_probe 经真 HTTP 落库，self-test 回读并可 since 过滤', async () => {
    const init = await rpc(agent.token, 'initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'atb-client-entry-e2e', version: '0.0.0' },
    });
    expect(init.status).toBe(200);
    negotiated = String(init.body.result.protocolVersion);

    const res = await callTool(agent.token, 'wake_probe', { source: 'qoder' });
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    const result = res.body.result as ToolResult;
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      server: 'jarvis-workbench',
      source: 'qoder',
    });
    // 末块是当前会话模式（首块仍是可 JSON 解析的载荷）。
    const notice = result.content[result.content.length - 1]!;
    expect(notice.type).toBe('text');
    expect(notice.text).toContain('【贾维斯】当前会话模式：单次');

    const selfTest = await ui.get(`${API}/client-entries/self-test`);
    expect(selfTest.status).toBe(200);
    expect(selfTest.body.probes[0]).toMatchObject({
      source: 'qoder',
      tokenName: agent.name,
    });
    expect(await t.prisma.wakeProbe.count()).toBe(1);

    const future = new Date(Date.now() + 60_000).toISOString();
    const filtered = await ui.get(
      `${API}/client-entries/self-test?since=${encodeURIComponent(future)}`,
    );
    expect(filtered.status).toBe(200);
    expect(filtered.body.probes).toEqual([]);
  });

  it('审计安全性：install 的 before/after 不含规则正文或托管标记', async () => {
    const rows = await t.prisma.auditLog.findMany({
      where: { action: 'client_entry_install' },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const payload = `${row.before ?? ''}\n${row.after ?? ''}`;
      expect(payload).not.toContain('贾维斯');
      expect(payload).not.toContain('jarvis-workbench:managed');
      expect(payload).not.toContain('Bearer');
    }
  });
});
