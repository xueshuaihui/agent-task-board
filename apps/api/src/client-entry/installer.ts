import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import {
  CLIENT_ENTRY_MARKER_BEGIN,
  CLIENT_ENTRY_TEMPLATE_VERSION,
  CUSTOM_CLIENT_EFFECT_HINT,
  CUSTOM_CLIENT_ID,
  CUSTOM_CLIENT_LABEL,
  type ClientEntryAsset,
  type ClientEntryClientId,
  type ClientEntryScope,
  type ClientEntryStatus,
  type ClientId,
} from '../contract/client-entry';
import { ApiException } from '../contract/errors';
import { MCP_SERVER_NAME } from '../mcp/wake';
import { getAdapter, type TargetCandidate } from './adapters';
import {
  backupFile,
  ClientEntryFileLockedError,
  ClientEntryWriteFailedError,
  readFileIfExists,
  restoreBackup,
  sha256,
  writeFileAtomic,
} from './atomic-write';
import { resolveClientEnv, type ClientEnv } from './client-env';
import { mergeManagedBlock, readManagedBlock, stripManagedBlock } from './managed-block';
import { assertSafeTarget, resolveInstallRoot, resolveWorkspaceDir } from './paths';
import { renderRule, renderSkill, type RenderedAsset } from './templates';

/**
 * 客户端入口的文件层：只做「计划 → 落盘 → 校验 → 卸载」。
 *
 * 三条边界：
 * 1. 不碰 Prisma/HTTP——台账（StoredEntry）由 service 传入，entry id 由 service 生成；
 * 2. 所有写盘前都重新 assertSafeTarget，绝不绕开 paths.ts 的软链/越界检查；
 * 3. 预览（planInstall）只读不写；写盘只发生在 applyPlan，且每一步都可回滚。
 *
 * `custom` 伪客户端在这里分流：它没有 adapter，planCustomInstall 直接按 target_dir
 * 合成落点，逐资产走与六端完全相同的校验/判定逻辑（见 planFileAction）。
 */

export interface StoredEntry {
  id: string;
  client: ClientEntryClientId;
  scope: ClientEntryScope;
  workspacePath: string | null;
  assetType: ClientEntryAsset;
  assetName: string;
  targetPath: string;
  writeMode: 'file' | 'managed_block';
  contentHash: string;
  fileHash: string;
  templateVersion: number;
  createdFile: boolean;
  marker: string;
}

export interface InstallPlanInput {
  client: ClientEntryClientId;
  scope: ClientEntryScope;
  workspace?: string;
  /** 仅 `custom` 使用：安装根（客户端会读取的规则目录），允许尚不存在。 */
  target_dir?: string;
  /** 显式 `[]` = 什么都不装；缺省时按 adapter 支持的资产全装。 */
  assets?: ClientEntryAsset[];
  /** 缺省 `resolveClientEnv()`：测试可换成临时 home，不碰真机目录。 */
  env?: ClientEnv;
  /** 台账行：整文件模式靠它判断「这个文件是不是我们写的」。 */
  existingEntries?: StoredEntry[];
}

export type PlanActionName = 'create' | 'update' | 'unchanged' | 'conflict';

export interface PlanAction {
  assetType: ClientEntryAsset;
  /** 固定为 MCP_SERVER_NAME（`jarvis-workbench`）。 */
  assetName: string;
  targetPath: string;
  writeMode: 'file' | 'managed_block';
  action: PlanActionName;
  reason?: string;
  /** 预览内容：file=整份文件；managed_block=块内正文（不含 marker）。 */
  content: string;
  contentChars: number;
  contentHash: string;
  expectedPrevHash: string | null;
  backupRequired: boolean;
  warnings: string[];
  charLimit?: number;
  /**
   * 写入后整份文件的字符数（托管块模式含块外用户内容），仅当客户端声明 charLimit 时提供。
   * `contentChars` 始终只是本应用内容的长度，二者不能互相替代。
   */
  limitChars?: number;
  confidence: 'confirmed' | 'probable';
  effectHint: string;
}

export interface InstallPlan {
  client: ClientEntryClientId;
  scope: ClientEntryScope;
  workspacePath: string | null;
  planHash: string;
  actions: PlanAction[];
  warnings: string[];
}

export interface AppliedAction {
  plan: PlanAction;
  entryId: string;
  fileHash: string;
  createdFile: boolean;
  backupPath: string | null;
  templateVersion: number;
  marker: string;
}

const ASSET_LABEL: Record<ClientEntryAsset, string> = {
  rule: '入口规则',
  skill: '技能',
};

/** plan 阶段读文件；读不了就是 IO 失败，不把正文带进错误里。 */
function readForPlan(targetPath: string): string | null {
  try {
    return readFileIfExists(targetPath);
  } catch (error) {
    throw new ApiException(
      'CLIENT_ENTRY_WRITE_FAILED',
      '读取客户端入口文件失败，请检查文件权限后重试',
      undefined,
      { path: targetPath, reason: shortError(error) },
    );
  }
}

/** 错误上下文只放 errno/简短消息，绝不放文件正文。 */
function shortError(error: unknown): string {
  if (!error || typeof error !== 'object') return 'UNKNOWN';
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === 'string' && code !== '') return code;
  const name = (error as Error).name;
  const message = (error as Error).message;
  if (typeof message === 'string' && message !== '') {
    return `${name}: ${message.slice(0, 120)}`;
  }
  return name || 'UNKNOWN';
}

/** 沿用 adapter 的资产顺序；显式清单去重但保持用户给定顺序。 */
function resolveAssets(
  client: ClientEntryClientId,
  label: string,
  sources: readonly ClientEntryAsset[],
  requested: ClientEntryAsset[] | undefined,
  scope: ClientEntryScope,
): ClientEntryAsset[] {
  const wanted = requested === undefined ? [...sources] : [...new Set(requested)];
  for (const asset of wanted) {
    if (!sources.includes(asset)) {
      throw new ApiException(
        'CLIENT_ENTRY_UNSUPPORTED',
        `${label} 不支持${ASSET_LABEL[asset]}资产`,
        undefined,
        { client, scope, asset },
      );
    }
  }
  return wanted;
}

function isExistingFile(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isFile();
  } catch {
    return false;
  }
}

/**
 * 同一资产可能有多个落点（例如 Codex 的两个技能根）。优先已存在的文件，
 * 其次第一个允许新建的候选，最后退回第一个——预览与安装必须选中同一格。
 */
function pickCandidate(candidates: TargetCandidate[]): TargetCandidate | undefined {
  if (candidates.length === 0) return undefined;
  const existing = candidates.find((candidate) => isExistingFile(candidate.path));
  if (existing) return existing;
  return candidates.find((candidate) => candidate.createDefault) ?? candidates[0];
}

function renderContent(
  client: ClientEntryClientId,
  asset: ClientEntryAsset,
  writeMode: 'file' | 'managed_block',
): string {
  // 技能只有 rule 之外的四个端支持；adapter.assets 已在上游挡掉不支持的组合。
  const rendered: RenderedAsset = asset === 'rule' ? renderRule(client) : renderSkill(client);
  if (writeMode === 'file') {
    const prefix = rendered.frontmatter === undefined ? '' : `${rendered.frontmatter}\n\n`;
    return `${prefix}${rendered.body}\n`;
  }
  // 托管块只承载正文：frontmatter 属于「整份文件」的格式（如 Windsurf 的
  // `.windsurf/rules/*.md`），塞进 global_rules.md 的块里只会变成可见文本。
  return rendered.body.replace(/\r\n/g, '\n');
}

interface Judgement {
  action: PlanActionName;
  reason?: string;
  expectedPrevHash: string | null;
  backupRequired: boolean;
}

function judgeManaged(existing: string | null, contentHash: string): Judgement {
  if (existing === null) {
    return { action: 'create', expectedPrevHash: null, backupRequired: false };
  }
  const read = readManagedBlock(existing);
  if (read.kind === 'absent') {
    // 追加托管块，不覆盖用户内容；仍需备份，便于撤销。
    return { action: 'create', expectedPrevHash: null, backupRequired: true };
  }
  if (read.kind === 'unpaired') {
    return {
      action: 'conflict',
      reason: 'managed_markers_unpaired',
      expectedPrevHash: sha256(existing),
      backupRequired: false,
    };
  }
  const existingHash = sha256(read.body);
  if (existingHash === contentHash) {
    return { action: 'unchanged', expectedPrevHash: existingHash, backupRequired: false };
  }
  return { action: 'update', expectedPrevHash: existingHash, backupRequired: true };
}

/**
 * 托管块写入后的整份文件长度。块外用户内容同样占客户端的字符额度；
 * 标记不成对时已经判 conflict，退回本应用正文长度即可。
 */
function mergedChars(existing: string | null, content: string): number {
  const merged = mergeManagedBlock(existing ?? '', content);
  return merged.kind === 'unpaired' ? content.length : merged.text.length;
}

function judgeFile(
  existing: string | null,
  contentHash: string,
  ledger: StoredEntry | undefined,
): Judgement {
  if (existing === null) {
    return { action: 'create', expectedPrevHash: null, backupRequired: false };
  }
  const currentHash = sha256(existing);
  if (ledger !== undefined) {
    if (currentHash !== ledger.fileHash) {
      // 安装后被用户改过：哪怕内容恰好等于新模板，也交回用户决定。
      return {
        action: 'conflict',
        reason: 'file_modified_since_install',
        expectedPrevHash: currentHash,
        backupRequired: false,
      };
    }
    if (currentHash === contentHash) {
      return { action: 'unchanged', expectedPrevHash: currentHash, backupRequired: false };
    }
    return { action: 'update', expectedPrevHash: currentHash, backupRequired: true };
  }
  if (currentHash === contentHash) {
    // 台账丢了但内容一致：我们的文件（或用户自己写了一模一样的），安全接管。
    return { action: 'unchanged', expectedPrevHash: currentHash, backupRequired: false };
  }
  // 无主文件绝不覆盖。
  return {
    action: 'conflict',
    reason: 'file_exists_unmanaged',
    expectedPrevHash: currentHash,
    backupRequired: false,
  };
}

function findLedgerEntry(
  entries: StoredEntry[] | undefined,
  targetPath: string,
): StoredEntry | undefined {
  return entries?.find(
    (entry) => entry.writeMode === 'file' && entry.targetPath === targetPath,
  );
}

function computePlanHash(actions: PlanAction[]): string {
  return sha256(
    JSON.stringify(
      actions.map((action) => [
        action.targetPath,
        action.writeMode,
        action.contentHash,
        action.expectedPrevHash,
        action.action,
      ]),
    ),
  );
}

/**
 * 单个落点的预览：校验 → 读现状 → 渲染 → 判定 → 上限与警告。
 * 六端（adapter 产出的固定落点）与 custom（target_dir 合成落点）共用，行为一字不差。
 */
function planTargetAction(args: {
  client: ClientEntryClientId;
  asset: ClientEntryAsset;
  target: Pick<TargetCandidate, 'path' | 'writeMode' | 'confidence' | 'charLimit' | 'note'>;
  allowedRoot: string;
  stability: 'stable' | 'experimental';
  effectHint: string;
  existingEntries?: StoredEntry[];
}): PlanAction {
  const { asset, target } = args;

  // 预览也校验：路径不安全的落点必须在看到内容前就报错。
  assertSafeTarget(target.path, args.allowedRoot);
  const existing = readForPlan(target.path);
  const content = renderContent(args.client, asset, target.writeMode);
  const contentHash = sha256(content);
  const judgement =
    target.writeMode === 'file'
      ? judgeFile(existing, contentHash, findLedgerEntry(args.existingEntries, target.path))
      : judgeManaged(existing, contentHash);

  const actionWarnings: string[] = [];
  if (target.note !== undefined) actionWarnings.push(target.note);
  if (args.stability === 'experimental') {
    actionWarnings.push('该落点为实验性支持，客户端版本可能不支持');
  }
  // 上限按「写入后整份文件」算：Windsurf 用户级写的是共享的 global_rules.md，
  // 块外用户内容同样占额度，只量本应用正文会漏报。
  const limitChars =
    target.charLimit === undefined
      ? undefined
      : target.writeMode === 'file'
        ? content.length
        : mergedChars(existing, content);
  if (
    target.charLimit !== undefined &&
    limitChars !== undefined &&
    limitChars > target.charLimit
  ) {
    actionWarnings.push(
      `超过客户端 ${target.charLimit} 字上限（写入后 ${limitChars} 字，其中本应用内容 ${content.length} 字），安装需显式确认`,
    );
  }

  return {
    assetType: asset,
    assetName: MCP_SERVER_NAME,
    targetPath: target.path,
    writeMode: target.writeMode,
    action: judgement.action,
    ...(judgement.reason === undefined ? {} : { reason: judgement.reason }),
    content,
    contentChars: content.length,
    contentHash,
    expectedPrevHash: judgement.expectedPrevHash,
    backupRequired: judgement.backupRequired,
    warnings: actionWarnings,
    ...(target.charLimit === undefined ? {} : { charLimit: target.charLimit }),
    ...(limitChars === undefined ? {} : { limitChars }),
    confidence: target.confidence,
    effectHint: args.effectHint,
  };
}

export async function planInstall(input: InstallPlanInput): Promise<InstallPlan> {
  // custom 伪客户端没有 adapter：到 getAdapter 之前就分流（getAdapter 传 'custom' 仍抛错）。
  if (input.client === CUSTOM_CLIENT_ID) return planCustomInstall(input);

  const adapter = getAdapter(input.client);
  if (!adapter.scopes.includes(input.scope)) {
    throw new ApiException(
      'CLIENT_ENTRY_UNSUPPORTED',
      `${adapter.label} 不支持${input.scope === 'project' ? '项目级' : '用户级'}安装`,
      undefined,
      { client: input.client, scope: input.scope },
    );
  }

  const env = input.env ?? resolveClientEnv();
  const assets = resolveAssets(
    input.client,
    adapter.label,
    adapter.assets,
    input.assets,
    input.scope,
  );

  let workspacePath: string | null = null;
  let allowedRoot: string;
  if (input.scope === 'project') {
    workspacePath = resolveWorkspaceDir(input.workspace ?? '');
    allowedRoot = workspacePath;
  } else {
    allowedRoot = env.home;
  }

  const warnings: string[] = [];
  if (input.assets !== undefined && input.assets.length === 0) {
    warnings.push('未选择任何资产');
  }

  const actions: PlanAction[] = [];
  for (const asset of assets) {
    const candidates = adapter.targets({
      asset,
      scope: input.scope,
      env,
      workspace: workspacePath ?? undefined,
    });
    const candidate = pickCandidate(candidates);
    if (candidate === undefined) {
      warnings.push(`客户端没有为「${ASSET_LABEL[asset]}」提供可用落点`);
      continue;
    }

    actions.push(
      planTargetAction({
        client: input.client,
        asset,
        target: candidate,
        allowedRoot,
        stability: adapter.stability[asset],
        effectHint: adapter.effectHint(input.scope),
        existingEntries: input.existingEntries,
      }),
    );
  }

  return {
    client: input.client,
    scope: input.scope,
    workspacePath,
    planHash: computePlanHash(actions),
    actions,
    warnings,
  };
}

/**
 * custom 的计划：没有固定落点，scope 恒为 project（台账 CHECK 的
 * `scope='project' AND workspace_path IS NOT NULL` 由 target_dir 兑现），
 * 落点按资产合成——rule 写所选目录下的 jarvis-workbench.md（无 frontmatter 的
 * 通用 Markdown），skill 写 jarvis-workbench/SKILL.md。
 */
function planCustomInstall(input: InstallPlanInput): InstallPlan {
  if (input.scope !== 'project') {
    throw new ApiException(
      'CLIENT_ENTRY_UNSUPPORTED',
      `${CUSTOM_CLIENT_LABEL}只支持项目级安装`,
      undefined,
      { client: input.client, scope: input.scope },
    );
  }

  const workspacePath = resolveInstallRoot(input.target_dir ?? '');
  const assets = resolveAssets(
    input.client,
    CUSTOM_CLIENT_LABEL,
    ['rule', 'skill'],
    input.assets,
    input.scope,
  );

  const warnings: string[] = [];
  if (input.assets !== undefined && input.assets.length === 0) {
    warnings.push('未选择任何资产');
  }

  const actions = assets.map((asset) =>
    planTargetAction({
      client: input.client,
      asset,
      // 目录由用户显式选定，落点虽无客户端文档背书，预览仍按 confirmed 给出。
      target: {
        path:
          asset === 'rule'
            ? path.join(workspacePath, `${MCP_SERVER_NAME}.md`)
            : path.join(workspacePath, MCP_SERVER_NAME, 'SKILL.md'),
        writeMode: 'file',
        confidence: 'confirmed',
      },
      allowedRoot: workspacePath,
      // 兜底形态按实验性支持提示：预览警告「该落点为实验性支持」自动出现。
      stability: 'experimental',
      effectHint: CUSTOM_CLIENT_EFFECT_HINT,
      existingEntries: input.existingEntries,
    }),
  );

  return {
    client: input.client,
    scope: input.scope,
    workspacePath,
    planHash: computePlanHash(actions),
    actions,
    warnings,
  };
}

/**
 * 进程内按 targetPath 串行：同一文件的多条动作（以及并发 install 的写入）不会交错，
 * 后到者在拿到锁之后才读现状、落盘；锁只覆盖写入本身，预览仍是只读的。
 */
const targetLocks = new Map<string, Promise<unknown>>();

async function withTargetLock<T>(targetPath: string, task: () => Promise<T>): Promise<T> {
  const previous = targetLocks.get(targetPath) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  targetLocks.set(targetPath, run);
  try {
    return await run;
  } finally {
    if (targetLocks.get(targetPath) === run) targetLocks.delete(targetPath);
  }
}

interface WrittenRecord {
  targetPath: string;
  backupPath: string | null;
  createdFile: boolean;
}

/** 回滚是尽力而为：失败不能让原始错误被掩盖。 */
async function rollbackWrite(record: WrittenRecord): Promise<void> {
  try {
    if (record.backupPath !== null) {
      restoreBackup(record.backupPath, record.targetPath);
      return;
    }
    if (record.createdFile) {
      await fsp.unlink(record.targetPath).catch(() => undefined);
    }
  } catch {
    // 已尽力：保留现场比抛二次错误更有用。
  }
}

function mapWriteError(error: unknown, targetPath: string | null): ApiException {
  if (error instanceof ApiException) return error;
  const context: Record<string, unknown> = targetPath === null ? {} : { path: targetPath };
  if (error instanceof ClientEntryFileLockedError) {
    return new ApiException(
      'CLIENT_ENTRY_FILE_LOCKED',
      '目标文件正被其它程序占用，请关闭对应客户端或编辑器后重试',
      undefined,
      context,
    );
  }
  if (error instanceof ClientEntryWriteFailedError) {
    return new ApiException(
      'CLIENT_ENTRY_WRITE_FAILED',
      '写入客户端入口文件失败，请检查文件权限后重试',
      undefined,
      { ...context, reason: shortError(error) },
    );
  }
  return new ApiException(
    'CLIENT_ENTRY_WRITE_FAILED',
    '写入客户端入口文件失败',
    undefined,
    { ...context, reason: shortError(error) },
  );
}

function planStaleError(targetPath: string): ApiException {
  return new ApiException(
    'CLIENT_ENTRY_PLAN_STALE',
    '预览之后目标文件已变化，请重新预览后再安装',
    undefined,
    { path: targetPath },
  );
}

function unpairedMarkersError(targetPath: string): ApiException {
  return new ApiException(
    'CLIENT_ENTRY_CONFLICT',
    '托管标记不成对，拒绝写入',
    undefined,
    { path: targetPath, reason: 'managed_markers_unpaired' },
  );
}

/**
 * 拿到锁、重读目标之后复核计划预期：预览与写盘之间文件可能被别的进程改写。
 * applyPlan 开头的 planHash 只能证明「重新计划的结论没变」，不能证明落盘这一刻
 * 还是预览时那份文件，所以这里按 expectedPrevHash 再验一次（纵深防御）。
 */
function assertExpectedState(action: PlanAction, existing: string | null): void {
  if (action.writeMode === 'file') {
    const current =
      action.expectedPrevHash === null
        ? existing === null
        : existing !== null && sha256(existing) === action.expectedPrevHash;
    if (!current) throw planStaleError(action.targetPath);
    return;
  }

  const block = readManagedBlock(existing ?? '');
  if (action.expectedPrevHash === null) {
    // null = 预览时文件不存在或尚无托管块：此刻仍没有我们的块才允许追加。
    if (block.kind === 'absent') return;
    if (block.kind === 'unpaired') throw unpairedMarkersError(action.targetPath);
    throw planStaleError(action.targetPath);
  }
  if (block.kind === 'unpaired') throw unpairedMarkersError(action.targetPath);
  if (block.kind !== 'found' || sha256(block.body) !== action.expectedPrevHash) {
    throw planStaleError(action.targetPath);
  }
}

async function writeAction(
  action: PlanAction,
  allowedRoot: string,
  entryIdFor: (targetPath: string) => string,
): Promise<AppliedAction> {
  // 计划与写盘之间文件可能被替换成软链，这里再拦一次。
  assertSafeTarget(action.targetPath, allowedRoot);
  const entryId = entryIdFor(action.targetPath);
  const existing = readFileIfExists(action.targetPath);
  assertExpectedState(action, existing);
  const createdFile = existing === null;
  let backupPath: string | null = null;
  if (existing !== null && action.backupRequired) {
    backupPath = backupFile(action.targetPath, entryId);
  }

  let nextText: string;
  if (action.writeMode === 'file') {
    nextText = action.content;
  } else {
    const merged = mergeManagedBlock(existing ?? '', action.content);
    if (merged.kind === 'unpaired') {
      throw new ApiException(
        'CLIENT_ENTRY_CONFLICT',
        '托管标记不成对，拒绝写入',
        undefined,
        { path: action.targetPath, reason: 'managed_markers_unpaired' },
      );
    }
    nextText = merged.text;
  }

  await writeFileAtomic(action.targetPath, nextText);

  let readBack: string | null = null;
  try {
    readBack = readFileIfExists(action.targetPath);
  } catch {
    readBack = null;
  }
  const verified =
    readBack !== null &&
    (action.writeMode === 'file'
      ? sha256(readBack) === action.contentHash
      : (() => {
          const block = readManagedBlock(readBack as string);
          return block.kind === 'found' && block.body === action.content;
        })());

  if (!verified) {
    await rollbackWrite({ targetPath: action.targetPath, backupPath, createdFile });
    throw new ApiException(
      'CLIENT_ENTRY_WRITE_FAILED',
      '写入后回读校验失败，已尽力还原原文件',
      undefined,
      { path: action.targetPath },
    );
  }

  return {
    plan: action,
    entryId,
    fileHash: sha256(readBack as string),
    createdFile,
    backupPath,
    templateVersion: CLIENT_ENTRY_TEMPLATE_VERSION,
    marker: action.writeMode === 'managed_block' ? CLIENT_ENTRY_MARKER_BEGIN : '',
  };
}

export async function applyPlan(args: {
  input: InstallPlanInput;
  planHash: string;
  allowOverLimit?: boolean;
  /** service 提供：台账已有 id 或 uuidv7()。 */
  entryIdFor: (targetPath: string) => string;
}): Promise<{ actions: PlanAction[]; applied: AppliedAction[]; plan: InstallPlan }> {
  const plan = await planInstall(args.input);
  if (plan.planHash !== args.planHash) {
    throw new ApiException(
      'CLIENT_ENTRY_PLAN_STALE',
      '预览之后目标文件已变化，请重新预览后再安装',
      { expected: args.planHash, actual: plan.planHash },
      { client: plan.client, scope: plan.scope },
    );
  }

  const conflicts = plan.actions.filter((action) => action.action === 'conflict');
  if (conflicts.length > 0) {
    // 防御：预览结果里带 conflict 时绝不落任何盘。
    throw new ApiException(
      'CLIENT_ENTRY_CONFLICT',
      '目标位置已有非本应用创建的内容，或托管标记不成对',
      conflicts.map((action) => ({ target: action.targetPath, reason: action.reason })),
      { client: plan.client, scope: plan.scope },
    );
  }

  const over = overLimitActions(plan.actions);
  if (over.length > 0 && args.allowOverLimit !== true) {
    throw new ApiException(
      'CLIENT_ENTRY_LIMIT_EXCEEDED',
      '内容超过客户端字符上限，需显式确认后才能安装',
      over.map((action) => ({
        target: action.targetPath,
        chars: action.limitChars ?? action.contentChars,
        limit: action.charLimit,
      })),
      { client: plan.client, scope: plan.scope },
    );
  }

  const env = args.input.env ?? resolveClientEnv();
  const allowedRoot = plan.workspacePath ?? env.home;

  const applied: AppliedAction[] = [];
  const written: WrittenRecord[] = [];
  let currentPath: string | null = null;

  try {
    for (const action of plan.actions) {
      if (action.action !== 'create' && action.action !== 'update') continue;
      currentPath = action.targetPath;
      const result = await withTargetLock(action.targetPath, () =>
        writeAction(action, allowedRoot, args.entryIdFor),
      );
      applied.push(result);
      written.push({
        targetPath: action.targetPath,
        backupPath: result.backupPath,
        createdFile: result.createdFile,
      });
    }
  } catch (error) {
    // 多动作中后续失败：把本批次已写的按逆序回滚，再抛出原始错误。
    for (const record of [...written].reverse()) await rollbackWrite(record);
    throw mapWriteError(error, currentPath);
  }

  return { actions: plan.actions, applied, plan };
}

/**
 * 只读校验：不写文件，也不因为目标被替换成软链就拒绝整批校验——读不到就报 error。
 * `env` 预留给 service 显式传入测试 home；当前判定只依赖台账里的绝对 targetPath。
 */
export async function verifyEntry(
  entry: StoredEntry,
  env?: ClientEnv,
): Promise<{ status: ClientEntryStatus; fileHash?: string; error?: string }> {
  void env;
  let existing: string | null;
  try {
    existing = readFileIfExists(entry.targetPath);
  } catch (error) {
    return { status: 'error', error: shortError(error) };
  }
  if (existing === null) return { status: 'missing' };

  const fileHash = sha256(existing);
  if (entry.writeMode === 'file') {
    return { status: fileHash === entry.fileHash ? 'installed' : 'drifted', fileHash };
  }

  const block = readManagedBlock(existing);
  if (block.kind === 'absent') return { status: 'missing', fileHash };
  if (block.kind === 'unpaired') return { status: 'drifted', fileHash };
  // 块外用户改动不算 drift：只看块内正文是否与安装时的 content_hash 一致。
  return {
    status: sha256(block.body) === entry.contentHash ? 'installed' : 'drifted',
    fileHash,
  };
}

/** 技能卸载后尽力清掉只属于我们的空目录；非空/不存在/无权限一律忽略。 */
async function removeSkillDirIfEmpty(targetPath: string): Promise<void> {
  const dir = path.dirname(targetPath);
  if (path.basename(dir) !== MCP_SERVER_NAME) return;
  try {
    await fsp.rmdir(dir);
  } catch {
    // ENOTEMPTY 说明里面还有用户文件；ENOENT/EPERM 同理不删除用户目录。
  }
}

export async function uninstallEntry(
  entry: StoredEntry,
  env?: ClientEnv,
): Promise<{ removed: boolean; kept?: 'drifted' | 'missing' | 'unmanaged' }> {
  const resolvedEnv = env ?? resolveClientEnv();
  const allowedRoot = entry.scope === 'project' ? entry.workspacePath : resolvedEnv.home;
  if (allowedRoot === null || allowedRoot === '') {
    throw new ApiException(
      'CLIENT_ENTRY_PATH_UNSAFE',
      '项目级入口缺少工作区路径，无法安全卸载',
      undefined,
      { path: entry.targetPath, reason: 'workspace_missing' },
    );
  }
  assertSafeTarget(entry.targetPath, allowedRoot);

  let existing: string | null;
  try {
    existing = readFileIfExists(entry.targetPath);
  } catch (error) {
    throw mapWriteError(error, entry.targetPath);
  }
  if (existing === null) return { removed: true };

  if (entry.writeMode === 'file') {
    if (sha256(existing) !== entry.fileHash) {
      // 用户改过：绝不替用户决定删不删。
      return { removed: false, kept: 'drifted' };
    }
    if (!entry.createdFile) {
      // 安装前就存在、内容相同被接管的文件：台账可以清，文件不归我们删。
      return { removed: true, kept: 'unmanaged' };
    }
    try {
      await fsp.unlink(entry.targetPath);
    } catch (error) {
      throw mapWriteError(error, entry.targetPath);
    }
    if (entry.assetType === 'skill') await removeSkillDirIfEmpty(entry.targetPath);
    return { removed: true };
  }

  const block = readManagedBlock(existing);
  if (block.kind === 'unpaired') return { removed: false, kept: 'drifted' };
  if (block.kind === 'absent') return { removed: true };
  if (sha256(block.body) !== entry.contentHash) {
    // 用户改过托管块内容：不替他决定，文件一个字节都不动。
    return { removed: false, kept: 'drifted' };
  }

  const stripped = stripManagedBlock(existing);
  if (stripped.kind === 'unpaired') return { removed: false, kept: 'drifted' };

  if (stripped.text === '' && entry.createdFile) {
    try {
      await fsp.unlink(entry.targetPath);
    } catch (error) {
      throw mapWriteError(error, entry.targetPath);
    }
    return { removed: true };
  }

  try {
    await writeFileAtomic(entry.targetPath, stripped.text);
  } catch (error) {
    throw mapWriteError(error, entry.targetPath);
  }
  return { removed: true };
}

/** Windsurf 全局规则等客户端的字符上限预检：安装前 service 用它决定是否要求显式确认。 */
export function overLimitActions(actions: PlanAction[]): PlanAction[] {
  return actions.filter(
    (action) =>
      action.charLimit !== undefined &&
      action.limitChars !== undefined &&
      action.limitChars > action.charLimit,
  );
}
