import path from 'node:path';
import type { ClientAdapter, TargetCandidate } from './types';
import { isDirectory, requireWorkspace } from './shared';

/**
 * Qoder 历史上存在 `~/.qoder-cn` 与 `~/.qoder` 两个用户根：优先已存在的，
 * 都不存在时按当前发行版建 `.qoder-cn`。项目级固定 `.qoder/`，与用户根无关。
 */
function resolveUserRoot(home: string): string {
  const preferred = path.join(home, '.qoder-cn');
  if (isDirectory(preferred)) return preferred;
  const legacy = path.join(home, '.qoder');
  if (isDirectory(legacy)) return legacy;
  return preferred;
}

export const qoderAdapter: ClientAdapter = {
  id: 'qoder',
  label: 'Qoder',
  assets: ['rule', 'skill'],
  scopes: ['project', 'user'],
  stability: { rule: 'stable', skill: 'stable' },
  notes: ['用户级优先使用已存在的 ~/.qoder-cn，其次 ~/.qoder；都不存在时新建 ~/.qoder-cn。'],
  effectHint: () => '新开会话后生效',
  targets({ asset, scope, env, workspace }): TargetCandidate[] {
    let root: string;
    if (scope === 'project') {
      const dir = requireWorkspace(workspace);
      if (dir === undefined) return [];
      root = path.join(dir, '.qoder');
    } else {
      root = resolveUserRoot(env.home);
    }

    const targetPath =
      asset === 'rule'
        ? path.join(root, 'rules', 'jarvis-workbench.md')
        : path.join(root, 'skills', 'jarvis-workbench', 'SKILL.md');
    return [
      {
        scope,
        asset,
        path: targetPath,
        detectPath: root,
        writeMode: 'file',
        // 用户根是二选一，落点会随机器状态变化，标 probable 让 UI 明示这一点。
        confidence: scope === 'project' ? 'confirmed' : 'probable',
        createDefault: true,
      },
    ];
  },
};
