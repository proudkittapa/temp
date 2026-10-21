import { spawn, spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// `npm run dev:api` passes --api: the frontend then talks to the Go backend
// (VITE_DATA_SOURCE=api, see src/api.ts). Set here rather than as an inline
// `VAR=value` prefix in package.json so it also works on Windows.
const apiMode = process.argv.includes('--api');
const isWindows = process.platform === 'win32';

console.log(`--- Starting Sports Arena Service Orchestrator${apiMode ? ' (API mode)' : ''} ---`);

const children = [];
let shuttingDown = false;

// Each child gets its own process group (detached) so stopping it also stops
// what it started: `go run` compiles and runs a separate server binary, and
// `npx vite` runs under a shell. Killing only the direct child used to leave
// those running and holding ports 8080/3000 ("address already in use").
function start(name, command, args, options) {
  const child = spawn(command, args, { ...options, detached: !isWindows });
  child.label = name;
  children.push(child);
  child.stdout.on('data', data => console.log(`[${name}] ${data.toString().trim()}`));
  child.stderr.on('data', data => console.error(`[${name} Err] ${data.toString().trim()}`));
  child.on('error', err => {
    console.error(`[Orchestrator] Could not start ${name}: ${err.message}`);
    shutdown(1);
  });
  child.on('exit', code => {
    child.exited = true;
    console.log(`[${name}] process exited with code ${code}`);
    // If one side stops on its own, stop the other rather than leave a
    // half-working setup running.
    if (!shuttingDown) shutdown(code ?? 1);
  });
  return child;
}

function killTree(child, signal) {
  if (child.exited || !child.pid) return;
  try {
    if (isWindows) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    } else {
      process.kill(-child.pid, signal); // the whole process group
    }
  } catch {
    // already gone
  }
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[Orchestrator] Shutting down services politely...');
  children.forEach(c => killTree(c, c.stopSignal || 'SIGTERM'));
  // The backend finishes requests in progress and closes the database
  // first (up to its SHUTDOWN_TIMEOUT_SECONDS, 30 by default); force
  // anything still running after 35 seconds.
  setTimeout(() => {
    children.forEach(c => killTree(c, 'SIGKILL'));
    process.exit(exitCode);
  }, 35000).unref();
  const waitForAll = setInterval(() => {
    if (children.every(c => c.exited || !c.pid)) {
      clearInterval(waitForAll);
      process.exit(exitCode);
    }
  }, 100);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGHUP', () => shutdown(0)); // terminal closed

// `npm run dev` starts this script through a shell, and npm doesn't pass a
// SIGTERM on to it - so when an IDE's stop button or `kill <npm pid>` ends
// npm, this script used to keep running with everything it started. Watch
// for the parent going away and shut down then too.
const parentPid = process.ppid;
setInterval(() => {
  if (process.ppid !== parentPid) shutdown(0);
}, 1000).unref();
process.on('exit', () => children.forEach(c => killTree(c, 'SIGKILL')));

// 1. Go backend - API mode only. `npm run dev` keeps everything in the
// browser and doesn't need Go (or a database) installed.
if (apiMode) {
  const goCheck = spawnSync('go', ['version'], { shell: isWindows });
  if (goCheck.error || goCheck.status !== 0) {
    console.error('[Orchestrator] `npm run dev:api` needs Go (https://go.dev/dl/) and PostgreSQL - see golang-backend/README.md.');
    console.error('[Orchestrator] To try the app without them, run `npm run dev` (data stays in the browser).');
    process.exit(1);
  }
  // Variables set here take precedence over golang-backend/.env (main.go's
  // loadEnv never overrides an already-set variable), so PORT always
  // matches the Vite proxy in vite.config.ts. DATABASE_URL is deliberately
  // not set: the backend reads it from .env (or .env.example).
  console.log('[Orchestrator] Starting Go Backend on port 8080...');
  const backend = start('Go Backend', 'go', ['run', '.'], {
    cwd: path.join(__dirname, 'golang-backend'),
    shell: isWindows,
    env: {
      ...process.env,
      PORT: '8080',
      // Local dev only: seed the demo accounts (password 123456) that match
      // mockData.ts, so the frontend's API mode has users to log in as.
      SEED_DEMO_USERS: process.env.SEED_DEMO_USERS || 'true'
    }
  });
  // SIGINT, not SIGTERM: `go run` dies at once on SIGTERM, leaving the
  // server it started orphaned with a broken log pipe (its next log line
  // killed it mid-request); on SIGINT it waits while the server - same
  // process group - shuts down cleanly.
  backend.stopSignal = 'SIGINT';
}

// 2. Vite frontend on port 3000 - in API mode only once the backend says
// it is ready (database connected and set up), so the first page load
// doesn't hit a backend that isn't listening yet.
function startVite() {
  if (shuttingDown) return;
  console.log('[Orchestrator] Starting Vite Frontend on port 3000...');
  start('Vite', 'npx', ['vite', '--port=3000', '--host=0.0.0.0'], {
    shell: true,
    env: {
      ...process.env,
      ...(apiMode ? { VITE_DATA_SOURCE: 'api' } : {}),
      DISABLE_HMR: 'true'
    }
  });
}

async function waitForBackend() {
  console.log('[Orchestrator] Waiting for the backend to be ready (compiling, connecting to the database)...');
  const deadline = Date.now() + 180000; // first `go run` compiles everything
  while (!shuttingDown && Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:8080/readyz');
      if (res.ok) {
        console.log('[Orchestrator] Backend is ready.');
        return;
      }
    } catch {
      // not listening yet
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!shuttingDown) console.warn('[Orchestrator] Backend not ready after 3 minutes - starting the frontend anyway.');
}

if (apiMode) {
  waitForBackend().then(startVite);
} else {
  startVite();
}
