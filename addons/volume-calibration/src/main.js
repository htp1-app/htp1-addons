import 'bootstrap/dist/css/bootstrap.min.css';
import '@/main.css';
import { createApp } from 'vue';
import { createRouter, createWebHashHistory } from 'vue-router';
import App from './App.vue';
import VolumeCalibrationPage from './components/VolumeCalibrationPage.vue';
import VolumeCalibrationWizard from './components/VolumeCalibrationWizard.vue';
import SweepLab from './components/SweepLab.vue';

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: VolumeCalibrationPage },
    { path: '/wizard', component: VolumeCalibrationWizard },
    { path: '/sweep-lab', component: SweepLab },
  ],
});

createApp(App).use(router).mount('#app');
