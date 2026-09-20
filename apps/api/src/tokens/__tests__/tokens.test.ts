import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '../../auth/auth.guard';
import { hashToken } from '../../contract/ids';
import { applyMigrations } from '../../infra/bootstrap';
import { PrismaService } from '../../infra/prisma.service';
import { TokensService } from '../tokens.service';
import { AuditService } from '../../infra/audit.service';

/**
 * 15 章「只存 hash、明文只出现一次」+ 13 章「吊销不删行」的回归。
 * 用独立临时库（`ATB_DATA_DIR` 指到 mkdtemp），不碰 apps/api/prisma/dev.db。
 */
let dir: string;
let prisma: PrismaService;
let tokens: TokensService;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'atb-tokens-'));
  process.env.ATB_DATA_DIR = dir;
  applyMigrations();
  prisma = new PrismaService();
  tokens = new TokensService(prisma, new AuditService(prisma));
});

afterAll(async () => {
  delete process.env.ATB_DATA_DIR;
  await prisma.$disconnect();
  rmSync(dir, { force: true, recursive: true });
});

/** 只喂 AuthGuard 真正读的那三个方法，不引 @nestjs/testing（未安装）。 */
function guardFor(bearer: string): Promise<unknown> {
  const reflector = new Reflector();
  vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue('agent');
  const req: { headers: Record<string, string>; auth?: unknown } = {
    headers: { authorization: `Bearer ${bearer}` },
  };
  const ctx = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return new AuthGuard(reflector, prisma).canActivate(ctx);
}

describe('POST /tokens', () => {
  it('响应给一次性明文，库里只落 sha256', async () => {
    const issued = await tokens.issue({ name: 'qoder-1', capabilities: ['language:typescript'] });
    expect(issued.token).toMatch(/^atb_[0-9a-zA-Z]{40}$/);
    expect(issued.capabilities).toEqual(['language:typescript']);

    const row = await prisma.apiToken.findUnique({ where: { id: issued.id } });
    expect(row).not.toBeNull();
    expect(row!.tokenHash).toBe(hashToken(issued.token));
    expect(row!.tokenHash).toHaveLength(64);
    expect(JSON.stringify(row)).not.toContain(issued.token);
  });

  it('出参不含 token_hash，审计详情也不含明文', async () => {
    const issued = await tokens.issue({ name: 'claude-ci', capabilities: [] });
    expect(Object.keys(issued)).not.toContain('token_hash');
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'token_issue', targetId: issued.id },
    });
    expect(audit?.after).not.toContain(issued.token);
    expect(audit?.after).not.toContain(hashToken(issued.token));
  });
});

describe('GET /tokens', () => {
  it('含已吊销项，且不带任何可还原凭证的列', async () => {
    const active = await tokens.issue({ name: 'qoder-2', capabilities: [] });
    const legacy = await tokens.issue({ name: 'legacy-bot', capabilities: [] });
    await tokens.revoke(legacy.id);

    const { items } = await tokens.list();
    const names = items.map((item) => item.name);
    expect(names).toContain('qoder-2');
    expect(names).toContain('legacy-bot');

    const revoked = items.find((item) => item.id === legacy.id)!;
    expect(revoked.enabled).toBe(false);
    expect(items.find((item) => item.id === active.id)!.enabled).toBe(true);
    expect(Object.keys(revoked).sort().join(',')).toBe(
      'capabilities,created_at,enabled,id,last_used_at,name',
    );
  });
});

describe('DELETE /tokens/:id', () => {
  it('吊销后该 Token 的请求一律 401，行仍在、Run 归属不丢', async () => {
    const issued = await tokens.issue({ name: 'busy-bot', capabilities: [] });
    await expect(guardFor(issued.token)).resolves.toBe(true);

    await prisma.task.create({ data: { id: 'T-9001', title: '归属检查' } });
    await prisma.taskRun.create({
      data: { id: 'R-9001', taskId: 'T-9001', runNumber: 1, tokenId: issued.id },
    });

    await tokens.revoke(issued.id);

    await expect(guardFor(issued.token)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401,
    });
    const row = await prisma.apiToken.findUnique({ where: { id: issued.id } });
    expect(row).not.toBeNull();
    expect(row!.enabled).toBe(0);
    const run = await prisma.taskRun.findUnique({ where: { id: 'R-9001' } });
    expect(run!.tokenId).toBe(issued.id);
  });

  it('重复吊销幂等，只留一条 token_revoke 审计', async () => {
    const issued = await tokens.issue({ name: 'twice-bot', capabilities: [] });
    await tokens.revoke(issued.id);
    await tokens.revoke(issued.id);
    const rows = await prisma.auditLog.findMany({
      where: { action: 'token_revoke', targetId: issued.id },
    });
    expect(rows).toHaveLength(1);
  });

  it('不存在的 id 给 404 NOT_FOUND', async () => {
    await expect(tokens.revoke('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });
});
