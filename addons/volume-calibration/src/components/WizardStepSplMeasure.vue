<template>
  <div>
    <h5 class="mt-2">Measure reference level at your seat</h5>
    <p class="small text-muted">
      Use your UMIK with REW's SPL meter, or a handheld meter set to
      C-weighting, slow.
    </p>

    <div
      v-if="reusableReference && !splCapture"
      class="alert alert-info small py-2 px-3"
    >
      You measured reference before<template v-if="referenceDate">
        ({{ referenceDate }})</template>:
      <strong>{{ reusableReference.vRef.toFixed(2) }} V</strong> at the HTP-1's
      outputs. Your filters and settings haven't changed since, so it's still
      valid.
      <div class="mt-2">
        <button
          class="btn btn-sm btn-primary"
          @click="useRecordedReference"
        >
          Use Previous Measurement
        </button>
        <span class="ml-1">or re-measure below</span>
      </div>
    </div>

    <div class="alert alert-light border small py-2 d-flex justify-content-between align-items-center">
      <span>
        <strong>"THX-like" band-limited pink noise at &minus;30 dBFS</strong> · front left<br>
        <span class="text-muted">Dirac has already matched the other channels to this one</span>
      </span>
      <button
        class="btn btn-sm"
        :class="tonePlaying ? 'btn-primary' : 'btn-outline-primary'"
        @click="toggleTone"
      >
        {{ tonePlaying ? 'Stop tone' : 'Play tone' }}
      </button>
    </div>

    <div class="form-group">
      <label class="small">Master volume</label>
      <div class="form-inline">
        <button class="btn btn-sm btn-outline-secondary mr-1" @click="nudgeVolume(-1)">&minus;1</button>
        <button class="btn btn-sm btn-outline-secondary mr-2" @click="nudgeVolume(1)">+1</button>
        <span class="vcal-figure">{{ displayVolume?.toFixed(1) }} dB</span>
      </div>
    </div>

    <div class="alert alert-light border small py-2 d-flex justify-content-between align-items-center">
      <span>
        <strong>Raise volume until the meter reads 75 dB</strong><br>
        <span class="text-muted">Then capture the volume you landed on</span>
      </span>
      <button
        class="btn btn-sm btn-primary"
        @click="capture"
      >
        Use this volume
      </button>
    </div>

    <div
      v-if="splCapture"
      class="alert alert-success small py-2"
    >
      {{ splCapture.reusedFromRecord ? 'Re-using your previous measurement:' : 'Captured:' }}
      reference is {{ splCapture.vRef.toFixed(2) }} V at the HTP-1's
      outputs, the output level that reaches reference in your room. The wizard
      stores this anchor so 0&nbsp;dB keeps meaning reference level even if other
      settings change later.
    </div>

    <p class="small text-muted">
      75 dB from a &minus;30 dBFS tone puts peaks at 105 dB, the same alignment
      as the cinema 85 dB / &minus;20 dBFS convention.
    </p>
  </div>
</template>

<script>
  import { computed, ref, onBeforeUnmount, onDeactivated, watch } from 'vue';

  import useVolumeCalibration from '~/use/useVolumeCalibration.js';
  import useMso from '@/use/useMso.js';

  export default {
    name: 'WizardStepSplMeasure',
    setup() {
      const {
        splCapture, captureReference, currentStep,
        reusableReference, useRecordedReference,
      } = useVolumeCalibration();

      const referenceDate = computed(() => {
        const at = reusableReference.value?.calibratedAt;
        return at ? new Date(at).toLocaleDateString() : null;
      });
      const {
        mso, displayVolume, setVolume,
        setSignalGeneratorOn, setSignalGeneratorOff,
        setSignalGeneratorChannel, setSignalGeneratorSignalType,
        setLoudnessOff, setLoudnessOn, flushMsoCommands,
      } = useMso();

      const tonePlaying = ref(false);
      let savedSgen = null;

      function startTone() {
        savedSgen = {
          sgensw: mso.value.sgen?.sgensw,
          select: mso.value.sgen?.select,
          signalType: mso.value.sgen?.signalType,
          loudness: mso.value.loudness,
        };
        // Loudness boost varies with master volume; a capture taken with it
        // on would not reproduce reference SPL once calibration moves where
        // 0 dB lands on the internal scale. Measure the un-boosted anchor.
        setLoudnessOff();
        setSignalGeneratorSignalType('thx');
        setSignalGeneratorChannel('lf');
        setSignalGeneratorOn();
        tonePlaying.value = true;
      }

      function stopTone() {
        if (!tonePlaying.value) return;
        // Off goes out ALONE: bundling other sgen edits into the same
        // changemso can leave the audio path latched on the generator
        // (source stuck at 2.0 PCM) — see the sweep engine's restore.
        setSignalGeneratorOff();
        flushMsoCommands();
        const saved = savedSgen;
        savedSgen = null;
        if (saved) {
          setTimeout(() => {
            setSignalGeneratorSignalType(saved.signalType);
            setSignalGeneratorChannel(saved.select);
            if (saved.sgensw === 'on') setSignalGeneratorOn();
            if (saved.loudness === 'on') setLoudnessOn();
            flushMsoCommands();
          }, 500);
        }
        tonePlaying.value = false;
      }

      function toggleTone() {
        if (tonePlaying.value) stopTone();
        else startTone();
      }

      function nudgeVolume(delta) {
        setVolume(mso.value.volume + delta);
      }

      function capture() {
        captureReference();
      }

      // The tone must never keep playing when the user leaves this step by
      // any route: step navigation, wizard cancel, tab switch, unmount.
      watch(currentStep, (step) => {
        if (step !== 'spl') stopTone();
      });
      onBeforeUnmount(stopTone);
      onDeactivated(stopTone);

      return {
        splCapture, displayVolume, tonePlaying,
        toggleTone, nudgeVolume, capture,
        reusableReference, useRecordedReference, referenceDate,
      };
    }
  }
</script>

<style scoped>
  .vcal-figure {
    font-weight: bold;
  }
</style>
