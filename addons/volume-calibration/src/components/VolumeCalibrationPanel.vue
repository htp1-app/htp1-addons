<template>
  <div class="vcal-panel card mb-3" :class="{ 'bg-dark': darkMode }">
    <div class="card-body py-2 px-3">
      <div class="d-flex justify-content-between align-items-center mb-1">
        <h6 class="mb-0">Volume calibration</h6>
        <span class="badge" :class="badgeClass">{{ badgeLabel }}</span>
      </div>

      <!-- state 1: never calibrated -->
      <template v-if="panelStateName === 'neverCalibrated'">
        <p class="small mb-2">
          These are {{ factoryDefaults ? 'factory defaults' : 'your current settings' }}.
          Calibration works out what your amplifier and your Dirac filter actually
          need, and explains what 0&nbsp;dB means on your scale.
        </p>
        <div class="row small mb-2">
          <div class="col-auto">
            <div class="text-muted">Headroom at top of scale</div>
            <div class="vcal-figure">{{ fmt1(diagnosis.headroomAtTop) }} dB</div>
          </div>
          <div class="col-auto">
            <div class="text-muted">0 dB means</div>
            <div class="vcal-figure">{{ zeroDbMeaning }}</div>
          </div>
          <div class="col-auto">
            <div class="text-muted">Top of scale</div>
            <div class="vcal-figure">{{ fmt1(diagnosis.topOfScaleDisplayed) }} dB</div>
          </div>
        </div>
        <router-link
          class="btn btn-sm btn-primary mb-2"
          to="/wizard"
        >
          Run calibration
        </router-link>
        <p
          v-if="diagnosis.headroomAtTop <= 1"
          class="small text-muted mb-1"
        >
          1 dB is all the headroom there is at the very top of the scale; that's
          by design, and fine at normal listening levels where headroom is
          plentiful. Calibration tells you whether your material actually needs
          more, and what it would cost.
        </p>
      </template>

      <!-- state 2: in sync -->
      <template v-else-if="panelStateName === 'inSync'">
        <div class="row small mb-2">
          <div class="col-auto">
            <div class="text-muted">Calibrated</div>
            <div class="vcal-figure">{{ calibratedDate }}</div>
          </div>
          <div class="col-auto">
            <div class="text-muted">Dirac slot measured</div>
            <div class="vcal-figure">{{ ceilingSlotName }}</div>
          </div>
          <div class="col-auto">
            <div class="text-muted">Headroom right now</div>
            <div class="vcal-figure text-success">{{ fmt1(record.written?.headroom) }} dB</div>
          </div>
          <div class="col-auto">
            <div class="text-muted">0 dB means</div>
            <div class="vcal-figure">{{ zeroDbMeaning }}</div>
          </div>
          <div class="col-auto">
            <div class="text-muted">Top of scale</div>
            <div class="vcal-figure">{{ fmt1(diagnosis.topOfScaleDisplayed) }} dB</div>
          </div>
        </div>
        <div
          v-if="headroomCutAtTop > 0.05"
          class="alert alert-info small py-2 mb-2"
        >
          Your volume limit lets the scale run past the loudest clean volume:
          above {{ fmt1(cleanTopDisplayed) }} dB on the dial, you are exceeding
          the maximum headroom available on your system and may run into
          clipping with loud content.
        </div>
        <p
          v-if="currentCoverage?.demandBasis === 'estimate'"
          class="small text-muted mb-2"
        >
          {{ currentSlotName }}'s {{ fmt1(currentCoverage.demand) }} dB figure
          is an estimate: its sweep found
          {{ fmt1(currentCoverage.estimate?.sweepDb) }} dB, plus the
          {{ fmt1(currentCoverage.estimate?.overheadDb) }} dB content overhead
          measured on {{ currentCoverage.estimate?.fromLabel }}. To confirm it,
          measure with demanding content in the calibration wizard.
        </p>
        <p
          v-else-if="currentCoverage?.demandBasis === 'sweepFloor'"
          class="small text-muted mb-2"
        >
          {{ currentSlotName }}'s figure comes from a channel sweep only, which
          real content usually exceeds. Treat it as a floor and measure with
          demanding content in the calibration wizard for the real number.
        </p>
        <div
          v-if="underProvisioned"
          class="alert alert-warning small py-1 px-2 mb-2"
        >
          A measured slot now demands {{ fmt1(demandCeiling) }} dB, more than the
          {{ fmt1(record.written?.headroom) }} dB this calibration provisioned.
          <button class="btn btn-sm btn-primary ml-1" @click="recalculate()">Recalculate</button>
        </div>
        <router-link
          class="btn btn-sm btn-outline-secondary mb-1"
          to="/wizard"
        >
          Re-run calibration
        </router-link>
      </template>

      <!-- state 3: settings changed -->
      <template v-else-if="panelStateName === 'settingsChanged'">
        <p class="small mb-2">
          You changed
          <strong>{{ driftFieldNames }}</strong>
          since calibration. The other values no longer match what calibration derived.
        </p>
        <table class="table table-sm small mb-2 vcal-table">
          <thead>
            <tr>
              <th>Field</th>
              <th class="text-right">Now</th>
              <th class="text-right">Should be</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in drift.diffs" :key="d.path">
              <td>{{ d.field }}</td>
              <td class="text-right">{{ d.now }}</td>
              <td class="text-right">{{ d.expected }}</td>
            </tr>
          </tbody>
        </table>
        <div
          v-if="recalculatePreview && !recalculatePreview.feasible"
          class="small text-muted mb-2"
        >
          Reference output voltage is already at the 4&nbsp;V ceiling, so
          {{ fmt1(demandCeiling) }} dB isn't reachable. Recalculating caps headroom
          at {{ fmt1(recalculatePreview.hMax) }} dB and leaves the rest as calibrated.
        </div>
        <button class="btn btn-sm btn-primary mr-2" @click="recalculate()">Recalculate</button>
        <button class="btn btn-sm btn-outline-secondary" @click="keepMyChanges()">Keep my changes</button>
        <div
          v-if="alsoStale"
          class="small text-muted mt-2"
        >
          Also: the {{ currentSlotName }} filter changed since it was measured.
        </div>
      </template>

      <!-- state 4: slot not measured -->
      <template v-else-if="panelStateName === 'slotNotMeasured'">
        <p class="small mb-2">
          Your settings are provisioned for {{ ceilingSlotName }}, the most
          demanding slot measured so far. {{ currentSlotName }} hasn't been
          measured and may need more than it's getting.
        </p>
        <table class="table table-sm small mb-2 vcal-table">
          <tbody>
            <tr v-for="s in visibleSlotCoverage" :key="s.slotId">
              <td class="text-muted">Slot {{ s.slotId + 1 }}</td>
              <td>{{ s.name }}</td>
              <td class="text-right">{{ demandLabel(s) }}</td>
              <td class="text-right">
                <span v-if="s.setsCeiling" class="text-primary">sets the ceiling</span>
                <span v-else-if="s.freshness === 'fresh' && s.demandBasis === 'estimate'" class="text-warning">estimated</span>
                <span v-else-if="s.freshness === 'fresh' && s.demandBasis === 'sweepFloor'" class="text-warning">sweep floor</span>
                <span v-else-if="s.freshness === 'fresh'" class="text-muted">measured</span>
                <span v-else-if="s.freshness === 'stale'" class="text-danger">out of date</span>
                <span v-else-if="s.freshness === 'unmeasured'" class="text-danger">not measured</span>
              </td>
            </tr>
          </tbody>
        </table>
        <button
          v-if="!measuring"
          class="btn btn-sm btn-primary mr-2"
          @click="measureCurrent"
        >
          Measure {{ currentSlotName }} · {{ sweepMinutes }}, quiet
        </button>
        <template v-else>
          <span class="small mr-2">{{ sweepProgressLabel }}</span>
          <button class="btn btn-sm btn-outline-secondary mr-2" @click="cancelMeasure">Cancel</button>
        </template>
        <button class="btn btn-sm btn-outline-secondary" :disabled="measuring" @click="dismissUnmeasured()">Dismiss</button>
        <div
          v-if="measureError"
          class="alert alert-danger small py-1 px-2 mt-2 mb-1"
        >
          Measurement stopped and nothing was saved. {{ measureError }}
        </div>
        <p class="small text-muted mt-1 mb-1">
          Playback pauses briefly during the measurement.
        </p>
        <p
          v-if="contentOverheadDb"
          class="small text-muted mb-1"
        >
          How the result is calculated: the sweep only sees each channel's own
          boost, while real content usually demands more because bass from many
          channels sums into the subwoofers at once. On
          {{ contentOverheadDb.fromLabel }}, content needed
          {{ fmt1(contentOverheadDb.overheadDb) }} dB more than its sweep
          found, so this slot's result is reported as its sweep plus that same
          {{ fmt1(contentOverheadDb.overheadDb) }} dB and marked as an
          estimate. Playing demanding content with this slot active, via the
          calibration wizard, is still the definitive check.
        </p>
        <p
          v-else
          class="small text-muted mb-1"
        >
          The sweep only sees each channel's own boost, not the bass from many
          channels summing at once, so its figure is recorded as a floor
          rather than the answer. For the real number, run the calibration
          wizard and measure with demanding content while this slot is active.
        </p>
        <div
          v-if="coverageRegime === 'coupled'"
          class="alert alert-info small py-1 px-2 mt-1 mb-1"
        >
          Slots needing less than the ceiling are covered automatically at no
          cost: every setting delivers the same voltage at maximum volume, so a
          gentler filter simply ends up with more margin than it needs. Only a
          slot needing more than {{ fmt1(demandCeiling) }} dB would change anything.
        </div>
        <div
          v-else-if="coverageRegime === 'loudnessTraded'"
          class="alert alert-info small py-1 px-2 mt-1 mb-1"
        >
          Slots needing less than the ceiling stay safe, but not for free here:
          this calibration keeps the full {{ fmt1(demandCeiling) }} dB of
          headroom by lowering the maximum volume, so with a gentler filter
          loaded the top of the scale sits lower than that filter alone would
          need. That is the price of one shared setting provisioned for the
          most demanding filter. Measuring another slot only changes the
          settings if it needs more than {{ fmt1(demandCeiling) }} dB.
        </div>
        <div
          v-else
          class="alert alert-info small py-1 px-2 mt-1 mb-1"
        >
          Your current calibration lets the scale reach {{ capTargetLabel }}
          even though the full {{ fmt1(demandCeiling) }} dB of headroom cannot
          be preserved there. Near the top, the most demanding filter can run
          short of headroom; that is the trade your calibration chose. A
          gentler filter needs less, so it simply runs safer in that region.
          Measuring another slot only changes the settings if it needs more
          than {{ fmt1(demandCeiling) }} dB.
        </div>
        <p
          v-if="record?.anchor === 'cleanCeiling'"
          class="small text-muted mt-1 mb-1"
        >
          0 dB marks the loudest clean level as measured at calibration time.
          A gentler filter may play cleanly above that point; re-run
          calibration with it active if you want the scale to reflect that.
        </p>
      </template>

      <!-- state 5: measurement out of date (informational — nothing auto-written) -->
      <template v-else-if="panelStateName === 'filterReplaced'">
        <p
          v-if="currentStaleReason === 'chain'"
          class="small mb-2"
        >
          Your processing settings (PEQ, crossovers, tone controls, or channel
          trims) changed since {{ currentSlotName }} was measured, so the
          measurement may no longer cover what the chain adds.
        </p>
        <p
          v-else
          class="small mb-2"
        >
          The filter in {{ currentSlotName }} was replaced. Your headroom was
          measured against the previous one, so it may no longer cover this
          filter's boost.
        </p>
        <div class="row small mb-2">
          <div class="col-auto">
            <div class="text-muted">Measured against</div>
            <div class="vcal-figure">{{ currentSlotName }} · {{ measuredAgainstDate }}</div>
          </div>
          <div class="col-auto">
            <div class="text-muted">Currently active</div>
            <div class="vcal-figure text-danger">
              {{ currentStaleReason === 'chain' ? 'changed processing settings' : 'a different filter' }}
            </div>
          </div>
        </div>
        <button
          v-if="!measuring"
          class="btn btn-sm btn-primary mr-2"
          @click="measureCurrent"
        >
          Re-measure headroom · {{ sweepMinutes }}
        </button>
        <template v-else>
          <span class="small mr-2">{{ sweepProgressLabel }}</span>
          <button class="btn btn-sm btn-outline-secondary mr-2" @click="cancelMeasure">Cancel</button>
        </template>
        <button class="btn btn-sm btn-outline-secondary" :disabled="measuring" @click="dismissStale()">Dismiss</button>
        <div
          v-if="measureError"
          class="alert alert-danger small py-1 px-2 mt-2 mb-1"
        >
          Measurement stopped and nothing was saved. {{ measureError }}
        </div>
        <div class="alert alert-info small py-1 px-2 mt-2 mb-1">
          Nothing has been changed automatically; your settings are exactly as
          calibrated. If the new filter boosts more than the
          {{ fmt1(record.written?.headroom) }} dB you're provisioned for, the top
          of the scale can clip until you re-measure.
        </div>
      </template>
    </div>
  </div>
</template>

<script>
  import { computed, ref, onDeactivated, onBeforeUnmount } from 'vue';

  import useVolumeCalibration from '~/use/useVolumeCalibration.js';
  import useMso from '@/use/useMso.js';
  import useLocalStorage from '@/use/useLocalStorage.js';
  import useSpeakerGroups from '@/use/useSpeakerGroups.js';
  import { buildToneSchedule, estimateDuration } from '~/calibration/toneSchedule.js';
  import { estimatePerToneMs, hasObservedPerToneMs } from '~/calibration/sweepEngine.js';
  import { solve, solvePreservingHeadroom } from '~/calibration/gainModel.js';
  import { PANEL_BADGE_LABELS, panelBadgeClass } from './panelBadges.js';

  export default {
    name: 'VolumeCalibrationPanel',
    setup() {
      const vcal = useVolumeCalibration();
      const { mso } = useMso();
      const { darkMode } = useLocalStorage();

      const {
        panelStateName, diagnosis, record, drift, demandCeiling, slotCoverage,
        recalculatePreview, recalculate, keepMyChanges, dismissStale,
        dismissUnmeasured, measureSlot, underProvisioned, currentStaleReason, sweep,
        contentOverheadDb,
      } = vcal;

      const factoryDefaults = computed(() => {
        const c = mso.value?.cal;
        return c?.ampsense === 1.6 && c?.headroom === 12 && c?.vph === 0 && !c?.zeroPoint;
      });

      const badgeLabel = computed(() => PANEL_BADGE_LABELS[panelStateName.value]);
      const badgeClass = computed(() => panelBadgeClass(panelStateName.value));

      const zeroDbMeaning = computed(() => {
        if (record.value?.calibratedAt && record.value.anchor === 'reference' && !drift.value) {
          return 'reference level';
        }
        if (record.value?.calibratedAt && record.value.anchor === 'cleanCeiling' && !drift.value) {
          return 'loudest clean level';
        }
        return diagnosis.value.zeroPointActive
          ? `shifted ${fmt1(-diagnosis.value.zeroDbInternal)} dB`
          : 'amplifier clipping';
      });

      const calibratedDate = computed(() =>
        (record.value?.calibratedAt ? new Date(record.value.calibratedAt).toLocaleDateString() : ''));

      const currentSlotName = computed(() => {
        const i = mso.value?.cal?.currentdiracslot;
        return mso.value?.cal?.slots?.[i]?.name ?? `Slot ${(i ?? 0) + 1}`;
      });

      // Live slot name first; the label recorded at measurement time covers
      // slots the device currently reports blank.
      const ceilingSlotName = computed(() => {
        const covered = slotCoverage.value.find((s) => s.setsCeiling);
        if (!covered) return 'the measured slots';
        const recorded = (record.value?.slots ?? [])
          .find((s) => s.slotId === covered.slotId);
        return covered.name || recorded?.label || `Slot ${covered.slotId + 1}`;
      });

      // How much of the provisioned headroom the volume limit gives up at the
      // very top of the scale (0 when the limit stops at the clean maximum),
      // and where that clean maximum sits on the dial.
      const headroomCutAtTop = computed(() =>
        (record.value?.written?.headroom ?? 0) - (diagnosis.value?.headroomAtTop ?? 0));
      const cleanTopDisplayed = computed(() =>
        1 - (mso.value?.cal?.headroom ?? 0) - (mso.value?.cal?.zeroPoint ?? 0));

      // Whether "gentler slots are covered at no cost" is actually true.
      // 'coupled': output voltage below its ceiling, so the cap delivers the
      // same voltage for any demand and the claim holds. 'loudnessTraded':
      // headroom was preserved by lowering the cap, so gentler slots inherit
      // a lower top of scale than they alone would need. 'topShort': the cap
      // was allowed past the headroom-preserving point (to reference or amp
      // full power), so the ceiling filter runs short near the top instead.
      const coverageRegime = computed(() => {
        const r = record.value;
        if (!r?.written || !r.vTarget) return 'coupled';
        const need = demandCeiling.value + (r.beqAllowanceDb ?? 0);
        if (r.capTarget === 'headroom') {
          const p = solvePreservingHeadroom({
            ampSensitivity: r.vTarget, requiredHeadroom: need,
          });
          return p.deliveredShortDb > 0.05 ? 'loudnessTraded' : 'coupled';
        }
        const target = r.capTarget === 'reference' && r.vRef ? r.vRef : r.vTarget;
        const sol = solve({ ampSensitivity: target, requiredHeadroom: need });
        return sol.feasible ? 'coupled' : 'topShort';
      });

      const capTargetLabel = computed(() => (
        record.value?.capTarget === 'reference'
          ? 'reference level'
          : "the amplifier's full power"));

      const measuredAgainstDate = computed(() => {
        const i = mso.value?.cal?.currentdiracslot;
        const entry = (record.value?.slots ?? []).find((s) => s.slotId === i);
        return entry?.measuredAt ? new Date(entry.measuredAt).toLocaleDateString() : '';
      });

      const driftFieldNames = computed(() =>
        (drift.value?.diffs ?? []).map((d) => d.field).join(', '));

      const alsoStale = computed(() =>
        panelStateName.value === 'settingsChanged'
          && vcal.currentSlotFreshness.value === 'stale');

      // hide empty slots from the coverage table
      const visibleSlotCoverage = computed(() =>
        slotCoverage.value.filter((s) => s.freshness !== 'empty'));

      const currentCoverage = computed(() =>
        slotCoverage.value.find((s) => s.slotId === mso.value?.cal?.currentdiracslot) ?? null);

      function demandLabel(s) {
        if (s.demand == null) return '—';
        const v = `${fmt1(s.demand)} dB`;
        if (s.demandBasis === 'estimate') return `~${v}`;
        if (s.demandBasis === 'sweepFloor') return `≥ ${v}`;
        return v;
      }

      const measuring = computed(() =>
        sweep.sweepState.value === 'running' || sweep.sweepState.value === 'preparing'
          || sweep.sweepState.value === 'restoring');

      const sweepProgressLabel = computed(() => {
        const p = sweep.sweepProgress.value;
        if (!p) return 'Measuring…';
        return `Measuring ${p.inputChannel} · ${p.toneIndex + 1}/${p.toneCount}`;
      });

      const { getActiveChannels } = useSpeakerGroups();
      const sweepMinutes = computed(() => {
        const channels = (getActiveChannels(mso.value?.speakers?.groups) ?? [])
          .filter((ch) => !ch.startsWith('sub')).length;
        const secs = estimateDuration(buildToneSchedule().length, Math.max(1, channels), estimatePerToneMs());
        const mins = Math.max(1, Math.round(secs / 60));
        return hasObservedPerToneMs() ? `~${mins} min` : `up to ~${mins} min`;
      });

      // Track sweeps this panel started, so navigating away (the settings
      // router-view is kept alive) never leaves the generator running.
      const panelStartedSweep = ref(false);
      const measureError = ref(null);

      async function measureCurrent() {
        panelStartedSweep.value = true;
        measureError.value = null;
        try {
          const ok = await measureSlot(mso.value?.cal?.currentdiracslot);
          if (!ok) {
            const e = sweep.sweepError.value;
            measureError.value = e
              ? (e.message || e.code)
              : 'The active slot changed during the measurement.';
          }
        } finally {
          panelStartedSweep.value = false;
        }
      }

      function cancelMeasure() {
        sweep.cancelSweep();
      }

      function cancelIfOurs() {
        if (panelStartedSweep.value) sweep.cancelSweep();
      }
      onDeactivated(cancelIfOurs);
      onBeforeUnmount(cancelIfOurs);

      function fmt1(v) {
        return (v == null || Number.isNaN(v)) ? '—' : Number(v).toFixed(1);
      }

      return {
        panelStateName, diagnosis, record, drift, demandCeiling,
        recalculatePreview, recalculate, keepMyChanges, dismissStale,
        dismissUnmeasured, underProvisioned, currentStaleReason,
        darkMode, factoryDefaults, badgeLabel, badgeClass, zeroDbMeaning,
        calibratedDate, currentSlotName, ceilingSlotName,
        headroomCutAtTop, cleanTopDisplayed,
        measuredAgainstDate, driftFieldNames, alsoStale, visibleSlotCoverage,
        coverageRegime, capTargetLabel, contentOverheadDb, currentCoverage, demandLabel,
        measuring, sweepProgressLabel, sweepMinutes, measureCurrent, cancelMeasure,
        measureError, fmt1,
      };
    }
  }
</script>

<style scoped>
  .vcal-panel {
    width: 100%;
  }
  .vcal-figure {
    font-weight: bold;
  }
  .vcal-table {
    max-width: 30rem;
  }
</style>
