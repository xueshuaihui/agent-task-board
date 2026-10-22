import path from 'node:path';
import type { ClientAdapter, TargetCandidate } from './types';
import { isDirectory, requireWorkspace } from './shared';

const SKILL_LEAF = ['jarvis-workbench', 'SKILL.md'];

/**
 * Codex 的规则只认 AGENTS.md（同目录的 AGENTS.override.md 可能优先，故在 notes 提示）；
 * 技能根在 `.codex/skills` 与 `.agents/skills` 之间择一，后者是实验落点。
 */
function projectSkillRoot(workspace: string): string {
  const codex = path.join(workspace, '.codex', 'skills');
  return isDirectory(codex) ? codex : path.join(workspace, '.agents', 'skills');
}

function userSkillRoot(home: string): string {
  const codex = path.join(home, '.codex', 'skills');
  if (isDirectory(codex)) return codex;
  const agents = path.join(home, '.agents', 'skills');
  if (isDirectory(agents)) return agents;
  return codex;
}

export const codexAdapter: ClientAdapter = {
  id: 'codex',
  label: 'Codex',
  assets: ['rule', 'skill'],
  scopes: ['project', 'user'],
  stability: { rule: 'stable', skill: 'experimental' },
  notes: [
    '若同目录存在 `AGENTS.override.md`，Codex 可能优先读取它，请检查其中是否也需要入口规则。',
    '技能根优先使用已存在的 `.codex/skills`，其次是 `.agents/skills`（实验落点）。',
  ],
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
              ? path.join(dir, 'AGENTS.md')
              : path.join(projectSkillRoot(dir), ...SKILL_LEAF),
          // 规则以 AGENTS.md 文件为准；技能以实际选中的技能根为准。
          detectPath:
            asset === 'rule' ? path.join(dir, 'AGENTS.md') : projectSkillRoot(dir),
          writeMode: asset === 'rule' ? 'managed_block' : 'file',
          confidence: asset === 'rule' ? 'confirmed' : 'probable',
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
            ? path.join(env.home, '.codex', 'AGENTS.md')
            : path.join(userSkillRoot(env.home), ...SKILL_LEAF),
        // 用户级规则认 ~/.codex/AGENTS.md 文件；技能认实际选中的技能根。
        detectPath:
          asset === 'rule' ? path.join(env.home, '.codex', 'AGENTS.md') : userSkillRoot(env.home),
        writeMode: asset === 'rule' ? 'managed_block' : 'file',
        confidence: asset === 'rule' ? 'confirmed' : 'probable',
        createDefault: true,
      },
    ];
  },
};
