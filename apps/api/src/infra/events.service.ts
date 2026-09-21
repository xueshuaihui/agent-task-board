import { Injectable, Logger } from '@nestjs/common';

/** 13 章 WebSocket 事件表的取值集合。 */
export const WS_EVENTS = [
  'task.created',
  'task.updated',
  'task.moved',
  'task.unblocked',
  'task.deleted',
  'task.archived',
  'run.progress',
  'run.log',
  'lease.expired',
  'notification.created',
  // v0.0.4 W4 §5.6（r3 闭环）：分组归档/反归档，载荷带分组 id（事件只当失效信号）。
  'group.archived',
  'group.unarchived',
  // v0.0.4 W7 §16.3 拆解五条（复用同一 sink，不建第二条通道）。
  'breakdown.started',
  'breakdown.progress',
  'breakdown.task_draft',
  'breakdown.finished',
  'breakdown.cancelled',
  // v0.0.4 W8-a2 §8.7/§16.3 轻确认卡片下发（决策经 REST 回传，终结态卡片靠本地倒计时收敛，
  // 与 PRD 事件表逐行对齐——不私加 resolved 事件）。
  'agent.task_requested',
] as const;

export type WsEventName = (typeof WS_EVENTS)[number];

export interface WsEvent<K extends WsEventName = WsEventName> {
  event: K;
  data: Record<string, unknown>;
  ts: string;
}

/**
 * 服务端只有一个发送方（sidecar），接收方是主窗口的若干连接。
 * 业务层只依赖这个抽象，WebSocket 服务器怎么起、连了几个客户端与业务无关。
 */
@Injectable()
export class EventsService {
  private readonly logger = new Logger('events');
  private readonly sinks = new Set<(event: WsEvent) => void>();

  registerSink(sink: (event: WsEvent) => void): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  emit<K extends WsEventName>(event: K, data: WsEvent<K>['data']): void {
    const payload: WsEvent = { event, data, ts: new Date().toISOString() };
    for (const sink of this.sinks) {
      try {
        sink(payload);
      } catch (error) {
        this.logger.warn(`事件投递失败 ${event}: ${(error as Error).message}`);
      }
    }
  }
}
