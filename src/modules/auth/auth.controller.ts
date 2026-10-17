import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common'
import { IsOptional, IsString, Length } from 'class-validator'
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger'
import type { Response } from 'express'
import { Caller } from '../../authz/caller'
import {
  AllowUnverified,
  ApiError,
  AuthedRequest,
  badRequest,
  CurrentCaller,
  NoWorkspace,
  Public,
  RateLimit,
} from '../../common/http'
import { ENV, Env } from '../../config/env'
import { AcceptInviteDto, EmailDto, GoogleStartDto, LoginDto, ResetPasswordDto, SignUpDto, TokenDto } from './auth.dto'
import { AuthService } from './auth.service'
import { GoogleAuthService } from './google-auth.service'
import { InviteAcceptanceService } from './invite-acceptance.service'
import { MeService } from './me.view'

export const REFRESH_COOKIE = 'pn_refresh'

class NativeTokenDto {
  @IsOptional() @IsString() @Length(20, 200) refreshToken?: string
}

/** React Native / Tauri send `X-Client: native` and keep the refresh token in the OS keychain. */
const isNative = (req: AuthedRequest) => req.headers['x-client'] === 'native'

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private auth: AuthService,
    private me: MeService,
    private invites: InviteAcceptanceService,
    private google: GoogleAuthService,
    @Inject(ENV) private env: Env
  ) {}

  private setCookie(res: Response, token: string) {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: this.env.cookieSecure,
      sameSite: 'lax',
      path: '/api/v1/auth',
      domain: this.env.cookieDomain,
      maxAge: this.env.refreshTokenTtlSec * 1000,
    })
  }

  private clearCookie(res: Response) {
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth', domain: this.env.cookieDomain })
  }

  /**
   * CSRF defence for the two cookie-authenticated endpoints. A request is accepted if it carries
   * a custom header (cross-site forms cannot set one) OR a browser `Origin` that is on the CORS
   * allow-list (a cross-site request carries the attacker's origin). The existing web client
   * relies on the second rule; native clients never reach this code (no cookie).
   */
  private csrf(req: AuthedRequest) {
    const origin = req.headers.origin
    if (req.headers['x-requested-with'] || (typeof origin === 'string' && this.env.corsOrigins.includes(origin))) return
    throw new ApiError(400, 'csrf_blocked', 'Cross-site request refused')
  }

  @Public()
  @HttpCode(202)
  @RateLimit({ by: 'ip', limit: 20, windowSec: 3600 })
  @Post('sign-up')
  signUp(@Body() dto: SignUpDto) {
    return this.auth.signUp(dto)
  }

  @Public()
  @HttpCode(200)
  @RateLimit({ by: 'ip', limit: 30, windowSec: 60 }, { by: 'body.email', limit: 20, windowSec: 900 })
  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.login(dto.email, dto.password)
    if (isNative(req)) return { accessToken: r.accessToken, refreshToken: r.refreshToken, user: r.user }
    this.setCookie(res, r.refreshToken)
    return { accessToken: r.accessToken, user: r.user }
  }

  @Public()
  @HttpCode(200)
  @RateLimit({ by: 'ip', limit: 120, windowSec: 60 })
  @Post('refresh')
  async refresh(@Body() dto: NativeTokenDto, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    if (isNative(req)) {
      // No ambient credentials here, so no CSRF risk: the caller must present the token itself.
      if (!dto.refreshToken) throw new ApiError(401, 'invalid_refresh_token', 'Sign in again')
      const r = await this.auth.refresh(dto.refreshToken)
      return { accessToken: r.accessToken, refreshToken: r.refreshToken }
    }
    this.csrf(req)
    const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE]
    if (!token) throw new ApiError(401, 'invalid_refresh_token', 'Sign in again')
    try {
      const r = await this.auth.refresh(token)
      this.setCookie(res, r.refreshToken)
      return { accessToken: r.accessToken }
    } catch (e) {
      if (e instanceof ApiError && e.code !== 'refresh_in_flight') this.clearCookie(res)
      throw e
    }
  }

  @Public()
  @HttpCode(204)
  @Post('logout')
  async logout(@Body() dto: NativeTokenDto, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    if (isNative(req)) {
      await this.auth.logout(dto.refreshToken)
      return
    }
    this.csrf(req)
    await this.auth.logout((req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE])
    this.clearCookie(res)
  }

  @Public()
  @HttpCode(200)
  @RateLimit({ by: 'ip', limit: 30, windowSec: 3600 })
  @Post('verify-email')
  async verifyEmail(@Body() dto: TokenDto) {
    await this.auth.verifyEmail(dto.token)
    return { verified: true }
  }

  @NoWorkspace()
  @AllowUnverified()
  @HttpCode(202)
  @RateLimit({ by: 'user', limit: 5, windowSec: 3600 })
  @Post('resend-verification')
  async resend(@CurrentCaller() c: Caller) {
    await this.auth.resendVerification(c.userId)
    return { sent: true }
  }

  @Public()
  @HttpCode(202)
  @RateLimit({ by: 'body.email', limit: 3, windowSec: 3600 }, { by: 'ip', limit: 10, windowSec: 3600 })
  @Post('forgot-password')
  async forgot(@Body() dto: EmailDto) {
    await this.auth.forgotPassword(dto.email)
    return { message: "If an account exists, we've sent a link" }
  }

  @Public()
  @HttpCode(200)
  @RateLimit({ by: 'ip', limit: 20, windowSec: 3600 })
  @Post('reset-password')
  async reset(@Body() dto: ResetPasswordDto) {
    await this.auth.resetPassword(dto.token, dto.password)
    return { reset: true }
  }

  /* ---- Google sign-in / sign-up / link (identity only; Drive is a separate consent) ---- */

  /** Returns the Google consent URL; the browser navigates to it. */
  @Public()
  @HttpCode(200)
  @RateLimit({ by: 'ip', limit: 30, windowSec: 60 })
  @Post('google/start')
  googleStart(@Body() dto: GoogleStartDto) {
    return this.google.start(dto)
  }

  /** Google redirects the browser here; we set the session cookie and send the user back to the app. */
  @ApiExcludeEndpoint()
  @Public()
  @RateLimit({ by: 'ip', limit: 60, windowSec: 60 })
  @Get('google/callback')
  async googleCallback(
    @Query('state') state: string,
    @Query('code') code: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response
  ) {
    const r = await this.google.finish(state ?? '', code, error)
    if (r.refreshToken) this.setCookie(res, r.refreshToken)
    res.redirect(302, r.redirect)
  }

  /** Signed-in user links a Google account so they can sign in with it later. */
  @ApiBearerAuth()
  @NoWorkspace()
  @HttpCode(200)
  @RateLimit({ by: 'user', limit: 10, windowSec: 600 })
  @Post('google/link')
  googleLink(@CurrentCaller() c: Caller) {
    return this.google.startLink(c.userId)
  }

  @ApiBearerAuth()
  @NoWorkspace()
  @HttpCode(204)
  @Delete('google')
  async googleUnlink(@CurrentCaller() c: Caller) {
    await this.google.unlink(c.userId)
  }

  /* ---- invite links (e-mail) ---- */

  @Public()
  @Get('invites/:token')
  previewInvite(@Param('token') token: string) {
    return this.invites.preview(token)
  }

  @Public()
  @HttpCode(200)
  @RateLimit({ by: 'ip', limit: 20, windowSec: 3600 })
  @Post('invites/:token/accept')
  async acceptByToken(@Param('token') token: string, @Body() dto: AcceptInviteDto, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    if (!token || token.length < 20) throw badRequest('invalid_token', 'This invitation link is not valid')
    const r = await this.invites.acceptByToken(token, dto)
    if (isNative(req)) return { accessToken: r.accessToken, refreshToken: r.refreshToken, user: r.user }
    this.setCookie(res, r.refreshToken)
    return { accessToken: r.accessToken, user: r.user }
  }
}
