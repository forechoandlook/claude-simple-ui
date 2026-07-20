// terminal.js — Shell tab: persistent bash via WebSocket (with xterm.js)
import { $, watch } from './lib.js';
import { currentProject, currentTab, ctx } from './state.js';

let ws        = null;
let term      = null;
let fitAddon  = null;
let connected = false;

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
  try {
    if (fitAddon) fitAddon.fit();
  } catch (e) {}

  term.onData(data => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }));
    }
  });

  window.addEventListener('resize', () => {
    try {
      if (fitAddon) {
        fitAddon.fit();
        sendResize();
      }
    } catch (e) {}
  });
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

function connect(cwd) {
  if (ws) { ws.close(); ws = null; }
  connected = false;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const cwdParam = cwd ? `&cwd=${encodeURIComponent(cwd)}` : '';
  const cols = term ? term.cols : 80;
  const rows = term ? term.rows : 24;
  let q = `token=${encodeURIComponent(ctx.token || '')}${cwdParam}&cols=${cols}&rows=${rows}`;
  if (ctx.machineId) q += `&machine=${encodeURIComponent(ctx.machineId)}`;
  ws = new WebSocket(`${proto}://${location.host}/ws/shell?${q}`);

  ws.addEventListener('open', () => {
    connected = true;
    term?.write('\x1b[32mConnected to interactive terminal\x1b[0m\r\n');
    sendResize();
  });

  ws.addEventListener('message', e => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'output') {
      term?.write(msg.data);
    } else if (msg.type === 'exit') {
      term?.write(`\r\n\x1b[33m[process exited: ${msg.code}]\x1b[0m\r\n`);
    } else if (msg.type === 'error') {
      term?.write(`\r\n\x1b[31m[error: ${msg.data}]\x1b[0m\r\n`);
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

export function initTerminal() {
  initXterm();

  watch(currentTab, tab => {
    if (tab === 'shell') {
      const cwd = currentProject.peek()?.path;
      const cwdEl = $('term-cwd');
      if (cwdEl) cwdEl.textContent = cwd || '~';
      
      if (!term) {
        initXterm();
      }
      
      setTimeout(() => {
        try {
          if (fitAddon) fitAddon.fit();
        } catch (e) {}
        if (!connected) connect(cwd);
      }, 100);
    }
  });

  document.getElementById('term-reconnect')?.addEventListener('click', () => {
    term?.clear();
    connect(currentProject.peek()?.path);
  });
}
