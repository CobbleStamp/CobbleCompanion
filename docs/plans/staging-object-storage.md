# Plan: Move upload staging to object storage (S3) + filesystem-local

**Status:** ✅ DELIVERED (AWS-only this pass; GCS adapter = tracked follow-up). Code: core
`upload-staging*.ts` (port + S3/filesystem stores), api `upload-staging-factory.ts` +
`sources.requestFileUpload`/`sources.file` + `/uploads/local` route + purge sweep, web two-step
upload, Pulumi `infra/aws/src/storage.ts` (+ iam/compute/index), migration `0011_new_wasp.sql`.
**Branch:** `feat/ws-embodiment`
**Supersedes:** the byte-storage part of `deliver-scalability.md` §D-A (the
`upload_staging bytea` table). The job-queue + `uploadId`-reference model from D-A
is unchanged; only *where the bytes live* and *how they get there* changes.

---

## 1. Problem

D-A stages raw upload bytes in a Postgres `bytea` column (`upload_staging.bytes`),
capped at `INGESTION_MAX_BYTES` (default **25 MB**). Two issues:

1. **Postgres-blob bloat.** Up-to-25 MB blobs live in the primary transactional DB
   (table size, vacuum, backup, replication volume) for a buffer that is meant to
   live seconds.
2. **The leak (issue #3).** `purgeExpired()` — the GC backstop for rows that are
   staged but whose `ingest` job never reaches its `finally` delete (crash /
   lost node / enqueue failure between `stage()` and a completed run) — **is never
   called in production.** No sweep is wired. Leaked rows persist forever (only a
   user delete cascades them away). The `expires_at` index is dead weight.

## 2. Goal

- Raw upload bytes leave Postgres entirely. Production stores them in **S3** under a
  `tmp-uploads/` prefix with a **bucket lifecycle TTL** — so expiry is guaranteed
  server-side and issue #3 cannot recur regardless of application behaviour.
- Local dev / CI use a **filesystem** backend rooted at a configurable directory.
- Backend is selected by env: `UPLOAD_STAGING_BACKEND=s3 | file`. When `file`,
  the root directory is **required** (fail fast at startup if absent).
- File uploads move to **presigned, direct-to-S3** uploads (client → S3), so upload
  bandwidth bypasses the API. The filesystem backend mirrors the same client
  protocol via an API-hosted upload route.
- The `upload_staging` Postgres table and `DrizzleUploadStagingStore` are **removed**
  (destructive migration).

## 3. Decisions (resolved with product owner)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Multi-cloud | **S3 now; provider-agnostic port for GCS later.** Only the AWS Pulumi stack gains a bucket in this pass. |
| 2 | Local/CI backend | **Filesystem**, configurable root, selected by env (`s3`\|`file`); root required when `file`. The `upload_staging` table is dropped. |
| 3 | Upload path | **Presigned client upload (S3)**; filesystem mirrors via an API-hosted PUT route. |

### 3.1 Consequences that need explicit acknowledgement

- **GCP production has no valid backend after this change.** Dropping the Postgres
  table removes GCP Cloud Run's only option (filesystem on Cloud Run is
  instance-local and non-durable across its 1–5 instances; S3-from-GCP needs static
  AWS creds). **GCP is not the MVP target** (the MVP is AWS EC2 single-node; GCP and
  D7 multi-node are deferred in `deliver-scalability.md`). This plan **does not touch
  the GCP stack**; GCP staging is a tracked follow-up = the GCS adapter behind the
  same port. Called out here so it is not a silent regression.
- **Magic-byte validation moves off the synchronous upload path.** Today
  `source.routes.ts` validates magic bytes *before* staging because the API holds the
  bytes. With presigned direct-to-S3, the API never sees the bytes at slot-request
  time. Validation relocates to the **enqueue** step via a cheap **ranged read of the
  first 8 bytes** (`peek`) — not a full 25 MB download. A bad/oversized/missing object
  is rejected there (HEAD for existence + size cap, peek for magic bytes) before any
  source/job row is created.
- **Browser presigned PUT requires S3 bucket CORS.** The bucket needs a CORS rule
  allowing `PUT` from the web origin — included in the Pulumi bucket config.
- **Note/link and the `ingest_source` tool keep server-side staging.** They are tiny
  text the server already holds (and the tool has no browser client), so they use the
  port's server-side `stage(bytes)` write, not a presigned slot. Only browser **file**
  uploads use the presigned slot flow.

## 4. Port design (`packages/core/src/ingestion/upload-staging.ts`)

Keep the name `UploadStagingStore`; extend it. Tableless — the `uploadId` is the
object key; the owner is encoded in the key prefix for authorization.

```ts
// key layout (both backends): tmp-uploads/<ownerId>/<uuid>__<kind>
interface UploadSlot {
  readonly uploadId: string;                 // opaque; encodes owner + kind + uuid
  readonly url: string;                       // absolute URL the client PUTs to
  readonly method: 'PUT';
  readonly headers?: Readonly<Record<string, string>>;
  readonly expiresAt: string;                 // ISO; matches presign / token expiry
}

interface UploadStagingStore {
  /** Issue a presigned/direct upload slot for a client file upload. */
  createUploadSlot(p: { ownerId: string; kind: SourceKind;
                        contentType?: string; maxBytes: number }): Promise<UploadSlot>;
  /** Server-side write for small in-hand payloads (note/link, ingest_source tool). */
  stage(p: StageUploadParams): Promise<{ id: string }>;
  /** Existence + size, without downloading the body. null if absent. */
  head(id: string): Promise<{ byteSize: number } | null>;
  /** First n bytes only (ranged) — for magic-byte validation at enqueue. */
  peek(id: string, n: number): Promise<Uint8Array | null>;
  /** Full read for the ingest job. */
  get(id: string): Promise<StagedUpload | null>;
  delete(id: string): Promise<void>;
  /** Filesystem: delete files past TTL. S3: no-op (bucket lifecycle owns TTL). */
  purgeExpired(): Promise<number>;
}
```

`uploadId` carries `ownerId` (key prefix) so the enqueue step authorizes it against
`ctx.ownerId`; `kind` is parsed from the key suffix so `get()` still returns
`{ id, kind, bytes }` with no metadata table.

### 4.1 Implementations

- **`S3UploadStagingStore`** (`upload-staging-s3.ts`) — `@aws-sdk/client-s3` +
  `@aws-sdk/s3-request-presigner`. `createUploadSlot` → presigned `PutObjectCommand`
  (content-type pinned, expiry = slot TTL). `head`→HeadObject, `peek`→GetObject with
  `Range: bytes=0-(n-1)`, `get`→GetObject, `delete`→DeleteObject (idempotent on
  `NoSuchKey`), `stage`→PutObject, `purgeExpired`→`return 0` (lifecycle owns TTL).
  Credentials via the default SDK chain (EC2 instance role).
- **`FilesystemUploadStagingStore`** (`upload-staging-fs.ts`) — root from config.
  `createUploadSlot` → `{ url: <publicBaseUrl>/uploads/local/<uploadId>, headers }`;
  the client PUTs to an API-hosted route (below). `head/peek/get/delete/stage` operate
  on `<root>/<key>`. `purgeExpired` walks the root and deletes files whose mtime is
  past the TTL. Path-safety: keys are validated to stay within root.
- **Remove** `DrizzleUploadStagingStore`.

## 5. API changes (`packages/api`)

1. **New slot endpoint.** WS method `sources.requestFileUpload` (and the matching
   thing the web client uses) → `{ uploadId, url, method, headers, expiresAt }`.
   Derives `kind` from the supplied filename (`uploadKindForFilename`), rejects
   unknown kinds, enforces the size cap intent.
2. **`enqueue` takes an `uploadId`, not bytes.** New flow:
   `head` (exists + size ≤ `ingestionMaxBytes`, else 4xx) → `peek(8)` + `magicByteError`
   (else 4xx) → authorize key owner === caller → create source + job → enqueue `ingest`.
   The fleet-wide pending-`ingest` backpressure check (`ingest.isFull()`) stays.
3. **Filesystem upload route** `PUT /uploads/local/:uploadId` — `requireAuth`, verifies
   the key prefix owner === caller, streams the body to `<root>/<key>` with a
   size-cap guard. Only meaningful for the `file` backend; not mounted for `s3`.
4. **Note/link WS methods** (`sources.ts`) unchanged in contract — still call
   server-side `stage(bytes)`.
5. **Wire the purge sweep** in `index.ts` next to the existing three
   (`setInterval` + `.unref()` + error log + `clearInterval` on shutdown). For S3 it's
   a cheap no-op; for filesystem it reclaims leaked files. **This is the issue-#3 fix.**
6. **Backend selection + DI** in `index.ts`: build `S3UploadStagingStore` or
   `FilesystemUploadStagingStore` from config; inject the same `UploadStagingStore`
   everywhere it flows today (`AppDeps.staging`, ingest job handler, `ingest_source`
   tool, routes, ws methods).

## 6. Config (`packages/api/src/config.ts`, Zod)

```
UPLOAD_STAGING_BACKEND = 's3' | 'file'          (required)
UPLOAD_STAGING_S3_BUCKET                          (required when backend=s3)
UPLOAD_STAGING_S3_PREFIX = 'tmp-uploads'          (default)
UPLOAD_STAGING_S3_REGION                          (defaults to AWS_REGION)
UPLOAD_STAGING_FS_ROOT                            (required when backend=file)
UPLOAD_STAGING_TTL_MS = 3600000                   (slot/file TTL; matches lifecycle)
PUBLIC_BASE_URL                                   (needed by the fs slot URL)
```

Zod refinement enforces the conditional-required fields (fail fast at startup).
Update `.env.example`.

## 7. Web client (`packages/web`)

File upload becomes two-step: call `sources.requestFileUpload` → `PUT` the file to
the returned `url` with the returned headers → call enqueue with `uploadId`. Surface
upload progress/errors. (Note/link unchanged.)

## 8. Infra — Pulumi AWS (`infra/aws/src/storage.ts`, new)

- `aws.s3.BucketV2` `cobblecompanion-uploads` (+ stack suffix; `forceDestroy: true`
  per the Phase-0 convention), `tags`.
- `BucketLifecycleConfigurationV2`: rule on prefix `tmp-uploads/` → `expiration` 1 day;
  `abortIncompleteMultipartUpload` 1 day.
- `BucketServerSideEncryptionConfigurationV2` (SSE-S3) — matches `encrypted: true`.
- `BucketPublicAccessBlock` — block all public access.
- `BucketCorsConfigurationV2` — `AllowedMethods: [PUT]`, `AllowedOrigins: [<app
  origin from config>]`, `AllowedHeaders: ['*']`, `MaxAgeSeconds`.
- IAM (`iam.ts`): add an inline `RolePolicy` granting the instance role
  `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:HeadObject` (and
  `s3:AbortMultipartUpload`) scoped to `arn:aws:s3:::<bucket>/tmp-uploads/*`. The API
  signs presigned URLs with these creds (default chain on EC2).
- Surface `UPLOAD_STAGING_BACKEND=s3`, `UPLOAD_STAGING_S3_BUCKET`,
  `UPLOAD_STAGING_S3_REGION`, `UPLOAD_STAGING_S3_PREFIX` to the app as **non-secret
  env** via `user-data` (same mechanism as `LLM_MODEL`). Export bucket name from
  `index.ts`. Update `infra/aws/README.md`.
- **GCP stack untouched** (§3.1).

## 9. Schema / migration (`db/`)

Drop `upload_staging` (table + `bytea` custom type if now unused) and add the Drizzle
migration. Remove its export from `db/src/schema.ts`.

## 10. Tests

- **Core:** unit-test `FilesystemUploadStagingStore` against a temp dir (stage/get/
  head/peek/delete/purgeExpired, path-safety, TTL purge). `S3UploadStagingStore`
  against a fake S3 client (in-memory map honoring Range/HEAD). Slot-key owner
  encode/parse round-trip.
- **API:** enqueue rejects missing/oversized/wrong-magic uploads (4xx) using a fake
  staging store; the fs upload route enforces auth + owner + size cap; note/link still
  stage server-side; purge sweep is wired and unref'd.
- Update test fakes (`ingest-source.test.ts`, `ingest-job.test.ts`, `helpers.ts`) to
  the extended port. Default test backend = an in-memory fake (no fs/S3 needed).

## 11. Docs

- `deliver-scalability.md` §D-A: note the byte-storage model was superseded (link here).
- `docs/architecture.md` §6 / `docs/implementation.md` §2.4: update the upload flow
  (presigned two-part, object-storage staging, validation-at-enqueue).
- `infra/setup` + `infra/aws/README.md`: bucket, lifecycle, CORS, IAM, new env.
- `.env.example`.

## 12. Out of scope

- GCS adapter / GCP stack changes (tracked follow-up).
- Presigned **POST** content-length-range enforcement (we cap via HEAD at enqueue;
  can tighten later).
- Resumable / multipart client uploads (single PUT; 25 MB cap).

## 13. Suggested commit slicing

1. Port interface + `FilesystemUploadStagingStore` + in-memory fake + core tests.
2. `S3UploadStagingStore` + presigner + fake-S3 tests.
3. Config + backend selection/DI + drop Drizzle store; DB migration.
4. API: slot endpoint, enqueue-with-uploadId + validation relocation, fs upload route,
   purge sweep; api tests.
5. Web client two-step upload.
6. Pulumi AWS bucket + IAM + env; infra docs.
7. Docs realignment.
