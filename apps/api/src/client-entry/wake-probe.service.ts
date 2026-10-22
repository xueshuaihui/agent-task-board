import { Injectable } from '@nestjs/common';
import type { WakeProbe as WakeProbeRow } from '@prisma/client';
import {
  sanitizeWakeSource,
  type WakeProbeRecorder,
} from '../contract/client-entry';
import { uuidv7 } from '../contract/ids';
import { PrismaService } from '../infra/prisma.service';

/** 自测落行的出参：`tokenId` 只给排障用，前端不需要时可以不展示。 */
export interface WakeProbeDto {
  id: string;
  source: string | null;
  tokenName: string | null;
  receivedAt: string;
  tokenId?: string;
}

/** 诊断数据只保留最近 50 条：自测表不是审计账本，没有长期留存价值。 */
const WAKE_PROBE_RETENTION = 50;
const DEFAULT_RECENT_LIMIT = 20;

@Injectable()
export class WakeProbeService implements WakeProbeRecorder {
  /**
   * 进程内串行链：写入后要按最新顺序裁掉第 50 条之后的行，两次并发 record 若各自读到
   * 同一份「前 50」会重复删或漏删。串起来后每条记录都基于上一条落库后的状态裁剪。
   * 链本身吞掉错误，单次 record 的失败仍会照常抛给调用方。
   */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly prisma: PrismaService) {}

  record(input: { source?: string; tokenId?: string; tokenName?: string }): Promise<void> {
    const run = this.tail.then(() => this.write(input));
    this.tail = run.catch(() => undefined);
    return run;
  }

  async recent(limit = DEFAULT_RECENT_LIMIT, since?: string): Promise<WakeProbeDto[]> {
    const rows = await this.prisma.wakeProbe.findMany({
      where:
        since === undefined
          ? undefined
          : { receivedAt: { gte: normalizeSince(since) } },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map(toWakeProbeDto);
  }

  private async write(input: {
    source?: string;
    tokenId?: string;
    tokenName?: string;
  }): Promise<void> {
    await this.prisma.wakeProbe.create({
      data: {
        id: uuidv7(),
        source: sanitizeWakeSource(input.source) ?? null,
        tokenId: input.tokenId ?? null,
        tokenName: input.tokenName ?? null,
        receivedAt: new Date().toISOString(),
      },
    });
    await this.prune();
  }

  private async prune(): Promise<void> {
    const stale = await this.prisma.wakeProbe.findMany({
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      skip: WAKE_PROBE_RETENTION,
      select: { id: true },
    });
    if (stale.length === 0) return;
    await this.prisma.wakeProbe.deleteMany({
      where: { id: { in: stale.map((row) => row.id) } },
    });
  }
}

/**
 * 库里存的是 `toISOString()`（毫秒 + Z）。入参可能带时区偏移或省略毫秒，
 * 先归一到同一格式再比较，避免字符串 gte 在边界上错开一秒/一毫秒。
 */
function normalizeSince(since: string): string {
  const parsed = new Date(since);
  return Number.isNaN(parsed.getTime()) ? since : parsed.toISOString();
}

function toWakeProbeDto(row: WakeProbeRow): WakeProbeDto {
  return {
    id: row.id,
    source: row.source,
    tokenName: row.tokenName,
    receivedAt: row.receivedAt,
    ...(row.tokenId === null ? {} : { tokenId: row.tokenId }),
  };
}
