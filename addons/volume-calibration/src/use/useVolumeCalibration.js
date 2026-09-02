// Shared state and logic for the volume calibration feature: wizard staging,
// calibration record access, drift detection, and the Volume Setup panel
// state. Pure math lives in src/calibration/; this file wires it to the mso.
//
// Module-level refs (repo idiom) so wizard state survives the keep-alive'd
// settings router-view.

import { ref, computed, watch } from 'vue';

import useMso from '@/use/useMso.js';
import useSweep from './useSweep.js';
import {
  solve,
  solveAtVoltage,
  solvePreservingHeadroom,
  operatingPoints,
  hMax,
  captureVRef,
  H_FLOOR_DB,
  H_MAX_DB,
} from '~/calibration/gainModel.js';
import {
  deriveZeroPoint,
  settingsDiagnosis,
  consistencyDrift,
  globalDemand,
  slotFreshness,
  panelState,
  buildRecord,
  staleDismissKey,
  unmeasuredDismissKey,
  chainSignature,
  CHAIN_SIG_VERSION,
  staleReason,
  slotFingerprint,
  referenceDiagnostic as computeReferenceDiagnostic,
} from '~/calibration/calibrationRecord.js';
import { BEQ_ALLOWANCE_DB, BEQ_WORST_CASE_DB } from '~/calibration/beq.js';

// Wizard step ids. The goal question (anchor) comes right after amp
// sensitivity: it needs no measurement to answer and fixes the path — and so
// the step count — before any measuring starts. Path B (anchor !=
// 'reference') filters out 'spl'; steps are numbered by index in the active
// list, never by arithmetic. The operating point is no longer a step: the
// solver auto-picks the highest-reserve voltage and the result step offers
// it as an override.
export const ALL_STEPS = ['amp', 'anchor', 'demand', 'spl', 'result', 'summary'];

// ---- wizard staging (module-level: survives navigation) -------------------

const currentStep = ref('amp');
const stagedVTarget = ref(null); // amplifier input sensitivity, volts
const stagedDemand = ref(null); // { demandDb, source, peakFreqHz, peakInputChannel, peakOutputChannel, fingerprint, slotId }
const stagedVoltageChoice = ref(null); // operating-point output voltage when demand > hFree
const stagedAnchor = ref(null); // 'reference' | 'cleanCeiling' | 'unchanged'
const stagedBeqUser = ref(null); // provision extra headroom for BEQ presets: true/false, null = not yet answered (required)

// The last completed measurement, persisted so a browser refresh mid-wizard
// doesn't cost it. Only ever offered back after revalidating fingerprint and
// chain signature against the live slot.
const STAGED_MEASUREMENT_KEY = 'vcalStagedMeasurement';
const persistedMeasurement = ref((() => {
  if (typeof localStorage === 'undefined') return null;
  try {
    return JSON.parse(localStorage.getItem(STAGED_MEASUREMENT_KEY));
  } catch {
    return null;
  }
})());
const stagedBeqWorstCase = ref(false); // size that allowance for the heaviest titles (p95) instead of the median
// What the top of the scale is provisioned to deliver when demand exceeds
// the amp's free ceiling — each dB of top loudness conceded buys one dB of
// headroom ceiling:
//   'loudness'  — amp full power at the cap (max loudness, headroom haircut)
//   'reference' — measured reference at the cap (path A, when it overshoots)
//   'headroom'  — full measured headroom preserved; the cap lands wherever
//                 1 − H puts it, even below reference
const stagedHeadroomPriority = ref('loudness');
const splCapture = ref(null); // { vRef, capturedMasterVolume }
const applyState = ref('idle'); // idle | applying | applied | error
const applyError = ref(null);

let engine = null;

export default function useVolumeCalibration() {
  const {
    mso, importMsoPatchList, diracFilterTransferInProgress, calToolConnected,
    dismissAlert, setDiracSlot, state,
  } = useMso();
  if (!engine) engine = useSweep();

  // ---- record + panel ----------------------------------------------------

  const record = computed(() => mso.value?.cal?.vcal ?? null);
  const isCalibrated = computed(() => !!record.value?.calibratedAt);
  const cal = computed(() => mso.value?.cal);
  const currentSlot = computed(() => cal.value?.currentdiracslot);

  const diagnosis = computed(() => settingsDiagnosis(cal.value));
  const drift = computed(() => consistencyDrift(record.value, cal.value));
  const demandCeiling = computed(() => globalDemand(record.value));

  // Content overhead: how much more real content demanded than the channel
  // sweep found, taken from record entries that carry BOTH figures. The
  // sweep sees each channel's own boost but not multi-channel bass summing,
  // so a sweep-only measurement of a new slot is reported as its sweep plus
  // this overhead, labeled an estimate. Max across qualifying slots: when
  // in doubt, provision more.
  const contentOverheadDb = computed(() => {
    let best = null;
    for (const s of record.value?.slots ?? []) {
      const material = s.sources?.material?.demandDb;
      const sweepDb = s.sources?.sweep?.demandDb;
      if (material == null || sweepDb == null) continue;
      const overheadDb = Math.max(0, Math.round((material - sweepDb) * 10) / 10);
      if (!best || overheadDb > best.overheadDb) {
        best = { overheadDb, fromSlotId: s.slotId, fromLabel: s.label ?? `Slot ${s.slotId + 1}` };
      }
    }
    return best;
  });

  function isDismissed(key) {
    return !!mso.value?.personalize?.dismissedAlerts?.[key];
  }

  // Signature of the non-Dirac chain (PEQ, speakers, tone control, this
  // slot's trims…): a change here invalidates measurements just as a filter
  // swap does.
  const currentChainSignature = computed(() => chainSignature(mso.value, currentSlot.value));

  // Why the current slot is stale ('filter' | 'chain' | null) — panel copy.
  const currentStaleReason = computed(() =>
    staleReason(currentSlot.value, cal.value?.slots, record.value, currentChainSignature.value));

  const panelStateName = computed(() => panelState({
    record: record.value,
    cal: cal.value,
    currentSlot: currentSlot.value,
    isDismissed,
    currentChainSignature: currentChainSignature.value,
  }));

  const currentSlotFreshness = computed(() =>
    slotFreshness(currentSlot.value, cal.value?.slots, record.value, currentChainSignature.value));

  // Per-slot coverage rows for the panel table and wizard footer.
  const slotCoverage = computed(() => {
    const slots = cal.value?.slots ?? [];
    const ceiling = demandCeiling.value;
    return slots.map((slot, i) => {
      const entry = (record.value?.slots ?? []).find((s) => s.slotId === i);
      return {
        slotId: i,
        name: slot.name,
        freshness: slotFreshness(i, slots, record.value, chainSignature(mso.value, i)),
        demand: entry?.demand ?? null,
        // 'measured' (content-informed), 'estimate' (sweep + borrowed content
        // overhead), or 'sweepFloor' (sweep only, no overhead known)
        demandBasis: entry?.demandBasis ?? (entry ? 'measured' : null),
        estimate: entry?.estimate ?? null,
        measuredAt: entry?.measuredAt ?? null,
        setsCeiling: entry != null && entry.demand === ceiling && ceiling > 0,
      };
    });
  });

  function dismissStale() {
    dismissAlert(staleDismissKey(currentSlot.value, cal.value, currentChainSignature.value));
  }

  function dismissUnmeasured() {
    dismissAlert(unmeasuredDismissKey(currentSlot.value, cal.value, currentChainSignature.value));
  }

  // ---- wizard flow -------------------------------------------------------

  const wizardPath = computed(() => (stagedAnchor.value === 'reference' ? 'A' : 'B'));

  const activeSteps = computed(() =>
    (wizardPath.value === 'B' ? ALL_STEPS.filter((s) => s !== 'spl') : ALL_STEPS));

  const stepNumber = computed(() => activeSteps.value.indexOf(currentStep.value) + 1);
  const stepCount = computed(() => activeSteps.value.length);

  // The chain's measured maximum gain inside the BEQ band (15–40 Hz), the
  // figure a BEQ preset's boost stacks on. Taken from the staged sweep, or
  // from this session's sweep result when it still describes the current
  // slot and chain (demand itself may have come from content). Null when no
  // valid sweep data exists — the BEQ allowance cannot be sized without it.
  const beqLowBandDb = computed(() => {
    if (stagedDemand.value?.lowBandDemandDb != null) {
      return stagedDemand.value.lowBandDemandDb;
    }
    const r = engine.sweepResult.value;
    if (!r || r.partial || r.lowBandDemandDb == null) return null;
    if (r.slotId !== currentSlot.value) return null;
    const fp = slotFingerprint(cal.value?.slots?.[currentSlot.value]);
    if (String(r.fingerprint) !== String(fp.value)) return null;
    if (r.chainSignature !== currentChainSignature.value) return null;
    return r.lowBandDemandDb;
  });

  // BEQ = yes but no sweep of the current slot/chain exists to size the
  // allowance against — the wizard requires one before advancing.
  const beqNeedsSweep = computed(() =>
    stagedBeqUser.value === true && stagedDemand.value != null && beqLowBandDb.value == null);

  const beqTitleBoostDb = computed(() =>
    (stagedBeqWorstCase.value ? BEQ_WORST_CASE_DB : BEQ_ALLOWANCE_DB));

  // Extra headroom the BEQ choice actually provisions: the catalog figure
  // stacked on the system's own measured low-band demand, counted only where
  // that exceeds the overall peak. Null while the answer is unknown — the
  // question unanswered or the required sweep not yet run. A guessed
  // placeholder is never shown or applied.
  const beqExtraDb = computed(() => {
    if (stagedDemand.value == null) return null;
    if (stagedBeqUser.value === false) return 0;
    if (stagedBeqUser.value !== true) return null; // question not answered yet
    const low = beqLowBandDb.value;
    if (low == null) return null; // required sweep not run yet
    const base = stagedDemand.value.demandDb;
    const need = Math.min(H_MAX_DB, Math.max(base, low + beqTitleBoostDb.value));
    return Math.round(Math.max(0, need - base) * 10) / 10;
  });

  // Demand actually provisioned for: the measured figure plus the BEQ
  // allowance when the user runs BEQ presets (always shown as a separate,
  // labeled line — never folded silently into the measurement). Null until
  // the BEQ question is resolved, so no downstream step can compute from a
  // guess.
  const effectiveDemandDb = computed(() => (
    stagedDemand.value == null || beqExtraDb.value == null
      ? null
      : Math.min(H_MAX_DB, stagedDemand.value.demandDb + beqExtraDb.value)
  ));

  // Free-headroom threshold for the staged amplifier sensitivity.
  const hFree = computed(() =>
    (stagedVTarget.value ? hMax(stagedVTarget.value) : null));

  const demandExceedsFree = computed(() =>
    effectiveDemandDb.value != null && hFree.value != null
      && effectiveDemandDb.value > hFree.value + 1e-9);

  const operatingPointCards = computed(() =>
    (stagedVTarget.value ? operatingPoints(stagedVTarget.value) : []));

  // The card list depends on the amplifier sensitivity (voltages below it
  // are excluded), so a choice made for one amplifier is meaningless for
  // another — clear it whenever the target changes.
  watch(stagedVTarget, (v, old) => {
    if (old !== undefined && v !== old) stagedVoltageChoice.value = null;
  });

  // The staged choice, revalidated against the CURRENT card list. Falls back
  // to the highest-reserve card so an out-of-list value can never be applied.
  const effectiveVoltageChoice = computed(() => {
    const cards = operatingPointCards.value;
    if (!cards.length) return 4.0;
    const choice = stagedVoltageChoice.value;
    return cards.some((c) => c.outputVoltage === choice) ? choice : cards[0].outputVoltage;
  });

  // The four values the wizard will write, derived from staging.
  const stagedSettings = computed(() => {
    if (!stagedVTarget.value || effectiveDemandDb.value == null) return null;
    let outputVoltage;
    let headroom;
    if (stagedHeadroomPriority.value === 'headroom') {
      // Preserve every measured dB; the top of the scale falls where 1 − H
      // puts it, conceding loudness dB-for-dB.
      const p = solvePreservingHeadroom({
        ampSensitivity: stagedVTarget.value,
        requiredHeadroom: effectiveDemandDb.value,
      });
      outputVoltage = p.outputVoltage;
      headroom = p.headroom;
    } else if (stagedHeadroomPriority.value === 'reference' && splCapture.value) {
      // Cap-at-reference: the scale only needs to reach the MEASURED
      // reference voltage at its top, not amp full power — a system that
      // overshoots reference trades its spare loudness for extra headroom.
      const s = solve({
        ampSensitivity: splCapture.value.vRef,
        requiredHeadroom: effectiveDemandDb.value,
      });
      outputVoltage = s.outputVoltage;
      headroom = s.achievableHeadroom;
    } else if (demandExceedsFree.value) {
      const v = effectiveVoltageChoice.value;
      const p = solveAtVoltage(stagedVTarget.value, v);
      outputVoltage = v;
      headroom = p.headroom;
    } else {
      const s = solve({
        ampSensitivity: stagedVTarget.value,
        requiredHeadroom: effectiveDemandDb.value,
      });
      outputVoltage = s.outputVoltage;
      headroom = s.achievableHeadroom;
    }
    // Integer-field rounding, toward safety: headroom keeps a decimal, the
    // volume cap floors (never above 1 - H), zero point rounds (its own
    // helper) — drift tolerances cover the wobble.
    headroom = Math.round(headroom * 10) / 10;
    const maxVolume = Math.floor(1 - headroom);
    const zeroPoint = deriveZeroPoint(stagedAnchor.value ?? 'unchanged', {
      vRef: splCapture.value?.vRef,
      outputVoltage,
      maxVolume,
    });
    return {
      outputVoltage: Math.round(outputVoltage * 100) / 100,
      headroom,
      maxVolume,
      zeroPoint,
    };
  });

  // Path A diagnostic (step 6): where measured reference lands vs the cap.
  const referenceDiagnostic = computed(() => {
    if (!splCapture.value || !stagedSettings.value) return null;
    return computeReferenceDiagnostic({
      vRef: splCapture.value.vRef,
      outputVoltage: stagedSettings.value.outputVoltage,
      maxVolume: stagedSettings.value.maxVolume,
    });
  });

  // Step-6 refinement: the loudness-vs-headroom trade, offered whenever the
  // calibration took a headroom haircut. Every dB of top-of-scale loudness
  // conceded buys one dB of headroom ceiling. Options:
  //   loudness  — amp full power at the cap (the default haircut)
  //   reference — cap at measured reference (only when it overshoots)
  //   headroom  — preserve the full measured figure, cap falls where it lands
  // Null when demand fits under the amp ceiling (nothing to trade for).
  const headroomTradeOptions = computed(() => {
    if (effectiveDemandDb.value == null || !stagedVTarget.value) return null;
    const demand = effectiveDemandDb.value;
    const ampCeiling = Math.min(H_MAX_DB, hMax(stagedVTarget.value));
    if (demand <= ampCeiling + 0.5) return null; // no haircut, nothing to regain
    const options = [{
      key: 'loudness',
      headroom: Math.min(demand, ampCeiling),
      loudnessGivenUpDb: 0,
    }];
    const vRef = splCapture.value?.vRef;
    if (stagedAnchor.value === 'reference' && vRef && vRef < stagedVTarget.value - 0.01) {
      const refCeiling = Math.min(H_MAX_DB, hMax(vRef));
      if (refCeiling > ampCeiling + 0.5 && refCeiling < demand - 0.5) {
        options.push({
          key: 'reference',
          headroom: Math.min(demand, refCeiling),
          loudnessGivenUpDb: 20 * Math.log10(stagedVTarget.value / vRef),
        });
      }
    }
    const full = solvePreservingHeadroom({
      ampSensitivity: stagedVTarget.value,
      requiredHeadroom: demand,
    });
    options.push({
      key: 'headroom',
      headroom: full.headroom,
      loudnessGivenUpDb: full.deliveredShortDb,
    });
    return { vRef: vRef ?? null, options };
  });

  function startWizard() {
    currentStep.value = 'amp';
    stagedVTarget.value = record.value?.vTarget ?? null;
    stagedDemand.value = null;
    stagedVoltageChoice.value = null;
    stagedAnchor.value = null;
    // The BEQ question is a required choice on EVERY run — deliberately not
    // restored from the record, so no run starts with an answer preselected.
    stagedBeqUser.value = null;
    stagedBeqWorstCase.value = record.value?.beqWorstCase ?? false;
    stagedHeadroomPriority.value = 'loudness';
    splCapture.value = null;
    applyState.value = 'idle';
    applyError.value = null;
  }

  function goToStep(step) {
    if (activeSteps.value.includes(step)) currentStep.value = step;
  }

  function nextStep() {
    const steps = activeSteps.value;
    const i = steps.indexOf(currentStep.value);
    if (i >= 0 && i < steps.length - 1) currentStep.value = steps[i + 1];
  }

  function prevStep() {
    const steps = activeSteps.value;
    const i = steps.indexOf(currentStep.value);
    if (i > 0) currentStep.value = steps[i - 1];
  }

  // Graceful exit from the SPL measurement step to path B — keeps all
  // prior staging, no restart. Handoff §5 requires this transition.
  function exitToPathB() {
    stagedAnchor.value = 'cleanCeiling';
    splCapture.value = null;
    currentStep.value = 'result';
  }

  // Tone-level correction for the SPL measurement: the 75 dB / -30 dBFS
  // convention assumes the tone plays at -30 dBFS. If hardware verification
  // finds the "THX-like" noise at a different level L, set this to L + 30.
  // (Handoff 09 §A.7 / open risk: thx maps to "gen vol 0" in node-red.)
  const THX_TONE_OFFSET_DB = 0;

  // Capture the reference anchor at the current master volume (step 5).
  // Nothing has been applied yet, so the room's SPL is produced by the
  // DEVICE'S CURRENT output voltage — V_ref is a physical fact about the
  // room (the output voltage at which it reaches reference) and is captured
  // from actual settings, independent of what the wizard will write. Zero
  // Point is later derived against the NEW output voltage, which is exactly
  // why V_ref is the stored quantity (handoff §2 stored-vs-derived).
  function captureReference() {
    splCapture.value = {
      vRef: captureVRef(
        cal.value?.ampsense ?? 1.6,
        mso.value.volume + THX_TONE_OFFSET_DB,
      ),
      capturedMasterVolume: mso.value.volume,
    };
  }

  // Adopt a finished sweep into staging (wizard step 2). A measured chain
  // gain below the 1 dB floor still provisions the floor — that's the
  // honest minimum, not a failure.
  function useSweepResult() {
    const r = engine.sweepResult.value;
    // A band-limited sweep measured only part of the spectrum — its maximum
    // can never stand in for the slot's overall demand.
    if (!r || r.demandDb == null || r.partial || r.bandHz) return false;
    return stageDemand(Math.max(H_FLOOR_DB, r.demandDb), 'sweep', {
      peakFreqHz: r.peakFreqHz,
      peakInputChannel: r.peakInputChannel,
      peakOutputChannel: r.peakOutputChannel,
      lowBandDemandDb: r.lowBandDemandDb,
      fingerprint: r.fingerprint,
      fingerprintSource: r.fingerprintSource,
      chainSignature: r.chainSignature,
      slotId: r.slotId,
    });
  }

  // All staged demand goes through here so invalid or out-of-range values
  // can never reach the solver (NaN would serialize to null in the patch).
  function stageDemand(demandDb, source, extra = {}) {
    const d = parseFloat(demandDb);
    if (!Number.isFinite(d) || d < H_FLOOR_DB || d > H_MAX_DB) return false;
    const fp = slotFingerprint(cal.value?.slots?.[currentSlot.value]);
    stagedDemand.value = {
      demandDb: Math.round(d * 10) / 10,
      source,
      fingerprint: fp.value,
      fingerprintSource: fp.source ?? 'checksum',
      chainSignature: currentChainSignature.value,
      slotId: currentSlot.value,
      ...extra,
    };
    // Persist so a browser refresh mid-wizard doesn't cost the measurement;
    // it is only offered back after fingerprint + chain revalidation.
    // Reusing a previous figure isn't a new measurement, so don't re-stamp.
    if (source !== 'previous' && typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(STAGED_MEASUREMENT_KEY, JSON.stringify({
          ...stagedDemand.value,
          measuredAt: Date.now(),
        }));
        persistedMeasurement.value = JSON.parse(localStorage.getItem(STAGED_MEASUREMENT_KEY));
      } catch { /* storage unavailable: reuse just won't survive refresh */ }
    }
    return true;
  }

  function setManualDemand(demandDb) {
    return stageDemand(demandDb, 'manual');
  }

  // ---- apply -------------------------------------------------------------

  function buildSlotEntries() {
    const previous = record.value?.slots ?? [];
    const d = stagedDemand.value;
    if (!d || d.slotId == null) return [...previous];
    const prevEntry = previous.find((s) => s.slotId === d.slotId);
    const entry = {
      slotId: d.slotId,
      label: cal.value?.slots?.[d.slotId]?.name ?? `Slot ${d.slotId + 1}`,
      fingerprint: d.fingerprint,
      fingerprintSource: d.fingerprintSource ?? 'checksum',
      chainSignature: d.chainSignature ?? null,
      chainSignatureVersion: d.chainSignature != null ? CHAIN_SIG_VERSION : null,
      demand: d.demandDb,
      // keep both method figures per slot: the content-vs-sweep gap is what
      // lets a later sweep-only measurement borrow a content overhead
      demandBasis: 'measured',
      sources: {
        ...(prevEntry?.sources ?? {}),
        [d.source]: {
          demandDb: d.demandDb,
          measuredAt: Date.now(),
          ...(d.peakFreqHz != null ? { peakFreqHz: d.peakFreqHz } : {}),
          ...(d.peakOutputChannel != null ? { peakOutputChannel: d.peakOutputChannel } : {}),
        },
      },
      peakFreq: d.peakFreqHz ?? null,
      peakChannel: d.peakOutputChannel ?? null,
      // The 15-40 Hz maximum, kept so a later re-run against an unchanged
      // chain can size the BEQ allowance without re-sweeping. Carried
      // forward from the previous entry only when it described this same
      // filter and chain.
      lowBandDemandDb: d.lowBandDemandDb
        ?? ((prevEntry
          && String(prevEntry.fingerprint) === String(d.fingerprint)
          && prevEntry.chainSignature === d.chainSignature)
          ? prevEntry.lowBandDemandDb ?? null : null),
      measuredAt: Date.now(),
    };
    return [...previous.filter((s) => s.slotId !== entry.slotId), entry];
  }

  // A previous measurement for the CURRENT slot, offered for reuse when the
  // filter and processing chain are provably unchanged. Two sources, newest
  // first: a measurement persisted before it was ever applied (survives a
  // browser refresh mid-wizard), then the applied record's slot entry (the
  // same freshness check that drives the drift panel). Lets a user re-run
  // the wizard just to change what 0 dB means without re-measuring.
  const reusableMeasurement = computed(() => {
    const p = persistedMeasurement.value;
    if (p && p.slotId === currentSlot.value && p.demandDb != null) {
      const fp = slotFingerprint(cal.value?.slots?.[p.slotId]);
      if (p.fingerprint != null && String(p.fingerprint) === String(fp.value)
          && p.chainSignature === currentChainSignature.value) {
        return {
          demand: p.demandDb,
          lowBandDemandDb: p.lowBandDemandDb ?? null,
          peakFreq: p.peakFreqHz ?? null,
          peakChannel: p.peakOutputChannel ?? null,
          measuredAt: p.measuredAt ?? null,
          source: p.source ?? null,
        };
      }
    }
    if (currentSlotFreshness.value !== 'fresh') return null;
    const entry = (record.value?.slots ?? [])
      .find((s) => s.slotId === currentSlot.value);
    if (!entry || entry.demand == null) return null;
    return {
      demand: entry.demand,
      lowBandDemandDb: entry.lowBandDemandDb ?? null,
      peakFreq: entry.peakFreq ?? null,
      peakChannel: entry.peakChannel ?? null,
      measuredAt: entry.measuredAt ?? null,
      source: entry.sources?.material ? 'material'
        : (entry.sources?.sweep ? 'sweep' : 'manual'),
    };
  });

  // A previously measured reference (V_ref) is a physical fact about the
  // room: the output voltage at which it reaches reference SPL through the
  // active chain. It stays valid while the slot's filter and chain are
  // unchanged (the same freshness check as measurement reuse), letting a
  // re-run keep the THX anchor without another SPL measurement.
  const reusableReference = computed(() => (
    isCalibrated.value && record.value?.vRef != null
      && currentSlotFreshness.value === 'fresh'
      ? { vRef: record.value.vRef, calibratedAt: record.value.calibratedAt ?? null }
      : null));

  function useRecordedReference() {
    const r = reusableReference.value;
    if (!r) return false;
    splCapture.value = {
      vRef: r.vRef,
      capturedMasterVolume: null,
      reusedFromRecord: true,
    };
    return true;
  }

  function useLastMeasurement() {
    const e = reusableMeasurement.value;
    if (!e) return false;
    return stageDemand(e.demand, 'previous', {
      lowBandDemandDb: e.lowBandDemandDb ?? null,
      peakFreqHz: e.peakFreq ?? null,
      peakOutputChannel: e.peakChannel ?? null,
      reusedFromMeasuredAt: e.measuredAt ?? null,
    });
  }

  const APPLY_ACK_TIMEOUT_MS = 10000;

  // A staged measurement is only valid for the filter and chain it was
  // taken against. A filter transfer or PEQ/layout change between measuring
  // and applying must block Apply, not merely warn afterward.
  const stagedDemandStale = computed(() => {
    const d = stagedDemand.value;
    if (!d || d.slotId == null) return false;
    const slot = cal.value?.slots?.[d.slotId];
    const current = d.fingerprintSource === 'filter_id' ? slot?.filter_id : slot?.checksum;
    if (d.fingerprint != null && current != null
        && String(d.fingerprint) !== String(current)) return true;
    if (d.chainSignature != null
        && d.chainSignature !== chainSignature(mso.value, d.slotId)) return true;
    return false;
  });

  function applyCalibration() {
    if (diracFilterTransferInProgress.value || calToolConnected.value) return false;
    if (state.value !== 'OPEN') {
      applyState.value = 'error';
      applyError.value = 'Not connected to the HTP-1 — nothing was written.';
      return false;
    }
    if (stagedDemandStale.value) {
      applyState.value = 'error';
      applyError.value = 'Your filter or processing settings changed since the measurement — go back to step 2 and re-measure before applying.';
      return false;
    }
    const s = stagedSettings.value;
    if (!s || !stagedAnchor.value
        || !Number.isFinite(s.outputVoltage) || !Number.isFinite(s.headroom)
        || !Number.isFinite(s.maxVolume)) return false;
    if (stagedAnchor.value === 'reference' && !splCapture.value) return false;

    const rec = {
      ...buildRecord({
        previous: record.value,
        now: Date.now(),
        vTarget: stagedVTarget.value,
        vRef: splCapture.value?.vRef ?? null,
        anchor: stagedAnchor.value,
        slots: buildSlotEntries(),
        written: {
          outputVoltage: s.outputVoltage,
          headroom: s.headroom,
          maxVolume: s.maxVolume,
          zeroPoint: s.zeroPoint,
        },
      }),
      // what the cap is provisioned to deliver — recalculate must solve
      // against the same choice: 'amp' | 'reference' | 'headroom'
      capTarget: stagedHeadroomPriority.value === 'loudness' ? 'amp' : stagedHeadroomPriority.value,
      // The extra actually provisioned (band-aware when sweep data sized it),
      // plus the raw choice so a re-run can restore the checkbox even when
      // the system's low band needed no extra at all.
      beqUser: stagedBeqUser.value === true,
      beqWorstCase: stagedBeqWorstCase.value,
      beqAllowanceDb: beqExtraDb.value ?? 0,
    };

    // One changemso burst: settings first, record last, so a truncated
    // message can never leave a record claiming values that weren't written.
    const ops = [
      { op: 'replace', path: '/cal/ampsense', value: s.outputVoltage },
      { op: 'replace', path: '/cal/headroom', value: s.headroom },
      { op: 'replace', path: '/cal/vph', value: s.maxVolume },
    ];
    if (s.zeroPoint !== null) {
      ops.push({ op: 'replace', path: '/cal/zeroPoint', value: s.zeroPoint });
    }
    ops.push({ op: 'add', path: '/cal/vcal', value: rec });
    importMsoPatchList(ops);

    // Success is what the device echoes back, not what we queued: the
    // socket silently drops sends while disconnected, so wait until the
    // record round-trips before claiming "applied".
    applyState.value = 'applying';
    applyError.value = null;
    const stopWatch = watch(record, (r) => {
      if (r?.calibratedAt === rec.calibratedAt) {
        applyState.value = 'applied';
        stopWatch();
        clearTimeout(timer);
      }
    });
    const timer = setTimeout(() => {
      stopWatch();
      if (applyState.value === 'applying') {
        applyState.value = 'error';
        applyError.value = 'The HTP-1 did not confirm the change — check the connection and the current settings before retrying.';
      }
    }, APPLY_ACK_TIMEOUT_MS);
    return true;
  }

  // Measure one slot from the panel (state 4): switch to it if needed, run
  // the sweep, merge the result into the record's slots (record-only write —
  // settings are only changed via Recalculate), and switch back.
  const SLOT_LOAD_SETTLE_MS = 3000; // filter-load settle; tune on hardware

  async function measureSlot(slotId) {
    if (diracFilterTransferInProgress.value || calToolConnected.value) return false;
    const prevSlot = currentSlot.value;
    if (slotId !== prevSlot) {
      setDiracSlot(slotId);
      await new Promise((resolve) => setTimeout(resolve, SLOT_LOAD_SETTLE_MS));
    }
    let ok = false;
    try {
      ok = await engine.startSweep();
      const r = engine.sweepResult.value;
      // The engine measures whatever slot is ACTIVE; if another client's
      // slot change echoed in during the load settle, the result belongs to
      // a different slot and must not be recorded under this one's ID.
      if (ok && r && r.slotId !== slotId) {
        ok = false;
      } else if (ok && r && r.demandDb != null && record.value) {
        // A sweep alone under-reports: it cannot see multi-channel bass
        // summing. When another slot has both a content and a sweep figure,
        // report this sweep plus that observed overhead as an ESTIMATE;
        // otherwise record the sweep as a floor, never the answer.
        const sweepDb = Math.round(r.demandDb * 10) / 10;
        const overhead = contentOverheadDb.value;
        const previous = (record.value.slots ?? []).find((s) => s.slotId === slotId);
        const entry = {
          slotId,
          label: cal.value?.slots?.[slotId]?.name ?? `Slot ${slotId + 1}`,
          fingerprint: r.fingerprint,
          fingerprintSource: r.fingerprintSource,
          chainSignature: r.chainSignature ?? null,
          chainSignatureVersion: r.chainSignature != null ? CHAIN_SIG_VERSION : null,
          demand: overhead
            ? Math.min(H_MAX_DB, Math.round((sweepDb + overhead.overheadDb) * 10) / 10)
            : sweepDb,
          demandBasis: overhead ? 'estimate' : 'sweepFloor',
          estimate: overhead
            ? { sweepDb, overheadDb: overhead.overheadDb, fromSlotId: overhead.fromSlotId, fromLabel: overhead.fromLabel }
            : { sweepDb },
          sources: {
            ...(previous?.sources ?? {}),
            sweep: {
              demandDb: sweepDb,
              measuredAt: Date.now(),
              peakFreqHz: r.peakFreqHz,
              peakOutputChannel: r.peakOutputChannel,
            },
          },
          peakFreq: r.peakFreqHz,
          peakChannel: r.peakOutputChannel,
          measuredAt: Date.now(),
        };
        const slots = [
          ...(record.value.slots ?? []).filter((s) => s.slotId !== slotId),
          entry,
        ];
        importMsoPatchList([{ op: 'add', path: '/cal/vcal', value: { ...record.value, slots } }]);
      }
    } finally {
      if (slotId !== prevSlot) setDiracSlot(prevSlot);
    }
    return ok;
  }

  // A newly measured slot can demand more than the calibration provisioned;
  // the panel offers Recalculate when that happens (settings stay untouched).
  // Compared against the headroom ACHIEVABLE for the recorded amplifier, not
  // raw demand — a calibration that deliberately accepted a shortfall (demand
  // beyond the 4 V ceiling) is fully provisioned, and warning about it would
  // offer a Recalculate that rewrites identical settings forever.
  const underProvisioned = computed(() => {
    if (!isCalibrated.value || !record.value?.written) return false;
    const target = record.value.capTarget === 'reference' && record.value.vRef
      ? record.value.vRef
      : record.value.vTarget;
    const achievable = Math.min(
      H_MAX_DB,
      demandCeiling.value + (record.value.beqAllowanceDb ?? 0),
      // preserve-headroom calibrations have no voltage ceiling on headroom
      record.value.capTarget === 'headroom' ? Infinity : (target ? hMax(target) : Infinity),
    );
    return achievable > record.value.written.headroom + 0.5;
  });

  // ---- panel actions -----------------------------------------------------

  // Preview of what recalculating from the recorded inputs would write.
  const recalculatePreview = computed(() => {
    if (!isCalibrated.value) return null;
    // Solve against the same cap target and allowance the calibration chose.
    const need = demandCeiling.value + (record.value.beqAllowanceDb ?? 0);
    let resolved;
    if (record.value.capTarget === 'headroom') {
      const p = solvePreservingHeadroom({
        ampSensitivity: record.value.vTarget,
        requiredHeadroom: need,
      });
      resolved = {
        feasible: true, // headroom is preserved by construction
        hMax: Math.min(H_MAX_DB, need),
        shortfall: 0,
        outputVoltage: p.outputVoltage,
        achievableHeadroom: p.headroom,
      };
    } else {
      const target = record.value.capTarget === 'reference' && record.value.vRef
        ? record.value.vRef
        : record.value.vTarget;
      resolved = solve({ ampSensitivity: target, requiredHeadroom: need });
    }
    const headroom = Math.round(resolved.achievableHeadroom * 10) / 10;
    const maxVolume = Math.floor(1 - headroom);
    const zeroPoint = deriveZeroPoint(record.value.anchor, {
      vRef: record.value.vRef,
      outputVoltage: resolved.outputVoltage,
      maxVolume,
    });
    return {
      feasible: resolved.feasible,
      hMax: resolved.hMax,
      shortfall: resolved.shortfall,
      written: {
        outputVoltage: Math.round(resolved.outputVoltage * 100) / 100,
        headroom,
        maxVolume,
        zeroPoint,
      },
    };
  });

  function recalculate() {
    const p = recalculatePreview.value;
    if (!p || diracFilterTransferInProgress.value || calToolConnected.value
        || state.value !== 'OPEN') return false;
    const rec = buildRecord({
      previous: record.value,
      now: Date.now(),
      vTarget: record.value.vTarget,
      vRef: record.value.vRef,
      anchor: record.value.anchor,
      slots: record.value.slots ?? [],
      written: p.written,
    });
    const ops = [
      { op: 'replace', path: '/cal/ampsense', value: p.written.outputVoltage },
      { op: 'replace', path: '/cal/headroom', value: p.written.headroom },
      { op: 'replace', path: '/cal/vph', value: p.written.maxVolume },
    ];
    if (p.written.zeroPoint !== null) {
      ops.push({ op: 'replace', path: '/cal/zeroPoint', value: p.written.zeroPoint });
    }
    ops.push({ op: 'add', path: '/cal/vcal', value: rec });
    importMsoPatchList(ops);
    return true;
  }

  // Adopt the user's hand-edited settings as intentional: update only the
  // record, never the settings. Drift computes back to inSync on the echo.
  function keepMyChanges() {
    if (!isCalibrated.value || diracFilterTransferInProgress.value
        || calToolConnected.value || state.value !== 'OPEN') return false;
    const c = cal.value;
    importMsoPatchList([{
      op: 'add',
      path: '/cal/vcal',
      value: {
        ...record.value,
        keptAt: Date.now(),
        written: {
          outputVoltage: c.ampsense,
          headroom: c.headroom,
          maxVolume: c.vph,
          zeroPoint: record.value.anchor === 'unchanged' ? null : c.zeroPoint,
        },
      },
    }]);
    return true;
  }

  return {
    // record + panel
    record, isCalibrated, diagnosis, drift, demandCeiling, contentOverheadDb,
    panelStateName, currentSlotFreshness, currentStaleReason, slotCoverage,
    dismissStale, dismissUnmeasured, measureSlot, underProvisioned,
    recalculatePreview, recalculate, keepMyChanges,
    sweep: engine,
    // wizard
    currentStep, stepNumber, stepCount, activeSteps, wizardPath,
    stagedVTarget, stagedDemand, stagedVoltageChoice, stagedAnchor,
    stagedBeqUser, stagedHeadroomPriority, effectiveDemandDb,
    beqLowBandDb, beqNeedsSweep, beqExtraDb, stagedBeqWorstCase, beqTitleBoostDb,
    splCapture, applyState, applyError, stagedDemandStale,
    hFree, demandExceedsFree, operatingPointCards, effectiveVoltageChoice,
    stagedSettings,
    referenceDiagnostic, headroomTradeOptions,
    startWizard, goToStep, nextStep, prevStep, exitToPathB,
    captureReference, useSweepResult, setManualDemand, stageDemand, applyCalibration,
    reusableMeasurement, useLastMeasurement,
    reusableReference, useRecordedReference,
  };
}
