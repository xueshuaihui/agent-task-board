import { useState } from 'react';
import { Badge, Button, Checkbox, Dialog, ErrorCopy } from '@/components/ui';
import type { ClientEntryPlan, ClientEntryPlanAction } from '@/api/types';
import { InlineError } from '@/features/task-detail/ui-bits';
import { cn } from '@/lib/cn';

/**
 * 预览安装弹窗：只展示服务端算出来的动作矩阵，不自己推断冲突或落点。
 *
 * 冲突动作不可确认（按钮禁用），但仍允许「复制内容」——服务端已经把预览正文带回来了，
 * 用户可以在自己的文件里手动合并。字符超限（Windsurf 全局规则 6000 字）按**写入后整份文件**
 * 的字符数 `limitChars` 判断（托管块含块外用户内容），不是 `contentChars`（本应用内容长度）；
 * 默认阻止，必须先勾选豁免；`allowOverLimit` 由父层随安装请求下发。
 */

const ASSET_LABEL: Record<ClientEntryPlanAction['assetType'], string> = {
  rule: '入口规则',
  skill: '操作技能',
};

const ACTION_LABEL: Record<ClientEntryPlanAction['action'], string> = {
  create: '新建',
  update: '更新',
  unchanged: '无变化',
  conflict: '冲突',
};

const ACTION_CLASS: Record<ClientEntryPlanAction['action'], string> = {
  create: 'bg-status-done-soft text-status-done',
  update: 'bg-status-running-soft text-status-running',
  unchanged: 'bg-bg-muted text-text-secondary',
  conflict: 'bg-status-failed-soft text-status-failed',
};

export interface PlanConfirmOptions {
  allowOverLimit?: boolean;
}

export interface PlanDialogProps {
  open: boolean;
  clientLabel: string;
  plan: ClientEntryPlan;
  installing: boolean;
  error: unknown;
  onClose: () => void;
  onConfirm: (options: PlanConfirmOptions) => void;
  onReplan: () => void;
  onCopy: (action: ClientEntryPlanAction) => void;
}

export function PlanDialog({
  open,
  clientLabel,
  plan,
  installing,
  error,
  onClose,
  onConfirm,
  onReplan,
  onCopy,
}: PlanDialogProps) {
  // 用 planHash 记「这次勾选了豁免」：重新预览拿到新计划时自动回到未勾选，不必写 effect。
  const [allowOverLimitFor, setAllowOverLimitFor] = useState<string | null>(null);
  // 超限只看服务端给的「写入后整文件字符数」；缺 limitChars 的旧响应不在这里自行推算。
  const overLimitAction = plan.actions.find(
    (action) =>
      action.limitChars !== undefined &&
      action.charLimit !== undefined &&
      action.limitChars > action.charLimit,
  );
  const allowOverLimit = allowOverLimitFor === plan.planHash;
  const hasConflict = plan.actions.some((action) => action.action === 'conflict');
  const blockedByLimit = overLimitAction !== undefined && !allowOverLimit;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`安装 ${clientLabel} · ${plan.scope === 'project' ? '项目级' : '用户级'}`}
      size="form"
      dismissible={!installing}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={installing}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={installing}
            disabled={hasConflict || installing || blockedByLimit}
            onClick={() => onConfirm(overLimitAction ? { allowOverLimit: true } : {})}
          >
            确认安装
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-aux text-text-secondary">
            预览只读取目标文件，不会写入；确认后才落盘。
          </p>
          <Button variant="ghost" size="sm" onClick={onReplan}>
            重新预览
          </Button>
        </div>

        {plan.warnings.length > 0 ? (
          <ul className="flex flex-col gap-1 rounded-control bg-status-running-soft px-3 py-2 text-aux text-status-running">
            {plan.warnings.map((warning, index) => (
              <li key={`${warning}-${index}`}>{warning}</li>
            ))}
          </ul>
        ) : null}

        {error ? <InlineError text={<ErrorCopy error={error} />} /> : null}

        {plan.actions.map((action) => (
          <div
            key={`${action.assetType}-${action.targetPath}`}
            className="flex flex-col gap-2 rounded-control border border-border px-3 py-2.5"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge className={cn(ACTION_CLASS[action.action])}>
                {ACTION_LABEL[action.action]}
              </Badge>
              <span className="text-body text-text-primary">{ASSET_LABEL[action.assetType]}</span>
              <span className="font-mono text-code break-all text-text-secondary">
                {action.targetPath}
              </span>
              <span className="text-aux text-text-tertiary">{action.contentChars} 字</span>
              {action.limitChars !== undefined && action.limitChars !== action.contentChars ? (
                // 托管块模式下整份文件还有块外用户内容：单独标出写入后的整文件字数，避免误读成块正文。
                <span className="text-aux text-text-tertiary">写入后 {action.limitChars} 字</span>
              ) : null}
              <span className="text-aux text-text-tertiary">
                {action.writeMode === 'managed_block' ? '托管块' : '独立文件'}
              </span>
            </div>

            {action.reason ? (
              <p className="text-aux text-text-secondary">{action.reason}</p>
            ) : null}

            {action.warnings.map((warning, index) => (
              <p key={`${warning}-${index}`} className="text-aux text-status-running">
                {warning}
              </p>
            ))}

            {action.action === 'conflict' ? (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-aux text-status-failed">
                  该位置已有非本应用内容，未覆盖。可复制规则后手动合并。
                </p>
                <Button size="sm" variant="ghost" onClick={() => onCopy(action)}>
                  复制内容
                </Button>
              </div>
            ) : null}

            <details className="text-aux">
              <summary className="cursor-pointer select-none text-text-secondary">
                查看内容
              </summary>
              <pre className="atb-scroll mt-1 max-h-64 overflow-auto rounded-control border border-border bg-bg-muted px-2 py-1 font-mono text-code break-all whitespace-pre-wrap text-text-primary">
                {action.content}
              </pre>
            </details>
          </div>
        ))}

        {overLimitAction ? (
          <Checkbox
            checked={allowOverLimit}
            onChange={(event) =>
              setAllowOverLimitFor(event.target.checked ? plan.planHash : null)
            }
            label={`写入后 ${overLimitAction.limitChars ?? 0} 字超过客户端上限（${overLimitAction.charLimit ?? 0} 字），仍要写入`}
          />
        ) : null}
      </div>
    </Dialog>
  );
}
