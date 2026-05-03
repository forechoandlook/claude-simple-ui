// files.js — Files tab
import { signal, effect, delegate, esc, $ } from './lib.js';
import { currentProject, currentTab } from './state.js';
import { api } from './api.js';

export const filesPath   = signal('');   // current directory
export const viewingFile = signal(null); // null = dir listing, string = file path

function render(result) {
  if (!result) return '';
  if (result.type === 'file')
    return `<pre class="p-4 font-mono text-xs leading-relaxed overflow-auto">${esc(result.content)}</pre>`;
  const { files } = result;
  if (!files.length) return '<div class="p-4 text-xs text-base-content/40">Empty</div>';
  files.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
  return files.map(f => `
    <div class="flex items-center gap-2 px-4 py-2 cursor-pointer hover:bg-base-300 text-sm ${f.isDir ? 'text-primary' : ''}"
         ${f.isDir ? `data-dir-path="${esc(f.path)}"` : `data-file-path="${esc(f.path)}"`}>
      <span>${f.isDir ? '📁' : fileIcon(f.name)}</span>
      <span>${esc(f.name)}</span>
    </div>`).join('');
}

function buildBreadcrumb(path, isFile) {
  const parts = path ? path.split('/') : [];
  const dirs  = isFile ? parts.slice(0, -1) : parts;
  let h = `<span class="cursor-pointer text-primary hover:underline" data-dir-path="">root</span>`;
  let cum = '';
  for (const p of dirs) {
    cum = cum ? `${cum}/${p}` : p;
    h += ` <span class="text-base-content/40">/</span> <span class="cursor-pointer text-primary hover:underline" data-dir-path="${esc(cum)}">${esc(p)}</span>`;
  }
  if (isFile) h += ` <span class="text-base-content/40">/</span> <span>${esc(parts.at(-1))}</span>`;
  return h;
}

export function initFilesTab() {
  // Breadcrumb — sync, no fetch
  effect(() => {
    const bc = $('files-breadcrumb');
    if (bc) bc.innerHTML = buildBreadcrumb(viewingFile.value ?? filesPath.value, viewingFile.value !== null);
  });

  // Content — re-runs on any signal change, aborts previous request
  let ctrl = null;
  effect(() => {
    const tab  = currentTab.value;
    const proj = currentProject.value;
    const file = viewingFile.value;
    const dir  = filesPath.value;
    const area = $('files-area');
    if (!area) return;
    ctrl?.abort(); ctrl = new AbortController();
    if (tab !== 'files' || !proj) { area.innerHTML = ''; return; }
    area.innerHTML = '<div style="padding:14px;font-size:12px;opacity:.5">Loading…</div>';
    const [url, xform] = file !== null
      ? [`/api/projects/${proj.id}/file?root=${encodeURIComponent(proj.path)}&path=${encodeURIComponent(file)}`,  d => ({ type: 'file', content: d.content, path: file })]
      : [`/api/projects/${proj.id}/files?root=${encodeURIComponent(proj.path)}&path=${encodeURIComponent(dir)}`, d => ({ type: 'dir', files: d })];
    api('GET', url, undefined, ctrl.signal)
      .then(d => { if (!ctrl.signal.aborted) area.innerHTML = render(xform(d)); })
      .catch(e => { if (!ctrl.signal.aborted && e?.name !== 'AbortError') area.innerHTML = `<div style="padding:14px;font-size:12px;color:#f85149">${esc(e?.message ?? e)}</div>`; });
    return () => ctrl?.abort();
  });

  delegate.on('click', '[data-dir-path]',  (_, el) => { viewingFile.value = null; filesPath.value = el.dataset.dirPath; });
  delegate.on('click', '[data-file-path]', (_, el) => { viewingFile.value = el.dataset.filePath; });
}

function fileIcon(name) {
  const ext = name.split('.').pop()?.toLowerCase();
  return { js:'📄',ts:'📄',jsx:'📄',tsx:'📄',py:'🐍',md:'📝',json:'⚙️',html:'🌐',css:'🎨',sh:'⚡',env:'🔑' }[ext] || '📄';
}
