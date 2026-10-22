import type { ClientId } from '../../contract/client-entry';
import type { ClientAdapter } from './types';
import { qoderAdapter } from './qoder';
import { cursorAdapter } from './cursor';
import { clineAdapter } from './cline';
import { windsurfAdapter } from './windsurf';
import { claudeCodeAdapter } from './claude-code';
import { codexAdapter } from './codex';

export type { ClientAdapter, TargetCandidate, TargetConfidence } from './types';

/** 六端注册表；`Record<ClientId, …>` 让新增客户端时编译期就暴露漏注册。 */
export const CLIENT_ADAPTERS: Record<ClientId, ClientAdapter> = {
  qoder: qoderAdapter,
  cursor: cursorAdapter,
  cline: clineAdapter,
  windsurf: windsurfAdapter,
  claude_code: claudeCodeAdapter,
  codex: codexAdapter,
};

export function getAdapter(id: ClientId): ClientAdapter {
  const adapter = CLIENT_ADAPTERS[id];
  if (!adapter) throw new Error(`未知客户端：${id}`);
  return adapter;
}
