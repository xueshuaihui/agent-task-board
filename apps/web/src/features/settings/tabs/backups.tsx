import { useState } from 'react';
import { FolderOpen, HardDriveDownload, History } from 'lucide-react';
import { Button, Progress, Tooltip } from '@/components/ui';
import { errorMessage } from '@/api';
import { COPY } from '@/lib/copy';
import { SHOW_AUTO_BACKUP_TOGGLE } from '@/lib/phase';
import { formatBytes, formatDateTime } from '@/lib/time';
import { ConfirmDialog } from '../components/confirm-dialog';
import {
  FormError,
  ReadOnlyTag,
  RowActions,
  SettingRow,
  SettingsTable,
  SettingSection,
  StaticValue,
  TabHeader,
} from '../components/settings-ui';
import { useBackupList, useCreateBackup, useRestoreBackup, type RestoreResultView } from '../queries';
import { useOpenDir, useSystemInfo } from '../system-info';
import { isBackupFileName } from '../utils';

/**
 * 备份 Tab（8.5 / 原型 7.8 / PRD 9.3）。
 *
 * 阶段一只有「手动备份 + 手动恢复」两件事（17.2）：自动备份的开关、频率、时间、保留份数
 * 四项**一个都不渲染**（`SHOW_AUTO_BACKUP_TOGGLE` 为假），不是置灰。
 *
 * 列表**没有「来源」列**——13 章的备份接口只回文件名/大小/时间，磁盘扫描也拿不到更细的信息。
 * 「较早」是纯提示：非最近一份照样可恢复（用户可能就是要把某个时间点倒回去）。
 */

const COLS = 'grid-cols-[minmax(0,1fr)_88px_148px_72px_88px]';

export function BackupsTab() {
  const { items, totalSize, dir, isLoading } = useBackupList();
  const { info } = useSystemInfo();
  const openDir = useOpenDir();
  const create = useCreateBackup();
  const restore = useRestoreBackup();

  const [target, setTarget] = useState<string | null>(null);
  const [result, setResult] = useState<RestoreResultView | null>(null);

  const backupDir = dir ?? info.backup_dir ?? null;
  const newest = items[0];

  const confirmRestore = () => {
    if (!target) return;
    restore.mutate(target, {
      onSuccess: (data) => {
        setResult(data);
        setTarget(null);
      },
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <TabHeader
        title="备份"
        meta={isLoading ? undefined : `共 ${formatBytes(totalSize)}`}
        description="备份是整库快照（`VACUUM INTO`，只读一致性、不停写）；产物文件不在备份范围内（9.3）。"
      />

      <SettingSection>
        <SettingRow
          label="备份路径"
          width="fluid"
          hint="9.3 固定为「数据目录/backups」，与数据库同盘；不提供改目录（20.9 没有这个设置键）。"
        >
          <div className="flex flex-wrap items-center gap-2 py-1">
            <StaticValue mono className="min-w-[240px] flex-1">
              {backupDir ?? '—'}
            </StaticValue>
            <Button
              size="sm"
              variant="ghost"
              icon={<FolderOpen className="size-3.5" />}
              onClick={() => void openDir('backups')}
            >
              打开目录
            </Button>
          </div>
        </SettingRow>

        <SettingRow
          label="立即备份"
          width="fluid"
          hint={
            newest
              ? `上次备份：${backupTime(newest.created_at)} · ${formatBytes(newest.size_bytes)}`
              : '还没有备份。'
          }
        >
          <div className="flex h-8 items-center">
            <Button
              variant="primary"
              icon={<HardDriveDownload className="size-4" />}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              立即备份
            </Button>
          </div>
        </SettingRow>

        {SHOW_AUTO_BACKUP_TOGGLE ? null : (
          <p className="border-t border-border py-2 text-aux text-text-tertiary">
            本页只有手动备份与手动恢复（8.5）：阶段一不删任何历史备份，
            所以目录总占用摆在列表标题右侧，磁盘占用请自己留意。
            <ReadOnlyTag>8.5</ReadOnlyTag>
          </p>
        )}
      </SettingSection>

      {create.error ? <FormError>{errorMessage(create.error)}</FormError> : null}
      {result ? <RestoreResultLine result={result} /> : null}

      <SettingSection
        bare
        title={`备份列表（${items.length}）`}
        meta="阶段一不自动清理旧备份"
      >
        <SettingsTable
          cols={COLS}
          head={['文件名', '大小', '时间', '状态', '操作']}
          items={items}
          rowKey={(item) => item.name}
          align="start"
          cells={(item, index) => {
            const restorable = isBackupFileName(item.name);
            return [
              <Tooltip key="name" content={item.name}>
                <span className="block truncate font-mono text-code text-text-primary">
                  {item.name}
                </span>
              </Tooltip>,
              <span key="size" className="text-aux text-text-secondary">
                {formatBytes(item.size_bytes)}
              </span>,
              <span key="time" className="text-aux text-text-secondary">
                {backupTime(item.created_at)}
              </span>,
              <span key="state" className="text-aux text-text-tertiary">
                {!restorable ? (
                  <Tooltip content="文件名不匹配 `^atb-\\d{8}-\\d{6}\\.db$`，恢复接口会直接 400 INVALID_BACKUP_NAME">
                    <span className="truncate">不可恢复</span>
                  </Tooltip>
                ) : index === 0 ? (
                  '—'
                ) : (
                  '较早'
                )}
              </span>,
              <RowActions key="actions">
                {restorable ? (
                  <Button
                    size="sm"
                    variant="outlineDanger"
                    onClick={() => {
                      setResult(null);
                      restore.reset();
                      setTarget(item.name);
                    }}
                  >
                    恢复
                  </Button>
                ) : null}
              </RowActions>,
            ];
          }}
          empty={
            <div className="flex items-start gap-2 text-aux text-text-secondary">
              <History className="mt-0.5 size-4 shrink-0 text-text-tertiary" />
              <span>{COPY.emptyBackup}</span>
            </div>
          }
        />
      </SettingSection>

      {restore.error ? <FormError>{errorMessage(restore.error)}</FormError> : null}

      <ConfirmDialog
        open={target !== null}
        title="恢复备份"
        description={COPY.restoreConfirm}
        detail={
          restore.isPending
            ? '正在备份当前数据…（点确认后服务端先对当前库做一次 VACUUM INTO，失败即中止恢复）'
            : `将用 ${target ?? ''} 覆盖当前数据库。`
        }
        confirmText="确认恢复"
        danger
        loading={restore.isPending}
        onConfirm={confirmRestore}
        onClose={() => setTarget(null)}
      />
      {restore.isPending ? <Progress value={35} /> : null}
    </div>
  );
}

/** 恢复后的落地说明：9.3 的三条后果（安全备份名、执行中任务转失败、产物缺失）。 */
function RestoreResultLine({ result }: { result: RestoreResultView }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-bg-muted px-4 py-3 text-aux text-text-secondary">
      已恢复 {result.restored}
      {result.safety_backup ? <> · 恢复前已备份为 {result.safety_backup}</> : null}
      {result.tasks_failed !== undefined
        ? ` · ${result.tasks_failed} 个执行中的任务转为失败（${result.runs_abandoned ?? 0} 条 Run 置 ABANDONED）`
        : null}
    </div>
  );
}

/** 原型 7.8 的时间列写法：今天给「今天 14:35」，昨天给「昨天 03:00」，更早给「N 天前」。 */
function backupTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return formatDateTime(value);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now.getTime() - 86_400_000).toDateString() === date.toDateString();
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return `今天 ${clock}`;
  if (yesterday) return `昨天 ${clock}`;
  const days = Math.floor((now.getTime() - date.getTime()) / 86_400_000);
  if (days < 30) return `${days} 天前`;
  return formatDateTime(value);
}
