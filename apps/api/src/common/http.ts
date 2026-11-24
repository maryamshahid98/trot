import type { Request, Response } from 'express';

/** The request after the sign-in check has attached the person (see AuthGuard). */
export type ApiRequest = Request & { id?: string; user?: import('../auth/decorators.ts').AuthUser };
export type ApiResponse = Response;
