import { useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { errorMessage } from '@/api/errors';
import { useToast } from '@/components/ui';
import { Button, Dialog, Field, RadioGroup, Select } from '@/components/ui';
import { useActiveGroups, useGroupMutations } from './queries';
import type { Group } from './types';

/**
 * 5.1「删除分组需处理其下任务（迁移或一并删除）」：删除前二选一——
 * - 迁移：该分组下的任务整体挪到另一个活跃分组（默认，任务不丢）；
 * - 一并删除：任务与其执行记录随分组删除，**不可恢复**，按钮与警示都描红。
 * 成功 Toast 用服务端返回的 `affected_tasks` 报真实数量（4.3.1 规则 4 的口径）。
 */
export interface GroupDeleteDialogProps {
  group: Group | null;
  onClose: () => void;
}

export function GroupDeleteDialog({ group, onClose }: GroupDeleteDialogProps) {
  const toast = useToast();
  const mutations = useGroupMutations();
  const active = useActiveGroups();

  const [strategy, setStrategy] = useState<'migrate' | 'cascade'>('migrate');
  const targets = useMemo(
    () => (active.data?.items ?? []).filter((item) => item.id !== group?.id),
    [active.data?.items, group?.id],
  );
  const [targetId, setTargetId] = useState('');
  const target = targets.find((item) => item.id === targetId) ?? targets[0];

  if (!group) return null;

  const confirm = async () => {
    if (strategy === 'migrate' && !target) return;
    try {
      const result = await mutations.remove.mutateAsync({
        id: group.id,
        strategy,
        ...(strategy === 'migrate' && target ? { targetGroupId: target.id } : {}),
      });
      const action = result.strategy === 'migrate' ? '迁移' : '删除';
      toast.success(
        `已删除分组 ${group.name}`,
        `${action}了 ${result.affected_tasks} 个任务${result.strategy === 'cascade' ? '（含执行记录，不可恢复）' : ''}`,
      );
      onClose();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <Dialog
      open
      size="form"
      title={`删除分组：${group.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="danger"
            loading={mutations.remove.isPending}
            disabled={strategy === 'migrate' && !target}
            onClick={() => void confirm()}
          >
            删除分组
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="flex items-start gap-2 text-body text-text-primary">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-status-failed" aria-hidden />
          该分组下的任务不会凭空消失——先决定它们的去向：
        </p>

        <RadioGroup
          layout="column"
          name="delete-strategy"
          value={strategy}
          onChange={(value) => setStrategy(value as 'migrate' | 'cascade')}
          options={[
            {
              value: 'migrate',
              label: '迁移任务到其他分组',
              description: '分组删除，任务与其执行记录完整保留',
            },
            {
              value: 'cascade',
              label: '连同任务一起删除',
              description: '任务、执行记录与产物一并删除，不可恢复',
            },
          ]}
        />

        {strategy === 'migrate' ? (
          <Field label="迁移到" hint={targets.length === 0 ? '没有其他活跃分组可选' : undefined}>
            <Select
              value={target?.id ?? ''}
              invalid={targets.length > 0 && !target}
              disabled={targets.length === 0}
              placeholder={targets.length === 0 ? '无可选分组' : '选择目标分组'}
              options={targets.map((item) => ({
                value: item.id,
                label: `${item.icon ?? '📁'} ${item.name}`,
              }))}
              onChange={(event) => setTargetId(event.target.value)}
            />
          </Field>
        ) : (
          <p className="rounded-card bg-status-failed-soft px-3 py-2 text-aux text-status-failed">
            该分组下的所有任务与其执行记录都会被删除，此操作不可恢复。
          </p>
        )}
      </div>
    </Dialog>
  );
}
