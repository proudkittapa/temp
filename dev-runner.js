import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// `npm run dev:api` passes --api: the frontend then talks to the Go backend
// (VITE_DATA_SOURCE=api, see src/api.ts). Set here rather than as an inline
// `VAR=value` prefix in package.json so it also works on Windows.
const apiMode = process.argv.includes('--api');

console.log(`--- Starting Sports Arena Service Orchestrator${apiMode ? ' (API mode)' : ''} ---`);

// 1. Spawn Go Backend
console.log('[Orchestrator] Starting Go Backend on port 8080...');
const goBackend = spawn('go', ['run', 'main.go'], {
  cwd: path.join(__dirname, 'golang-backend'),
  env: {
    ...process.env,
    PORT: '8080',
    // Local dev only: seed the demo accounts (password 123456) that match
    // mockData.ts, so the frontend's API mode has users to log in as.
    SEED_DEMO_USERS: process.env.SEED_DEMO_USERS || 'true',
    // Fallback URL if env is not already set
    DATABASE_URL: process.env.DATABASE_URL || 'postgres://arena_user:ArenaSecurePass99@localhost:5432/arena_db?sslmode=disable'
  }
});

goBackend.stdout.on('data', (data) => {
  console.log(`[Go Backend] ${data.toString().trim()}`);
});

goBackend.stderr.on('data', (data) => {
  console.error(`[Go Backend Err] ${data.toString().trim()}`);
});

goBackend.on('close', (code) => {
  console.log(`[Go Backend] process exited with code ${code}`);
});

// 2. Spawn Vite Frontend on standard port 3000
console.log('[Orchestrator] Starting Vite Frontend on port 3000...');
const viteDev = spawn('npx', ['vite', '--port=3000', '--host=0.0.0.0'], {
  shell: true,
  env: {
    ...process.env,
    ...(apiMode ? { VITE_DATA_SOURCE: 'api' } : {}),
    DISABLE_HMR: 'true'
  }
});

viteDev.stdout.on('data', (data) => {
  console.log(`[Vite] ${data.toString().trim()}`);
});

viteDev.stderr.on('data', (data) => {
  console.error(`[Vite Err] ${data.toString().trim()}`);
});

viteDev.on('close', (code) => {
  console.log(`[Vite] process exited with code ${code}`);
});

// Ensure children die when orchestrator processes die
const cleanup = () => {
  console.log('[Orchestrator] Shutting down services politely...');
  goBackend.kill('SIGTERM');
  viteDev.kill('SIGTERM');
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
