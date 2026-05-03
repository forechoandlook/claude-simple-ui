// git.js — Git tab
import { signal, effect, delegate, esc, $ } from './lib.js';
import { currentProject, currentTab, gitRoot } from './state.js';
import { api } from './api.js';

const diffStaged = signal(false);

function renderGraph(raw) {
  if (!raw) return '<span class="text-base-content/40">No commits</span>';
  return raw.split('\n').map(line => {
    const escaped = esc(line);
    return escaped
      .replace(/\b([0-9a-f]{7})\b/, '<span class="gh">$1</span>')
      .replace(/\(([^)]*)\)/, '<span style="color:oklch(var(--wa))">($1)</span>');
  }).join('\n');
}

function gitRenderer(data) {
  if (!data) return '';
  if (!data.isGit) return '<div class="p-4 text-sm text-base-content/50">Not a git repository</div>';
  const statusColor = { M: 'text-warning', D: 'text-error' };
  return `
    <div class="px-4 py-2 text-xs text-base-content/50 border-b border-base-300">
      Branch: <span class="text-success font-semibold">${esc(data.branch)}</span>
    </div>
    ${!data.files.length
      ? '<div class="px-4 py-2 text-sm text-base-content/50">Working tree clean</div>'
      : data.files.map(f => `
        <div class="flex items-center gap-3 px-4 py-1 text-sm">
          <span class="font-mono text-xs w-5 flex-shrink-0 ${statusColor[f.status] || 'text-success'}">${esc(f.status)}</span>
          <span class="break-all">${esc(f.file)}</span>
        </div>`).join('')
    }
    <div class="border-t border-base-300 p-4">
      <div class="flex gap-4 text-xs mb-3">
        <span id="diff-unstaged" class="cursor-pointer text-primary">Unstaged</span>
        <span id="diff-staged"   class="cursor-pointer text-base-content/50">Staged</span>
      </div>
      <div id="diff-content" class="font-mono text-xs overflow-auto max-h-[30vh] whitespace-pre"></div>
    </div>
    <div class="border-t border-base-300">
      <div class="flex items-center justify-between px-4 py-2 text-xs text-base-content/50 cursor-pointer select-none" id="git-graph-toggle">
        <span class="uppercase tracking-wider font-medium">Git Graph</span>
        <span id="git-graph-chevron" class="text-[10px]">▶</span>
      </div>
      <div id="git-graph-panel" class="hidden px-4 pb-4">
        <div id="git-graph-content" class="git-graph overflow-x-auto max-h-[35vh] overflow-y-auto">
          <span class="text-base-content/40">Loading…</span>
        </div>
      </div>
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
  effect(() => {
    const tab  = currentTab.value;
    const proj = currentProject.value;
    const root = gitRoot.value || proj?.path;
    const area = $('git-area');
    if (!area) return;
    const ctrl = new AbortController();
    if (tab !== 'git' || !root) { area.innerHTML = ''; return () => ctrl.abort(); }
    const id = proj?.id || '_';
    area.innerHTML = '<div class="p-4 text-xs text-base-content/40">Loading…</div>';
    api('GET', `/api/projects/${id}/git/status?root=${encodeURIComponent(root)}`, undefined, ctrl.signal)
      .then(d => { if (!ctrl.signal.aborted) area.innerHTML = gitRenderer(d); })
      .catch(e => { if (!ctrl.signal.aborted && e?.name !== 'AbortError')
        area.innerHTML = `<div class="p-4 text-xs text-error">${esc(e?.message ?? String(e))}</div>`; });
    return () => ctrl.abort();
  });

  // Diff panel
  effect(() => {
    const proj   = currentProject.value;
    const root   = gitRoot.value || proj?.path;
    const staged = diffStaged.value;
    const target = $('diff-content');
    if (!target || !root) return;
    const id   = proj?.id || '_';
    const ctrl = new AbortController();
    api('GET', `/api/projects/${id}/git/diff?root=${encodeURIComponent(root)}${staged ? '&staged=true' : ''}`, undefined, ctrl.signal)
      .then(d => { if (!ctrl.signal.aborted) target.innerHTML = d?.diff ? renderDiff(d.diff) : '<span class="text-base-content/40">No changes</span>'; })
      .catch(e => { if (!ctrl.signal.aborted && e?.name !== 'AbortError')
        target.innerHTML = `<span class="text-error">${esc(e?.message ?? String(e))}</span>`; });
    return () => ctrl.abort();
  });

  delegate.on('click', '#diff-unstaged, #diff-staged', (_, el) => {
    const staged = el.id === 'diff-staged';
    diffStaged.value = staged;
    $('diff-unstaged').className = `cursor-pointer ${staged ? 'text-base-content/50' : 'text-primary'}`;
    $('diff-staged').className   = `cursor-pointer ${staged ? 'text-primary' : 'text-base-content/50'}`;
  });

  // Git graph — load on expand
  delegate.on('click', '#git-graph-toggle', () => {
    const panel   = $('git-graph-panel');
    const chevron = $('git-graph-chevron');
    const open    = panel.classList.toggle('hidden');
    chevron.textContent = open ? '▶' : '▼';
    if (!open) loadGraph();
  });
}

function loadGraph() {
  const proj    = currentProject.peek();
  const root    = gitRoot.peek() || proj?.path;
  const content = $('git-graph-content');
  if (!root || !content) return;
  const id = proj?.id || '_';
  content.innerHTML = '<span class="text-base-content/40">Loading…</span>';
  api('GET', `/api/projects/${id}/git/log?root=${encodeURIComponent(root)}`)
    .then(d => { content.innerHTML = d.graph ? renderGraph(d.graph) : '<span class="text-base-content/40">No commits</span>'; })
    .catch(e => { content.innerHTML = `<span class="text-error">${esc(e.message)}</span>`; });
}
