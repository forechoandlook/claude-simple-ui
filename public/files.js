// files.js — Files tab with upload / download / delete + text/office preview
import { effect, delegate, esc, $ } from './lib.js';
import { currentProject, currentTab, filesRoot, filesPath, viewingFile, ctx } from './state.js';
import { api } from './api.js';

// ── Helpers ───────────────────────────────────────────────────────────────────
function fileIcon(name) {
  const ext = name.split('.').pop()?.toLowerCase();
  return {
    js: '📄', ts: '📄', jsx: '📄', tsx: '📄', py: '🐍', md: '📝', json: '⚙️',
    html: '🌐', css: '🎨', sh: '⚡', env: '🔑',
    docx: '📘', pptx: '📙', xlsx: '📗',
  }[ext] || '📄';
}

function extOf(path) {
  const base = (path || '').split('/').pop() || '';
  const i = base.lastIndexOf('.');
  return i >= 0 ? base.slice(i + 1).toLowerCase() : '';
}

function officeKind(path) {
  const e = extOf(path);
  return e === 'docx' || e === 'pptx' || e === 'xlsx' ? e : null;
}

function sizeLabel(size) {
  if (size == null) return '';
  if (size > 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size > 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}

function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

const _scriptLoads = new Map();
function loadScript(src) {
  if (_scriptLoads.has(src)) return _scriptLoads.get(src);
  const p = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === '1') return resolve();
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)));
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.dataset.src = src;
    s.onload = () => { s.dataset.loaded = '1'; resolve(); };
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
  _scriptLoads.set(src, p);
  return p;
}

/** Map filename / path → highlight.js language id (or '' for plain text). */
function langFromPath(path) {
  const base = (path || '').split('/').pop() || '';
  const lower = base.toLowerCase();
  const byName = {
    dockerfile: 'dockerfile', makefile: 'makefile', gemfile: 'ruby',
    rakefile: 'ruby', procfile: 'yaml', 'cmakelists.txt': 'cmake',
  };
  if (byName[lower]) return byName[lower];
  const ext = lower.includes('.') ? lower.split('.').pop() : '';
  const map = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    py: 'python', pyw: 'python', pyi: 'python',
    rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
    cs: 'csharp', swift: 'swift', php: 'php', scala: 'scala',
    sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
    ps1: 'powershell', psm1: 'powershell',
    html: 'xml', htm: 'xml', xhtml: 'xml', xml: 'xml', svg: 'xml',
    css: 'css', scss: 'scss', less: 'less',
    json: 'json', jsonc: 'json', json5: 'json',
    yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', conf: 'ini', env: 'bash',
    md: 'markdown', mdx: 'markdown', markdown: 'markdown',
    sql: 'sql', graphql: 'graphql', gql: 'graphql',
    vue: 'xml', svelte: 'xml',
    r: 'r', lua: 'lua', pl: 'perl', pm: 'perl',
    dart: 'dart', ex: 'elixir', exs: 'elixir', erl: 'erlang',
    zig: 'zig', nim: 'nim', clj: 'clojure', cljs: 'clojure',
    diff: 'diff', patch: 'diff',
    dockerfile: 'dockerfile',
  };
  return map[ext] || '';
}

function highlightFilePreview(root) {
  if (!root || typeof hljs === 'undefined') return;
  root.querySelectorAll('pre code.file-preview-code').forEach(el => {
    try {
      delete el.dataset.highlighted;
      hljs.highlightElement(el);
    } catch { /* unknown language / empty */ }
  });
}

function fileChrome(path, size, kindLabel) {
  const sizeStr = sizeLabel(size);
  return `
    <div class="flex items-center gap-2 px-4 py-1.5 border-b border-base-300 flex-shrink-0 bg-base-200">
      <span class="text-xs text-base-content/40 flex-1 truncate">${esc(path)} · ${esc(sizeStr)}${kindLabel ? ` · <span class="text-primary/70">${esc(kindLabel)}</span>` : ''}</span>
      <button class="btn btn-ghost btn-xs" data-download-path="${esc(path)}">↓ Download</button>
    </div>`;
}

// ── Directory / text render ───────────────────────────────────────────────────
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

function renderTextFile(path, content, size) {
  const isBinary = /[\x00-\x08\x0e-\x1f]/.test(content.slice(0, 512));
  const lang = langFromPath(path);
  const langClass = lang ? `language-${esc(lang)}` : '';
  const body = isBinary
    ? `<div class="p-4 text-xs text-base-content/40">Binary file — <button class="text-primary hover:underline" data-download-path="${esc(path)}">Download</button></div>`
    : `<pre class="file-preview p-4 font-mono text-xs leading-relaxed overflow-auto flex-1 m-0"><code class="hljs file-preview-code ${langClass}">${esc(content)}</code></pre>`;
  return fileChrome(path, size, isBinary ? 'binary' : (lang || 'text')) + body;
}

// ── Office previews ───────────────────────────────────────────────────────────
async function renderDocx(arrayBuffer) {
  await loadScript('https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js');
  if (typeof mammoth === 'undefined') throw new Error('mammoth failed to load');
  const result = await mammoth.convertToHtml({ arrayBuffer });
  const warn = result.messages?.length
    ? `<div class="office-warn text-xs text-warning/80 px-3 py-1">${result.messages.length} conversion note(s)</div>`
    : '';
  return `<div class="office-preview office-docx overflow-auto flex-1 p-4 md">${warn}<div class="office-docx-body">${result.value || '<p class="text-base-content/40">Empty document</p>'}</div></div>`;
}

async function renderXlsx(arrayBuffer) {
  await loadScript('https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js');
  if (typeof XLSX === 'undefined') throw new Error('SheetJS failed to load');
  const wb = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
  const names = wb.SheetNames || [];
  if (!names.length) {
    return `<div class="p-4 text-xs text-base-content/40">Empty workbook</div>`;
  }
  const tabs = names.map((n, i) =>
    `<button type="button" class="office-sheet-tab${i === 0 ? ' active' : ''}" data-sheet-idx="${i}">${esc(n)}</button>`
  ).join('');
  const sheets = names.map((n, i) => {
    const sheet = wb.Sheets[n];
    // sheet_to_html is fine for preview; escape not needed — SheetJS emits tags
    let html;
    try {
      html = XLSX.utils.sheet_to_html(sheet, { id: `xlsx-sheet-${i}`, editable: false });
    } catch {
      html = '<p class="text-base-content/40 text-xs p-2">Unable to render this sheet</p>';
    }
    return `<div class="office-sheet-pane${i === 0 ? '' : ' hidden'}" data-sheet-pane="${i}">${html}</div>`;
  }).join('');
  return `
    <div class="office-preview office-xlsx flex flex-col flex-1 min-h-0 overflow-hidden">
      <div class="office-sheet-tabs flex gap-1 px-2 py-1.5 border-b border-base-300 overflow-x-auto flex-shrink-0 bg-base-200">${tabs}</div>
      <div class="office-sheet-body flex-1 overflow-auto p-2">${sheets}</div>
    </div>`;
}

function pptxExtractSlideTexts(xml) {
  // Collect <a:t>…</a:t> runs; group roughly by paragraph breaks via </a:p>
  const parts = [];
  const paraRe = /<a:p[\s>][\s\S]*?<\/a:p>/g;
  const textRe = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
  let m;
  const paras = xml.match(paraRe) || [xml];
  for (const para of paras) {
    const runs = [];
    textRe.lastIndex = 0;
    while ((m = textRe.exec(para)) !== null) {
      const t = m[1]
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
      if (t) runs.push(t);
    }
    if (runs.length) parts.push(runs.join(''));
  }
  return parts;
}

async function renderPptx(arrayBuffer) {
  await loadScript('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');
  if (typeof JSZip === 'undefined') throw new Error('JSZip failed to load');
  const zip = await JSZip.loadAsync(arrayBuffer);
  const slideFiles = Object.keys(zip.files)
    .filter(n => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)/i)?.[1] || '0', 10);
      const nb = parseInt(b.match(/slide(\d+)/i)?.[1] || '0', 10);
      return na - nb;
    });
  if (!slideFiles.length) {
    return `<div class="p-4 text-xs text-base-content/40">No slides found in this presentation</div>`;
  }
  const cards = [];
  for (let i = 0; i < slideFiles.length; i++) {
    const xml = await zip.files[slideFiles[i]].async('string');
    const lines = pptxExtractSlideTexts(xml);
    const body = lines.length
      ? lines.map(l => `<p>${esc(l)}</p>`).join('')
      : '<p class="text-base-content/40 italic">（此页无可提取文本 / 可能以图片为主）</p>';
    cards.push(`
      <article class="office-slide-card">
        <header class="office-slide-num">Slide ${i + 1}</header>
        <div class="office-slide-body">${body}</div>
      </article>`);
  }
  return `
    <div class="office-preview office-pptx overflow-auto flex-1 p-3 space-y-3">
      <p class="text-xs text-base-content/50 px-1">文本预览（版式/图片不还原）· ${slideFiles.length} slide(s)</p>
      ${cards.join('')}
    </div>`;
}

async function renderOfficeFile(path, base64, size) {
  const kind = officeKind(path);
  const labels = { docx: 'Word', pptx: 'PowerPoint', xlsx: 'Excel' };
  const ab = base64ToArrayBuffer(base64);
  let body;
  if (kind === 'docx') body = await renderDocx(ab);
  else if (kind === 'xlsx') body = await renderXlsx(ab);
  else if (kind === 'pptx') body = await renderPptx(ab);
  else throw new Error('Unsupported office type');
  return fileChrome(path, size, labels[kind] || kind) + body;
}

function buildBreadcrumb(pathStr, isFile) {
  const parts = pathStr ? pathStr.split('/') : [];
  const dirs = isFile ? parts.slice(0, -1) : parts;
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
    const id = proj?.id || '_';
    const files = [...input.files];
    let failed = false;
    for (const file of files) {
      const destPath = dir ? `${dir}/${file.name}` : file.name;
      const url = `/api/projects/${id}/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(destPath)}`;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${ctx.token}` },
          body: file,
          duplex: 'half',
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `HTTP ${res.status}`); }
      } catch (e) { alert(`Upload failed (${file.name}): ${e.message}`); failed = true; break; }
    }
    if (!failed) {
      const cur = filesPath.peek();
      filesPath.value = cur + '\x00';
      filesPath.value = cur;
    }
  });
  input.click();
}

function downloadFile(proj, filePath) {
  const root = filesRoot.peek() || proj?.path || '';
  const id = proj?.id || '_';
  const url = `/api/projects/${id}/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(filePath)}&download=true&token=${encodeURIComponent(ctx.token)}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = filePath.split('/').pop();
  a.click();
}

async function deleteFile(proj, filePath) {
  if (!confirm(`Delete "${filePath.split('/').pop()}"?`)) return;
  const root = filesRoot.peek() || proj?.path || '';
  const id = proj?.id || '_';
  try {
    await api('DELETE', `/api/projects/${id}/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(filePath)}`);
    filesPath.value = filesPath.peek() + ' ';
    filesPath.value = filesPath.peek().trimEnd();
  } catch (e) { alert(`Delete failed: ${e.message}`); }
}

async function showFile(area, file, data, signal) {
  const size = data.size ?? (typeof data.content === 'string' ? data.content.length : 0);
  const kind = officeKind(file);
  if (kind && data.encoding === 'base64') {
    area.innerHTML = fileChrome(file, size, kind) +
      `<div class="p-4 text-xs text-base-content/40">Parsing ${kind.toUpperCase()}…</div>`;
    try {
      const html = await renderOfficeFile(file, data.content, size);
      if (signal.aborted) return;
      area.innerHTML = html;
    } catch (e) {
      if (signal.aborted) return;
      area.innerHTML = fileChrome(file, size, kind) +
        `<div class="p-4 text-xs text-error">Preview failed: ${esc(e.message)} — <button class="text-primary hover:underline" data-download-path="${esc(file)}">Download</button></div>`;
    }
    return;
  }
  if (data.encoding === 'base64') {
    area.innerHTML = fileChrome(file, size, 'binary') +
      `<div class="p-4 text-xs text-base-content/40">Binary file — <button class="text-primary hover:underline" data-download-path="${esc(file)}">Download</button></div>`;
    return;
  }
  area.innerHTML = renderTextFile(file, data.content || '', size);
  highlightFilePreview(area);
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
    const tab = currentTab.value;
    const proj = currentProject.value;
    const root = filesRoot.value || proj?.path;
    const file = viewingFile.value;
    const dir = filesPath.value;
    const area = $('files-area');
    if (!area) return;
    const ctrl = new AbortController();
    if (tab !== 'files' || !root) { area.innerHTML = ''; return () => ctrl.abort(); }
    const id = proj?.id || '_';
    area.innerHTML = '<div class="p-4 text-xs text-base-content/40">Loading…</div>';
    if (file !== null) {
      api('GET', `/api/projects/${id}/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(file)}`, undefined, ctrl.signal)
        .then(d => { if (!ctrl.signal.aborted) return showFile(area, file, d, ctrl.signal); })
        .catch(e => {
          if (!ctrl.signal.aborted && e?.name !== 'AbortError') {
            area.innerHTML = `<div class="p-4 text-xs text-error">${esc(e.message)}</div>`;
          }
        });
    } else {
      api('GET', `/api/projects/${id}/files?root=${encodeURIComponent(root)}&path=${encodeURIComponent(dir)}`, undefined, ctrl.signal)
        .then(d => { if (!ctrl.signal.aborted) area.innerHTML = renderDir(d); })
        .catch(e => {
          if (!ctrl.signal.aborted && e?.name !== 'AbortError') {
            area.innerHTML = `<div class="p-4 text-xs text-error">${esc(e.message)}</div>`;
          }
        });
    }
    return () => ctrl.abort();
  });

  delegate.on('click', '[data-dir-path]', (_, el) => { viewingFile.value = null; filesPath.value = el.dataset.dirPath; });
  delegate.on('click', '[data-file-path]', (_, el) => { viewingFile.value = el.dataset.filePath; });
  delegate.on('click', '#btn-upload', () => triggerUpload());
  delegate.on('click', '[data-download-path]', (_, el) => {
    const proj = currentProject.peek();
    if (proj) downloadFile(proj, el.dataset.downloadPath);
  });
  delegate.on('click', '[data-delete-path]', (_, el) => {
    const proj = currentProject.peek();
    if (proj) deleteFile(proj, el.dataset.deletePath);
  });
  // Excel sheet tabs
  delegate.on('click', '.office-sheet-tab', (_, el) => {
    const root = el.closest('.office-xlsx');
    if (!root) return;
    const idx = el.dataset.sheetIdx;
    root.querySelectorAll('.office-sheet-tab').forEach(t => t.classList.toggle('active', t === el));
    root.querySelectorAll('.office-sheet-pane').forEach(p => {
      p.classList.toggle('hidden', p.dataset.sheetPane !== idx);
    });
  });
}
