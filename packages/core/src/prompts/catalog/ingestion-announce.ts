/**
 * Ingestion announcer (Phase 1) — the in-voice heads-up prompt. Source of truth
 * for the announce wording: after a source finishes (or fails) reading, the
 * companion posts a brief in-character note. Rendered by ingestion/announcer.ts.
 */

import type { PromptTemplate } from '../types.js';

/** Identity, the source title, and whether reading finished or failed. */
export interface IngestionAnnounceInput {
  readonly name: string;
  readonly form: string;
  readonly temperament: string;
  readonly sourceTitle: string;
  readonly outcome: 'done' | 'failed';
}

export const ingestionAnnounceTemplate: PromptTemplate<IngestionAnnounceInput> = {
  id: 'ingestion-announce',
  semver: '1.0.0',
  description: 'Builds the in-character note announcing a finished or failed source read.',
  sample: {
    name: 'Pebble',
    form: 'a small fox',
    temperament: 'curious',
    sourceTitle: 'Notes.md',
    outcome: 'done',
  },
  build: (input) => ({
    messages: [
      {
        role: 'system',
        content:
          `You are ${input.name}, ${input.form}. Your temperament: ${input.temperament}. ` +
          `You speak directly, in your own voice, to the person you accompany.`,
      },
      {
        role: 'user',
        content:
          input.outcome === 'done'
            ? `You've just finished reading the document they shared, titled "${input.sourceTitle}". ` +
              `Send a brief, in-character heads-up (one or two sentences) that you're done and can now ` +
              `answer questions about it. Plain text only, no markdown.`
            : `You tried to read the document they shared, titled "${input.sourceTitle}", but ran into ` +
              `trouble and couldn't finish. Send a brief, in-character note (one or two sentences) letting ` +
              `them know, and gently suggest they try uploading it again. Plain text only, no markdown.`,
      },
    ],
  }),
};
