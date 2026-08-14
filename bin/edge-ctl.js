#!/usr/bin/env node
/**
 * Manage a supervised Claude Simple edge:
 *   claude-edge status|start|stop|restart|logs
 *   claude-edge daemon <same>
 *
 * Detects launchd (macOS com.claude-simple.edge) or systemd (claude-simple-edge).
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const LAUNCHD_LABEL = 'system/com.claude-simple.edge';
const LAUNCHD_PLIST = '/Library/LaunchDaemons/com.claude-simple.edge.plist';
const SYSTEMD_UNIT = 'claude-simple-edge.service';
const MAC_OUT = path.join(os.homedir(), '.claude-simple-edge', 'edge.out.log');
const MAC_ERR = path.join(os.homedir(), '.claude-simple-edge', 'edge.err.log');

function usage(code = 0) {
  const text = `Usage: claude-edge <command>

  status     Show running state, pid, port, last log lines
  start      Start the edge daemon
  stop       Stop the edge daemon (stays down until start)
  restart    Restart the edge daemon
  logs       Last 80 lines of stdout (or journal on Linux)
  logs -f    Follow logs
  logs err   Stderr only (launchd)

Also installed as: claude-simple-edge, edge-daemon
`;
  if (code) process.stderr.write(text);
  else process.stdout.write(text);
  process.exit(code);
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: opts.stdio || ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
}

function hasCmd(cmd) {
  const r = run(process.platform === 'win32' ? 'where' : 'which', [cmd]);
  return r.status === 0;
}

function detectBackend() {
  if (process.platform === 'darwin') {
    if (fs.existsSync(LAUNCHD_PLIST)) return 'launchd';
    const r = run('launchctl', ['print', LAUNCHD_LABEL]);
    if (r.status === 0) return 'launchd';
  }
  if (hasCmd('systemctl')) {
    const r = run('systemctl', ['cat', SYSTEMD_UNIT]);
    if (r.status === 0) return 'systemd';
  }
  if (process.platform === 'darwin') return 'launchd';
  if (process.platform === 'linux') return 'systemd';
  return null;
}

function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/** Re-exec this CLI via sudo so launchctl/systemctl can touch the system unit. */
function ensureRoot() {
  if (isRoot()) return;
  if (!hasCmd('sudo')) return;
  const script = fileURLToPath(import.meta.url);
  const args = process.argv.slice(2);
  const candidates = ['/usr/local/bin/claude-edge', process.argv[1], script].filter(Boolean);
  const seen = new Set();
  for (const entry of candidates) {
    const resolved = path.resolve(entry);
    if (seen.has(resolved) || !fs.existsSync(resolved)) continue;
    seen.add(resolved);
    const r = spawnSync('sudo', ['-n', resolved, ...args], { stdio: 'inherit' });
    if (r.status === 0) process.exit(0);
  }
  const r = spawnSync('sudo', [process.execPath, script, ...args], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

function runRoot(cmd, args, opts = {}) {
  return run(cmd, args, opts);
}

function fail(msg, extra) {
  console.error(msg);
  if (extra) process.stderr.write(String(extra).trimEnd() + '\n');
  process.exit(1);
}

function parseLaunchdPrint(text) {
  const pick = (re) => {
    const m = text.match(re);
    return m ? m[1] : '-';
  };
  return {
    state: pick(/^\s*state = (\S+)/m),
    pid: pick(/^\s*pid = (\S+)/m),
    runs: pick(/^\s*runs = (\S+)/m),
  };
}

function listenPort() {
  const port = process.env.LOCAL_PORT || '13000';
  const r = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']);
  if (r.status === 0 && r.stdout.trim()) return `127.0.0.1:${port}`;
  const ss = run('ss', ['-lnt']);
  if (ss.status === 0 && ss.stdout.includes(`:${port}`)) return `127.0.0.1:${port}`;
  return 'down';
}

function tailFile(file, n) {
  if (!fs.existsSync(file)) return '';
  const r = run('tail', ['-n', String(n), file]);
  return (r.stdout || '').trimEnd();
}

function cmdStatus(backend) {
  ensureRoot();
  if (backend === 'launchd') {
    const r = runRoot('launchctl', ['print', LAUNCHD_LABEL]);
    if (r.status !== 0) {
      console.log(`service:   ${LAUNCHD_LABEL}`);
      console.log('state:     not-loaded');
      console.log(`plist:     ${LAUNCHD_PLIST}`);
      if (r.stderr) console.log(r.stderr.trim());
      return;
    }
    const info = parseLaunchdPrint(r.stdout);
    const machine = r.stdout.match(/MACHINE_ID => (\S+)/)?.[1] || process.env.MACHINE_ID || '-';
    console.log(`service:   ${LAUNCHD_LABEL}`);
    console.log(`machine:   ${machine}`);
    console.log(`state:     ${info.state}`);
    console.log(`pid:       ${info.pid}`);
    console.log(`runs:      ${info.runs}`);
    console.log(`listen:    ${listenPort()}`);
    console.log(`plist:     ${LAUNCHD_PLIST}`);
    console.log(`stdout:    ${MAC_OUT}`);
    console.log(`stderr:    ${MAC_ERR}`);
    const last = tailFile(MAC_OUT, 8);
    if (last) console.log(`\n--- last logs ---\n${last}`);
    return;
  }

  const r = runRoot('systemctl', ['show', SYSTEMD_UNIT, '--no-pager',
    '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID', '-p', 'NRestarts', '-p', 'FragmentPath', '-p', 'Environment']);
  if (r.status !== 0) fail(`cannot query ${SYSTEMD_UNIT}`, r.stderr || r.stdout);
  const kv = Object.fromEntries(
    r.stdout.split('\n').filter(Boolean).map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i), line.slice(i + 1)];
    }),
  );
  const machine = (kv.Environment || '').match(/(?:^|\s)MACHINE_ID=(\S+)/)?.[1]
    || process.env.MACHINE_ID || '-';
  console.log(`service:   ${SYSTEMD_UNIT}`);
  console.log(`machine:   ${machine}`);
  console.log(`state:     ${kv.ActiveState || '-'} (${kv.SubState || '-'})`);
  console.log(`pid:       ${kv.MainPID || '-'}`);
  console.log(`restarts:  ${kv.NRestarts || '-'}`);
  console.log(`listen:    ${listenPort()}`);
  console.log(`unit:      ${kv.FragmentPath || '-'}`);
  const logs = runRoot('journalctl', ['-u', SYSTEMD_UNIT, '-n', '8', '--no-pager']);
  if (logs.stdout?.trim()) console.log(`\n--- last logs ---\n${logs.stdout.trimEnd()}`);
}

function cmdStart(backend) {
  ensureRoot();
  if (backend === 'launchd') {
    runRoot('launchctl', ['enable', LAUNCHD_LABEL]);
    const loaded = runRoot('launchctl', ['print', LAUNCHD_LABEL]);
    if (loaded.status !== 0) {
      const b = runRoot('launchctl', ['bootstrap', 'system', LAUNCHD_PLIST]);
      if (b.status !== 0) fail('bootstrap failed', b.stderr || b.stdout);
    }
    const k = runRoot('launchctl', ['kickstart', '-k', LAUNCHD_LABEL]);
    if (k.status !== 0) fail('start failed', k.stderr || k.stdout);
    console.log('started');
    return;
  }
  const r = runRoot('systemctl', ['enable', '--now', SYSTEMD_UNIT]);
  if (r.status !== 0) fail('start failed', r.stderr || r.stdout);
  console.log('started');
}

function cmdStop(backend) {
  ensureRoot();
  if (backend === 'launchd') {
    runRoot('launchctl', ['disable', LAUNCHD_LABEL]);
    runRoot('launchctl', ['bootout', LAUNCHD_LABEL]);
    console.log('stopped');
    return;
  }
  const r = runRoot('systemctl', ['disable', '--now', SYSTEMD_UNIT]);
  if (r.status !== 0) fail('stop failed', r.stderr || r.stdout);
  console.log('stopped');
}

function cmdRestart(backend) {
  ensureRoot();
  if (backend === 'launchd') {
    runRoot('launchctl', ['enable', LAUNCHD_LABEL]);
    const loaded = runRoot('launchctl', ['print', LAUNCHD_LABEL]);
    if (loaded.status !== 0) {
      const b = runRoot('launchctl', ['bootstrap', 'system', LAUNCHD_PLIST]);
      if (b.status !== 0) fail('bootstrap failed', b.stderr || b.stdout);
    }
    const k = runRoot('launchctl', ['kickstart', '-k', LAUNCHD_LABEL]);
    if (k.status !== 0) fail('restart failed', k.stderr || k.stdout);
    console.log('restarted');
    return;
  }
  const r = runRoot('systemctl', ['restart', SYSTEMD_UNIT]);
  if (r.status !== 0) fail('restart failed', r.stderr || r.stdout);
  console.log('restarted');
}

function cmdLogs(backend, mode) {
  if (backend === 'systemd') ensureRoot();
  if (backend === 'launchd') {
    if (mode === '-f' || mode === '--follow') {
      const child = spawn('tail', ['-n', '50', '-F', MAC_OUT, MAC_ERR], { stdio: 'inherit' });
      child.on('exit', (c) => process.exit(c || 0));
      return;
    }
    if (mode === 'err' || mode === 'error' || mode === 'stderr') {
      process.stdout.write(tailFile(MAC_ERR, 80) + '\n');
      return;
    }
    process.stdout.write(tailFile(MAC_OUT, 80) + '\n');
    return;
  }
  const args = ['-u', SYSTEMD_UNIT, '--no-pager'];
  if (mode === '-f' || mode === '--follow') {
    const child = spawn('journalctl', ['-u', SYSTEMD_UNIT, '-f', '-n', '50'], { stdio: 'inherit' });
    child.on('exit', (c) => process.exit(c || 0));
    return;
  }
  args.push('-n', '80');
  const r = runRoot('journalctl', args);
  process.stdout.write((r.stdout || r.stderr || '') + (r.stdout?.endsWith('\n') ? '' : '\n'));
}

const raw = process.argv.slice(2);
if (raw[0] === 'daemon') raw.shift();
const cmd = raw[0] || 'status';
const rest = raw.slice(1);

if (['-h', '--help', 'help'].includes(cmd)) usage(0);

const backend = detectBackend();
if (!backend) fail('no launchd/systemd edge service found');

switch (cmd) {
  case 'status':
    cmdStatus(backend);
    break;
  case 'start':
    cmdStart(backend);
    break;
  case 'stop':
    cmdStop(backend);
    break;
  case 'restart':
    cmdRestart(backend);
    break;
  case 'logs':
    cmdLogs(backend, rest[0]);
    break;
  default:
    console.error(`unknown command: ${cmd}`);
    usage(2);
}
