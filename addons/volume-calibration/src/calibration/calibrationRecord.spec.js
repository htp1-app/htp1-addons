import { describe, it, expect } from 'vitest';
import {
  deriveZeroPoint,
  settingsDiagnosis,
  consistencyDrift,
  globalDemand,
  slotFreshness,
  panelState,
  buildRecord,
  staleDismissKey,
  chainSignature,
  CHAIN_SIG_VERSION,
  staleReason,
  referenceDiagnostic,
  EMPTY_SLOT_CHECKSUM,
  HISTORY_LIMIT,
} from './calibrationRecord.js';

const CAL_RECORD = {
  version: 1,
  calibratedAt: 1754000000000,
  vTarget: 1.6,
  vRef: 2.52,
  anchor: 'reference',
  slots: [
    { slotId: 0, label: 'Movie', fingerprint: 111, fingerprintSource: 'checksum', demand: 9.0, measuredAt: 1 },
    { slotId: 1, label: 'Music', fingerprint: 222, fingerprintSource: 'checksum', demand: 6.5, measuredAt: 1 },
  ],
  written: { outputVoltage: 4.0, headroom: 9, maxVolume: -8, zeroPoint: -4 },
  history: [],
};

const CAL_SETTINGS = {
  ampsense: 4.0,
  headroom: 9,
  vph: -8,
  zeroPoint: -4,
  slots: [
    { checksum: 111, valid: true },
    { checksum: 222, valid: true },
    { checksum: EMPTY_SLOT_CHECKSUM, valid: false },
  ],
};

describe('deriveZeroPoint', () => {
  it('mockup path A: vRef 2.52 at 4.0 V out -> writes -4', () => {
    expect(deriveZeroPoint('reference', { vRef: 2.52, outputVoltage: 4.0 })).toBe(-4);
  });

  it('mockup path B: clean ceiling at cap -8 -> writes -8', () => {
    expect(deriveZeroPoint('cleanCeiling', { maxVolume: -8 })).toBe(-8);
  });

  it('unchanged -> null (field not written)', () => {
    expect(deriveZeroPoint('unchanged', {})).toBeNull();
  });
});

describe('settingsDiagnosis — never-calibrated panel, factory defaults', () => {
  it('reads 1 dB of headroom at the top on factory defaults', () => {
    const d = settingsDiagnosis({ ampsense: 1.6, headroom: 12, vph: 0, zeroPoint: 0 });
    expect(d.headroomAtTop).toBe(1);
    expect(d.topOfScaleDisplayed).toBe(0);
    expect(d.zeroPointActive).toBe(false);
    expect(d.hMaxAtCurrentVoltage).toBeCloseTo(8.96, 1);
  });

  it('reports full headroom when the cap is at 1 - H', () => {
    const d = settingsDiagnosis({ ampsense: 4.0, headroom: 9, vph: -8, zeroPoint: -4 });
    expect(d.headroomAtTop).toBe(9);
    expect(d.topOfScaleDisplayed).toBe(-4); // -8 internal displays as -4
  });
});

describe('consistencyDrift', () => {
  it('is null when settings match the record', () => {
    expect(consistencyDrift(CAL_RECORD, CAL_SETTINGS)).toBeNull();
  });

  it('names the edited field and re-solves for the explanation', () => {
    const drift = consistencyDrift(CAL_RECORD, { ...CAL_SETTINGS, headroom: 12 });
    expect(drift.diffs).toHaveLength(1);
    expect(drift.diffs[0].field).toBe('Maximum Digital Headroom');
    expect(drift.diffs[0].now).toBe(12);
    expect(drift.diffs[0].expected).toBe(9);
    // 12 dB on a 1.6 V system: past the 4 V ceiling -> infeasible, panel
    // must state the ceiling rather than silently trimming
    expect(drift.resolved.feasible).toBe(false);
    expect(drift.resolved.hMax).toBeCloseTo(8.96, 1);
  });

  it('tolerates integer-rounding wobble inside the tolerances', () => {
    expect(consistencyDrift(CAL_RECORD, { ...CAL_SETTINGS, ampsense: 4.0, vph: -8 })).toBeNull();
    expect(consistencyDrift(CAL_RECORD, { ...CAL_SETTINGS, ampsense: 3.95 })).toBeNull();
  });

  it('ignores zeroPoint when the anchor was left unchanged', () => {
    const rec = { ...CAL_RECORD, anchor: 'unchanged', written: { ...CAL_RECORD.written, zeroPoint: null } };
    expect(consistencyDrift(rec, { ...CAL_SETTINGS, zeroPoint: 3 })).toBeNull();
  });

  it('returns null with no record', () => {
    expect(consistencyDrift(null, CAL_SETTINGS)).toBeNull();
    expect(consistencyDrift({ calibratedAt: null }, CAL_SETTINGS)).toBeNull();
  });
});

describe('globalDemand', () => {
  it('is the max across measured slots', () => {
    expect(globalDemand(CAL_RECORD)).toBe(9.0);
  });
  it('is 0 with no measurements', () => {
    expect(globalDemand({ slots: [] })).toBe(0);
    expect(globalDemand(null)).toBe(0);
  });
});

describe('slotFreshness', () => {
  it('fresh when fingerprints match', () => {
    expect(slotFreshness(0, CAL_SETTINGS.slots, CAL_RECORD)).toBe('fresh');
  });
  it('stale when the filter was replaced', () => {
    const slots = [{ checksum: 999, valid: true }];
    expect(slotFreshness(0, slots, CAL_RECORD)).toBe('stale');
  });
  it('unmeasured when the record has no entry', () => {
    const slots = [...CAL_SETTINGS.slots];
    slots[2] = { checksum: 333, valid: true };
    expect(slotFreshness(2, slots, CAL_RECORD)).toBe('unmeasured');
  });
  it('empty for the 31802 sentinel or invalid slots', () => {
    expect(slotFreshness(2, CAL_SETTINGS.slots, CAL_RECORD)).toBe('empty');
  });
  it('unknown when a fingerprint is null — never false-flags', () => {
    const slots = [{ checksum: null, valid: true }];
    expect(slotFreshness(0, slots, CAL_RECORD)).toBe('unknown');
  });

  it('prefers filter_id over checksum, compared like for like (legacy null checksum)', () => {
    // Dirac ART device: checksum null, filter_id published as a string
    const slots = [{ checksum: null, valid: true, filter_id: '1691316452487927006' }];
    const rec = {
      ...CAL_RECORD,
      slots: [{ ...CAL_RECORD.slots[0], fingerprint: '1691316452487927006', fingerprintSource: 'filter_id' }],
    };
    expect(slotFreshness(0, slots, rec)).toBe('fresh');
    // a new transfer changes the id
    const replaced = [{ checksum: null, valid: true, filter_id: '999' }];
    expect(slotFreshness(0, replaced, rec)).toBe('stale');
    // a checksum-keyed record stays comparable even after filter_id appears
    const chkRec = {
      ...CAL_RECORD,
      slots: [{ ...CAL_RECORD.slots[0], fingerprint: 111, fingerprintSource: 'checksum' }],
    };
    const both = [{ checksum: 111, valid: true, filter_id: '555' }];
    expect(slotFreshness(0, both, chkRec)).toBe('fresh');
  });

  it('checksum null with no filter_id stays unknown — never false-flags', () => {
    const slots = [{ checksum: null, valid: true }];
    const rec = {
      ...CAL_RECORD,
      slots: [{ ...CAL_RECORD.slots[0], fingerprint: '123', fingerprintSource: 'filter_id' }],
    };
    expect(slotFreshness(0, slots, rec)).toBe('unknown');
  });

  it('goes stale when the non-Dirac chain signature changes (PEQ, layout…)', () => {
    const rec = {
      ...CAL_RECORD,
      slots: [{ ...CAL_RECORD.slots[0], chainSignature: 111111, chainSignatureVersion: CHAIN_SIG_VERSION }],
    };
    expect(slotFreshness(0, CAL_SETTINGS.slots, rec, 111111)).toBe('fresh');
    expect(slotFreshness(0, CAL_SETTINGS.slots, rec, 999999)).toBe('stale');
    // older records without a signature never false-flag
    expect(slotFreshness(0, CAL_SETTINGS.slots, CAL_RECORD, 999999)).toBe('fresh');
  });

  it('never compares a chain signature from another algorithm version', () => {
    // pre-versioning entry (no chainSignatureVersion field)
    const legacy = {
      ...CAL_RECORD,
      slots: [{ ...CAL_RECORD.slots[0], chainSignature: 111111 }],
    };
    expect(slotFreshness(0, CAL_SETTINGS.slots, legacy, 999999)).toBe('fresh');
    // explicit older version
    const v1 = {
      ...CAL_RECORD,
      slots: [{ ...CAL_RECORD.slots[0], chainSignature: 111111, chainSignatureVersion: 1 }],
    };
    expect(slotFreshness(0, CAL_SETTINGS.slots, v1, 999999)).toBe('fresh');
  });
});

describe('chainSignature', () => {
  const base = {
    peq: { slots: [1], currentpeqslot: 0 },
    speakers: { groups: { lr: { present: true } } },
    cal: { slots: [{ channels: { lf: { trim: 0, delay: 1 } } }] },
  };

  it('changes when PEQ or speaker layout changes, stable otherwise', () => {
    const same = chainSignature({ ...base }, 0);
    expect(chainSignature(base, 0)).toBe(same);
    expect(chainSignature({ ...base, peq: { slots: [2], currentpeqslot: 0 } }, 0)).not.toBe(same);
    expect(chainSignature({ ...base, speakers: { groups: { lr: { present: false } } } }, 0)).not.toBe(same);
    // unrelated mso churn (volume, inputs) does not move it
    expect(chainSignature({ ...base, volume: -20, input: 'h1' }, 0)).toBe(same);
  });

  it('ignores the PEQ editor band selection (UI-only state)', () => {
    const same = chainSignature(base, 0);
    expect(chainSignature({ ...base, peq: { ...base.peq, currentpeqslot: 7 } }, 0)).toBe(same);
  });

  it('changes with global Channel Levels (/channeltrim)', () => {
    const withTrims = { ...base, channeltrim: { channels: { lf: 0 } } };
    const same = chainSignature(withTrims, 0);
    expect(chainSignature({ ...base, channeltrim: { channels: { lf: 6 } } }, 0)).not.toBe(same);
  });

  it('ignores BEQ-flagged bands and beqActive — per-movie BEQ swaps never flag staleness', () => {
    const noPeq = {
      ...base,
      peq: { currentpeqslot: 0, slots: [{ channels: { sub1: { Fc: 100, gaindB: 0, Q: 1 } } }] },
    };
    const beqLoaded = {
      ...base,
      peq: {
        currentpeqslot: 0,
        beqActive: 'Some Movie',
        slots: [{ channels: { sub1: { Fc: 22, gaindB: 8, Q: 0.7, beq: true } } }],
      },
    };
    expect(chainSignature(beqLoaded, 0)).toBe(chainSignature(noPeq, 0));
    // a real user PEQ (no beq flag, non-zero gain) still changes it
    const userPeq = {
      ...base,
      peq: { currentpeqslot: 0, slots: [{ channels: { sub1: { Fc: 60, gaindB: -3, Q: 2 } } }] },
    };
    expect(chainSignature(userPeq, 0)).not.toBe(chainSignature(noPeq, 0));
  });

  it("changes with this slot's channel trims and mutes, not delays", () => {
    const same = chainSignature(base, 0);
    const withTrim = { ...base, cal: { slots: [{ channels: { lf: { trim: 6, delay: 1 } } }] } };
    const withMute = { ...base, cal: { slots: [{ channels: { lf: { trim: 0, delay: 1, mute: true } } }] } };
    const withDelay = { ...base, cal: { slots: [{ channels: { lf: { trim: 0, delay: 9 } } }] } };
    expect(chainSignature(withTrim, 0)).not.toBe(same);
    expect(chainSignature(withMute, 0)).not.toBe(same);
    expect(chainSignature(withDelay, 0)).toBe(same); // delay does not alter gain
  });

  it('ignores inaudible tone-control state (off, or bands at 0 dB)', () => {
    const noEq = { ...base };
    const tcOffFiddled = {
      ...base,
      eq: { tc: false, bass: { level: 0, freq: 109 }, treble: { level: 0, freq: 501 } },
    };
    const tcOnNeutral = {
      ...base,
      eq: { tc: true, bass: { level: 0, freq: 250 }, treble: { level: 0, freq: 8000 } },
    };
    // none of these can change the chain's gain, so none may move the hash
    expect(chainSignature(tcOffFiddled, 0)).toBe(chainSignature(noEq, 0));
    expect(chainSignature(tcOnNeutral, 0)).toBe(chainSignature(noEq, 0));
    // an audible band changes it, and its corner frequency now matters
    const tcAudible = {
      ...base,
      eq: { tc: true, bass: { level: 4, freq: 109 }, treble: { level: 0, freq: 501 } },
    };
    const tcAudibleMoved = {
      ...base,
      eq: { tc: true, bass: { level: 4, freq: 250 }, treble: { level: 0, freq: 501 } },
    };
    expect(chainSignature(tcAudible, 0)).not.toBe(chainSignature(noEq, 0));
    expect(chainSignature(tcAudibleMoved, 0)).not.toBe(chainSignature(tcAudible, 0));
    // turning tone control OFF while a band has gain returns to neutral
    const tcOffWithGain = {
      ...base,
      eq: { tc: false, bass: { level: 4, freq: 109 }, treble: { level: 0, freq: 501 } },
    };
    expect(chainSignature(tcOffWithGain, 0)).toBe(chainSignature(noEq, 0));
  });

  it("is insensitive to OTHER slots' trims", () => {
    const twoSlots = {
      ...base,
      cal: { slots: [base.cal.slots[0], { channels: { lf: { trim: 0 } } }] },
    };
    const same = chainSignature(twoSlots, 0);
    const otherSlotTrimmed = {
      ...base,
      cal: { slots: [base.cal.slots[0], { channels: { lf: { trim: 6 } } }] },
    };
    expect(chainSignature(otherSlotTrimmed, 0)).toBe(same);
  });
});

describe('staleReason', () => {
  const rec = {
    ...CAL_RECORD,
    slots: [{ ...CAL_RECORD.slots[0], chainSignature: 111111, chainSignatureVersion: CHAIN_SIG_VERSION }],
  };

  it('null when fresh', () => {
    expect(staleReason(0, CAL_SETTINGS.slots, rec, 111111)).toBeNull();
  });

  it("'filter' when the checksum changed", () => {
    const slots = [{ checksum: 999, valid: true }];
    expect(staleReason(0, slots, rec, 111111)).toBe('filter');
  });

  it("'chain' when only the processing signature changed", () => {
    expect(staleReason(0, CAL_SETTINGS.slots, rec, 999999)).toBe('chain');
  });
});

describe('referenceDiagnostic', () => {
  // vRef 2.52 V at 4.0 V output puts reference at internal -4.01 dB.
  it('short: reference above the cap is unreachable', () => {
    const d = referenceDiagnostic({ vRef: 2.52, outputVoltage: 4.0, maxVolume: -8 });
    expect(d.kind).toBe('short');
    expect(d.shortfallDb).toBeCloseTo(3.99, 1);
    expect(d.spareDb).toBe(0);
  });

  it('exceeds: cap above reference leaves usable range', () => {
    const d = referenceDiagnostic({ vRef: 2.52, outputVoltage: 4.0, maxVolume: -2 });
    expect(d.kind).toBe('exceeds');
    expect(d.spareDb).toBeCloseTo(2.01, 1);
    expect(d.shortfallDb).toBe(0);
  });

  it('matched at the cap', () => {
    const d = referenceDiagnostic({ vRef: 2.52, outputVoltage: 4.0, maxVolume: -4.013 });
    expect(d.kind).toBe('matched');
  });
});

describe('panelState precedence', () => {
  const base = { record: CAL_RECORD, cal: { ...CAL_SETTINGS, currentdiracslot: 0 }, currentSlot: 0 };

  it('neverCalibrated without a record', () => {
    expect(panelState({ ...base, record: null })).toBe('neverCalibrated');
  });

  it('inSync when everything matches', () => {
    expect(panelState(base)).toBe('inSync');
  });

  it('settingsChanged outranks freshness', () => {
    const cal = { ...CAL_SETTINGS, headroom: 12, slots: [{ checksum: 999, valid: true }] };
    expect(panelState({ ...base, cal })).toBe('settingsChanged');
  });

  it('filterReplaced when the active slot went stale', () => {
    const cal = { ...CAL_SETTINGS, slots: [{ checksum: 999, valid: true }, ...CAL_SETTINGS.slots.slice(1)] };
    expect(panelState({ ...base, cal })).toBe('filterReplaced');
  });

  it('slotNotMeasured for an unmeasured active slot', () => {
    const cal = { ...CAL_SETTINGS, slots: [...CAL_SETTINGS.slots] };
    cal.slots[2] = { checksum: 333, valid: true };
    expect(panelState({ ...base, cal, currentSlot: 2 })).toBe('slotNotMeasured');
  });

  it('dismissal silences states 4/5, scoped to the fingerprint', () => {
    const cal = { ...CAL_SETTINGS, slots: [{ checksum: 999, valid: true }, ...CAL_SETTINGS.slots.slice(1)] };
    const dismissed = new Set([staleDismissKey(0, cal)]);
    expect(panelState({ ...base, cal, isDismissed: (k) => dismissed.has(k) })).toBe('inSync');
    // a different (newer) filter re-raises the flag
    const cal2 = { ...cal, slots: [{ checksum: 777, valid: true }, ...cal.slots.slice(1)] };
    expect(panelState({ ...base, cal: cal2, isDismissed: (k) => dismissed.has(k) })).toBe('filterReplaced');
  });

  it('switching between measured slots is silent', () => {
    expect(panelState({ ...base, currentSlot: 1 })).toBe('inSync');
  });
});

describe('buildRecord', () => {
  it('pushes the previous record into history, capped', () => {
    let rec = CAL_RECORD;
    for (let i = 0; i < HISTORY_LIMIT + 3; i++) {
      rec = buildRecord({
        previous: rec,
        now: 2000 + i,
        vTarget: 1.6,
        vRef: 2.5,
        anchor: 'reference',
        slots: rec.slots,
        written: rec.written,
      });
    }
    expect(rec.history).toHaveLength(HISTORY_LIMIT);
    expect(rec.history[HISTORY_LIMIT - 1].calibratedAt).toBe(2000 + HISTORY_LIMIT + 1);
    expect(rec.calibratedAt).toBe(2000 + HISTORY_LIMIT + 2);
  });

  it('does not add history for a first calibration', () => {
    const rec = buildRecord({
      previous: null,
      now: 1,
      vTarget: 1.6,
      vRef: null,
      anchor: 'cleanCeiling',
      slots: [],
      written: { outputVoltage: 4, headroom: 9, maxVolume: -8, zeroPoint: -8 },
    });
    expect(rec.history).toEqual([]);
    expect(rec.vRef).toBeNull();
  });
});
