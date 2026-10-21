import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  // Court counts for the browser-only seed (mockData.ts parseCourtCounts):
  // the same un-prefixed names as the Go backend, read from the root .env
  // or the environment. In API mode the backend's golang-backend/.env
  // decides instead.
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), tailwindcss()],
    define: {
      __COURT_COUNTS__: JSON.stringify({
        basketball: env.BASKETBALL_COURT_COUNT ?? '',
        badminton: env.BADMINTON_COURT_COUNT ?? '',
        pickleball: env.PICKLEBALL_COURT_COUNT ?? '',
        meetingRoom: env.MEETING_ROOM_COUNT ?? '',
      }),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      port: 3000,
      host: '0.0.0.0',
      proxy: {
        '/api': {
          target: 'http://localhost:8080',
          changeOrigin: true,
        },
      },
    },
  };
});
