/** render() stamps the right version; versionOf() caches per template. */

import { describe, expect, it } from 'vitest';
import { render, versionOf } from './render.js';
import { contentHash } from './version.js';
import type { PromptTemplate } from './types.js';

interface Greeting {
  readonly name: string;
}

const greetingTemplate: PromptTemplate<Greeting> = {
  id: 'persona',
  semver: '1.0.0',
  description: 'Test template that greets by name.',
  sample: { name: 'sample' },
  build: (input) => ({
    messages: [
      { role: 'system', content: 'You greet people.' },
      { role: 'user', content: `Greet ${input.name}.` },
    ],
  }),
};

const toolTemplate: PromptTemplate<Greeting> = {
  id: 'affect-sense',
  semver: '2.1.0',
  description: 'Test template that advertises a tool.',
  sample: { name: 'sample' },
  build: (input) => ({
    messages: [{ role: 'user', content: `Sense ${input.name}.` }],
    tools: [{ name: 'report', description: 'report', parameters: { type: 'object' } }],
  }),
};

describe('render', () => {
  it('interpolates the input into the messages', () => {
    const rendered = render(greetingTemplate, { name: 'Pebble' });
    expect(rendered.messages[1]?.content).toBe('Greet Pebble.');
  });

  it('stamps the prompt id and declared semver on the ref', () => {
    const rendered = render(greetingTemplate, { name: 'Pebble' });
    expect(rendered.ref.id).toBe('persona');
    expect(rendered.ref.version.semver).toBe('1.0.0');
  });

  it('stamps a content hash that matches the rendered output of the sample', () => {
    const rendered = render(greetingTemplate, { name: 'Pebble' });
    const expected = contentHash(greetingTemplate.build(greetingTemplate.sample));
    expect(rendered.ref.version.contentHash).toBe(expected);
  });

  it('carries advertised tools through and omits them otherwise', () => {
    expect(render(toolTemplate, { name: 'x' }).tools).toHaveLength(1);
    expect(render(greetingTemplate, { name: 'x' }).tools).toBeUndefined();
  });
});

describe('versionOf', () => {
  it('returns a stable version across calls', () => {
    expect(versionOf(toolTemplate)).toEqual(versionOf(toolTemplate));
  });

  it('resolves each template by its own content, even when two share an id', () => {
    // Two distinct templates that share one id but differ in wording + semver.
    // (The id type is a closed union, so a test template must reuse a real id —
    // that reuse is exactly what makes the collision reachable.)
    const original: PromptTemplate<Greeting> = {
      id: 'judge',
      semver: '1.0.0',
      description: 'First template registered under a shared id.',
      sample: { name: 'sample' },
      build: (input) => ({
        messages: [{ role: 'user', content: `Original ${input.name}.` }],
      }),
    };
    const reworded: PromptTemplate<Greeting> = {
      ...original,
      semver: '2.0.0',
      build: (input) => ({
        messages: [{ role: 'user', content: `Reworded ${input.name}.` }],
      }),
    };

    const originalVersion = versionOf(original);
    const rewordedVersion = versionOf(reworded);

    // Each version must reflect its OWN wording and semver. With a cache keyed
    // by id alone, `reworded` gets `original`'s cached version and these collide.
    expect(rewordedVersion.contentHash).not.toBe(originalVersion.contentHash);
    expect(rewordedVersion.semver).toBe('2.0.0');
  });
});
