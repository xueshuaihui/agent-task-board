import { Injectable } from '@nestjs/common';
import { ApiException } from '../contract/errors';
import { generateAgentToken, hashToken, newId } from '../contract/ids';
import { nowSql } from '../contract/time';
import type { TokenCreateInput } from '../contract/schemas';
import { AuditService } from '../infra/audit.service';
import { PrismaService } from '../infra/prisma.service';
import { toTokenDto, type IssuedTokenDto, type TokenDto } from './token.dto';

/**
 * 20.1：`api_tokens.id` 是 UUID v7、明文是 `atb_` + 40 位 base62，都取 contract/ids.ts。
 * 哈希只认「对完整明文取 sha256」这一个口径（与 AuthGuard 同一函数），不另算一套。
 */
@Injectable()
export class TokensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * 8.5：列表**含已吊销项**。原型 7.3 的理由是隐藏会让历史 Run 的归属显示成空白，
   * 所以「默认过滤已吊销」这件事只做在前端，服务端不替它决定。
   */
  async list(accountId: string): Promise<{ items: TokenDto[] }> {
    const rows = await this.prisma.apiToken.findMany({
      where: { accountId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return { items: rows.map(toTokenDto) };
  }

  async issue(accountId: string, input: TokenCreateInput): Promise<IssuedTokenDto> {
    // 只取 generateAgentToken() 的明文：它顺带返回的 tokenHash 算的是**未加 `atb_` 前缀**的裸串，
    // 而 AuthGuard 按 hashToken(bearer) 查库，照抄会让每个签出的 Token 一调用就 401。
    // 哈希在这里按守卫口径重算，contract/ids.ts 那处待修（报告已提）。
    const { plaintext } = generateAgentToken();
    const tokenHash = hashToken(plaintext);
    const id = newId();
    await this.prisma.apiToken.create({
      data: {
        id,
        accountId,
        name: input.name,
        tokenHash,
        capabilities: JSON.stringify(input.capabilities),
        enabled: 1,
        createdAt: nowSql(),
      },
    });
    // 审计详情会被设置页原样渲染，明文与 hash 都不进 `after`。
    await this.audit.record({
      actorType: 'user',
      action: 'token_issue',
      targetType: 'token',
      targetId: id,
      after: { id, name: input.name, capabilities: input.capabilities },
    });
    return { ...toTokenDto(await this.get(accountId, id)), token: plaintext };
  }

  /**
   * 13 章：吊销 = 置 `enabled = 0`，**不删行**——`task_runs.token_id` 要保留归属。
   * 也没有反向接口：恢复使用需新建 Token。
   */
  async revoke(accountId: string, id: string): Promise<{ id: string; enabled: false; revoked: boolean }> {
    await this.get(accountId, id);
    const result = await this.prisma.apiToken.updateMany({
      where: { id, accountId, enabled: 1 },
      data: { enabled: 0 },
    });
    // 重复吊销不再写第二条审计：列表里没有「重新启用」，第二次请求只可能是误点或重放。
    if (result.count > 0) {
      await this.audit.record({
        actorType: 'user',
        action: 'token_revoke',
        targetType: 'token',
        targetId: id,
        after: { enabled: false },
      });
    }
    return { id, enabled: false, revoked: true };
  }

  private async get(accountId: string, id: string) {
    const row = await this.prisma.apiToken.findFirst({ where: { id, accountId } });
    if (!row) throw new ApiException('NOT_FOUND', `Token ${id} 不存在`);
    return row;
  }
}
