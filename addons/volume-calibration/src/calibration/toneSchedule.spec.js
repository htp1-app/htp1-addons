import { describe, it, expect } from 'vitest';
import { buildToneSchedule, estimateDuration } from './toneSchedule.js';

describe('buildToneSchedule', () => {
  const tones = buildToneSchedule();

  it('is strictly ascending', () => {
    for (let i = 1; i < tones.length; i++) {
      expect(tones[i]).toBeGreaterThan(tones[i - 1]);
    }
  });

  it('starts at 15 Hz, includes 250 Hz once, ends at 20 kHz', () => {
    expect(tones[0]).toBe(15);
    expect(tones.filter((f) => f === 250)).toHaveLength(1);
    expect(tones[tones.length - 1]).toBe(20000);
  });

  it('is integer Hz throughout — the /sgen/sinehz setter truncates fractions', () => {
    for (const f of tones) {
      expect(Number.isInteger(f)).toBe(true);
    }
  });

  it('steps 1/12 octave below 250 Hz and 1/3 octave above', () => {
    const twelfth = Math.pow(2, 1 / 12);
    const third = Math.pow(2, 1 / 3);
    for (let i = 1; i < tones.length - 1; i++) {
      const ratio = tones[i] / tones[i - 1];
      const expected = tones[i] <= 250 ? twelfth : third;
      // integer rounding perturbs the ratio slightly at low frequencies
      expect(ratio).toBeGreaterThan(expected * 0.97);
      expect(ratio).toBeLessThan(expected * 1.03);
    }
  });

  it('has roughly the spec tone count (~60-75)', () => {
    expect(tones.length).toBeGreaterThanOrEqual(60);
    expect(tones.length).toBeLessThanOrEqual(75);
  });
});

describe('estimateDuration', () => {
  it('multiplies out to seconds', () => {
    expect(estimateDuration(68, 2, 1500)).toBe(204);
  });
});
