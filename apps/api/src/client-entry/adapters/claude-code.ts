import path from 'node:path';
import type { ClientAdapter, TargetCandidate } from './types';
import { requireWorkspace } from './shared';

const SKILL_PATH = ['skills', 'jarvis-workbench', 'SKILL.md'];

/**
 * Claude Code 把项目级/用户级都建模成 `CLAUDE.md`，只能追加托管块；
 * 技能则是独立 SKILL.md 文件。两者路径都按官方文档的固定层级拼。
 */
export const claudeCodeAdapter: ClientAdapter = {
  id: 'claude_code',
  label: 'Claude Code',
  assets: ['rule', 'skill'],
  scopes: ['project', 'user'],
  stability: { rule: 'stable', skill: 'stable' },
  notes: ['规则写入 CLAUDE.md 的托管块，块外用户内容逐字保留；技能写入独立 SKILL.md。'],
  effectHint: () => '新开会话后生效',
  targets({ asset, scope, env, workspace }): TargetCandidate[] {
    if (scope === 'project') {
      const dir = requireWorkspace(workspace);
      if (dir === undefined) return [];
      return [
        {
          scope,
          asset,
          path:
            asset === 'rule'
              ? path.join(dir, 'CLAUDE.md')
              : path.join(dir, '.claude', ...SKILL_PATH),
          // 规则只认 CLAUDE.md 本身（项目根目录不算配置）；技能认 .claude 配置目录。
          detectPath: asset === 'rule' ? path.join(dir, 'CLAUDE.md') : path.join(dir, '.claude'),
          writeMode: asset === 'rule' ? 'managed_block' : 'file',
          confidence: 'confirmed',
          createDefault: true,
        },
      ];
    }

    return [
      {
        scope,
        asset,
        path:
          asset === 'rule'
            ? path.join(env.home, '.claude', 'CLAUDE.md')
            : path.join(env.home, '.claude', ...SKILL_PATH),
        // 两种资产都以 ~/.claude 作为「客户端已配置」的锚点。
        detectPath: path.join(env.home, '.claude'),
        writeMode: asset === 'rule' ? 'managed_block' : 'file',
        confidence: 'confirmed',
        createDefault: true,
      },
    ];
  },
};
