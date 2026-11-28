// Uploaded files in Amazon S3, or any service that speaks the S3 protocol. The bucket is private: nothing outside the API ever
// reads it, so the permission checks and the viewing log in the API cannot be walked around.
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { FileStorage } from './file-storage.ts';
import { fileLocation } from './file-storage.ts';

export interface S3Settings {
  bucket: string;
  region: string;
  /** Only for a service other than Amazon, such as the free local one used in development. */
  endpoint?: string;
  forcePathStyle: boolean;
  /** A folder-like beginning for every object name, so one bucket can serve more than one environment. */
  prefix: string;
  /** Leave both out on a server that has an IAM role: the AWS library then finds its own credentials. */
  accessKeyId?: string;
  secretAccessKey?: string;
}

const CONNECT_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;

export const s3Client = (s: S3Settings) =>
  new S3Client({
    region: s.region,
    ...(s.endpoint ? { endpoint: s.endpoint, requestChecksumCalculation: 'WHEN_REQUIRED' as const, responseChecksumValidation: 'WHEN_REQUIRED' as const } : {}),
    forcePathStyle: s.forcePathStyle,
    ...(s.accessKeyId && s.secretAccessKey ? { credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey } } : {}),
    requestHandler: { connectionTimeout: CONNECT_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS },
  });

export class S3FileStorage implements FileStorage {
  private readonly client: S3Client;
  private readonly settings: S3Settings;

  constructor(settings: S3Settings) {
    this.settings = settings;
    this.client = s3Client(settings);
  }

  /** The same two-level layout as the local folder, so files can be copied across unchanged. */
  private objectName(key: string): string {
    return `${this.settings.prefix}${fileLocation(key)}`;
  }

  async save(key: string, data: Buffer): Promise<void> {
    // IfNoneMatch: the service refuses to overwrite a file that is already there. Amazon encrypts new objects at rest by itself.
    await this.client.send(new PutObjectCommand({ Bucket: this.settings.bucket, Key: this.objectName(key), Body: data, ContentLength: data.length, ContentType: 'application/octet-stream', IfNoneMatch: '*' }));
  }

  async read(key: string): Promise<Buffer | null> {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.settings.bucket, Key: this.objectName(key) }));
      return Buffer.from(await r.Body!.transformToByteArray());
    } catch (e: unknown) {
      // Only a missing file is "no file". A missing bucket or a refused key is a fault and must be seen.
      if ((e as { name?: string }).name === 'NoSuchKey') return null;
      throw e;
    }
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.settings.bucket, Key: this.objectName(key) }));
  }
}
