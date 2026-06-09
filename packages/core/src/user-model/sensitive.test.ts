import { describe, expect, it } from 'vitest';
import { isGatedSensitive, isSensitiveMatter, SENSITIVE_WRITE_CONFIDENCE } from './sensitive.js';

describe('isSensitiveMatter', () => {
  it('flags protected matters by lexicon (word-boundary)', () => {
    expect(isSensitiveMatter('believes', 'is a devout Muslim')).toBe(true);
    expect(isSensitiveMatter('prefers', 'therapy on Tuesdays')).toBe(true);
    expect(isSensitiveMatter('believes', 'votes Republican')).toBe(true);
    expect(isSensitiveMatter('interestedIn', 'LGBTQ rights')).toBe(true);
  });

  it('flags age/gender by predicate regardless of object', () => {
    expect(isSensitiveMatter('bornOn', '1990-05-01')).toBe(true);
    expect(isSensitiveMatter('gender', 'woman')).toBe(true);
  });

  it('does not flag ordinary preferences', () => {
    expect(isSensitiveMatter('prefers', 'oat milk')).toBe(false);
    expect(isSensitiveMatter('interestedIn', 'Rust programming')).toBe(false);
    expect(isSensitiveMatter('livesIn', 'Berlin')).toBe(false);
  });

  it('matches on word boundaries, not substrings', () => {
    // "classical" must not match a "class"-style term; "gaylord" must not match "gay".
    expect(isSensitiveMatter('interestedIn', 'classical music')).toBe(false);
    expect(isSensitiveMatter('interestedIn', 'Gaylord Hotels')).toBe(false);
  });
});

describe('isGatedSensitive', () => {
  it('gates a low-confidence inference about a protected matter', () => {
    expect(isGatedSensitive('believes', 'is Catholic', 0.4)).toBe(true);
  });

  it('lets an explicit (high-confidence) sensitive statement through', () => {
    expect(isGatedSensitive('believes', 'is Catholic', 0.9)).toBe(false);
    expect(isGatedSensitive('believes', 'is Catholic', SENSITIVE_WRITE_CONFIDENCE)).toBe(false);
  });

  it('treats null/absent confidence as authoritative (passes)', () => {
    expect(isGatedSensitive('believes', 'is Catholic', null)).toBe(false);
    expect(isGatedSensitive('believes', 'is Catholic', undefined)).toBe(false);
  });

  it('never gates a non-sensitive belief, even at low confidence', () => {
    expect(isGatedSensitive('prefers', 'oat milk', 0.1)).toBe(false);
  });
});
