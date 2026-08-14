// shell/dashboard.js — welcome calendar + stats
import { esc, $ } from '../lib.js';
import {
  ctx, sessionsData, agentFilter, hubMode, selectedMachineId, sessionDisplayTitle,
} from '../state.js';
import { formatTime, agentBadge, shortPath, coerceTs } from './util.js';

export let calYear = new Date().getFullYear();
export let calMonth = new Date().getMonth(); // 0-11
export let selectedCalDate = null;

function asSessionArray(v) {
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.results)) return v.results;
  if (v && Array.isArray(v.sessions)) return v.sessions;
  return [];
}

/**
 * Sessions for home calendar/stats.
 * Uses full session list (not sidebar 14d / 120-cap filters) so the month grid is complete.
 * Still respects agent filter + hub machine selection.
 */
export function getDashboardSessions() {
  let list = asSessionArray(sessionsData.peek());
  const mid = selectedMachineId.peek();
  if (hubMode.peek() && mid) {
    list = list.filter(s => s && (!s.machineId || s.machineId === mid));
  }
  const aFilter = agentFilter.peek();
  if (aFilter && aFilter !== 'all') {
    list = list.filter(s => s && (s.agent || 'claude') === aFilter);
  }
  return list;
}

function getLocalDateString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getMonthGrid(year, month) {
  const cells = [];
  const firstDay = new Date(year, month, 1);
  const startDay = firstDay.getDay();
  const lastDay = new Date(year, month + 1, 0);
  const totalDays = lastDay.getDate();
  const prevLastDay = new Date(year, month, 0).getDate();
  
  for (let i = startDay - 1; i >= 0; i--) {
    cells.push({
      date: new Date(year, month - 1, prevLastDay - i),
      isCurrentMonth: false
    });
  }
  
  for (let i = 1; i <= totalDays; i++) {
    cells.push({
      date: new Date(year, month, i),
      isCurrentMonth: true
    });
  }
  
  const remaining = 7 - (cells.length % 7);
  if (remaining < 7) {
    for (let i = 1; i <= remaining; i++) {
      cells.push({
        date: new Date(year, month + 1, i),
        isCurrentMonth: false
      });
    }
  }
  
  return cells;
}

function getSessionsForDate(date, sessions) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const end = start + 24 * 60 * 60 * 1000;
  return sessions.filter(s => {
    const ts = coerceTs(s.updatedAt);
    return ts != null && ts >= start && ts < end;
  });
}

function formatTokenCount(n) {
  if (n == null || isNaN(n)) return '0';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

export function updateDashboard(sessions) {
  const grid = $('calendar-grid');
  if (!grid) return;

  // Always normalize; callers may pass filteredSessions / cache shapes
  sessions = asSessionArray(sessions != null ? sessions : getDashboardSessions());

  const header = $('calendar-month-year');
  if (header) {
    const dummyDate = new Date(calYear, calMonth, 1);
    header.textContent = dummyDate.toLocaleDateString([], { month: 'long', year: 'numeric' });
  }

  // Calculate total sessions, unique projects, and total tokens
  const totalSessions = sessions.length;
  const uniqueProjects = new Set(sessions.map(s => s.cwd).filter(Boolean)).size;
  const totalTokens = sessions.reduce((acc, s) => acc + (Number(s.totalTokens) || 0), 0);

  const tSessionsEl = $('stats-total-sessions');
  const tProjectsEl = $('stats-total-projects');
  const tTokensEl = $('stats-total-tokens');

  if (tSessionsEl) tSessionsEl.textContent = String(totalSessions);
  if (tProjectsEl) tProjectsEl.textContent = String(uniqueProjects);
  if (tTokensEl) tTokensEl.textContent = formatTokenCount(totalTokens);

  const cells = getMonthGrid(calYear, calMonth);

  if (!selectedCalDate) {
    selectedCalDate = getLocalDateString(new Date());
  }

  grid.innerHTML = cells.map(cell => {
    const day = cell.date;
    const dateStr = getLocalDateString(day);
    const daySessions = getSessionsForDate(day, sessions);
    const count = daySessions.length;
    const isToday = day.toDateString() === new Date().toDateString();
    const isSelected = dateStr === selectedCalDate;
    
    let bgClass = '';
    let textClass = 'text-base-content/65';
    let borderClass = 'border border-transparent';
    let cursorClass = 'cursor-default';
    let opacityClass = cell.isCurrentMonth ? '' : 'opacity-25';

    if (count > 0) {
      cursorClass = 'cursor-pointer';
      if (count <= 2) {
        bgClass = 'bg-primary/15';
        textClass = 'text-primary font-bold';
        borderClass = 'border border-primary/30';
      } else if (count <= 5) {
        bgClass = 'bg-primary/30';
        textClass = 'text-primary font-bold';
        borderClass = 'border border-primary/50';
      } else {
        bgClass = 'bg-primary/60';
        textClass = 'text-primary-content font-bold';
        borderClass = 'border border-primary/80';
      }
    } else {
      bgClass = 'bg-base-300/25';
      if (cell.isCurrentMonth) cursorClass = 'hover:bg-base-300/50';
    }

    if (isToday) {
      borderClass = 'border-2 border-primary';
    } else if (isSelected) {
      borderClass = 'border-2 border-accent';
    }

    const monthLabel = day.getDate() === 1 ? `<span class="absolute top-0.5 left-1 text-[8px] opacity-60 uppercase">${day.toLocaleDateString([], {month:'short'})}</span>` : '';

    return `
      <div class="aspect-square rounded-xl flex flex-col items-center justify-center p-2 relative transition-all min-h-[50px] md:min-h-[60px] ${bgClass} ${textClass} ${borderClass} ${cursorClass} ${opacityClass}" 
           data-cal-date="${dateStr}" title="${day.toDateString()}: ${count} session(s)">
        ${monthLabel}
        <span class="text-sm font-semibold">${day.getDate()}</span>
        ${count > 0 ? `<span class="text-[10px] mt-0.5 opacity-80 font-medium whitespace-nowrap">${count}s</span>` : ''}
      </div>`;
  }).join('');

  showSelectedDaySessions(sessions);
  updateRecentSessionsList(sessions);
}

export function showSelectedDaySessions(sessions) {
  const titleEl = $('selected-day-title');
  const listEl = $('selected-day-sessions');
  if (!titleEl || !listEl) return;

  const [y, m, d] = selectedCalDate.split('-').map(Number);
  const targetDate = new Date(y, m - 1, d);
  titleEl.textContent = `Activity on ${targetDate.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}`;

  sessions = asSessionArray(sessions);
  const daySessions = getSessionsForDate(targetDate, sessions);
  const selectedTokens = daySessions.reduce((acc, s) => acc + (Number(s.totalTokens) || 0), 0);
  const sTokensEl = $('stats-selected-tokens');
  if (sTokensEl) sTokensEl.textContent = formatTokenCount(selectedTokens);

  if (!daySessions.length) {
    listEl.innerHTML = `<div class="text-center text-xs text-base-content/40 my-auto py-6">No sessions active on this day</div>`;
    return;
  }

  daySessions.sort((a, b) => (coerceTs(b.updatedAt) || 0) - (coerceTs(a.updatedAt) || 0));

  listEl.innerHTML = daySessions.map(s => {
    const ms = coerceTs(s.updatedAt);
    const timeStr = ms != null
      ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';
    const active = ctx.sessionId === s.sessionId;
    return `
      <div class="flex items-center gap-2.5 p-2.5 rounded-lg bg-base-300/40 hover:bg-base-300 border border-base-300/50 cursor-pointer text-left transition-all ${active ? 'border-primary bg-primary/5' : ''}"
           data-session-id="${esc(s.sessionId)}"
           data-session-cwd="${esc(s.cwd || '')}"
           data-session-config-dir="${esc(s.configDir || '')}"
           data-session-agent="${esc(s.agent || 'claude')}"
           data-session-machine="${esc(s.machineId || '')}">
        <div class="flex-shrink-0">${agentBadge(s.agent)}</div>
        <div class="flex-1 min-w-0">
          <div class="text-xs font-semibold truncate text-base-content/90">${esc(sessionDisplayTitle(s))}</div>
          <div class="text-[10px] text-base-content/40 truncate mt-0.5">${esc(s.projectName || shortPath(s.cwd) || 'No workspace')}</div>
        </div>
        <div class="text-[9px] text-base-content/45 font-mono whitespace-nowrap bg-base-300 px-1.5 py-0.5 rounded">${timeStr}</div>
      </div>`;
  }).join('');
}

/** How many sessions in the topbar “最近” quick-jump menu. */
export const RECENT_MENU_LIMIT = 15;

function sortRecentSessions(sessions, limit) {
  return [...asSessionArray(sessions)]
    .filter(s => s && s.sessionId)
    .sort((a, b) => (coerceTs(b.updatedAt) || 0) - (coerceTs(a.updatedAt) || 0))
    .slice(0, limit);
}

export function updateRecentSessionsList(sessions) {
  const container = $('recent-sessions-list');
  if (!container) return;

  const recent = sortRecentSessions(sessions, 6);

  if (!recent.length) {
    container.innerHTML = `<div class="col-span-full text-center text-xs text-base-content/40 py-4">No recent sessions</div>`;
    return;
  }

  container.innerHTML = recent.map(s => {
    const timeStr = formatTime(s.updatedAt);
    const active = ctx.sessionId === s.sessionId;
    return `
      <div class="flex items-center gap-2.5 p-3 rounded-xl bg-base-200 hover:bg-base-300 border border-base-300/80 cursor-pointer text-left transition-all ${active ? 'border-primary bg-primary/5' : ''}"
           data-session-id="${esc(s.sessionId)}"
           data-session-cwd="${esc(s.cwd || '')}"
           data-session-config-dir="${esc(s.configDir || '')}"
           data-session-agent="${esc(s.agent || 'claude')}"
           data-session-machine="${esc(s.machineId || '')}">
        <div class="flex-shrink-0">${agentBadge(s.agent)}</div>
        <div class="flex-1 min-w-0">
          <div class="text-xs font-bold truncate text-base-content/95">${esc(sessionDisplayTitle(s))}</div>
          <div class="text-[10px] text-base-content/40 truncate mt-1">${esc(s.projectName || shortPath(s.cwd) || 'No workspace')}</div>
        </div>
        <div class="text-[9px] text-base-content/40 whitespace-nowrap self-start mt-0.5">${timeStr}</div>
      </div>`;
  }).join('');
}

export function closeRecentMenu() {
  const menu = $('recent-menu');
  if (menu) {
    menu.classList.add('hidden');
    menu.classList.remove('recent-menu-open');
    // clear inline placement for next open
    menu.style.top = '';
    menu.style.left = '';
    menu.style.right = '';
    menu.style.width = '';
    menu.style.maxHeight = '';
  }
  $('recent-menu-backdrop')?.classList.add('hidden');
}

/**
 * Place the panel under the topbar with position:fixed so it is never clipped
 * by #app / #topbar overflow (the previous top-full + fixed combo put it
 * below the viewport on phones — looked like “no response”).
 */
export function positionRecentMenu() {
  const menu = $('recent-menu');
  const topbar = $('topbar');
  if (!menu || !topbar) return;
  const rect = topbar.getBoundingClientRect();
  const gap = 6;
  const top = Math.round(rect.bottom + gap);
  const side = window.matchMedia('(max-width: 640px)').matches ? 8 : null;
  menu.style.top = `${top}px`;
  if (side != null) {
    menu.style.left = `${side}px`;
    menu.style.right = `${side}px`;
  } else {
    // desktop: align under the “最近” button when possible
    const btn = $('btn-recent-sessions');
    const br = btn?.getBoundingClientRect();
    if (br) {
      const width = Math.min(320, window.innerWidth - 16);
      let left = br.left;
      if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
      if (left < 8) left = 8;
      menu.style.left = `${Math.round(left)}px`;
      menu.style.right = 'auto';
      menu.style.width = `${width}px`;
    }
  }
  const maxH = Math.max(160, window.innerHeight - top - 12);
  menu.style.maxHeight = `${Math.min(maxH, Math.round(window.innerHeight * 0.7))}px`;
}

export function openRecentMenu(sessions) {
  const menu = $('recent-menu');
  if (!menu) return;
  renderRecentSessionsMenu(sessions ?? getDashboardSessions());
  menu.classList.remove('hidden');
  menu.classList.add('recent-menu-open');
  positionRecentMenu();
  $('recent-menu-backdrop')?.classList.remove('hidden');
}

export function toggleRecentMenu(sessions) {
  const menu = $('recent-menu');
  if (!menu) return;
  if (menu.classList.contains('hidden')) openRecentMenu(sessions);
  else closeRecentMenu();
}

/** Topbar quick-jump: last N sessions by updatedAt. */
export function renderRecentSessionsMenu(sessions) {
  const listEl = $('recent-menu-list');
  const emptyEl = $('recent-menu-empty');
  const countEl = $('recent-menu-count');
  if (!listEl) return;

  const recent = sortRecentSessions(sessions ?? getDashboardSessions(), RECENT_MENU_LIMIT);
  if (countEl) countEl.textContent = recent.length ? `${recent.length}` : '';

  if (!recent.length) {
    listEl.innerHTML = '';
    emptyEl?.classList.remove('hidden');
    return;
  }
  emptyEl?.classList.add('hidden');

  listEl.innerHTML = recent.map(s => {
    const timeStr = formatTime(s.updatedAt);
    const active = ctx.sessionId === s.sessionId
      && (!s.machineId || !ctx.machineId || s.machineId === ctx.machineId);
    const machine = s.machineId
      ? `<span class="text-[9px] font-mono text-base-content/35 truncate max-w-[4.5rem]" title="${esc(s.machineId)}">@${esc(s.machineId)}</span>`
      : '';
    return `
      <button type="button"
        class="recent-menu-item w-full text-left px-2 py-1.5 rounded-md flex items-start gap-2
               ${active ? 'bg-primary/15 text-primary' : 'hover:bg-base-200'}"
        data-session-id="${esc(s.sessionId)}"
        data-session-cwd="${esc(s.cwd || '')}"
        data-session-config-dir="${esc(s.configDir || '')}"
        data-session-agent="${esc(s.agent || 'claude')}"
        data-session-machine="${esc(s.machineId || '')}">
        <span class="flex-shrink-0 mt-0.5">${agentBadge(s.agent)}</span>
        <span class="flex-1 min-w-0">
          <span class="block text-xs font-semibold truncate leading-snug">${esc(sessionDisplayTitle(s))}</span>
          <span class="block text-[10px] text-base-content/40 truncate mt-0.5">${esc(s.projectName || shortPath(s.cwd) || '—')}</span>
        </span>
        <span class="flex flex-col items-end gap-0.5 flex-shrink-0 self-start">
          <span class="text-[9px] text-base-content/40 whitespace-nowrap">${esc(timeStr)}</span>
          ${machine}
          ${active ? '<span class="text-[9px] opacity-70">当前</span>' : ''}
        </span>
      </button>`;
  }).join('');
}

export function setCalMonthYear(m, y) { calMonth = m; calYear = y; }
export function setSelectedCalDate(d) { selectedCalDate = d; }

/** Mutate calendar month by delta months (imported bindings are read-only). */
export function shiftCalMonth(delta) {
  calMonth += delta;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  else if (calMonth > 11) { calMonth = 0; calYear++; }
}
