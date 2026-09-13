import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, qk, useApiMutation, useFieldDefs, useSettings } from '@/api';
import type {
  AgentToken,
  BackupFile,
  ImportPreview,
  ImportStrategy,
  IssuedToken,
  Settings,
  Template,
  TokenCreateInput,
} from '@/api/types';

/**
 * 设置页自己的读查询。`src/api/queries.ts` 只放了跨 feature 复用的那几个
 * （useSettings / useFieldDefs / useAudit…），Token、模板、备份列表只在这页消费，
 * 所以按基座约定写在 feature 里——**query key 仍全部取自 `qk`**，不现写数组。
 *
 * `src/api/resources/*.ts` 只有端点、没有钩子，这里补的也只是 react-query 包装，
 * 不新增路径：所有请求都走 `api.*`。
 */

export { useFieldDefs };

/* ------------------------------------------------------------- 读 */

export function useTokens() {
  return useQuery({ queryKey: qk.tokens(), queryFn: () => api.tokens.list() });
}

export function useTemplates() {
  return useQuery({ queryKey: qk.templates(), queryFn: () => api.templates.list() });
}

/** 13 章：Token 列表含已吊销项，「默认过滤已吊销」只做在界面（7.3）。 */
export function splitTokens(items: AgentToken[]): {
  active: AgentToken[];
  revoked: AgentToken[];
} {
  return {
    active: items.filter((item) => item.enabled),
    revoked: items.filter((item) => !item.enabled),
  };
}

export function useTemplateList(): Template[] {
  return useTemplates().data?.items ?? [];
}

/**
 * 原型 7.2：删词表项前要写出「删除后不影响 N 个已有任务」。
 *
 * 只为一句话的确认弹窗，所以直接发一次 `page_size=1` 的计数请求、不进缓存也不建 key
 * （为它建缓存会让每次打开设置页多出 N 个查询）。失败回 `null`，调用方改用不带数字的措辞。
 */
export async function countTasksByType(type: string): Promise<number | null> {
  try {
    const page = await api.tasks.list({ type: [type], archived: 'all', page: 1, page_size: 1 });
    return page.total;
  } catch {
    return null;
  }
}

/**
 * `GET /settings/backups`：`api/types.ts` 的 `BackupListResult` 已按服务端实际响应
 * 收录 `backup_dir`（9.3 的存放目录，原型 7.8 的「备份路径」那一行用它），这里不再叠克隆类型。
 */
export function useBackupList(): {
  items: BackupFile[];
  totalSize: number;
  dir: string | null;
  isLoading: boolean;
} {
  const query = useQuery({
    queryKey: qk.backups(),
    queryFn: () => api.settings.backups(),
  });
  return {
    items: query.data?.items ?? [],
    totalSize: query.data?.total_size_bytes ?? 0,
    dir: query.data?.backup_dir ?? null,
    isLoading: query.isLoading,
  };
}

/* --------------------------------------------------------- 设置写入 */

export interface SettingsWriter {
  settings: Settings | undefined;
  /** 即时写入（原型 7.2 无「保存」按钮）；未知键与越界由服务端 422。 */
  patch: (body: Partial<Settings>) => void;
  /** 单值写法：`set('board_column_limit', 50)`。 */
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  pending: boolean;
  errorText: string | null;
}

/**
 * 把「本 Tab 最近一次成功响应」叠在查询缓存之上：控件因此能在一个往返内
 * 保持用户刚选中的值，不会先弹回旧值再跳回来。
 */
export function useSettingsWriter(): SettingsWriter {
  const query = useSettings();
  const queryClient = useQueryClient();
  const mutation = useApiMutation<Partial<Settings>, Settings>(
    (body) => api.settings.patch(body),
    {
      invalidate: [qk.settings()],
      onSuccess: (data) => queryClient.setQueryData(qk.settings(), data),
    },
  );
  return {
    settings: mutation.data ?? query.data,
    patch: (body) => mutation.mutate(body),
    set: (key, value) => mutation.mutate({ [key]: value } as Partial<Settings>),
    pending: mutation.isPending,
    errorText: mutation.error ? errorMessage(mutation.error) : null,
  };
}

/* -------------------------------------------------- 数据 Tab 的导入两段 */

/** 6.12.2 的完整结果体。`ImportPreview`（`api/types.ts`）只有前三块，其余在这里补。 */
export interface ImportCounters {
  new: number;
  updated: number;
  skipped: number;
}

export interface ImportResultFull extends ImportPreview {
  dry_run: boolean;
  strategy: ImportStrategy | null;
  /** 真正导入前服务端先做的那次手动备份（6.12.2）；预览为 null。 */
  backup: { name: string; path: string } | null;
  templates: ImportCounters;
  runs: { new: number };
  reviews: { new: number };
  dependencies: { new: number };
  imported: { tasks: string[]; field_defs: string[]; templates: string[] };
  skipped: { kind: string; id: string; reason: string }[];
  failed: { kind: string; id: string | null; code: string; detail: string }[];
  dropped_dependencies: { task_id: string; depends_on: string; reason: string }[];
  warnings: string[];
}

export function useImportPreview() {
  return useApiMutation<File, ImportResultFull>(
    async (file) => (await api.data.importPreview(file)) as ImportResultFull,
    { errorText: errorMessage },
  );
}

/**
 * `dry_run=false`：导入是不可逆的批量写入，成功后要清掉的不只是任务缓存——
 * 服务端导入前自带一次备份，字段定义与模板也可能被这个文件改写（6.12.2 的导入顺序）。
 */
export function useImportApply() {
  return useApiMutation<{ file: File; strategy: ImportStrategy }, ImportResultFull>(
    async ({ file, strategy }) =>
      (await api.data.importApply(file, strategy)) as ImportResultFull,
    {
      invalidate: [
        qk.tasksRoot,
        qk.boardRoot,
        qk.fieldDefs(),
        qk.templates(),
        qk.backups(),
        qk.auditRoot,
        qk.tags(),
      ],
    },
  );
}

/* -------------------------------------------------------- Token 写侧 */

/** 明文只在这一次的响应里（13 章），错误内联显示所以不弹 Toast。 */
export function useIssueToken() {
  return useApiMutation<TokenCreateInput, IssuedToken>(
    (body) => api.tokens.create(body),
    { invalidate: [qk.tokens()], toastOnError: false },
  );
}

export function useRevokeToken() {
  return useApiMutation<{ id: string }, { id: string; enabled: false }>(
    ({ id }) => api.tokens.revoke(id),
    { invalidate: [qk.tokens()] },
  );
}

/* -------------------------------------------------------- 备份写侧 */

export function useCreateBackup() {
  return useApiMutation<undefined, { name: string; size_bytes: number }>(
    () => api.settings.backup(),
    { invalidate: [qk.backups()] },
  );
}

/**
 * 恢复的结果体（服务端 `RestoreResult`，`api/types.ts` 未收录）。
 * `safety_backup` 即 9.3 要求的「恢复前置备份」，界面要把它报给用户。
 */
export interface RestoreResultView {
  restored: string;
  safety_backup?: string;
  tasks_failed?: number;
  runs_abandoned?: number;
  message?: string;
}

/** 恢复是整库换文件（9.3）：除备份列表外，任务/字段/模板/Token/审计全都要重取。 */
export function useRestoreBackup() {
  return useApiMutation<string, RestoreResultView>(
    (name) => api.settings.restore(name) as Promise<RestoreResultView>,
    {
      invalidate: [
        qk.tasksRoot,
        qk.boardRoot,
        qk.fieldDefs(),
        qk.templates(),
        qk.tokens(),
        qk.settings(),
        qk.auditRoot,
        qk.backups(),
        qk.tags(),
      ],
    },
  );
}

/* -------------------------------------------------------- 字段 / 模板写侧 */

export function useCreateFieldDef() {
  return useApiMutation<Parameters<typeof api.fieldDefs.create>[0], FieldDefResult>(
    (body) => api.fieldDefs.create(body),
    { invalidate: [qk.fieldDefs(), qk.boardRoot, qk.tasksRoot], toastOnError: false },
  );
}

export function usePatchFieldDef() {
  return useApiMutation<
    { id: string; body: Parameters<typeof api.fieldDefs.patch>[1] },
    FieldDefResult
  >(({ id, body }) => api.fieldDefs.patch(id, body), {
    invalidate: [qk.fieldDefs(), qk.boardRoot, qk.tasksRoot],
    toastOnError: false,
  });
}

export function useDeleteFieldDef() {
  return useApiMutation<string, { id: string }>((id) => api.fieldDefs.remove(id), {
    invalidate: [qk.fieldDefs()],
    // FIELD_IN_USE 由界面自己接住并引导「改用停用」，不额外弹一条 Toast。
    toastOnError: false,
  });
}

export function useCreateTemplate() {
  return useApiMutation<Parameters<typeof api.templates.create>[0], Template>(
    (body) => api.templates.create(body),
    { invalidate: [qk.templates()], toastOnError: false },
  );
}

export function usePatchTemplate() {
  return useApiMutation<
    { id: string; body: Parameters<typeof api.templates.patch>[1] },
    Template
  >(({ id, body }) => api.templates.patch(id, body), {
    invalidate: [qk.templates()],
    toastOnError: false,
  });
}

export function useDeleteTemplate() {
  return useApiMutation<string, { id: string }>((id) => api.templates.remove(id), {
    invalidate: [qk.templates()],
  });
}

type FieldDefResult = Awaited<ReturnType<typeof api.fieldDefs.create>>;
