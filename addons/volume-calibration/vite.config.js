import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';

// '@' is the controller's source, installed as a dependency, so the wizard uses the same
// MSO connection, speaker groups and styling as the main UI. '~' is this addon's source.
const aliases = {
  '@': fileURLToPath(new URL('./node_modules/htp1-custom-controller/src', import.meta.url)),
  '~': fileURLToPath(new URL('./src', import.meta.url)),
};

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  if (command === 'serve' && !env.HTP1_HOST) {
    throw new Error('HTP1_HOST is not set; the dev server needs an HTP-1 to talk to, e.g. HTP1_HOST=192.168.1.13');
  }
  return {
    base: './',
    plugins: [vue()],
    resolve: { alias: aliases, dedupe: ['vue', 'vue-router'] },
    build: { outDir: 'www', emptyOutDir: true },
    server: {
      proxy: Object.fromEntries(['/ws/controller', '/config.json', '/webapi'].map((path) => [
        path, { target: `http://${env.HTP1_HOST}`, changeOrigin: true, ws: path.startsWith('/ws/') },
      ])),
    },
  };
});
