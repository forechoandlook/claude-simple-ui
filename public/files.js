// files.js — Files tab with upload / download / delete
import { signal, effect, delegate, esc, $ } from './lib.js';
import { currentProject, currentTab, filesRoot, ctx } from './state.js';
import { api } from './api.js';

export const filesPath   = signal('');
export const viewingFile = signal(null);

// ── Rendering ─────────────────────────────────────────────────────────────────
function fileIcon(name) {
  const ext = name.split('.').pop()?.toLowerCase();
  return { js:'📄',ts:'📄',jsx:'📄',tsx:'📄',py:'🐍',md:'📝',json:'⚙️',html:'🌐',css:'🎨',sh:'⚡',env:'🔑' }[ext] || '📄';
}

function renderDir(files) {
  if (!files.length) return '<div class="p-4 text-xs text-base-content/40">Empty directory</div>';
  files.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
  return files.map(f => `
    <div class="flex items-center gap-2 px-4 py-1.5 hover:bg-base-300 group"
         ${f.isDir ? `data-dir-path="${esc(f.path)}"` : `data-file-path="${esc(f.path)}"`}>
      <span class="cursor-pointer flex-shrink-0">${f.isDir ? '📁' : fileIcon(f.name)}</span>
      <span class="text-sm flex-1 truncate cursor-pointer ${f.isDir ? 'text-primary' : ''}">${esc(f.name)}</span>
      ${!f.isDir ? `
        <button class="opacity-0 group-hover:opacity-100 btn btn-ghost btn-xs px-1 text-base-content/40 hover:text-base-content"
                data-download-path="${esc(f.path)}" title="Download">↓</button>
        <button class="opacity-0 group-hover:opacity-100 btn btn-ghost btn-xs px-1 text-error/60 hover:text-error"
                data-delete-path="${esc(f.path)}" title="Delete">✕</button>` : ''}
    </div>`).join('');
}

function renderFile(path, content, size) {
  const isBinary = /[\x00-\x08\x0e-\x1f]/.test(content.slice(0, 512));
  const body = isBinary
    ? `<div class="p-4 text-xs text-base-content/40">Binary file — <button class="text-primary hover:underline" data-download-path="${esc(path)}">Download</button></div>`
    : `<pre class="p-4 font-mono text-xs leading-relaxed overflow-auto flex-1">${esc(content)}</pre>`;
  const sizeStr = size > 1024 ? `${(size/1024).toFixed(1)} KB` : `${size} B`;
  return `
    <div class="flex items-center gap-2 px-4 py-1.5 border-b border-base-300 flex-shrink-0 bg-base-200">
      <span class="text-xs text-base-content/40 flex-1">${esc(path)} · ${sizeStr}</span>
      <button class="btn btn-ghost btn-xs" data-download-path="${esc(path)}">↓ Download</button>
    </div>
    ${body}`;
}

function buildBreadcrumb(pathStr, isFile) {
  const parts = pathStr ? pathStr.split('/') : [];
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

// ── Upload ────────────────────────────────────────────────────────────────────
function triggerUpload() {
  const proj = currentProject.peek();
  const root = filesRoot.peek() || proj?.path;
  if (!root) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.addEventListener('change', async () => {
    const dir = filesPath.peek();
    const id  = proj?.id || '_';
    const files = [...input.files];
    let failed = false;
    for (const file of files) {
      const destPath = dir ? `${dir}/${file.name}` : file.name;
      const url = `/api/projects/${id}/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(destPath)}`;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${ctx.token}` },
          body: file,                 // stream directly — no base64 overhead
          duplex: 'half',             // required for request body streaming
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `HTTP ${res.status}`); }
      } catch (e) { alert(`Upload failed (${file.name}): ${e.message}`); failed = true; break; }
    }
    if (!failed) {
      // nudge signal to refresh listing
      const cur = filesPath.peek();
      filesPath.value = cur + '\x00';
      filesPath.value = cur;
    }
  });
  input.click();
}

function downloadFile(proj, filePath) {
  const root = filesRoot.peek() || proj?.path || '';
  const id   = proj?.id || '_';
  const url = `/api/projects/${id}/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(filePath)}&download=true&token=${encodeURIComponent(ctx.token)}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = filePath.split('/').pop();
  a.click();
}

async function deleteFile(proj, filePath) {
  if (!confirm(`Delete "${filePath.split('/').pop()}"?`)) return;
  const root = filesRoot.peek() || proj?.path || '';
  const id   = proj?.id || '_';
  try {
    await api('DELETE', `/api/projects/${id}/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(filePath)}`);
    filesPath.value = filesPath.peek() + ' ';
    filesPath.value = filesPath.peek().trimEnd();
  } catch (e) { alert(`Delete failed: ${e.message}`); }
}

// ── Init ──────────────────────────────────────────────────────────────────────
export function initFilesTab() {
  effect(() => {
    const bc = $('files-breadcrumb');
    if (!bc) return;
    const isFile = viewingFile.value !== null;
    bc.innerHTML = `
      ${buildBreadcrumb(viewingFile.value ?? filesPath.value, isFile)}
      <div class="flex-1"></div>
      ${!isFile ? `<button id="btn-upload" class="btn btn-ghost btn-xs text-base-content/50 hover:text-base-content">↑ Upload</button>` : ''}`;
  });

  effect(() => {
    const tab   = currentTab.value;
    const proj  = currentProject.value;
    const root  = filesRoot.value || proj?.path;   // custom root overrides session cwd
    const file  = viewingFile.value;
    const dir   = filesPath.value;
    const area  = $('files-area');
    if (!area) return;
    const ctrl = new AbortController();
    if (tab !== 'files' || !root) { area.innerHTML = ''; return () => ctrl.abort(); }
    const id = proj?.id || '_';
    area.innerHTML = '<div class="p-4 text-xs text-base-content/40">Loading…</div>';
    if (file !== null) {
      api('GET', `/api/projects/${id}/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(file)}`, undefined, ctrl.signal)
        .then(d => { if (!ctrl.signal.aborted) area.innerHTML = renderFile(file, d.content, d.size ?? d.content.length); })
        .catch(e => { if (!ctrl.signal.aborted && e?.name !== 'AbortError') area.innerHTML = `<div class="p-4 text-xs text-error">${esc(e.message)}</div>`; });
    } else {
      api('GET', `/api/projects/${id}/files?root=${encodeURIComponent(root)}&path=${encodeURIComponent(dir)}`, undefined, ctrl.signal)
        .then(d => { if (!ctrl.signal.aborted) area.innerHTML = renderDir(d); })
        .catch(e => { if (!ctrl.signal.aborted && e?.name !== 'AbortError') area.innerHTML = `<div class="p-4 text-xs text-error">${esc(e.message)}</div>`; });
    }
    return () => ctrl.abort();
  });

  delegate.on('click', '[data-dir-path]',  (_, el) => { viewingFile.value = null; filesPath.value = el.dataset.dirPath; });
  delegate.on('click', '[data-file-path]', (_, el) => { viewingFile.value = el.dataset.filePath; });
  delegate.on('click', '#btn-upload',      () => triggerUpload());
  delegate.on('click', '[data-download-path]', (_, el) => {
    const proj = currentProject.peek();
    if (proj) downloadFile(proj, el.dataset.downloadPath);
  });
  delegate.on('click', '[data-delete-path]', (_, el) => {
    const proj = currentProject.peek();
    if (proj) deleteFile(proj, el.dataset.deletePath);
  });
}
