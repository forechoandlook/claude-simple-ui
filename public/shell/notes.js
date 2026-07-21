// shell/notes.js — project goal/notes + session favorites/notes/title (rename)
import { esc, $ } from '../lib.js';
import {
  currentProject, sessionMetaMap, metaKey, getSessionMeta,
  currentAgent, ctx,
} from '../state.js';
import { api } from '../api.js';

export let activeProjectGoal = '';
export let activeProjectNotes = '';

export function setProjectNoteFields(goal, notes) {
  activeProjectGoal = goal || '';
  activeProjectNotes = notes || '';
}

export async function fetchProjectNotes(rootPath) {
  const bar = $('project-notes-bar');
  if (!bar) return;

  try {
    const res = await api('GET', `/api/projects/notes?root=${encodeURIComponent(rootPath)}`);
    activeProjectGoal = res.goal || '';
    activeProjectNotes = res.notes || '';
    renderProjectNotesDisplayMode();
    bar.style.display = 'flex';
  } catch (err) {
    console.error('Error fetching project notes:', err);
    bar.style.display = 'none';
  }
}

export function renderProjectNotesDisplayMode() {
  const bar = $('project-notes-bar');
  if (!bar) return;

  const goalText = activeProjectGoal || 'No goal yet — click Edit';
  const notesText = activeProjectNotes || '';
  bar.innerHTML = `
    <div class="flex items-start gap-2 w-full">
      <div class="flex-1 min-w-0">
        <div class="truncate">
          <span class="font-bold text-base-content/40 uppercase mr-1">Goal:</span>
          <span id="project-goal-text" class="text-base-content/80 cursor-pointer hover:underline" title="Click to edit">${esc(goalText)}</span>
        </div>
        ${notesText
          ? `<div class="mt-0.5 text-base-content/55 line-clamp-2 whitespace-pre-wrap" id="project-notes-text" title="${esc(notesText)}"><span class="font-bold text-base-content/35 uppercase mr-1">Notes:</span>${esc(notesText)}</div>`
          : `<div class="mt-0.5 text-base-content/35 italic text-[11px]" id="project-notes-text">No project notes</div>`}
      </div>
      <button id="btn-edit-project-notes" class="btn btn-ghost btn-xs px-1.5 hover:bg-base-300 flex-shrink-0">Edit</button>
    </div>
  `;
}

export function renderProjectNotesEditMode() {
  const bar = $('project-notes-bar');
  if (!bar) return;

  bar.innerHTML = `
    <div class="flex flex-col gap-1.5 w-full">
      <div class="flex items-center gap-2">
        <span class="text-[10px] font-bold text-base-content/40 uppercase w-12 flex-shrink-0">Goal</span>
        <input id="project-goal-input" type="text" class="input input-xs input-bordered flex-1 text-xs"
               placeholder="One-line project goal…" value="${esc(activeProjectGoal)}">
      </div>
      <div class="flex items-start gap-2">
        <span class="text-[10px] font-bold text-base-content/40 uppercase w-12 flex-shrink-0 mt-1">Notes</span>
        <textarea id="project-notes-input" rows="2" class="textarea textarea-xs textarea-bordered flex-1 text-xs leading-snug"
                  placeholder="Longer project notes (stack, links, status…)">${esc(activeProjectNotes)}</textarea>
      </div>
      <div class="flex items-center gap-1 justify-end">
        <button id="btn-save-project-notes" class="btn btn-primary btn-xs px-2">Save</button>
        <button id="btn-cancel-project-notes" class="btn btn-ghost btn-xs px-2">Cancel</button>
      </div>
    </div>
  `;

  $('project-goal-input')?.focus();
}

export async function loadSessionMetaMap() {
  try {
    const db = await api('GET', '/api/sessions/meta');
    sessionMetaMap.value = db || {};
  } catch (e) {
    console.warn('session meta load failed', e);
  }
}

export function renderSessionNotesBar() {
  const bar = $('session-notes-bar');
  if (!bar) return;
  const sid = ctx.sessionId;
  const agent = ctx.agent || currentAgent.peek() || 'claude';
  if (!sid) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }
  // Don't clobber in-progress inline rename on the bar
  if (bar.querySelector('.session-rename-input')) return;

  const meta = getSessionMeta(agent, sid);
  const note = (meta.notes || '').trim();
  const fav = !!meta.favorite;
  const title = (meta.title || '').trim();
  const showTitle = title || sid.slice(0, 8);
  bar.style.display = 'flex';
  bar.innerHTML = `
    <div class="flex-1 min-w-0 flex items-center gap-2">
      <button type="button" class="session-fav-btn ${fav ? 'is-fav' : ''}" data-fav-toggle="1"
              data-fav-session-id="${esc(sid)}" data-fav-session-agent="${esc(agent)}"
              title="${fav ? 'Unfavorite' : 'Favorite'}">${fav ? '★' : '☆'}</button>
      <span id="session-title-display"
            class="session-title-inline max-w-[40%] truncate font-semibold text-base-content/85 cursor-text hover:text-primary"
            title="Click to rename"
            data-rename-bar="1">${esc(showTitle)}</span>
      <span class="font-bold text-base-content/40 uppercase flex-shrink-0">Note:</span>
      <span class="truncate text-base-content/70 ${note ? '' : 'italic text-base-content/40'}"
            id="session-notes-text" title="${esc(note || 'Add a note for this session')}">${esc(note || 'No session note')}</span>
    </div>
    <button id="btn-edit-session-notes" class="btn btn-ghost btn-xs px-1.5">Note</button>
  `;
}

export function renderSessionNotesEditMode() {
  const bar = $('session-notes-bar');
  if (!bar || !ctx.sessionId) return;
  const agent = ctx.agent || currentAgent.peek() || 'claude';
  const meta = getSessionMeta(agent, ctx.sessionId);
  bar.innerHTML = `
    <input id="session-notes-input" type="text" class="input input-xs input-bordered flex-1 text-xs"
           placeholder="Note for this session…" value="${esc(meta.notes || '')}">
    <button id="btn-save-session-notes" class="btn btn-primary btn-xs px-2">Save</button>
    <button id="btn-cancel-session-notes" class="btn btn-ghost btn-xs px-2">Cancel</button>
  `;
  const input = $('session-notes-input');
  input?.focus();
  input?.select();
}

export async function toggleSessionFavorite(sessionId, agent) {
  const key = metaKey(agent, sessionId);
  const prev = sessionMetaMap.peek()?.[key] || { favorite: false, notes: '', title: '' };
  const nextFav = !prev.favorite;
  // optimistic
  sessionMetaMap.value = {
    ...sessionMetaMap.peek(),
    [key]: { ...prev, favorite: nextFav, updatedAt: Date.now() },
  };
  try {
    await api('PUT', '/api/sessions/meta', { sessionId, agent, favorite: nextFav });
  } catch (e) {
    sessionMetaMap.value = { ...sessionMetaMap.peek(), [key]: prev };
    alert(`Favorite failed: ${e.message}`);
  }
  if (ctx.sessionId === sessionId) renderSessionNotesBar();
}

export async function saveSessionNotes(sessionId, agent, notes) {
  const key = metaKey(agent, sessionId);
  const prev = sessionMetaMap.peek()?.[key] || { favorite: false, notes: '', title: '' };
  try {
    const res = await api('PUT', '/api/sessions/meta', { sessionId, agent, notes });
    sessionMetaMap.value = {
      ...sessionMetaMap.peek(),
      [key]: {
        favorite: res.favorite ?? prev.favorite,
        notes: res.notes ?? notes,
        title: res.title ?? prev.title ?? '',
        updatedAt: Date.now(),
      },
    };
  } catch (e) {
    alert(`Save note failed: ${e.message}`);
    return false;
  }
  return true;
}

/**
 * Rename session via meta title map (does not rewrite agent transcript files).
 * Empty title clears the mapping and restores original display.
 */
export async function renameSession(sessionId, agent, title, { machineId } = {}) {
  if (!sessionId) return false;
  const key = metaKey(agent, sessionId, machineId);
  const prev = sessionMetaMap.peek()?.[key] || { favorite: false, notes: '', title: '' };
  const nextTitle = String(title || '').trim().slice(0, 200);
  // optimistic
  sessionMetaMap.value = {
    ...sessionMetaMap.peek(),
    [key]: { ...prev, title: nextTitle, updatedAt: Date.now() },
  };
  try {
    const res = await api('PUT', '/api/sessions/meta', { sessionId, agent, title: nextTitle });
    sessionMetaMap.value = {
      ...sessionMetaMap.peek(),
      [key]: {
        favorite: res.favorite ?? prev.favorite,
        notes: res.notes ?? prev.notes ?? '',
        title: res.title !== undefined ? res.title : nextTitle,
        updatedAt: Date.now(),
      },
    };
    // If server dropped empty entry, keep local clear
    if (!res.title && !res.favorite && !res.notes) {
      const map = { ...sessionMetaMap.peek() };
      if (!nextTitle && !prev.favorite && !(prev.notes || '').trim()) {
        delete map[key];
        sessionMetaMap.value = map;
      }
    }
  } catch (e) {
    sessionMetaMap.value = { ...sessionMetaMap.peek(), [key]: prev };
    alert(`Rename failed: ${e.message}`);
    return false;
  }
  if (ctx.sessionId === sessionId) renderSessionNotesBar();
  return true;
}

/**
 * Inline rename — replace title in-place with an input (no dialog).
 * Enter / blur = save; Escape = cancel. Empty value clears custom name.
 *
 * @param {{ sessionId: string, agent?: string, machineId?: string|null, fallbackDisplay?: string, mountEl: HTMLElement }} opts
 */
export function startInlineRename({
  sessionId,
  agent = 'claude',
  machineId = null,
  fallbackDisplay = '',
  mountEl,
} = {}) {
  if (!sessionId || !mountEl) return;
  // One editor at a time
  document.querySelectorAll('.session-rename-input').forEach(el => {
    el.dispatchEvent(new CustomEvent('session-rename-cancel', { bubbles: true }));
  });

  const meta = getSessionMeta(agent, sessionId, machineId);
  const current = (meta.title || '').trim() || fallbackDisplay || sessionId.slice(0, 8);
  const prevHtml = mountEl.innerHTML;
  const prevClass = mountEl.className;

  mountEl.classList.add('session-rename-active');
  mountEl.innerHTML = `<input type="text" class="session-rename-input input input-xs input-bordered w-full min-w-0 text-xs font-mono"
    value="${esc(current)}"
    placeholder="Session name (empty = original)"
    maxlength="200"
    data-rename-input="1"
    data-rename-session-id="${esc(sessionId)}"
    data-rename-session-agent="${esc(agent)}"
    data-rename-session-machine="${esc(machineId || '')}"
    autocomplete="off" spellcheck="false" />`;

  const input = mountEl.querySelector('.session-rename-input');
  if (!input) return;

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const value = save ? input.value : current;
    // Drop editor so list/bar effects can repaint
    mountEl.className = prevClass;
    if (!save) {
      mountEl.innerHTML = prevHtml;
      return;
    }
    await renameSession(sessionId, agent, value, { machineId });
    // Clear editors so list/bar re-render is not blocked
    document.querySelectorAll('.session-rename-input').forEach(n => n.remove());
    if (ctx.sessionId === sessionId) renderSessionNotesBar();
    sessionMetaMap.value = { ...sessionMetaMap.peek() };
  };

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  input.addEventListener('session-rename-cancel', () => finish(false));
  // blur after a tick so click on another control still works
  input.addEventListener('blur', () => {
    setTimeout(() => finish(true), 0);
  });

  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

/** @deprecated use startInlineRename — kept name for call sites */
export function promptRenameSession(sessionId, agent, opts = {}) {
  // Prefer explicit mount; otherwise try bar / active row
  let mountEl = opts.mountEl;
  if (!mountEl && ctx.sessionId === sessionId) {
    mountEl = document.getElementById('session-title-display');
  }
  if (!mountEl) {
    mountEl = document.querySelector(
      `.session-title-wrap[data-session-id="${CSS.escape(sessionId)}"]`,
    );
  }
  if (!mountEl) return;
  startInlineRename({
    sessionId,
    agent,
    machineId: opts.machineId,
    fallbackDisplay: opts.fallbackDisplay,
    mountEl,
  });
}
