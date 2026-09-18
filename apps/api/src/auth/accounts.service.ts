import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Account } from '@prisma/client';
import { ApiException } from '../contract/errors';
import { newId } from '../contract/ids';
import { nowSql, toIso } from '../contract/time';
import { AuditService } from '../infra/audit.service';
import { PrismaService } from '../infra/prisma.service';
import { SettingsService } from '../infra/settings.service';
import { signJwt } from './jwt';
import { hashPassword, randomSecret, verifyPassword } from './password';

/** ATB_UI_TOKEN 兼容路径映射到的内置账号；迁移脚本保证这行始终存在，密码登录永远进不来。 */
export const BUILTIN_ACCOUNT_ID = 'acct_local';
export const BUILTIN_USERNAME = '__local__';
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 64;

export interface AccountDto {
  id: string;
  username: string;
  role: string;
  status: string;
  display_name: string | null;
  must_change_password: boolean;
  created_at: string | null;
}

export interface LoginResult {
  token: string;
  account: AccountDto;
  must_change_password: boolean;
}

export function toAccountDto(row: Account): AccountDto {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    status: row.status,
    display_name: row.displayName,
    must_change_password: row.mustChangePassword === 1,
    created_at: toIso(row.createdAt),
  };
}

/**
 * 账号体系：本地账号存本库（scrypt 哈希），UI 会话用 HS256 JWT。
 * JWT secret 放 settings 表：env `ATB_JWT_SECRET` 可覆盖，缺省首次生成后持久化，重启不掉线。
 */
@Injectable()
export class AccountsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  /** 迁移只建了行；这里兜底保证内置账号存在（幂等）。 */
  async onModuleInit(): Promise<void> {
    await this.prisma.account.upsert({
      where: { id: BUILTIN_ACCOUNT_ID },
      create: { id: BUILTIN_ACCOUNT_ID, username: BUILTIN_USERNAME, role: 'ADMIN' },
      update: {},
    });
  }

  async login(username: string, password: string): Promise<LoginResult> {
    const row = await this.prisma.account.findUnique({ where: { username } });
    if (!row || row.id === BUILTIN_ACCOUNT_ID || !verifyPassword(password, row.salt, row.passwordHash)) {
      throw new ApiException('UNAUTHORIZED', '用户名或密码错误');
    }
    if (row.status !== 'ACTIVE') {
      throw new ApiException('FORBIDDEN', '账号已禁用，请联系管理员');
    }
    return this.issue(row);
  }

  /** 首次部署初始化：存在任何一个真实账号（非内置）后永久关闭。 */
  async init(input: { username: string; password: string; display_name?: string }): Promise<LoginResult> {
    const existing = await this.prisma.account.count({ where: { id: { not: BUILTIN_ACCOUNT_ID } } });
    if (existing > 0) {
      throw new ApiException('FORBIDDEN', '已存在账号，初始化接口已关闭');
    }
    const row = await this.prisma.account.create({ data: await this.accountData(input, 'ADMIN') });
    await this.audit.record({
      actorType: 'user',
      actorName: row.username,
      action: 'account_init',
      targetType: 'account',
      targetId: row.id,
      after: { username: row.username, role: row.role },
    });
    return this.issue(row);
  }

  async changePassword(
    auth: { accountId: string },
    currentPassword: string,
    newPassword: string,
  ): Promise<LoginResult> {
    const row = await this.getReal(auth.accountId);
    if (!verifyPassword(currentPassword, row.salt, row.passwordHash)) {
      throw new ApiException('UNAUTHORIZED', '当前密码不正确');
    }
    const updated = await this.prisma.account.update({
      where: { id: row.id },
      data: { ...dataOf(hashPassword(newPassword)), mustChangePassword: 0, updatedAt: nowSql() },
    });
    await this.audit.record({
      actorType: 'user',
      actorName: row.username,
      action: 'account_change_password',
      targetType: 'account',
      targetId: row.id,
    });
    return this.issue(updated);
  }

  async listUsers(): Promise<{ items: AccountDto[] }> {
    const rows = await this.prisma.account.findMany({
      where: { id: { not: BUILTIN_ACCOUNT_ID } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return { items: rows.map(toAccountDto) };
  }

  async createUser(input: { username: string; password: string; role?: string; display_name?: string }): Promise<AccountDto> {
    const duplicate = await this.prisma.account.findUnique({ where: { username: input.username } });
    if (duplicate) {
      throw new ApiException('VALIDATION_FAILED', `用户名「${input.username}」已存在`, [
        { path: 'username', code: 'duplicate_username', message: '该用户名已被占用' },
      ]);
    }
    const row = await this.prisma.account.create({
      data: {
        ...(await this.accountData(input, input.role ?? 'MEMBER')),
        // admin 建的号首登强制改密码。
        mustChangePassword: 1,
      },
    });
    await this.audit.record({
      actorType: 'user',
      action: 'account_create',
      targetType: 'account',
      targetId: row.id,
      after: { username: row.username, role: row.role },
    });
    return toAccountDto(row);
  }

  async patchUser(
    id: string,
    input: {
      password?: string;
      role?: 'ADMIN' | 'MEMBER';
      status?: 'ACTIVE' | 'DISABLED';
      must_change_password?: boolean;
      display_name?: string | null;
    },
  ): Promise<AccountDto> {
    const row = await this.getReal(id);
    const data: Record<string, unknown> = { updatedAt: nowSql() };
    if (input.password !== undefined) {
      Object.assign(data, dataOf(hashPassword(input.password)), { mustChangePassword: 1 });
    }
    if (input.role !== undefined) data.role = input.role;
    if (input.status !== undefined) data.status = input.status;
    if (input.must_change_password !== undefined) data.mustChangePassword = input.must_change_password ? 1 : 0;
    if (input.display_name !== undefined) data.displayName = input.display_name;
    const updated = await this.prisma.account.update({ where: { id: row.id }, data });
    await this.audit.record({
      actorType: 'user',
      action: 'account_update',
      targetType: 'account',
      targetId: row.id,
      before: { role: row.role, status: row.status },
      after: { ...input, password: input.password === undefined ? undefined : '(set)' },
    });
    return toAccountDto(updated);
  }

  async accountById(id: string): Promise<Account | null> {
    return this.prisma.account.findUnique({ where: { id } });
  }

  private async getReal(id: string) {
    const row = await this.prisma.account.findUnique({ where: { id } });
    if (!row || row.id === BUILTIN_ACCOUNT_ID) throw new ApiException('NOT_FOUND', '账号不存在');
    return row;
  }

  private async accountData(input: { username: string; password: string; display_name?: string }, role: string) {
    this.assertUsername(input.username);
    this.assertPassword(input.password);
    return {
      id: newId(),
      username: input.username,
      role,
      status: 'ACTIVE',
      displayName: input.display_name ?? null,
      ...dataOf(hashPassword(input.password)),
    };
  }

  private assertUsername(username: string): void {
    if (!USERNAME_RE.test(username)) {
      throw new ApiException('VALIDATION_FAILED', '用户名需为 3-32 位字母/数字/下划线/连字符', [
        { path: 'username', code: 'invalid_username', message: USERNAME_RE.source },
      ]);
    }
  }

  private assertPassword(password: string): void {
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      throw new ApiException('VALIDATION_FAILED', `密码长度需在 ${PASSWORD_MIN}-${PASSWORD_MAX} 位之间`, [
        { path: 'password', code: 'invalid_password', message: `长度 ${PASSWORD_MIN}-${PASSWORD_MAX}` },
      ]);
    }
  }

  /** 签发会话：JWT secret 惰性生成并持久化（env ATB_JWT_SECRET 优先）。 */
  private async issue(row: Account): Promise<LoginResult> {
    const secret = process.env.ATB_JWT_SECRET ?? (await this.ensureSecret());
    const token = signJwt({ sub: row.id, username: row.username, role: row.role }, secret);
    const account = toAccountDto(row);
    return { token, account, must_change_password: account.must_change_password };
  }

  private async ensureSecret(): Promise<string> {
    const existing = await this.prisma.setting.findUnique({ where: { key: 'jwt_secret' } });
    if (existing) return existing.value;
    const value = randomSecret();
    await this.prisma.setting.create({ data: { key: 'jwt_secret', value, updatedAt: nowSql() } });
    return value;
  }
}

function dataOf(hashed: { salt: string; hash: string; algo: string }) {
  return { salt: hashed.salt, passwordHash: hashed.hash, algo: hashed.algo };
}
