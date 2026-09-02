import { describe, it, expect, beforeEach } from 'vitest';
import { ref } from 'vue';
import { createSweepEngine } from './sweepEngine.js';
import { VU_VAL_TO_DBFS } from '@/calibration/vuDecode.js';

// ---- fake harness ---------------------------------------------------------

function vuIndexOf(dbfs) {
  const i = VU_VAL_TO_DBFS.indexOf(dbfs);
  if (i < 0) throw new Error('not a table value: ' + dbfs);
  return i;
}

// Nearest table index for an arbitrary dBFS value; at/below the floor -> 0.
function nearestVuIndex(dbfs) {
  if (dbfs <= -84) return 0;
  let best = 1;
  for (let i = 1; i < VU_VAL_TO_DBFS.length; i++) {
    if (Math.abs(VU_VAL_TO_DBFS[i] - dbfs) < Math.abs(VU_VAL_TO_DBFS[best] - dbfs)) best = i;
  }
  return best;
}

function makeHarness() {
  const trace = [];
  const mso = ref({
    volume: -20,
    loudness: 'off',
    cal: {
      headroom: 12,
      currentdiracslot: 0,
      diracactive: 'on',
      slots: [{ name: 'Movie', checksum: 12345 }],
    },
    sgen: { sgensw: 'off', select: 'rf', signalType: 'thx', sinehz: 440, sinedb: -20 },
    speakers: { groups: {} },
  });
  const vuPeakData = ref([]);
  const vuPeakUpdateCounter = ref(0);
  const state = ref('OPEN');

  // Behavior hooks tests can override. The default models a PHYSICAL chain:
  // the reading tracks the stimulus (chain gain -6 dB), as the engine's
  // stimulus-tracking verification requires. Return 'floor' for silence.
  const behavior = {
    readingFor: (stimulusDbfs) => stimulusDbfs - 6,
    clipped: () => false,
    activeBit: () => true,
  };

  let currentStimulus = -20;

  const deps = {
    mso,
    vuPeakData,
    vuPeakUpdateCounter,
    state,
    diracFilterTransferInProgress: ref(false),
    calToolConnected: ref(false),
    vuPollActive: ref(false),
    chainSignatureOf: () => 424242,
    // Setters mirror patchMso's local-apply behavior: mso state updates
    // immediately, which the engine's mid-sweep guards read back.
    setVolume: (v) => { trace.push(['setVolume', v]); mso.value.volume = v; },
    setLoudnessOff: () => { trace.push(['setLoudnessOff']); mso.value.loudness = 'off'; },
    setLoudnessOn: () => { trace.push(['setLoudnessOn']); mso.value.loudness = 'on'; },
    setSignalGeneratorOn: () => { trace.push(['sgenOn']); mso.value.sgen.sgensw = 'on'; },
    setSignalGeneratorOff: () => { trace.push(['sgenOff']); mso.value.sgen.sgensw = 'off'; },
    setSignalGeneratorChannel: (ch) => { trace.push(['channel', ch]); mso.value.sgen.select = ch; },
    setSignalGeneratorSignalType: (t) => { trace.push(['signalType', t]); mso.value.sgen.signalType = t; },
    // mirrors production convertInt truncation of /sgen/sinehz — a
    // fractional tone schedule would desync the expected-state guard
    setSineFrequency: (f) => { trace.push(['freq', f]); mso.value.sgen.sinehz = parseInt(f, 10); },
    setSineAmplitude: (db) => { trace.push(['level', db]); mso.value.sgen.sinedb = db; currentStimulus = db; },
    flushMsoCommands: () => trace.push(['flush']),
    clearVuPeakLevels: () => trace.push(['vuc']),
    startVuPoll: () => trace.push(['startVuPoll']),
    stopVuPoll: () => trace.push(['stopVuPoll']),
    getActiveChannels: () => ['lf', 'rf'],
    reverseAllChannelCodes: { lf: 0, rf: 1 },
    // sleep resolves on next tick and simulates meter frames arriving.
    sleep: async () => {
      await Promise.resolve();
      const db = behavior.readingFor(currentStimulus);
      const idx = db === 'floor' ? 0 : nearestVuIndex(db);
      const byte = (behavior.activeBit() ? 0x80 : 0)
        | (behavior.clipped(currentStimulus) ? 0x40 : 0) | idx;
      vuPeakData.value = [byte, byte];
      vuPeakUpdateCounter.value += 5;
    },
  };

  return { deps, trace, mso, state, behavior };
}

// ---- tests ----------------------------------------------------------------

describe('sweep engine', () => {
  let h;
  beforeEach(() => {
    h = makeHarness();
  });

  it('runs to completion and computes demand with attribution', async () => {
    // flat -26 reading at -20 stimulus, H=12 in effect at -40 MV:
    // chain gain = -26 - (-20) + 12 = 6
    const engine = createSweepEngine(h.deps);
    const ok = await engine.startSweep({ refine: false });
    expect(ok).toBe(true);
    expect(engine.sweepState.value).toBe('done');
    const r = engine.sweepResult.value;
    expect(r.demandDb).toBe(6);
    expect(r.fingerprint).toBe(12345);
    expect(r.fingerprintSource).toBe('checksum');
    expect(r.partial).toBe(false);
    expect(Object.keys(r.perInput)).toEqual(['lf', 'rf']);
    expect(r.perInput.lf.tones.length).toBeGreaterThanOrEqual(60);
  });

  it('sets quiet deterministic conditions and restores everything after', async () => {
    h.mso.value.volume = -10;
    h.mso.value.loudness = 'on';
    h.mso.value.sgen.sgensw = 'off';
    const engine = createSweepEngine(h.deps);
    await engine.startSweep({ refine: false });

    const t = h.trace;
    // setup: volume capped, loudness off, sine selected, generator on
    expect(t).toContainEqual(['setVolume', -40]);
    expect(t).toContainEqual(['setLoudnessOff']);
    expect(t).toContainEqual(['signalType', 'sine']);
    // restore: sgen off FIRST, then settings back, loudness back on, volume back
    const offIdx = t.findLastIndex((e) => e[0] === 'sgenOff');
    const loudnessOnIdx = t.findLastIndex((e) => e[0] === 'setLoudnessOn');
    const volRestoreIdx = t.findLastIndex((e) => e[0] === 'setVolume' && e[1] === -10);
    const stopIdx = t.findLastIndex((e) => e[0] === 'stopVuPoll');
    expect(offIdx).toBeGreaterThan(-1);
    expect(loudnessOnIdx).toBeGreaterThan(offIdx);
    expect(volRestoreIdx).toBeGreaterThan(offIdx);
    expect(stopIdx).toBeGreaterThan(volRestoreIdx);
    // original signal type restored
    const typeRestores = t.filter((e) => e[0] === 'signalType');
    expect(typeRestores[typeRestores.length - 1]).toEqual(['signalType', 'thx']);
    // sgen was off before, so it must not be turned back on after the restore's off
    expect(t.slice(offIdx + 1).some((e) => e[0] === 'sgenOn')).toBe(false);
  });

  it('re-probes 12 dB down when a reading is near the meter ceiling', async () => {
    // Hot chain: near-ceiling at -20 stimulus, sane at -32.
    // near-ceiling at the -20 start; tracks the stimulus once re-probed down
    h.behavior.readingFor = (stim) => (stim === -20 ? 4.5 : stim + 26);
    const engine = createSweepEngine(h.deps);
    await engine.startSweep({ refine: false, inputChannels: ['lf'] });
    expect(engine.sweepState.value).toBe('done');
    // -6 reading at -32 stimulus with 12 dB in effect: 12 - 6 + 20... chain
    // gain = -6 - (-32) + 12 = 38? No: headroom at MV -40 with H=12 is 12.
    // chainGain = -6 + 32 + 12 - 20... = reading - stimulus + h = -6+32+12 = 38.
    // The hot-chain fake isn't physical; what matters is the stimulus used:
    expect(h.trace).toContainEqual(['level', -32]);
    expect(engine.sweepResult.value.perInput.lf.tones[0].stimulusDbfs).toBe(-32);
  });

  it('cancels mid-sweep, restores, and keeps state=cancelled', async () => {
    const engine = createSweepEngine(h.deps);
    let cancelled = false;
    h.behavior.readingFor = (stim) => {
      if (!cancelled) {
        cancelled = true;
        engine.cancelSweep();
      }
      return -26;
    };
    const ok = await engine.startSweep({ refine: false });
    expect(ok).toBe(false);
    expect(engine.sweepState.value).toBe('cancelled');
    expect(engine.sweepError.value.code).toBe('cancelled');
    // restore still ran: generator off after cancellation
    expect(h.trace.some((e) => e[0] === 'sgenOff')).toBe(true);
    expect(h.trace.some((e) => e[0] === 'stopVuPoll')).toBe(true);
  });

  it('aborts with state-changed if another client moves the volume', async () => {
    const engine = createSweepEngine(h.deps);
    let moved = false;
    h.behavior.readingFor = () => {
      if (!moved) {
        moved = true;
        h.mso.value.volume = -30; // front-panel knob mid-tone
      }
      return -26;
    };
    const ok = await engine.startSweep({ refine: false });
    expect(ok).toBe(false);
    expect(engine.sweepState.value).toBe('error');
    expect(engine.sweepError.value.code).toBe('state-changed');
  });

  it('marks error=disconnected and replays the restore on reconnect', async () => {
    const engine = createSweepEngine(h.deps);
    let dropped = false;
    h.behavior.readingFor = () => {
      if (!dropped) {
        dropped = true;
        h.state.value = 'CLOSED';
      }
      return -26;
    };
    const ok = await engine.startSweep({ refine: false });
    expect(ok).toBe(false);
    expect(engine.sweepError.value.code).toBe('disconnected');
    const trBefore = h.trace.length;
    // reconnect: pending restore replays exactly once (the second half of
    // the restore rides a delayed tail behind the isolated sgen-off, so
    // flush several ticks)
    h.state.value = 'OPEN';
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const restored = h.trace.slice(trBefore);
    expect(restored.some((e) => e[0] === 'sgenOff')).toBe(true);
    expect(restored.some((e) => e[0] === 'stopVuPoll')).toBe(true);
  });

  it('refuses to start on an empty Dirac slot', async () => {
    h.mso.value.cal.slots[0].checksum = 31802;
    const engine = createSweepEngine(h.deps);
    const ok = await engine.startSweep();
    expect(ok).toBe(false);
    expect(engine.sweepError.value.code).toBe('empty-slot');
  });

  it('refuses to start during a Dirac filter transfer', async () => {
    h.deps.diracFilterTransferInProgress.value = true;
    const engine = createSweepEngine(h.deps);
    const ok = await engine.startSweep();
    expect(ok).toBe(false);
    expect(engine.sweepError.value.code).toBe('transfer');
  });

  it('refuses to start while the Dirac cal tool holds the write lock', async () => {
    h.deps.calToolConnected.value = true;
    const engine = createSweepEngine(h.deps);
    const ok = await engine.startSweep();
    expect(ok).toBe(false);
    expect(engine.sweepError.value.code).toBe('cal-tool');
  });

  it('aborts with no-signal when the meter reports no valid data', async () => {
    h.behavior.activeBit = () => false;
    const engine = createSweepEngine(h.deps);
    const ok = await engine.startSweep({ refine: false });
    expect(ok).toBe(false);
    expect(engine.sweepError.value.code).toBe('no-signal');
    // restore still ran
    expect(h.trace.some((e) => e[0] === 'sgenOff')).toBe(true);
  });

  it('aborts with saturated when readings stay pinned after all stimulus drops', async () => {
    h.behavior.readingFor = () => 6;
    h.behavior.clipped = () => true;
    const engine = createSweepEngine(h.deps);
    const ok = await engine.startSweep({ refine: false });
    expect(ok).toBe(false);
    expect(engine.sweepError.value.code).toBe('saturated');
    expect(engine.sweepError.value.message).toContain('15'); // first tone, with attribution
  });

  it('claims and releases the VU poll exactly once (ref-counted in useMso)', async () => {
    const engine = createSweepEngine(h.deps);
    await engine.startSweep({ refine: false, inputChannels: ['lf'] });
    expect(engine.sweepState.value).toBe('done');
    // Balanced start/stop: the ref count in useMso keeps another owner's
    // poll alive; the engine's job is only to pair its own claim/release.
    expect(h.trace.filter((e) => e[0] === 'startVuPoll')).toHaveLength(1);
    expect(h.trace.filter((e) => e[0] === 'stopVuPoll')).toHaveLength(1);
    const startIdx = h.trace.findIndex((e) => e[0] === 'startVuPoll');
    const stopIdx = h.trace.findIndex((e) => e[0] === 'stopVuPoll');
    expect(stopIdx).toBeGreaterThan(startIdx);
  });

  it('aborts with state-changed when the processing chain changes mid-sweep', async () => {
    let sig = 424242;
    h.deps.chainSignatureOf = () => sig;
    const engine = createSweepEngine(h.deps);
    let sabotaged = false;
    h.behavior.readingFor = () => {
      if (!sabotaged) {
        sabotaged = true;
        sig = 999999; // another client edited PEQ / layout
      }
      return -26;
    };
    const ok = await engine.startSweep({ refine: false });
    expect(ok).toBe(false);
    expect(engine.sweepError.value.code).toBe('state-changed');
    expect(engine.sweepError.value.message).toContain('processing settings');
  });

  it('aborts with state-changed when another client retunes the generator', async () => {
    const engine = createSweepEngine(h.deps);
    // Sabotage during a dwell (after the tone's own setters ran), not during
    // the channel settle where the next readTone would overwrite it.
    let calls = 0;
    h.behavior.readingFor = () => {
      calls += 1;
      if (calls === 3) {
        h.mso.value.sgen.sinedb = -5; // releveled externally: stimulus no longer what we set
      }
      return -26;
    };
    const ok = await engine.startSweep({ refine: false });
    expect(ok).toBe(false);
    expect(engine.sweepError.value.code).toBe('state-changed');
  });

  it('aborts with state-changed when another client re-enables loudness', async () => {
    const engine = createSweepEngine(h.deps);
    let calls = 0;
    h.behavior.readingFor = () => {
      calls += 1;
      if (calls === 3) {
        h.mso.value.loudness = 'on'; // echoed in from another client mid-dwell
      }
      return -26;
    };
    const ok = await engine.startSweep({ refine: false });
    expect(ok).toBe(false);
    expect(engine.sweepError.value.code).toBe('state-changed');
    expect(engine.sweepError.value.message).toContain('loudness');
  });

  it('aborts when the Dirac cal tool connects mid-sweep', async () => {
    const engine = createSweepEngine(h.deps);
    let sabotaged = false;
    h.behavior.readingFor = () => {
      if (!sabotaged) {
        sabotaged = true;
        h.deps.calToolConnected.value = true;
      }
      return -26;
    };
    const ok = await engine.startSweep({ refine: false });
    expect(ok).toBe(false);
    expect(engine.sweepError.value.code).toBe('cal-tool');
  });

  it('aborts with state-changed if another client kills the signal generator', async () => {
    const engine = createSweepEngine(h.deps);
    let sabotaged = false;
    h.behavior.readingFor = () => {
      if (!sabotaged) {
        sabotaged = true;
        h.mso.value.sgen.sgensw = 'off'; // another client's patch echoed in
      }
      return -26;
    };
    const ok = await engine.startSweep({ refine: false });
    expect(ok).toBe(false);
    expect(engine.sweepError.value.code).toBe('state-changed');
  });

  it('records the chain signature in the result', async () => {
    const engine = createSweepEngine(h.deps);
    await engine.startSweep({ refine: false, inputChannels: ['lf'] });
    expect(engine.sweepResult.value.chainSignature).toBe(424242);
  });

  it('prefers filter_id as the fingerprint when the mso carries one', async () => {
    h.mso.value.cal.slots[0].checksum = null; // legacy ART device
    h.mso.value.cal.slots[0].filter_id = '1691316452487927006';
    const engine = createSweepEngine(h.deps);
    await engine.startSweep({ refine: false, inputChannels: ['lf'] });
    expect(engine.sweepState.value).toBe('done');
    expect(engine.sweepResult.value.fingerprint).toBe('1691316452487927006');
    expect(engine.sweepResult.value.fingerprintSource).toBe('filter_id');
  });

  it('aborts with state-changed when the filter_id changes mid-sweep', async () => {
    h.mso.value.cal.slots[0].filter_id = '111';
    const engine = createSweepEngine(h.deps);
    let calls = 0;
    h.behavior.readingFor = (stim) => {
      calls += 1;
      if (calls === 3) {
        h.mso.value.cal.slots[0].filter_id = '222'; // transfer echoed in
      }
      return stim - 6;
    };
    const ok = await engine.startSweep({ refine: false });
    expect(ok).toBe(false);
    expect(engine.sweepError.value.code).toBe('state-changed');
  });

  it('refines coarse readings by raising the stimulus', async () => {
    // physical chain with -20 dB gain: -40 at the -20 start (coarse region)
    h.behavior.readingFor = (stim) => stim - 20;
    const engine = createSweepEngine(h.deps);
    await engine.startSweep({ inputChannels: ['lf'] });
    expect(engine.sweepState.value).toBe('done');
    const tone = engine.sweepResult.value.perInput.lf.tones[0];
    // refine wants -4 dBFS which needs +16 stimulus -> capped at 0; the
    // reading tracked the +20 dB change, so the pair is trusted:
    // chain gain = -20 - 0 + 12 = -8
    expect(tone.stimulusDbfs).toBe(0);
    expect(tone.chainGainDb).toBe(-8);
  });

  it('REGRESSION: a stale high reading at the start level is refuted, not accepted', async () => {
    // The spurious-demand failure: the meter returns a stale -3.5 dBFS that
    // ignores the stimulus entirely. Pre-fix this was accepted verbatim
    // (>= -10 needs no adjustment) and inflated demand by ~20 dB.
    h.behavior.readingFor = () => -3.5;
    const engine = createSweepEngine(h.deps);
    const ok = await engine.startSweep({ refine: false });
    expect(ok).toBe(false);
    expect(engine.sweepError.value.code).toBe('unstable-reading');
  });

  it('verifies zero-adjustment tones with a 6 dB tracking read', async () => {
    const engine = createSweepEngine(h.deps);
    await engine.startSweep({ refine: false, inputChannels: ['lf'] });
    expect(engine.sweepState.value).toBe('done');
    // first tone: read at -20, then the verification read at -26
    const levels = h.trace.filter((e) => e[0] === 'level').map((e) => e[1]);
    expect(levels).toContain(-26);
    // the accepted pair is the original, not the verification pair
    const tone = engine.sweepResult.value.perInput.lf.tones[0];
    expect(tone.stimulusDbfs).toBe(-20);
    expect(tone.chainGainDb).toBe(6);
  });

  it('excludes subwoofers from the stimulus input list', async () => {
    h.deps.getActiveChannels = () => ['lf', 'sub1', 'sub2'];
    h.deps.reverseAllChannelCodes = { lf: 0, sub1: 3, sub2: 4 };
    const engine = createSweepEngine(h.deps);
    await engine.startSweep({ refine: false });
    expect(engine.sweepState.value).toBe('done');
    expect(Object.keys(engine.sweepResult.value.perInput)).toEqual(['lf']);
  });

  it('aborts a speaker input that reads the floor on every tone', async () => {
    h.behavior.readingFor = () => 'floor'; // active meter, but total silence
    const engine = createSweepEngine(h.deps);
    const ok = await engine.startSweep({ refine: false });
    expect(ok).toBe(false);
    expect(engine.sweepError.value.code).toBe('no-signal');
    expect(engine.sweepError.value.message).toContain('lf');
  });
});
