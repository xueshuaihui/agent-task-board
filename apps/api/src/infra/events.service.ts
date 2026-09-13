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
