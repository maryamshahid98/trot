import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, loadConfig } from './env.ts';

/** Reads and checks the environment once, when the app is created. Inject it with @Inject(APP_CONFIG). */
@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig() }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
