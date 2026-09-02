<template>
  <div class="container">
    <div class="row">
      <div class="col-12 col-xl-10">
        <div class="row justify-content-between">
          <div class="col-auto pl-0">
            <h5>Volume Calibration</h5>
          </div>
          <div class="col-auto pr-0">
            <a
              class="small" href="/#/settings/volume"
            >
              Back to Volume Setup
            </a>
          </div>
        </div>
        <div class="row">
          <volume-calibration-panel />
        </div>
      </div>
    </div>
  </div>
</template>

<script>
  import VolumeCalibrationPanel from './VolumeCalibrationPanel.vue';

  export default {
    name: 'VolumeCalibrationPage',
    components: {
      VolumeCalibrationPanel
    }
  }
</script>
