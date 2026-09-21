import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence } from 'motion/react';
import { useCreationRequests } from './queries';
import { useCreationStore } from './store';
import { CreationCard } from './creation-card';
import { AgentUndoStack, useAgentUndoStore } from './agent-undo-stack';
import { useWSEvent } from '@/ws';

/**
 * v0.0.4 W8 §8.4 轻确认卡片的宿主：右下角全局浮层，一条栈挂整个应用（挂 `OverlaySlot`）。
 *
 * 为什么不是路由也不是通知中心里的一个条目：PRD §8.4/§14 两处都写明「位置=右下角、不抢占焦点」，
 * 且 §14 组件表把「轻确认卡片」单列为「全局浮层组件」——通知中心是左出面板、要用户主动打开，
 * 30 秒的决策窗口等不到用户点铃铛。通知中心那侧仍然由后端 `creation_request` 通知承担留痕
 * （W9 已按 kind 白名单预留「待处理」归类）。
 *
 * 层级给 z-45：低于 Radix 弹窗（z-50，避免编辑框被卡片压住），高于通知中心（z-40）。
 * 容器 `pointer-events-none`、卡片自己 `pointer-events-auto`：空白区域不挡看板操作。
 */
export function CreationRequestHost() {
  const cards = useCreationStore((state) => state.cards);
  const undoEntries = useAgentUndoStore((state) => state.entries);
  const upsert = useCreationStore((state) => state.upsert);
  const upsertMany = useCreationStore((state) => state.upsertMany);
  const list = useCreationRequests();

  // 卡片本体：WS `agent.task_requested` 直接带 CreationRequestView（见 ws/invalidate.ts 的例外注释）。
  useWSEvent(['agent.task_requested'], ({ data }) => upsert(data));

  // 断线重连补齐：`refreshAfterReconnect` 失效 `qk.creationRoot` → 这条 GET 重取。
  // 只收未决项——服务端列表混着的近期终结项属于历史，重启后不该在右下角复活。
  useEffect(() => {
    const items = list.data;
    if (!items) return;
    upsertMany(items.filter((item) => item.status === 'pending'));
  }, [list.data, upsertMany]);

  if (cards.length === 0 && undoEntries.length === 0) return null;

  return createPortal(
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[45] flex flex-col items-end gap-2"
      role="region"
      aria-label="Agent 创建任务待确认"
    >
      <AnimatePresence initial={false}>
        {cards.map((card) => (
          <CreationCard key={card.request_id} card={card} />
        ))}
      </AnimatePresence>
      {/* §8.6（W8-a4）：agent direct/silent 直建的 5 秒撤销浮层，与决策卡片同栈同语汇。 */}
      <AgentUndoStack />
    </div>,
    document.body,
  );
}
