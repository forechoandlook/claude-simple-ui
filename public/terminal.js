// terminal.js — Shell tab: persistent bash via WebSocket
import { esc, $, watch } from './lib.js';
import { currentProject, currentTab, ctx } from './state.js';

let ws        = null;
let history   = [];
let histIdx   = -1;
let connected = false;

// ── ANSI handling ─────────────────────────────────────────────────────────────
const ANSI_COLORS = {
  30:'#4e4e4e', 31:'#cc0000', 32:'#4e9a06', 33:'#c4a000',
  34:'#3465a4', 35:'#75507b', 36:'#06989a', 37:'#d3d7cf',
  90:'#555753', 91:'#ef2929', 92:'#8ae234', 93:'#fce94f',
  94:'#729fcf', 95:'#ad7fa8', 96:'#34e2e2', 97:'#eeeeec',
};

function ansiToHtml(text) {
  let out = '';
  let fg = null, bold = false;
  const parts = text.split(/(\x1b\[[0-9;]*m)/);
  for (const part of parts) {
    if (part.startsWith('\x1b[')) {
      const codes = part.slice(2, -1).split(';').map(Number);
      for (const c of codes) {
        if (c === 0)  { fg = null; bold = false; }
        else if (c === 1) bold = true;
        else if (c === 22) bold = false;
        else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) fg = c;
        else if (c === 39) fg = null;
      }
    } else if (part) {
      // strip remaining non-SGR escape sequences (cursor movement etc.)
      const clean = part.replace(/\x1b\[[0-9;]*[A-HJKSTf]/g, '')
                        .replace(/\x1b[()][0-9A-Za-z]/g, '')
                        .replace(/\r/g, '');
      if (!clean) continue;
      const color = fg ? ANSI_COLORS[fg] : null;
      const style = [color ? `color:${color}` : '', bold ? 'font-weight:600' : ''].filter(Boolean).join(';');
      out += style ? `<span style="${style}">${esc(clean)}</span>` : esc(clean);
    }
  }
  return out;
}

// ── Connection ────────────────────────────────────────────────────────────────
function connect(cwd) {
  if (ws) { ws.close(); ws = null; }
  connected = false;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const cwdParam = cwd ? `&cwd=${encodeURIComponent(cwd)}` : '';
  ws = new WebSocket(`${proto}://${location.host}/ws/shell?token=${ctx.token}${cwdParam}`);

  ws.addEventListener('open', () => {
    connected = true;
    appendOutput('\x1b[32mConnected\x1b[0m\r\n');
    focusInput();
  });

  ws.addEventListener('message', e => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'output') appendOutput(msg.data);
    else if (msg.type === 'exit') appendOutput(`\r\n\x1b[33m[process exited: ${msg.code}]\x1b[0m\r\n`);
    else if (msg.type === 'error') appendOutput(`\r\n\x1b[31m[error: ${msg.data}]\x1b[0m\r\n`);
  });

  ws.addEventListener('close', () => {
    connected = false;
    appendOutput('\r\n\x1b[33m[disconnected]\x1b[0m\r\n');
  });

  ws.addEventListener('error', () => {
    appendOutput('\r\n\x1b[31m[WebSocket error]\x1b[0m\r\n');
  });
}

function disconnect() {
  if (ws) { ws.close(); ws = null; }
  connected = false;
}

// ── Output ────────────────────────────────────────────────────────────────────
function appendOutput(text) {
  const out = $('term-output');
  if (!out) return;
  const div = document.createElement('span');
  div.innerHTML = ansiToHtml(text);
  out.appendChild(div);
  out.scrollTop = out.scrollHeight;
}

function clearOutput() {
  const out = $('term-output');
  if (out) out.innerHTML = '';
}

// ── Input ─────────────────────────────────────────────────────────────────────
function focusInput() { $('term-input')?.focus(); }

function sendInput(data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'input', data }));
}

function handleKey(e) {
  const input = e.target;

  if (e.key === 'Enter') {
    const cmd = input.value;
    input.value = '';
    histIdx = -1;
    if (cmd) { history.unshift(cmd); if (history.length > 200) history.pop(); }
    sendInput(cmd + '\n');
    return;
  }

  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (histIdx < history.length - 1) { histIdx++; input.value = history[histIdx]; }
    return;
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (histIdx > 0) { histIdx--; input.value = history[histIdx]; }
    else { histIdx = -1; input.value = ''; }
    return;
  }

  if (e.key === 'c' && e.ctrlKey) {
    e.preventDefault();
    sendInput('\x03');   // Ctrl+C → SIGINT to bash
    return;
  }

  if (e.key === 'd' && e.ctrlKey && !input.value) {
    e.preventDefault();
    sendInput('\x04');   // Ctrl+D → EOF
    return;
  }

  if (e.key === 'l' && e.ctrlKey) {
    e.preventDefault();
    clearOutput();
    return;
  }

  if (e.key === 'Tab') {
    e.preventDefault();
    sendInput('\t');
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
export function initTerminal() {
  // Auto-connect/disconnect when switching to Shell tab
  watch(currentTab, tab => {
    if (tab === 'shell') {
      const cwd = currentProject.peek()?.path;
      const cwdEl = $('term-cwd');
      if (cwdEl) cwdEl.textContent = cwd || '~';
      if (!connected) connect(cwd);
      setTimeout(focusInput, 50);
    }
  });

  const input = $('term-input');
  if (input) input.addEventListener('keydown', handleKey);

  document.getElementById('term-reconnect')?.addEventListener('click', () => {
    clearOutput();
    connect(currentProject.peek()?.path);
  });

  document.getElementById('term-clear')?.addEventListener('click', clearOutput);

  // Click anywhere on output → focus input
  $('term-output')?.addEventListener('click', focusInput);
}
