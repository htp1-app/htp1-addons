// Pure per-tone decision logic for the calibration sweep. The useSweep
// composable does the I/O; everything here is testable without hardware.
//
// Arithmetic (handoff §4, verified by on-device test 2, 2026-08-05):
// the peak meter reads AFTER the digital volume, so
//   chain_gain = reading - stimulus + min(H_configured, 1 - MV)
// at measurement time. Volume-independent by construction.

import { headroomAt } from './gainModel.js';
import { decodeVuByte, vuDbfs, VU_CEILING_DBFS } from '@/calibration/vuDecode.js';
import { BEQ_BAND_HZ } from './beq.js';

export const CEILING_GUARD_DB = 2; // re-probe when within this of the +6 ceiling
export const TRACKING_TOLERANCE_DB = 3; // reading must follow a stimulus change within this
export const TRACKING_FLOOR_DBFS = -70; // below this, tracking can't be verified (meter floor)
export const REPROBE_DROP_DB = 12; // stimulus drop on a near-ceiling reading
export const REFINE_TARGET_DBFS = -4; // refine into the 0.25 dB-resolution window
export const REFINE_BELOW_DBFS = -10; // readings below this are in the coarse region
export const MAX_ADJUSTMENTS = 2; // per tone, re-probes + refinements combined
export const MIN_STIMULUS_DBFS = -80;
export const MAX_STIMULUS_DBFS = 0;

/** Chain gain for one (stimulus, reading) pair. */
export function chainGain({ readingDbfs, stimulusDbfs, hConfigured, masterVolume }) {
  return readingDbfs - stimulusDbfs + headroomAt(hConfigured, masterVolume);
}

/** Decode one output channel's peak byte into sweep terms. */
export function classifyReading(peakByte) {
  const { clipped, value } = decodeVuByte(peakByte);
  const dbfs = vuDbfs(value);
  return {
    dbfs,
    clipped,
    nearCeiling: clipped || dbfs >= VU_CEILING_DBFS - CEILING_GUARD_DB,
  };
}

/**
 * Stimulus policy after a reading:
 *  - near the meter ceiling (or clip bit): drop 12 dB and re-probe;
 *  - deep in the coarse-resolution region: raise the stimulus so the reading
 *    lands near -4 dBFS, where resolution is 0.25 dB;
 *  - otherwise accept.
 * The caller enforces MAX_ADJUSTMENTS per tone.
 */
export function nextStimulus({ stimulusDbfs, dbfs, clipped }) {
  if (clipped || dbfs >= VU_CEILING_DBFS - CEILING_GUARD_DB) {
    return {
      action: 'reprobe',
      stimulusDbfs: Math.max(MIN_STIMULUS_DBFS, stimulusDbfs - REPROBE_DROP_DB),
    };
  }
  if (dbfs < REFINE_BELOW_DBFS) {
    return {
      action: 'refine',
      stimulusDbfs: Math.min(
        MAX_STIMULUS_DBFS,
        stimulusDbfs + (REFINE_TARGET_DBFS - dbfs),
      ),
    };
  }
  return { action: 'accept', stimulusDbfs };
}

/**
 * Physical invariant check: a linear chain's reading must move by the same
 * amount as the stimulus. A reading that ignores a stimulus change is stale
 * meter data (the spurious-demand failure mode: a stale HIGH reading gets
 * accepted verbatim and can only ever inflate demand). Not applicable when
 * the earlier reading was pinned at the meter ceiling (capped) or either
 * reading sits at the floor.
 */
export function tracksStimulus({ stimulusA, readingA, stimulusB, readingB }) {
  if (readingA <= TRACKING_FLOOR_DBFS && readingB <= TRACKING_FLOOR_DBFS) return true;
  const stimulusDelta = stimulusB - stimulusA;
  const readingDelta = readingB - readingA;
  return Math.abs(readingDelta - stimulusDelta) <= TRACKING_TOLERANCE_DB;
}

/**
 * Decode the peak-hold array into per-output readings and find the hottest.
 * Bass Control cross-feeds bass to many outputs, so demand must consider ALL
 * output channels per stimulated input (on-device tests 1 and 4).
 *
 * @param vuPeakArray raw byte array from vupupdate
 * @param outputChannels [{ channel, index }] channels to read, with their
 *   vu array indexes (from reverseAllChannelCodes)
 */
export function snapshotOutputs(vuPeakArray, outputChannels) {
  const readings = [];
  let max = null;
  let anyActive = false;
  for (const { channel, index } of outputChannels) {
    const raw = vuPeakArray?.[index] ?? 0;
    const { active, clipped, value } = decodeVuByte(raw);
    const entry = { channel, active, dbfs: vuDbfs(value), clipped, value };
    if (active) anyActive = true;
    readings.push(entry);
    // Only channels the meter marks valid can win; missing/inactive data
    // must never masquerade as a real (silent) reading.
    if (active && (max === null || entry.dbfs > max.dbfs)) max = entry;
  }
  return { readings, max, anyActive };
}

/**
 * Reduce per-input tone results to the slot's demand figure.
 *
 * @param perInputToneResults
 *   { [inputChannel]: [{ freqHz, stimulusDbfs, readingDbfs, outputChannel,
 *                        chainGainDb, clipped }] }
 * @returns { demandDb, peakFreqHz, peakInputChannel, peakOutputChannel,
 *            lowBandDemandDb, perInput }
 *   lowBandDemandDb is the maximum chain gain across the BEQ band
 *   (15–40 Hz) over ALL inputs — the figure a BEQ allowance stacks on,
 *   which can sit well below the overall peak when that peak lives in a
 *   different band. Null when no tone fell inside the band.
 */
export function reduceDemand(perInputToneResults) {
  let demandDb = -Infinity;
  let peakFreqHz = null;
  let peakInputChannel = null;
  let peakOutputChannel = null;
  let lowBandDemandDb = null;
  const perInput = {};

  for (const [input, tones] of Object.entries(perInputToneResults)) {
    let inputMax = null;
    for (const t of tones) {
      if (inputMax === null || t.chainGainDb > inputMax.chainGainDb) inputMax = t;
      if (t.chainGainDb > demandDb) {
        demandDb = t.chainGainDb;
        peakFreqHz = t.freqHz;
        peakInputChannel = input;
        peakOutputChannel = t.outputChannel;
      }
      if (t.freqHz >= BEQ_BAND_HZ.low && t.freqHz <= BEQ_BAND_HZ.high
          && (lowBandDemandDb === null || t.chainGainDb > lowBandDemandDb)) {
        lowBandDemandDb = t.chainGainDb;
      }
    }
    perInput[input] = {
      maxChainGainDb: inputMax ? inputMax.chainGainDb : null,
      atFreqHz: inputMax ? inputMax.freqHz : null,
      atOutputChannel: inputMax ? inputMax.outputChannel : null,
      tones,
    };
  }

  return {
    demandDb: demandDb === -Infinity ? null : demandDb,
    peakFreqHz,
    peakInputChannel,
    peakOutputChannel,
    lowBandDemandDb,
    perInput,
  };
}
