import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '../../auth/auth.guard';
import { AccountsController } from '../../auth/accounts.controller';
import { AccountsService } from '../../auth/accounts.service';
import { PrismaService } from '../../infra/prisma.service';
import { MarketController } from '../../market/market.controller';
import { MarketService } from '../../market/market.service';

/**
 * vitest 走 esbuild 转译，不实现 `emitDecoratorMetadata`，`design:paramtypes` 恒为空，
 * Nest 在第一个带构造注入的类上就会拿到 undefined。这里在 create() 之前把构造参数表
 * 补回 reflect 元数据；`declare()` 用形参个数对账防漂移（与 apps/api 的 nest-di-shim 同一套约定）。
 */
type InjectableClass = abstract new (...args: never[]) => unknown;

let applied = false;

export function applyDiShim(): void {
  if (applied) return;
  applied = true;
  declare(AccountsService, [PrismaService]);
  declare(AccountsController, [AccountsService]);
  declare(AuthGuard, [Reflector, PrismaService]);
  declare(MarketService, [PrismaService]);
  declare(MarketController, [MarketService]);
}

function declare(cls: InjectableClass, tokens: unknown[]): void {
  const name = (cls as unknown as { name?: string }).name ?? 'anonymous';
  if (tokens.some((token) => token === undefined || token === null)) {
    throw new Error(`DI shim: ${name} 的依赖表里有 undefined（多半是循环 import）`);
  }
  if ((cls as unknown as { length: number }).length > tokens.length) {
    throw new Error(
      `DI shim 与实现漂移：${name} 声明了 ${(cls as unknown as { length: number }).length} 个构造参数，但表里只给了 ${tokens.length} 个 token`,
    );
  }
  Reflect.defineMetadata('design:paramtypes', tokens, cls);
}
