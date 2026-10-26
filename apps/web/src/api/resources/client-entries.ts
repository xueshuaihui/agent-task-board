import { http } from '../client';
import { CLIENT_ENTRY_STATUSES } from '../types';
import type {
  ClientDetectResult,
  ClientEntry,
  ClientEntryAsset,
  ClientEntryClientId,
  ClientEntryInstallInput,
  ClientEntryInstallResult,
  ClientEntryOverview,
  ClientEntryPlan,
  ClientEntryPlanAction,
  ClientEntryPlanInput,
  ClientEntryScope,
  ClientEntrySelfTest,
  ClientEntryStatus,
  ClientEntryUninstallResult,
  ClientEntryVerifyResult,
  ClientTarget,
  WakeProbe,
} from '../types';

/**
 * 设置 → 客户端入口（v0.0.4 W9）的 REST 面：
 *   GET  /client-entries?workspace=     六端 + custom 合成卡概览 + 台账 + 自测摘要
 *   POST /client-entries/plan           预览（不写盘）
 *   POST /client-entries/install        按 plan_hash 落盘（confirm: true）
 *   POST /client-entries/verify         重读台账文件
 *   POST /client-entries/:id/uninstall  只删本应用写入的内容
 *   GET  /client-entries/self-test?since=
 *
 * 服务端契约（`apps/api/src/contract/client-entry.ts`）的请求体是 snake_case，台账行也直出
 * snake_case 列；这里统一映射成 `types.ts` 的 camelCase，UI 不会同时见到两种命名。
 */

type RawObject = Record<string, unknown>;

function obj(value: unknown): RawObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as RawObject)
    : {};
}

function list(value: unknown): RawObject[] {
  return Array.isArray(value) ? value.map(obj) : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function flag(value: unknown): boolean {
  return value === true;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** 同一语义字段优先取 camelCase（新接口），回落到 snake_case（台账列直出）。 */
function field(raw: RawObject, ...keys: string[]): unknown {
  for (const key of keys) {
    if (raw[key] !== undefined && raw[key] !== null) return raw[key];
  }
  return undefined;
}

function mapWakeProbe(raw: RawObject): WakeProbe {
  return {
    id: text(raw.id),
    source: textOrNull(raw.source),
    tokenName: textOrNull(field(raw, 'tokenName', 'token_name')),
    receivedAt: text(field(raw, 'receivedAt', 'received_at')),
  };
}

function mapClientEntry(raw: RawObject): ClientEntry {
  return {
    id: text(raw.id),
    client: text(raw.client) as ClientEntryClientId,
    scope: text(raw.scope) as ClientEntryScope,
    workspacePath: textOrNull(field(raw, 'workspacePath', 'workspace_path')),
    assetType: text(field(raw, 'assetType', 'asset_type')) as ClientEntryAsset,
    assetName: text(field(raw, 'assetName', 'asset_name')),
    targetPath: text(field(raw, 'targetPath', 'target_path')),
    writeMode: text(field(raw, 'writeMode', 'write_mode')) as ClientEntry['writeMode'],
    status: text(raw.status) as ClientEntryStatus,
    templateVersion: count(field(raw, 'templateVersion', 'template_version')),
    installedAt: text(field(raw, 'installedAt', 'installed_at')),
    verifiedAt: textOrNull(field(raw, 'verifiedAt', 'verified_at')),
    lastError: textOrNull(field(raw, 'lastError', 'last_error')),
    updateAvailable: flag(field(raw, 'updateAvailable', 'update_available')),
  };
}

function mapClientTarget(raw: RawObject): ClientTarget {
  const note = text(field(raw, 'note', 'reason'));
  return {
    scope: text(raw.scope) as ClientEntryScope,
    // 计划 §1.3 的 targets 是路径矩阵、只带 scope/path；asset 缺失时按 rule 处理。
    asset: (text(field(raw, 'asset', 'assetType', 'asset_type')) || 'rule') as ClientEntryAsset,
    path: text(field(raw, 'path', 'targetPath', 'target_path')),
    writeMode: text(field(raw, 'writeMode', 'write_mode')) as ClientTarget['writeMode'],
    confidence: text(raw.confidence) === 'probable' ? 'probable' : 'confirmed',
    exists: flag(raw.exists),
    ...(note ? { note } : {}),
  };
}

/**
 * 计划 §1.3 的 GET 只给客户端级 `stability: 'stable' | 'experimental'`，
 * 而 UI 要按资产类型显示徽章；两种形状都吃：对象按资产取，字符串则两类同值。
 */
function mapStability(value: unknown): Record<ClientEntryAsset, 'stable' | 'experimental'> {
  const raw = obj(value);
  if (Object.keys(raw).length > 0) {
    const one = (asset: ClientEntryAsset): 'stable' | 'experimental' =>
      raw[asset] === 'experimental' ? 'experimental' : 'stable';
    return { rule: one('rule'), skill: one('skill') };
  }
  const single = value === 'experimental' ? 'experimental' : 'stable';
  return { rule: single, skill: single };
}

function mapDetectResult(raw: RawObject): ClientDetectResult {
  const detected = obj(raw.detected);
  const hints = obj(field(raw, 'effectHint', 'effect_hint'));
  return {
    client: text(raw.client) as ClientEntryClientId,
    label: text(raw.label) || text(raw.client),
    assets: strings(raw.assets) as ClientEntryAsset[],
    scopes: strings(raw.scopes) as ClientEntryScope[],
    stability: mapStability(raw.stability),
    notes: strings(raw.notes),
    detected: { project: flag(detected.project), user: flag(detected.user) },
    targets: list(raw.targets).map(mapClientTarget),
    entries: list(raw.entries).map(mapClientEntry),
    effectHint: { project: text(hints.project), user: text(hints.user) },
  };
}

function mapSelfTestCore(raw: RawObject) {
  return {
    serverName: text(field(raw, 'serverName', 'server_name')),
    mcpEndpoint: text(field(raw, 'mcpEndpoint', 'mcp_endpoint')),
    wakeMode: field(raw, 'wakeMode', 'wake_mode') === 'continuous' ? ('continuous' as const) : ('single' as const),
  };
}

function mapPlanAction(raw: RawObject): ClientEntryPlanAction {
  const reason = text(raw.reason);
  const charLimit = field(raw, 'charLimit', 'char_limit');
  // 写入后整份文件的字符数（托管块含块外用户内容）；只在服务端给了有限数字时附带。
  const limitChars = field(raw, 'limitChars', 'limit_chars');
  return {
    assetType: text(field(raw, 'assetType', 'asset_type')) as ClientEntryAsset,
    assetName: text(field(raw, 'assetName', 'asset_name')),
    targetPath: text(field(raw, 'targetPath', 'target_path')),
    writeMode: text(field(raw, 'writeMode', 'write_mode')) as ClientEntryPlanAction['writeMode'],
    action: text(raw.action) as ClientEntryPlanAction['action'],
    ...(reason ? { reason } : {}),
    content: text(raw.content),
    contentChars: count(field(raw, 'contentChars', 'content_chars')),
    contentHash: text(field(raw, 'contentHash', 'content_hash')),
    expectedPrevHash: textOrNull(field(raw, 'expectedPrevHash', 'expected_prev_hash')),
    backupRequired: flag(field(raw, 'backupRequired', 'backup_required')),
    warnings: strings(raw.warnings),
    ...(typeof charLimit === 'number' && Number.isFinite(charLimit) ? { charLimit } : {}),
    ...(typeof limitChars === 'number' && Number.isFinite(limitChars) ? { limitChars } : {}),
  };
}

function mapPlan(raw: RawObject): ClientEntryPlan {
  return {
    client: text(raw.client) as ClientEntryClientId,
    scope: text(raw.scope) as ClientEntryScope,
    planHash: text(field(raw, 'planHash', 'plan_hash')),
    actions: list(raw.actions).map(mapPlanAction),
    warnings: strings(raw.warnings),
  };
}

function mapInstallResult(raw: RawObject): ClientEntryInstallResult {
  return {
    entries: list(raw.entries).map(mapClientEntry),
    actions: list(raw.actions).map(mapPlanAction),
  };
}

function mapVerifyResult(raw: RawObject): ClientEntryVerifyResult {
  const summaryRaw = obj(raw.summary);
  const summary: Record<ClientEntryStatus, number> = {
    installed: 0,
    drifted: 0,
    missing: 0,
    error: 0,
  };
  for (const status of CLIENT_ENTRY_STATUSES) summary[status] = count(summaryRaw[status]);
  return { entries: list(raw.entries).map(mapClientEntry), summary };
}

function mapUninstallResult(raw: RawObject): ClientEntryUninstallResult {
  // unmanaged = 安装前已存在、内容相同被接管的文件：文件保留、只删台账。
  const kept =
    raw.kept === 'drifted' || raw.kept === 'missing' || raw.kept === 'unmanaged'
      ? raw.kept
      : undefined;
  const entryRaw = obj(raw.entry);
  const entry = Object.keys(entryRaw).length > 0 ? mapClientEntry(entryRaw) : undefined;
  return {
    removed: flag(raw.removed),
    ...(kept ? { kept } : {}),
    ...(entry ? { entry } : {}),
  };
}

/** 计划/安装共用字段：服务端 zod 用 `assets`（不是 asset_types），空串 workspace 不发。 */
function planBody(input: ClientEntryPlanInput): Record<string, unknown> {
  const body: Record<string, unknown> = { client: input.client, scope: input.scope };
  const workspace = input.workspace?.trim();
  if (workspace) body.workspace = workspace;
  // `target_dir` 只属于 custom 伪客户端（内置六端传了会被 422 拒绝）；空串不发，
  // 让服务端按「缺 target_dir」报字段错误，而不是发一个会过 trim 校验的假值。
  const targetDir = input.targetDir?.trim();
  if (targetDir) body.target_dir = targetDir;
  // 显式空数组也要发：契约里「什么都不装」与「不传=按客户端能力取默认」是两种语义。
  if (input.assets !== undefined) body.assets = input.assets;
  return body;
}

export const clientEntriesApi = {
  /** 六端检测 + 台账 + 自测摘要；workspace 缺省时服务端只判用户级（项目级要用户先选目录）。 */
  detect: async (workspace?: string): Promise<ClientEntryOverview> => {
    const raw = await http.get<unknown>('/client-entries', { workspace });
    const body = obj(raw);
    const selfTest = obj(field(body, 'selfTest', 'self_test'));
    return {
      clients: list(body.clients).map(mapDetectResult),
      selfTest: {
        ...mapSelfTestCore(selfTest),
        recent: list(field(selfTest, 'recent', 'probes')).map(mapWakeProbe),
      },
    };
  },

  /** 预览：只渲染内容与冲突判定，不写盘。 */
  plan: async (input: ClientEntryPlanInput): Promise<ClientEntryPlan> => {
    const raw = await http.post<unknown>('/client-entries/plan', planBody(input));
    return mapPlan(obj(raw));
  },

  /** 安装：服务端重新计划并比对 plan_hash；成功回最新台账与逐动作结果。 */
  install: async (input: ClientEntryInstallInput): Promise<ClientEntryInstallResult> => {
    const raw = await http.post<unknown>('/client-entries/install', {
      ...planBody(input),
      plan_hash: input.planHash,
      confirm: input.confirm,
      ...(input.allowOverLimit ? { allow_over_limit: true } : {}),
    });
    return mapInstallResult(obj(raw));
  },

  /** 校验：不传 ids = 全部台账行；只重读文件，不改文件。 */
  verify: async (input: { ids?: string[] }): Promise<ClientEntryVerifyResult> => {
    const raw = await http.post<unknown>(
      '/client-entries/verify',
      input.ids ? { ids: input.ids } : {},
    );
    return mapVerifyResult(obj(raw));
  },

  /** 卸载：只删台账记录对应的本应用内容，用户自己的改动保留（回 kept 说明原因）。 */
  uninstall: async (id: string): Promise<ClientEntryUninstallResult> => {
    const raw = await http.post<unknown>(
      `/client-entries/${encodeURIComponent(id)}/uninstall`,
      { confirm: true },
    );
    return mapUninstallResult(obj(raw));
  },

  /** 自测：最近（或 since 之后）的 wake_probe 到达记录，不占任务、不改设置。 */
  selfTest: async (since?: string): Promise<ClientEntrySelfTest> => {
    const raw = await http.get<unknown>('/client-entries/self-test', { since });
    const body = obj(raw);
    return {
      ...mapSelfTestCore(body),
      probes: list(field(body, 'probes', 'recent')).map(mapWakeProbe),
    };
  },
};
