import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { parse } from '../common/validate.ts';
import { ChangePasswordBody, LoginBody, RefreshBody } from './auth.schemas.ts';
import { AuthService } from './auth.service.ts';
import { CurrentUser, Public } from './decorators.ts';
import type { AuthUser } from './decorators.ts';
import { RateLimitGuard } from './rate-limit.guard.ts';
import { APP_CONFIG } from '../config/env.ts';
import type { AppConfig } from '../config/env.ts';
import { REFRESH_COOKIE } from '../config/constants.ts';
import { clearRefreshCookie, isWebClient, readCookie, setRefreshCookie } from './web-session.ts';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** The website gets its refresh token as a cookie only; everyone else gets it in the body. */
  private deliver<T extends { refreshToken?: string }>(req: any, res: any, result: T): Omit<T, 'refreshToken'> | T {
    if (!isWebClient(req) || !result.refreshToken) return result;
    setRefreshCookie(res, result.refreshToken, this.config.auth.refreshTtlDays, this.config.auth.cookieSecure);
    const { refreshToken: _omit, ...rest } = result;
    return rest;
  }

  @Post('login')
  @HttpCode(200)
  @Public()
  @UseGuards(RateLimitGuard)
  async login(@Body() body: unknown, @Req() req: any, @Res({ passthrough: true }) res: any) {
    return this.deliver(req, res, await this.auth.login(parse(LoginBody, body), req.headers['user-agent']));
  }

  @Post('refresh')
  @HttpCode(200)
  @Public()
  @UseGuards(RateLimitGuard)
  async refresh(@Body() body: unknown, @Req() req: any, @Res({ passthrough: true }) res: any) {
    const web = isWebClient(req);
    // A website request uses its cookie and nothing else, so a token pasted into the body can never be used from a page.
    const token = web ? readCookie(req, REFRESH_COOKIE.name) : parse(RefreshBody, body).refreshToken;
    if (!token) throw new UnauthorizedException('Your session is not valid. Please sign in again.');
    try {
      return this.deliver(req, res, await this.auth.refresh(token, req.headers['user-agent']));
    } catch (err) {
      if (web) clearRefreshCookie(res, this.config.auth.cookieSecure);
      throw err;
    }
  }

  @Post('logout')
  @HttpCode(200)
  @Public()
  @UseGuards(RateLimitGuard)
  async logout(@Body() body: unknown, @Req() req: any, @Res({ passthrough: true }) res: any) {
    const web = isWebClient(req);
    const token = web ? readCookie(req, REFRESH_COOKIE.name) : parse(RefreshBody, body).refreshToken;
    if (web) clearRefreshCookie(res, this.config.auth.cookieSecure);
    return token ? this.auth.logout(token) : { ok: true };
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  @Post('change-password')
  @HttpCode(200)
  changePassword(@Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.auth.changePassword(user, parse(ChangePasswordBody, body));
  }
}
