import { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { Button, Pagination, Select, Tooltip } from '@/components/ui';
import { useAudit } from '@/api';
import type { LogLevel } from '@/api/types';
import { AUDIT_ACTION_LABEL, labelOf } from '@/lib/labels';
import { formatDateTime, formatRelative } from '@/lib/time';
import {
  FormError,
  ReadOnlyTag,
  SectionDivider,
  SettingRow,
  SettingsTable,
  SettingSection,
  StaticValue,
  TabHeader,
} from '../components/settings-ui';
import { useSettingsWriter } from '../queries';
import { useOpenDir, useSystemInfo } from '../system-info';
import { auditSummary, prettyJson } from '../utils';

/**
 * 日志与审计 Tab（8.5 / 原型 7.7 / PRD 9.1、9.3）。
 *
 * 上半只有两项可写（20.9 的 `log_level`、`log_retention_days`）：
 * 单文件 20 MB 由 9.3 随版本固定、日志目录由系统约定，两处都只读展示；
 * **不做「总量上限」设置**（7.7：轮转已按「天数 + 单文件」两个条件，再加一个只会让人以为今天的日志会丢）。
 *
 * 下半审计只读、时间倒序、`page_size` 固定 50、**无筛选控件**（17.2）：
 * 与任务详情抽屉的「审计」Tab 是同一份读路径（`GET /audit`），差别只是这里不传 `target_id`。
 */

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** 9.3 的固定值：单文件轮转阈值，不开放修改。 */
const LOG_FILE_MAX_MB = 20;

/** 20.9 允许 1–90，界面按原型 7.7 给几档常用值。 */
const RETENTION_TIERS = [3, 7, 14, 30, 60, 90] as const;

export function LogsTab() {
  const { settings, set, errorText } = useSettingsWriter();
  const { info } = useSystemInfo();
  const openDir = useOpenDir();

  const retention = settings?.log_retention_days ?? 14;

  return (
    <div className="flex flex-col gap-4">
      <TabHeader title="日志与审计" />

      <SettingSection title="运行日志">
        <SettingRow
          label="日志级别"
          width="narrow"
          hint="debug / info / warn / error；只影响此后写入的粒度。"
        >
          <Select
            value={settings?.log_level ?? 'info'}
            options={LEVELS.map((level) => ({ value: level, label: level }))}
            onChange={(event) => set('log_level', event.target.value as LogLevel)}
          />
        </SettingRow>

        <SettingRow
          label="保留天数"
          width="narrow"
          hint="1–90（20.9）。轮转按「天数 + 单文件 20 MB」两个条件，不设总量上限。"
        >
          <Select
            value={String(retention)}
            options={[...new Set([...RETENTION_TIERS, retention])]
              .sort((a, b) => a - b)
              .map((days) => ({ value: String(days), label: `${days} 天` }))}
            onChange={(event) => set('log_retention_days', Number(event.target.value))}
          />
        </SettingRow>

        <SettingRow label="单文件大小">
          <div className="flex h-8 items-center">
            <StaticValue>
              {LOG_FILE_MAX_MB} MB（固定，随版本发布）
              <ReadOnlyTag>9.3</ReadOnlyTag>
            </StaticValue>
          </div>
        </SettingRow>

        <SettingRow label="日志目录" width="fluid">
          <div className="flex flex-wrap items-center gap-2 py-1">
            <StaticValue mono className="min-w-[240px] flex-1">
              {info.logs_dir ?? '—'}
            </StaticValue>
            <Button
              size="sm"
              icon={<FolderOpen className="size-3.5" />}
              onClick={() => void openDir('logs')}
            >
              打开目录
            </Button>
          </div>
        </SettingRow>
      </SettingSection>

      {errorText ? <FormError>{errorText}</FormError> : null}

      <SectionDivider className="my-0" />

      <AuditBlock />
    </div>
  );
}

/* --------------------------------------------------------------- 审计 */

function AuditBlock() {
  const [page, setPage] = useState(1);
  const audit = useAudit({ page });
  const rows = audit.data?.items ?? [];
  const total = audit.data?.total ?? 0;
  const pageSize = audit.data?.page_size ?? 50;

  return (
    <SettingSection
      bare
      title="操作审计"
      meta={audit.isFetching ? '加载中…' : `共 ${total} 条 · 每页 ${pageSize} 条`}
      description="全量写入、只读列表，阶段一无筛选控件（17.2）。详情列是 before → after 的压缩摘要，展开才给两份 JSON 原文。"
    >
      <SettingsTable
        cols="grid-cols-[152px_96px_minmax(0,110px)_minmax(0,96px)_minmax(0,1fr)]"
        head={['时间', '操作人', '动作', '对象', '详情']}
        items={rows}
        rowKey={(item) => String(item.id)}
        align="start"
        cells={(item) => [
          <Tooltip key="time" content={formatDateTime(item.created_at)}>
            <span className="block truncate text-aux text-text-secondary">
              {item.created_at
                ? `${formatDateTime(item.created_at).slice(5)} · ${formatRelative(item.created_at)}`
                : '—'}
            </span>
          </Tooltip>,
          <span key="actor" className="truncate text-text-primary">
            {item.actor_label ??
              (item.actor_type === 'user' ? '我' : (item.actor_name ?? item.actor_type))}
          </span>,
          <span key="action" className="truncate text-aux text-text-secondary">
            {labelOf(AUDIT_ACTION_LABEL, item.action)}
          </span>,
          <span key="target" className="truncate font-mono text-code text-text-secondary">
            {item.target_id ?? '—'}
          </span>,
          <details key="detail" className="min-w-0">
            <summary className="cursor-pointer truncate text-aux text-text-secondary">
              {auditSummary(item.before, item.after)}
            </summary>
            <div className="mt-1 grid gap-2">
              <JsonPane label="before" value={item.before} />
              <JsonPane label="after" value={item.after} />
            </div>
          </details>,
        ]}
        empty={
          <p className="text-aux text-text-secondary">
            还没有审计记录。任务、Run、审核、Token、字段与模板的每次写入都会留痕（9.1）。
          </p>
        }
      />
      {total > pageSize ? (
        <Pagination
          total={total}
          page={page}
          pageSize={pageSize}
          onPageChange={setPage}
          className="mt-1 border-t-0"
        />
      ) : null}
      <p className="text-aux text-text-tertiary">
        审计不参与导入导出：`audit_logs.id` 是本机自增，换机后无意义（6.12.1）。
      </p>
    </SettingSection>
  );
}

function JsonPane({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <p className="mb-1 text-badge text-text-tertiary">{label}</p>
      <pre className="atb-scroll max-h-[180px] overflow-auto rounded-control border border-border bg-bg-muted px-2 py-1.5 font-mono text-code leading-relaxed text-text-secondary">
        {prettyJson(value)}
      </pre>
    </div>
  );
}
