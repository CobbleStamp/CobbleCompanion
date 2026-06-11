/**
 * Autonomous burst report note (Phase 4.1, companion-motivation.md §5) — the
 * "here's what I read on my own" prompt. Source of truth for the report-note
 * wording: after the companion autonomously reads leads, it posts one
 * in-character note. Rendered by motivation/autonomous-burst.ts (billed to energy).
 *
 * The note SUMMARISES findings (it leads with substance), keeps personality
 * light, and offers further detail as an optional door the user can leave closed
 * — it never pre-commits them to digging in. The substance comes from each
 * source's section digest (topic titles + enrichment context-headers), not just
 * the URLs, so the companion has something real to report rather than gesturing
 * at what it read.
 */

import type { PromptTemplate } from '../types.js';

/** One read source and the short findings (topic / context-header lines) pulled from it. */
export interface ReadSourceDigest {
  readonly title: string;
  readonly findings: readonly string[];
}

/** Identity (incl. optional evolved persona) and the digests of what was just read. */
export interface AutonomousNoteInput {
  readonly name: string;
  readonly form: string;
  readonly temperament: string;
  readonly evolvedPersona: string | null;
  readonly sources: readonly ReadSourceDigest[];
}

/** Render one source as a titled block of its findings (or a bare title if none). */
function renderSource(source: ReadSourceDigest): string {
  if (source.findings.length === 0) {
    return `From ${source.title}: (no detail captured)`;
  }
  return `From ${source.title}:\n` + source.findings.map((finding) => `  - ${finding}`).join('\n');
}

export const autonomousNoteTemplate: PromptTemplate<AutonomousNoteInput> = {
  id: 'autonomous-note',
  semver: '1.1.0',
  description: 'Builds the in-character note summarising an autonomous reading burst.',
  sample: {
    name: 'Pebble',
    form: 'a small fox',
    temperament: 'curious',
    evolvedPersona: null,
    sources: [
      {
        title: 'An Article',
        findings: ['The euro-area inflation outlook softened in Q2.'],
      },
    ],
  },
  build: (input) => {
    const persona = input.evolvedPersona ? ` ${input.evolvedPersona}` : '';
    return {
      messages: [
        {
          role: 'system',
          content:
            `You are ${input.name}, ${input.form}. Your temperament: ${input.temperament}.` +
            persona +
            ` You speak directly, in your own voice, to the person you accompany.`,
        },
        {
          role: 'user',
          content:
            `On your own initiative, while they were away, you worked through your ` +
            `reading list. Here is what you took in:\n\n` +
            input.sources.map(renderSource).join('\n\n') +
            `\n\nWrite them a short note about it. Lead with the substance: in one or ` +
            `two plain sentences, summarise the gist of what you learned, naming the ` +
            `concrete points — not just that you read something. Stay in your own ` +
            `voice, but keep the personality light; the findings come first, not the ` +
            `performance. If you only have a little detail on something, say so ` +
            `honestly rather than inventing specifics. Then offer, in a single short ` +
            `question, one specific thread they could pull on for more detail — and ` +
            `leave it entirely optional; do not assume they want to dig in. Two to ` +
            `four sentences total, plain text, no markdown.`,
        },
      ],
    };
  },
};
