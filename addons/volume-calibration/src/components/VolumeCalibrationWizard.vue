<template>
  <div class="container">
    <div class="row">
      <div class="col-12 px-0">
        <div class="d-flex justify-content-between align-items-baseline">
          <h5>Volume calibration</h5>
          <span
            v-if="!resumePromptVisible"
            class="small text-muted"
          >
            Step {{ stepNumber }} of {{ stepCount }} · {{ stepTitle }}
          </span>
        </div>

        <div
          v-if="resumePromptVisible"
          class="card"
        >
          <div class="card-body">
            <p class="mb-2">
              A calibration is in progress at step {{ stepNumber }}
              ({{ stepTitle }}); your entries so far are kept.
            </p>
            <button
              class="btn btn-sm btn-primary mr-2"
              @click="resumePromptVisible = false"
            >
              Resume where I left off
            </button>
            <button
              class="btn btn-sm btn-outline-secondary"
              @click="restart"
            >
              Start over
            </button>
          </div>
        </div>

        <template v-else>
          <component :is="stepComponent" />

          <div class="d-flex justify-content-between mt-3 mb-4">
            <button
              v-if="stepNumber > 1"
              class="btn btn-sm btn-outline-secondary"
              @click="prevStep"
            >
              Back
            </button>
            <span v-else />
            <div>
              <router-link
                class="btn btn-sm btn-link text-muted"
                to="/"
              >
                Cancel
              </router-link>
              <button
                v-if="currentStep !== 'summary'"
                class="btn btn-sm btn-primary"
                :disabled="!canAdvance"
                @click="nextStep"
              >
                Next
              </button>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script>
  import { computed, onActivated, onBeforeUnmount, ref } from 'vue';
  import { onBeforeRouteLeave } from 'vue-router';

  import useVolumeCalibration from '~/use/useVolumeCalibration.js';

  import WizardStepAmpSensitivity from './WizardStepAmpSensitivity.vue';
  import WizardStepDemand from './WizardStepDemand.vue';
  import WizardStepAnchor from './WizardStepAnchor.vue';
  import WizardStepSplMeasure from './WizardStepSplMeasure.vue';
  import WizardStepResult from './WizardStepResult.vue';
  import WizardStepSummary from './WizardStepSummary.vue';

  const STEP_COMPONENTS = {
    amp: WizardStepAmpSensitivity,
    anchor: WizardStepAnchor,
    demand: WizardStepDemand,
    spl: WizardStepSplMeasure,
    result: WizardStepResult,
    summary: WizardStepSummary,
  };

  const STEP_TITLES = {
    amp: 'reference output voltage',
    anchor: 'what 0 dB means',
    demand: 'digital headroom',
    spl: 'measure reference',
    result: 'the result',
    summary: 'summary',
  };

  export default {
    name: 'VolumeCalibrationWizard',
    setup() {
      const {
        currentStep, stepNumber, stepCount, nextStep, prevStep, startWizard,
        stagedVTarget, stagedDemand, stagedAnchor, splCapture, applyState,
        beqNeedsSweep, stagedBeqUser, sweep,
      } = useVolumeCalibration();

      const sweepRunning = computed(() =>
        sweep.sweepState.value === 'running' || sweep.sweepState.value === 'preparing');

      // Staging survives navigation on purpose (keep-alive, sweeps). A fresh
      // entry resets after a completed apply; otherwise stale mid-run staging
      // is the user's to keep or discard, not silently resumed. The component
      // is kept alive, so this must run on every activation, not just the
      // first mount.
      const resumePromptVisible = ref(false);
      function evaluateEntry() {
        if (applyState.value === 'applied' || currentStep.value === 'amp') {
          startWizard();
          resumePromptVisible.value = false;
        } else if (!sweepRunning.value) {
          resumePromptVisible.value = true;
        }
      }
      evaluateEntry();
      onActivated(evaluateEntry);

      function restart() {
        startWizard();
        resumePromptVisible.value = false;
      }

      const stepComponent = computed(() => STEP_COMPONENTS[currentStep.value]);
      const stepTitle = computed(() => STEP_TITLES[currentStep.value]);

      const canAdvance = computed(() => {
        switch (currentStep.value) {
          case 'amp': return stagedVTarget.value > 0;
          case 'anchor': return stagedAnchor.value != null;
          case 'demand': return stagedDemand.value != null
            && stagedBeqUser.value !== null && !beqNeedsSweep.value;
          case 'spl': return splCapture.value != null;
          default: return true;
        }
      });

      onBeforeRouteLeave(() => {
        if (sweepRunning.value) {
          const leave = window.confirm(
            'A measurement sweep is running. Leave and cancel it?');
          if (leave) sweep.cancelSweep();
          return leave;
        }
        return true;
      });

      onBeforeUnmount(() => {
        if (sweepRunning.value) sweep.cancelSweep();
      });

      return {
        currentStep, stepNumber, stepCount, nextStep, prevStep,
        stepComponent, stepTitle, canAdvance,
        resumePromptVisible, restart,
      };
    }
  }
</script>
