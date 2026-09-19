import { Body, Controller, Get, Post } from '@nestjs/common';
import { Auth, Public, type RequestAuth } from './auth.scope';
import { zod } from '../infra/zod.pipe';
import { AccountsService } from './accounts.service';
import { loginSchema, registerSchema, type LoginInput, type RegisterInput } from './auth.dto';

@Controller('cloud/v1/accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Public()
  @Post('register')
  register(@Body(zod(registerSchema)) body: RegisterInput) {
    return this.accounts.register(body);
  }

  @Public()
  @Post('login')
  login(@Body(zod(loginSchema)) body: LoginInput) {
    return this.accounts.login(body);
  }

  @Get('me')
  me(@Auth() auth: RequestAuth) {
    return this.accounts.me(auth.accountId);
  }
}
