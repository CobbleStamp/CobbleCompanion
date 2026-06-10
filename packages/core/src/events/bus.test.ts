import type { MessageDto } from '@cobble/shared';
import { describe, expect, it } from 'vitest';
import { InProcessCompanionEventBus } from './bus.js';

function message(id: string, companionId: string, content: string): MessageDto {
  return {
    id,
    companionId,
    role: 'assistant',
    content,
    kind: 'message',
    sourceId: null,
    createdAt: '2026-01-03T00:00:00.000Z',
  };
}

describe('InProcessCompanionEventBus', () => {
  it('delivers a published row to a live subscriber', async () => {
    const bus = new InProcessCompanionEventBus();
    const sub = bus.subscribe('c1');

    bus.publish('c1', message('m1', 'c1', 'hello'));

    const next = await sub.events.next();
    expect(next.done).toBe(false);
    expect(next.value).toMatchObject({ id: 'm1', content: 'hello' });
    sub.close();
  });

  it('resolves a parked consumer when a row arrives (waiter path)', async () => {
    const bus = new InProcessCompanionEventBus();
    const sub = bus.subscribe('c1');

    // Park on next() BEFORE anything is published, then publish.
    const pending = sub.events.next();
    bus.publish('c1', message('m1', 'c1', 'later'));

    const next = await pending;
    expect(next.value).toMatchObject({ id: 'm1' });
    sub.close();
  });

  it('preserves publish order across buffered rows', async () => {
    const bus = new InProcessCompanionEventBus();
    const sub = bus.subscribe('c1');

    bus.publish('c1', message('m1', 'c1', 'one'));
    bus.publish('c1', message('m2', 'c1', 'two'));

    expect((await sub.events.next()).value).toMatchObject({ id: 'm1' });
    expect((await sub.events.next()).value).toMatchObject({ id: 'm2' });
    sub.close();
  });

  it('fans a row out to every subscriber of the same companion', async () => {
    const bus = new InProcessCompanionEventBus();
    const a = bus.subscribe('c1');
    const b = bus.subscribe('c1');

    bus.publish('c1', message('m1', 'c1', 'broadcast'));

    expect((await a.events.next()).value).toMatchObject({ id: 'm1' });
    expect((await b.events.next()).value).toMatchObject({ id: 'm1' });
    a.close();
    b.close();
  });

  it('isolates companions — a publish never crosses to another companion', async () => {
    const bus = new InProcessCompanionEventBus();
    const other = bus.subscribe('c2');

    bus.publish('c1', message('m1', 'c1', 'for c1'));

    // c2's subscriber must still be parked (nothing delivered); prove it by
    // racing its next() against an immediate tick.
    const race = await Promise.race([
      other.events.next().then(() => 'delivered'),
      Promise.resolve('empty'),
    ]);
    expect(race).toBe('empty');
    other.close();
  });

  it('is a no-op when publishing to a companion with no subscribers', () => {
    const bus = new InProcessCompanionEventBus();
    expect(() => bus.publish('nobody', message('m1', 'nobody', 'x'))).not.toThrow();
  });

  it('completes the iterator on close and ignores rows published after', async () => {
    const bus = new InProcessCompanionEventBus();
    const sub = bus.subscribe('c1');

    sub.close();
    const next = await sub.events.next();
    expect(next.done).toBe(true);

    // A publish after close must not resurrect or throw.
    expect(() => bus.publish('c1', message('m1', 'c1', 'late'))).not.toThrow();
  });

  it('closing one subscriber leaves the other receiving', async () => {
    const bus = new InProcessCompanionEventBus();
    const a = bus.subscribe('c1');
    const b = bus.subscribe('c1');

    a.close();
    bus.publish('c1', message('m1', 'c1', 'still here'));

    expect((await b.events.next()).value).toMatchObject({ id: 'm1' });
    b.close();
  });

  it('supports a fresh subscription after all prior ones closed (bucket cleanup)', async () => {
    const bus = new InProcessCompanionEventBus();
    const first = bus.subscribe('c1');
    first.close();

    const second = bus.subscribe('c1');
    bus.publish('c1', message('m1', 'c1', 'reopened'));
    expect((await second.events.next()).value).toMatchObject({ id: 'm1' });
    second.close();
  });

  it('return() closes the subscription (for-await break path)', async () => {
    const bus = new InProcessCompanionEventBus();
    const sub = bus.subscribe('c1');

    const result = await sub.events.return!();
    expect(result.done).toBe(true);
    // After return, a publish is ignored and the next read is terminal.
    bus.publish('c1', message('m1', 'c1', 'late'));
    expect((await sub.events.next()).done).toBe(true);
  });
});
