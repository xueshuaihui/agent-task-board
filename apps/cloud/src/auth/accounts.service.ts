import { Injectable } from '@nestjs/common';
import { ApiException } from '../contract/errors';
import { uuidv7 } from '../contract/ids';
import { nowSql, toIso } from '../contract/time';
import { PrismaService } from '../infra/prisma.service';
import { hashPassword, verifyPassword } from './password';
import { signJwt } from './jwt';
import { jwtSecret } from '../common/paths';
import type { LoginInput, RegisterInput } from './auth.dto';

export interface AccountDto {
  id: string;
  username: string;
  display_name: string | null;
  role: 'MEMBER' | 'ADMIN';
  created_at: string | null;
}

@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService) {}

  async register(input: RegisterInput): Promise<{ account: AccountDto; token: string }> {
    const exists = await this.prisma.cloudAccount.findUnique({ where: { username: input.username } });
    if (exists) throw new ApiException('USERNAME_TAKEN', '用户名已被占用', undefined, { username: input.username });
    const { salt, hash, algo } = hashPassword(input.password);
    const row = await this.prisma.cloudAccount.create({
      data: {
        id: `acct_${uuidv7()}`,
        username: input.username,
        passwordHash: hash,
        salt,
        algo,
        displayName: input.display_name ?? null,
      },
    });
    return { account: this.toDto(row), token: this.issueToken(row) };
  }

  async login(input: LoginInput): Promise<{ account: AccountDto; token: string }> {
    const row = await this.prisma.cloudAccount.findUnique({ where: { username: input.username } });
    // 用户不存在与密码错误同一文案，避免账号枚举。
    if (!row || !verifyPassword(input.password, row.salt, row.passwordHash)) {
      throw new ApiException('UNAUTHORIZED', '用户名或密码错误');
    }
    if (row.status !== 'ACTIVE') throw new ApiException('UNAUTHORIZED', '账号已禁用');
    return { account: this.toDto(row), token: this.issueToken(row) };
  }

  async me(accountId: string): Promise<AccountDto> {
    const row = await this.prisma.cloudAccount.findUnique({ where: { id: accountId } });
    if (!row || row.status !== 'ACTIVE') throw new ApiException('UNAUTHORIZED', '账号不可用');
    return this.toDto(row);
  }

  private issueToken(row: { id: string; username: string; role: string }): string {
    const secret = jwtSecret();
    if (!secret) throw new ApiException('INTERNAL', '服务端未配置 CLOUD_JWT_SECRET，无法签发凭证');
    return signJwt({ sub: row.id, username: row.username, role: row.role }, secret);
  }

  private toDto(row: {
    id: string;
    username: string;
    displayName: string | null;
    role: string;
    createdAt: string;
  }): AccountDto {
    return {
      id: row.id,
      username: row.username,
      display_name: row.displayName,
      role: row.role === 'ADMIN' ? 'ADMIN' : 'MEMBER',
      created_at: toIso(row.createdAt),
    };
  }
}
