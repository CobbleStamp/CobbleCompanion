/**
 * The Phase 12 Tier-2 user-model retrieval arm (architecture.md §4.3): embeds the turn,
 * hybrid-searches the user's CURRENT beliefs, and renders the top-K as one fenced
 * "what I know about you" grounding block. Owner-scoped; degrades to no block on a
 * missing owner or an embedding failure (recall never breaks the conversation).
 */

import { type Database, EMBEDDING_DIMENSIONS } from '@cobble/db';
import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeEmbeddingGateway } from '../embedding/fake.js';
import type { EmbeddingGateway } from '../embedding/gateway.js';
import { DrizzleIdentityStore } from '../identity/store.js';
import type { Logger } from '../logging.js';
import { beliefPhrase } from '../user-model/phrasing.js';
import { DrizzleUserModelStore } from '../user-model/store.js';
import { createUserModelRetrieveContext } from './user-model-retrieve.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

describe('createUserModelRetrieveContext', () => {
  let db: Database;
  let close: () => Promise<void>;
  let store: DrizzleUserModelStore;
  let embeddings: FakeEmbeddingGateway;
  let userId: string;

  function arm(gateway: EmbeddingGateway = embeddings) {
    return createUserModelRetrieveContext({
      store,
      embeddings: gateway,
      embeddingModel: 'embed',
      embeddingDimensions: EMBEDDING_DIMENSIONS,
      logger: silent,
    });
  }

  /** A unit vector with a single 1 at `hot` — basis vectors are pairwise orthogonal
   *  (cosine distance 1.0), identical ones distance 0.0, so the floor is exercised exactly. */
  function basisVector(hot: number): number[] {
    const v: number[] = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    v[hot] = 1;
    return v;
  }

  /** A gateway that embeds every input to a fixed vector — lets a test place the query
   *  query at a chosen distance from a belief's known embedding. */
  function fixedGateway(vector: readonly number[]): EmbeddingGateway {
    return {
      embed: (params: { input: readonly string[] }) =>
        Promise.resolve({
          vectors: params.input.map(() => vector),
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        }),
    };
  }

  /** Embed a belief's text with the same fake gateway (same natural-language rendering the
   *  harness stores under), so recall can match it. */
  async function embed(predicate: string, object: string): Promise<readonly number[]> {
    const { vectors } = await embeddings.embed({
      input: [beliefPhrase(predicate, object)],
      model: 'embed',
      dimensions: EMBEDDING_DIMENSIONS,
    });
    const [vector] = vectors;
    if (!vector) {
      throw new Error('fake embedding returned no vector');
    }
    return vector;
  }

  /** Record a belief embedded by the same fake gateway, so recall can match it. */
  async function seedBelief(predicate: string, object: string): Promise<string> {
    const embedding = await embed(predicate, object);
    const belief = await store.recordBelief({ userId, predicate, object, embedding });
    return belief.id;
  }

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    close = created.close;
    const identity = new DrizzleIdentityStore(db);
    store = new DrizzleUserModelStore(db);
    embeddings = new FakeEmbeddingGateway();
    const user = await identity.ensureUserByEmail('sam@example.com');
    userId = user.id;
  });

  afterEach(async () => {
    await close();
  });

  it('renders relevant current beliefs as one fenced grounding block', async () => {
    await seedBelief('interestedIn', 'jazz');
    await seedBelief('prefers', 'oat milk');

    const { blocks } = await arm()({
      companionId: 'c1',
      userContent: 'the user is interested in jazz',
      ownerId: userId,
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.role).toBe('system');
    expect(blocks[0]?.content).toContain("What you've learned about the user");
    expect(blocks[0]?.content).toContain('the user is interested in jazz');
  });

  it('drops a belief beyond the vector relevance floor (not the K nearest regardless)', async () => {
    // One belief, embedded at a known basis vector. The default floor (~0.8) decides
    // whether an off-topic turn still pulls it in.
    await store.recordBelief({
      userId,
      predicate: 'interestedIn',
      object: 'jazz',
      embedding: basisVector(0),
    });

    // Query orthogonal to the belief (cosine distance 1.0 > floor) and FTS-disjoint →
    // it is NOT injected, even though topK would happily fit it.
    const offTopic = await arm(fixedGateway(basisVector(7)))({
      companionId: 'c1',
      userContent: 'unrelated weather question',
      ownerId: userId,
    });
    expect(offTopic.blocks).toEqual([]);

    // Query identical to the belief (distance 0 < floor) → it surfaces.
    const onTopic = await arm(fixedGateway(basisVector(0)))({
      companionId: 'c1',
      userContent: 'tell me about jazz',
      ownerId: userId,
    });
    expect(onTopic.blocks[0]?.content).toContain('the user is interested in jazz');
  });

  it('reflects current state only — a replaced belief never resurfaces', async () => {
    const lovesId = await seedBelief('prefers', 'loves coffee');
    await store.replaceBelief(userId, lovesId, {
      userId,
      predicate: 'prefers',
      object: 'quit coffee',
      embedding: await embed('prefers', 'quit coffee'),
    });

    const { blocks } = await arm()({
      companionId: 'c1',
      userContent: 'prefers coffee',
      ownerId: userId,
    });

    const content = blocks[0]?.content ?? '';
    expect(content).not.toContain('loves coffee');
    expect(content).toContain('quit coffee');
  });

  it('contributes nothing when the turn has no owner', async () => {
    await seedBelief('interestedIn', 'jazz');
    const { blocks } = await arm()({ companionId: 'c1', userContent: 'jazz' });
    expect(blocks).toEqual([]);
  });

  it('contributes nothing when the user has no beliefs', async () => {
    const { blocks } = await arm()({ companionId: 'c1', userContent: 'jazz', ownerId: userId });
    expect(blocks).toEqual([]);
  });

  it('degrades to no block when embedding fails (recall never breaks the turn)', async () => {
    await seedBelief('interestedIn', 'jazz');
    const broken: EmbeddingGateway = {
      embed: () => Promise.reject(new Error('provider down')),
    };
    const { blocks } = await arm(broken)({
      companionId: 'c1',
      userContent: 'jazz',
      ownerId: userId,
    });
    expect(blocks).toEqual([]);
  });
});
