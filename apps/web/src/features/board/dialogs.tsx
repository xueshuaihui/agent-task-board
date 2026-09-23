import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TaskCard } from '@/api/types';
import { api, qk } from '@/api';
import { COPY } from '@/lib/copy';
import { Button, Dialog, Field, Input } from '@/components/ui';
import type { BoardMutations } from './mutations';

/**
 * 4.3 + 10.5：不可逆动作一律先确认，确认语直接取 `lib/copy`（与 sidecar 的 `USER_COPY` 同源），
 * 提交在弹窗内部完成——取消等于什么都没发生，不发请求（PRD 7.2）。
 * 归档（6.13）不弹这里：它可逆，且被依赖挡住时服务端的 409 文案已经是正确提示。
 */

export interface DangerDialogProps {
  card: TaskCard | null;
  mutations: BoardMutations;
  onClose: () => void;
}

/** 🔒「执行中 → 异常/失败」的唯一入口（4.5：拖拽落点与卡片菜单都落到这里）。 */
export function StopDialog({ card, mutations, onClose }: DangerDialogProps) {
  // 退场动画接线：Dialog 常驻、`open={!!card}` 受控——card 变 null 时组件不卸载，
  // 让 Dialog 经历 open true→false 过渡帧播 140ms 退场；期间内容仍用末次非空 card。
  const lastCardRef = useRef<TaskCard | null>(null);
  if (card) lastCardRef.current = card;
  const shown = card ?? lastCardRef.current;
  const [reason, setReason] = useState('');
  // 每次真正打开（false→true）清空「原因」输入框，回到空态（与旧的「null→整体卸载」等价）。
  const wasOpenRef = useRef(false);
  if (card && !wasOpenRef.current) setReason('');
  wasOpenRef.current = Boolean(card);
  if (!shown) return null;
  const busy = mutations.stop.isPending;
  const submit = () => {
    mutations.stop.mutate(
      { id: shown.id, reason: reason.trim() || undefined },
      { onSuccess: () => onClose() },
    );
  };
  return (
    <Dialog
      open={Boolean(card)}
      size="form"
      title={`强制停止 ${shown.id}`}
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="danger" loading={busy} onClick={submit}>
            强制停止
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-body text-text-primary">{shown.title}</p>
        {/* 4.3.1 规则 2：平台只吊销租约，不下发中止指令，所以这句话必须出现。 */}
        <p className="rounded-card bg-status-failed-soft px-3 py-2 text-aux text-status-failed">
          {COPY.stopConfirm}
        </p>
        <Field label="停止原因" hint="选填，写入审计与任务时间线">
          <Input
            value={reason}
            maxLength={200}
            placeholder="例如：Agent 已失联"
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        <p className="text-aux text-text-tertiary">
          任务转入「异常/失败」，可移回需求池后由任意 Agent 重新领取；已产生的产物保留。
        </p>
      </div>
    </Dialog>
  );
}

/**
 * 4.3.1 规则 4：物理删除、级联删 runs 与产物、下游立即解除阻塞。
 * N 用卡片自带的 `run_count`，M 要现问 `/dependencies`（20.7 的卡片 DTO 不带下游）。
 */
export function DeleteDialog({ card, mutations, onClose }: DangerDialogProps) {
  // 同 StopDialog：常驻 + open 受控；关闭过渡期间继续用末次非空 card（依赖查询也保留命中该 id 的缓存）。
  const lastCardRef = useRef<TaskCard | null>(null);
  if (card) lastCardRef.current = card;
  const shown = card ?? lastCardRef.current;
  const id = shown?.id ?? '';
  const deps = useQuery({
    queryKey: qk.taskDependencies(id),
    queryFn: () => api.tasks.dependencies(id),
    enabled: id !== '',
    staleTime: 10_000,
  });
  if (!shown) return null;

  const downstream = (deps.data?.blocks ?? []).filter((item) => item.status !== 'DONE').length;
  const busy = mutations.remove.isPending;
  const submit = () => {
    mutations.remove.mutate(shown.id, { onSuccess: () => onClose() });
  };

  return (
    <Dialog
      open={Boolean(card)}
      size="form"
      title={`删除任务 ${shown.id}`}
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="danger" loading={busy} disabled={!deps.data} onClick={submit}>
            确认删除
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-body text-text-primary">{shown.title}</p>
        <p className="text-aux text-text-secondary">{COPY.deleteConfirm(shown.run_count, downstream)}</p>
        {downstream > 0 ? (
          <ul className="flex flex-col gap-1 rounded-card border border-border px-3 py-2">
            {(deps.data?.blocks ?? [])
              .filter((item) => item.status !== 'DONE')
              .slice(0, 5)
              .map((item) => (
                <li key={item.dep_id} className="truncate text-aux text-text-secondary">
                  <span className="font-mono">{item.id}</span> {item.title}
                </li>
              ))}
          </ul>
        ) : null}
        {deps.isError ? (
          <p className="text-aux text-status-failed">
            下游依赖读取失败，仍要继续删除吗？（无法预判解除阻塞的任务数）
          </p>
        ) : null}
        <p className="text-aux text-text-tertiary">删除不可撤销：任务、执行记录、评论与产物一并移除。</p>
      </div>
    </Dialog>
  );
}
