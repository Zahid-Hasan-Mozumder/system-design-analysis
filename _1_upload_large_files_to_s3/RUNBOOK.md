# RUNBOOK — Large File Uploader (S3 Multipart)

Upload files **larger than 2 GB** straight from the browser to S3-compatible
storage (**MinIO** in this setup) using S3 multipart upload, while a NestJS API
tracks every upload in Postgres through Prisma.

The browser sends file bytes **directly to the object store** using presigned
URLs. The backend only ever handles metadata — it never proxies the file —
which is what makes multi-gigabyte uploads practical.

```
frontend/   React (Create React App) — file picker, chunking, progress UI
backend/    NestJS + Prisma + AWS SDK v3 — orchestrates the multipart flow
```

---

## 1. Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Node.js 20+** | Tested on Node 24. `node -v` |
| **PostgreSQL 13+** | Local install, Docker, or a managed instance (RDS/Supabase/Neon). |
| **MinIO** | A running MinIO server reachable from the browser, with a bucket and access/secret keys. (Any S3-compatible store — AWS S3, LocalStack, R2 — also works; see §9.) |

---

## 2. One-time MinIO setup

### 2.1 Endpoint must be browser-reachable
Presigned URLs embed the MinIO host, and the **browser** connects to it directly
to upload each chunk. So `S3_ENDPOINT` must be a hostname the browser can
resolve — `http://localhost:9000`, or a public URL like
`https://s3.your-domain.com`. A docker-internal name (e.g. `http://minio:9000`)
will **not** work from the browser.

### 2.2 Path-style addressing (REQUIRED)
This backend sets `S3_FORCE_PATH_STYLE=true`, so objects are addressed as
`https://<endpoint>/<bucket>/<key>`. MinIO serves path-style by default;
virtual-host style (`<bucket>.<endpoint>`) usually fails to resolve. Leave the
flag `true` unless your MinIO is explicitly configured for virtual-host domains.

### 2.3 Create the bucket
Create the bucket the app will use (e.g. `test`):

```bash
# MinIO client
mc alias set local http://localhost:9000 minioadmin minioadmin
mc mb local/test
```

Or let the backend create it on startup by setting `S3_AUTO_CREATE_BUCKET=true`
in `.env` (best-effort — it logs and continues if MinIO is unreachable).

### 2.4 Credentials
Use the MinIO access key / secret (root console credentials, or a dedicated
service account) as `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. A service
account scoped to the bucket with `s3:*` object + multipart permissions is
enough.

### 2.5 CORS (REQUIRED)
The browser `PUT`s each chunk directly to MinIO, so MinIO **must** allow your
frontend origin and expose the `ETag` response header (the app reads the ETag of
every part). Without this, part uploads fail with an opaque CORS error.

MinIO allows all origins by default. If yours restricts them (or sits behind a
reverse proxy that handles CORS), allow the frontend origin explicitly — e.g.
set `MINIO_API_CORS_ALLOW_ORIGIN=http://localhost:3000` on the MinIO server, and
ensure any proxy passes `OPTIONS` preflights through and does not strip the
`ETag` response header.

---

## 3. Backend — setup & run

```bash
cd backend
npm install
```

### 3.1 Configure environment
```bash
cp .env.example .env     # on Windows PowerShell: copy .env.example .env
```

Edit `backend/.env`:

```ini
PORT=4000
CORS_ORIGINS=http://localhost:3000

DATABASE_URL="postgresql://postgres:postgres@localhost:5432/s3_uploads?schema=public"

# --- MinIO ---
AWS_REGION=us-east-1                       # MinIO ignores it, SDK requires one
S3_BUCKET=test
AWS_ACCESS_KEY_ID=minioadmin
AWS_SECRET_ACCESS_KEY=minioadmin
S3_ENDPOINT=http://localhost:9000          # browser-reachable MinIO URL
S3_FORCE_PATH_STYLE=true                   # REQUIRED for MinIO
S3_AUTO_CREATE_BUCKET=false                # true = create the bucket on startup

# Optional tuning (defaults shown)
UPLOAD_PART_SIZE_BYTES=16777216      # 16 MiB per part
UPLOAD_MAX_FILE_BYTES=5497558138880  # 5 TiB ceiling (the S3 object limit)
UPLOAD_URL_TTL_SECONDS=3600          # presigned part URL lifetime
UPLOAD_KEY_PREFIX=uploads            # key prefix inside the bucket
```

> `S3_ENDPOINT` must be the URL the **browser** uses to reach MinIO (presigned
> URLs embed it). Keep `S3_FORCE_PATH_STYLE=true` for MinIO.

### 3.2 Create the database schema
Make sure the Postgres server is running and the user in `DATABASE_URL` exists.
Then apply migrations (this also generates the Prisma client):

```bash
npm run db:migrate        # first run creates the DB + tables (prisma migrate dev)
```

For a non-dev / CI environment use `npm run db:deploy` instead.

Other DB commands:
```bash
npm run db:generate   # regenerate the Prisma client only
npm run db:studio     # browse the data in Prisma Studio
npm run db:reset      # drop & recreate (destroys all data)
```

### 3.3 Start the backend
```bash
npm run start:dev     # watch mode on http://localhost:4000/api
# or
npm run build && npm run start:prod
```

Health check:
```bash
curl http://localhost:4000/api/health
# {"status":"ok","database":"up","timestamp":"..."}
```

### 3.4 Backend tests
```bash
npm test              # unit tests (chunking math, complete/abort logic)
```

---

## 4. Frontend — setup & run

```bash
cd frontend
npm install
npm start             # http://localhost:3000
```

In development, CRA proxies `/api/*` to `http://localhost:4000` (set via the
`proxy` field in `frontend/package.json`), so no extra config is needed.

If the backend runs elsewhere, create `frontend/.env`:
```ini
REACT_APP_API_BASE=https://api.your-domain.com
```

### 4.1 Frontend tests & build
```bash
npm test              # CI=true npm test for a single run
npm run build         # production bundle in frontend/build
```

---

## 5. Start order (local dev)

1. **Postgres** — running and reachable at `DATABASE_URL`.
2. **Backend** — `cd backend && npm run start:dev` (wait for *"API listening"*).
3. **Frontend** — `cd frontend && npm start`, then open http://localhost:3000.

Pick a file, choose an optional destination folder, and click **Upload to S3**.
Progress, throughput, ETA and per-part counts update live; **Cancel** aborts the
S3 multipart upload and marks the row `ABORTED`.

---

## 6. How the flow maps to the code

| Step | What happens | Where |
|------|--------------|-------|
| 1–2 | Client initiates; server calls S3 `CreateMultipartUpload`, gets an `UploadId` | `POST /api/uploads/initiate` → `S3Service.createMultipartUpload` |
| 3 | Server writes a `PENDING` row with the `UploadId` | `UploadsService.initiate` → Prisma `Upload.create` |
| 4 | Server returns `{ id, partSize, totalParts }` | `InitiateUploadResult` |
| 5–7 | For each part, client asks for a presigned `UploadPart` URL | `POST /api/uploads/:id/part-url` → `S3Service.createPresignedPartUrl` |
| 8–9 | Client `PUT`s the chunk straight to S3, reads the part `ETag` | `frontend/src/uploader.js` (`putPart`) |
| 10 | Client sends the collected `{partNumber, etag}` list | `POST /api/uploads/:id/complete` |
| 11 | Server calls S3 `CompleteMultipartUpload`; S3 stitches the parts | `S3Service.completeMultipartUpload` |
| 12 | Server records parts + flips the row to `COMPLETED` (one transaction) | `UploadsService.complete` |
| 13 | Server returns the final object record | `UploadView` |

Parts upload with bounded concurrency (4 at a time) and each part retries up to
3 times with backoff. A 2 GB file at the 16 MiB default becomes **128 parts**;
part size auto-doubles for very large files so the S3 10,000-part limit is never
exceeded.

### API summary
| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/uploads/initiate` | Open the multipart upload, create the DB row |
| `POST` | `/api/uploads/:id/part-url` | Presigned PUT URL for one part |
| `POST` | `/api/uploads/:id/complete` | Finalize; S3 assembles the object |
| `DELETE` | `/api/uploads/:id` | Abort an in-flight upload |
| `GET` | `/api/uploads/:id/status` | Which parts S3 already holds (resume aid) |
| `GET` | `/api/uploads/:id` | One upload record |
| `GET` | `/api/uploads?limit=25` | Recent uploads |
| `GET` | `/api/health` | Liveness + DB check |

---

## 7. Data model (Postgres, via Prisma)

- **Upload** — one row per multipart upload: file metadata, `sizeBytes` (BigInt),
  `bucket` / `objectKey` / `s3UploadId`, `partSize`, `totalParts`, `status`
  (`PENDING` → `UPLOADING` → `COMPLETED` / `ABORTED` / `FAILED`), final
  `location` + `etag`.
- **UploadPart** — one row per completed part: `partNumber`, `etag`, `sizeBytes`
  (cascade-deleted with its upload).

Schema lives in `backend/prisma/schema.prisma`; the connection string is read
from `backend/prisma.config.ts` (Prisma 7 no longer keeps it in the schema).

---

## 8. Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| Part `PUT` fails with a CORS error in the browser console | MinIO CORS missing or wrong origin; it must allow the frontend origin and expose `ETag` (§2.5). |
| Part `PUT` fails with DNS / `ENOTFOUND <bucket>.<host>` | Virtual-host addressing is being used — set `S3_FORCE_PATH_STYLE=true` (§2.2). |
| `initiate` fails with `NoSuchBucket` | The bucket does not exist — create it (§2.3) or set `S3_AUTO_CREATE_BUCKET=true`. |
| `complete` fails with `InvalidPart` / `EntityTooSmall` | A part other than the last was < 5 MiB, or an ETag was lost. The row is marked `FAILED`; re-upload. |
| Backend won't start: *Missing required environment variable* | Fill in `.env` (`DATABASE_URL`, `S3_BUCKET`). |
| `prisma migrate` can't connect | Postgres not running, or `DATABASE_URL` host/port/credentials wrong. |
| `SignatureDoesNotMatch` | Wrong access key / secret, or large clock skew on the host. |
| `AccessDenied` on part or complete | The MinIO key lacks object / multipart permission on the bucket (§2.4). |
| Browser can't reach the presigned URL host | `S3_ENDPOINT` is not browser-reachable (e.g. a docker-internal name) — use a host the browser resolves (§2.1). |
| Presigned URL expired mid-upload | Increase `UPLOAD_URL_TTL_SECONDS`; the client also re-requests a URL on retry. |
| Uploads stop after cancelling | Expected — Cancel aborts the multipart upload and marks the row `ABORTED`. |

---

## 9. Production notes

- Set `CORS_ORIGINS` (backend) and MinIO's allowed origins to your real frontend
  origin(s); set `REACT_APP_API_BASE` at frontend build time.
- Serve MinIO over HTTPS on a browser-reachable host; use a scoped MinIO service
  account rather than the root credentials.
- Add a MinIO/S3 **lifecycle rule** to abort incomplete multipart uploads after N
  days so abandoned parts don't accrue storage.
- Run `npm run db:deploy` (not `db:migrate`) in CI/CD; serve the frontend's
  `build/` folder from a static host or CDN.
- **To switch to real AWS S3:** leave `S3_ENDPOINT` blank, set
  `S3_FORCE_PATH_STYLE=false`, use your AWS region + IAM credentials (the backend
  falls back to the default AWS credential chain when the keys are blank), and
  configure the bucket's CORS and an IAM policy granting `s3:PutObject`,
  `s3:GetObject`, `s3:AbortMultipartUpload`, `s3:ListMultipartUploadParts`, and
  `s3:ListBucketMultipartUploads`.
