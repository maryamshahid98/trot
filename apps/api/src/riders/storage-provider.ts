// Chooses where uploaded files are kept (STORAGE_DRIVER). Every module that handles files uses this one provider.
import { APP_CONFIG } from '../config/env.ts';
import type { AppConfig } from '../config/env.ts';
import { FILE_STORAGE, LocalFileStorage } from './file-storage.ts';
import type { FileStorage } from './file-storage.ts';
import { S3FileStorage } from './s3-storage.ts';

export const createFileStorage = (config: AppConfig): FileStorage => (config.uploads.s3 ? new S3FileStorage(config.uploads.s3) : new LocalFileStorage(config));

export const fileStorageProvider = { provide: FILE_STORAGE, useFactory: createFileStorage, inject: [APP_CONFIG] };
