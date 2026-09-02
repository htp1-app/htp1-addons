<template>
  <div class="py-3">
    <router-view v-if="mso.cal" />
    <div
      v-else
      class="container text-center py-5"
    >
      <div
        class="spinner-border text-primary"
        role="status"
      />
      <p class="mt-3 text-muted">
        Connecting to the HTP-1…
      </p>
    </div>
  </div>
</template>

<script>
  import { watchEffect } from 'vue';
  import useMso from '@/use/useMso.js';
  import useLocalStorage from '@/use/useLocalStorage.js';

  export default {
    name: 'App',
    setup() {
      const { mso } = useMso();
      const { darkMode } = useLocalStorage();

      // Same theme attribute and storage key as the main UI, so the choice made there applies here.
      watchEffect(() => {
        document.documentElement.setAttribute('data-theme', darkMode.value ? 'darkMode' : '');
      });

      return { mso };
    },
  };
</script>
