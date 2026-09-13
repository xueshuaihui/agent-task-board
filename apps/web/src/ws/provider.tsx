import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { onUnauthorized } from '@/api/client';
import type { WsEventName, WsEventPayloads, WsFrame } from '@/api/types';
import { useUnreadStore } from '@/app/store/unread';
import { WsClient, type WsStatus } from './client';
import { applyEvent, refreshAfterReconnect } from './invalidate';

/**
 * 单一 WS 连接挂在整个应用上（不是每个页面一条）：sidecar 只对 UI 开一条 `/ws`，
 * 多开就是成倍的连接数与心跳。
 */
interface WsContextValue {
  status: WsStatus;
  /** 手动重连（例如托盘「重启服务」后立刻恢复）。 */
  reconnect: () => void;
  subscribe: (names: readonly WsEventName[], handler: WsHandler) => () => void;
}

type WsHandler = (frame: WsFrame) => void;

const WsContext = createContext<WsContextValue | null>(null);

export function WSProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<WsStatus>('idle');
  const listeners = useRef(new Map<WsHandler, Set<string>>());
  const clientRef = useRef<WsClient | null>(null);

  const subscribe = useCallback((names: readonly WsEventName[], handler: WsHandler) => {
    const set = listeners.current.get(handler) ?? new Set<string>();
    for (const name of names) set.add(name);
    listeners.current.set(handler, set);
    return () => {
      listeners.current.delete(handler);
    };
  }, []);

  useEffect(() => {
    const client = new WsClient({
      onEvent: (frame) => {
        applyEvent(queryClient, frame);
        for (const [handler, names] of listeners.current) {
          if (names.has(frame.event)) handler(frame);
        }
      },
      onStatus: (next, info) => {
        setStatus(next);
        if (next === 'open' && info.reconnected) {
          // 断线期间的事件不会补发，漏一条就永久错位，所以只在这里补一次全量。
          refreshAfterReconnect(queryClient);
        }
      },
    });
    clientRef.current = client;
    client.start();
    return () => {
      client.stop();
      clientRef.current = null;
    };
  }, [queryClient]);

  // 401 = 注入的 Token 与 sidecar 手里的不是同一个（多半是 sidecar 重启过）。
  useEffect(
    () =>
      onUnauthorized(() => {
        setStatus('reconnecting');
      }),
    [],
  );

  const value = useMemo<WsContextValue>(
    () => ({
      status,
      reconnect: () => clientRef.current?.restart(),
      subscribe,
    }),
    [status, subscribe],
  );

  return <WsContext.Provider value={value}>{children}</WsContext.Provider>;
}

export function useWS(): WsContextValue {
  const value = useContext(WsContext);
  if (!value) throw new Error('WSProvider 未挂载：useWS() 必须在 <WSProvider> 内使用');
  return value;
}

export function useWSStatus(): WsStatus {
  return useWS().status;
}

/**
 * 订阅入口（各 feature 声明「哪些事件要我」）。
 * 只用于**渲染态**：卡片高亮、租约倒计时变红、日志块追加提示。
 * 数据失效由 `src/ws/invalidate.ts` 统一负责，这里不要再写 invalidateQueries。
 */
export function useWSEvent<K extends WsEventName>(
  names: readonly K[],
  handler: (frame: { event: K; data: WsEventPayloads[K]; ts: string }) => void,
): void {
  const { subscribe } = useWS();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const namesRef = useRef(names);
  namesRef.current = names;
  // 订阅用 names 的字符串指纹做键：调用方每次渲染都传新数组字面量，直接依赖 names 就是每帧重订。
  const key = names.join(',');

  useEffect(() => {
    const dispatch: WsHandler = (frame) => {
      if (!namesRef.current.includes(frame.event as K)) return;
      handlerRef.current(frame as { event: K; data: WsEventPayloads[K]; ts: string });
    };
    return subscribe(namesRef.current, dispatch);
  }, [subscribe, key]);
}

/** 断线提示条：只有非 open 且已经有过一轮重连时才显示，避免首帧闪一下。 */
export function useWSWarning(): { visible: boolean; text: string } {
  const status = useWSStatus();
  return useMemo(() => {
    if (status === 'open' || status === 'idle') return { visible: false, text: '' };
    return {
      visible: true,
      text: status === 'reconnecting' ? '实时连接已断开，正在重连…' : '实时连接已断开',
    };
  }, [status]);
}

/** 角标读点：顶栏与（阶段二的）任何地方都从 store 取，不再各发一次请求。 */
export function useUnreadCount(): number {
  return useUnreadStore((state) => state.count);
}
