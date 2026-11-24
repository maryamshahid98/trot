import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.ts';
import { AuthService } from './auth.service.ts';
import { MfaService } from './mfa.service.ts';
import { TokenService } from './tokens.ts';

@Module({ controllers: [AuthController], providers: [AuthService, MfaService, TokenService], exports: [TokenService] })
export class AuthModule {}
