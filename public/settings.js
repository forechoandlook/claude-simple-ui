// settings.js — Workspace settings modal
import { esc, $ } from './lib.js';
import { api } from './api.js';
import { workspacesData } from './state.js';
import { setCachedWorkspaces } from './cache.js';

export function initSettings() {
  document.getElementById('root').insertAdjacentHTML('beforeend', `
    <dialog id="modal-settings" class="modal">
      <div class="modal-box max-w-lg">
        <h3 class="font-bold text-base mb-4">⚙️ Settings — Workspaces</h3>
        <div id="ws-list" class="flex flex-col gap-2 mb-4"></div>
        <div class="border-t border-base-300 pt-4">
          <div class="text-xs uppercase tracking-wider text-base-content/50 mb-2">Add workspace</div>
          <div class="flex gap-2 mb-2">
            <input id="ws-new-name" type="text" placeholder="Name (e.g. personal)" class="input input-sm input-bordered flex-1">
            <input id="ws-new-dir"  type="text" placeholder="~/.claude-personal"    class="input input-sm input-bordered flex-[2]">
            <button id="ws-add-btn" class="btn btn-primary btn-sm">Add</button>
          </div>
          <div id="ws-error" class="alert alert-error text-xs py-1.5 hidden"></div>
        </div>
        <div class="modal-action">
          <form method="dialog"><button class="btn btn-ghost btn-sm">Close</button></form>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop"><button>close</button></form>
    </dialog>`);

  renderWsList();

  document.getElementById('ws-add-btn').addEventListener('click', addWorkspace);
  document.getElementById('ws-new-name').addEventListener('keydown', e => { if (e.key === 'Enter') addWorkspace(); });
  document.getElementById('ws-new-dir').addEventListener('keydown',  e => { if (e.key === 'Enter') addWorkspace(); });
}

function renderWsList() {
  const el = $('ws-list');
  if (!el) return;
  const wss = workspacesData.peek();
  if (!wss.length) { el.innerHTML = '<div class="text-xs text-base-content/40">No workspaces configured</div>'; return; }
  el.innerHTML = wss.map(w => `
    <div class="flex items-center gap-2 px-3 py-2 bg-base-200 rounded-lg">
      <div class="flex-1 min-w-0">
        <div class="text-sm font-medium">${esc(w.name)}</div>
        <div class="text-xs font-mono text-base-content/50 truncate">${esc(w.configDir)}</div>
      </div>
      ${wss.length > 1
        ? `<button class="btn btn-ghost btn-xs text-error" data-ws-delete="${esc(w.id)}">✕</button>`
        : '<span class="text-[10px] text-base-content/30">default</span>'}
    </div>`).join('');

  el.querySelectorAll('[data-ws-delete]').forEach(btn => {
    btn.addEventListener('click', () => deleteWorkspace(btn.dataset.wsDelete));
  });
}

async function addWorkspace() {
  const name   = $('ws-new-name').value.trim();
  const dir    = $('ws-new-dir').value.trim();
  const errEl  = $('ws-error');
  errEl.classList.add('hidden');
  if (!name || !dir) { errEl.textContent = 'Name and path are required'; errEl.classList.remove('hidden'); return; }
  try {
    const ws = await api('POST', '/api/workspaces', { name, configDir: dir });
    workspacesData.value = [...workspacesData.peek(), ws];
    setCachedWorkspaces(workspacesData.peek());
    $('ws-new-name').value = '';
    $('ws-new-dir').value  = '';
    renderWsList();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
}

async function deleteWorkspace(id) {
  try {
    await api('DELETE', `/api/workspaces/${id}`);
    workspacesData.value = workspacesData.peek().filter(w => w.id !== id);
    setCachedWorkspaces(workspacesData.peek());
    renderWsList();
  } catch (e) {
    alert(e.message);
  }
}

export function openSettings() {
  renderWsList();
  $('modal-settings')?.showModal();
}
