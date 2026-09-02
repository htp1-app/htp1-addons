<template>
  <div>
    <h5 class="mt-2">Settings to apply</h5>
    <p class="small text-muted">
      These are yours to edit afterward. They're saved as a calibration record,
      and Volume Setup will flag it if they drift.
      <template v-if="wizardPath === 'B'">
        On this path 0&nbsp;dB depends on your headroom setting, which is worth
        knowing before you edit it.
      </template>
    </p>

    <table class="table table-sm vcal-summary">
      <tbody>
        <tr>
          <td>
            Reference output voltage
            <div class="small text-muted">{{ voltageReason }}</div>
          </td>
          <td class="text-right align-middle vcal-figure">
            {{ stagedSettings?.outputVoltage?.toFixed(2) }} V
          </td>
        </tr>
        <tr>
          <td>
            Maximum digital headroom
            <div class="small text-muted">{{ headroomReason }}</div>
          </td>
          <td class="text-right align-middle vcal-figure">
            {{ stagedSettings?.headroom?.toFixed(1) }} dB
          </td>
        </tr>
        <tr>
          <td>
            Maximum volume
            <div class="small text-muted">
              displays as {{ displayedCap }} once zero point applies
            </div>
          </td>
          <td class="text-right align-middle vcal-figure">
            {{ stagedSettings?.maxVolume?.toFixed(1) }} dB
          </td>
        </tr>
        <tr v-if="stagedSettings?.zeroPoint !== null">
          <td>
            Zero point
            <div class="small text-muted">{{ zeroPointReason }}</div>
          </td>
          <td class="text-right align-middle vcal-figure">
            {{ stagedSettings?.zeroPoint?.toFixed(1) }} dB
          </td>
        </tr>
        <tr v-else>
          <td>
            Zero point
            <div class="small text-muted">left untouched, as you chose</div>
          </td>
          <td class="text-right align-middle vcal-figure">—</td>
        </tr>
      </tbody>
    </table>

    <div
      v-if="wizardPath === 'B' && stagedAnchor === 'cleanCeiling'"
      class="alert alert-warning small py-2"
    >
      <strong>Saved as your calibration record.</strong> Because 0&nbsp;dB here
      is derived from headroom rather than measured, changing headroom later
      moves it. Volume Setup will tell you when that happens.
    </div>

    <div
      v-if="diracFilterTransferInProgress"
      class="alert alert-warning small py-2"
    >
      A Dirac filter transfer is in progress; settings can't be written until
      it finishes.
    </div>

    <div
      v-if="stagedDemandStale"
      class="alert alert-danger small py-2"
    >
      Your filter or processing settings changed since the measurement was
      taken, so these values may no longer cover the chain's boost. Go back to
      step 2 and re-measure before applying.
    </div>

    <div
      v-if="applyState === 'applied'"
      class="alert alert-success small py-2"
    >
      Applied and confirmed by the device. Volume Setup now shows the
      calibration state; you can close the wizard.
    </div>
    <div
      v-else-if="applyState === 'applying'"
      class="alert alert-info small py-2"
    >
      Applying, waiting for the HTP-1 to confirm…
    </div>
    <div
      v-else-if="applyState === 'error'"
      class="alert alert-danger small py-2"
    >
      {{ applyError }}
    </div>

    <button
      v-if="applyState !== 'applied' && applyState !== 'applying'"
      class="btn btn-sm btn-primary"
      :disabled="!canApply"
      @click="applyCalibration()"
    >
      {{ applyState === 'error' ? 'Retry apply' : 'Apply' }}
    </button>
    <a
      v-else
      class="btn btn-sm btn-outline-secondary" href="/#/settings/volume"
    >
      Back to Volume Setup
    </a>
  </div>
</template>

<script>
  import { computed } from 'vue';

  import useVolumeCalibration from '~/use/useVolumeCalibration.js';
  import useMso from '@/use/useMso.js';

  export default {
    name: 'WizardStepSummary',
    setup() {
      const {
        stagedSettings, stagedVTarget, stagedDemand, stagedAnchor, splCapture,
        wizardPath, applyState, applyError, applyCalibration, demandExceedsFree,
        hFree, stagedDemandStale, stagedHeadroomPriority, effectiveDemandDb,
        beqExtraDb,
      } = useVolumeCalibration();
      const { diracFilterTransferInProgress, calToolConnected, mso } = useMso();

      const canApply = computed(() =>
        !!stagedSettings.value && !!stagedAnchor.value
          && (stagedAnchor.value !== 'reference' || !!splCapture.value)
          && !diracFilterTransferInProgress.value
          && !calToolConnected.value
          && !stagedDemandStale.value);

      const voltageReason = computed(() => {
        const from = mso.value?.cal?.ampsense;
        const to = stagedSettings.value?.outputVoltage;
        if (from != null && to != null && Math.abs(to - from) > 0.05) {
          return to > from
            ? `raised from ${from.toFixed(1)} V to buy headroom`
            : `lowered from ${from.toFixed(1)} V to what your target needs`;
        }
        return 'matches your amplifier';
      });

      const headroomReason = computed(() => {
        const d = stagedDemand.value?.demandDb;
        if (d == null) return '';
        const beq = beqExtraDb.value > 0 ? ` + ${beqExtraDb.value.toFixed(1)} dB BEQ allowance` : '';
        const need = effectiveDemandDb.value ?? d;
        const h = stagedSettings.value?.headroom;
        const capNote = {
          reference: ' (scale capped at reference)',
          headroom: ' (loudness traded to preserve it)',
        }[stagedHeadroomPriority.value] ?? '';
        if (h != null && need > h + 0.05) {
          return `${d.toFixed(1)} dB measured${beq}; ${h.toFixed(1)} dB is the ceiling here${capNote}`;
        }
        return `${d.toFixed(1)} dB measured${beq}, fully preserved${capNote}`;
      });

      const zeroPointReason = computed(() =>
        (stagedAnchor.value === 'reference'
          ? 'derived from your measured reference level'
          : '0 dB = loudest clean level, not a measured reference'));

      const displayedCap = computed(() => {
        const s = stagedSettings.value;
        if (!s) return '';
        const displayed = s.maxVolume - (s.zeroPoint ?? 0);
        return `${displayed.toFixed(1)} dB`;
      });

      return {
        stagedSettings, stagedAnchor, wizardPath, applyState, applyError, applyCalibration,
        diracFilterTransferInProgress, canApply, stagedDemandStale,
        voltageReason, headroomReason, zeroPointReason, displayedCap, hFree,
      };
    }
  }
</script>

<style scoped>
  .vcal-figure {
    font-weight: bold;
  }
  .vcal-summary {
    max-width: 36rem;
  }
</style>
