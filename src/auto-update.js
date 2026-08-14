/**
 * Optional self-update against the public npm registry.
 *
 * Env:
 *   AUTO_UPDATE=0|false|off     disable (default: enabled for edge client)
 *   AUTO_UPDATE_INTERVAL_HOURS  check interval, default 12 (half day)
 *   AUTO_UPDATE_PACKAGE         package name, default claude-simple
 *   AUTO_UPDATE_CHANNEL         dist-tag, default latest
 *   AUTO_UPDATE_IDLE_WAIT_MS    wait for agents to finish before applying, default 30min
 *   AUTO_UPDATE_APPLY=0         only log when newer; do not install/restart
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(__dirname, '..');

function envBool(name, defaultOn) {
  const v = process.env[name];
  if (v == null || v === '') return defaultOn;
  return !/^(0|false|off|no)$/i.test(String(v));
}

function readLocalVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

/** semver-ish compare: a > b → 1, a < b → -1, eq → 0 */
export function cmpSemver(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function fetchLatestVersion(pkgName, tag) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(pkgName)}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'claude-simple-auto-update' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
  const data = await res.json();
  const ver = data?.['dist-tags']?.[tag] || data?.['dist-tags']?.latest;
  if (!ver) throw new Error('no dist-tag on registry');
  return String(ver);
}

/** Detect install layout: global npm vs local/source tree. */
function detectInstallMode() {
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
  const inGlobal = /[/\\]node_modules[/\\]claude-simple[/\\]/.test(entry)
    || /[/\\]lib[/\\]node_modules[/\\]claude-simple[/\\]/.test(PKG_ROOT);
  // Prefer global update when package lives under a node_modules tree named claude-simple
  if (inGlobal || /[/\\]node_modules[/\\]claude-simple$/.test(PKG_ROOT)) {
    return { mode: 'global', cwd: process.cwd() };
  }
  return { mode: 'local', cwd: PKG_ROOT };
}

function runNpmInstall(mode, pkgName, version, cwd) {
  const spec = `${pkgName}@${version}`;
  const args = mode === 'global'
    ? ['install', '-g', spec, '--no-fund', '--no-audit']
    : ['install', spec, '--no-fund', '--no-audit', '--prefix', cwd];
  return new Promise((resolve, reject) => {
    console.log(`[auto-update] running: npm ${args.join(' ')}`);
    const child = spawn('npm', args, {
      cwd: mode === 'global' ? osHomedir() : cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    child.stderr.on('data', (d) => { err += d; process.stderr.write(d); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`npm exited ${code}: ${(err || out).slice(-500)}`));
    });
  });
}

function osHomedir() {
  return process.env.HOME || process.env.USERPROFILE || PKG_ROOT;
}

/**
 * @param {object} opts
 * @param {() => boolean} [opts.isBusy]  return true while agent turn is running
 * @param {boolean} [opts.enabled]
 * @param {string} [opts.role]  log label
 */
export function startAutoUpdate(opts = {}) {
  const enabled = opts.enabled != null ? opts.enabled : envBool('AUTO_UPDATE', true);
  if (!enabled) {
    console.log('[auto-update] disabled (AUTO_UPDATE=0)');
    return { stop() {} };
  }

  const intervalHours = Math.max(0.25, parseFloat(process.env.AUTO_UPDATE_INTERVAL_HOURS || '12') || 12);
  const intervalMs = intervalHours * 3600 * 1000;
  const pkgName = process.env.AUTO_UPDATE_PACKAGE || 'claude-simple';
  const channel = process.env.AUTO_UPDATE_CHANNEL || 'latest';
  const apply = envBool('AUTO_UPDATE_APPLY', true);
  const idleWaitMs = Math.max(60_000, parseInt(process.env.AUTO_UPDATE_IDLE_WAIT_MS || String(30 * 60 * 1000), 10) || 30 * 60 * 1000);
  const isBusy = typeof opts.isBusy === 'function' ? opts.isBusy : () => false;
  const role = opts.role || 'process';

  let stopped = false;
  let timer = null;
  let applying = false;
  const localVersion = readLocalVersion();

  console.log(
    `[auto-update] enabled · local=${localVersion} · check every ${intervalHours}h · package=${pkgName}@${channel} · apply=${apply}`,
  );

  async function waitUntilIdle() {
    const deadline = Date.now() + idleWaitMs;
    while (Date.now() < deadline) {
      if (stopped) return false;
      if (!isBusy()) return true;
      console.log('[auto-update] agent busy — waiting before apply…');
      await new Promise((r) => setTimeout(r, 15_000));
    }
    console.warn('[auto-update] idle wait timed out; applying anyway');
    return true;
  }

  async function checkOnce() {
    if (stopped || applying) return;
    try {
      const latest = await fetchLatestVersion(pkgName, channel);
      const cmp = cmpSemver(latest, localVersion);
      if (cmp <= 0) {
        console.log(`[auto-update] up to date (${localVersion}, registry ${latest})`);
        return;
      }
      console.log(`[auto-update] new version available: ${localVersion} → ${latest}`);
      if (!apply) {
        console.log('[auto-update] AUTO_UPDATE_APPLY=0 — skip install');
        return;
      }

      applying = true;
      await waitUntilIdle();
      if (stopped) return;

      const { mode, cwd } = detectInstallMode();
      console.log(`[auto-update] install mode=${mode} root=${PKG_ROOT}`);

      // Global install when package is under node_modules; else npm install in package root
      if (mode === 'global') {
        await runNpmInstall('global', pkgName, latest, cwd);
      } else {
        // Source / linked tree: pull package.json version bump via npm update in place
        await runNpmInstall('local', pkgName, latest, cwd);
        // If we're running from a git checkout that *is* the package (not a dependency),
        // local `npm install claude-simple@x` only updates node_modules — won't replace this tree.
        // For git checkouts, pull via npm pack is wrong; log and skip restart unless global.
        const pkgJsonName = (() => {
          try { return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).name; }
          catch { return null; }
        })();
        if (pkgJsonName === pkgName && !/node_modules/.test(PKG_ROOT)) {
          console.warn(
            '[auto-update] running from source checkout — npm cannot overwrite this tree. '
            + 'Use `npm install -g claude-simple` for auto-apply, or pull git + restart manually.',
          );
          applying = false;
          return;
        }
      }

      console.log(`[auto-update] installed ${latest}; restarting ${role} (exit 0 — supervisor should relaunch)`);
      // Give logs a moment to flush; systemd Restart= will bring us back on new code
      setTimeout(() => process.exit(0), 500);
    } catch (e) {
      console.warn(`[auto-update] check failed: ${e.message || e}`);
      applying = false;
    }
  }

  // First check after a short delay (don't compete with boot / hub connect)
  const firstDelay = Math.min(60_000, Math.max(15_000, intervalMs / 100));
  timer = setTimeout(function tick() {
    checkOnce().finally(() => {
      if (stopped) return;
      timer = setTimeout(tick, intervalMs);
    });
  }, firstDelay);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    checkNow: checkOnce,
    localVersion,
  };
}
