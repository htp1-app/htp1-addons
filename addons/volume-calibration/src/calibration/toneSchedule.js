// Tone schedule for the calibration sweep: dense where Dirac boosts live
// (bass), sparse above. Handoff §4: 1/12 octave from 15-250 Hz, 1/3 octave
// from 250 Hz to 20 kHz.
//
// Frequencies are INTEGER Hz: the production setter (/sgen/sinehz via
// convertInt) truncates fractions, so a fractional schedule would desync the
// engine's expected-state guard from what the device actually plays. Integer
// rounding costs at most 0.5 Hz, negligible against 1/12-octave spacing.

/**
 * Build the sweep frequency list in integer Hz, strictly ascending. The
 * split frequency appears exactly once; the top frequency is always included.
 */
export function buildToneSchedule({ lowStart = 15, split = 250, top = 20000 } = {}) {
  const tones = [];
  const twelfth = Math.pow(2, 1 / 12);
  const third = Math.pow(2, 1 / 3);

  for (let f = lowStart; f < split - 1e-9; f *= twelfth) {
    push(tones, Math.round(f));
  }
  for (let f = split; f < top - 1e-9; f *= third) {
    push(tones, Math.round(f));
  }
  push(tones, Math.round(top));
  return tones;
}

// keep strictly ascending even if integer rounding collides two steps
function push(tones, f) {
  if (tones.length === 0 || f > tones[tones.length - 1]) tones.push(f);
}

/** Rough sweep ETA in seconds for the progress display. */
export function estimateDuration(toneCount, channelCount, perToneMs) {
  return Math.round((toneCount * channelCount * perToneMs) / 1000);
}
