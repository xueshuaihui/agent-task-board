import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WsClient, type WsStatus } from '../client';

/**
 * 实时连接状态机（issue「连接状态丢失」）。
 *
 * 这条用例锁的是顶栏连接角标依赖的那条链：`WsClient` 把每一条状态变化经 `onStatus`
 * 抛给 provider（provider 再 `setStatus`）。离线环境下没有真 WS，于是用假 socket
 * 手动点火：open/close 由测试触发，退避定时器用假时钟推进。
 *
 * 重点在最后一条：**旧连接的迟到回调不许改动当前状态**——否则新连接已经 open 的情况下
 * 顶栏会掉回「重连中」，用户看到就是一个「连接状态丢了」的界面。
 */

type CloseEventLike = { code: number; reason: string };

/** 最小 WebSocket 替身：只实现 WsClient 用到的构造、readyState、四个回调与 close()。 */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: CloseEventLike) => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocol: string,
  ) {
    FakeSocket.instances.push(this);
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }

  /** 模拟握手成功。 */
  fireOpen(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  /** 模拟服务端/网络侧断开（1006 = 异常关闭，不需要客户端先 close）。 */
  fireClose(code = 1006, reason = ''): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

let statuses: WsStatus[];

function client(): WsClient {
  return new WsClient(
    {
      onEvent: () => {},
      onStatus: (status) => statuses.push(status),
    },
    'ws://127.0.0.1:7788/ws',
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  statuses = [];
  // uiToken() 读 window 注入值（9.4.1）：长度 ≥32 才算有效，否则 WsClient 直接排重连、不建连。
  vi.stubGlobal('window', { __ATB_UI_TOKEN__: 'a'.repeat(40) });
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('WsClient 状态机', () => {
  it('start → connecting → open；掉线后 reconnecting，退避到点自动重建并回到 open', () => {
    const ws = client();
    ws.start();
    expect(statuses).toEqual(['connecting']);

    const first = FakeSocket.instances[0]!;
    expect(first.protocol).toBe('a'.repeat(40));
    first.fireOpen();
    expect(statuses.at(-1)).toBe('open');
    expect(ws.status).toBe('open');

    first.fireClose();
    expect(statuses.at(-1)).toBe('reconnecting');

    // 13 章退避：首次 1s。
    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.instances).toHaveLength(2);

    FakeSocket.instances[1]!.fireOpen();
    expect(statuses.at(-1)).toBe('open');
    // 第二条 open 带 reconnected=true：provider 据此触发一次全量刷（断线期间的事件不补发）。
    expect(statuses.filter((status) => status === 'open')).toHaveLength(2);
  });

  it('旧连接的迟到 close 回调不覆盖当前连接的状态（连接还在，状态不能掉）', () => {
    const ws = client();
    ws.start();
    const first = FakeSocket.instances[0]!;
    first.fireOpen();
    // 捕获旧回调后再重连：真实浏览器里这条回调可能已经排进事件队列。
    const staleClose = first.onclose!;

    ws.restart();
    const second = FakeSocket.instances[1]!;
    second.fireOpen();
    expect(ws.status).toBe('open');

    staleClose({ code: 1006, reason: '' });

    expect(ws.status).toBe('open');
    expect(statuses.at(-1)).toBe('open');
  });

  it('没有 UI Token 时不敲网关：不建 socket，状态停在 reconnecting 等注入', () => {
    vi.stubGlobal('window', {});
    const ws = client();
    ws.start();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(statuses).toEqual(['connecting', 'reconnecting']);
  });
});
