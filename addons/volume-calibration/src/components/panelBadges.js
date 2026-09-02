// Badge presentation for the calibration panel states, shared between the
// full panel and the compact status row on Volume Setup.
export const PANEL_BADGE_LABELS = {
  neverCalibrated: 'Not calibrated',
  inSync: 'In sync',
  settingsChanged: 'Settings changed',
  slotNotMeasured: 'Slot not measured',
  filterReplaced: 'Measurement out of date',
};

export function panelBadgeClass(stateName) {
  return {
    'badge-secondary': stateName === 'neverCalibrated',
    'badge-success': stateName === 'inSync',
    'badge-warning': stateName === 'settingsChanged' || stateName === 'slotNotMeasured',
    'badge-danger': stateName === 'filterReplaced',
  };
}
