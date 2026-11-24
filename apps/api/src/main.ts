import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.ts';
import { configureApp } from './bootstrap.ts';
import { APP_CONFIG, ConfigError, loadConfig } from './config/env.ts';
import type { AppConfig } from './config/env.ts';

async function bootstrap() {
  loadConfig(); // fail fast, with a readable list of what is missing, before anything starts

  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks(); // on SIGTERM / SIGINT, close the database pool and finish cleanly
  configureApp(app);
  const { port } = app.get<AppConfig>(APP_CONFIG);
  await app.listen(port);
  new Logger('Bootstrap').log(`Trot API listening on port ${port}`);
}

bootstrap().catch((e) => {
  console.error(e instanceof ConfigError ? e.message : e);
  process.exit(1);
});
