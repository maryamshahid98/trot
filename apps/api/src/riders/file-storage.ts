import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { APP_CONFIG } from '../config/env.ts';
import type { AppConfig } from '../config/env.ts';

export const FILE_STORAGE = 'FILE_STORAGE';

/** Where uploaded files live: a folder on disk (below) or an S3 bucket (s3-storage.ts). Callers do not know which. */
export interface FileStorage {
  save(key: string, data: Buffer): Promise<void>;
  /** The file, or null when there is no such file. */
  read(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
}

/** Keys are made by the server (a UUID). Anything else is refused, so a key can never be used to reach outside the folder. */
const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Where a file sits inside any storage: a short folder from the start of its name, then the name. Refuses names the server did not make. */
export function fileLocation(key: string): string {
  if (!KEY_RE.test(key)) throw new Error('Invalid file key.');
  return `${key.slice(0, 2)}/${key}`;
}

@Injectable()
export class LocalFileStorage implements FileStorage {
  private readonly root: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.root = path.resolve(config.uploads.dir);
  }

  private pathFor(key: string): string {
    return path.join(this.root, fileLocation(key));
  }

  async save(key: string, data: Buffer): Promise<void> {
    const file = this.pathFor(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data, { flag: 'wx', mode: 0o600 }); // 'wx': never overwrite an existing file
  }

  async read(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathFor(key));
    } catch (e: unknown) {
      if ((e as { code?: string }).code === 'ENOENT') return null;
      throw e;
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}

export const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

export type AllowedFileType = 'application/pdf' | 'image/jpeg' | 'image/png';
export const ALLOWED_FILE_TYPES: readonly AllowedFileType[] = ['application/pdf', 'image/jpeg', 'image/png'];

/** What the file really is, judged from its first bytes. What the sender CLAIMS (the Content-Type header, the file name) is not trusted. */
export function detectFileType(data: Buffer): AllowedFileType | null {
  if (data.length >= 5 && data.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

const EXTENSION: Record<AllowedFileType, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };

/** A file name that is safe to show and to put in a download header: no folders, no control characters, not too long. */
export function safeFileName(raw: string | undefined, fallback: string, type: AllowedFileType, max: number): string {
  let name = '';
  if (raw) {
    try { name = decodeURIComponent(raw); } catch { name = raw; }
  }
  name = name.replace(/[\\/]/g, ' ').replace(/[^\p{L}\p{N} ._()-]/gu, '').replace(/\.{2,}/g, '.').replace(/\s+/g, ' ').replace(/^[.\s]+/, '').trim();
  if (!name) name = fallback;
  const ext = `.${EXTENSION[type]}`;
  if (!name.toLowerCase().endsWith(ext)) name += ext;
  if (name.length > max) name = name.slice(0, max - ext.length) + ext;
  return name;
}
