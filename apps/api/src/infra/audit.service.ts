import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuditAction, AuditTargetType, AuthorType } from '../contract/enums';
import { PrismaService } from './prisma.service';

export interface AuditEntry {
  actorType: AuthorType;
  actorName?: string | null;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId?: string | number | null;
  before?: unknown;
  after?: unknown;
}

/** 6.8：审计写入点全部在服务端，Agent 与前端都没有造动作名的入口。 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? this.prisma;
    await client.auditLog.create({
      data: {
        actorType: entry.actorType,
        actorName: entry.actorName ?? null,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId === undefined || entry.targetId === null ? null : String(entry.targetId),
        before: entry.before === undefined ? null : json(entry.before),
        after: entry.after === undefined ? null : json(entry.after),
      },
    });
  }
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ unserializable: String(value) });
  }
}
