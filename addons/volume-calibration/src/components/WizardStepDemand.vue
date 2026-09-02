<template>
  <div>
    <h5 class="mt-2">How much digital headroom does your system need?</h5>

    <!-- step 1: demand from content (manual fallback inside) -->
    <div
      class="card mb-2 vcal-card"
      :class="card1Complete ? 'vcal-captured' : { 'border-primary': openCard === 1 }"
      role="button"
      @click="openCard = 1"
    >
      <div class="card-body py-2 px-3">
        <strong>1. Watch peaks while demanding content plays</strong>
        <span
          v-if="card1Complete"
          class="badge badge-success ml-2 align-middle"
        >&#10003; {{ demandBadgeLabel }}</span>
        <div
          v-if="materialCaptured"
          class="small mt-1"
        >
          Captured from your content:
          <template v-if="stagedDemand.peakDbfs != null">
            {{ stagedDemand.peakDbfs.toFixed(1) }} dBFS peak +
            {{ stagedDemand.headroomAtCapture.toFixed(1) }} dB headroom in effect =
          </template>
          <strong>{{ stagedDemand.demandDb.toFixed(1) }} dB</strong> headroom demand
        </div>
        <div
          v-else-if="reusedMaterial"
          class="small mt-1"
        >
          Re-using your content measurement from {{ reusableDate }}:
          <strong>{{ stagedDemand.demandDb.toFixed(1) }} dB</strong> headroom demand
        </div>
        <div
          v-else-if="card1Complete"
          class="small mt-1"
        >
          Measured demand: <strong>{{ stagedDemand.demandDb.toFixed(1) }} dB</strong>
          ({{ sourceLabel }})
        </div>
        <div
          v-if="offerReuseMaterial"
          class="alert alert-info small py-2 px-3 mt-2 mb-1"
        >
          Your filters haven't changed since your last content measurement
          ({{ reusableDate }}): <strong>{{ reusableMeasurement.demand.toFixed(1) }} dB</strong>
          <div class="mt-2">
            <button
              class="btn btn-sm btn-primary"
              @click.stop="reuseLast"
            >
              Use Previous Measurement
            </button>
            <span class="ml-1">or re-measure below</span>
          </div>
        </div>
        <template v-if="openCard === 1">
          <p
            v-if="!card1Complete"
            class="small text-muted mb-1"
          >
            Play something with heavy, multi-channel bass, such as an Atmos demo
            reel or a movie known for deep bass, for a few minutes at your normal
            volume, and Peak Monitor records what it demanded. Real content
            exercises everything your processing adds at once, which makes it
            the real path to your headroom number.
          </p>
          <!-- its rows carry negative margins that would bleed past the card
               padding; this wrapper's padding absorbs them -->
          <div class="px-3">
            <peak-signal-levels />
          </div>
          <div class="form-inline mt-2">
            <label class="small mr-2">Highest peak observed:</label>
            <strong class="mr-2">
              {{ observedPeakDbfs != null ? `${observedPeakDbfs.toFixed(1)} dBFS` : 'no peaks yet' }}
            </strong>
            <button
              class="btn btn-sm btn-primary"
              :disabled="observedPeakDbfs == null"
              @click.stop="useMaterialPeak"
            >
              Use it
            </button>
          </div>
          <div
            v-if="materialError"
            class="alert alert-warning small py-1 px-2 mt-1 mb-0"
          >
            {{ materialError }}
          </div>
          <p class="small text-muted mt-1 mb-0">
            The {{ availableHeadroomNow.toFixed(1) }} dB of headroom in effect at
            the current volume is added back automatically. It only covers what
            you played; a few minutes of genuinely demanding material beats a
            long stretch of quiet content.
          </p>
          <div class="form-inline mt-2">
            <label class="small mr-2">Or set the demand yourself:</label>
            <div class="input-group input-group-sm numeric-input mr-2">
              <input
                v-model="manualDemand"
                type="number"
                class="form-control"
                min="1"
                max="30"
                step="0.5"
              >
              <div class="input-group-append">
                <span class="input-group-text">dB</span>
              </div>
            </div>
            <button
              class="btn btn-sm btn-outline-primary"
              @click.stop="useManual"
            >
              Use it
            </button>
          </div>
          <div class="text-right mt-2">
            <button
              class="btn btn-sm btn-primary"
              :disabled="stagedDemand == null"
              @click.stop="openCard = 2"
            >
              Continue
            </button>
          </div>
        </template>
      </div>
    </div>

    <!-- step 2: BEQ allowance -->
    <div
      class="card mb-2 vcal-card"
      :class="card2Complete ? 'vcal-captured' : { 'border-primary': openCard === 2 }"
      role="button"
      @click="openCard = 2"
    >
      <div class="card-body py-2 px-3">
        <div class="d-flex justify-content-between align-items-center">
          <strong>2. Do you use BEQ for movie playback?</strong>
          <div
            v-if="openCard === 2"
            class="btn-group btn-group-sm"
          >
            <button
              type="button"
              class="btn"
              :class="stagedBeqUser === true ? 'btn-primary' : 'btn-outline-secondary'"
              @click.stop="chooseBeq(true)"
            >
              Yes
            </button>
            <button
              type="button"
              class="btn"
              :class="stagedBeqUser === false ? 'btn-primary' : 'btn-outline-secondary'"
              @click.stop="chooseBeq(false)"
            >
              No
            </button>
          </div>
          <span
            v-else-if="card2Complete"
            class="badge badge-success align-middle"
          >&#10003; {{ stagedBeqUser ? 'Yes' : 'No' }}</span>
        </div>
        <div
          v-if="openCard !== 2 && stagedBeqUser === true"
          class="small mt-1"
        >
          BEQ allowance:
          <strong v-if="beqExtraDb != null">+{{ beqExtraDb.toFixed(1) }} dB</strong>
          <span
            v-else
            class="text-warning"
          >pending the step 3 sweep</span>
        </div>
        <p
          v-if="openCard === 2"
          class="small text-muted mb-0"
        >
          BEQ presets add substantial bass boost. Choosing yes requires the
          per-channel sweep in step 3: it measures how much boost your system
          already has, and the allowance is sized from it, adding only what
          your overall measurement doesn't already cover.
        </p>
        <div
          v-if="openCard === 2 && stagedBeqUser === true"
          class="alert alert-info small py-2 mt-2 mb-0"
        >
          By default this provisions for the median BEQ title's boost
          (<strong>{{ BEQ_ALLOWANCE_DB }} dB</strong>): the median effective
          low-frequency boost across all
          {{ beqEntries.toLocaleString() }} titles in the
          <a
            href="https://beqcatalogue.readthedocs.io/en/latest/"
            target="_blank"
            rel="noopener"
          >BEQ catalogue</a>, so half of all titles are fully covered and
          most of the rest nearly so.
          <div class="custom-control custom-checkbox mt-2">
            <input
              id="vcal-beq-worst"
              v-model="stagedBeqWorstCase"
              type="checkbox"
              class="custom-control-input"
            >
            <label class="custom-control-label" for="vcal-beq-worst">
              Provision for the heaviest BEQ titles instead
              ({{ BEQ_WORST_CASE_DB }} dB, covering all but the most extreme
              ~5% of the catalogue)
            </label>
          </div>
        </div>
        <template v-if="openCard === 2">
          <div
            v-if="beqNeedsSweep"
            class="alert alert-warning small py-1 px-2 mt-2 mb-0"
          >
            Run the &ldquo;Measure BEQ band&rdquo; option in step 3. It
            measures your system's 15&ndash;40&nbsp;Hz boost, which determines
            the BEQ specific additional headroom needed for your system.
          </div>
          <div class="text-right mt-2">
            <button
              class="btn btn-sm btn-primary"
              :disabled="stagedBeqUser === null"
              @click.stop="openCard = 3"
            >
              Continue
            </button>
          </div>
        </template>
      </div>
    </div>

    <!-- step 3: sweep (sizes BEQ; re-measures after filter changes) -->
    <div
      class="card mb-2 vcal-card"
      :class="card3Complete ? 'vcal-captured' : { 'border-primary': openCard === 3 }"
      role="button"
      @click="openCard = 3"
    >
      <div class="card-body py-2 px-3">
        <strong>3. Per-channel sweep
          ({{ stagedBeqUser === true ? 'required for BEQ' : 'optional' }})</strong>
        <span
          v-if="reusedSweep"
          class="badge badge-success ml-2 align-middle"
        >&#10003; last measurement in use</span>
        <span
          v-else-if="card3Complete"
          class="badge badge-success ml-2 align-middle"
        >&#10003; measured</span>
        <div
          v-if="priorSweep"
          class="alert alert-info small py-2 px-3 mt-2 mb-1"
        >
          Your previous sweep<template v-if="priorSweepDate">
            ({{ priorSweepDate }})</template> is used by default:
          15&ndash;40&nbsp;Hz boost
          <strong>{{ priorSweep.lowBandDb.toFixed(1) }} dB</strong><template v-if="priorSweep.full && priorSweep.demandDb != null">
            · overall +{{ priorSweep.demandDb.toFixed(1) }} dB</template>.
          Your filters and settings haven't changed since, so re-measuring
          would find the same result; you can simply continue.
        </div>
        <div
          v-if="offerReuseSweep"
          class="alert alert-info small py-2 px-3 mt-2 mb-1"
        >
          Your filters haven't changed since your last sweep
          ({{ reusableDate }}): <strong>{{ reusableMeasurement.demand.toFixed(1) }} dB</strong>
          <div class="mt-2">
            <button
              class="btn btn-sm btn-primary"
              @click.stop="reuseLast"
            >
              Use Previous Measurement
            </button>
            <span class="ml-1">or re-measure below</span>
          </div>
        </div>

        <template v-if="openCard === 3">
          <p class="small text-muted mb-2">
            A quiet test sweep measures each channel's path individually and
            names the frequency and channel with the most boost; playback
            pauses while it runs. It's intended for two jobs: finding the BEQ
            allowance your system needs when you answered yes in step 2
            ({{ lowBandDurationLabel }}), and re-measuring after transferring
            a new Dirac filter, to see how its demand differs from the
            previous one ({{ fullDurationLabel }} for your
            {{ channelCount }}-channel layout). Because it plays one channel
            at a time it misses bass that several channels add together, so
            the content measurement in step 1 usually finds a higher overall
            number.
          </p>
          <div
            v-if="!sweepRunning"
            class="mb-2"
          >
            <button
              v-if="stagedBeqUser === true"
              class="btn btn-sm btn-primary mr-2 mb-1"
              @click="sweep.startSweep({ bandHz: BEQ_BAND_HZ })"
            >
              {{ priorSweep ? 'Re-measure' : 'Measure' }} BEQ band
              (15&ndash;40 Hz) · {{ lowBandDurationLabel }}
            </button>
            <button
              class="btn btn-sm mb-1"
              :class="stagedBeqUser === true ? 'btn-outline-secondary' : 'btn-primary'"
              @click="sweep.startSweep({})"
            >
              Full {{ priorSweep ? 're-measurement' : 'measurement' }} · {{ fullDurationLabel }}
            </button>
          </div>
          <div v-if="sweepRunning" class="mb-2">
            <div class="small">
              Sweeping · {{ slotName }} ·
              {{ progress?.inputChannel }} · tone
              {{ (progress?.toneIndex ?? 0) + 1 }} of {{ progress?.toneCount }}
            </div>
            <div class="progress mt-1 mb-1" style="height: 6px;">
              <div
                class="progress-bar"
                role="progressbar"
                :style="{ width: progressPercent + '%' }"
              />
            </div>
            <button class="btn btn-sm btn-outline-secondary" @click="sweep.cancelSweep()">Cancel</button>
          </div>
          <div
            v-if="sweep.sweepError.value"
            class="alert alert-warning small py-1 px-2"
          >
            Measurement stopped: {{ sweep.sweepError.value.message || sweep.sweepError.value.code }}
          </div>
          <div
            v-if="sweep.sweepState.value === 'done' && sweep.sweepResult.value"
            class="alert alert-light border small py-2"
          >
            <template v-if="sweep.sweepResult.value.bandHz">
              <div class="d-flex justify-content-between">
                <span>Most boost in the BEQ band (15&ndash;40 Hz)</span>
                <strong class="vcal-figure">+{{ sweep.sweepResult.value.lowBandDemandDb?.toFixed(1) }} dB</strong>
              </div>
              <div class="text-muted text-right">
                at {{ sweep.sweepResult.value.peakFreqHz }} Hz on
                {{ spkName(sweep.sweepResult.value.peakOutputChannel) }}
              </div>
              <div
                v-if="skippedLabel"
                class="text-warning"
              >
                {{ skippedLabel }}
              </div>
              <div
                v-if="beqExtraDb != null"
                class="text-success"
              >
                &#10003;
                <template v-if="beqExtraDb === 0">
                  Your content measurement already provisions
                  {{ stagedDemand?.demandDb?.toFixed(1) }} dB, which covers this
                  band's boost plus the BEQ figure — nothing additional is
                  needed.
                </template>
                <template v-else>
                  Sizes the BEQ allowance: +{{ beqExtraDb.toFixed(1) }} dB on
                  top of your content measurement.
                </template>
              </div>
            </template>
            <template v-else>
              <div class="d-flex justify-content-between">
                <span>Most boost your chain adds</span>
                <strong class="vcal-figure">+{{ sweep.sweepResult.value.demandDb?.toFixed(1) }} dB</strong>
              </div>
              <div class="text-muted text-right">
                at {{ sweep.sweepResult.value.peakFreqHz }} Hz on
                {{ spkName(sweep.sweepResult.value.peakOutputChannel) }}
              </div>
              <div
                v-if="skippedLabel"
                class="text-warning"
              >
                {{ skippedLabel }}
              </div>
              <button
                v-if="stagedDemand?.source !== 'sweep'"
                class="btn btn-sm btn-primary mt-1"
                @click.stop="useSweepResult()"
              >
                Use this measurement
              </button>
              <span v-else class="badge badge-success mt-1">applied</span>
            </template>
          </div>
          <div class="text-right mt-2">
            <button
              class="btn btn-sm btn-primary"
              :disabled="beqNeedsSweep"
              @click.stop="openCard = 0"
            >
              Continue
            </button>
          </div>
        </template>
      </div>
    </div>

    <div
      v-if="stagedDemand"
      class="card"
      :class="pendingSteps.length ? '' : 'border-success'"
    >
      <div class="card-body py-2 px-3 small">
        <h6 class="mb-2">Headroom to provision</h6>
        <div class="d-flex justify-content-between">
          <span>Measured demand ({{ sourceLabel }})</span>
          <strong>{{ stagedDemand.demandDb.toFixed(1) }} dB</strong>
        </div>
        <div
          v-if="stagedBeqUser === true"
          class="d-flex justify-content-between"
        >
          <span>BEQ allowance (sized by your low-band sweep)</span>
          <strong v-if="beqExtraDb != null">+{{ beqExtraDb.toFixed(1) }} dB</strong>
          <span
            v-else
            class="text-warning"
          >pending sweep</span>
        </div>
        <hr class="my-1">
        <div class="d-flex justify-content-between">
          <span><strong>Provisioned headroom</strong></span>
          <strong v-if="effectiveDemandDb != null">{{ effectiveDemandDb.toFixed(1) }} dB</strong>
          <span
            v-else
            class="text-warning"
          >&mdash;</span>
        </div>
        <ul
          v-if="pendingSteps.length"
          class="text-warning mb-0 mt-2 pl-3"
        >
          <li
            v-for="p in pendingSteps"
            :key="p"
          >
            {{ p }}
          </li>
        </ul>
        <p class="text-muted mb-0 mt-2">
          No hidden margin; every number above is labeled. Results vary by
          Dirac slot; this measured the active one ({{ slotName }}). Measure
          your other slots later and the settings will cover the most
          demanding slot you've measured.
        </p>
      </div>
    </div>
  </div>
</template>

<script>
  import { ref, computed } from 'vue';

  import useVolumeCalibration from '~/use/useVolumeCalibration.js';
  import useMso from '@/use/useMso.js';
  import useSpeakerGroups from '@/use/useSpeakerGroups.js';
  import { headroomAt } from '~/calibration/gainModel.js';
  import { VU_VAL_TO_DBFS } from '@/calibration/vuDecode.js';
  import { buildToneSchedule, estimateDuration } from '~/calibration/toneSchedule.js';
  import { estimatePerToneMs, hasObservedPerToneMs } from '~/calibration/sweepEngine.js';
  import { BEQ_ALLOWANCE_DB, BEQ_WORST_CASE_DB, BEQ_BAND_HZ, BEQ_CATALOG_STATS } from '~/calibration/beq.js';
  import PeakSignalLevels from '@/components/PeakSignalLevels.vue';

  export default {
    name: 'WizardStepDemand',
    components: { PeakSignalLevels },
    setup() {
      const {
        stagedDemand, useSweepResult, setManualDemand, stageDemand, sweep,
        stagedBeqUser, stagedBeqWorstCase, effectiveDemandDb,
        beqNeedsSweep, beqLowBandDb, beqExtraDb,
        reusableMeasurement, useLastMeasurement,
      } = useVolumeCalibration();
      const { mso, vuPeakData } = useMso();
      const { spkName, getActiveChannels, reverseAllChannelCodes } = useSpeakerGroups();

      // Honest ETA from the engine's measured per-tone cost; subs are not
      // stimulus inputs so they don't count toward duration.
      const toneCount = buildToneSchedule().length;
      const lowToneCount = buildToneSchedule()
        .filter((f) => f >= BEQ_BAND_HZ.low && f <= BEQ_BAND_HZ.high).length;
      const channelCount = computed(() =>
        (getActiveChannels(mso.value?.speakers?.groups) ?? [])
          .filter((ch) => !ch.startsWith('sub')).length);
      function durationLabel(tc) {
        const secs = estimateDuration(tc, Math.max(1, channelCount.value), estimatePerToneMs());
        const mins = Math.max(1, Math.round(secs / 60));
        const label = `${mins} minute${mins === 1 ? '' : 's'}`;
        // Before a first completed sweep the constant is a conservative
        // ceiling, not a prediction; say so.
        return hasObservedPerToneMs() ? `about ${label}` : `up to about ${label}`;
      }
      const fullDurationLabel = computed(() => durationLabel(toneCount));
      const lowBandDurationLabel = computed(() => durationLabel(lowToneCount));
      const sweepDurationLabel = computed(() => {
        const l = fullDurationLabel.value;
        return l.charAt(0).toUpperCase() + l.slice(1);
      });

      // Which numbered card is expanded (1 content, 2 BEQ, 3 sweep, 0 none).
      // Entry resumes at the first incomplete step.
      const openCard = ref(
        stagedDemand.value == null ? 1
          : stagedBeqUser.value === null ? 2
            : beqNeedsSweep.value ? 3 : 0);
      const manualDemand = ref(12);

      // Highest hardware peak-hold reading across the active channels —
      // decoded the same way as the Peak Monitor table, so the figure the
      // user sees there is exactly the one adopted here.
      const observedPeakDbfs = computed(() => {
        const data = vuPeakData.value;
        if (!data || !data.length) return null;
        let max = null;
        for (const ch of (getActiveChannels(mso.value?.speakers?.groups) ?? [])) {
          const value = (data[reverseAllChannelCodes[ch]] || 0) & 0x3F;
          if (value > 0) {
            const dbfs = VU_VAL_TO_DBFS[value];
            if (max === null || dbfs > max) max = dbfs;
          }
        }
        return max;
      });

      const materialCaptured = computed(() => stagedDemand.value?.source === 'material');

      function chooseBeq(answer) {
        stagedBeqUser.value = answer;
      }

      const card1Complete = computed(() => stagedDemand.value != null);
      const card2Complete = computed(() => stagedBeqUser.value !== null);
      const card3Complete = computed(() =>
        reusedSweep.value
          || (stagedBeqUser.value === true
            ? beqLowBandDb.value != null
            : sweep.sweepState.value === 'done'));

      const demandBadgeLabel = computed(() => ({
        material: 'captured',
        previous: 'last measurement in use',
        manual: 'set manually',
        sweep: 'from sweep',
      }[stagedDemand.value?.source] ?? 'done'));

      function useManual() {
        if (setManualDemand(manualDemand.value)) openCard.value = 2;
      }

      // A prior sweep of this chain (this session's, persisted across
      // refresh, or reused via the record) — shown as the existing figure so
      // "measured" is never an unexplained pill, and the buttons become
      // Re-measure. Null while a just-finished sweep's own result box shows.
      const priorSweep = computed(() => {
        if (sweep.sweepState.value === 'done') return null;
        // Only trust the (possibly refresh-restored) engine result when the
        // validated low-band figure comes from it — beqLowBandDb re-checks
        // slot, fingerprint and chain signature.
        const r = sweep.sweepResult.value;
        if (r && r.lowBandDemandDb != null
            && beqLowBandDb.value === r.lowBandDemandDb) {
          return {
            lowBandDb: r.lowBandDemandDb,
            at: r.finishedAt ?? null,
            full: !r.bandHz,
            demandDb: r.demandDb ?? null,
          };
        }
        if (beqLowBandDb.value != null) {
          return {
            lowBandDb: beqLowBandDb.value,
            at: reusableMeasurement.value?.measuredAt ?? null,
            full: false,
            demandDb: null,
          };
        }
        return null;
      });

      const priorSweepDate = computed(() => {
        const at = priorSweep.value?.at;
        return at ? new Date(at).toLocaleDateString() : null;
      });

      // Why the Next button is disabled, stated as the work remaining.
      const pendingSteps = computed(() => {
        const p = [];
        if (stagedBeqUser.value === null) p.push('Answer the BEQ question (step 2)');
        else if (beqNeedsSweep.value) p.push('Run the BEQ band sweep (step 3) to size the BEQ allowance');
        return p;
      });

      const sourceLabel = computed(() => ({
        material: 'from your content',
        sweep: 'per-channel sweep',
        manual: 'entered manually',
        previous: 'from your last calibration',
      }[stagedDemand.value?.source] ?? ''));

      const reusedLast = computed(() => stagedDemand.value?.source === 'previous');

      const reusableDate = computed(() => {
        const at = reusableMeasurement.value?.measuredAt;
        return at ? new Date(at).toLocaleDateString() : 'a previous run';
      });

      // The reuse offer lives inside the card matching the method that
      // produced the stored measurement.
      const reuseSource = computed(() => reusableMeasurement.value?.source ?? null);
      const reusedMaterial = computed(() => reusedLast.value && reuseSource.value === 'material');
      const reusedSweep = computed(() => reusedLast.value && reuseSource.value === 'sweep');
      const offerReuseMaterial = computed(() =>
        !!reusableMeasurement.value && reuseSource.value === 'material'
          && !reusedLast.value && !materialCaptured.value);
      const offerReuseSweep = computed(() =>
        !!reusableMeasurement.value && reuseSource.value === 'sweep'
          && !reusedLast.value && stagedDemand.value?.source !== 'sweep');

      function reuseLast() {
        if (useLastMeasurement()) {
          openCard.value = stagedBeqUser.value === null ? 2 : 0;
        }
      }

      const sweepRunning = computed(() =>
        sweep.sweepState.value === 'running' || sweep.sweepState.value === 'preparing'
          || sweep.sweepState.value === 'restoring');

      const progress = computed(() => sweep.sweepProgress.value);

      const progressPercent = computed(() => {
        const p = progress.value;
        if (!p) return 0;
        const perChannel = 100 / p.channelCount;
        return Math.round(p.channelIndex * perChannel + (p.toneIndex / p.toneCount) * perChannel);
      });

      // Tones whose readings failed stimulus verification were skipped, not
      // trusted — say so, since the demand figure may miss boost there.
      const skippedLabel = computed(() => {
        const s = sweep.sweepResult.value?.skippedTones ?? [];
        if (!s.length) return '';
        const shown = s.slice(0, 3)
          .map((x) => `${x.freqHz} Hz on ${spkName(x.inputChannel)}`).join(', ');
        const more = s.length > 3 ? ` and ${s.length - 3} more` : '';
        return `${s.length === 1 ? '1 tone' : `${s.length} tones`} could not be `
          + `verified, even after automatic retries, and did not count: ${shown}${more}. `
          + 'The measured figure may miss boost there; running the sweep '
          + 'again usually recovers them.';
      });

      const slotName = computed(() => {
        const i = mso.value?.cal?.currentdiracslot;
        return mso.value?.cal?.slots?.[i]?.name ?? `Slot ${(i ?? 0) + 1}`;
      });

      // Material-based arithmetic (handoff §5 step 2 / 06 §Q2): the meter
      // reads after the digital volume, so add back min(H, 1 - MV) at
      // measurement time.
      const availableHeadroomNow = computed(() =>
        headroomAt(mso.value?.cal?.headroom ?? 12, mso.value?.volume ?? 0));

      const materialError = ref(null);

      function useMaterialPeak() {
        materialError.value = null;
        const peak = observedPeakDbfs.value;
        if (!Number.isFinite(peak)) {
          materialError.value = 'No peaks recorded yet — play some content with Peak Monitoring on.';
          return;
        }
        // At the meter's +6 dBFS ceiling the reading is only a lower bound —
        // the real demand may be higher, so it must not become a calibration.
        if (peak >= 6) {
          materialError.value = 'The meter saturates at +6 dBFS, so this reading is only a lower bound; the real peak may be higher. Lower the volume and re-play, or use the sweep, which has no such limit.';
          return;
        }
        if (stageDemand(availableHeadroomNow.value + peak, 'material', {
          peakDbfs: peak,
          headroomAtCapture: availableHeadroomNow.value,
        })) {
          // Capture done: collapse to the captured summary, open step 2.
          openCard.value = 2;
        } else {
          materialError.value = 'That works out to a headroom outside the settable 1–30 dB range; check the reading.';
        }
      }

      return {
        stagedDemand, useSweepResult, setManualDemand, sweep,
        openCard, manualDemand, useManual, observedPeakDbfs,
        card1Complete, card2Complete, card3Complete, demandBadgeLabel,
        priorSweep, priorSweepDate,
        sweepRunning, progress, progressPercent, slotName, skippedLabel,
        materialCaptured, chooseBeq, pendingSteps,
        reusableMeasurement, reusedLast, reusableDate, reuseLast,
        reusedMaterial, reusedSweep, offerReuseMaterial, offerReuseSweep,
        availableHeadroomNow, useMaterialPeak, materialError, spkName,
        channelCount, sweepDurationLabel, fullDurationLabel, lowBandDurationLabel,
        BEQ_BAND_HZ,
        stagedBeqUser, stagedBeqWorstCase, effectiveDemandDb, sourceLabel,
        beqNeedsSweep, beqLowBandDb, beqExtraDb,
        BEQ_ALLOWANCE_DB, BEQ_WORST_CASE_DB,
        beqEntries: BEQ_CATALOG_STATS.entries,
      };
    }
  }
</script>

<style scoped>
  .vcal-card {
    cursor: pointer;
  }
  .vcal-captured {
    border-color: #28a745;
    background-color: rgba(40, 167, 69, 0.07);
  }
</style>
