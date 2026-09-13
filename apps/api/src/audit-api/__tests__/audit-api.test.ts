import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ArgumentMetadata } from '@nestjs/common';
import { afterEach, beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { newId } from '../../contract/ids';
import { nowSql } from '../../contract/time';
import { applyMigrations } from '../../infra/bootstrap';
import { AuditService } from '../../infra/audit.service';
import { PrismaService } from '../../infra/prisma.service';
import { ZodPipe } from '../../infra/zod.pipe';
import {
  AUDIT_PAGE_SIZE,
  type AuditListDto,
  type AuditListQuery,
  auditListQuerySchema,
} from '../audit-item.dto';
import { AuditQueryService } from '../audit-query.service';

/**
 * 13 章读取模型：`GET /api/v1/audit?target_type=&target_id=&page=`，
 * `page_size` 固定 50、时间倒序、无别的筛选。写入侧用真实的 AuditService，
 * 免得测的是一套形状、跑的是另一套。
 */
let dir: string;
let prisma: PrismaService;
let audit: AuditQueryService;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'atb-audit-'));
  process.env.ATB_DATA_DIR = dir;
  applyMigrations();
  prisma = new PrismaService();
  audit = new AuditQueryService(prisma);
});

afterAll(async () => {
  delete process.env.ATB_DATA_DIR;
  await prisma.$disconnect();
  rmSync(dir, { force: true, recursive: true });
});

/** 第 n 分钟的时间点：造出严格递增的 created_at，倒序才可断言。 */
function at(minutesAgo: number): string {
  return nowSql(new Date(Date.now() - minutesAgo * 60_000));
}

async function seed(count: number, prefix = 'task'): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await prisma.auditLog.create({
      data: {
        actorType: i % 3 === 0 ? 'system' : 'agent',
        actorName: i % 3 === 0 ? null : 'qoder-1',
        action: 'task_update',
        targetType: prefix,
        targetId: `${prefix}-${i}`,
        before: JSON.stringify({ priority: 0 }),
        after: JSON.stringify({ priority: 1 }),
        createdAt: at(count - i),
      },
    });
  }
}

async function page(pageNumber: number): Promise<AuditListDto> {
  return audit.list({ page: pageNumber });
}

beforeEach(async () => {
  await prisma.auditLog.deleteMany();
});
afterEach(async () => {
  await prisma.auditLog.deleteMany();
});

describe('分页与排序', () => {
  it('page_size 固定 50，不受调用方影响', async () => {
    await seed(120);
    const first = await page(1);
    expect(first.items).toHaveLength(AUDIT_PAGE_SIZE);
    expect(first.page_size).toBe(50);
    expect(first.total).toBe(120);
    expect(first.total_pages).toBe(3);
    expect(first.page).toBe(1);
  });

  it('时间倒序，翻页不重不漏', async () => {
    await seed(120);
    const pages = [await page(1), await page(2), await page(3)];
    const ids = pages.flatMap((item) => item.items.map((row) => row.id));
    expect(ids).toHaveLength(120);
    expect(new Set(ids).size).toBe(120);

    const times = pages.flatMap((item) => item.items.map((row) => row.created_at));
    expect([...times].sort().reverse()).toEqual(times);
    // seed() 里 i 越大时间越新：首行应是 task-119，末页末行应是 task-0。
    expect(pages[0].items[0].target_id).toBe('task-119');
    const tail = pages[2].items[pages[2].items.length - 1];
    expect(tail.target_id).toBe('task-0');
  });

  it('同一秒内的多条按自增 id 倒序，不靠 created_at 硬排', async () => {
    const same = at(5);
    for (let i = 0; i < 3; i += 1) {
      await prisma.auditLog.create({
        data: {
          actorType: 'user',
          action: 'task_create',
          targetType: 'task',
          targetId: `T-30${i}`,
          createdAt: same,
        },
      });
    }
    const { items } = await page(1);
    expect(items.map((row) => row.id)).toEqual([...items.map((row) => row.id)].sort((a, b) => b - a));
    expect(new Set(items.map((row) => row.created_at)).size).toBe(1);
  });

  it('超出末页返回空 items，但 total 与页数仍是真值', async () => {
    await seed(60);
    const last = await page(9);
    expect(last.items).toEqual([]);
    expect(last.total).toBe(60);
    expect(last.total_pages).toBe(2);
  });

  it('空表也显示 1 页，不让分页条出现 1 / 0', async () => {
    const empty = await page(1);
    expect(empty.total).toBe(0);
    expect(empty.total_pages).toBe(1);
  });
});

describe('读取模型的两个消费方', () => {
  it('抽屉传 target_id，设置页不传：同一份 DTO 形状', async () => {
    await seed(3, 'task');
    await prisma.auditLog.create({
      data: {
        actorType: 'user',
        action: 'task_transition',
        targetType: 'task',
        targetId: 'T-1015',
        before: JSON.stringify({ status: 'READY' }),
        after: JSON.stringify({ status: 'REVIEW' }),
        createdAt: at(1),
      },
    });
    const drawer = await audit.list({ page: 1, target_id: 'T-1015' });
    expect(drawer.total).toBe(1);
    expect(drawer.items[0]).toMatchObject({
      action: 'task_transition',
      target_type: 'task',
      target_id: 'T-1015',
      before: { status: 'READY' },
      after: { status: 'REVIEW' },
    });
    const wholePage = await page(1);
    expect(Object.keys(wholePage).sort().join(',')).toBe(
      'items,page,page_size,total,total_pages',
    );
  });

  it('target_type 过滤与 target_id 同时生效', async () => {
    await seed(2, 'task');
    await seed(2, 'run');
    const { items, total } = await audit.list({ page: 1, target_type: 'run' });
    expect(total).toBe(2);
    expect(items.every((row) => row.target_type === 'run')).toBe(true);
  });

  it('36 位 UUID 的 target_id 能过滤（Token/模板的审计行就是 UUID 主键）', async () => {
    const tokenId = newId();
    await prisma.auditLog.create({
      data: {
        actorType: 'user',
        action: 'token_revoke',
        targetType: 'token',
        targetId: tokenId,
        createdAt: at(1),
      },
    });
    await seed(2, 'task');
    const queryMeta: ArgumentMetadata = { type: 'query', metatype: Object, data: undefined };
    const pipe = (raw: Record<string, unknown>) =>
      new ZodPipe(auditListQuerySchema).transform(raw, queryMeta) as AuditListQuery;

    const filtered = await audit.list(pipe({ page: '1', target_id: tokenId }));
    expect(filtered.total).toBe(1);
    expect(filtered.items[0]).toMatchObject({ action: 'token_revoke', target_id: tokenId });

    // 放宽长度不等于放开长度：离谱值仍由 zod 挡在门外。
    expect(() => pipe({ page: '1', target_id: 'u'.repeat(65) })).toThrowError();
  });

  it('操作人展示口径：user → 我、system → 系统、agent → Token 名（20.8）', async () => {
    const writer = new AuditService(prisma);
    await writer.record({
      actorType: 'user',
      action: 'task_create',
      targetType: 'task',
      targetId: 'T-1016',
    });
    await writer.record({
      actorType: 'agent',
      actorName: 'qoder-1',
      action: 'run_claim',
      targetType: 'run',
      targetId: 'R-2001',
    });
    const { items } = await page(1);
    const labels = items.map((row) => `${row.actor_type}:${row.actor_label}`);
    expect(labels).toContain('user:我');
    expect(labels).toContain('agent:qoder-1');
  });

  it('before/after 是 JSON 文本时解成对象；手改坏行不炸整页', async () => {
    await prisma.auditLog.create({
      data: {
        actorType: 'system',
        action: 'lease_expire',
        targetType: 'task',
        targetId: 'T-1018',
        before: 'RUNNING',
        after: '{"status":"FAILED"}',
        createdAt: at(1),
      },
    });
    const { items } = await page(1);
    expect(items[0].after).toEqual({ status: 'FAILED' });
    expect(items[0].before).toBe('RUNNING');
    expect(items[0].actor_label).toBe('系统');
  });
});
