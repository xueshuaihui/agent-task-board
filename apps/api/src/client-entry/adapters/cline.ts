import path from 'node:path';
import type { ClientAdapter, TargetCandidate } from './types';
import { isFile, requireWorkspace } from './shared';

/**
 * Cline 的 `.clinerules` 既可能是目录也可能是单文件：目录模式写独立规则文件，
 * 单文件模式只能在末尾追加托管块。用户级规则目录固定在 Documents 下。
 */
export const clineAdapter: ClientAdapter = {
  id: 'cline',
  label: 'Cline',
  assets: ['rule'],
  scopes: ['project', 'user'],
  stability: { rule: 'stable', skill: 'experimental' },
  notes: [
    '项目级 `.clinerules` 已是文件时以托管块追加；是目录时写入 `jarvis-workbench.md`。',
    'Cline 无 Agent Skills，技能资产不提供。',
  ],
  effectHint: () => '新开任务后生效',
  targets({ asset, scope, env, workspace }): TargetCandidate[] {
    if (asset !== 'rule') return [];

    if (scope === 'project') {
      const dir = requireWorkspace(workspace);
      if (dir === undefined) return [];
      const marker = path.join(dir, '.clinerules');
      if (isFile(marker)) {
        return [
          {
            scope,
            asset,
            path: marker,
            detectPath: marker,
            writeMode: 'managed_block',
            confidence: 'confirmed',
            createDefault: true,
          },
        ];
      }
      return [
        {
          scope,
          asset,
          path: path.join(marker, 'jarvis-workbench.md'),
          detectPath: marker,
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
        path: path.join(env.home, 'Documents', 'Cline', 'Rules', 'jarvis-workbench.md'),
        // 只认 Cline 自己的 Documents/Cline：Documents 是 macOS 必备目录，Rules 也可能
        // 由其它工具共用，拿它们判断「已配置」会把没装 Cline 的机器误报成已安装。
        detectPath: path.join(env.home, 'Documents', 'Cline'),
        writeMode: 'file',
        confidence: 'confirmed',
        createDefault: true,
      },
    ];
  },
};
