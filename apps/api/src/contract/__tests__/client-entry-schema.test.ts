import { describe, expect, it } from 'vitest';

import {
  CLIENT_ENTRY_CLIENTS,
  CUSTOM_CLIENT_ID,
  clientEntryInstallSchema,
  clientEntryPlanSchema,
} from '../client-entry';

/**
 * custom 伪客户端的请求校验：target_dir 的有无是唯一的新契约面，
 * 词表本身（CLIENT_ENTRY_CLIENTS = 六端 + custom）与迁移 0026 的 CHECK 同值。
 */
describe('clientEntryPlanSchema：custom 与 target_dir', () => {
  it('CLIENT_ENTRY_CLIENTS 在六端末尾追加了 custom', () => {
    expect(CLIENT_ENTRY_CLIENTS).toEqual([
      'qoder',
      'cursor',
      'cline',
      'windsurf',
      'claude_code',
      'codex',
      'custom',
    ]);
  });

  it('custom 必须带 target_dir，缺了按字段错误拒绝', () => {
    const missing = clientEntryPlanSchema.safeParse({
      client: CUSTOM_CLIENT_ID,
      scope: 'project',
    });
    expect(missing.success).toBe(false);
    if (missing.success) throw new Error('expected failure');
    expect(missing.error.issues).toEqual([
      expect.objectContaining({ path: ['target_dir'] }),
    ]);

    const ok = clientEntryPlanSchema.safeParse({
      client: CUSTOM_CLIENT_ID,
      scope: 'project',
      target_dir: ' /tmp/my-client/rules\n',
    });
    expect(ok.success).toBe(true);
    if (!ok.success) throw new Error('expected success');
    // trim() 清洗照旧生效。
    expect(ok.data.target_dir).toBe('/tmp/my-client/rules');
  });

  it.each(['qoder', 'cursor', 'cline', 'windsurf', 'claude_code', 'codex'] as const)(
    '%s 传 target_dir 被按字段错误拒绝',
    (client) => {
      const result = clientEntryPlanSchema.safeParse({
        client,
        scope: 'project',
        workspace: '/tmp/ws',
        target_dir: '/tmp/my-client/rules',
      });
      expect(result.success).toBe(false);
      if (result.success) throw new Error('expected failure');
      expect(result.error.issues).toEqual([
        expect.objectContaining({ path: ['target_dir'] }),
      ]);
    },
  );

  it('install schema 继承同一约束：custom 缺 target_dir、六端多 target_dir 都拒绝', () => {
    expect(
      clientEntryInstallSchema.safeParse({ client: CUSTOM_CLIENT_ID, scope: 'project' }).success,
    ).toBe(false);
    expect(
      clientEntryInstallSchema.safeParse({
        client: 'qoder',
        scope: 'project',
        workspace: '/tmp/ws',
        target_dir: '/tmp/x',
        plan_hash: 'hash',
        confirm: true,
      }).success,
    ).toBe(false);
    expect(
      clientEntryInstallSchema.safeParse({
        client: CUSTOM_CLIENT_ID,
        scope: 'project',
        target_dir: '/tmp/x',
        plan_hash: 'hash',
        confirm: true,
      }).success,
    ).toBe(true);
  });
});
