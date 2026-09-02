<template>
  <div>
    <!-- path A: measured reference, three diagnostic cases -->
    <template v-if="wizardPath === 'A' && referenceDiagnostic">
      <h5 class="mt-2">{{ headline }}</h5>
      <p class="small text-muted">
        0&nbsp;dB now means THX reference level, measured.
        <template v-if="referenceDiagnostic.kind === 'short'">
          The scale stops {{ referenceDiagnostic.shortfallDb.toFixed(1) }} dB below it.
        </template>
        <template v-else-if="referenceDiagnostic.kind === 'exceeds'">
          The scale continues {{ referenceDiagnostic.spareDb.toFixed(1) }} dB above it.
        </template>
      </p>

      <div class="row small mb-2">
        <div
          v-if="referenceDiagnostic.kind === 'short'"
          class="col-auto"
        >
          <div class="text-muted">Short of reference by</div>
          <div class="vcal-figure text-danger">{{ referenceDiagnostic.shortfallDb.toFixed(1) }} dB</div>
        </div>
        <div
          v-if="referenceDiagnostic.kind === 'exceeds'"
          class="col-auto"
        >
          <div class="text-muted">Usable range above reference</div>
          <div class="vcal-figure text-success">{{ referenceDiagnostic.spareDb.toFixed(1) }} dB</div>
        </div>
        <div class="col-auto">
          <div class="text-muted">Peak level at your seat</div>
          <div class="vcal-figure">{{ peakSplAtSeat.toFixed(1) }} dB</div>
        </div>
      </div>

      <div
        v-if="referenceDiagnostic.kind === 'short'"
        class="alert alert-warning small py-2"
      >
        Your amplifier reaches full power before the room reaches reference
        level, so the volume control stops
        {{ referenceDiagnostic.shortfallDb.toFixed(1) }} dB short and can't be
        raised past that point at these settings. More amplifier power or more
        sensitive speakers would close the gap; no processor setting can. Most
        listening happens 10 to 20 dB below reference anyway.
      </div>
      <div
        v-else-if="referenceDiagnostic.kind === 'exceeds'"
        class="alert alert-light border small py-2"
      >
        A system with power to spare gets range above 0&nbsp;dB and the extra
        range stays usable. A matched system lands exactly at 0.0.
      </div>
      <div
        v-else
        class="alert alert-success small py-2"
      >
        Reference level and the loudest clean level coincide: maximum volume
        displays as exactly 0.0&nbsp;dB.
      </div>

    </template>

    <!-- path B: derived clean-ceiling anchor -->
    <template v-else>
      <h5 class="mt-2">0 dB is now the loudest your system plays cleanly</h5>
      <p class="small text-muted">
        The scale ends there. Every level on it keeps all
        {{ stagedSettings?.headroom?.toFixed(1) }} dB of your headroom.
      </p>

      <div class="row small mb-2">
        <div class="col-auto">
          <div class="text-muted">0 dB equals</div>
          <div class="vcal-figure">{{ stagedSettings?.maxVolume?.toFixed(1) }} dB internal</div>
        </div>
        <div class="col-auto">
          <div class="text-muted">Headroom preserved</div>
          <div class="vcal-figure text-success">{{ stagedSettings?.headroom?.toFixed(1) }} dB</div>
        </div>
      </div>

      <div class="alert alert-warning small py-2">
        This anchor is a consequence of your headroom setting, not a fact about
        the room. Change headroom later and 0&nbsp;dB moves; Volume Setup will
        flag it when it does. It also says nothing about loudness in dB SPL.
        Measure reference if you want that.
      </div>
    </template>

    <!-- loudness-vs-headroom trade: every conceded dB of top loudness buys
         one dB of headroom ceiling; offered whenever a haircut was taken -->
    <template v-if="headroomTradeOptions">
      <h6 class="mt-3">What should the top of the scale deliver?</h6>
      <p class="small text-muted">
        Your measured demand exceeds what the amplifier's full output leaves
        room for. Giving up loudness at the very top of the scale buys back
        headroom, dB for dB.
      </p>
      <div
        v-for="opt in headroomTradeOptions.options"
        :key="opt.key"
        class="card mb-2 vcal-card"
        :class="{ 'border-primary': stagedHeadroomPriority === opt.key }"
        role="button"
        @click="stagedHeadroomPriority = opt.key"
      >
        <div class="card-body py-2 px-3 d-flex justify-content-between">
          <div>
            <strong>{{ TRADE_LABELS[opt.key].title }}</strong>
            <div class="small text-muted">{{ TRADE_LABELS[opt.key].blurb }}</div>
          </div>
          <div class="text-right">
            <div class="vcal-figure">{{ opt.headroom.toFixed(1) }} dB headroom</div>
            <div class="small text-muted">
              <template v-if="opt.loudnessGivenUpDb > 0.05">
                top of scale {{ opt.loudnessGivenUpDb.toFixed(1) }} dB below amp full power
              </template>
              <template v-else>
                amp full power at the top
              </template>
            </div>
          </div>
        </div>
      </div>
      <p class="small text-muted">
        Nothing is enforced; the cap is an ordinary setting you can raise
        later, at the cost of the regained headroom. The diagnostic above
        updates as you choose.
      </p>
    </template>

    <!-- operating point: auto-picked (highest reserve), offered as an
         override rather than a required step -->
    <template v-if="showVoltageChoice">
      <p class="small text-muted mt-3 mb-2">
        Reference Output Voltage is set to
        <strong>{{ effectiveVoltageChoice.toFixed(2) }} V</strong>, the
        operating point with the most reserve for your measured boost. Every
        choice here plays equally loud at the top of the scale; lower settings
        trade reserve for the analog stage's measured character at each
        voltage, far below audible.
        <a
          href="#"
          @click.prevent="voltageChoiceOpen = !voltageChoiceOpen"
        >{{ voltageChoiceOpen ? 'Hide options' : 'Change' }}</a>
      </p>
      <template v-if="voltageChoiceOpen">
        <div
          v-for="card in voltageCards"
          :key="card.outputVoltage"
          class="card mb-2 vcal-card"
          :class="{ 'border-primary': effectiveVoltageChoice === card.outputVoltage }"
          role="button"
          @click="stagedVoltageChoice = card.outputVoltage"
        >
          <div class="card-body py-2 px-3 d-flex justify-content-between">
            <div>
              <strong>{{ card.title }}</strong>
              <span
                v-if="card.badge"
                class="badge badge-light border ml-1"
              >{{ card.badge }}</span>
              <div class="small text-muted">{{ card.blurb }}</div>
            </div>
            <div class="text-right">
              <div class="vcal-figure">{{ card.headroom.toFixed(1) }} dB headroom</div>
              <div class="small text-muted">
                Reference Output Voltage {{ card.outputVoltage.toFixed(2) }} V ·
                cap {{ card.maxVolume.toFixed(1) }} dB
              </div>
            </div>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<script>
  import { computed, ref } from 'vue';

  import useVolumeCalibration from '~/use/useVolumeCalibration.js';

  export default {
    name: 'WizardStepResult',
    setup() {
      const {
        wizardPath, referenceDiagnostic, stagedSettings,
        headroomTradeOptions, stagedHeadroomPriority,
        demandExceedsFree, operatingPointCards, effectiveVoltageChoice,
        stagedVoltageChoice,
      } = useVolumeCalibration();

      const TRADE_LABELS = {
        loudness: {
          title: 'Loudest',
          blurb: 'Amp reaches full power at the top; headroom takes the haircut',
        },
        reference: {
          title: 'Cap at reference',
          blurb: 'The scale tops out at measured reference; the spare range above it becomes headroom',
        },
        headroom: {
          title: 'Preserve all measured headroom',
          blurb: 'Every measured dB survives; the top of the scale lands wherever that requires, even below reference',
        },
      };

      const headline = computed(() => {
        const d = referenceDiagnostic.value;
        if (!d) return '';
        if (d.kind === 'short') {
          return `Your system falls ${d.shortfallDb.toFixed(1)} dB short of reference`;
        }
        if (d.kind === 'exceeds') {
          return 'Your system plays beyond reference level';
        }
        return 'Your system reaches reference level exactly';
      });

      // Reference peaks are 105 dB SPL by convention; the achievable peak is
      // reference minus any shortfall.
      const peakSplAtSeat = computed(() =>
        105 - (referenceDiagnostic.value?.shortfallDb ?? 0));

      // The operating point only feeds the written settings on the loudness
      // branch, and there's nothing to choose with a single card.
      const voltageChoiceOpen = ref(false);
      const showVoltageChoice = computed(() =>
        demandExceedsFree.value
          && stagedHeadroomPriority.value === 'loudness'
          && operatingPointCards.value.length > 1);

      const CARD_META = [
        { title: 'Most boost survives', blurb: (h) => `Bass boost up to ${h} dB passes cleanly, even at the top of the scale` },
        { title: 'Balanced', blurb: (h) => `Boost beyond ${h} dB clips only near the very top of the scale` },
        { title: 'Least reserve', badge: 'least distortion', blurb: (h) => `Boost beyond ${h} dB clips at high volume. Fine if you rarely play loud` },
      ];

      const voltageCards = computed(() =>
        operatingPointCards.value.map((p, i) => ({
          ...p,
          title: CARD_META[i]?.title ?? `${p.outputVoltage} V`,
          badge: CARD_META[i]?.badge,
          blurb: CARD_META[i]?.blurb ? CARD_META[i].blurb(p.headroom.toFixed(1)) : '',
        })));

      return {
        wizardPath, referenceDiagnostic, stagedSettings, headline, peakSplAtSeat,
        headroomTradeOptions, stagedHeadroomPriority, TRADE_LABELS,
        showVoltageChoice, voltageChoiceOpen, voltageCards,
        effectiveVoltageChoice, stagedVoltageChoice,
      };
    }
  }
</script>

<style scoped>
  .vcal-figure {
    font-weight: bold;
  }
  .vcal-card {
    cursor: pointer;
  }
</style>
