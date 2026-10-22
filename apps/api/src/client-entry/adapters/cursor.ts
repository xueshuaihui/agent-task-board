import path from 'node:path';
import type { ClientAdapter, TargetCandidate } from './types';
import { requireWorkspace } from './shared';

/**
 * Cursor 的 User Rules 存在客户端内部存储里，没有可稳定写入的文件落点；
 * 用户级只给复制文案，不返回 target（`scopes` 因此也只有 project）。
 */
export const cursorAdapter: ClientAdapter = {
  id: 'cursor',
  label: 'Cursor',
  assets: ['rule', 'skill'],
  scopes: ['project'],
  stability: { rule: 'stable', skill: 'experimental' },
  notes: [
    'User Rules 无稳定文件落点，请复制到 Cursor Settings → Rules',
    '项目级技能目录（.cursor/skills）为实验能力，客户端版本可能不识别。',
  ],
  effectHint: () => '在 Cursor 执行 Reload Window 后生效',
  targets({ asset, scope, workspace }): TargetCandidate[] {
    if (scope !== 'project') return [];
    const dir = requireWorkspace(workspace);
    if (dir === undefined) return [];

    const root = path.join(dir, '.cursor');
    if (asset === 'rule') {
      return [
        {
          scope,
          asset,
          path: path.join(root, 'rules', 'jarvis-workbench.mdc'),
          detectPath: root,
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
        path: path.join(root, 'skills', 'jarvis-workbench', 'SKILL.md'),
        detectPath: root,
        writeMode: 'file',
        confidence: 'probable',
        createDefault: true,
      },
    ];
  },
};
