import { Inject, Injectable, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { STATUS_CODES } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { constantTimeEqual } from '../common/ui-token';
import { ApiException } from '../contract/errors';
import { verifyJwt } from '../auth/jwt';
import { PrismaService } from '../infra/prisma.service';
import { AppLogger } from '../infra/logger';
import { EventsService, type WsEvent } from '../infra/events.service';

export const WS_GATEWAY_OPTIONS = 'ATB_WS_GATEWAY_OPTIONS';

export interface WsGatewayOptions {
  /** 升级路径，13 章固定 `/ws`（9.4.2 通道表）。 */
  path?: string;
  /** 13 章：服务端每 25 秒 ping 一次。 */
  pingIntervalMs?: number;
  /**
   * 网关侧的死连接阈值：这么久没有 pong/消息就 terminate 该连接。
   * 13 章那个「60 秒」原话是写给客户端的，两侧取同一个数、方向相反。
   */
  idleTimeoutMs?: number;
  /** UI 不发消息，心跳帧几十字节；上限只是防御性收口。 */
  maxPayloadBytes?: number;
}

/** 13 章默认值，测试会传小值得以覆盖心跳分支。 */
const DEFAULTS: Required<Pick<WsGatewayOptions, 'path' | 'pingIntervalMs' | 'idleTimeoutMs' | 'maxPayloadBytes'>> = {
  path: '/ws',
  pingIntervalMs: 25_000,
  idleTimeoutMs: 60_000,
  maxPayloadBytes: 8_192,
};

/** 只查询参数里可能出现的凭证键名，命中即拒绝（13 章：不用查询参数）。 */
const QUERY_TOKEN_KEYS = /^(token|atb_ui_token|access_token|authorization)$/i;

/**
 * 心跳数据帧的事件名：**不在** 13 章十个事件的名单里，前端 `parseFrame` 按心跳丢弃、不进失效表。
 * 它的唯一作用是给客户端那条「60 秒无消息即判定断开」的死线喂证据。
 */
const HEARTBEAT_EVENT = 'heartbeat';

/**
 * 13 章 WebSocket 网关：`noServer` 模式挂在 sidecar 已有的 http.Server 上，
 * 与 REST / MCP 共用 7788 端口（9.4.2 三条通道）。
 *
 * 它只是 EventsService 的一个 sink：业务层不感知有几个连接，
 * 网关也不感知是谁发的事件——扇出抽象在 infra/events.service.ts 里已经收口。
 */
@Injectable()
export class WsGateway implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly path: string;
  private readonly pingIntervalMs: number;
  private readonly idleTimeoutMs: number;

  /** 每个连接最后一次收到消息（含 pong）的时刻，用于 60 秒空闲判定。 */
  private readonly lastSeenAt = new Map<WebSocket, number>();
  private readonly server: WebSocketServer;
  private httpServer: Server | null = null;
  private upgradeListener: ((req: IncomingMessage, socket: Duplex, head: Buffer) => void) | null = null;
  private unregisterSink: (() => void) | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  /** 握手鉴权通过后暂存的回显子协议（handleProtocols 在 handleUpgrade 内同步读取）。 */
  private acceptedProtocol: string | false = false;
  /** JWT secret 惰性缓存：env 优先，其次 settings.jwt_secret（与 AuthGuard 同一来源）。 */
  private jwtSecret: string | null = null;

  constructor(
    private readonly events: EventsService,
    @Optional() private readonly adapterHost?: HttpAdapterHost,
    @Optional() private readonly logger?: AppLogger,
    @Optional() @Inject(WS_GATEWAY_OPTIONS) options?: WsGatewayOptions,
    @Optional() private readonly prisma?: PrismaService,
  ) {
    this.path = options?.path ?? DEFAULTS.path;
    this.pingIntervalMs = options?.pingIntervalMs ?? DEFAULTS.pingIntervalMs;
    this.idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs;
    this.server = new WebSocketServer({
      noServer: true,
      clientTracking: true,
      perMessageDeflate: false,
      maxPayload: options?.maxPayloadBytes ?? DEFAULTS.maxPayloadBytes,
      // 浏览器 `new WebSocket(url, [token])` 会把 token 当作子协议提交，
      // 必须原样回显选中的那个，否则握手在客户端被判失败。
      handleProtocols: () => this.pickUiProtocol(),
    });
  }

  get connectionCount(): number {
    return this.server.clients.size;
  }

  /**
   * 接线优先自动完成：http.Server 在 `NestFactory.create()` 里就已建好，
   * 在 bootstrap 钩子上挂 upgrade 监听早于 listen()，因此 main.ts 无需改动。
   * 拿不到实例（非 express 适配器、或用了独立 http.Server）时，由外部调 attach()。
   */
  onApplicationBootstrap(): void {
    this.registerSink();
    const instance = this.adapterHost?.httpAdapter?.getHttpServer?.();
    if (instance) {
      this.attach(instance as unknown as Server);
      return;
    }
    this.warn('未能从 HttpAdapterHost 取到 http.Server，需要在 main.ts 里调用 WsGateway.attach(server)');
  }

  onModuleDestroy(): void {
    this.detach();
    this.unregisterSink?.();
    this.unregisterSink = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const client of this.server.clients) client.terminate();
    this.server.close();
  }

  /** 显式接线入口：幂等，重复传同一个 server 不会挂两个监听。 */
  attach(server: Server): void {
    this.registerSink();
    if (this.httpServer === server) return;
    this.detach();
    this.upgradeListener = (req, socket, head) => {
      void this.onUpgrade(req, socket, head).catch(() => {
        // 鉴权里的 DB 异常按拒绝处理，不让 upgrade 通道挂死。
        if (!socket.destroyed) socket.destroy();
      });
    };
    server.on('upgrade', this.upgradeListener);
    this.httpServer = server;
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => this.tick(), this.pingIntervalMs);
      // 定时器不该单独撑起事件循环：否则测试进程与优雅退出都会被拖住。
      this.heartbeat.unref();
    }
  }

  detach(): void {
    if (this.httpServer && this.upgradeListener) {
      this.httpServer.removeListener('upgrade', this.upgradeListener);
    }
    this.httpServer = null;
    this.upgradeListener = null;
  }

  private registerSink(): void {
    if (this.unregisterSink) return;
    this.unregisterSink = this.events.registerSink((event) => this.broadcast(event));
  }

  // ------------------------------------------------------------------ 握手

  private async onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = req.url ?? '';
    const pathname = url.split('?')[0] ?? '';
    if (pathname !== this.path) {
      // 监听器已接管 upgrade：不认识的升级请求必须明确回绝，否则客户端挂在那里。
      return this.reject(socket, new ApiException('NOT_FOUND', `不支持的升级路径 ${pathname}`));
    }
    const query = new URL(url, 'http://127.0.0.1').searchParams;
    for (const key of query.keys()) {
      // Token 进查询参数会落到访问日志与进程列表里，13 章明令禁止，这里直接拒绝而不是忽略。
      if (QUERY_TOKEN_KEYS.test(key)) {
        return this.reject(
          socket,
          new ApiException('INVALID_PARAM', 'WS 不接受查询参数携带凭证，请在 Sec-WebSocket-Protocol 中提交 UI 会话 Token'),
        );
      }
    }
    const offered = parseProtocols(req.headers['sec-websocket-protocol']);
    // 0919：UI 会话凭证现在是「静态 Token（旧桌面壳兼容）或账号 JWT」两空间，
    // 鉴权通过的那个子协议原样回显，否则客户端判握手失败。
    const accepted = await this.matchUiCredential(offered);
    if (!accepted) {
      return this.reject(
        socket,
        new ApiException('UNAUTHORIZED', 'WS 握手未通过 UI 会话 Token 校验（仅 UI 可连接，Agent Token 不适用）'),
      );
    }
    this.acceptedProtocol = accepted;
    this.server.handleUpgrade(req, socket, head, (ws) => {
      this.acceptedProtocol = false;
      this.track(ws);
    });
  }

  /** 返回通过的凭证（原样回显给客户端），都不通过时返回 false。 */
  private async matchUiCredential(offered: string[]): Promise<string | false> {
    if (offered.length === 0) return false;
    const uiToken = process.env.ATB_UI_TOKEN ?? '';
    for (const protocol of offered) {
      if (uiToken && constantTimeEqual(protocol, uiToken)) return protocol;
    }
    // Agent Token 与 UI 凭证是两个空间：JWT 校验失败自然把 Agent 连接挡在门外。
    const secret = await this.resolveJwtSecret();
    if (!secret) return false;
    for (const protocol of offered) {
      const payload = verifyJwt(protocol, secret);
      if (!payload) continue;
      const account = this.prisma
        ? await this.prisma.account.findUnique({ where: { id: payload.sub } })
        : null;
      if (account && account.status === 'ACTIVE') return protocol;
      return false;
    }
    return false;
  }

  private async resolveJwtSecret(): Promise<string> {
    if (this.jwtSecret) return this.jwtSecret;
    const fromEnv = process.env.ATB_JWT_SECRET ?? '';
    if (fromEnv) {
      this.jwtSecret = fromEnv;
      return fromEnv;
    }
    const row = this.prisma
      ? await this.prisma.setting.findUnique({ where: { key: 'jwt_secret' } })
      : null;
    this.jwtSecret = row?.value ?? '';
    return this.jwtSecret;
  }

  private pickUiProtocol(): string | false {
    return this.acceptedProtocol;
  }

  private reject(socket: Duplex, error: ApiException): void {
    if (socket.destroyed) return;
    const body = Buffer.from(JSON.stringify(error.toBody()), 'utf8');
    const head = [
      `HTTP/1.1 ${error.status} ${STATUS_CODES[error.status] ?? 'Unauthorized'}`,
      'Content-Type: application/json; charset=utf-8',
      'Content-Length: ' + String(body.byteLength),
      'Connection: close',
      '',
      '',
    ].join('\r\n');
    socket.end(Buffer.concat([Buffer.from(head, 'ascii'), body]));
    socket.destroy();
  }

  // ------------------------------------------------------------------ 连接

  private track(ws: WebSocket): void {
    this.lastSeenAt.set(ws, Date.now());
    ws.on('pong', () => this.lastSeenAt.set(ws, Date.now()));
    ws.on('message', () => {
      // UI 侧没有上行指令（数据操作一律走 REST，9.4.2 边界原则）；能收到任何帧就算活着。
      this.lastSeenAt.set(ws, Date.now());
    });
    ws.on('close', () => this.lastSeenAt.delete(ws));
    ws.on('error', () => this.drop(ws));
  }

  /** sink 回调是同步的：单个连接写失败只踢那一个连接，不能连带影响其他连接与业务侧 emit。 */
  private broadcast(event: WsEvent): void {
    const frame = JSON.stringify(event);
    for (const client of this.server.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      client.send(frame, (error) => {
        if (error) this.drop(client);
      });
    }
  }

  private drop(ws: WebSocket): void {
    this.lastSeenAt.delete(ws);
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
  }

  /**
   * 13 章心跳：空闲超阈值先断开，其余一条 ping + 一条 `heartbeat` 数据帧。
   *
   * 两条线方向不同，缺一不可：ping 是**服务端**判客户端死（无 pong 则 `lastSeenAt` 不前移）；
   * 数据帧是**客户端**那条「60 秒无消息」死线的唯一喂法——浏览器不把控制帧交给页面的
   * `onmessage`，只发 ping 会让健康空闲的连接被前端反复误判断开。
   */
  private tick(): void {
    const now = Date.now();
    for (const client of this.server.clients) {
      const seen = this.lastSeenAt.get(client);
      if (seen === undefined) this.lastSeenAt.set(client, now);
      else if (now - seen > this.idleTimeoutMs) {
        this.lastSeenAt.delete(client);
        client.terminate();
        continue;
      }
      if (client.readyState !== WebSocket.OPEN) continue;
      client.ping();
      client.send(
        JSON.stringify({
          event: HEARTBEAT_EVENT,
          data: {},
          ts: new Date(now).toISOString(),
        }),
        (error) => {
          if (error) this.drop(client);
        },
      );
    }
  }

  private warn(message: string): void {
    if (this.logger) this.logger.warn(message, 'ws');
  }
}

/** `Sec-WebSocket-Protocol` 可能是逗号分隔的单值，也可能是数组。 */
function parseProtocols(header: string | string[] | undefined): string[] {
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
