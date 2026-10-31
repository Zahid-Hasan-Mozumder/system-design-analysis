/** Smallest part S3 will accept for anything but the final part. */
export const S3_MIN_PART_SIZE = 5 * 1024 * 1024;

/** S3 allows at most 10,000 parts per multipart upload. */
export const S3_MAX_PARTS = 10_000;

/** S3 allows at most 5 GiB per part. */
export const S3_MAX_PART_SIZE = 5 * 1024 * 1024 * 1024;

export interface AppConfig {
  port: number;
  corsOrigins: string[];
  databaseUrl: string;
  s3: {
    region: string;
    bucket: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    endpoint?: string;
    forcePathStyle: boolean;
    autoCreateBucket: boolean;
  };
  upload: {
    partSizeBytes: number;
    maxFileBytes: number;
    urlTtlSeconds: number;
    keyPrefix: string;
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive number, got "${raw}".`);
  }
  return Math.floor(parsed);
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === 'true' || raw === '1';
}

export function configuration(): AppConfig {
  const partSizeBytes = int('UPLOAD_PART_SIZE_BYTES', 16 * 1024 * 1024);

  if (partSizeBytes < S3_MIN_PART_SIZE) {
    throw new Error(`UPLOAD_PART_SIZE_BYTES must be at least ${S3_MIN_PART_SIZE} (5 MiB), got ${partSizeBytes}.`);
  }
  if (partSizeBytes > S3_MAX_PART_SIZE) {
    throw new Error(`UPLOAD_PART_SIZE_BYTES must be at most ${S3_MAX_PART_SIZE} (5 GiB), got ${partSizeBytes}.`);
  }

  return {
    port: int('PORT', 4000),
    corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    databaseUrl: required('DATABASE_URL'),
    s3: {
      region: process.env.AWS_REGION ?? 'us-east-1',
      bucket: required('S3_BUCKET'),
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || undefined,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || undefined,
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: bool('S3_FORCE_PATH_STYLE', false),
      autoCreateBucket: bool('S3_AUTO_CREATE_BUCKET', false),
    },
    upload: {
      partSizeBytes,
      // Default ceiling is the 5 TiB S3 object limit.
      maxFileBytes: int('UPLOAD_MAX_FILE_BYTES', 5 * 1024 * 1024 * 1024 * 1024),
      urlTtlSeconds: int('UPLOAD_URL_TTL_SECONDS', 3600),
      keyPrefix: (process.env.UPLOAD_KEY_PREFIX ?? 'uploads').replace(/^\/+|\/+$/g, ''),
    },
  };
}
