<template>
  <div>
    <h5 class="mt-2">What voltage does your amplifier need for full power?</h5>

    <div class="form-inline mb-2">
      <div
        class="btn-group btn-group-sm mr-3"
        role="group"
      >
        <button
          v-for="v in PRESETS"
          :key="v"
          type="button"
          class="btn"
          :class="stagedVTarget === v ? 'btn-primary' : 'btn-outline-secondary'"
          @click="setVTarget(v)"
        >
          {{ v.toFixed(1) }} V
        </button>
      </div>
      <div class="input-group input-group-sm numeric-input">
        <input
          type="number"
          class="form-control"
          aria-label="Amplifier input sensitivity"
          min="0.1"
          max="4.0"
          step="0.01"
          :value="stagedVTarget"
          @change="({ target }) => setVTarget(target.value)"
        >
        <div class="input-group-append">
          <span class="input-group-text">V</span>
        </div>
      </div>
    </div>
    <label class="small text-muted">Amplifier input sensitivity</label>

    <div class="alert alert-primary small py-2">
      <strong>This number matters. Get it from your amplifier's spec sheet.</strong>
      Look for "input sensitivity" or "input level for full power." Everything the
      wizard calculates, including your final Reference Output Voltage, volume cap, and
      headroom, is derived from it.
    </div>

    <div class="alert alert-light small py-2 border">
      This asks what your <strong>amplifier</strong> needs, not what the
      setting should be. The wizard usually sets Reference Output Voltage higher than
      this number and lowers the volume cap to match: at the top of the scale
      your amp still receives exactly the voltage you enter, and the extra
      range becomes headroom for everything your processing adds.
    </div>

    <div class="alert alert-light small py-2 border">
      <strong>Run this after Dirac Live calibration.</strong> The wizard measures
      through your filters.
    </div>
  </div>
</template>

<script>
  import useVolumeCalibration from '~/use/useVolumeCalibration.js';

  export default {
    name: 'WizardStepAmpSensitivity',
    setup() {
      const { stagedVTarget } = useVolumeCalibration();

      const PRESETS = [1.0, 1.4, 1.6, 2.0, 4.0];

      function setVTarget(v) {
        const f = parseFloat(v);
        if (!Number.isNaN(f) && f >= 0.1 && f <= 4.0) {
          stagedVTarget.value = f;
        }
      }

      return { stagedVTarget, setVTarget, PRESETS };
    }
  }
</script>
