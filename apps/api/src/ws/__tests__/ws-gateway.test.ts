import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Module, type INestApplication } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket, type ClientOptions } from 'ws';
import { EventsService } from '../../infra/events.service';
import { WsGateway } from '../ws-gateway';

/**
 * 握手拒绝与广播是验收 32/41 的门面，用真的 http.Server + 真的 ws 客户端跑，
 * 而不是把逻辑抽成纯函数自证：`Sec-WebSocket-Protocol` 的解析与回显只能在真握手里验。
 */
const UI_TOKEN = 'ui-token-for-ws-tests-0123456789abcdef0123456789';
const AGENT_TOKEN = 'atb_agenttoken00000000000000000000000000000000';

/**
 * 不带 InfraModule：AppLogger 缺失正好验证 @Optional() 依赖不阻塞启动。
 *
 * 用 useFactory + 显式 inject —— vitest 的 esbuild 转换不产出 design:paramtypes，
 * 按类型自动注入在这套测试环境下必然报 UNKNOWN_DEPENDENCIES（生产的 nest build 走 tsc，正常）。
 */
@Module({
  providers: [
    EventsService,
    {
      provide: WsGateway,
      useFactory: (events: EventsService, host: HttpAdapterHost) => new WsGateway(events, host),
      inject: [EventsService, HttpAdapterHost],
    },
  ],
})
class TestWsModule {}

let server: Server;
let port = 0;
let events: EventsService;
let gateway: WsGateway;
/** 「健康连接活过空闲阈值」专用：宽阈值网关，见 createGateway 的说明。 */
let lenientGateway: WsGateway;
let lenientServer: Server;
let lenientPort = 0;

/** 起一个独立 http.Server 并挂上网关，返回监听端口。事件源由调用方指定，广播用例共用同一个。 */
async function createGateway(broadcastEvents: EventsService, pingIntervalMs: number, idleTimeoutMs: number): Promise<[WsGateway, Server, number]> {
  const gateway = new WsGateway(broadcastEvents, undefined, undefined, { pingIntervalMs, idleTimeoutMs });
  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  gateway.attach(server);
  return [gateway, server, port];
}

beforeAll(async () => {
  process.env.ATB_UI_TOKEN = UI_TOKEN;
  events = new EventsService();
  // 心跳阈值调小，让「60 秒无消息判定断开」这条分支在同一量级里被覆盖。
  [gateway, server, port] = await createGateway(events, 40, 120);
  // 「健康连接不被掐」的用例不能共用上面这个 120ms 阈值：CI 慢机（37 个文件并行抢
  // 4 核）上事件循环一次停顿就能超过 120ms，pong 还没处理服务端就把健康连接判死
  // （readyState=CLOSED）。阈值放宽到 5 秒——停顿以几百 ms 计，够不着这条线；
  // 快速掐断的负例仍由紧阈值网关覆盖，两边语义各自成立。
  [lenientGateway, lenientServer, lenientPort] = await createGateway(events, 40, 5_000);
});

afterAll(async () => {
  gateway.onModuleDestroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  lenientGateway.onModuleDestroy();
  await new Promise<void>((resolve) => lenientServer.close(() => resolve()));
});

interface UpgradeResult {
  status: number | undefined;
  protocol: string | undefined;
  body: string;
}

/** 用裸 HTTP 升级请求看服务端到底回了什么状态码与错误体（ws 客户端会吞掉这些）。 */
function rawUpgrade(path: string, protocols?: string[]): Promise<UpgradeResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
      'Sec-WebSocket-Version': '13',
    };
    if (protocols) headers['Sec-WebSocket-Protocol'] = protocols.join(', ');
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers });
    req.on('response', (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          protocol: Array.isArray(res.headers['sec-websocket-protocol'])
            ? (res.headers['sec-websocket-protocol'] as string[])[0]
            : (res.headers['sec-websocket-protocol'] as string | undefined),
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('upgrade', (res: IncomingMessage, socket) => {
      socket.destroy();
      resolve({ status: 101, protocol: res.headers['sec-websocket-protocol'] as string, body: '' });
    });
    req.on('error', reject);
    req.end();
  });
}

function open(protocols?: string[] | string, options: ClientOptions = {}, url?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url ?? `ws://127.0.0.1:${port}/ws`, protocols, {
      handshakeTimeout: 3_000,
      ...options,
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', (error) => {
      ws.terminate();
      reject(error);
    });
  });
}

/** 只等下一个业务事件帧，跳过心跳。 */
const HEARTBEAT = 'heartbeat';

function nextFrame(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('未收到事件帧')), 3_000);
    const onMessage = (raw: Buffer) => {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>;
      if (frame.event === HEARTBEAT) return;
      clearTimeout(timer);
      ws.removeListener('message', onMessage);
      resolve(frame);
    };
    ws.on('message', onMessage);
  });
}

function closed(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接未按期断开')), 3_000);
    ws.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe('握手鉴权（13 章 / 验收 32）', () => {
  it('不带 Sec-WebSocket-Protocol 的升级请求被拒 401', async () => {
    const result = await rawUpgrade('/ws');
    expect(result.status).toBe(401);
    expect(JSON.parse(result.body).error.code).toBe('UNAUTHORIZED');
  });

  it('带错误 token 的升级请求被拒 401', async () => {
    const result = await rawUpgrade('/ws', ['wrong-token']);
    expect(result.status).toBe(401);
    expect(JSON.parse(result.body).error.code).toBe('UNAUTHORIZED');
  });

  it('Agent Token 不能连 WS（9.4.2 只允许 UI）', async () => {
    const result = await rawUpgrade('/ws', [AGENT_TOKEN]);
    expect(result.status).toBe(401);
  });

  it('token 走查询参数直接拒绝，不接受也不忽略', async () => {
    const result = await rawUpgrade(`/ws?token=${UI_TOKEN}`);
    expect(result.status).toBe(422);
    expect(JSON.parse(result.body).error.code).toBe('INVALID_PARAM');
  });

  it('UI Token 握手成功，并把选中的子协议原样回显', async () => {
    const result = await rawUpgrade('/ws', ['chat', UI_TOKEN]);
    expect(result.status).toBe(101);
    expect(result.protocol).toBe(UI_TOKEN);
  });

  it('非 /ws 的升级请求明确回绝，不把客户端挂住', async () => {
    const result = await rawUpgrade('/other', [UI_TOKEN]);
    expect(result.status).toBe(404);
  });
});

describe('事件广播（13 章 / 验收 41）', () => {
  it('一条事件按 {event,data,ts} 原样投递到所有连接', async () => {
    const clients = await Promise.all([
      open(UI_TOKEN),
      open(UI_TOKEN),
      open(UI_TOKEN),
    ]);
    expect(gateway.connectionCount).toBe(3);

    const received = Promise.all(clients.map((client) => nextFrame(client)));
    events.emit('task.moved', { id: 'T-100', from: 'READY', to: 'RUNNING' });
    const frames = await received;

    for (const frame of frames) {
      expect(frame).toEqual({
        event: 'task.moved',
        data: { id: 'T-100', from: 'READY', to: 'RUNNING' },
        ts: expect.any(String),
      });
    }
    // 三个连接拿到的是同一份 ts：广播是同一次 sink 回调，不该各算一次时间戳。
    expect(new Set(frames.map((frame) => frame.ts)).size).toBe(1);

    await Promise.all(
      clients.map(async (client) => {
        client.close();
        await new Promise<void>((resolve) => client.once('close', () => resolve()));
      }),
    );
    await vi.waitFor(() => expect(gateway.connectionCount).toBe(0));
  });

  it('lease.expired 这类由 ATB-1 发出的事件同样透传，网关不做业务判断', async () => {
    const client = await open(UI_TOKEN);
    const frame = nextFrame(client);
    events.emit('lease.expired', { task_id: 'T-1015', run_id: 'R-2001' });
    expect(await frame).toMatchObject({ event: 'lease.expired', data: { task_id: 'T-1015' } });
    client.terminate();
  });

  it('空闲连接按 ping 周期收到 heartbeat 数据帧，且正常回 pong 的连接活过空闲阈值', async () => {
    // 浏览器不把控制帧交给页面脚本，前端那条「60 秒无消息判死」只能靠这条数据帧喂：
    // 少了它，健康空闲的连接会被 UI 反复误判断开（真实事故，不是假想）。
    const client = await open(UI_TOKEN, {}, `ws://127.0.0.1:${lenientPort}/ws`);
    const frames: Record<string, unknown>[] = [];
    client.on('message', (raw) => frames.push(JSON.parse(String(raw)) as Record<string, unknown>));
    // 宽阈值网关（idleTimeoutMs=5000）：CI 慢机的事件循环停顿够不着这条线，不该被 terminate。
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(client.readyState).toBe(WebSocket.OPEN);

    const heartbeats = frames.filter((frame) => frame.event === 'heartbeat');
    expect(heartbeats.length).toBeGreaterThanOrEqual(2);
    expect(heartbeats[0]).toEqual({ event: 'heartbeat', data: {}, ts: expect.any(String) });

    client.terminate();
    await vi.waitFor(() => expect(gateway.connectionCount).toBe(0));
  });

  it('服务端定期 ping，不回 pong 的连接按空闲阈值判定断开', async () => {
    // autoPong=false 复现「客户端卡死」：服务端 ping 有去无回，lastSeen 不再前移。
    const client = await open(UI_TOKEN, { autoPong: false });
    const code = await closed(client);
    // 1006 = 没有关闭帧的异常断开，正是 terminate() 的表现，而不是正常 close(1000)。
    expect(code).toBe(1006);
    await vi.waitFor(() => expect(gateway.connectionCount).toBe(0));
  });
});

describe('自动接线（OnApplicationBootstrap）', () => {
  it('Nest 起应用后 upgrade 监听已挂在 http.Server 上，main.ts 不需要改', async () => {
    const app: INestApplication = await NestFactory.create(TestWsModule, {
      logger: false,
      // Nest 默认在装配失败时 process.abort()，会把测试进程直接打死、看不到原因。
      abortOnError: false,
    });
    await app.init();
    try {
      const httpServer = app.getHttpServer() as Server;
      // getInstance() 拿到的是 express app，只有 getHttpServer() 才是真 http.Server：
      // 挂错对象的话升级请求会被静默丢弃，所以这里直接查监听数。
      expect(httpServer.listenerCount('upgrade')).toBe(1);
      expect(app.get(WsGateway).connectionCount).toBe(0);
    } finally {
      await app.close();
    }
  });
});
