<template>
  <div>
    <h5 class="mt-2">What should 0 dB mean on your volume control?</h5>
    <p class="small text-muted">
      This only decides what the numbers on the volume dial mean and where
      0&nbsp;dB sits on the scale.
    </p>

    <div
      v-for="opt in OPTIONS"
      :key="opt.value"
      class="card mb-2 vcal-card"
      :class="{ 'border-primary': stagedAnchor === opt.value }"
      role="button"
      @click="stagedAnchor = opt.value"
    >
      <div class="card-body py-2 px-3">
        <strong>{{ opt.label }}</strong>
        <span
          v-if="opt.badge"
          class="badge badge-warning ml-1"
        >{{ opt.badge }}</span>
        <div class="small text-muted">{{ opt.blurb }}</div>
      </div>
    </div>

    <div
      v-if="stagedAnchor === 'reference'"
      class="alert alert-info small py-2"
    >
      This option adds an SPL measurement step later: a few minutes with the
      microphone. You can switch to the second option at any point.
    </div>
    <div
      v-else-if="stagedAnchor === 'cleanCeiling'"
      class="alert alert-info small py-2"
    >
      No SPL measurement needed. This anchors 0&nbsp;dB to a value calculated
      from your headroom, so the wizard skips the measurement step.
    </div>
  </div>
</template>

<script>
  import useVolumeCalibration from '~/use/useVolumeCalibration.js';

  export default {
    name: 'WizardStepAnchor',
    setup() {
      const { stagedAnchor } = useVolumeCalibration();

      const OPTIONS = [
        {
          value: 'reference',
          label: 'THX reference level',
          blurb: '0 dB = 105 dB peaks at your seat',
        },
        {
          value: 'cleanCeiling',
          label: 'The loudest my system plays cleanly',
          blurb: 'No measurement needed, but this point can be different depending on active Bass EQ, Tone Control, PEQ and Channel Level settings. Volume Setup will let you know if those change after you set this',
        },
        {
          value: 'unchanged',
          label: 'Leave it as it is',
          blurb: 'The dial’s numbers keep their current meaning',
        },
      ];

      return { stagedAnchor, OPTIONS };
    }
  }
</script>

<style scoped>
  .vcal-card {
    cursor: pointer;
  }
</style>
