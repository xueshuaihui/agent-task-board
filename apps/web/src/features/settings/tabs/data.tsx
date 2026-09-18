import { useRef, useState } from 'react';
import { Download, FileUp, FolderOpen } from 'lucide-react';
import { desktop } from '@/app/desktop';
import { navigate } from '@/app/router';
import { taskListSearch, useFilterStore, activeFilterCount, toListQuery } from '@/app/store/filters';
import type { FilterState } from '@/app/store/filters';
import { Button, Checkbox, Input, RadioGroup, Textarea, useToast } from '@/components/ui';
import type { ExportInput, ImportStrategy, TaskListQuery } from '@/api/types';
import { api, errorMessage, useApiMutation } from '@/api';
import { formatBytes } from '@/lib/time';
import { SHOW_CSV_EXPORT } from '@/lib/phase';
import { ConfirmDialog } from '../components/confirm-dialog';
import {
  FormError,
  SettingRow,
  SettingSection,
  StaticValue,
  TabHeader,
} from '../components/settings-ui';
import { useImportApply, useImportPreview, useSettingsWriter, type ImportResultFull } from '../queries';
import { parseTaskIds } from '../utils';

/**
 * 数据 Tab（8.5 / 原型 7.6 / PRD 6.12）。
 *
 * 两块边界写死在界面里：
 * - **导出没有格式单选**（17.2 阶段一只有 JSON）。放一个点了报错的 CSV 单选比没有更糟，
 *   所以 `SHOW_CSV_EXPORT` 为假时这一行整体不渲染，只在只读说明里交代「仅 JSON」。
 * - **导入是四步**：选文件 → 预览（`dry_run=true`）→ 冲突处理（有冲突必选策略）→ 确认。
 *   一步直传会跳过 6.12.2 的强制选择，也没机会给出「导入前自动备份」的路径。
 */

const STRATEGY_LABEL: Record<ImportStrategy, string> = {
  skip: '跳过',
  overwrite: '覆盖',
  reassign: '重新分配',
};

const STRATEGY_HINT: Record<ImportStrategy, string> = {
  skip: '跳过冲突任务，只导入本地不存在的（默认最保守）',
  overwrite: '按 ID 覆盖本地任务的字段；本地正在执行的任务拒绝覆盖并计入跳过',
  reassign: '丢弃文件里的 T-/R- 号，按 20.1 重新分配——把另一台机器整库搬过来用它',
};

export function DataTab() {
  const { settings, set, errorText: settingError } = useSettingsWriter();
  return (
    <div className="flex flex-col gap-4">
      <TabHeader
        title="数据"
        description="导出/导入是跨机迁移通道，不是备份：JSON 不含产物文件与审计记录，也不含 Token（6.12.1）。"
      />

      <ExportBlock />
      <ImportBlock />

      <SettingSection title="归档">
        <SettingRow
          label="自动归档"
          hint="0 = 关闭。定时任务每天检查一次「已完成超过 N 天」的任务并归档。"
        >
          <div className="flex h-8 items-center gap-2">
            <Input
              className="w-[88px]"
              inputMode="numeric"
              defaultValue={String(settings?.auto_archive_days ?? 30)}
              key={String(settings?.auto_archive_days ?? 30)}
              onBlur={(event) => {
                const parsed = Math.trunc(Number(event.target.value));
                const next = Number.isFinite(parsed) ? Math.min(365, Math.max(0, parsed)) : 30;
                if (next !== settings?.auto_archive_days) set('auto_archive_days', next);
              }}
            />
            <span className="text-aux text-text-tertiary">天</span>
          </div>
        </SettingRow>

        <SettingRow
          label="已归档任务"
          hint="设置页不做二级列表：归档唯一读路径是任务列表页的 `archived=true`（6.13.1）。"
        >
          <div className="flex h-8 items-center">
            <Button
              icon={<FolderOpen className="size-4" />}
              onClick={() => navigate('tasks', taskListSearch({ archived: 'true' }))}
            >
              查看
            </Button>
          </div>
        </SettingRow>
      </SettingSection>

      {settingError ? <FormError>{settingError}</FormError> : null}
    </div>
  );
}

/* ------------------------------------------------------------- 导出 */

function ExportBlock() {
  const toast = useToast();
  const filters = useFilterStore();
  const count = activeFilterCount(filters);
  const [scope, setScope] = useState<'all' | 'filtered' | 'selected'>('all');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [ids, setIds] = useState('');

  const parsed = parseTaskIds(ids);
  const exportData = useApiMutation<void, { filename: string; bytes: number }>(
    async () => {
      const body = buildExportBody(scope, parsed, includeArchived, filters);
      const result = await apiExport(body);
      // 9.4：桌面壳优先（原生保存对话框），浏览器开发态 `saveTextFile` 自己退回 `<a download>`。
      await desktop.saveTextFile(result.filename, result.text);
      return { filename: result.filename, bytes: result.text.length };
    },
    {
      onSuccess: (data) => toast.success(`已导出 ${data.filename}`, `约 ${formatBytes(data.bytes)}`),
    },
  );

  const blocked = scope === 'filtered' && count === 0;
  const noIds = scope === 'selected' && parsed.length === 0;

  return (
    <SettingSection
      title="导出"
      meta={SHOW_CSV_EXPORT ? undefined : '格式 JSON（阶段一仅 JSON，17.2）'}
    >
      <SettingRow
        label="范围"
        width="fluid"
        hint={
          scope === 'filtered'
            ? `将按任务列表页的当前筛选导出：${describeFilters(filters)}`
            : scope === 'selected'
              ? '导出不含产物文件与日志；Run 只保留状态与时长。'
              : '全部任务 + 字段定义 + 模板（6.12.1：三者必须一起导出，否则换机后自定义字段无处校验）。'
        }
      >
        <div className="flex flex-col gap-2 py-1">
          <RadioGroup
            value={scope}
            options={[
              { value: 'all', label: '全部' },
              {
                value: 'filtered',
                label: '当前筛选',
                disabled: count === 0,
                description: count === 0 ? '先到任务列表页设筛选' : undefined,
              },
              { value: 'selected', label: '选中任务' },
            ]}
            onChange={(value) => setScope(value as typeof scope)}
          />
          {scope === 'selected' ? (
            <>
              <Textarea
                rows={3}
                value={ids}
                invalid={noIds && ids.trim().length > 0}
                placeholder="T-1012, T-1015"
                onChange={(event) => setIds(event.target.value)}
              />
              <p className="text-aux text-text-tertiary">
                已识别 {parsed.length} 个 ID。任务列表页的勾选状态不在设置页可读范围内（共享选择
                store 未落地），因此这里按 ID 填。
              </p>
            </>
          ) : null}
          <Checkbox
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
            label="包含已归档任务"
            description="默认不含（6.12.1）。"
          />
        </div>
      </SettingRow>

      <SettingRow label="" width="fluid" className="border-b-0">
        <Button
          variant="primary"
          icon={<Download className="size-4" />}
          loading={exportData.isPending}
          disabled={blocked || noIds}
          onClick={() => exportData.mutate()}
        >
          导出
        </Button>
        {exportData.error ? <FormError>{errorMessage(exportData.error)}</FormError> : null}
      </SettingRow>
    </SettingSection>
  );
}

async function apiExport(body: ExportInput): Promise<{ filename: string; text: string }> {
  const result = await api.data.export(body);
  return { filename: result.filename, text: await result.blob.text() };
}

function buildExportBody(
  scope: 'all' | 'filtered' | 'selected',
  ids: string[],
  includeArchived: boolean,
  filters: FilterState,
): ExportInput {
  if (scope === 'selected') return { scope: 'selected', ids, include_archived: includeArchived };
  if (scope === 'filtered') {
    const full = toListQuery(filters, { page: 1, page_size: 50 });
    const filter: TaskListQuery = {};
    if (full.status?.length) filter.status = full.status;
    if (full.keyword) filter.keyword = full.keyword;
    if (full.priority?.length) filter.priority = full.priority;
    if (full.type?.length) filter.type = full.type;
    if (full.tags?.length) filter.tags = full.tags;
    if (full.custom_fields && Object.keys(full.custom_fields).length) {
      filter.custom_fields = full.custom_fields;
    }
    return { scope: 'filtered', filter, include_archived: includeArchived };
  }
  return { scope: 'all', include_archived: includeArchived };
}

/** 「当前筛选」到底指什么，得在这一行里说清，否则导出结果像凭运气。 */
function describeFilters(state: FilterState): string {
  const parts: string[] = [];
  if (state.view !== 'all') parts.push(`视图=${state.view}`);
  if (state.status.length) parts.push(`状态[${state.status.join('、')}]`);
  if (state.keyword.trim()) parts.push(`关键词「${state.keyword.trim()}」`);
  if (state.priority.length) parts.push(`优先级[${state.priority.map((p) => `P${p}`).join('、')}]`);
  if (state.type.length) parts.push(`类型[${state.type.join('、')}]`);
  if (state.tags.length) parts.push(`标签[${state.tags.join('、')}]`);
  if (Object.keys(state.customFields).length) parts.push(`自定义字段 ${Object.keys(state.customFields).length} 项`);
  if (state.archived !== 'false') parts.push(`归档=${state.archived}`);
  return parts.length ? parts.join(' · ') : '无';
}

/* ------------------------------------------------------------- 导入 */

type ImportStep = 'pick' | 'preview' | 'done';

function ImportBlock() {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const preview = useImportPreview();
  const apply = useImportApply();

  const [file, setFile] = useState<File | null>(null);
  const [step, setStep] = useState<ImportStep>('pick');
  const [strategy, setStrategy] = useState<ImportStrategy | ''>('');
  const [confirming, setConfirming] = useState(false);

  const previewResult = preview.data;
  const result = apply.data;
  const conflicts = previewResult?.conflicts ?? [];

  const choose = (next: File | null) => {
    setFile(next);
    setStrategy('');
    apply.reset();
    preview.reset();
    if (!next) {
      setStep('pick');
      return;
    }
    preview.mutate(next, { onSuccess: () => setStep('preview') });
  };

  const runImport = () => {
    if (!file || !strategy) return;
    setConfirming(false);
    apply.mutate(
      { file, strategy },
      {
        onSuccess: () => setStep('done'),
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  };

  return (
    <SettingSection
      title="导入"
      description="导入前服务端先做一次手动备份（6.12.2），结果页会给出该文件路径；这一步没有退路，所以不能一步直传。"
      className="border-status-failed"
    >
      <SettingRow label="选择文件" width="fluid">
        <div className="flex flex-wrap items-center gap-2 py-1">
          <input
            ref={inputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => choose(event.target.files?.[0] ?? null)}
          />
          <Button icon={<FileUp className="size-4" />} onClick={() => inputRef.current?.click()}>
            选择文件
          </Button>
          <StaticValue muted={!file}>{file ? `${file.name} · ${formatBytes(file.size)}` : '未选择文件'}</StaticValue>
          {preview.isPending ? <span className="text-aux text-text-tertiary">正在预览…</span> : null}
        </div>
      </SettingRow>

      {preview.error ? <FormError>{errorMessage(preview.error)}</FormError> : null}

      {step !== 'pick' && previewResult ? (
        <SettingRow label="预览" width="fluid">
          <div className="flex flex-col gap-2 py-1">
            <p className="text-body text-text-primary">
              新增 {previewResult.tasks.new} · 覆盖 {previewResult.tasks.updated} · 跳过{' '}
              {previewResult.tasks.skipped} · ID 冲突 {conflicts.length} · 字段定义新增{' '}
              {previewResult.field_defs.new}
            </p>
            {conflicts.length ? (
              <ul className="flex max-h-[132px] flex-col gap-1 overflow-y-auto rounded-control border border-border bg-bg-muted px-3 py-2">
                {conflicts.slice(0, 20).map((item) => (
                  <li key={`${item.kind}-${item.id}`} className="text-aux text-text-secondary">
                    <span className="font-mono text-code">{item.id}</span> {item.detail}
                  </li>
                ))}
                {conflicts.length > 20 ? (
                  <li className="text-aux text-text-tertiary">…另有 {conflicts.length - 20} 条</li>
                ) : null}
              </ul>
            ) : (
              <p className="text-aux text-text-tertiary">没有 ID 冲突，可直接确认。</p>
            )}
          </div>
        </SettingRow>
      ) : null}

      {step !== 'pick' ? (
        <SettingRow
          label="策略"
          width="fluid"
          required={conflicts.length > 0}
          hint={
            conflicts.length > 0
              ? `${conflicts.length} 条冲突，必选一项才能继续（6.12.2：无默认值）。`
              : '无冲突时也请显式选一项：`skip` 最保守。'
          }
        >
          <RadioGroup
            layout="column"
            value={strategy}
            options={(Object.keys(STRATEGY_LABEL) as ImportStrategy[]).map((item) => ({
              value: item,
              label: `${STRATEGY_LABEL[item]}（${item}）`,
              description: STRATEGY_HINT[item],
            }))}
            onChange={(value) => setStrategy(value as ImportStrategy)}
          />
        </SettingRow>
      ) : null}

      {step !== 'pick' ? (
        <SettingRow label="" width="fluid" className="border-b-0">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="danger"
              disabled={!strategy || Boolean(result && !result.dry_run)}
              loading={apply.isPending}
              onClick={() => setConfirming(true)}
            >
              确认导入
            </Button>
            <span className="text-aux text-text-tertiary">
              导入按「字段定义 → 模板 → 任务 → 依赖边 → Run 与审核记录」顺序执行，单条失败不整体回滚。
            </span>
          </div>
        </SettingRow>
      ) : null}

      {apply.error ? <FormError>{errorMessage(apply.error)}</FormError> : null}

      {result && step === 'done' ? <ImportResultView result={result} /> : null}

      <ConfirmDialog
        open={confirming}
        title="确认导入"
        description={`将以「${strategy ? STRATEGY_LABEL[strategy] : ''}」策略导入 ${file?.name ?? ''}。`}
        detail="不可逆的批量写入：服务端会先对当前库做一次备份，结果页给出该备份文件名；已有同 ID 任务按所选策略处理。"
        confirmText="开始导入"
        danger
        loading={apply.isPending}
        onConfirm={runImport}
        onClose={() => setConfirming(false)}
      />
    </SettingSection>
  );
}

/** 6.12.2 的结果页：四类各自给原因，不弹多个 toast。 */
function ImportResultView({ result }: { result: ImportResultFull }) {
  const groups: readonly { title: string; rows: readonly (readonly string[])[] }[] = [
    {
      title: `跳过 ${result.skipped.length}`,
      rows: result.skipped.map((item) => [item.id, `${item.kind}：${item.reason}`]),
    },
    {
      title: `失败 ${result.failed.length}`,
      rows: result.failed.map((item) => [item.id ?? '—', `${item.code}：${item.detail}`]),
    },
    {
      title: `丢弃的依赖边 ${result.dropped_dependencies.length}`,
      rows: result.dropped_dependencies.map((item) => [
        item.task_id,
        `→ ${item.depends_on}：${item.reason}`,
      ]),
    },
  ];
  return (
    <div className="flex flex-col gap-3 py-3">
      <p className="text-body text-text-primary">
        已导入任务 {result.imported.tasks.length} · 字段定义 {result.imported.field_defs.length} · 模板{' '}
        {result.imported.templates.length}
        {result.backup ? ` · 导入前备份：${result.backup.name}` : ''}
      </p>
      {result.warnings.length ? (
        <ul className="flex flex-col gap-1">
          {result.warnings.map((item) => (
            <li key={item} className="text-aux text-status-running">
              ⚠ {item}
            </li>
          ))}
        </ul>
      ) : null}
      {groups.map((group) =>
        group.rows.length ? (
          <details key={group.title} className="rounded-control border border-border px-3 py-2">
            <summary className="cursor-pointer text-aux text-text-secondary">{group.title}</summary>
            <ul className="mt-2 flex flex-col gap-1">
              {group.rows.map(([id, detail]) => (
                <li key={`${id}-${detail}`} className="text-aux text-text-tertiary">
                  <span className="font-mono text-code">{id}</span> {detail}
                </li>
              ))}
            </ul>
          </details>
        ) : null,
      )}
      <p className="text-aux text-text-tertiary">
        审计不参与导入导出（6.12.1），Token 也不会被带过来——换机后需在 Token Tab 重新生成。
      </p>
    </div>
  );
}
