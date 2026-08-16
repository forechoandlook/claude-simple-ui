import { $, delegate, esc } from './lib.js';
import { api } from './api.js';
import { coerceTs } from './shell/util.js';

let notifications = [];
let unreadCount = 0;
let openSession = null;

function fmtTime(ts) {
  const ms = coerceTs(ts);
  if (ms == null) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

function updateBadge() {
  const badge = $('notifications-badge');
  if (!badge) return;
  if (!unreadCount) {
    badge.classList.add('hidden');
    badge.textContent = '0';
    return;
  }
  badge.classList.remove('hidden');
  badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
}

function positionNotificationsMenu() {
  const menu = $('notifications-menu');
  const btn = $('btn-notifications');
  const topbar = $('topbar');
  if (!menu || !btn || !topbar) return;
  const btnRect = btn.getBoundingClientRect();
  const topbarRect = topbar.getBoundingClientRect();
  const width = Math.min(416, window.innerWidth - 16);
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, btnRect.right - width));
  menu.style.top = `${Math.round(topbarRect.bottom + 8)}px`;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.width = `${Math.round(width)}px`;
}

function renderNotifications() {
  const listEl = $('notifications-menu-list');
  const emptyEl = $('notifications-menu-empty');
  if (!listEl || !emptyEl) return;
  if (!notifications.length) {
    listEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
    updateBadge();
    return;
  }
  emptyEl.classList.add('hidden');
  listEl.innerHTML = notifications.map((item) => `
    <button type="button"
      class="w-full text-left rounded-lg border px-3 py-2 transition-colors hover:bg-base-200/70 ${item.unread ? 'border-primary/35 bg-primary/5' : 'border-base-300 bg-base-100'}"
      data-notification-id="${esc(item.id)}"
      data-notification-session="${esc(item.sessionId || '')}"
      data-notification-agent="${esc(item.agent || 'claude')}"
      data-notification-cwd="${esc(item.cwd || '')}"
      data-notification-machine="${esc(item.machineId || '')}">
      <div class="flex items-start gap-2">
        <span class="text-sm leading-5">🔔</span>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="text-xs font-semibold truncate">${esc(item.title || 'Session done')}</span>
            ${item.unread ? '<span class="inline-block w-2 h-2 rounded-full bg-primary flex-shrink-0"></span>' : ''}
          </div>
          ${item.body ? `<div class="text-[11px] text-base-content/55 mt-0.5 line-clamp-2">${esc(item.body)}</div>` : ''}
          <div class="flex items-center gap-2 mt-1 text-[10px] text-base-content/35">
            ${item.projectName ? `<span class="font-mono truncate">${esc(item.projectName)}</span>` : ''}
            ${item.machineId ? `<span class="px-1 py-0.5 rounded bg-base-300 text-base-content/55 font-mono">${esc(item.machineId)}</span>` : ''}
            <span>${esc(fmtTime(item.createdAt))}</span>
          </div>
        </div>
      </div>
    </button>`).join('');
  updateBadge();
}

export function closeNotificationsMenu() {
  $('notifications-menu')?.classList.add('hidden');
  $('notifications-backdrop')?.classList.add('hidden');
  $('btn-notifications')?.setAttribute('aria-expanded', 'false');
}

export function openNotificationsMenu() {
  positionNotificationsMenu();
  $('notifications-menu')?.classList.remove('hidden');
  $('notifications-backdrop')?.classList.remove('hidden');
  $('btn-notifications')?.setAttribute('aria-expanded', 'true');
}

export function toggleNotificationsMenu() {
  const menu = $('notifications-menu');
  if (!menu) return;
  if (menu.classList.contains('hidden')) openNotificationsMenu();
  else closeNotificationsMenu();
}

function mergeNotifications(rows) {
  const map = new Map();
  for (const item of rows || []) {
    if (!item?.id) continue;
    map.set(String(item.id), item);
  }
  notifications = [...map.values()].sort((a, b) => (coerceTs(b.createdAt) || 0) - (coerceTs(a.createdAt) || 0));
  unreadCount = notifications.reduce((sum, item) => sum + (item.unread ? 1 : 0), 0);
  renderNotifications();
}

export async function refreshNotifications() {
  try {
    const data = await api('GET', '/api/notifications?limit=80');
    notifications = Array.isArray(data?.notifications) ? data.notifications : [];
    unreadCount = Number(data?.unreadCount) || notifications.reduce((sum, item) => sum + (item.unread ? 1 : 0), 0);
    renderNotifications();
  } catch {
    notifications = [];
    unreadCount = 0;
    renderNotifications();
  }
}

async function markNotificationsRead(ids = null) {
  const data = await api('POST', '/api/notifications/read', ids?.length ? { ids } : {});
  notifications = Array.isArray(data?.notifications) ? data.notifications : notifications.map(item => (
    !ids || ids.includes(item.id) ? { ...item, unread: false } : item
  ));
  unreadCount = Number(data?.unreadCount) || notifications.reduce((sum, item) => sum + (item.unread ? 1 : 0), 0);
  renderNotifications();
}

function maybeShowBrowserNotification(item) {
  if (typeof Notification === 'undefined') return;
  if (document.visibilityState === 'visible') return;
  if (Notification.permission !== 'granted') return;
  try {
    const n = new Notification(item.title || 'Session done', {
      body: item.body || item.projectName || item.sessionId || '',
      tag: item.id,
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // ignore
  }
}

export function pushNotification(item) {
  if (!item?.id) return;
  const existing = notifications.find(row => row.id === item.id);
  if (existing) {
    mergeNotifications([item, ...notifications.filter(row => row.id !== item.id)]);
    return;
  }
  mergeNotifications([item, ...notifications]);
  maybeShowBrowserNotification(item);
}

export function initNotifications(opts = {}) {
  openSession = typeof opts.openSession === 'function' ? opts.openSession : null;
  renderNotifications();
  refreshNotifications();

  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    document.addEventListener('click', () => {
      try { Notification.requestPermission().catch(() => {}); } catch {}
    }, { once: true });
  }

  delegate.on('click', '#notifications-backdrop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeNotificationsMenu();
  });

  delegate.on('click', '#btn-notifications-read-all', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await markNotificationsRead();
  });

  delegate.on('click', '[data-notification-id]', async (_, el) => {
    const id = el.dataset.notificationId;
    if (!id) return;
    await markNotificationsRead([id]);
    closeNotificationsMenu();
    if (!openSession || !el.dataset.notificationSession) return;
    openSession(
      el.dataset.notificationSession,
      el.dataset.notificationCwd || null,
      null,
      el.dataset.notificationAgent || 'claude',
      el.dataset.notificationMachine || null,
    );
  });

  document.addEventListener('click', (e) => {
    const menu = $('notifications-menu');
    const btn = $('btn-notifications');
    const target = e.target;
    if (!menu || menu.classList.contains('hidden')) return;
    if (menu.contains(target) || btn?.contains(target)) return;
    closeNotificationsMenu();
  });

  window.addEventListener('resize', () => {
    if ($('notifications-menu') && !$('notifications-menu').classList.contains('hidden')) {
      positionNotificationsMenu();
    }
  });
}
