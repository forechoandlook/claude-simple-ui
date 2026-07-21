// shell/util.js — shared formatting helpers
import { esc } from '../lib.js';
import { AGENT_LABELS } from '../state.js';

/** Coerce history/API timestamps to epoch milliseconds. */
export function coerceTs(ts) {
  if (ts == null || ts === '') return null;
  if (typeof ts === 'number') {
    if (!Number.isFinite(ts) || ts <= 0) return null;
    // Unix seconds (~1e9–1e10) → ms; already-ms is ~1e12–1e13
    return ts < 1e12 ? Math.round(ts * 1000) : Math.round(ts);
  }
  if (typeof ts === 'string') {
    const trimmed = ts.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      return coerceTs(Number(trimmed));
    }
    const ms = Date.parse(trimmed);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

export function formatTime(ts) {
  const ms = coerceTs(ts);
  if (ms == null) return '';
  const diff = Date.now() - ms;
  if (diff < 0) return new Date(ms).toLocaleDateString();
  if (diff < 60000)       return 'just now';
  if (diff < 3600000)     return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000)    return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 7 * 86400000) return `${Math.floor(diff / 86400000)}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function agentBadge(agent, compact = true) {
  const a = agent || 'claude';
  const colors = {
    claude: 'bg-orange-500/15 text-orange-400',
    codex:  'bg-emerald-500/15 text-emerald-400',
    grok:   'bg-sky-500/15 text-sky-400',
  };
  const cls = colors[a] || 'bg-base-300 text-base-content/50';
  const label = compact
    ? (a === 'claude' ? 'CC' : a === 'codex' ? 'CX' : a === 'grok' ? 'GX' : a.slice(0, 2).toUpperCase())
    : (AGENT_LABELS[a] || a);
  return `<span class="text-[9px] px-1 py-0.5 rounded font-mono font-semibold flex-shrink-0 ${cls}" title="${esc(AGENT_LABELS[a] || a)}">${label}</span>`;
}

export function agentCountPills(agents) {
  return Object.entries(agents || {})
    .filter(([, n]) => n > 0)
    .map(([a, n]) => `${agentBadge(a)}<span class="text-[9px] text-base-content/40 -ml-0.5">${n}</span>`)
    .join('');
}

export function shortPath(cwd) {
  if (!cwd) return '';
  const home = ''; // browser can't know home reliably; show last 2 segments if long
  const parts = cwd.split('/').filter(Boolean);
  if (parts.length <= 3) return cwd;
  return '…/' + parts.slice(-2).join('/');
}
