import { wsUrl, uiToken } from '@/api/env';
import { WS_EVENT_NAMES } from '@/api/types';
import type { WsEventName, WsEventPayloads, WsFrame } from '@/api/types';

export type WsStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/** 13 章 WS 连接约定的四个数：退避 1s 起、上限 30s、服务端 25s ping、客户端 60s 判死。 */
export const WS_BACKOFF_BASE_MS = 1_000;
export const WS_BACKOFF_MAX_MS = 30_000;
export const WS_SERVER_PING_INTERVAL_MS = 25_000;
export const WS_DEAD_AFTER_MS = 60_000;

export interface WsClientHandlers {
  onEvent: (frame: WsFrame) => void;
  /** `reconnected=true` 时调用方必须做一次全量刷（见 src/ws/invalidate.ts 的理由注释）。 */
  onStatus: (status: WsStatus, info: { reconnected: boolean }) => void;
  onProtocolRejected?: (reason: string) => void;
}


/** 纯 TS、无 React 依赖，便于在 dev 里用一条 `new WsClient(...)` 单独验证重连行为。 */
export class WsClient {
  private socket: WebSocket | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private deadTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private everOpened = false;

  constructor(
    private readonly handlers: WsClientHandlers,
    private readonly url: string = wsUrl(),
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.discard(this.detach());
    this.handlers.onStatus('closed', { reconnected: false });
  }

  /** 手动重连（sidecar 重启后托盘点「重启服务」，壳层可以调它省掉一轮退避）。 */
  restart(): void {
    this.attempt = 0;
    this.clearTimers();
    this.discard(this.detach());
    this.stopped = false;
    this.connect();
  }

  get status(): WsStatus {
    if (this.socket?.readyState === WebSocket.OPEN) return 'open';
    if (this.stopped) return 'idle';
    return this.attempt > 0 ? 'reconnecting' : 'connecting';
  }

  private connect(): void {
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) return;
    this.handlers.onStatus(this.attempt > 0 ? 'reconnecting' : 'connecting', {
      reconnected: false,
    });

    const token = uiToken();
    if (!token) {
      // 没有 Token 就不要再敲网关：握手会 101→401 循环，日志里全是噪音。
      this.scheduleRetry();
      return;
    }

    /**
     * 握手带 Token 的唯一可行通道是子协议：浏览器不给 `Sec-WebSocket-Protocol` 的写入口，
     * 而 13 章认证段禁止把 Token 放进查询参数（会进访问日志）。
     * 只 Offer 一个值、且值就是 Token 本身，是因为按 RFC 6455 服务端必须回选其中一个，
     * 单值让「回什么」没有歧义（网关侧 `handleProtocols` 原样 echo 即可）。
     */
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url, token);
    } catch (error) {
      this.handlers.onProtocolRejected?.((error as Error).message ?? 'WebSocket 构造失败');
      this.scheduleRetry();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      const reconnected = this.everOpened;
      this.everOpened = true;
      this.attempt = 0;
      this.armDeadTimer();
      this.handlers.onStatus('open', { reconnected });
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      // 任何入站**数据帧**都是存活证据：服务端每 25 秒随 ping 发一条 heartbeat，浏览器收得到数据帧
      // 却看不到控制帧，所以 60 秒死线只能这么喂（心跳在 parseFrame 里被丢弃，不进失效表）。
      this.armDeadTimer();
      const frame = parseFrame(event.data);
      if (!frame) return;
      this.handlers.onEvent(frame);
    };

    socket.onerror = () => {
      /* onclose 里统一处理，error 事件不带可行动信息 */
    };

    socket.onclose = (event: CloseEvent) => {
      const wasRequested = this.stopped;
      this.socket = null;
      this.clearDeadTimer();
      if (wasRequested) {
        this.handlers.onStatus('closed', { reconnected: false });
        return;
      }
      if (event.code === 1002 || event.code === 1005 || event.reason.includes('protocol')) {
        this.handlers.onProtocolRejected?.(event.reason || `握手被拒（code ${event.code}）`);
      }
      this.scheduleRetry();
    };
  }

  /** 指数退避 1s → 2s → 4s …… 上限 30s（13 章）。 */
  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = Math.min(WS_BACKOFF_BASE_MS * 2 ** this.attempt, WS_BACKOFF_MAX_MS);
    this.attempt += 1;
    this.handlers.onStatus('reconnecting', { reconnected: false });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * 60 秒收不到任何消息即判定断开。
   *
   * 判死后**必须**自己排重连，不能指望 `close()` 触发的 `onclose`：半开连接（对端已经没了）
   * 可能迟迟不发关闭帧，那一刻 socket 上还挂着处理函数，早到的 heartbeat 又会把死线重置。
   * 所以这里摘掉处理函数、丢掉旧连接，然后直接把状态交给 `scheduleRetry()`。
   */
  private armDeadTimer(): void {
    this.clearDeadTimer();
    this.deadTimer = setTimeout(() => {
      this.deadTimer = null;
      this.discard(this.detach());
      this.scheduleRetry();
    }, WS_DEAD_AFTER_MS);
  }

  private clearDeadTimer(): void {
    if (this.deadTimer) {
      clearTimeout(this.deadTimer);
      this.deadTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearDeadTimer();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private detach(): WebSocket | null {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
    }
    return socket;
  }

  /**
   * 关掉一条已经不属于本客户端的连接（处理函数已由 detach() 摘掉，所以不会回调进来）。
   *
   * CONNECTING 时直接 close() 会让浏览器打一条「WebSocket is closed before the connection is
   * established」错误——StrictMode 双挂载下每进页面必现，看起来像故障。这里等它开起来再关；
   * 握手失败的话连接自己就没了，两种情况都不留悬挂 socket。
   */
  private discard(socket: WebSocket | null): void {
    if (!socket) return;
    if (socket.readyState === WebSocket.CONNECTING) {
      socket.addEventListener('open', () => this.discard(socket));
      return;
    }
    try {
      socket.close();
    } catch {
      /* 已经 CLOSE 了 */
    }
  }
}

/** 心跳帧容忍：服务端 ping/pong 不是业务事件，不能进失效表。 */
const HEARTBEAT_NAMES = new Set<string>(['ping', 'pong', 'heartbeat']);

function parseFrame(raw: string): WsFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const name = (record.event ?? record.type) as string | undefined;
  if (!name || HEARTBEAT_NAMES.has(name)) return null;
  if (!isWsEventName(name)) return null;
  // 帧是外部输入：`event` 与 `data` 的配对由服务端保证，这里只保证不认识的名字进不来。
  return {
    event: name,
    data: (record.data ?? {}) as WsEventPayloads[typeof name],
    ts: typeof record.ts === 'string' ? record.ts : '',
  } as WsFrame<typeof name>;
}

/** 载荷里带什么由服务端决定，前端只认这份名单（`apps/api/src/infra/events.service.ts` 的镜像）。 */
export function isWsEventName(name: string): name is WsEventName {
  return (WS_EVENT_NAMES as readonly string[]).includes(name);
}
