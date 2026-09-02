// Calibration record shape, drift checks, and panel state logic — pure
// functions over plain objects (the mso's /cal subtree and the /cal/vcal
// record), so milestone 6's drift behavior is fully unit-testable.

import { solve, hMax, headroomAt, zeroPointSetting } from './gainModel.js';

export const RECORD_VERSION = 1;
export const EMPTY_SLOT_CHECKSUM = 31802;
export const HISTORY_LIMIT = 5;

// Drift tolerances. ampsense is a 0.1 V-step float (half-step + epsilon);
// vph and zeroPoint are integers in shipped code; headroom is written from
// the solver so 0.5 dB is generous.
export const DRIFT_TOLERANCE = {
  outputVoltage: 0.051,
  headroom: 0.5,
  maxVolume: 0.5,
  zeroPoint: 0.5,
};

/**
 * Zero Point value to WRITE to /cal/zeroPoint for a given anchor choice.
 * Returns null for 'unchanged' (do not write the field at all).
 * Math.round because /cal/zeroPoint is integer throughout shipped code.
 */
export function deriveZeroPoint(anchor, { vRef, outputVoltage, maxVolume }) {
  if (anchor === 'unchanged') return null;
  if (anchor === 'cleanCeiling') return Math.round(maxVolume); // top of scale displays 0.0
  return Math.round(zeroPointSetting(vRef, outputVoltage)); // 'reference'
}

/**
 * What the current settings mean, with no record required — the panel's
 * never-calibrated diagnosis (default state for every existing user).
 */
export function settingsDiagnosis(cal) {
  const ampsense = cal?.ampsense ?? 1.6;
  const headroom = cal?.headroom ?? 12;
  const vph = cal?.vph ?? 0;
  const zeroPoint = cal?.zeroPoint ?? 0;
  return {
    // same math as VolumeSetup's inline rows: headroom in effect at the cap
    headroomAtTop: headroomAt(headroom, vph),
    topOfScaleDisplayed: vph - zeroPoint,
    zeroPointActive: zeroPoint !== 0,
    // 0 dB displayed = internal zeroPoint; at zeroPoint 0 the old meaning
    // holds: full-scale drives the amp (at ampsense volts) to clipping
    zeroDbInternal: zeroPoint,
    hMaxAtCurrentVoltage: hMax(ampsense),
    outputVoltage: ampsense,
  };
}

/**
 * Consistency check: do the current settings still match what calibration
 * wrote? Compares against record.written (immune to solver-version drift);
 * the "should be" explanation comes from a fresh solve.
 * Returns null when in sync, else { diffs, resolved }.
 */
export function consistencyDrift(record, cal) {
  if (!record?.calibratedAt || !record.written || !cal) return null;
  const w = record.written;
  const diffs = [];
  if (Math.abs(cal.ampsense - w.outputVoltage) > DRIFT_TOLERANCE.outputVoltage) {
    diffs.push({ field: 'Output Voltage', path: '/cal/ampsense', now: cal.ampsense, expected: w.outputVoltage });
  }
  if (Math.abs(cal.headroom - w.headroom) > DRIFT_TOLERANCE.headroom) {
    diffs.push({ field: 'Maximum Digital Headroom', path: '/cal/headroom', now: cal.headroom, expected: w.headroom });
  }
  if (Math.abs(cal.vph - w.maxVolume) > DRIFT_TOLERANCE.maxVolume) {
    diffs.push({ field: 'Maximum Volume', path: '/cal/vph', now: cal.vph, expected: w.maxVolume });
  }
  if (record.anchor !== 'unchanged'
      && w.zeroPoint !== null && w.zeroPoint !== undefined
      && Math.abs(cal.zeroPoint - w.zeroPoint) > DRIFT_TOLERANCE.zeroPoint) {
    diffs.push({ field: 'Zero Point', path: '/cal/zeroPoint', now: cal.zeroPoint, expected: w.zeroPoint });
  }
  if (!diffs.length) return null;
  return {
    diffs,
    resolved: solve({
      ampSensitivity: record.vTarget,
      requiredHeadroom: globalDemand(record),
    }),
  };
}

/** Highest measured demand across slots — what global headroom provisions for. */
export function globalDemand(record) {
  const demands = (record?.slots ?? []).map((s) => s.demand).filter((d) => typeof d === 'number');
  return demands.length ? Math.max(...demands) : 0;
}

/**
 * Freshness of one Dirac slot's measurement.
 * 'empty' — no filter loaded; 'unmeasured' — no record entry;
 * 'stale' — fingerprint mismatch (filter replaced since measurement);
 * 'unknown' — fingerprint unavailable, stay quiet rather than false-flag;
 * 'fresh' — measured against the loaded filter.
 */
/**
 * The strongest available identity for a slot's loaded filter. Prefers the
 * uint64 filter_id (published into the mso as a STRING — it exceeds JS
 * safe-integer range) and falls back to the legacy checksum, which is null
 * on Dirac ART devices.
 */
export function slotFingerprint(slot) {
  if (slot?.filter_id !== null && slot?.filter_id !== undefined) {
    return { value: slot.filter_id, source: 'filter_id' };
  }
  if (slot?.checksum !== null && slot?.checksum !== undefined
      && slot.checksum !== EMPTY_SLOT_CHECKSUM) {
    return { value: slot.checksum, source: 'checksum' };
  }
  return { value: null, source: null };
}

// Compare a record entry's fingerprint against the loaded slot, like for
// like: an entry keyed on checksum is compared to the checksum even if a
// filter_id has since appeared, and vice versa. String() both sides so a
// filter_id stored before the string convention still matches.
function fingerprintState(entry, slot) {
  if (entry.fingerprint === null || entry.fingerprint === undefined) return 'unknown';
  const source = entry.fingerprintSource === 'filter_id' ? 'filter_id' : 'checksum';
  const current = source === 'filter_id' ? slot.filter_id : slot.checksum;
  if (current === null || current === undefined) return 'unknown';
  return String(entry.fingerprint) === String(current) ? 'fresh' : 'stale';
}

export function slotFreshness(slotIndex, msoSlots, record, currentChainSignature) {
  const slot = msoSlots?.[slotIndex];
  if (!slot || slot.checksum === EMPTY_SLOT_CHECKSUM || slot.valid === false) return 'empty';
  const entry = (record?.slots ?? []).find((s) => s.slotId === slotIndex);
  if (!entry) return 'unmeasured';
  const fpState = fingerprintState(entry, slot);
  if (fpState === 'stale') return 'stale';
  // The sweep measures the whole chain, not just Dirac — a changed PEQ,
  // speaker layout, or tone-control state invalidates the measurement too.
  // Only compared when both sides carry a signature (older records don't)
  // AND the entry was signed by the current algorithm (see CHAIN_SIG_VERSION).
  if (currentChainSignature !== undefined
      && entry.chainSignatureVersion === CHAIN_SIG_VERSION
      && entry.chainSignature !== undefined && entry.chainSignature !== null
      && entry.chainSignature !== currentChainSignature) return 'stale';
  return fpState; // 'fresh' or 'unknown'
}

/**
 * Signature of the parts of the processing chain, beyond the Dirac filter
 * itself, that contribute to measured demand: PEQ bands, speaker
 * layout/crossovers, tone control, bass enhancement, and the given slot's
 * per-channel trims and mutes. Field-selected so UI-only state (like which
 * PEQ band is selected in the editor) can never flag staleness, and /cal/vcal
 * is never included so record writes can't self-flag. A cheap 32-bit string
 * hash — collisions only risk a missed flag, never a false one.
 *
 * CHAIN_SIG_VERSION stamps entries at write time. The hash input is not
 * stable across algorithm changes, so signatures are only compared between
 * equal versions; an entry from another version reads as unknown (quiet, per
 * the never-false-flag rule) until the slot is next measured. Bump this
 * whenever the `relevant` selection below changes.
 */
export const CHAIN_SIG_VERSION = 2;

export function chainSignature(mso, slotIndex) {
  // mso.peq minus editor-selection state (changed by merely viewing a band)
  // and minus BEQ state: BEQ presets are loaded per movie and provisioned
  // via the calibration's BEQ allowance, so swapping them must not flag the
  // measurement stale. Bands are normalized so "no PEQ" (neutral zeros) and
  // "BEQ loaded" (flagged bands) hash identically: a band-channel entry is
  // dropped when it carries the beq flag OR is magnitude-neutral (gain 0).
  const { currentpeqslot, beqActive, ...peqRest } = mso?.peq ?? {};
  const peqDsp = {
    ...peqRest,
    slots: (peqRest.slots ?? []).map((band) => (band?.channels
      ? {
        ...band,
        channels: Object.fromEntries(Object.entries(band.channels)
          .filter(([, v]) => !v?.beq && (v?.gaindB ?? 0) !== 0)),
      }
      : band)),
  };
  // Tone control is hashed only when audible: with tone control off, or a
  // band at 0 dB gain, corner-frequency fiddling cannot change the chain and
  // must not flag staleness (the same neutrality rule as PEQ bands above).
  const eqRaw = mso?.eq ?? null;
  const tcOn = !!eqRaw?.tc;
  const eqBass = tcOn && (eqRaw?.bass?.level ?? 0) !== 0 ? eqRaw.bass : null;
  const eqTreble = tcOn && (eqRaw?.treble?.level ?? 0) !== 0 ? eqRaw.treble : null;
  // fully neutral tone control hashes identically to no eq state at all
  const eqDsp = (eqBass || eqTreble) ? { bass: eqBass, treble: eqTreble } : null;

  // this slot's user trims and mutes — they are part of real chain gain
  const channels = mso?.cal?.slots?.[slotIndex]?.channels ?? null;
  const slotTrims = channels
    ? Object.fromEntries(Object.entries(channels).map(
      ([ch, v]) => [ch, [v?.trim ?? 0, v?.mute ?? false]],
    ))
    : null;
  const relevant = {
    peq: peqDsp,
    speakers: mso?.speakers?.groups ?? null,
    eq: eqDsp,
    bassenhance: mso?.bassenhance ?? null,
    bassLpf: mso?.bassLpf ?? null,
    // global Channel Levels (±12 dB, applied ahead of Dirac/bass management)
    channeltrim: mso?.channeltrim ?? null,
    slotTrims,
  };
  const s = JSON.stringify(relevant);
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * Why a stale slot is stale: 'filter' (the Dirac filter itself was
 * replaced) or 'chain' (PEQ, layout, tone control, or trims changed).
 * null when not stale. Drives the panel's state-5 copy.
 */
export function staleReason(slotIndex, msoSlots, record, currentChainSignature) {
  if (slotFreshness(slotIndex, msoSlots, record, currentChainSignature) !== 'stale') return null;
  const entry = (record?.slots ?? []).find((s) => s.slotId === slotIndex);
  return fingerprintState(entry, msoSlots[slotIndex]) === 'stale' ? 'filter' : 'chain';
}

/**
 * Path A step-6 diagnostic: where measured reference lands on the new scale.
 * referenceMv is the internal master volume at which the room reaches
 * reference with the staged output voltage. Reference ABOVE the cap means
 * the system cannot reach it cleanly ('short'); reference BELOW the cap
 * means usable range continues above it ('exceeds').
 */
export function referenceDiagnostic({ vRef, outputVoltage, maxVolume }) {
  if (!vRef || !outputVoltage) return null;
  const referenceMv = 20 * Math.log10(vRef / outputVoltage);
  const gap = referenceMv - maxVolume;
  let kind;
  if (Math.abs(gap) < 0.05) kind = 'matched';
  else if (gap > 0) kind = 'short'; // reference sits above the reachable cap
  else kind = 'exceeds'; // scale continues above reference
  return {
    kind,
    referenceMv,
    shortfallDb: Math.max(0, gap),
    spareDb: Math.max(0, -gap),
  };
}

/**
 * Panel state machine (mockup 04). Precedence: settings drift invalidates
 * everything the panel would otherwise assert, so it outranks freshness;
 * a stale measurement on the ACTIVE slot outranks a merely missing one.
 * Only the current slot is considered (switching between measured slots is
 * silent by design).
 */
export function panelState({ record, cal, currentSlot, isDismissed = () => false, currentChainSignature }) {
  if (!record?.calibratedAt) return 'neverCalibrated';
  if (consistencyDrift(record, cal)) return 'settingsChanged';
  const freshness = slotFreshness(currentSlot, cal?.slots, record, currentChainSignature);
  if (freshness === 'stale' && !isDismissed(staleDismissKey(currentSlot, cal, currentChainSignature))) {
    return 'filterReplaced';
  }
  if (freshness === 'unmeasured' && !isDismissed(unmeasuredDismissKey(currentSlot, cal, currentChainSignature))) {
    return 'slotNotMeasured';
  }
  return 'inSync';
}

// Dismissal keys are scoped to the filter checksum AND the chain signature,
// so any NEW change (filter transfer, PEQ edit, layout change) re-raises the
// flag while the dismissed state stays dismissed. Each key costs one entry
// in /personalize/dismissedAlerts, created only by an explicit dismissal.
export function staleDismissKey(slotIndex, cal, sig) {
  const fp = slotFingerprint(cal?.slots?.[slotIndex]).value;
  return `vcal-stale-${slotIndex}-${fp}-${sig ?? ''}`;
}

export function unmeasuredDismissKey(slotIndex, cal, sig) {
  const fp = slotFingerprint(cal?.slots?.[slotIndex]).value;
  return `vcal-unmeasured-${slotIndex}-${fp}-${sig ?? ''}`;
}

/**
 * Build the record written on Apply. `previous` (if any) is summarized into
 * history, capped at HISTORY_LIMIT.
 */
export function buildRecord({
  previous,
  now,
  vTarget,
  vRef,
  anchor,
  slots,
  written,
}) {
  const history = [...(previous?.history ?? [])];
  if (previous?.calibratedAt) {
    history.push({
      calibratedAt: previous.calibratedAt,
      anchor: previous.anchor,
      vTarget: previous.vTarget,
      vRef: previous.vRef ?? null,
      written: previous.written,
    });
    while (history.length > HISTORY_LIMIT) history.shift();
  }
  return {
    version: RECORD_VERSION,
    calibratedAt: now,
    vTarget,
    vRef: vRef ?? null,
    anchor,
    slots,
    written,
    history,
  };
}
