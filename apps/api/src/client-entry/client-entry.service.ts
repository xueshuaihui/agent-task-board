import fs from 'node:fs';
import { Injectable } from '@nestjs/common';
import {
  CLIENT_ENTRY_MARKER_BEGIN,
  CLIENT_ENTRY_TEMPLATE_VERSION,
  type ClientEntryAsset,
  type ClientEntryInstallInput,
  type ClientEntryPlanInput,
  type ClientEntryScope,
  type ClientEntrySelfTestQuery,
  type ClientEntryStatus,
  type ClientEntryVerifyInput,
  type ClientId,
} from '../contract/client-entry';
import { ApiException } from '../contract/errors';
import { uuidv7 } from '../contract/ids';
import type { Settings } from '../contract/settings';
import { port } from '../common/paths';
import { AuditService } from '../infra/audit.service';
import { AppLogger } from '../infra/logger';
import { PrismaService } from '../infra/prisma.service';
import { SettingsService } from '../infra/settings.service';
import { MCP_SERVER_NAME } from '../mcp/wake';
import { CLIENT_ADAPTERS, type ClientAdapter, type TargetCandidate } from './adapters';
import { readFileIfExists, restoreBackup, sha256 } from './atomic-write';
import { resolveClientEnv, type ClientEnv } from './client-env';
import {
  applyPlan,
  planInstall,
  uninstallEntry,
  verifyEntry,
  type AppliedAction,
  type InstallPlanInput,
  type PlanAction,
} from './installer';
import { resolveWorkspaceDir } from './paths';
import {
  ClientEntryRepository,
  type ClientEntryRecord,
} from './client-entry.repository';
import { WakeProbeService, type WakeProbeDto } from './wake-probe.service';

/** 台账 DTO：字段与 Prisma 模型同名（camelCase），`updateAvailable` 由模板版本算出。 */
export interface ClientEntryDto {
  id: string;
  client: ClientId;
  scope: ClientEntryScope;
  workspacePath: string | null;
  assetType: ClientEntryAsset;
  assetName: string;
  targetPath: string;
  writeMode: 'file' | 'managed_block';
  status: ClientEntryStatus;
  templateVersion: number;
  installedAt: string;
  verifiedAt: string | null;
  lastError: string | null;
  updateAvailable: boolean;
}

export interface ClientTargetDto {
  scope: ClientEntryScope;
  asset: ClientEntryAsset;
  path: string;
  writeMode: 'file' | 'managed_block';
  confidence: 'confirmed' | 'probable';
  exists: boolean;
  note?: string;
}

export interface ClientDetectDto {
  client: ClientId;
  label: string;
  assets: ClientEntryAsset[];
  scopes: ClientEntryScope[];
  stability: Record<ClientEntryAsset, 'stable' | 'experimental'>;
  notes: string[];
  detected: { project: boolean; user: boolean };
  targets: ClientTargetDto[];
  entries: ClientEntryDto[];
  effectHint: { project: string; user: string };
}

export interface ClientEntryOverviewDto {
  clients: ClientDetectDto[];
  selfTest: {
    serverName: string;
    mcpEndpoint: string;
    wakeMode: Settings['mcp_wake_mode'];
    recent: WakeProbeDto[];
  };
}

export interface ClientEntryPlanDto {
  client: ClientId;
  scope: ClientEntryScope;
  planHash: string;
  actions: PlanAction[];
  warnings: string[];
}

export interface ClientEntryInstallResultDto {
  entries: ClientEntryDto[];
  actions: PlanAction[];
}

export interface ClientEntryVerifyResultDto {
  entries: ClientEntryDto[];
  summary: Record<ClientEntryStatus, number>;
}

export interface ClientEntryUninstallResultDto {
  removed: boolean;
  /** `unmanaged`：卸载成功但保留了安装前就存在的整文件（只删台账，不动文件）。 */
  kept?: 'drifted' | 'missing' | 'unmanaged';
  entry?: ClientEntryDto;
}

export interface ClientEntrySelfTestDto {
  serverName: string;
  mcpEndpoint: string;
  wakeMode: Settings['mcp_wake_mode'];
  probes: WakeProbeDto[];
}

interface InstallAudit {
  targetId: string;
  before: unknown;
  after: {
    path: string;
    scope: ClientEntryScope;
    client: ClientId;
    assetType: ClientEntryAsset;
    action: PlanAction['action'];
    contentHash: string;
    backupPath: string | null;
  };
}

/**
 * 设置 → 客户端入口的编排层。
 *
 * 文件层（installer）只管「计划 → 落盘 → 校验 → 卸载」，本层补三件事：
 * 1. 把台账行交给 installer 判断整文件归属，并负责安装后的 upsert；
 * 2. 台账/审计的一致性（unchanged 也刷新台账，安装/卸载各记一条审计）；
 * 3. installer 无法覆盖的边界：DB 写入失败时按本次写盘记录尽力还原文件。
 */
@Injectable()
export class ClientEntryService {
  constructor(
    private readonly repository: ClientEntryRepository,
    private readonly wakeProbe: WakeProbeService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly logger: AppLogger,
    private readonly prisma: PrismaService,
  ) {}

  /** 六端检测概览 + 台账 + 自测摘要；未选工作区时只展示用户级。 */
  async overview(workspace?: string): Promise<ClientEntryOverviewDto> {
    const requested = workspace?.trim() ?? '';
    const workspacePath = requested === '' ? null : resolveWorkspaceDir(requested);
    const env = resolveClientEnv();
    const allEntries = await this.repository.listAll();

    const clients = Object.values(CLIENT_ADAPTERS).map((adapter) => {
      // 工作区未选时不展示项目级落点：路径无从计算，展示出来只会是假矩阵。
      const visibleScopes =
        workspacePath === null
          ? adapter.scopes.filter((scope) => scope === 'user')
          : [...adapter.scopes];
      const candidates = listCandidates(adapter, visibleScopes, env, workspacePath);
      const targets = candidates.map(toTargetDto);
      const detected = {
        project:
          workspacePath !== null &&
          candidates.some(
            (candidate) =>
              candidate.scope === 'project' &&
              fs.existsSync(candidate.detectPath ?? candidate.path),
          ),
        user: candidates.some(
          (candidate) =>
            candidate.scope === 'user' &&
            fs.existsSync(candidate.detectPath ?? candidate.path),
        ),
      };

      const entries = allEntries
        .filter((entry) => entry.client === adapter.id)
        .filter(
          (entry) =>
            entry.scope === 'user' ||
            (workspacePath !== null && entry.workspacePath === workspacePath),
        )
        .map(toClientEntryDto);

      return {
        client: adapter.id,
        label: adapter.label,
        assets: [...adapter.assets],
        scopes: [...adapter.scopes],
        stability: { ...adapter.stability },
        notes: [...adapter.notes],
        detected,
        targets,
        entries,
        effectHint: {
          project: adapter.effectHint('project'),
          user: adapter.effectHint('user'),
        },
      } satisfies ClientDetectDto;
    });

    const [wakeMode, recent] = await Promise.all([
      this.settings.get('mcp_wake_mode'),
      this.wakeProbe.recent(),
    ]);

    return {
      clients,
      selfTest: {
        serverName: MCP_SERVER_NAME,
        mcpEndpoint: mcpEndpoint(),
        wakeMode,
        recent,
      },
    };
  }

  /** 预览只读：把当前 client+scope(+workspace) 的台账交给 installer 判断文件归属。 */
  async plan(input: ClientEntryPlanInput): Promise<ClientEntryPlanDto> {
    const workspacePath = resolveScopeWorkspace(input.scope, input.workspace);
    const existingEntries = await this.ledger(input.client, input.scope, workspacePath);
    const plan = await planInstall({
      client: input.client,
      scope: input.scope,
      workspace: workspacePath ?? undefined,
      assets: input.assets,
      existingEntries,
    });
    return {
      client: plan.client,
      scope: plan.scope,
      planHash: plan.planHash,
      actions: plan.actions,
      warnings: plan.warnings,
    };
  }

  async install(input: ClientEntryInstallInput): Promise<ClientEntryInstallResultDto> {
    const workspacePath = resolveScopeWorkspace(input.scope, input.workspace);
    const ledger = await this.ledger(input.client, input.scope, workspacePath);

    // installer 每写一条动作问一次 id；同一 targetPath 多次询问必须给同一个 id。
    const memo = new Map<string, string>();
    const entryIdFor = (targetPath: string): string => {
      const cached = memo.get(targetPath);
      if (cached !== undefined) return cached;
      const id = ledger.find((entry) => entry.targetPath === targetPath)?.id ?? uuidv7();
      memo.set(targetPath, id);
      return id;
    };

    const planInput: InstallPlanInput = {
      client: input.client,
      scope: input.scope,
      workspace: workspacePath ?? undefined,
      assets: input.assets,
      existingEntries: ledger,
    };
    const { actions, applied, plan } = await applyPlan({
      input: planInput,
      planHash: input.plan_hash,
      allowOverLimit: input.allow_over_limit,
      entryIdFor,
    });

    const now = new Date().toISOString();
    try {
      // 台账 upsert 与安装审计同一事务：任何一步失败都整体回滚，不留下
      // 「文件写了、台账/审计没有」的半状态；文件回滚仍在事务外做。
      await this.prisma.$transaction(async (tx) => {
        const audits: InstallAudit[] = [];
        for (const item of applied) {
          const action = item.plan;
          const old = ledger.find((entry) => entry.targetPath === action.targetPath);
          const record: ClientEntryRecord = {
            id: item.entryId,
            client: input.client,
            scope: input.scope,
            workspacePath: plan.workspacePath,
            assetType: action.assetType,
            assetName: action.assetName,
            targetPath: action.targetPath,
            writeMode: action.writeMode,
            contentHash: action.contentHash,
            fileHash: item.fileHash,
            templateVersion: item.templateVersion,
            marker: item.marker,
            createdFile: item.createdFile,
            backupPath: item.backupPath,
            status: 'installed',
            lastError: null,
            installedAt: old?.installedAt ?? now,
            verifiedAt: now,
            updatedAt: now,
          };
          // upsert 按业务唯一键命中时可能复用既有行的 id 而不是 record.id：
          // 审计必须指向真实落库的那一行，否则会出现悬空的 target_id。
          const saved = await this.repository.upsert(record, tx);
          audits.push({
            targetId: saved.id,
            before: old === undefined ? null : summarizeRecord(old),
            after: {
              path: action.targetPath,
              scope: input.scope,
              client: input.client,
              assetType: action.assetType,
              action: action.action,
              contentHash: action.contentHash,
              backupPath: item.backupPath,
            },
          });
        }

        // 计划说 unchanged 也要刷新台账：用户可能在预览后删掉了台账行，
        // 或模板版本/校验时间需要归位；文件本身不动，所以不写审计。
        for (const action of actions) {
          if (action.action !== 'unchanged') continue;
          const old = ledger.find((entry) => entry.targetPath === action.targetPath);
          let current: string | null;
          try {
            current = readFileIfExists(action.targetPath);
          } catch {
            current = null;
          }
          if (current === null) {
            throw new ApiException(
              'CLIENT_ENTRY_PLAN_STALE',
              '预览之后目标文件已变化，请重新预览后再安装',
              undefined,
              { path: action.targetPath },
            );
          }
          await this.repository.upsert(
            {
              id: old?.id ?? uuidv7(),
              client: input.client,
              scope: input.scope,
              workspacePath: plan.workspacePath,
              assetType: action.assetType,
              assetName: action.assetName,
              targetPath: action.targetPath,
              writeMode: action.writeMode,
              contentHash: action.contentHash,
              fileHash: sha256(current),
              templateVersion: CLIENT_ENTRY_TEMPLATE_VERSION,
              marker:
                old?.marker ??
                (action.writeMode === 'managed_block' ? CLIENT_ENTRY_MARKER_BEGIN : ''),
              createdFile: old?.createdFile ?? false,
              backupPath: old?.backupPath ?? null,
              status: 'installed',
              lastError: null,
              installedAt: old?.installedAt ?? now,
              verifiedAt: now,
              updatedAt: now,
            },
            tx,
          );
        }

        for (const audit of audits) {
          await this.audit.record(
            {
              actorType: 'user',
              action: 'client_entry_install',
              targetType: 'client_entry',
              targetId: audit.targetId,
              before: audit.before,
              after: audit.after,
            },
            tx,
          );
        }
      });
    } catch (error) {
      // installer 只回滚它自己的文件批次；一旦 DB 事务失败，service 按 applied 记录再还原一次。
      this.rollbackFiles(applied);
      throw error;
    }

    return {
      entries: (await this.ledger(input.client, input.scope, workspacePath)).map(
        toClientEntryDto,
      ),
      actions,
    };
  }

  async verify(input: ClientEntryVerifyInput): Promise<ClientEntryVerifyResultDto> {
    const requested = input.ids === undefined ? undefined : [...new Set(input.ids)];
    let records: ClientEntryRecord[];
    if (requested === undefined) {
      records = await this.repository.listAll();
    } else {
      records = await this.repository.findManyByIds(requested);
      const found = new Set(records.map((record) => record.id));
      const missing = requested.filter((id) => !found.has(id));
      if (missing.length > 0) {
        throw new ApiException(
          'CLIENT_ENTRY_NOT_FOUND',
          '部分客户端入口不存在，可能已被卸载',
          { missing },
          { ids: missing },
        );
      }
    }

    const now = new Date().toISOString();
    const summary: Record<ClientEntryStatus, number> = {
      installed: 0,
      drifted: 0,
      missing: 0,
      error: 0,
    };
    for (const record of records) {
      const result = await verifyEntry(record);
      await this.repository.updateVerification(record.id, {
        status: result.status,
        lastError: result.error ?? null,
        verifiedAt: now,
      });
      summary[result.status] += 1;
    }

    const latest =
      requested === undefined
        ? await this.repository.listAll()
        : await this.repository.findManyByIds(requested);
    return { entries: latest.map(toClientEntryDto), summary };
  }

  async uninstall(id: string): Promise<ClientEntryUninstallResultDto> {
    const record = await this.repository.findById(id);
    if (record === null) {
      throw new ApiException(
        'CLIENT_ENTRY_NOT_FOUND',
        `客户端入口 ${id} 不存在`,
        undefined,
        { id },
      );
    }

    const result = await uninstallEntry(record);
    if (!result.removed) {
      // 用户改过文件 / 托管标记不成对：台账保留并标 drifted，不记「卸载成功」审计。
      await this.repository.updateVerification(id, {
        status: 'drifted',
        lastError: null,
        verifiedAt: new Date().toISOString(),
      });
      const latest = await this.repository.findById(id);
      return {
        removed: false,
        kept: result.kept ?? 'drifted',
        ...(latest === null ? {} : { entry: toClientEntryDto(latest) }),
      };
    }

    // 台账删除与卸载审计同事务：避免删了台账却没有留痕（或相反）。
    await this.prisma.$transaction(async (tx) => {
      await this.repository.delete(id, tx);
      await this.audit.record(
        {
          actorType: 'user',
          action: 'client_entry_uninstall',
          targetType: 'client_entry',
          targetId: id,
          before: summarizeRecord(record),
          after: {
            removed: true,
            path: record.targetPath,
            scope: record.scope,
            // null = 删的是我们创建的文件；unmanaged = 保留了安装前已存在的用户文件。
            kept: result.kept ?? null,
          },
        },
        tx,
      );
    });
    return {
      removed: true,
      ...(result.kept === undefined ? {} : { kept: result.kept }),
    };
  }

  async selfTest(input: ClientEntrySelfTestQuery): Promise<ClientEntrySelfTestDto> {
    const [wakeMode, probes] = await Promise.all([
      this.settings.get('mcp_wake_mode'),
      this.wakeProbe.recent(20, input.since),
    ]);
    return {
      serverName: MCP_SERVER_NAME,
      mcpEndpoint: mcpEndpoint(),
      wakeMode,
      probes,
    };
  }

  private ledger(
    client: ClientId,
    scope: ClientEntryScope,
    workspacePath: string | null,
  ): Promise<ClientEntryRecord[]> {
    return this.repository.listFor({
      client,
      scope,
      workspacePath: scope === 'project' ? workspacePath : null,
    });
  }

  /** 安装成功后才写库，失败时按本次写盘记录逆序还原（备份优先，其次删掉新建文件）。 */
  private rollbackFiles(applied: AppliedAction[]): void {
    for (const item of [...applied].reverse()) {
      const targetPath = item.plan.targetPath;
      try {
        if (item.backupPath !== null) {
          restoreBackup(item.backupPath, targetPath);
        } else if (item.createdFile) {
          fs.unlinkSync(targetPath);
        }
      } catch (error) {
        this.logger.error(
          `客户端入口安装失败后还原文件失败：${targetPath}：${(error as Error).message}`,
          undefined,
          'client-entry',
        );
      }
    }
  }
}

function resolveScopeWorkspace(
  scope: ClientEntryScope,
  workspace: string | undefined,
): string | null {
  // project 缺工作区时 resolveWorkspaceDir 会抛 CLIENT_ENTRY_PATH_UNSAFE，不在这里吞掉。
  return scope === 'project' ? resolveWorkspaceDir(workspace ?? '') : null;
}

function mcpEndpoint(): string {
  return `http://127.0.0.1:${port()}/mcp`;
}

function listCandidates(
  adapter: ClientAdapter,
  scopes: readonly ClientEntryScope[],
  env: ClientEnv,
  workspacePath: string | null,
): TargetCandidate[] {
  const candidates: TargetCandidate[] = [];
  for (const scope of scopes) {
    for (const asset of adapter.assets) {
      const produced = adapter.targets({
        asset,
        scope,
        env,
        workspace: workspacePath ?? undefined,
      });
      for (const candidate of produced) {
        if (typeof candidate.path !== 'string' || candidate.path === '') continue;
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}

function toTargetDto(candidate: TargetCandidate): ClientTargetDto {
  return {
    scope: candidate.scope,
    asset: candidate.asset,
    path: candidate.path,
    writeMode: candidate.writeMode,
    confidence: candidate.confidence,
    exists: fs.existsSync(candidate.path),
    ...(candidate.note === undefined ? {} : { note: candidate.note }),
  };
}

function toClientEntryDto(record: ClientEntryRecord): ClientEntryDto {
  return {
    id: record.id,
    client: record.client,
    scope: record.scope,
    workspacePath: record.workspacePath,
    assetType: record.assetType,
    assetName: record.assetName,
    targetPath: record.targetPath,
    writeMode: record.writeMode,
    status: record.status,
    templateVersion: record.templateVersion,
    installedAt: record.installedAt,
    verifiedAt: record.verifiedAt,
    lastError: record.lastError,
    updateAvailable: record.templateVersion < CLIENT_ENTRY_TEMPLATE_VERSION,
  };
}

/** 审计 before 只放可排障的字段：路径、哈希、状态；不放文件正文，也不放任何 token。 */
function summarizeRecord(record: ClientEntryRecord): Record<string, unknown> {
  return {
    path: record.targetPath,
    scope: record.scope,
    client: record.client,
    assetType: record.assetType,
    assetName: record.assetName,
    writeMode: record.writeMode,
    status: record.status,
    contentHash: record.contentHash,
    fileHash: record.fileHash,
    templateVersion: record.templateVersion,
  };
}
