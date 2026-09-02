// Calibration sweep engine (handoff §4): plays a quiet stepped-sine sweep
// through the processing chain per input channel and reads the APM peak
// meter across ALL output channels to measure the chain's boost ("demand").
//
// Built as a factory taking its useMso surface as dependencies, so it stays
// importable (and testable) without the browser-only modules useMso pulls
// in. The app-facing singleton lives in src/use/useSweep.js.

import { ref, watch } from 'vue';

import { buildToneSchedule, estimateDuration } from './toneSchedule.js';
import {
  chainGain,
  classifyReading,
  nextStimulus,
  snapshotOutputs,
  reduceDemand,
  tracksStimulus,
  MAX_ADJUSTMENTS,
  MIN_STIMULUS_DBFS,
  TRACKING_FLOOR_DBFS,
} from './sweepCore.js';

export const SWEEP_DEFAULTS = {
  startLevelDbfs: -20,
  vuPollMs: 300, // peak poll rate during the sweep (vupt); Peak Monitor uses 600
  dwellMs: 400, // minimum time the tone plays before a reading counts
  settleMs: 250, // serial + DSP settling after a freq/level change
  clearSettleMs: 400, // after a peak clear: in-flight frames generated
  // BEFORE the clear can still arrive for up to one poll period (vuPollMs)
  // and must not count toward the reading (the spurious-demand bug); sized
  // to vuPollMs + margin — keep them in step if either changes
  framesPerReading: 2, // vupupdate frames that must arrive after the discard window
  frameTimeoutMs: 5000,
  sweepVolume: -40, // never louder than this during the sweep
  refine: true,
  floorAbortTones: 8, // consecutive all-floor tones before a channel aborts
  // Below this frequency the settle time scales up inversely (high-Q
  // low-frequency filters ring longest exactly where BEQ/Dirac boost lives;
  // a 250 ms settle that's ample at 1 kHz can leave the previous level's
  // decay in a 16 Hz reading and fail the tracking check).
  lowFreqSettleHz: 40,
  // A tone whose reading can't be verified against the stimulus is SKIPPED
  // (recorded, never trusted); only this many consecutive skips abort the
  // sweep as genuinely untrustworthy meter data.
  unstableAbortTones: 6,
  // Restrict the tone schedule to a band, e.g. BEQ_BAND_HZ for the quick
  // low-band sweep that sizes the BEQ allowance. Null sweeps the full range.
  // A band-limited result reports its band and is never adoptable as the
  // slot's overall demand.
  bandHz: null,
};

// Honest per-tone wall-clock estimate for UI ETAs: settle + clear discard
// window + two 300 ms frames + overhead. A conservative ceiling until a
// completed sweep on this browser seeds the observed figure below.
export const PER_TONE_ESTIMATE_MS = 2200;

// Estimates learn from the last completed sweep on this browser: the
// constant is a worst-case guess, and real units run faster. Bounds guard
// against a partially-aborted sweep poisoning the estimate.
const PER_TONE_STORAGE_KEY = 'vcalObservedPerToneMs';
const PER_TONE_MIN_MS = 1000;
const PER_TONE_MAX_MS = 10000;

export function estimatePerToneMs() {
  if (typeof localStorage !== 'undefined') {
    const v = parseFloat(localStorage.getItem(PER_TONE_STORAGE_KEY));
    if (Number.isFinite(v) && v >= PER_TONE_MIN_MS && v <= PER_TONE_MAX_MS) return v;
  }
  return PER_TONE_ESTIMATE_MS;
}

// True once a completed sweep has seeded the estimate; before that the UI
// presents the constant as an upper bound rather than a prediction.
export function hasObservedPerToneMs() {
  return estimatePerToneMs() !== PER_TONE_ESTIMATE_MS;
}

function recordObservedPerToneMs(elapsedMs, toneCount) {
  if (typeof localStorage === 'undefined' || !toneCount) return;
  const perTone = Math.round(elapsedMs / toneCount);
  if (perTone >= PER_TONE_MIN_MS && perTone <= PER_TONE_MAX_MS) {
    localStorage.setItem(PER_TONE_STORAGE_KEY, String(perTone));
  }
}

const EMPTY_SLOT_CHECKSUM = 31802;

class SweepAbort extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

export function createSweepEngine(deps) {
  const {
    mso,
    setVolume,
    setLoudnessOff,
    setLoudnessOn,
    setSignalGeneratorOn,
    setSignalGeneratorOff,
    setSignalGeneratorChannel,
    setSignalGeneratorSignalType,
    setSineFrequency,
    setSineAmplitude,
    flushMsoCommands,
    clearVuPeakLevels,
    startVuPoll,
    stopVuPoll,
    vuPeakData,
    vuPeakUpdateCounter,
    diracFilterTransferInProgress,
    calToolConnected, // Dirac Live calibration lock: patchMso drops everything
    chainSignatureOf, // (mso, slotId) => signature of the non-Dirac chain
    state, // transport state ref ('OPEN' when connected)
    getActiveChannels,
    reverseAllChannelCodes,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = deps;

  const sweepState = ref('idle'); // idle|preparing|running|restoring|done|cancelled|error
  const sweepProgress = ref(null);
  const sweepResult = ref(null);
  const sweepError = ref(null);

  // A completed sweep survives a browser refresh: a slim copy (no per-tone
  // arrays) is persisted and restored here. It carries its slot, fingerprint
  // and chain signature, so every consumer re-validates before trusting it —
  // exactly as with a live result. sweepState stays 'idle', so the UI's
  // "sweep done" panel does not resurrect; only validated reuse paths
  // (BEQ sizing, use-last-measurement) see it.
  const LAST_SWEEP_STORAGE_KEY = 'vcalLastSweepResult';
  if (typeof localStorage !== 'undefined') {
    try {
      const persisted = JSON.parse(localStorage.getItem(LAST_SWEEP_STORAGE_KEY));
      if (persisted && persisted.demandDb != null) sweepResult.value = persisted;
    } catch { /* corrupt or absent: start empty */ }
  }

  function persistSweepResult(r) {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(LAST_SWEEP_STORAGE_KEY, JSON.stringify({
        slotId: r.slotId,
        fingerprint: r.fingerprint,
        fingerprintSource: r.fingerprintSource,
        chainSignature: r.chainSignature,
        hConfigured: r.hConfigured,
        masterVolume: r.masterVolume,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        partial: r.partial,
        bandHz: r.bandHz,
        skippedTones: r.skippedTones,
        demandDb: r.demandDb,
        peakFreqHz: r.peakFreqHz,
        peakInputChannel: r.peakInputChannel,
        peakOutputChannel: r.peakOutputChannel,
        lowBandDemandDb: r.lowBandDemandDb,
      }));
    } catch { /* storage full or unavailable: reuse just won't survive refresh */ }
  }

  let cancelRequested = false;
  let savedState = null;
  let pendingRestore = false;

  // If the socket comes back while a restore is owed, replay it once.
  watch(state, (v) => {
    if (v === 'OPEN' && pendingRestore) {
      performRestore();
    }
  });

  function throwIfAborted() {
    if (cancelRequested) throw new SweepAbort('cancelled');
    if (state.value !== 'OPEN') throw new SweepAbort('disconnected');
  }

  function snapshotSettings() {
    const m = mso.value;
    return {
      sgensw: m.sgen?.sgensw,
      select: m.sgen?.select,
      signalType: m.sgen?.signalType,
      sinehz: m.sgen?.sinehz,
      sinedb: m.sgen?.sinedb,
      volume: m.volume,
      loudness: m.loudness,
    };
  }

  // Returns a promise for the delayed second half of the restore; async
  // callers (the sweep flow itself) await it, fire-and-forget callers
  // (reconnect watcher, beforeunload) ignore it.
  function performRestore() {
    if (!savedState) return Promise.resolve();
    if (state.value !== 'OPEN') {
      pendingRestore = true;
      return Promise.resolve();
    }
    const s = savedState;
    pendingRestore = false;
    savedState = null;
    // Kill the tone before anything else — and ALONE. The off transition is
    // when avController hands the audio path back to the live input; bundling
    // other sgen edits into the same changemso has been seen to leave the
    // path latched on the generator (source stuck reporting 2.0 PCM until
    // the generator is manually cycled on the Signal Generator page). The
    // stock page sends off as its own message, so the sweep does too, and
    // gives the transition a moment before touching the other sgen fields.
    setSignalGeneratorOff();
    flushMsoCommands();
    return sleep(500).then(() => {
      setSineAmplitude(s.sinedb);
      setSineFrequency(s.sinehz);
      setSignalGeneratorSignalType(s.signalType);
      setSignalGeneratorChannel(s.select);
      if (s.sgensw === 'on') setSignalGeneratorOn();
      if (s.loudness === 'on') setLoudnessOn();
      setVolume(s.volume);
      flushMsoCommands();
      // stopVuPoll is reference-counted in useMso: this releases only the
      // sweep's own claim, so a Peak Monitor that is still open keeps polling.
      stopVuPoll();
    });
  }

  function handleBeforeUnload() {
    // Best effort: at least get the generator off and the patches out.
    performRestore();
  }

  function waitForFrames(targetCount, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (vuPeakUpdateCounter.value >= targetCount) return resolve();
      let timer = null;
      const stop = watch(vuPeakUpdateCounter, (v) => {
        if (v >= targetCount) {
          stop();
          if (timer) clearTimeout(timer);
          resolve();
        }
      });
      timer = setTimeout(() => {
        stop();
        reject(new SweepAbort('vu-timeout', 'no peak meter frames received'));
      }, timeoutMs);
    });
  }

  function outputChannelIndexes() {
    return getActiveChannels(mso.value.speakers?.groups).map((channel) => ({
      channel,
      index: reverseAllChannelCodes[channel],
    }));
  }

  async function readTone(freqHz, stimulusDbfs, opts, context) {
    // Retune, clear peaks, discard in-flight frames, dwell, snapshot.
    setSineFrequency(freqHz);
    setSineAmplitude(stimulusDbfs);
    context.expected.sinehz = freqHz;
    context.expected.sinedb = stimulusDbfs;
    flushMsoCommands();
    // Longer settle at very low frequencies, where filter ring-out decays
    // slowest: ~667 ms at 15 Hz, the base 250 ms from 40 Hz up.
    await sleep(Math.round(opts.settleMs * Math.max(1, opts.lowFreqSettleHz / freqHz)));
    throwIfAborted();
    clearVuPeakLevels();
    // Frames generated before the clear can arrive after it; counting them
    // as "fresh" is how a previous tone's peak masqueraded as this tone's
    // reading. Wait out one poll period, THEN baseline the frame counter.
    await sleep(opts.clearSettleMs);
    throwIfAborted();
    const target = vuPeakUpdateCounter.value + opts.framesPerReading;
    await Promise.all([sleep(opts.dwellMs), waitForFrames(target, opts.frameTimeoutMs)]);
    throwIfAborted();
    guardMeasurementState(context);
    return snapshotOutputs(vuPeakData.value, outputChannelIndexes());
  }

  function guardMeasurementState(context) {
    // Anything another client changes mid-sweep that alters the measured
    // chain or the add-back arithmetic invalidates this tone: volume,
    // headroom, the active slot or its filter, Dirac state, the rest of the
    // processing chain (PEQ, layout, tone control), the cal-tool lock, or
    // the signal generator's routing/tuning/level — a retuned or releveled
    // generator would make chainGain use the intended stimulus, not the
    // actual one.
    const m = mso.value;
    if (calToolConnected?.value) {
      throw new SweepAbort('cal-tool', 'Dirac Live calibration started during the sweep');
    }
    if (m.volume !== context.masterVolume || m.cal?.headroom !== context.hConfigured) {
      throw new SweepAbort('state-changed', 'volume or headroom changed during the sweep');
    }
    // The sweep forces loudness off; loudness moves gain between the analog
    // and digital domains, so a mid-sweep re-enable would mix incompatible
    // readings.
    if (m.loudness === 'on') {
      throw new SweepAbort('state-changed', 'loudness was enabled during the sweep');
    }
    const guardSlot = m.cal?.slots?.[context.slotId];
    if (m.cal?.currentdiracslot !== context.slotId
        || guardSlot?.checksum !== context.slotChecksum
        || guardSlot?.filter_id !== context.slotFilterId
        || m.cal?.diracactive !== context.diracactive) {
      throw new SweepAbort('state-changed', 'the Dirac slot or filter changed during the sweep');
    }
    if (chainSignatureOf
        && chainSignatureOf(m, context.slotId) !== context.chainSignature) {
      throw new SweepAbort('state-changed', 'processing settings (PEQ, layout, or tone controls) changed during the sweep');
    }
    const e = context.expected;
    if (m.sgen?.sgensw !== 'on' || m.sgen?.signalType !== 'sine'
        || (e.select !== undefined && m.sgen?.select !== e.select)
        || (e.sinehz !== undefined && m.sgen?.sinehz !== e.sinehz)
        || (e.sinedb !== undefined && m.sgen?.sinedb !== e.sinedb)) {
      throw new SweepAbort('state-changed', 'the signal generator was changed during the sweep');
    }
  }

  function classifyMax(snapshot) {
    return classifyReading((snapshot.max.clipped ? 0x40 : 0) | snapshot.max.value);
  }

  // One attempt at a tone. Returns { stale: true } when a reading fails the
  // stimulus-tracking invariant — the caller retries once, then aborts.
  async function attemptTone(freqHz, opts, context) {
    let stimulusDbfs = opts.startLevelDbfs;
    let snapshot = await readTone(freqHz, stimulusDbfs, opts, context);
    let cls = snapshot.max ? classifyMax(snapshot) : null;
    let adjustments = 0;
    let verified = false;

    while (snapshot.max && adjustments < MAX_ADJUSTMENTS) {
      const next = nextStimulus({ stimulusDbfs, dbfs: cls.dbfs, clipped: cls.clipped });
      if (next.action === 'accept') break;
      if (!opts.refine && next.action === 'refine') break;
      if (next.stimulusDbfs === stimulusDbfs) break;
      const prev = { stimulusDbfs, dbfs: cls.dbfs, nearCeiling: cls.nearCeiling };
      stimulusDbfs = next.stimulusDbfs;
      snapshot = await readTone(freqHz, stimulusDbfs, opts, context);
      if (!snapshot.max) break;
      cls = classifyMax(snapshot);
      adjustments += 1;
      // Every stimulus change doubles as a tracking check (unless the prior
      // reading was capped at the ceiling, where tracking isn't expected).
      if (!prev.nearCeiling) {
        if (!tracksStimulus({
          stimulusA: prev.stimulusDbfs, readingA: prev.dbfs,
          stimulusB: stimulusDbfs, readingB: cls.dbfs,
        })) {
          return { stale: true };
        }
        verified = true;
      }
    }

    // No output channel had valid meter data: the meter isn't feeding us, so
    // completing would fabricate a demand figure out of silence.
    if (!snapshot.max || !snapshot.anyActive) {
      throw new SweepAbort('no-signal',
        `no valid peak meter data at ${freqHz} Hz — is the meter running?`);
    }

    // Still pinned at the meter ceiling after every allowed stimulus drop:
    // the true boost is beyond what this pass can quantify. An underestimate
    // written as a calibration would silently under-provision, so abort.
    if (cls.nearCeiling) {
      throw new SweepAbort('saturated',
        `the chain's boost at ${freqHz} Hz on ${snapshot.max.channel} exceeds the measurable range`);
    }

    // A reading accepted without any stimulus change was never challenged —
    // exactly how a stale HIGH value became a spurious 34.5 dB demand. Verify
    // it tracks a 6 dB drop before trusting it. (Floor-level readings can't
    // be verified and can't set demand either.)
    if (!verified && cls.dbfs > TRACKING_FLOOR_DBFS) {
      const verifyStimulus = Math.max(MIN_STIMULUS_DBFS, stimulusDbfs - 6);
      const verifySnapshot = await readTone(freqHz, verifyStimulus, opts, context);
      const verifyCls = verifySnapshot.max ? classifyMax(verifySnapshot) : null;
      if (!verifyCls || !tracksStimulus({
        stimulusA: stimulusDbfs, readingA: cls.dbfs,
        stimulusB: verifyStimulus, readingB: verifyCls.dbfs,
      })) {
        return { stale: true };
      }
    }

    return {
      result: {
        freqHz,
        stimulusDbfs,
        readingDbfs: snapshot.max.dbfs,
        outputChannel: snapshot.max.channel,
        clipped: snapshot.max.clipped,
        chainGainDb: chainGain({
          readingDbfs: snapshot.max.dbfs,
          stimulusDbfs,
          hConfigured: context.hConfigured,
          masterVolume: context.masterVolume,
        }),
      },
    };
  }

  // Null means the tone's reading could not be verified after a retry — the
  // caller records the skip (an unverified reading must never set demand)
  // and only aborts when skips run consecutively.
  async function measureTone(freqHz, opts, context) {
    const first = await attemptTone(freqHz, opts, context);
    if (!first.stale) return first.result;
    const second = await attemptTone(freqHz, opts, context);
    if (!second.stale) return second.result;
    return null;
  }

  async function startSweep(options = {}) {
    if (sweepState.value === 'preparing' || sweepState.value === 'running') {
      return false;
    }
    const opts = { ...SWEEP_DEFAULTS, ...options };
    sweepError.value = null;
    sweepResult.value = null;
    cancelRequested = false;
    sweepState.value = 'preparing';

    try {
      if (state.value !== 'OPEN') throw new SweepAbort('disconnected');
      if (diracFilterTransferInProgress.value) throw new SweepAbort('transfer', 'Dirac filter transfer in progress');
      // While Dirac Live's cal tool is connected, patchMso drops every patch
      // — the sweep would silently measure whatever was already playing.
      if (calToolConnected?.value) {
        throw new SweepAbort('cal-tool', 'Dirac Live calibration is in progress');
      }

      const slotId = mso.value.cal?.currentdiracslot;
      const slot = mso.value.cal?.slots?.[slotId];
      if (!slot || slot.valid === false || slot.checksum === EMPTY_SLOT_CHECKSUM) {
        throw new SweepAbort('empty-slot', 'the active Dirac slot has no filter');
      }

      savedState = snapshotSettings();
      if (typeof window !== 'undefined') {
        window.addEventListener('beforeunload', handleBeforeUnload);
      }

      // Quiet, deterministic measurement conditions.
      if (mso.value.volume > opts.sweepVolume) setVolume(opts.sweepVolume);
      setLoudnessOff();
      setSignalGeneratorSignalType('sine');
      setSineAmplitude(opts.startLevelDbfs);
      flushMsoCommands();
      setSignalGeneratorOn();
      flushMsoCommands();
      startVuPoll(opts.vuPollMs);

      // Prefer the uint64 filter_id (a string in the mso) — the legacy
      // checksum is null on Dirac ART devices.
      const hasFilterId = slot.filter_id !== null && slot.filter_id !== undefined;
      const context = {
        hConfigured: mso.value.cal?.headroom,
        masterVolume: mso.value.volume,
        slotId,
        fingerprint: hasFilterId ? slot.filter_id : slot.checksum,
        fingerprintSource: hasFilterId ? 'filter_id' : 'checksum',
        slotChecksum: slot.checksum,
        slotFilterId: slot.filter_id,
        diracactive: mso.value.cal?.diracactive,
        chainSignature: chainSignatureOf ? chainSignatureOf(mso.value, slotId) : null,
        expected: {}, // sgen values the engine last set, per tone/channel
        skippedTones: [], // tones whose readings could not be verified
      };

      // Subwoofers are outputs, not program inputs: stimulating one measures
      // its own gain stage (trim read back as "chain boost") rather than any
      // path real content takes, so subs are excluded as stimulus channels.
      // They are still read as OUTPUTS for every speaker input. Known
      // limitation: the LFE program channel has no equivalent stimulus path.
      const inputChannels = (opts.inputChannels
        || getActiveChannels(mso.value.speakers?.groups))
        .filter((ch) => !ch.startsWith('sub'));
      if (!inputChannels.length) {
        throw new SweepAbort('no-inputs', 'no non-subwoofer input channels to sweep');
      }
      const tones = buildToneSchedule().filter((f) =>
        !opts.bandHz || (f >= opts.bandHz.low && f <= opts.bandHz.high));
      if (!tones.length) {
        throw new SweepAbort('no-tones', 'the requested band contains no tones');
      }
      const startedAt = Date.now();
      const perToneEstimateMs = estimatePerToneMs();

      sweepState.value = 'running';
      const perInput = {};

      for (let c = 0; c < inputChannels.length; c++) {
        const channel = inputChannels[c];
        throwIfAborted();
        setSignalGeneratorChannel(channel);
        context.expected.select = channel;
        flushMsoCommands();
        await sleep(300);
        perInput[channel] = [];
        let consecutiveUnstable = 0;

        for (let t = 0; t < tones.length; t++) {
          throwIfAborted();
          sweepProgress.value = {
            inputChannel: channel,
            channelIndex: c,
            channelCount: inputChannels.length,
            toneIndex: t,
            toneCount: tones.length,
            freqHz: tones[t],
            etaSeconds: estimateDuration(
              tones.length * (inputChannels.length - c) - t,
              1,
              perToneEstimateMs,
            ),
          };
          const toneResult = await measureTone(tones[t], opts, context);
          if (toneResult === null) {
            context.skippedTones.push({ freqHz: tones[t], inputChannel: channel });
            consecutiveUnstable += 1;
            if (consecutiveUnstable >= opts.unstableAbortTones) {
              throw new SweepAbort('unstable-reading',
                `${consecutiveUnstable} consecutive tones on ${channel} did not track the stimulus — meter data cannot be trusted`);
            }
            continue;
          }
          consecutiveUnstable = 0;
          perInput[channel].push(toneResult);

          // A speaker input whose first tones ALL read the meter floor is
          // not reaching the chain at all (subs would still show redirected
          // bass) — abort with attribution instead of wasting the channel.
          if (perInput[channel].length === opts.floorAbortTones
              && perInput[channel].every((r) => r.readingDbfs <= -84)) {
            throw new SweepAbort('no-signal',
              `${channel} produced no meter signal on any output for ${opts.floorAbortTones} consecutive tones`);
          }
        }
      }

      // One more pass over any skipped tones now that the sweep has settled —
      // a transient glitch at first attempt shouldn't leave permanent holes.
      if (context.skippedTones.length) {
        const remaining = [];
        for (const s of context.skippedTones) {
          throwIfAborted();
          if (context.expected.select !== s.inputChannel) {
            setSignalGeneratorChannel(s.inputChannel);
            context.expected.select = s.inputChannel;
            flushMsoCommands();
            await sleep(300);
          }
          sweepProgress.value = {
            ...sweepProgress.value,
            inputChannel: s.inputChannel,
            freqHz: s.freqHz,
          };
          const retried = await measureTone(s.freqHz, opts, context);
          if (retried) perInput[s.inputChannel].push(retried);
          else remaining.push(s);
        }
        context.skippedTones = remaining;
      }

      sweepState.value = 'restoring';
      await performRestore();

      recordObservedPerToneMs(
        Date.now() - startedAt,
        tones.length * inputChannels.length,
      );

      sweepResult.value = {
        slotId: context.slotId,
        fingerprint: context.fingerprint,
        fingerprintSource: context.fingerprintSource,
        chainSignature: context.chainSignature,
        hConfigured: context.hConfigured,
        masterVolume: context.masterVolume,
        startedAt,
        finishedAt: Date.now(),
        partial: false,
        bandHz: opts.bandHz ?? null,
        skippedTones: context.skippedTones,
        ...reduceDemand(perInput),
      };
      persistSweepResult(sweepResult.value);
      sweepState.value = 'done';
      return true;
    } catch (err) {
      const code = err instanceof SweepAbort ? err.code : 'unexpected';
      sweepError.value = { code, message: err.message };
      sweepState.value = 'restoring';
      await performRestore(); // queues as pendingRestore if disconnected
      sweepState.value = code === 'cancelled' ? 'cancelled' : 'error';
      if (code === 'unexpected') console.error('sweep error', err);
      return false;
    } finally {
      if (typeof window !== 'undefined') {
        window.removeEventListener('beforeunload', handleBeforeUnload);
      }
      sweepProgress.value = null;
    }
  }

  function cancelSweep() {
    if (sweepState.value === 'running' || sweepState.value === 'preparing') {
      cancelRequested = true;
    }
  }

  return {
    sweepState,
    sweepProgress,
    sweepResult,
    sweepError,
    startSweep,
    cancelSweep,
  };
}

