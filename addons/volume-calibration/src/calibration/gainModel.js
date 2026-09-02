// Gain model for the HTP-1 volume calibration feature.
//
// The model is verified against firmware (AvCtrl_volume.cpp, 2026-08-04/05):
//   headroom(MV)   = min(H_configured, 1 - MV)     floored at 1 dB
//   output_voltage = V_target * 10^((H - 1) / 20)  firmware clamps ampsense 0.1..4.0 V
//   max_volume     = 1 - H
//   H_max(V)       = 1 + 20 * log10(4 / V)
//
// Pure functions only — no Vue imports, testable headless.

export const V_CEILING = 4.0; // firmware clamp on /cal/ampsense (volts)
export const V_FLOOR = 0.1;
export const H_FLOOR_DB = 1; // digital volume never exceeds -1 dB (amp clips at 0 dB MV)
export const H_MAX_DB = 30; // firmware validation range for /cal/headroom
export const ANALOG_CAP_DB = 22; // CS3318 analog stage ceiling; overflow spills to digital

// THD+N operating zones by output voltage. Boundaries from the measurement
// report (best near 2.4 V, knee near 3.4 V) — confirm against hardware before
// surfacing as anything stronger than guidance.
export const THD_OPTIMAL_MAX_V = 2.6;
export const THD_ACCEPTABLE_MAX_V = 3.4;

const EPS = 1e-9;

/**
 * Digital headroom actually in effect at a given master volume:
 * min(H_configured, 1 - MV), floored at 1 dB.
 */
export function headroomAt(hConfigured, masterVolume) {
  return Math.max(H_FLOOR_DB, Math.min(hConfigured, 1 - masterVolume));
}

/**
 * The most headroom preservable while still delivering vTarget volts at max
 * volume: 1 + 20*log10(4 / vTarget). Also the "free headroom" threshold
 * H_free when vTarget is the voltage the system actually needs.
 */
export function hMax(vTarget) {
  return 1 + 20 * Math.log10(V_CEILING / vTarget);
}

/** THD+N zone for an output voltage setting. */
export function thdZone(outputVoltage) {
  if (outputVoltage <= THD_OPTIMAL_MAX_V + EPS) return 'optimal';
  if (outputVoltage <= THD_ACCEPTABLE_MAX_V + EPS) return 'acceptable';
  return 'degraded';
}

/**
 * Solve for the settings that deliver `ampSensitivity` volts to the amplifier
 * at maximum volume while preserving `requiredHeadroom` dB of digital headroom.
 *
 * @returns {{
 *   outputVoltage: number,      // clamped to V_CEILING
 *   requiredVoltage: number,    // unclamped, for reporting infeasible rows
 *   maxVolume: number,          // 1 - achievableHeadroom
 *   achievableHeadroom: number,
 *   hMax: number,
 *   feasible: boolean,
 *   shortfall: number,          // 0 when feasible
 *   thdZone: 'optimal'|'acceptable'|'degraded',
 * }}
 */
export function solve({ ampSensitivity, requiredHeadroom }) {
  // Clamp to the firmware's /cal/headroom range (0-30, floor 1 in practice).
  const h = Math.min(H_MAX_DB, Math.max(H_FLOOR_DB, requiredHeadroom));
  const ceiling = hMax(ampSensitivity);
  const requiredVoltage = ampSensitivity * Math.pow(10, (h - 1) / 20);
  const feasible = requiredVoltage <= V_CEILING + EPS;
  const achievableHeadroom = Math.min(H_MAX_DB, feasible ? h : ceiling);
  const outputVoltage = Math.min(requiredVoltage, V_CEILING);
  return {
    outputVoltage,
    requiredVoltage,
    maxVolume: 1 - achievableHeadroom,
    achievableHeadroom,
    hMax: ceiling,
    feasible,
    shortfall: feasible ? 0 : h - ceiling,
    thdZone: thdZone(outputVoltage),
  };
}

/**
 * The keep-headroom exit: preserve the FULL requested headroom and let the
 * top-of-scale loudness fall where it lands. Unlike solve(), an infeasible
 * request never falls back to hMax — the headroom is kept and the delivered
 * voltage drops instead. deliveredShortDb is how far the top of the scale
 * lands below the amplifier's full power (equals solve()'s shortfall — the
 * symmetric-shortfall invariant).
 */
export function solvePreservingHeadroom({ ampSensitivity, requiredHeadroom }) {
  const h = Math.min(H_MAX_DB, Math.max(H_FLOOR_DB, requiredHeadroom));
  const outputVoltage = Math.min(V_CEILING, ampSensitivity * Math.pow(10, (h - 1) / 20));
  const maxVolume = 1 - h;
  const deliveredVoltage = outputVoltage * Math.pow(10, maxVolume / 20);
  return {
    outputVoltage,
    headroom: h,
    maxVolume,
    deliveredVoltage,
    deliveredShortDb: Math.max(0, 20 * Math.log10(ampSensitivity / deliveredVoltage)),
    thdZone: thdZone(outputVoltage),
  };
}

/**
 * Inverse form for the operating-point cards: given an amplifier sensitivity
 * and a chosen output voltage, what headroom/cap does that buy?
 * deliveredVoltage is what the amp receives at the cap — always equals
 * ampSensitivity by construction (asserted in tests).
 */
export function solveAtVoltage(ampSensitivity, outputVoltage) {
  const headroom = Math.max(
    H_FLOOR_DB,
    1 + 20 * Math.log10(outputVoltage / ampSensitivity),
  );
  const maxVolume = 1 - headroom;
  return {
    outputVoltage,
    headroom,
    maxVolume,
    deliveredVoltage: outputVoltage * Math.pow(10, maxVolume / 20),
    thdZone: thdZone(outputVoltage),
  };
}

/**
 * The step-3 operating-point cards. Voltages below the amplifier's
 * sensitivity are excluded: with output voltage under the amp's full-power
 * input, the headroom floor pins the cap at 0 dB and the amp can never be
 * driven to full power — the card's "same loudness" promise would be false.
 */
export function operatingPoints(ampSensitivity, voltages = [4.0, 3.4, 2.4]) {
  return voltages
    .filter((v) => v >= ampSensitivity - EPS)
    .map((v) => solveAtVoltage(ampSensitivity, v));
}

/**
 * Analog/digital gain split. The CS3318 analog stage caps at +22 dB; the
 * firmware adds any overflow to digital gain (volDig += volAna - 22), which
 * loudness compensation can trigger at low volumes. Inputs are dB values
 * supplied by the caller (the analog-gain and loudness-curve constants are
 * hardware-verify items, not baked in here).
 */
export function gainSplit({ analogGainDb, loudnessBoostDb = 0 }) {
  const requested = analogGainDb + loudnessBoostDb;
  return {
    volAna: Math.min(requested, ANALOG_CAP_DB),
    volDigSpill: Math.max(0, requested - ANALOG_CAP_DB),
  };
}

/**
 * Digital headroom actually left after any analog-cap spill eats into it.
 */
export function effectiveHeadroom({
  hConfigured,
  masterVolume,
  analogGainDb,
  loudnessBoostDb = 0,
}) {
  const { volDigSpill } = gainSplit({ analogGainDb, loudnessBoostDb });
  return Math.max(0, headroomAt(hConfigured, masterVolume) - volDigSpill);
}

/**
 * Zero Point in the SPEC's convention (displayed = internal + zeroPoint):
 * -20*log10(vRef / outputVoltage). Kept only so the docs' formula appears
 * once, with its sign, next to the code-convention form below.
 */
export function zeroPointSpec(vRef, outputVoltage) {
  return -20 * Math.log10(vRef / outputVoltage);
}

/**
 * Zero Point value to WRITE to /cal/zeroPoint. Shipped code computes
 * displayed = volume - zeroPoint (custom controller displayVolume and the
 * node-red power-on conversion), the OPPOSITE of the handoff docs'
 * convention — so this is the negated spec value. Handoff §0 "convention
 * trap". vRef 2.52 V at 4.00 V output => -4.0 (the mockups' value).
 */
export function zeroPointSetting(vRef, outputVoltage) {
  return -zeroPointSpec(vRef, outputVoltage);
}

/**
 * The reference voltage anchor captured at wizard step 5: the output voltage
 * the HTP-1 produces at the master volume where the room reads reference SPL.
 */
export function captureVRef(outputVoltage, capturedMasterVolume) {
  return outputVoltage * Math.pow(10, capturedMasterVolume / 20);
}
