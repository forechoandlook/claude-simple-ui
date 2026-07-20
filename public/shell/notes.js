// shell/notes.js — project goal/notes + session favorites/notes
import { esc, $ } from '../lib.js';
import { currentProject, sessionMetaMap, metaKey, getSessionMeta, currentAgent, ctx } from '../state.js';
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
  const meta = getSessionMeta(agent, sid);
  const note = (meta.notes || '').trim();
  const fav = !!meta.favorite;
  bar.style.display = 'flex';
  bar.innerHTML = `
    <div class="flex-1 min-w-0 flex items-center gap-2">
      <button type="button" class="session-fav-btn ${fav ? 'is-fav' : ''}" data-fav-toggle="1"
              data-fav-session-id="${esc(sid)}" data-fav-session-agent="${esc(agent)}"
              title="${fav ? 'Unfavorite' : 'Favorite'}">${fav ? '★' : '☆'}</button>
      <span class="font-bold text-base-content/40 uppercase flex-shrink-0">Session:</span>
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
  const prev = sessionMetaMap.peek()?.[key] || { favorite: false, notes: '' };
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
  const prev = sessionMetaMap.peek()?.[key] || { favorite: false, notes: '' };
  try {
    const res = await api('PUT', '/api/sessions/meta', { sessionId, agent, notes });
    sessionMetaMap.value = {
      ...sessionMetaMap.peek(),
      [key]: { favorite: res.favorite ?? prev.favorite, notes: res.notes ?? notes, updatedAt: Date.now() },
    };
  } catch (e) {
    alert(`Save note failed: ${e.message}`);
    return false;
  }
  return true;
}
