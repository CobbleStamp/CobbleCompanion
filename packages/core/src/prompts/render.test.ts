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
});
