import { describe, it, expect } from 'vitest';
import {
  V_CEILING,
  headroomAt,
  hMax,
  thdZone,
  solve,
  solveAtVoltage,
  solvePreservingHeadroom,
  operatingPoints,
  gainSplit,
  effectiveHeadroom,
  zeroPointSpec,
  zeroPointSetting,
  captureVRef,
} from './gainModel.js';

// Handoff §8 validation matrix. Note on the last row: the handoff prints
// "2.4 V / 4.6 dB -> 4.00 V at limit", but under the verified model
// 2.4 * 10^((4.6-1)/20) = 3.63 V (feasible, not at limit); the printed row
// appears to omit the -1 term that every other row includes. We encode the
// model-correct expectation.
const MATRIX = [
  // [amp, wantH, outputVoltage, maxVol, feasible, thdZone]
  [0.5, 18, 3.54, -17, true, 'degraded'],
  [1.0, 12, 3.55, -11, true, 'degraded'],
  [1.2, 10, 3.38, -9, true, 'acceptable'], // "just inside knee"
  [1.66, 8.6, 4.0, -7.6, true, 'degraded'], // at limit: H_max exactly
  [1.66, 18, null, null, false, null], // requires 11.75 V, short 9.4
  [2.0, 12, null, null, false, null], // H_max = 7.0
  [4.0, 6, null, null, false, null], // H_max = 1
  [2.4, 4.6, 3.63, -3.6, true, 'degraded'], // handoff prints 4.00 V; see note
];

describe('solve — §8 validation matrix', () => {
  it.each(MATRIX)(
    'amp %f V, want %f dB',
    (amp, wantH, expectV, expectMaxVol, expectFeasible) => {
      const r = solve({ ampSensitivity: amp, requiredHeadroom: wantH });
      expect(r.feasible).toBe(expectFeasible);
      if (expectFeasible) {
        expect(r.outputVoltage).toBeCloseTo(expectV, 1);
        expect(r.maxVolume).toBeCloseTo(expectMaxVol, 1);
        expect(r.shortfall).toBe(0);
        expect(r.achievableHeadroom).toBeCloseTo(wantH, 9);
      } else {
        expect(r.outputVoltage).toBe(V_CEILING);
        expect(r.shortfall).toBeGreaterThan(0);
        // infeasible: falls back to the ceiling for this sensitivity
        expect(r.achievableHeadroom).toBeCloseTo(hMax(amp), 9);
        expect(r.maxVolume).toBeCloseTo(1 - hMax(amp), 9);
      }
    },
  );

  it('reproduces the original forum example: 1.66 V / 18 dB needs 11.75 V, short 9.4 dB', () => {
    const r = solve({ ampSensitivity: 1.66, requiredHeadroom: 18 });
    expect(r.requiredVoltage).toBeCloseTo(11.75, 1);
    expect(r.shortfall).toBeCloseTo(9.4, 1);
  });

  it('2.0 V / 12 dB reports H_max = 7.0', () => {
    const r = solve({ ampSensitivity: 2.0, requiredHeadroom: 12 });
    expect(r.hMax).toBeCloseTo(7.0, 1);
    expect(r.requiredVoltage).toBeCloseTo(7.1, 1);
  });

  it('4.0 V / 6 dB reports H_max = 1', () => {
    expect(solve({ ampSensitivity: 4.0, requiredHeadroom: 6 }).hMax).toBeCloseTo(1, 6);
  });
});

describe('operating points — same delivered voltage everywhere', () => {
  const AMPS = [0.5, 1.0, 1.2, 1.6, 1.66, 2.0, 2.4, 3.0, 4.0];

  it.each(AMPS)('amp %f V: every offered card delivers the amp voltage', (amp) => {
    const points = operatingPoints(amp);
    expect(points.length).toBeGreaterThan(0);
    for (const p of points) {
      expect(p.deliveredVoltage).toBeCloseTo(amp, 9);
    }
  });

  it('excludes voltages below the amplifier sensitivity — they cannot reach full power', () => {
    // A 4 V amp: only the 4.0 V card can deliver 4 V; 3.4/2.4 would leave
    // the amp 1.4/4.4 dB short of full power while claiming equal loudness.
    expect(operatingPoints(4.0).map((p) => p.outputVoltage)).toEqual([4.0]);
    expect(operatingPoints(3.0).map((p) => p.outputVoltage)).toEqual([4.0, 3.4]);
    expect(operatingPoints(2.4).map((p) => p.outputVoltage)).toEqual([4.0, 3.4, 2.4]);
  });

  it('matches the handoff step-1 table for a 1.6 V amplifier', () => {
    const [v40, v34, v24] = operatingPoints(1.6);
    expect(v40.headroom).toBeCloseTo(8.96, 1); // ~9.0 dB
    expect(v40.maxVolume).toBeCloseTo(-7.96, 1); // ~-8.0
    expect(v34.headroom).toBeCloseTo(7.55, 1); // ~7.5
    expect(v34.maxVolume).toBeCloseTo(-6.55, 1); // ~-6.5
    expect(v24.headroom).toBeCloseTo(4.52, 1); // ~4.5
    expect(v24.maxVolume).toBeCloseTo(-3.52, 1); // ~-3.5
  });
});

describe('symmetric shortfall invariant', () => {
  // For any infeasible input, the headroom shortfall (keep-reference choice)
  // must equal the reference shortfall (keep-headroom choice).
  const INFEASIBLE = [];
  for (const amp of [0.8, 1.0, 1.4, 1.66, 2.0, 2.5, 3.0, 3.5]) {
    for (const h of [10, 12, 14, 16, 18, 20, 25]) {
      if (amp * Math.pow(10, (h - 1) / 20) > V_CEILING) INFEASIBLE.push([amp, h]);
    }
  }

  it.each(INFEASIBLE)('amp %f V, want %f dB', (amp, h) => {
    const r = solve({ ampSensitivity: amp, requiredHeadroom: h });
    // Keep-headroom configuration: output at ceiling, cap at 1 - h.
    const delivered = V_CEILING * Math.pow(10, (1 - h) / 20);
    const referenceShortfall = 20 * Math.log10(amp / delivered);
    expect(r.shortfall).toBeCloseTo(referenceShortfall, 9);
  });

  it('worked example: 1.66 V / 16 dB — both exits cost 7.4 dB', () => {
    const r = solve({ ampSensitivity: 1.66, requiredHeadroom: 16 });
    expect(r.shortfall).toBeCloseTo(7.4, 1);
    // keep-16-dB row of the handoff table: delivers 0.71 V at -15 dB cap
    expect(V_CEILING * Math.pow(10, (1 - 16) / 20)).toBeCloseTo(0.71, 2);
    expect(r.hMax).toBeCloseTo(8.6, 1);
  });

  it('solvePreservingHeadroom is the keep-headroom exit of the same table', () => {
    const p = solvePreservingHeadroom({ ampSensitivity: 1.66, requiredHeadroom: 16 });
    expect(p.headroom).toBe(16);
    expect(p.outputVoltage).toBe(V_CEILING);
    expect(p.maxVolume).toBe(-15);
    expect(p.deliveredVoltage).toBeCloseTo(0.71, 2);
    expect(p.deliveredShortDb).toBeCloseTo(7.4, 1); // symmetric with solve().shortfall
    // a feasible request matches solve() exactly — no loudness given up
    const easy = solvePreservingHeadroom({ ampSensitivity: 1.6, requiredHeadroom: 6 });
    const s = solve({ ampSensitivity: 1.6, requiredHeadroom: 6 });
    expect(easy.outputVoltage).toBeCloseTo(s.outputVoltage, 9);
    expect(easy.deliveredShortDb).toBeCloseTo(0, 9);
  });
});

describe('round trip solve <-> solveAtVoltage', () => {
  it('recovers the requested headroom from the solved voltage', () => {
    for (const amp of [0.5, 1.0, 1.6, 2.4]) {
      for (const h of [2, 4, 6, 8]) {
        const s = solve({ ampSensitivity: amp, requiredHeadroom: h });
        if (!s.feasible) continue;
        expect(solveAtVoltage(amp, s.outputVoltage).headroom).toBeCloseTo(h, 9);
      }
    }
  });
});

describe('headroomAt', () => {
  it('is min(H, 1 - MV) with a 1 dB floor', () => {
    expect(headroomAt(12, -40)).toBe(12);
    expect(headroomAt(12, -5)).toBe(6);
    expect(headroomAt(12, 0)).toBe(1);
    expect(headroomAt(12, 10)).toBe(1); // floor, never below 1
    expect(headroomAt(18, -40)).toBe(18);
  });
});

describe('gainSplit / effectiveHeadroom — 22 dB analog cap', () => {
  it('does not spill at or below the cap', () => {
    expect(gainSplit({ analogGainDb: 21.9 }).volDigSpill).toBe(0);
    expect(gainSplit({ analogGainDb: 22.0 }).volDigSpill).toBe(0);
  });

  it('spills the overflow into digital gain', () => {
    expect(gainSplit({ analogGainDb: 22.1 }).volDigSpill).toBeCloseTo(0.1, 9);
    expect(gainSplit({ analogGainDb: 22.1 }).volAna).toBe(22);
    // loudness can push far past the cap at low volumes
    const l = gainSplit({ analogGainDb: 10, loudnessBoostDb: 35 });
    expect(l.volAna).toBe(22);
    expect(l.volDigSpill).toBeCloseTo(23, 9);
  });

  it('effectiveHeadroom equals headroomAt when loudness is off and analog fits', () => {
    expect(
      effectiveHeadroom({ hConfigured: 12, masterVolume: -40, analogGainDb: 10 }),
    ).toBe(headroomAt(12, -40));
  });

  it('effectiveHeadroom loses exactly the spill, floored at 0', () => {
    expect(
      effectiveHeadroom({
        hConfigured: 12,
        masterVolume: -40,
        analogGainDb: 20,
        loudnessBoostDb: 8,
      }),
    ).toBeCloseTo(12 - 6, 9);
    expect(
      effectiveHeadroom({
        hConfigured: 4,
        masterVolume: -40,
        analogGainDb: 22,
        loudnessBoostDb: 45,
      }),
    ).toBe(0);
  });
});

describe('zero point — sign convention (handoff §0 trap)', () => {
  // §2 table, V_ref = 2.52 V. zeroPointSetting is what gets WRITTEN
  // (code convention displayed = volume - zeroPoint).
  it.each([
    [4.0, 4.0, -4.0],
    [3.4, 2.6, -2.6],
    [2.4, -0.4, 0.4],
  ])('output %f V: spec %f, written %f', (vOut, specVal, written) => {
    expect(zeroPointSpec(2.52, vOut)).toBeCloseTo(specVal, 1);
    expect(zeroPointSetting(2.52, vOut)).toBeCloseTo(written, 1);
  });

  it('reference displays as 0 dB: internal MV of reference equals the written zero point', () => {
    const vRef = 2.52;
    const vOut = 4.0;
    const internalMvAtReference = 20 * Math.log10(vRef / vOut);
    expect(zeroPointSetting(vRef, vOut)).toBeCloseTo(internalMvAtReference, 9);
  });
});

describe('captureVRef', () => {
  it('is outputVoltage scaled by the captured master volume', () => {
    expect(captureVRef(4.0, -4.0)).toBeCloseTo(2.52, 2);
    expect(captureVRef(4.0, 0)).toBe(4.0);
  });

  it('round-trips through zeroPointSetting', () => {
    const vRef = captureVRef(4.0, -7.3);
    expect(zeroPointSetting(vRef, 4.0)).toBeCloseTo(-7.3, 9);
  });
});

describe('thdZone boundaries', () => {
  it.each([
    [1.6, 'optimal'],
    [2.4, 'optimal'],
    [2.6, 'optimal'],
    [2.7, 'acceptable'],
    [3.4, 'acceptable'],
    [3.5, 'degraded'],
    [4.0, 'degraded'],
  ])('%f V -> %s', (v, zone) => {
    expect(thdZone(v)).toBe(zone);
  });
});

describe('edge clamps', () => {
  it('floors requested headroom at 1 dB', () => {
    const r = solve({ ampSensitivity: 1.6, requiredHeadroom: 0 });
    expect(r.achievableHeadroom).toBe(1);
    expect(r.outputVoltage).toBeCloseTo(1.6, 9); // H=1 needs exactly the amp voltage
    expect(r.maxVolume).toBe(0);
  });

  it('hMax at the ampsense clamps', () => {
    expect(hMax(4.0)).toBeCloseTo(1, 9); // 4 V amp: no free headroom at all
    expect(hMax(0.1)).toBeCloseTo(1 + 20 * Math.log10(40), 9);
  });

  it('caps requested headroom at the 30 dB firmware limit', () => {
    const r = solve({ ampSensitivity: 0.1, requiredHeadroom: 45 });
    expect(r.achievableHeadroom).toBeLessThanOrEqual(30);
    expect(r.maxVolume).toBeGreaterThanOrEqual(-29);
    // even the infeasible fallback can't exceed what /cal/headroom accepts
    const inf = solve({ ampSensitivity: 0.05, requiredHeadroom: 45 });
    expect(inf.achievableHeadroom).toBeLessThanOrEqual(30);
  });
});
