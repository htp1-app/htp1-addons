// App-wide singleton for the calibration sweep engine, wired to the real
// useMso surface. The engine itself lives in src/calibration/sweepEngine.js
// so it can be tested without browser-only modules.

import useMso from '@/use/useMso.js';
import useSpeakerGroups from '@/use/useSpeakerGroups.js';
import { createSweepEngine } from '~/calibration/sweepEngine.js';
import { chainSignature } from '~/calibration/calibrationRecord.js';

let singleton = null;

export default function useSweep() {
  if (!singleton) {
    const {
      mso, setVolume, setLoudnessOff, setLoudnessOn, setSignalGeneratorOn,
      setSignalGeneratorOff, setSignalGeneratorChannel, setSignalGeneratorSignalType,
      setSineFrequency, setSineAmplitude, flushMsoCommands, clearVuPeakLevels,
      startVuPoll, stopVuPoll, vuPeakData, vuPeakUpdateCounter, vuPollActive,
      diracFilterTransferInProgress, calToolConnected, state,
    } = useMso();
    const { getActiveChannels, reverseAllChannelCodes } = useSpeakerGroups();
    singleton = createSweepEngine({
      mso, setVolume, setLoudnessOff, setLoudnessOn, setSignalGeneratorOn,
      setSignalGeneratorOff, setSignalGeneratorChannel, setSignalGeneratorSignalType,
      setSineFrequency, setSineAmplitude, flushMsoCommands, clearVuPeakLevels,
      startVuPoll, stopVuPoll, vuPeakData, vuPeakUpdateCounter, vuPollActive,
      diracFilterTransferInProgress, calToolConnected, state,
      getActiveChannels, reverseAllChannelCodes,
      chainSignatureOf: chainSignature,
    });
  }
  return singleton;
}
