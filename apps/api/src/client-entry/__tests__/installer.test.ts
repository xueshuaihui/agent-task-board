import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CLIENT_ENTRY_MARKER_BEGIN as BEGIN,
  CLIENT_ENTRY_MARKER_END as END,
  CLIENT_ENTRY_TEMPLATE_VERSION,
  type ClientEntryScope,
  type ClientId,
} from '../../contract/client-entry';
import { MCP_SERVER_NAME } from '../../mcp/wake';
import { sha256 } from '../atomic-write';
import type { ClientEnv } from '../client-env';
import {
  applyPlan,
  overLimitActions,
  planInstall,
  uninstallEntry,
  verifyEntry,
  type AppliedAction,
  type InstallPlan,
  type InstallPlanInput,
  type PlanAction,
  type StoredEntry,
} from '../installer';
import { readManagedBlock } from '../managed-block';

let root: string;
let workspace: string;
let home: string;
let env: ClientEnv;
let previousDataDir: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'atb-installer-'));
  const rawWorkspace = path.join(root, 'workspace');
  const rawHome = path.join(root, 'home');
  fs.mkdirSync(rawWorkspace, { recursive: true });
  fs.mkdirSync(rawHome, { recursive: true });
  // workspace 会被 installer 归一成 realpath（macOS 的 /var → /private/var），
  // 夹具先取 realpath，断言里的目标路径才与计划一致。
  workspace = fs.realpathSync(rawWorkspace);
  home = fs.realpathSync(rawHome);
  env = { platform: process.platform, home, appData: path.join(home, '.config') };
  // 备份写到临时 data 目录，跑用例不往真机 ~/.jarvis-workbench 里丢文件。
  previousDataDir = process.env.ATB_DATA_DIR;
  process.env.ATB_DATA_DIR = path.join(root, 'data');
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.ATB_DATA_DIR;
  else process.env.ATB_DATA_DIR = previousDataDir;
  fs.rmSync(root, { recursive: true, force: true });
});

const cursorRule = () => path.join(workspace, '.cursor', 'rules', 'jarvis-workbench.mdc');
const claudeRule = () => path.join(workspace, 'CLAUDE.md');
const qoderSkill = () => path.join(workspace, '.qoder', 'skills', MCP_SERVER_NAME, 'SKILL.md');

function entryIdFor(): (targetPath: string) => string {
  const ids = new Map<string, string>();
  return (targetPath) => {
    const existing = ids.get(targetPath);
    if (existing !== undefined) return existing;
    const id = `entry-${ids.size + 1}`;
    ids.set(targetPath, id);
    return id;
  };
}

function storedFrom(
  action: PlanAction,
  applied: AppliedAction,
  client: ClientId = 'cursor',
  scope: ClientEntryScope = 'project',
): StoredEntry {
  return {
    id: applied.entryId,
    client,
    scope,
    workspacePath: scope === 'project' ? workspace : null,
    assetType: action.assetType,
    assetName: action.assetName,
    targetPath: action.targetPath,
    writeMode: action.writeMode,
    contentHash: action.contentHash,
    fileHash: applied.fileHash,
    templateVersion: applied.templateVersion,
    createdFile: applied.createdFile,
    marker: applied.marker,
  };
}

async function install(input: InstallPlanInput, plan: InstallPlan) {
  return applyPlan({ input, planHash: plan.planHash, entryIdFor: entryIdFor() });
}

describe('planInstall / applyPlan：整文件资产', () => {
  it('cursor 项目级 rule：create → 落盘，回读哈希与台账一致', async () => {
    const input: InstallPlanInput = {
      client: 'cursor',
      scope: 'project',
      workspace,
      env,
      assets: ['rule'],
    };
    const plan = await planInstall(input);
    expect(plan.actions).toHaveLength(1);
    const action = plan.actions[0];

    expect(action.action).toBe('create');
    expect(action.targetPath).toBe(cursorRule());
    expect(action.writeMode).toBe('file');
    expect(action.assetName).toBe(MCP_SERVER_NAME);
    // 上游 CURSOR_FRONTMATTER 的顺序是 description → alwaysApply → 收尾 ---；
    // 这里断言「frontmatter 在最前且 alwaysApply: true 在 frontmatter 内」。
    expect(action.content.startsWith('---\n')).toBe(true);
    expect(action.content.slice(0, action.content.indexOf('\n---', 4))).toContain(
      'alwaysApply: true',
    );
    expect(action.content.endsWith('\n')).toBe(true);
    expect(action.contentChars).toBe(action.content.length);
    expect(action.contentHash).toBe(sha256(action.content));
    expect(action.expectedPrevHash).toBeNull();
    expect(action.backupRequired).toBe(false);
    expect(action.charLimit).toBeUndefined();
    expect(action.limitChars).toBeUndefined();
    expect(action.confidence).toBe('confirmed');

    const result = await install(input, plan);
    expect(result.applied).toHaveLength(1);
    const applied = result.applied[0];
    expect(applied.createdFile).toBe(true);
    expect(applied.backupPath).toBeNull();
    expect(applied.marker).toBe('');
    expect(applied.templateVersion).toBe(CLIENT_ENTRY_TEMPLATE_VERSION);

    const text = fs.readFileSync(action.targetPath, 'utf8');
    expect(text).toBe(action.content);
    expect(applied.fileHash).toBe(sha256(text));
    expect(await verifyEntry(storedFrom(action, applied))).toMatchObject({
      status: 'installed',
    });
  });

  it('二次预览/安装为 unchanged，不再重写文件', async () => {
    const input: InstallPlanInput = {
      client: 'cursor',
      scope: 'project',
      workspace,
      env,
      assets: ['rule'],
    };
    const first = await planInstall(input);
    await install(input, first);
    const target = first.actions[0].targetPath;
    const contentBefore = fs.readFileSync(target, 'utf8');
    const mtimeBefore = fs.statSync(target).mtimeMs;

    const second = await planInstall(input);
    expect(second.actions[0].action).toBe('unchanged');
    expect(second.actions[0].backupRequired).toBe(false);
    expect(second.actions[0].expectedPrevHash).toBe(second.actions[0].contentHash);

    const reapplied = await install(input, second);
    expect(reapplied.applied).toEqual([]);
    expect(reapplied.actions[0].action).toBe('unchanged');
    expect(fs.readFileSync(target, 'utf8')).toBe(contentBefore);
    expect(fs.statSync(target).mtimeMs).toBe(mtimeBefore);
  });
});

describe('planInstall / applyPlan：托管块资产', () => {
  it('Claude Code 项目级 rule 追加到已有 CLAUDE.md：原文逐字保留，块内改动才 drift', async () => {
    const original = '# 用户项目说明\n\n自己写的规则。\n';
    fs.writeFileSync(claudeRule(), original, 'utf8');

    const input: InstallPlanInput = {
      client: 'claude_code',
      scope: 'project',
      workspace,
      env,
      assets: ['rule'],
    };
    const plan = await planInstall(input);
    const action = plan.actions[0];
    expect(action.writeMode).toBe('managed_block');
    expect(action.action).toBe('create');
    // 文件已存在但无标记 → 追加托管块，仍要备份。
    expect(action.backupRequired).toBe(true);
    expect(action.expectedPrevHash).toBeNull();
    expect(action.content.startsWith('# Jarvis Workbench 唤醒入口')).toBe(true);
    expect(action.content).not.toContain(BEGIN);

    const result = await install(input, plan);
    const applied = result.applied[0];
    expect(applied.createdFile).toBe(false);
    expect(applied.backupPath).not.toBeNull();
    expect(applied.marker).toBe(BEGIN);

    const text = fs.readFileSync(claudeRule(), 'utf8');
    expect(text.startsWith(original)).toBe(true);
    expect(text.split(BEGIN)).toHaveLength(2);
    expect(text.split(END)).toHaveLength(2);
    const block = readManagedBlock(text);
    expect(block.kind).toBe('found');
    if (block.kind !== 'found') throw new Error('expected managed block');
    expect(block.body).toBe(action.content);

    const entry = storedFrom(action, applied, 'claude_code');
    expect(await verifyEntry(entry)).toMatchObject({ status: 'installed' });

    // 块外用户改动不算 drift。
    fs.writeFileSync(claudeRule(), `> 用户补充\n\n${text}`, 'utf8');
    expect(await verifyEntry(entry)).toMatchObject({ status: 'installed' });

    // 块内改动 → drifted。
    const current = fs.readFileSync(claudeRule(), 'utf8');
    const beginAt = current.indexOf(BEGIN) + BEGIN.length;
    fs.writeFileSync(
      claudeRule(),
      `${current.slice(0, beginAt)}\n额外一行\n${current.slice(beginAt)}`,
      'utf8',
    );
    expect(await verifyEntry(entry)).toMatchObject({ status: 'drifted' });
  });

  it('托管标记不成对：plan 为 conflict，verify 为 drifted，apply 拒绝', async () => {
    const broken = `${BEGIN}\n旧内容\n`;
    fs.writeFileSync(claudeRule(), broken, 'utf8');

    const input: InstallPlanInput = {
      client: 'claude_code',
      scope: 'project',
      workspace,
      env,
      assets: ['rule'],
    };
    const plan = await planInstall(input);
    const action = plan.actions[0];
    expect(action.action).toBe('conflict');
    expect(action.reason).toBe('managed_markers_unpaired');
    expect(action.expectedPrevHash).toBe(sha256(broken));
    expect(action.backupRequired).toBe(false);

    const entry: StoredEntry = {
      id: 'broken',
      client: 'claude_code',
      scope: 'project',
      workspacePath: workspace,
      assetType: 'rule',
      assetName: MCP_SERVER_NAME,
      targetPath: claudeRule(),
      writeMode: 'managed_block',
      contentHash: sha256(action.content),
      fileHash: sha256(broken),
      templateVersion: CLIENT_ENTRY_TEMPLATE_VERSION,
      createdFile: false,
      marker: BEGIN,
    };
    expect(await verifyEntry(entry)).toMatchObject({ status: 'drifted' });

    await expect(
      applyPlan({ input, planHash: plan.planHash, entryIdFor: entryIdFor() }),
    ).rejects.toMatchObject({ code: 'CLIENT_ENTRY_CONFLICT' });
    expect(fs.readFileSync(claudeRule(), 'utf8')).toBe(broken);
  });
});

describe('planInstall：冲突与过期', () => {
  it('已有无标记的技能文件 → conflict，apply 前就回 CONFLICT 且不覆盖', async () => {
    const target = qoderSkill();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '用户自己的技能内容\n', 'utf8');

    const input: InstallPlanInput = {
      client: 'qoder',
      scope: 'project',
      workspace,
      env,
      assets: ['skill'],
    };
    const plan = await planInstall(input);
    expect(plan.actions[0].targetPath).toBe(target);
    expect(plan.actions[0].action).toBe('conflict');
    expect(plan.actions[0].reason).toBe('file_exists_unmanaged');

    await expect(
      applyPlan({ input, planHash: plan.planHash, entryIdFor: entryIdFor() }),
    ).rejects.toMatchObject({ code: 'CLIENT_ENTRY_CONFLICT' });
    expect(fs.readFileSync(target, 'utf8')).toBe('用户自己的技能内容\n');
  });

  it('预览后目标文件被改 → 旧 planHash 回 PLAN_STALE', async () => {
    const input: InstallPlanInput = {
      client: 'cursor',
      scope: 'project',
      workspace,
      env,
      assets: ['rule'],
    };
    const plan = await planInstall(input);
    const target = plan.actions[0].targetPath;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '预览之后别人写的\n', 'utf8');

    await expect(
      applyPlan({ input, planHash: plan.planHash, entryIdFor: entryIdFor() }),
    ).rejects.toMatchObject({ code: 'CLIENT_ENTRY_PLAN_STALE' });
    expect(fs.readFileSync(target, 'utf8')).toBe('预览之后别人写的\n');
  });

  it('计划后目标文件出现（托管块路径）→ applyPlan 回 PLAN_STALE 且不写入', async () => {
    const input: InstallPlanInput = {
      client: 'claude_code',
      scope: 'project',
      workspace,
      env,
      assets: ['rule'],
    };
    const plan = await planInstall(input);
    expect(plan.actions[0].action).toBe('create');
    expect(plan.actions[0].expectedPrevHash).toBeNull();

    // 预览之后用户自己建了 CLAUDE.md：重新计划的结论（conflict + 整文件哈希）变了，
    // planHash 随之改变，必须拒绝而不是按旧计划追加托管块。
    const appeared = `${BEGIN}\n用户写了一半的旧标记\n`;
    fs.writeFileSync(claudeRule(), appeared, 'utf8');

    await expect(
      applyPlan({ input, planHash: plan.planHash, entryIdFor: entryIdFor() }),
    ).rejects.toMatchObject({ code: 'CLIENT_ENTRY_PLAN_STALE' });
    expect(fs.readFileSync(claudeRule(), 'utf8')).toBe(appeared);
  });

  it.skipIf(process.platform === 'win32')('目标为软链 → plan 阶段就回 PATH_UNSAFE', async () => {
    const target = cursorRule();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const outside = path.join(root, 'outside.md');
    fs.writeFileSync(outside, 'outside\n', 'utf8');
    fs.symlinkSync(outside, target);

    await expect(
      planInstall({ client: 'cursor', scope: 'project', workspace, env, assets: ['rule'] }),
    ).rejects.toMatchObject({ code: 'CLIENT_ENTRY_PATH_UNSAFE' });
  });
});

describe('planInstall：台账与资产校验', () => {
  it('台账命中 → update（带备份）；未命中但同内容 → unchanged', async () => {
    const target = cursorRule();
    fs.mkdirSync(path.dirname(target), { recursive: true });

    const bareInput: InstallPlanInput = {
      client: 'cursor',
      scope: 'project',
      workspace,
      env,
      assets: ['rule'],
    };
    const desired = (await planInstall(bareInput)).actions[0];

    const previousText = 'old version\n';
    fs.writeFileSync(target, previousText, 'utf8');
    const ledger: StoredEntry = {
      id: 'ledger-1',
      client: 'cursor',
      scope: 'project',
      workspacePath: workspace,
      assetType: 'rule',
      assetName: MCP_SERVER_NAME,
      targetPath: target,
      writeMode: 'file',
      contentHash: desired.contentHash,
      fileHash: sha256(previousText),
      templateVersion: CLIENT_ENTRY_TEMPLATE_VERSION,
      createdFile: true,
      marker: '',
    };

    const withLedger: InstallPlanInput = { ...bareInput, existingEntries: [ledger] };
    const hit = await planInstall(withLedger);
    expect(hit.actions[0].action).toBe('update');
    expect(hit.actions[0].expectedPrevHash).toBe(sha256(previousText));
    expect(hit.actions[0].backupRequired).toBe(true);

    const applied = await install(withLedger, hit);
    expect(applied.applied[0].backupPath).not.toBeNull();
    expect(fs.readFileSync(target, 'utf8')).toBe(desired.content);

    // 台账没有这一行，但内容恰好一致：孤儿文件安全接管为 unchanged。
    const orphan = await planInstall(bareInput);
    expect(orphan.actions[0].action).toBe('unchanged');
  });

  it('台账显示安装后被改过 → conflict（file_modified_since_install）', async () => {
    const target = cursorRule();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'user edited\n', 'utf8');

    const input: InstallPlanInput = {
      client: 'cursor',
      scope: 'project',
      workspace,
      env,
      assets: ['rule'],
      existingEntries: [
        {
          id: 'ledger-1',
          client: 'cursor',
          scope: 'project',
          workspacePath: workspace,
          assetType: 'rule',
          assetName: MCP_SERVER_NAME,
          targetPath: target,
          writeMode: 'file',
          contentHash: sha256('installed content'),
          fileHash: sha256('installed content'),
          templateVersion: CLIENT_ENTRY_TEMPLATE_VERSION,
          createdFile: true,
          marker: '',
        },
      ],
    };
    const plan = await planInstall(input);
    expect(plan.actions[0].action).toBe('conflict');
    expect(plan.actions[0].reason).toBe('file_modified_since_install');
    expect(plan.actions[0].expectedPrevHash).toBe(sha256('user edited\n'));
  });

  it('显式空资产 → 0 action + warning；不支持的资产/作用域 → UNSUPPORTED', async () => {
    const empty = await planInstall({
      client: 'cursor',
      scope: 'project',
      workspace,
      env,
      assets: [],
    });
    expect(empty.actions).toEqual([]);
    expect(empty.warnings).toContain('未选择任何资产');

    const emptyAgain = await planInstall({
      client: 'cursor',
      scope: 'project',
      workspace,
      env,
      assets: [],
    });
    expect(emptyAgain.planHash).toBe(empty.planHash);

    await expect(
      planInstall({ client: 'cline', scope: 'project', workspace, env, assets: ['skill'] }),
    ).rejects.toMatchObject({ code: 'CLIENT_ENTRY_UNSUPPORTED' });

    await expect(planInstall({ client: 'cursor', scope: 'user', env })).rejects.toMatchObject({
      code: 'CLIENT_ENTRY_UNSUPPORTED',
    });
  });
});

describe('uninstallEntry', () => {
  it('托管块卸载只摘块、保留用户内容；整文件被改过则保留并回 drifted', async () => {
    const original = '用户开头\n';
    fs.writeFileSync(claudeRule(), original, 'utf8');
    const claudeInput: InstallPlanInput = {
      client: 'claude_code',
      scope: 'project',
      workspace,
      env,
      assets: ['rule'],
    };
    const claudePlan = await planInstall(claudeInput);
    const claudeApplied = await install(claudeInput, claudePlan);
    const claudeEntry = storedFrom(claudePlan.actions[0], claudeApplied.applied[0], 'claude_code');

    expect(await uninstallEntry(claudeEntry)).toEqual({ removed: true });
    expect(fs.readFileSync(claudeRule(), 'utf8')).toBe(original);

    const cursorInput: InstallPlanInput = {
      client: 'cursor',
      scope: 'project',
      workspace,
      env,
      assets: ['rule'],
    };
    const cursorPlan = await planInstall(cursorInput);
    const cursorApplied = await install(cursorInput, cursorPlan);
    const cursorEntry = storedFrom(cursorPlan.actions[0], cursorApplied.applied[0]);
    fs.appendFileSync(cursorPlan.actions[0].targetPath, '用户追加\n', 'utf8');

    expect(await uninstallEntry(cursorEntry)).toEqual({ removed: false, kept: 'drifted' });
    expect(fs.existsSync(cursorPlan.actions[0].targetPath)).toBe(true);
  });

  it('托管块内容被用户改过 → 卸载回 drifted，文件一个字节都不改', async () => {
    const input: InstallPlanInput = {
      client: 'claude_code',
      scope: 'project',
      workspace,
      env,
      assets: ['rule'],
    };
    const plan = await planInstall(input);
    const applied = await install(input, plan);
    const entry = storedFrom(plan.actions[0], applied.applied[0], 'claude_code');

    const installed = fs.readFileSync(claudeRule(), 'utf8');
    const insertAt = installed.indexOf(BEGIN) + BEGIN.length;
    fs.writeFileSync(
      claudeRule(),
      `${installed.slice(0, insertAt)}\n用户自己补的块内内容\n${installed.slice(insertAt)}`,
      'utf8',
    );

    const before = fs.readFileSync(claudeRule());
    expect(await uninstallEntry(entry)).toEqual({ removed: false, kept: 'drifted' });
    expect(fs.readFileSync(claudeRule()).equals(before)).toBe(true);
    expect(readManagedBlock(fs.readFileSync(claudeRule(), 'utf8')).kind).toBe('found');
  });

  it('接管（createdFile=false）的整文件卸载不删文件；createdFile=true 仍删除', async () => {
    const target = cursorRule();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const content = '用户安装前就存在、内容恰好与模板一致的规则\n';
    fs.writeFileSync(target, content, 'utf8');

    const adopted: StoredEntry = {
      id: 'adopted',
      client: 'cursor',
      scope: 'project',
      workspacePath: workspace,
      assetType: 'rule',
      assetName: MCP_SERVER_NAME,
      targetPath: target,
      writeMode: 'file',
      contentHash: sha256(content),
      fileHash: sha256(content),
      templateVersion: CLIENT_ENTRY_TEMPLATE_VERSION,
      createdFile: false,
      marker: '',
    };

    expect(await uninstallEntry(adopted)).toEqual({ removed: true, kept: 'unmanaged' });
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe(content);

    // 内容被改过时仍然 drifted，且文件保留。
    fs.writeFileSync(target, `${content}用户追加\n`, 'utf8');
    expect(await uninstallEntry(adopted)).toEqual({ removed: false, kept: 'drifted' });

    // 同一份内容，若台账记的是本应用新建的文件，卸载照常删除。
    fs.writeFileSync(target, content, 'utf8');
    expect(await uninstallEntry({ ...adopted, id: 'created', createdFile: true })).toEqual({
      removed: true,
    });
    expect(fs.existsSync(target)).toBe(false);
  });

  it('技能卸载清理空的 jarvis-workbench 目录，不删用户目录', async () => {
    const skillsRoot = path.join(workspace, '.qoder', 'skills');
    fs.mkdirSync(skillsRoot, { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, 'keep.txt'), 'keep\n', 'utf8');

    const input: InstallPlanInput = {
      client: 'qoder',
      scope: 'project',
      workspace,
      env,
      assets: ['skill'],
    };
    const plan = await planInstall(input);
    expect(plan.actions[0].targetPath).toBe(qoderSkill());
    const result = await install(input, plan);
    expect(fs.existsSync(qoderSkill())).toBe(true);

    const entry = storedFrom(plan.actions[0], result.applied[0], 'qoder');
    expect(await uninstallEntry(entry)).toEqual({ removed: true });
    expect(fs.existsSync(qoderSkill())).toBe(false);
    expect(fs.existsSync(path.dirname(qoderSkill()))).toBe(false);
    expect(fs.existsSync(skillsRoot)).toBe(true);
    expect(fs.readFileSync(path.join(skillsRoot, 'keep.txt'), 'utf8')).toBe('keep\n');
  });
});

describe('Windsurf 全局规则的字符上限', () => {
  const windsurfRules = () =>
    path.join(home, '.codeium', 'windsurf', 'memories', 'global_rules.md');

  function userInput(): InstallPlanInput {
    return { client: 'windsurf', scope: 'user', env, assets: ['rule'] };
  }

  it('按写入后的整份文件计上限：块外 5950 字 → 超限、需显式确认', async () => {
    const outside = 'x'.repeat(5950);
    fs.mkdirSync(path.dirname(windsurfRules()), { recursive: true });
    fs.writeFileSync(windsurfRules(), outside, 'utf8');

    const input = userInput();
    const plan = await planInstall(input);
    const action = plan.actions[0];
    expect(action.writeMode).toBe('managed_block');
    expect(action.charLimit).toBe(6000);
    expect(action.limitChars).toBeGreaterThan(6000);
    expect(action.contentChars).toBeLessThan(6000);
    expect(action.warnings).toContain(
      `超过客户端 6000 字上限（写入后 ${action.limitChars} 字，其中本应用内容 ${action.contentChars} 字），安装需显式确认`,
    );
    expect(overLimitActions(plan.actions)).toEqual([action]);

    await expect(
      applyPlan({ input, planHash: plan.planHash, entryIdFor: entryIdFor() }),
    ).rejects.toMatchObject({
      code: 'CLIENT_ENTRY_LIMIT_EXCEEDED',
      details: [{ target: action.targetPath, chars: action.limitChars, limit: 6000 }],
    });
    // 需要显式确认时一个字节都没写。
    expect(fs.readFileSync(windsurfRules(), 'utf8')).toBe(outside);
  });

  it('块外内容较少时 limitChars ≤ 6000，不触发超限', async () => {
    const outside = 'x'.repeat(100);
    fs.mkdirSync(path.dirname(windsurfRules()), { recursive: true });
    fs.writeFileSync(windsurfRules(), outside, 'utf8');

    const plan = await planInstall(userInput());
    const action = plan.actions[0];
    expect(action.limitChars).toBeDefined();
    expect(action.limitChars as number).toBeLessThanOrEqual(6000);
    expect(overLimitActions(plan.actions)).toEqual([]);
    expect(action.warnings.some((warning) => warning.startsWith('超过客户端'))).toBe(false);
  });
});

describe('overLimitActions', () => {
  function synthetic(partial: Partial<PlanAction>): PlanAction {
    return {
      assetType: 'rule',
      assetName: MCP_SERVER_NAME,
      targetPath: '/tmp/jarvis-workbench.md',
      writeMode: 'file',
      action: 'create',
      content: 'x',
      contentChars: 1,
      contentHash: 'hash',
      expectedPrevHash: null,
      backupRequired: false,
      warnings: [],
      confidence: 'confirmed',
      effectHint: '新开会话后生效',
      ...partial,
    };
  }

  it('只挑出声明了 charLimit 且写入后整份文件超限的动作', () => {
    const atLimit = synthetic({ charLimit: 6000, limitChars: 6000 });
    const over = synthetic({ targetPath: '/tmp/over.md', charLimit: 6000, limitChars: 6001 });
    // 没有 limitChars（或没有 charLimit）的旧计划不判超限：宁可漏报也不误报。
    const noLimit = synthetic({ targetPath: '/tmp/none.md', contentChars: 99999 });
    const noMeasure = synthetic({ targetPath: '/tmp/no-measure.md', charLimit: 6000 });

    expect(overLimitActions([atLimit, over, noLimit, noMeasure])).toEqual([over]);
    expect(overLimitActions([atLimit, noLimit, noMeasure])).toEqual([]);
  });
});
