// The API without a listening port, for hosting that hands each request to a function (see docs/vercel-demo.md).
import 'reflect-metadata';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.ts';
import { configureApp } from './bootstrap.ts';
import { loadConfig } from './config/env.ts';

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

export async function createServerlessHandler(): Promise<RequestHandler> {
  loadConfig(); // fail fast, naming what is missing
  const app = await NestFactory.create(AppModule, { abortOnError: false });
  configureApp(app);
  await app.init();
  return app.getHttpAdapter().getInstance() as RequestHandler;
}
