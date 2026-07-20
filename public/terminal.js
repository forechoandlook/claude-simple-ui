// terminal.js — Shell tab: persistent bash via WebSocket (with xterm.js)
import { $, watch } from './lib.js';
import { currentProject, currentTab, ctx, hubMode, selectedMachineId } from './state.js';

let ws        = null;
let term      = null;
let fitAddon  = null;
let connected = false;
let lastCwd   = null;
let lastMachine = null;

function initXterm() {
  if (term) return;

  const container = $('terminal-container');
  if (!container) return;

  if (typeof Terminal === 'undefined') {
    setTimeout(initXterm, 100);
    return;
  }

  term = new Terminal({
    cursorBlink: true,
    fontFamily: 'Fira Code, Courier New, monospace',
    fontSize: 12,
    theme: {
      background: '#0d1117',
      foreground: '#c9d1d9',
      cursor: '#58a6ff',
      black: '#0d1117',
      red: '#ff7b72',
      green: '#3fb950',
      yellow: '#d29922',
      blue: '#58a6ff',
      magenta: '#bc8cff',
      cyan: '#39c5cf',
      white: '#b1bac4',
      brightBlack: '#484f58',
      brightRed: '#ffa198',
      brightGreen: '#56d364',
      brightYellow: '#e3b341',
      brightBlue: '#79c0ff',
      brightMagenta: '#d8b9ff',
      brightCyan: '#56d4dd',
      brightWhite: '#ffffff'
    }
  });

  if (typeof FitAddon !== 'undefined') {
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
  }

  term.open(container);
  fitTerminal();

  term.onData(data => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }));
    }
  });

  window.addEventListener('resize', () => {
    fitTerminal();
    sendResize();
  });
}

function fitTerminal() {
  try {
    if (fitAddon && term) fitAddon.fit();
  } catch { /* container may be hidden */ }
}

function sendResize() {
  if (ws && ws.readyState === WebSocket.OPEN && term) {
    ws.send(JSON.stringify({
      type: 'resize',
      cols: term.cols,
      rows: term.rows
    }));
  }
}

function activeMachine() {
  return ctx.machineId || selectedMachineId.peek() || null;
}

function connect(cwd) {
  if (ws) { try { ws.close(); } catch {} ws = null; }
  connected = false;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const cols = term ? term.cols : 80;
  const rows = term ? term.rows : 24;
  const q = new URLSearchParams();
  if (ctx.token) q.set('token', ctx.token);
  if (cwd) q.set('cwd', cwd);
  q.set('cols', String(cols));
  q.set('rows', String(rows));
  const mid = activeMachine();
  if (hubMode.peek() && mid) q.set('machine', mid);

  lastCwd = cwd || null;
  lastMachine = mid;

  ws = new WebSocket(`${proto}://${location.host}/ws/shell?${q}`);

  ws.addEventListener('open', () => {
    connected = true;
    term?.write('\x1b[32mConnected to interactive terminal\x1b[0m\r\n');
    sendResize();
  });

  ws.addEventListener('message', e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'output') {
      term?.write(msg.data);
    } else if (msg.type === 'exit') {
      term?.write(`\r\n\x1b[33m[process exited: ${msg.code}]\x1b[0m\r\n`);
    } else if (msg.type === 'error') {
      term?.write(`\r\n\x1b[31m[error: ${msg.data || msg.message || ''}]\x1b[0m\r\n`);
    }
  });

  ws.addEventListener('close', () => {
    connected = false;
    term?.write('\r\n\x1b[33m[disconnected]\x1b[0m\r\n');
  });

  ws.addEventListener('error', () => {
    term?.write('\r\n\x1b[31m[WebSocket error]\x1b[0m\r\n');
  });
}

function activateShellTab() {
  const cwd = currentProject.peek()?.path;
  const cwdEl = $('term-cwd');
  if (cwdEl) cwdEl.textContent = cwd || '~';

  if (!term) initXterm();

  // Double rAF: layout is ready after tab becomes visible
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      fitTerminal();
      const mid = activeMachine();
      const needReconnect = !connected
        || lastCwd !== (cwd || null)
        || lastMachine !== mid;
      if (needReconnect) {
        term?.clear();
        connect(cwd);
      } else {
        sendResize();
      }
    });
  });
}

export function initTerminal() {
  // Defer xterm until first visit to shell (container must be measurable)
  watch(currentTab, tab => {
    if (tab === 'shell') activateShellTab();
  });

  document.addEventListener('shell-tab-shown', () => {
    if (currentTab.peek() === 'shell') activateShellTab();
  });

  document.getElementById('term-reconnect')?.addEventListener('click', () => {
    term?.clear();
    connect(currentProject.peek()?.path);
  });
}
