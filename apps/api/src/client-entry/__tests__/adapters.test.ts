import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CLIENT_ENTRY_ASSETS,
  CLIENT_ENTRY_SCOPES,
  CLIENT_IDS,
  type ClientEntryAsset,
  type ClientEntryScope,
  type ClientId,
} from '../../contract/client-entry';
import type { ClientEnv } from '../client-env';
import { CLIENT_ADAPTERS, getAdapter } from '../adapters';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atb-client-entry-adapters-'));
const PLATFORMS: NodeJS.Platform[] = ['darwin', 'win32', 'linux'];

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function makeEnv(platform: NodeJS.Platform, label: string): ClientEnv {
  const home = path.join(root, label, 'home');
  fs.mkdirSync(home, { recursive: true });
  return { platform, home, appData: path.join(root, label, 'appdata') };
}

function makeWorkspace(label: string): string {
  const workspace = path.join(root, label, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  return workspace;
}

interface ExpectedTarget {
  base: 'workspace' | 'home';
  segments: string[];
  writeMode: 'file' | 'managed_block';
  confidence: 'confirmed' | 'probable';
  createDefault: boolean;
  charLimit?: number;
}

/**
 * 期望值独立于 adapter 实现写一遍（而不是 import adapter 自己的常量），
 * 这样改错路径时测试才会红。
 */
function expectedTarget(
  client: ClientId,
  scope: ClientEntryScope,
  asset: ClientEntryAsset,
): ExpectedTarget | null {
  if (asset === 'skill' && (client === 'cline' || client === 'windsurf')) return null;
  if (client === 'cursor' && scope === 'user') return null;

  if (client === 'qoder') {
    const rootSegments = scope === 'project' ? ['.qoder'] : ['.qoder-cn'];
    const leaf =
      asset === 'rule'
        ? ['rules', 'jarvis-workbench.md']
        : ['skills', 'jarvis-workbench', 'SKILL.md'];
    return {
      base: scope === 'project' ? 'workspace' : 'home',
      segments: [...rootSegments, ...leaf],
      writeMode: 'file',
      confidence: scope === 'project' ? 'confirmed' : 'probable',
      createDefault: true,
    };
  }

  if (client === 'cursor') {
    return asset === 'rule'
      ? {
          base: 'workspace',
          segments: ['.cursor', 'rules', 'jarvis-workbench.mdc'],
          writeMode: 'file',
          confidence: 'confirmed',
          createDefault: true,
        }
      : {
          base: 'workspace',
          segments: ['.cursor', 'skills', 'jarvis-workbench', 'SKILL.md'],
          writeMode: 'file',
          confidence: 'probable',
          createDefault: true,
        };
  }

  if (client === 'cline') {
    return scope === 'project'
      ? {
          base: 'workspace',
          segments: ['.clinerules', 'jarvis-workbench.md'],
          writeMode: 'file',
          confidence: 'confirmed',
          createDefault: true,
        }
      : {
          base: 'home',
          segments: ['Documents', 'Cline', 'Rules', 'jarvis-workbench.md'],
          writeMode: 'file',
          confidence: 'confirmed',
          createDefault: true,
        };
  }

  if (client === 'windsurf') {
    return scope === 'project'
      ? {
          base: 'workspace',
          segments: ['.windsurf', 'rules', 'jarvis-workbench.md'],
          writeMode: 'file',
          confidence: 'confirmed',
          createDefault: true,
        }
      : {
          base: 'home',
          segments: ['.codeium', 'windsurf', 'memories', 'global_rules.md'],
          writeMode: 'managed_block',
          confidence: 'probable',
          createDefault: true,
          charLimit: 6000,
        };
  }

  if (client === 'claude_code') {
    return scope === 'project'
      ? asset === 'rule'
        ? {
            base: 'workspace',
            segments: ['CLAUDE.md'],
            writeMode: 'managed_block',
            confidence: 'confirmed',
            createDefault: true,
          }
        : {
            base: 'workspace',
            segments: ['.claude', 'skills', 'jarvis-workbench', 'SKILL.md'],
            writeMode: 'file',
            confidence: 'confirmed',
            createDefault: true,
          }
      : asset === 'rule'
        ? {
            base: 'home',
            segments: ['.claude', 'CLAUDE.md'],
            writeMode: 'managed_block',
            confidence: 'confirmed',
            createDefault: true,
          }
        : {
            base: 'home',
            segments: ['.claude', 'skills', 'jarvis-workbench', 'SKILL.md'],
            writeMode: 'file',
            confidence: 'confirmed',
            createDefault: true,
          };
  }

  return scope === 'project'
    ? asset === 'rule'
      ? {
          base: 'workspace',
          segments: ['AGENTS.md'],
          writeMode: 'managed_block',
          confidence: 'confirmed',
          createDefault: true,
        }
      : {
          base: 'workspace',
          segments: ['.agents', 'skills', 'jarvis-workbench', 'SKILL.md'],
          writeMode: 'file',
          confidence: 'probable',
          createDefault: true,
        }
    : asset === 'rule'
      ? {
          base: 'home',
          segments: ['.codex', 'AGENTS.md'],
          writeMode: 'managed_block',
          confidence: 'confirmed',
          createDefault: true,
        }
      : {
          base: 'home',
          segments: ['.codex', 'skills', 'jarvis-workbench', 'SKILL.md'],
          writeMode: 'file',
          confidence: 'probable',
          createDefault: true,
        };
}

describe('路径矩阵', () => {
  it.each(PLATFORMS)('%s：六端 × 两作用域 × 两资产', (platform) => {
    const env = makeEnv(platform, platform);
    const workspace = makeWorkspace(platform);

    for (const client of CLIENT_IDS) {
      const adapter = getAdapter(client);
      for (const scope of CLIENT_ENTRY_SCOPES) {
        for (const asset of CLIENT_ENTRY_ASSETS) {
          const label = `${client}/${scope}/${asset}`;
          const targets = adapter.targets({ asset, scope, env, workspace });
          const expected = expectedTarget(client, scope, asset);
          if (expected === null) {
            expect(targets, label).toEqual([]);
            continue;
          }
          expect(targets, label).toHaveLength(1);
          const base = expected.base === 'workspace' ? workspace : env.home;
          expect(targets[0], label).toMatchObject({
            scope,
            asset,
            path: path.join(base, ...expected.segments),
            writeMode: expected.writeMode,
            confidence: expected.confidence,
            createDefault: expected.createDefault,
          });
          if (expected.charLimit === undefined) {
            expect(targets[0].charLimit, label).toBeUndefined();
          } else {
            expect(targets[0].charLimit, label).toBe(expected.charLimit);
          }
        }
      }
    }
  });

  it('项目级没有 workspace 时一律返回空数组', () => {
    const env = makeEnv('darwin', 'no-workspace');
    for (const client of CLIENT_IDS) {
      const adapter = getAdapter(client);
      for (const asset of CLIENT_ENTRY_ASSETS) {
        expect(adapter.targets({ asset, scope: 'project', env })).toEqual([]);
      }
    }
  });
});

describe('Qoder 用户根择一', () => {
  const qoder = getAdapter('qoder');
  const rulePath = (env: ClientEnv) =>
    qoder.targets({ asset: 'rule', scope: 'user', env })[0].path;
  const skillPath = (env: ClientEnv) =>
    qoder.targets({ asset: 'skill', scope: 'user', env })[0].path;

  it('.qoder-cn 与 .qoder 都在时优先 .qoder-cn', () => {
    const env = makeEnv('darwin', 'qoder-both');
    fs.mkdirSync(path.join(env.home, '.qoder-cn'), { recursive: true });
    fs.mkdirSync(path.join(env.home, '.qoder'), { recursive: true });
    expect(rulePath(env)).toBe(
      path.join(env.home, '.qoder-cn', 'rules', 'jarvis-workbench.md'),
    );
    expect(skillPath(env)).toBe(
      path.join(env.home, '.qoder-cn', 'skills', 'jarvis-workbench', 'SKILL.md'),
    );
  });

  it('只有 .qoder 时写 .qoder', () => {
    const env = makeEnv('darwin', 'qoder-legacy');
    fs.mkdirSync(path.join(env.home, '.qoder'), { recursive: true });
    expect(rulePath(env)).toBe(
      path.join(env.home, '.qoder', 'rules', 'jarvis-workbench.md'),
    );
  });

  it('都不存在时新建 .qoder-cn，并标 probable', () => {
    const env = makeEnv('darwin', 'qoder-none');
    const targets = qoder.targets({ asset: 'rule', scope: 'user', env });
    expect(targets[0]).toMatchObject({
      path: path.join(env.home, '.qoder-cn', 'rules', 'jarvis-workbench.md'),
      confidence: 'probable',
      createDefault: true,
    });
  });

  it('项目级固定 .qoder，不受用户根影响', () => {
    const env = makeEnv('darwin', 'qoder-project');
    const workspace = makeWorkspace('qoder-project');
    fs.mkdirSync(path.join(env.home, '.qoder'), { recursive: true });
    expect(
      qoder.targets({ asset: 'rule', scope: 'project', env, workspace })[0].path,
    ).toBe(path.join(workspace, '.qoder', 'rules', 'jarvis-workbench.md'));
  });
});

describe('Cursor 用户级', () => {
  const cursor = getAdapter('cursor');

  it('用户级不产生文件目标', () => {
    const env = makeEnv('darwin', 'cursor-user');
    expect(cursor.targets({ asset: 'rule', scope: 'user', env })).toEqual([]);
    expect(cursor.targets({ asset: 'skill', scope: 'user', env })).toEqual([]);
    expect(cursor.scopes).toEqual(['project']);
  });

  it('notes 提供复制兜底，effectHint 提示 Reload Window', () => {
    expect(cursor.notes.join('\n')).toContain(
      'User Rules 无稳定文件落点，请复制到 Cursor Settings → Rules',
    );
    expect(cursor.effectHint('project')).toContain('Reload Window');
  });
});

describe('Cline .clinerules 两种形态', () => {
  const cline = getAdapter('cline');

  it('不存在时写 .clinerules/jarvis-workbench.md', () => {
    const env = makeEnv('darwin', 'cline-default');
    const workspace = makeWorkspace('cline-default');
    expect(
      cline.targets({ asset: 'rule', scope: 'project', env, workspace })[0],
    ).toMatchObject({
      path: path.join(workspace, '.clinerules', 'jarvis-workbench.md'),
      writeMode: 'file',
    });
  });

  it('已是文件时写托管块', () => {
    const env = makeEnv('darwin', 'cline-file');
    const workspace = makeWorkspace('cline-file');
    fs.writeFileSync(path.join(workspace, '.clinerules'), 'user rules\n', 'utf8');
    expect(
      cline.targets({ asset: 'rule', scope: 'project', env, workspace })[0],
    ).toMatchObject({
      path: path.join(workspace, '.clinerules'),
      writeMode: 'managed_block',
    });
  });

  it('已是目录时写目录内文件', () => {
    const env = makeEnv('darwin', 'cline-dir');
    const workspace = makeWorkspace('cline-dir');
    fs.mkdirSync(path.join(workspace, '.clinerules'));
    expect(
      cline.targets({ asset: 'rule', scope: 'project', env, workspace })[0],
    ).toMatchObject({
      path: path.join(workspace, '.clinerules', 'jarvis-workbench.md'),
      writeMode: 'file',
    });
  });

  it('用户级固定 ~/Documents/Cline/Rules', () => {
    const env = makeEnv('darwin', 'cline-user');
    expect(cline.targets({ asset: 'rule', scope: 'user', env })[0].path).toBe(
      path.join(env.home, 'Documents', 'Cline', 'Rules', 'jarvis-workbench.md'),
    );
  });
});

describe('Codex 技能根择一', () => {
  const codex = getAdapter('codex');
  const skillPath = (scope: ClientEntryScope, env: ClientEnv, workspace?: string) =>
    codex.targets({ asset: 'skill', scope, env, workspace })[0].path;

  it('项目级默认 .agents/skills，已有 .codex/skills 时用它', () => {
    const env = makeEnv('darwin', 'codex-project');
    const plain = makeWorkspace('codex-project-plain');
    expect(skillPath('project', env, plain)).toBe(
      path.join(plain, '.agents', 'skills', 'jarvis-workbench', 'SKILL.md'),
    );

    const withCodex = makeWorkspace('codex-project-codex');
    fs.mkdirSync(path.join(withCodex, '.codex', 'skills'), { recursive: true });
    expect(skillPath('project', env, withCodex)).toBe(
      path.join(withCodex, '.codex', 'skills', 'jarvis-workbench', 'SKILL.md'),
    );
  });

  it('用户级：.codex/skills → .agents/skills → .codex/skills', () => {
    const none = makeEnv('darwin', 'codex-user-none');
    expect(skillPath('user', none)).toBe(
      path.join(none.home, '.codex', 'skills', 'jarvis-workbench', 'SKILL.md'),
    );

    const agents = makeEnv('darwin', 'codex-user-agents');
    fs.mkdirSync(path.join(agents.home, '.agents', 'skills'), { recursive: true });
    expect(skillPath('user', agents)).toBe(
      path.join(agents.home, '.agents', 'skills', 'jarvis-workbench', 'SKILL.md'),
    );

    const both = makeEnv('darwin', 'codex-user-both');
    fs.mkdirSync(path.join(both.home, '.codex', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(both.home, '.agents', 'skills'), { recursive: true });
    expect(skillPath('user', both)).toBe(
      path.join(both.home, '.codex', 'skills', 'jarvis-workbench', 'SKILL.md'),
    );
  });

  it('notes 提示 AGENTS.override.md 可能优先', () => {
    expect(codex.notes.join('\n')).toContain('AGENTS.override.md');
  });
});

describe('配置检测锚点（detectPath）', () => {
  const rule = (client: ClientId, scope: ClientEntryScope, env: ClientEnv, workspace?: string) =>
    getAdapter(client).targets({ asset: 'rule', scope, env, workspace })[0].detectPath;
  const skill = (client: ClientId, scope: ClientEntryScope, env: ClientEnv, workspace?: string) =>
    getAdapter(client).targets({ asset: 'skill', scope, env, workspace })[0].detectPath;

  it('Cline 用户级只认 Documents/Cline，Documents 存在不算已配置', () => {
    const env = makeEnv('darwin', 'detect-cline');
    fs.mkdirSync(path.join(env.home, 'Documents'), { recursive: true });
    const anchor = rule('cline', 'user', env);
    expect(anchor).toBe(path.join(env.home, 'Documents', 'Cline'));
    expect(fs.existsSync(anchor!)).toBe(false);

    fs.mkdirSync(path.join(env.home, 'Documents', 'Cline'), { recursive: true });
    expect(fs.existsSync(anchor!)).toBe(true);
  });

  it('Cline 项目级锚点是 .clinerules（文件或目录两种形态都取它）', () => {
    const env = makeEnv('darwin', 'detect-cline-project');
    const dirMode = makeWorkspace('detect-cline-project-dir');
    expect(rule('cline', 'project', env, dirMode)).toBe(path.join(dirMode, '.clinerules'));

    const fileMode = makeWorkspace('detect-cline-project-file');
    fs.writeFileSync(path.join(fileMode, '.clinerules'), 'user rules\n', 'utf8');
    expect(rule('cline', 'project', env, fileMode)).toBe(path.join(fileMode, '.clinerules'));
  });

  it('Windsurf 用户级只认 .codeium/windsurf，.codeium 或 memories 存在不算已配置', () => {
    const env = makeEnv('darwin', 'detect-windsurf');
    fs.mkdirSync(path.join(env.home, '.codeium', 'memories'), { recursive: true });
    const anchor = rule('windsurf', 'user', env);
    expect(anchor).toBe(path.join(env.home, '.codeium', 'windsurf'));
    expect(fs.existsSync(anchor!)).toBe(false);

    fs.mkdirSync(path.join(env.home, '.codeium', 'windsurf'), { recursive: true });
    expect(fs.existsSync(anchor!)).toBe(true);
  });

  it('Qoder 用户级锚点跟用户根择一，项目级固定 .qoder', () => {
    const env = makeEnv('darwin', 'detect-qoder');
    const workspace = makeWorkspace('detect-qoder');
    expect(rule('qoder', 'user', env)).toBe(path.join(env.home, '.qoder-cn'));
    fs.mkdirSync(path.join(env.home, '.qoder'), { recursive: true });
    expect(rule('qoder', 'user', env)).toBe(path.join(env.home, '.qoder'));
    expect(rule('qoder', 'project', env, workspace)).toBe(path.join(workspace, '.qoder'));
  });

  it('Cursor 项目级锚点是 .cursor', () => {
    const env = makeEnv('darwin', 'detect-cursor');
    const workspace = makeWorkspace('detect-cursor');
    expect(rule('cursor', 'project', env, workspace)).toBe(path.join(workspace, '.cursor'));
    expect(skill('cursor', 'project', env, workspace)).toBe(path.join(workspace, '.cursor'));
  });

  it('Claude Code：项目规则认 CLAUDE.md，项目技能认 .claude，用户级都认 ~/.claude', () => {
    const env = makeEnv('darwin', 'detect-claude');
    const workspace = makeWorkspace('detect-claude');
    expect(rule('claude_code', 'project', env, workspace)).toBe(
      path.join(workspace, 'CLAUDE.md'),
    );
    expect(skill('claude_code', 'project', env, workspace)).toBe(
      path.join(workspace, '.claude'),
    );
    expect(rule('claude_code', 'user', env)).toBe(path.join(env.home, '.claude'));
    expect(skill('claude_code', 'user', env)).toBe(path.join(env.home, '.claude'));
  });

  it('Codex：规则认 AGENTS.md，技能认实际选中的技能根', () => {
    const env = makeEnv('darwin', 'detect-codex');
    const workspace = makeWorkspace('detect-codex');
    expect(rule('codex', 'project', env, workspace)).toBe(path.join(workspace, 'AGENTS.md'));
    expect(skill('codex', 'project', env, workspace)).toBe(
      path.join(workspace, '.agents', 'skills'),
    );
    fs.mkdirSync(path.join(workspace, '.codex', 'skills'), { recursive: true });
    expect(skill('codex', 'project', env, workspace)).toBe(
      path.join(workspace, '.codex', 'skills'),
    );

    expect(rule('codex', 'user', env)).toBe(path.join(env.home, '.codex', 'AGENTS.md'));
    expect(skill('codex', 'user', env)).toBe(path.join(env.home, '.codex', 'skills'));
    fs.mkdirSync(path.join(env.home, '.agents', 'skills'), { recursive: true });
    expect(skill('codex', 'user', env)).toBe(path.join(env.home, '.agents', 'skills'));
  });
});

describe('adapter 元数据与能力矩阵一致', () => {
  const env = makeEnv('darwin', 'metadata');
  const workspace = makeWorkspace('metadata');

  it('注册表覆盖六端且 id 一致', () => {
    for (const client of CLIENT_IDS) {
      expect(CLIENT_ADAPTERS[client].id).toBe(client);
      expect(getAdapter(client)).toBe(CLIENT_ADAPTERS[client]);
    }
  });

  it('未列出的 scope / asset 一律返回空数组', () => {
    for (const client of CLIENT_IDS) {
      const adapter = CLIENT_ADAPTERS[client];
      for (const scope of CLIENT_ENTRY_SCOPES) {
        for (const asset of CLIENT_ENTRY_ASSETS) {
          if (!adapter.scopes.includes(scope) || !adapter.assets.includes(asset)) {
            expect(
              adapter.targets({ asset, scope, env, workspace }),
              `${client}/${scope}/${asset}`,
            ).toEqual([]);
          }
        }
      }
    }
  });

  it('六端都有非空的 notes 与生效提示', () => {
    for (const client of CLIENT_IDS) {
      const adapter = CLIENT_ADAPTERS[client];
      expect(adapter.notes.length).toBeGreaterThan(0);
      for (const scope of CLIENT_ENTRY_SCOPES) {
        expect(adapter.effectHint(scope).length).toBeGreaterThan(0);
      }
    }
  });

  it('Claude Code 的生效提示是新开会话', () => {
    expect(getAdapter('claude_code').effectHint('project')).toContain('新开会话');
  });
});
