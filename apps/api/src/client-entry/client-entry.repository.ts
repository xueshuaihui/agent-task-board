import { Injectable } from '@nestjs/common';
import type { ClientEntry as ClientEntryRow, Prisma } from '@prisma/client';
import type {
  ClientEntryAsset,
  ClientEntryScope,
  ClientEntryStatus,
  ClientId,
} from '../contract/client-entry';
import { PrismaService } from '../infra/prisma.service';
import type { StoredEntry } from './installer';

/**
 * 客户端入口台账的数据层出口。
 *
 * 只做「行 ↔ StoredEntry」的形状转换，不在这里做业务校验、不写审计——安装/卸载的
 * 归属判断与留痕都在 service；installer 仍是唯一碰文件的一层。
 * `created_file` 在库里是 0/1，出参统一成 boolean（StoredEntry 的形状）。
 */
export interface ClientEntryRecord extends StoredEntry {
  backupPath: string | null;
  status: ClientEntryStatus;
  lastError: string | null;
  installedAt: string;
  verifiedAt: string | null;
  updatedAt: string;
}

export interface ClientEntryFilter {
  client?: ClientId;
  scope?: ClientEntryScope;
  /** 缺省 = 不过滤；`null` = 只取用户级（`workspace_path IS NULL`）。 */
  workspacePath?: string | null;
}

export interface VerificationPatch {
  status: ClientEntryStatus;
  lastError: string | null;
  verifiedAt: string;
}

/** 稳定顺序：同一输入两次查询的行序一致，预览/安装/自测对比时不会因顺序抖动误判。 */
const ROW_ORDER: Prisma.ClientEntryOrderByWithRelationInput[] = [
  { client: 'asc' },
  { scope: 'asc' },
  { assetType: 'asc' },
  { targetPath: 'asc' },
];

@Injectable()
export class ClientEntryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listAll(): Promise<ClientEntryRecord[]> {
    const rows = await this.prisma.clientEntry.findMany({ orderBy: ROW_ORDER });
    return rows.map(toRecord);
  }

  async listFor(filter: ClientEntryFilter): Promise<ClientEntryRecord[]> {
    const where: Prisma.ClientEntryWhereInput = {};
    if (filter.client !== undefined) where.client = filter.client;
    if (filter.scope !== undefined) where.scope = filter.scope;
    if (filter.workspacePath !== undefined) where.workspacePath = filter.workspacePath;
    const rows = await this.prisma.clientEntry.findMany({ where, orderBy: ROW_ORDER });
    return rows.map(toRecord);
  }

  async findById(id: string): Promise<ClientEntryRecord | null> {
    const row = await this.prisma.clientEntry.findUnique({ where: { id } });
    return row === null ? null : toRecord(row);
  }

  async findManyByIds(ids: string[]): Promise<ClientEntryRecord[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const rows = await this.prisma.clientEntry.findMany({
      where: { id: { in: unique } },
      orderBy: ROW_ORDER,
    });
    return rows.map(toRecord);
  }

  /** `tx` 由 service 传入时与审计共用同一事务；缺省走默认连接。 */
  async upsert(
    record: ClientEntryRecord,
    tx?: Prisma.TransactionClient,
  ): Promise<ClientEntryRecord> {
    const client = tx ?? this.prisma;
    const data = toData(record);
    // 按业务唯一键（client/scope/asset_type/asset_name/target_path）而不是 id 落库：
    // 并发或陈旧台账下同一目标可能各自生成 uuid，按 id upsert 会撞唯一约束（P2002）。
    // 命中既有行时 `update` 不带 id，原 id 保留，调用方要用返回值里的 id 记审计。
    const row = await client.clientEntry.upsert({
      where: {
        client_scope_assetType_assetName_targetPath: {
          client: record.client,
          scope: record.scope,
          assetType: record.assetType,
          assetName: record.assetName,
          targetPath: record.targetPath,
        },
      },
      create: { id: record.id, ...data },
      update: data,
    });
    return toRecord(row);
  }

  async delete(id: string, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? this.prisma;
    await client.clientEntry.delete({ where: { id } });
  }

  async updateVerification(id: string, patch: VerificationPatch): Promise<void> {
    await this.prisma.clientEntry.update({
      where: { id },
      data: {
        status: patch.status,
        lastError: patch.lastError,
        verifiedAt: patch.verifiedAt,
        // 校验也是一次「最近一次触碰」，列表按它排序/展示时不至于停在安装时刻。
        updatedAt: patch.verifiedAt,
      },
    });
  }
}

function toRecord(row: ClientEntryRow): ClientEntryRecord {
  return {
    id: row.id,
    client: row.client as ClientId,
    scope: row.scope as ClientEntryScope,
    workspacePath: row.workspacePath,
    assetType: row.assetType as ClientEntryAsset,
    assetName: row.assetName,
    targetPath: row.targetPath,
    writeMode: row.writeMode as ClientEntryRecord['writeMode'],
    contentHash: row.contentHash,
    fileHash: row.fileHash,
    templateVersion: row.templateVersion,
    createdFile: row.createdFile !== 0,
    marker: row.marker,
    backupPath: row.backupPath,
    status: row.status as ClientEntryStatus,
    lastError: row.lastError,
    installedAt: row.installedAt,
    verifiedAt: row.verifiedAt,
    updatedAt: row.updatedAt,
  };
}

function toData(record: ClientEntryRecord): Omit<Prisma.ClientEntryUncheckedCreateInput, 'id'> {
  return {
    client: record.client,
    scope: record.scope,
    workspacePath: record.workspacePath,
    assetType: record.assetType,
    assetName: record.assetName,
    targetPath: record.targetPath,
    writeMode: record.writeMode,
    contentHash: record.contentHash,
    fileHash: record.fileHash,
    templateVersion: record.templateVersion,
    marker: record.marker,
    createdFile: record.createdFile ? 1 : 0,
    backupPath: record.backupPath,
    status: record.status,
    lastError: record.lastError,
    installedAt: record.installedAt,
    verifiedAt: record.verifiedAt,
    updatedAt: record.updatedAt,
  };
}
