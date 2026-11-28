import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { parse } from '../common/validate.ts';
import { ChangePasswordBody, ForgotBody, LoginBody, RefreshBody, ResetBody } from './auth.schemas.ts';
import { ResetService } from './reset.service.ts';
import { MfaService } from './mfa.service.ts';
import { AuthService } from './auth.service.ts';
import { AllowWithoutMfa, CurrentUser, Public } from './decorators.ts';
import type { AuthUser } from './decorators.ts';
import { RateLimitGuard } from './rate-limit.guard.ts';
import { APP_CONFIG } from '../config/env.ts';
import type { AppConfig } from '../config/env.ts';
import { REFRESH_COOKIE } from '../config/constants.ts';
import { clearRefreshCookie, isWebClient, readCookie, setRefreshCookie } from './web-session.ts';
import type { ApiRequest, ApiResponse } from '../common/http.ts';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MfaService) private readonly mfa: MfaService,
    @Inject(ResetService) private readonly resets: ResetService,
  ) {}

  /** The website gets its refresh token as a cookie only; everyone else gets it in the body. */
  private deliver<T extends object>(req: ApiRequest, res: ApiResponse, result: T): Omit<T, 'refreshToken'> | T {
    const refreshToken = (result as { refreshToken?: string }).refreshToken; // a two-step sign-in's first answer has none yet
    if (!isWebClient(req) || !refreshToken) return result;
    setRefreshCookie(res, refreshToken, this.config.auth.refreshTtlDays, this.config.auth);
    const { refreshToken: _omit, ...rest } = result as T & { refreshToken?: string };
    return rest;
  }

  @Post('login')
  @HttpCode(200)
  @Public()
  @UseGuards(RateLimitGuard)
  async login(@Body() body: unknown, @Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse) {
    return this.deliver(req, res, await this.auth.login(parse(LoginBody, body), req.headers['user-agent']));
  }

  @Post('refresh')
  @HttpCode(200)
  @Public()
  @UseGuards(RateLimitGuard)
  async refresh(@Body() body: unknown, @Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse) {
    const web = isWebClient(req);
    // A website request uses its cookie and nothing else, so a token pasted into the body can never be used from a page.
    const token = web ? readCookie(req, REFRESH_COOKIE.name) : parse(RefreshBody, body).refreshToken;
    if (!token) throw new UnauthorizedException('Your session is not valid. Please sign in again.');
    try {
      return this.deliver(req, res, await this.auth.refresh(token, req.headers['user-agent']));
    } catch (err) {
      if (web) clearRefreshCookie(res, this.config.auth);
      throw err;
    }
  }

  @Post('logout')
  @HttpCode(200)
  @Public()
  @UseGuards(RateLimitGuard)
  async logout(@Body() body: unknown, @Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse) {
    const web = isWebClient(req);
    const token = web ? readCookie(req, REFRESH_COOKIE.name) : parse(RefreshBody, body).refreshToken;
    if (web) clearRefreshCookie(res, this.config.auth);
    return token ? this.auth.logout(token) : { ok: true };
  }

  /** Sends a one-time code for choosing a new password. */
  @Post('forgot') @HttpCode(200) @Public() @UseGuards(RateLimitGuard)
  forgot(@Body() body: unknown) { return this.resets.forgot(parse(ForgotBody, body).identifier); }

  @Post('reset') @HttpCode(200) @Public() @UseGuards(RateLimitGuard)
  reset(@Body() body: unknown) { const b = parse(ResetBody, body); return this.resets.reset(b.identifier, b.code, b.newPassword); }

  /** The second step of a two-step sign-in: the token from login plus a code from the authenticator app, or a recovery code. */
  @Post('mfa/verify')
  @HttpCode(200)
  @Public()
  @UseGuards(RateLimitGuard)
  async verifyMfa(@Body() body: unknown, @Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse) {
    return this.deliver(req, res, await this.mfa.verifyLogin(body, req.headers['user-agent']));
  }

  @Get('mfa') @AllowWithoutMfa()
  mfaStatus(@CurrentUser() user: AuthUser) { return this.mfa.status(user); }

  /** Starts set-up: a secret and an address to scan with an authenticator app. */
  @Post('mfa/setup') @HttpCode(200) @AllowWithoutMfa()
  mfaSetup(@CurrentUser() user: AuthUser) { return this.mfa.setup(user); }

  /** Confirms set-up with a code from the app. Answers with recovery codes, shown only this once. */
  @Post('mfa/enable') @HttpCode(200) @AllowWithoutMfa()
  mfaEnable(@Body() body: unknown, @CurrentUser() user: AuthUser) { return this.mfa.enable(user, body); }

  @Post('mfa/disable') @HttpCode(200)
  mfaDisable(@Body() body: unknown, @CurrentUser() user: AuthUser) { return this.mfa.disable(user, body); }

  @Post('mfa/recovery-codes') @HttpCode(200)
  mfaRecoveryCodes(@Body() body: unknown, @CurrentUser() user: AuthUser) { return this.mfa.regenerateRecoveryCodes(user, body); }

  @Get('me') @AllowWithoutMfa()
  me(@CurrentUser() user: AuthUser) {
    // "role" is the account's own role; "actsAs" is the base role the portal builds its screens from.
    const { title, source: _source, ...rest } = user;
    return { ...rest, role: title ?? user.role, actsAs: user.role === 'manager' && title === 'auditor' ? 'manager' : title === 'director' ? 'manager' : title === 'finance' || title === 'scheduler' ? 'reception' : user.role };
  }

  @Post('change-password')
  @HttpCode(200)
  changePassword(@Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.auth.changePassword(user, parse(ChangePasswordBody, body));
  }
}
