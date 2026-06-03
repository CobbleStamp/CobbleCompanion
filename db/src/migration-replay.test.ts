/**
 * Migration-replay test: apply the committed `db/migrations/0000–0005` SQL files
 * in journal order against a fresh PGlite instance (pgvector loaded, exactly as
 * production migrates) and assert the resulting schema is usable end-to-end —
 * including the columns/states added by the latest migrations (`ingestion_jobs.
 * parsed_doc` from 0005, the `user_token_usage` table from 0004, and the
 * `deferred` job status the pipeline relies on).
 *
 * This exercises the migration files directly (not the drizzle schema push), so
 * a migration that drifts from `schema.ts` — or a CREATE/DROP ordering bug —
 * fails here. Uses raw SQL so the assertions depend only on the migrated DDL.
 */

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMBEDDING_DIMENSIONS } from './schema.js';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

/** A `[1,0,0,…]` vector literal sized to the embedding column's dimensions. */
function unitVectorLiteral(): string {
  const values: number[] = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  values[0] = 1;
  return `[${values.join(',')}]`;
}

describe('migration replay (0000–0005 against a fresh PGlite)', () => {
  let client: PGlite;

  beforeEach(async () => {
    client = new PGlite({ extensions: { vector } });
    // Apply the committed migration files in journal order (the same migrator
    // and folder production uses), against an otherwise empty database.
    const pglite = drizzle(client);
    await migrate(pglite, { migrationsFolder });
  });

  afterEach(async () => {
    await client.close();
  });

  it('builds the final table set (dropped legacy tables are gone)', async () => {
    const result = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    );
    const tables = result.rows.map((row) => row.table_name);
    // The end state of the schema (schema.ts), reached by replaying every step.
    expect(tables).toEqual(
      expect.arrayContaining([
        'companions',
        'facts',
        'ingestion_jobs',
        'messages',
        'sections',
        'sources',
        'user_token_usage',
        'users',
      ]),
    );
    // Tables created early then dropped by later migrations must not survive.
    expect(tables).not.toContain('auth_tokens'); // dropped in 0001
    expect(tables).not.toContain('conversations'); // dropped in 0002
  });

  it('inserts a source, an embedded section, and reads them back', async () => {
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ('replay@example.com') RETURNING id`,
    );
    const userId = user.rows[0]!.id;
    const companion = await client.query<{ id: string }>(
      `INSERT INTO companions (owner_id, name, form, temperament)
       VALUES ($1, 'Pebble', 'fox', 'curious') RETURNING id`,
      [userId],
    );
    const companionId = companion.rows[0]!.id;
    const source = await client.query<{ id: string }>(
      `INSERT INTO sources (companion_id, kind, title, raw_text)
       VALUES ($1, 'note', 'Peru book', 'ceviche history in Lima') RETURNING id`,
      [companionId],
    );
    const sourceId = source.rows[0]!.id;

    const section = await client.query<{ id: string; fts: string }>(
      `INSERT INTO sections
         (companion_id, source_id, topic_title, original_text, para_start, para_end, ord, embedding)
       VALUES ($1, $2, 'topic', 'ceviche history in Lima', 1, 1, 0, $3::vector)
       RETURNING id, fts::text AS fts`,
      [companionId, sourceId, unitVectorLiteral()],
    );
    // The generated FTS column (from migration 0003) is populated from the
    // text — `to_tsvector('english', …)` stems "ceviche" to "cevich".
    expect(section.rows[0]!.fts).toContain('cevich');

    // The vector column is queryable with the cosine-distance operator.
    const ranked = await client.query<{ id: string }>(
      `SELECT id FROM sections
       WHERE companion_id = $1
       ORDER BY embedding <=> $2::vector
       LIMIT 1`,
      [companionId, unitVectorLiteral()],
    );
    expect(ranked.rows[0]!.id).toBe(section.rows[0]!.id);
  });

  it('records per-user token usage via the user_token_usage table (0004)', async () => {
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ('budget@example.com') RETURNING id`,
    );
    const userId = user.rows[0]!.id;

    await client.query(
      `INSERT INTO user_token_usage (user_id, window_reset_at, used_tokens)
       VALUES ($1, now() + interval '1 day', 1234)`,
      [userId],
    );
    const usage = await client.query<{ used_tokens: string; cap_override: number | null }>(
      `SELECT used_tokens, cap_override FROM user_token_usage WHERE user_id = $1`,
      [userId],
    );
    // used_tokens is bigint → comes back as a string; cap_override defaults null.
    expect(Number(usage.rows[0]!.used_tokens)).toBe(1234);
    expect(usage.rows[0]!.cap_override).toBeNull();
  });

  it('holds a parsed doc on a deferred ingestion job (parsed_doc from 0005)', async () => {
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ('defer@example.com') RETURNING id`,
    );
    const companion = await client.query<{ id: string }>(
      `INSERT INTO companions (owner_id, name, form, temperament)
       VALUES ($1, 'Pebble', 'fox', 'curious') RETURNING id`,
      [user.rows[0]!.id],
    );
    const companionId = companion.rows[0]!.id;
    const source = await client.query<{ id: string }>(
      `INSERT INTO sources (companion_id, kind, title, raw_text)
       VALUES ($1, 'note', 'Parked', 'held') RETURNING id`,
      [companionId],
    );

    const job = await client.query<{ status: string; parsed_doc: unknown }>(
      `INSERT INTO ingestion_jobs (companion_id, source_id, status, parsed_doc)
       VALUES ($1, $2, 'deferred', $3::jsonb)
       RETURNING status, parsed_doc`,
      [
        companionId,
        source.rows[0]!.id,
        JSON.stringify({ rawText: 'held', paragraphs: [{ ord: 1, text: 'held' }] }),
      ],
    );
    expect(job.rows[0]!.status).toBe('deferred');
    expect(job.rows[0]!.parsed_doc).toMatchObject({
      rawText: 'held',
      paragraphs: [{ ord: 1, text: 'held' }],
    });
  });

  it('exposes parsed_doc as a nullable jsonb column on ingestion_jobs', async () => {
    const column = await client.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'ingestion_jobs' AND column_name = 'parsed_doc'`,
    );
    expect(column.rows).toHaveLength(1);
    expect(column.rows[0]!.data_type).toBe('jsonb');
    expect(column.rows[0]!.is_nullable).toBe('YES');
  });
});
