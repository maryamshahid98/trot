import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.ts';
import { AuthService } from './auth.service.ts';
import { MfaService } from './mfa.service.ts';
import { ResetService } from './reset.service.ts';
import { TokenService } from './tokens.ts';

@Module({ controllers: [AuthController], providers: [AuthService, MfaService, ResetService, TokenService], exports: [TokenService] })
export class AuthModule {}
