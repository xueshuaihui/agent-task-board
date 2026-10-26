import { Badge, Button } from '@/components/ui';
import type { ClientEntry, ClientEntryAsset, ClientEntryStatus } from '@/api/types';
import { formatDateTime } from '@/lib/time';
import { cn } from '@/lib/cn';

/**
 * 客户端入口卡片共用文案与徽章映射：六端卡（client-card.tsx）与 custom 兜底卡
 * （custom-card.tsx）共用同一份，避免同一状态出现两种叫法（文案纪律的硬约束）。
 */

export const ASSET_LABEL: Record<ClientEntryAsset, string> = {
  rule: '入口规则',
  skill: '操作技能',
};

export const STATUS_LABEL: Record<ClientEntryStatus, string> = {
  installed: '已安装',
  drifted: '已漂移',
  missing: '文件缺失',
  error: '校验失败',
};

export const STATUS_CLASS: Record<ClientEntryStatus, string> = {
  installed: 'bg-status-done-soft text-status-done',
  drifted: 'bg-status-running-soft text-status-running',
  missing: 'bg-status-failed-soft text-status-failed',
  error: 'bg-status-failed-soft text-status-failed',
};

export function stabilityClass(value: 'stable' | 'experimental'): string | undefined {
  return value === 'experimental' ? 'bg-status-running-soft text-status-running' : undefined;
}

export function stabilityLabel(value: 'stable' | 'experimental'): string {
  return value === 'experimental' ? '实验' : '稳定';
}

/**
 * 条目行元信息（状态徽章 + 模板版本 + 可更新 + 最近校验 + 卸载）：
 * 两种卡的台账行长得一模一样，抽成共用组件而不是各抄一份。
 */
export function EntryMeta({
  entry,
  busy,
  onUninstall,
}: {
  entry: ClientEntry;
  busy: boolean;
  onUninstall: (entry: ClientEntry) => void;
}) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-aux">
      <Badge className={cn(STATUS_CLASS[entry.status])}>{STATUS_LABEL[entry.status]}</Badge>
      <span className="text-text-tertiary">模板 v{entry.templateVersion}</span>
      {entry.updateAvailable ? (
        <Badge className="bg-primary-light text-primary">可更新</Badge>
      ) : null}
      {entry.verifiedAt ? (
        <span className="text-text-tertiary">最近校验 {formatDateTime(entry.verifiedAt)}</span>
      ) : null}
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => onUninstall(entry)}>
        卸载
      </Button>
    </div>
  );
}
