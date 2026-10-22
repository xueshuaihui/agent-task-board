import path from 'node:path';
import type { ClientAdapter, TargetCandidate } from './types';
import { requireWorkspace } from './shared';

/**
 * Windsurf 的全局规则是一份共享的 `global_rules.md`，所以只能写托管块；
 * 该文件还有 6000 字上限，超限时由 service 走 `allow_over_limit` 确认。
 */
export const windsurfAdapter: ClientAdapter = {
  id: 'windsurf',
  label: 'Windsurf',
  assets: ['rule'],
  scopes: ['project', 'user'],
  stability: { rule: 'stable', skill: 'experimental' },
  notes: [
    '用户级写入 `global_rules.md` 的托管块，客户端上限 6000 字，超限需显式确认。',
    'Windsurf 无 Agent Skills，技能资产不提供。',
  ],
  effectHint: () => '重载 Windsurf 后生效',
  targets({ asset, scope, env, workspace }): TargetCandidate[] {
    if (asset !== 'rule') return [];

    if (scope === 'project') {
      const dir = requireWorkspace(workspace);
      if (dir === undefined) return [];
      return [
        {
          scope,
          asset,
          path: path.join(dir, '.windsurf', 'rules', 'jarvis-workbench.md'),
          detectPath: path.join(dir, '.windsurf'),
          writeMode: 'file',
          confidence: 'confirmed',
          createDefault: true,
        },
      ];
    }

    return [
      {
        scope,
        asset,
        path: path.join(env.home, '.codeium', 'windsurf', 'memories', 'global_rules.md'),
        // `.codeium` 可能被 Codeium 插件（非 Windsurf）创建；只有 windsurf 子目录
        // 才说明这台机器装了 Windsurf。`memories` 也可能由别的记忆工具共用。
        detectPath: path.join(env.home, '.codeium', 'windsurf'),
        writeMode: 'managed_block',
        confidence: 'probable',
        createDefault: true,
        charLimit: 6000,
      },
    ];
  },
};
