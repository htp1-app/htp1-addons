// BEQ (Bass EQ) headroom allowance.
//
// BEQ filters (beqcatalogue.readthedocs.io) are per-movie bass restoration
// presets that add substantial low-frequency boost on top of everything the
// chain already does. A calibration that ignores them under-provisions for
// every BEQ movie night.
//
// The allowance below comes from analyzing the full catalogue database
// (2026-08-06, 15,135 entries): per title, the EFFECTIVE net boost evaluated
// across 15-40 Hz — where full-scale program bass actually lives — rather
// than the raw shelf sums, which overstate demand by counting boost below
// the content band. Distribution of effective boost:
//   p25 6.6 dB · median 9.8 dB · p75 14.0 dB · p90 18.8 dB · p95 21.9 dB
//
// 10 dB (the median) fully covers about half the catalogue and most of the
// rest partially; the step-2 copy discloses the distribution so users who
// run the heaviest titles can enter more by hand.
export const BEQ_ALLOWANCE_DB = 10;

// Worst-case provisioning option: the catalogue's p95 effective boost
// (21.9 dB), rounded. Covers all but the most extreme titles without the
// user having to look a number up.
export const BEQ_WORST_CASE_DB = 22;

// The band the catalog analysis evaluated (and where BEQ boost lives). The
// sweep reports the chain's maximum gain inside this band so the allowance
// can be sized against the system's own low-band demand instead of its
// overall peak, which may sit in a different band entirely.
export const BEQ_BAND_HZ = { low: 15, high: 40 };
export const BEQ_CATALOG_STATS = {
  analyzedAt: '2026-08-06',
  entries: 15135,
  effectiveBoostDb: { p25: 6.6, median: 9.8, p75: 14.0, p90: 18.8, p95: 21.9 },
};
