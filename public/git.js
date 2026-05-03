// git.js — Git tab
import { signal, effect, delegate, esc, $ } from './lib.js';
import { currentProject, currentTab } from './state.js';
import { api } from './api.js';

const diffStaged = signal(false);

function gitRenderer(data) {
  if (!data) return '';
  if (!data.isGit) return '<div class="p-4 text-sm text-base-content/50">Not a git repository</div>';
  const statusColor = { M: 'text-warning', D: 'text-error' };
  return `
    <div class="px-4 py-2 text-xs text-base-content/50 border-b border-base-300">
      Branch: <span class="text-success font-semibold">${esc(data.branch)}</span>
    </div>
    ${!data.files.length
      ? '<div class="p-4 text-sm text-base-content/50">Working tree clean</div>'
      : data.files.map(f => `
        <div class="flex items-center gap-3 px-4 py-1.5 text-sm">
          <span class="font-mono text-xs w-5 flex-shrink-0 ${statusColor[f.status] || 'text-success'}">${esc(f.status)}</span>
          <span class="break-all">${esc(f.file)}</span>
        </div>`).join('')
    }
    <div class="border-t border-base-300 p-4">
      <div class="flex gap-4 text-xs mb-3">
        <span id="diff-unstaged" class="cursor-pointer text-primary">Unstaged</span>
        <span id="diff-staged"   class="cursor-pointer text-base-content/50">Staged</span>
      </div>
      <div id="diff-content" class="font-mono text-xs overflow-auto max-h-[40vh] whitespace-pre"></div>
    </div>`;
}

function renderDiff(diff) {
  return diff.split('\n').map(line => {
    if (line.startsWith('+') && !line.startsWith('+++')) return `<span class="diff-add">${esc(line)}</span>`;
    if (line.startsWith('-') && !line.startsWith('---')) return `<span class="diff-del">${esc(line)}</span>`;
    if (line.startsWith('@@'))                           return `<span class="diff-hunk">${esc(line)}</span>`;
    if (/^(diff |index |---|[+]{3})/.test(line))         return `<span class="diff-head">${esc(line)}</span>`;
    return `<span>${esc(line)}</span>`;
  }).join('\n');
}


export function initGitTab() {
  // Git status panel
  let statusCtrl = null;
  effect(() => {
    const tab  = currentTab.value;
    const proj = currentProject.value;
    const area = $('git-area');
    if (!area) return;
    statusCtrl?.abort(); statusCtrl = new AbortController();
    if (tab !== 'git' || !proj) { area.innerHTML = ''; return; }
    area.innerHTML = '<div style="padding:14px;font-size:12px;opacity:.5">Loading…</div>';
    api('GET', `/api/projects/${proj.id}/git/status?root=${encodeURIComponent(proj.path)}`, undefined, statusCtrl.signal)
      .then(d => { if (!statusCtrl.signal.aborted) area.innerHTML = gitRenderer(d); })
      .catch(e => { if (!statusCtrl.signal.aborted && e?.name !== 'AbortError') area.innerHTML = `<div style="padding:14px;font-size:12px;color:#f85149">${esc(e?.message ?? e)}</div>`; });
    return () => statusCtrl?.abort();
  });

  // Diff panel — lazy target (#diff-content exists only after gitRenderer runs)
  let diffCtrl = null;
  effect(() => {
    const proj   = currentProject.value;
    const staged = diffStaged.value;
    const target = $('diff-content');
    if (!target || !proj) return;
    diffCtrl?.abort(); diffCtrl = new AbortController();
    api('GET', `/api/projects/${proj.id}/git/diff?root=${encodeURIComponent(proj.path)}${staged ? '&staged=true' : ''}`, undefined, diffCtrl.signal)
      .then(d => { if (!diffCtrl.signal.aborted) target.innerHTML = d?.diff ? renderDiff(d.diff) : '<span class="text-base-content/40">No changes</span>'; })
      .catch(e => { if (!diffCtrl.signal.aborted && e?.name !== 'AbortError') target.innerHTML = `<span style="color:#f85149">${esc(e?.message ?? e)}</span>`; });
    return () => diffCtrl?.abort();
  });

  delegate.on('click', '#diff-unstaged, #diff-staged', (_, el) => {
    const staged = el.id === 'diff-staged';
    diffStaged.value = staged;
    $('diff-unstaged').className = `cursor-pointer ${staged ? 'text-base-content/50' : 'text-primary'}`;
    $('diff-staged').className   = `cursor-pointer ${staged ? 'text-primary' : 'text-base-content/50'}`;
  });
}
