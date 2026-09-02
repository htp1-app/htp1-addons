import { describe, it, expect } from 'vitest';
import {
  chainGain,
  classifyReading,
  nextStimulus,
  snapshotOutputs,
  reduceDemand,
  tracksStimulus,
} from './sweepCore.js';
import { VU_VAL_TO_DBFS } from '@/calibration/vuDecode.js';

// Index in the meter table for a given dBFS value (test helper).
function vuIndexOf(dbfs) {
  const i = VU_VAL_TO_DBFS.indexOf(dbfs);
  if (i < 0) throw new Error('not a table value: ' + dbfs);
  return i;
}

describe('chainGain — on-device test-2 numbers (2026-08-05)', () => {
  // 1 kHz sine at -20 dBFS, MV -40. H=18: reading -46. H=30: reading -58.
  // Both must yield the same chain gain — the volume/headroom-independence
  // property that makes the sweep arithmetic valid (milestone 2 exit check).
  it('H=18 and H=30 rows agree', () => {
    const a = chainGain({ readingDbfs: -46, stimulusDbfs: -20, hConfigured: 18, masterVolume: -40 });
    const b = chainGain({ readingDbfs: -58, stimulusDbfs: -20, hConfigured: 30, masterVolume: -40 });
    expect(a).toBe(-8);
    expect(b).toBe(-8);
  });

  it('headroom pins to 1 - MV near the top of the dial', () => {
    // At MV -5 with H=18 configured, only 6 dB of digital attenuation is in
    // effect; the add-back must use min(H, 1-MV), not H.
    expect(
      chainGain({ readingDbfs: -20, stimulusDbfs: -20, hConfigured: 18, masterVolume: -5 }),
    ).toBe(6);
  });
});

describe('classifyReading / nextStimulus', () => {
  it('accepts a mid-scale reading', () => {
    const r = classifyReading(0x80 | vuIndexOf(-6));
    expect(r.dbfs).toBe(-6);
    expect(r.nearCeiling).toBe(false);
    expect(nextStimulus({ stimulusDbfs: -20, ...r }).action).toBe('accept');
  });

  it('re-probes 12 dB down at +4 dBFS and above', () => {
    const r = classifyReading(0x80 | vuIndexOf(4.5));
    expect(r.nearCeiling).toBe(true);
    const n = nextStimulus({ stimulusDbfs: -20, ...r });
    expect(n.action).toBe('reprobe');
    expect(n.stimulusDbfs).toBe(-32);
  });

  it('re-probes on the sticky clip bit regardless of level', () => {
    const r = classifyReading(0x80 | 0x40 | vuIndexOf(-6));
    expect(r.clipped).toBe(true);
    expect(nextStimulus({ stimulusDbfs: -20, ...r }).action).toBe('reprobe');
  });

  it('refines a coarse-region reading toward -4 dBFS', () => {
    const r = classifyReading(0x80 | vuIndexOf(-30));
    const n = nextStimulus({ stimulusDbfs: -40, ...r });
    expect(n.action).toBe('refine');
    expect(n.stimulusDbfs).toBe(-40 + (-4 - -30)); // -14 dBFS
  });

  it('never raises the stimulus above 0 dBFS', () => {
    const r = classifyReading(0x80 | vuIndexOf(-40));
    const n = nextStimulus({ stimulusDbfs: -20, ...r });
    expect(n.stimulusDbfs).toBe(0);
  });

  it('never drops below the floor', () => {
    const r = classifyReading(0x80 | 0x40 | vuIndexOf(6));
    const n = nextStimulus({ stimulusDbfs: -76, ...r });
    expect(n.stimulusDbfs).toBe(-80);
  });
});

describe('snapshotOutputs', () => {
  it('reads all output channels and finds the hottest (Bass Control cross-feed)', () => {
    // Modeled on test 1: 30 Hz on front left lands on the subs.
    const arr = [];
    arr[0] = 0x80 | vuIndexOf(-76); // lf
    arr[13] = 0x80 | vuIndexOf(-50); // sub1
    arr[14] = 0x80 | vuIndexOf(-42); // sub2
    const { readings, max } = snapshotOutputs(arr, [
      { channel: 'lf', index: 0 },
      { channel: 'sub1', index: 13 },
      { channel: 'sub2', index: 14 },
    ]);
    expect(readings).toHaveLength(3);
    expect(max.channel).toBe('sub2');
    expect(max.dbfs).toBe(-42);
  });

  it('missing or inactive meter data can never become a winning reading', () => {
    const { max, anyActive } = snapshotOutputs([], [{ channel: 'lf', index: 0 }]);
    expect(max).toBeNull();
    expect(anyActive).toBe(false);
  });

  it('excludes inactive channels from the max even when others are active', () => {
    const arr = [];
    arr[0] = VU_VAL_TO_DBFS.indexOf(-2); // no 0x80: invalid, even though "loud"
    arr[1] = 0x80 | VU_VAL_TO_DBFS.indexOf(-40);
    const { max, anyActive } = snapshotOutputs(arr, [
      { channel: 'lf', index: 0 },
      { channel: 'rf', index: 1 },
    ]);
    expect(anyActive).toBe(true);
    expect(max.channel).toBe('rf');
    expect(max.dbfs).toBe(-40);
  });
});

describe('tracksStimulus — the stale-reading invariant', () => {
  it('accepts a reading that follows the stimulus', () => {
    expect(tracksStimulus({ stimulusA: -20, readingA: -26, stimulusB: -26, readingB: -32 })).toBe(true);
    // meter quantization slack (2 dB steps in the coarse region)
    expect(tracksStimulus({ stimulusA: -20, readingA: -26, stimulusB: -26, readingB: -30 })).toBe(true);
  });

  it('refutes a reading that ignores the stimulus (the 34.5 dB artifact)', () => {
    // stale -3.5 held across a 20 dB stimulus change
    expect(tracksStimulus({ stimulusA: 0, readingA: -3.5, stimulusB: -20, readingB: -3.5 })).toBe(false);
    // and across the 6 dB verification drop
    expect(tracksStimulus({ stimulusA: -20, readingA: -3.5, stimulusB: -26, readingB: -3.5 })).toBe(false);
  });

  it('treats floor-to-floor as tracking (nothing to verify)', () => {
    expect(tracksStimulus({ stimulusA: -20, readingA: -86, stimulusB: -26, readingB: -86 })).toBe(true);
  });
});

describe('reduceDemand', () => {
  it('takes the max over inputs, tones, and output channels with attribution', () => {
    const result = reduceDemand({
      lf: [
        { freqHz: 32, stimulusDbfs: -20, readingDbfs: -10, outputChannel: 'sub2', chainGainDb: 16, clipped: false },
        { freqHz: 1000, stimulusDbfs: -20, readingDbfs: -26, outputChannel: 'lf', chainGainDb: 0, clipped: false },
      ],
      rf: [
        { freqHz: 40, stimulusDbfs: -20, readingDbfs: -14, outputChannel: 'sub1', chainGainDb: 12, clipped: false },
      ],
    });
    expect(result.demandDb).toBe(16);
    expect(result.peakFreqHz).toBe(32);
    expect(result.peakInputChannel).toBe('lf');
    expect(result.peakOutputChannel).toBe('sub2');
    expect(result.perInput.rf.maxChainGainDb).toBe(12);
    expect(result.perInput.rf.atFreqHz).toBe(40);
    // 32 Hz and 40 Hz both sit inside the BEQ band; 1000 Hz does not
    expect(result.lowBandDemandDb).toBe(16);
  });

  it('reports the low-band maximum separately when the overall peak sits outside the BEQ band', () => {
    const result = reduceDemand({
      sr: [
        { freqHz: 120, stimulusDbfs: -20, readingDbfs: -2, outputChannel: 'sr', chainGainDb: 18, clipped: false },
        { freqHz: 30, stimulusDbfs: -20, readingDbfs: -16, outputChannel: 'sub1', chainGainDb: 4, clipped: false },
      ],
    });
    expect(result.demandDb).toBe(18);
    expect(result.peakFreqHz).toBe(120);
    expect(result.lowBandDemandDb).toBe(4);
  });

  it('excludes tones outside 15-40 Hz from the low-band figure', () => {
    const result = reduceDemand({
      lf: [
        { freqHz: 14, stimulusDbfs: -20, readingDbfs: -5, outputChannel: 'sub1', chainGainDb: 15, clipped: false },
        { freqHz: 41, stimulusDbfs: -20, readingDbfs: -6, outputChannel: 'sub1', chainGainDb: 14, clipped: false },
        { freqHz: 25, stimulusDbfs: -20, readingDbfs: -12, outputChannel: 'sub1', chainGainDb: 8, clipped: false },
      ],
    });
    expect(result.lowBandDemandDb).toBe(8);
  });

  it('returns null low-band demand when no tone fell inside the band', () => {
    const result = reduceDemand({
      lf: [
        { freqHz: 1000, stimulusDbfs: -20, readingDbfs: -20, outputChannel: 'lf', chainGainDb: 0, clipped: false },
      ],
    });
    expect(result.lowBandDemandDb).toBeNull();
  });

  it('returns null demand for an empty result set', () => {
    expect(reduceDemand({}).demandDb).toBeNull();
    expect(reduceDemand({}).lowBandDemandDb).toBeNull();
  });
});
