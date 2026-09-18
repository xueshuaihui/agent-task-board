import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { z } from 'zod';
import { ApiException } from '../contract/errors';
import { nowSql, toIso } from '../contract/time';
import { Auth, AuthScope, type RequestAuth } from '../auth/auth.scope';
import { zod } from '../infra/zod.pipe';
import { PrismaService } from '../infra/prisma.service';

const keySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_.:-]+$/, '1-64 位字母/数字/_.:-');

export interface PrefResult {
  key: string;
  value: unknown;
  updated_at: string | null;
}

/**
 * 7.7 分组选择器等前端偏好的持久化：GET/PUT /api/v1/prefs/:key，按账号一行一个 JSON value。
 * key 由前端自定（如 `board.group_by`），服务端不维护词表；PUT 整体覆盖。
 */
@Controller('api/v1/prefs')
@AuthScope('ui')
export class PrefsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':key')
  async get(
    @Param('key', zod(keySchema)) key: string,
    @Auth() auth: RequestAuth,
  ): Promise<PrefResult> {
    const accountId = this.ui(auth).accountId;
    const row = await this.prisma.userPreference.findUnique({
      where: { accountId_key: { accountId, key } },
    });
    return {
      key,
      value: row ? (JSON.parse(row.value) as unknown) : null,
      updated_at: toIso(row?.updatedAt ?? null),
    };
  }

  @Put(':key')
  async put(
    @Param('key', zod(keySchema)) key: string,
    @Body() body: { value?: unknown },
    @Auth() auth: RequestAuth,
  ): Promise<PrefResult> {
    const accountId = this.ui(auth).accountId;
    if (!body || typeof body !== 'object' || !('value' in body)) {
      throw new ApiException('VALIDATION_FAILED', '请求体需为 { value: ... }');
    }
    const value = JSON.stringify(body.value ?? null);
    const row = await this.prisma.userPreference.upsert({
      where: { accountId_key: { accountId, key } },
      create: { accountId, key, value, updatedAt: nowSql() },
      update: { value, updatedAt: nowSql() },
    });
    return {
      key,
      value: JSON.parse(row.value) as unknown,
      updated_at: toIso(row.updatedAt),
    };
  }

  private ui(auth: RequestAuth): Extract<RequestAuth, { kind: 'ui' }> {
    if (auth.kind !== 'ui') throw new Error('unreachable: controller is ui-scoped');
    return auth;
  }
}
