import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiException } from '../contract/errors';
import { Auth, AuthScope, type RequestAuth } from './auth.scope';
import { zod } from '../infra/zod.pipe';
import {
  changePasswordSchema,
  initSchema,
  loginSchema,
  userCreateSchema,
  userPatchSchema,
  type ChangePasswordInput,
  type InitInput,
  type LoginInput,
  type UserCreateInput,
  type UserPatchInput,
} from './auth.dto';
import { AccountsService, toAccountDto, type AccountDto, type LoginResult } from './accounts.service';

/**
 * 0919 账号体系端点。login/init 无凭证可达（public）；
 * me/change-password/logout 只要 UI 会话；users 管理三件套要求 ADMIN 角色。
 */
@Controller('api/v1/auth')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Post('login')
  @AuthScope('public')
  login(@Body(zod(loginSchema)) body: LoginInput): Promise<LoginResult> {
    return this.accounts.login(body.username, body.password);
  }

  /** 无任何真实账号时开放（仅一次）：创建首个 ADMIN。 */
  @Post('init')
  @AuthScope('public')
  init(@Body(zod(initSchema)) body: InitInput): Promise<LoginResult> {
    return this.accounts.init(body);
  }

  @Get('me')
  @AuthScope('ui')
  async me(@Auth() auth: RequestAuth): Promise<AccountDto & { username: string }> {
    this.assertUi(auth);
    const row = await this.accounts.accountById(auth.accountId);
    if (!row) throw new ApiException('UNAUTHORIZED', '账号不存在');
    return toAccountDto(row);
  }

  /** 返回新签的 token（旧 token 里 mustChangePassword 已过期语义，前端直接替换）。 */
  @Post('change-password')
  @AuthScope('ui')
  changePassword(
    @Body(zod(changePasswordSchema)) body: ChangePasswordInput,
    @Auth() auth: RequestAuth,
  ): Promise<LoginResult> {
    this.assertUi(auth);
    return this.accounts.changePassword(auth, body.current_password, body.new_password);
  }

  /** 无状态 JWT：服务端无会话可销毁，返回 ok，前端丢弃 token。 */
  @Post('logout')
  @AuthScope('public')
  logout(): { ok: true } {
    return { ok: true };
  }

  @Get('users')
  @AuthScope('ui')
  listUsers(@Auth() auth: RequestAuth) {
    this.assertAdmin(auth);
    return this.accounts.listUsers();
  }

  @Post('users')
  @AuthScope('ui')
  createUser(@Body(zod(userCreateSchema)) body: UserCreateInput, @Auth() auth: RequestAuth): Promise<AccountDto> {
    this.assertAdmin(auth);
    return this.accounts.createUser(body);
  }

  /** 重置密码 / 禁用 / 启用 / 改角色 / 改 mustChangePassword，一个 PATCH 全包。 */
  @Patch('users/:id')
  @AuthScope('ui')
  patchUser(
    @Param('id') id: string,
    @Body(zod(userPatchSchema)) body: UserPatchInput,
    @Auth() auth: RequestAuth,
  ): Promise<AccountDto> {
    this.assertAdmin(auth);
    return this.accounts.patchUser(id, body);
  }

  private assertUi(auth: RequestAuth): asserts auth is Extract<RequestAuth, { kind: 'ui' }> {
    if (auth.kind !== 'ui') {
      throw new ApiException('FORBIDDEN', 'Agent Token 不能调用账号接口');
    }
  }

  private assertAdmin(auth: RequestAuth): void {
    this.assertUi(auth);
    if (auth.role !== 'ADMIN') {
      throw new ApiException('FORBIDDEN', '仅管理员可管理账号');
    }
  }
}
