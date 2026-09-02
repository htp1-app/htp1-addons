<template>
  <div class="container">
    <h5>Sweep Lab</h5>
    <p class="text-muted small">
      Development harness for the calibration sweep engine (milestone 2
      hardware validation). Playback pauses and the current Dirac slot's
      chain is measured with a quiet stepped-sine sweep.
    </p>

    <div class="mb-3">
      <button
        class="btn btn-sm btn-primary mr-2"
        :disabled="running"
        @click="startSweep({})"
      >
        Start sweep
      </button>
      <button
        class="btn btn-sm btn-secondary mr-2"
        :disabled="!running"
        @click="cancelSweep"
      >
        Cancel
      </button>
      <span class="badge" :class="stateBadgeClass">{{ sweepState }}</span>
    </div>

    <div
      v-if="sweepProgress"
      class="mb-3 small"
    >
      Channel {{ sweepProgress.channelIndex + 1 }}/{{ sweepProgress.channelCount }}
      ({{ sweepProgress.inputChannel }}) ·
      tone {{ sweepProgress.toneIndex + 1 }}/{{ sweepProgress.toneCount }} ·
      {{ sweepProgress.freqHz }} Hz ·
      ~{{ sweepProgress.etaSeconds }} s left
    </div>

    <div
      v-if="sweepError"
      class="alert alert-warning py-1 px-2 small"
    >
      {{ sweepError.code }}: {{ sweepError.message }}
    </div>

    <div v-if="sweepResult">
      <table class="table table-sm table-responsive-md">
        <tbody>
          <tr>
            <td>Demand (max chain gain)</td>
            <td class="text-right">{{ sweepResult.demandDb?.toFixed(2) }} dB</td>
          </tr>
          <tr>
            <td>At</td>
            <td class="text-right">
              {{ sweepResult.peakFreqHz }} Hz,
              {{ sweepResult.peakInputChannel }} &rarr; {{ sweepResult.peakOutputChannel }}
            </td>
          </tr>
          <tr>
            <td>Measured with</td>
            <td class="text-right">
              H {{ sweepResult.hConfigured }} dB, MV {{ sweepResult.masterVolume }} dB,
              slot {{ sweepResult.slotId }}
            </td>
          </tr>
        </tbody>
      </table>
      <details>
        <summary class="small">Raw result JSON</summary>
        <pre class="small">{{ JSON.stringify(sweepResult, null, 2) }}</pre>
      </details>
    </div>
  </div>
</template>

<script>
  import { computed, onDeactivated, onBeforeUnmount } from 'vue';
  import useSweep from '~/use/useSweep.js';

  export default {
    name: 'SweepLab',
    setup() {
      const { sweepState, sweepProgress, sweepResult, sweepError, startSweep, cancelSweep } = useSweep();

      const running = computed(() =>
        sweepState.value === 'running' || sweepState.value === 'preparing' || sweepState.value === 'restoring');

      // Never leave the generator running when this page goes away.
      function cancelIfRunning() {
        if (running.value) cancelSweep();
      }
      onDeactivated(cancelIfRunning);
      onBeforeUnmount(cancelIfRunning);

      const stateBadgeClass = computed(() => ({
        'badge-success': sweepState.value === 'done',
        'badge-danger': sweepState.value === 'error',
        'badge-info': running.value,
        'badge-secondary': sweepState.value === 'idle' || sweepState.value === 'cancelled',
      }));

      return { sweepState, sweepProgress, sweepResult, sweepError, startSweep, cancelSweep, running, stateBadgeClass };
    }
  }
</script>
