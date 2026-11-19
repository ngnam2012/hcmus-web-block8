import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config, sleep } from '../src/config.js';

const rootDir = fileURLToPath(new URL('../', import.meta.url));
const pidDir = fileURLToPath(new URL('../.pids/', import.meta.url));

const SERVICES = {
  'sender-api': {
    script: 'src/sender-api.js',
    healthUrl: `http://127.0.0.1:${config.senderPort}/health`,
  },
  relay: {
    script: 'src/relay.js',
    healthUrl: `http://127.0.0.1:${config.relayHealthPort}/health`,
  },
  'receiver-api': {
    script: 'src/receiver-api.js',
    healthUrl: `http://127.0.0.1:${config.receiverPort}/health`,
  },
  'receiver-worker': {
    script: 'src/receiver-worker.js',
    healthUrl: `http://127.0.0.1:${config.workerHealthPort}/health`,
  },
};

const ALL_ORDER = ['receiver-api', 'receiver-worker', 'sender-api', 'relay'];

function pidFile(name) {
  return `${pidDir}${name}.json`;
}

function logFile(name) {
  return `${pidDir}${name}.log`;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidRecord(name) {
  const file = pidFile(name);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

async function waitForHealth(url, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {
      // retry
    }
    await sleep(100);
  }
  return false;
}

async function startService(name, marker = '') {
  const spec = SERVICES[name];
  mkdirSync(pidDir, { recursive: true });

  const existing = readPidRecord(name);
  if (existing && isPidAlive(existing.pid)) {
    console.log(`${name}: already running (pid=${existing.pid})`);
    return;
  }

  const logPath = logFile(name);
  const outFd = openSync(logPath, 'w');
  const env = {
    ...process.env,
    BIND_HOST: '127.0.0.1',
    LAB_MODE: process.env.LAB_MODE || 'true',
    MARKER: marker || '',
  };

  const child = spawn(process.execPath, [spec.script], {
    cwd: rootDir,
    env,
    detached: true,
    stdio: ['ignore', outFd, outFd],
    windowsHide: true,
  });
  child.unref();
  closeSync(outFd);

  writeFileSync(
    pidFile(name),
    JSON.stringify({ service: name, pid: child.pid, marker: marker || null, started_at: new Date().toISOString() }, null, 2),
  );

  const healthy = await waitForHealth(spec.healthUrl, 10000);
  if (!healthy) {
    const logs = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    throw new Error(`${name} failed health check (${spec.healthUrl}). Log:\n${logs}`);
  }
  console.log(`${name}: started (pid=${child.pid}${marker ? `, marker=${marker}` : ''})`);
}

async function stopService(name, signal = 'SIGTERM') {
  const rec = readPidRecord(name);
  if (!rec) {
    console.log(`${name}: not running`);
    return;
  }
  if (isPidAlive(rec.pid)) {
    try {
      process.kill(rec.pid, signal);
    } catch {
      // already exited
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && isPidAlive(rec.pid)) {
      await sleep(80);
    }
    if (isPidAlive(rec.pid)) {
      try {
        process.kill(rec.pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
    console.log(`${name}: ${signal === 'SIGKILL' ? 'killed (SIGKILL)' : 'stopped'} (pid=${rec.pid})`);
  } else {
    console.log(`${name}: stale pid=${rec.pid} cleaned`);
  }
  if (existsSync(pidFile(name))) unlinkSync(pidFile(name));
}

async function showStatus() {
  for (const name of ALL_ORDER) {
    const rec = readPidRecord(name);
    const alive = rec ? isPidAlive(rec.pid) : false;
    let healthy = false;
    if (alive) {
      try {
        const res = await fetch(SERVICES[name].healthUrl, { signal: AbortSignal.timeout(800) });
        healthy = res.ok;
      } catch {
        healthy = false;
      }
    }
    console.log(
      `${name.padEnd(16)} ${alive ? 'RUNNING' : 'STOPPED'} pid=${rec?.pid ?? '-'} health=${healthy ? 'ok' : 'down'}${rec?.marker ? ` marker=${rec.marker}` : ''}`,
    );
  }
}

function showLogs(name) {
  const file = logFile(name);
  if (!existsSync(file)) {
    console.log(`${name}: no log file`);
    return;
  }
  console.log(readFileSync(file, 'utf8'));
}

function usage() {
  console.log(`Usage:
  node scripts/process-ctl.js start <sender-api|relay|receiver-api|receiver-worker|all> [--marker=<name>]
  node scripts/process-ctl.js stop  <sender-api|relay|receiver-api|receiver-worker|all>
  node scripts/process-ctl.js kill  <sender-api|relay|receiver-api|receiver-worker>
  node scripts/process-ctl.js status
  node scripts/process-ctl.js logs  <sender-api|relay|receiver-api|receiver-worker>`);
}

async function main() {
  const [action, target, ...rest] = process.argv.slice(2);
  const markerArg = rest.find(arg => arg.startsWith('--marker='));
  const marker = markerArg ? markerArg.slice('--marker='.length) : '';

  if (!action || action === '--help' || action === '-h') {
    usage();
    return;
  }

  if (action === 'status') {
    await showStatus();
    return;
  }

  const targets = target === 'all' ? ALL_ORDER : [target];
  if (!target || targets.some(t => !SERVICES[t])) {
    usage();
    process.exit(1);
  }

  if (action === 'start') {
    for (const name of targets) {
      await startService(name, targets.length === 1 ? marker : '');
    }
  } else if (action === 'stop') {
    for (const name of [...targets].reverse()) {
      await stopService(name, 'SIGTERM');
    }
  } else if (action === 'kill') {
    if (target === 'all') {
      throw new Error('Specify a single service for kill');
    }
    await stopService(target, 'SIGKILL');
  } else if (action === 'logs') {
    if (target === 'all') {
      for (const name of ALL_ORDER) {
        console.log(`=== ${name} ===`);
        showLogs(name);
      }
    } else {
      showLogs(target);
    }
  } else {
    usage();
    process.exit(1);
  }
}

main().catch(error => {
  console.error('PROC_CTL_ERROR', error.message);
  process.exit(1);
});
