/**
 * agent-panel.js — Meta Agent UI: chat, reports, VLM, auto-report.
 * Server-side tools stream via SSE (/api/ai/chat, /api/ai/report).
 */
import { esc, $ } from './lib.js';
import { api, authHeaders, currentMachineId } from './api.js';
import { hubMode, ctx } from './state.js';

let panelOpen = false;
let mode = 'chat'; // chat | report | history | config
let streaming = false;
let chatSessionId = null;
/** Full messages loaded for current session (for resume continuity on client display) */
let currentSessionMeta = null; // { id, title, updatedAt, messageCount }
/** Local previews only: { path, previewUrl, label } — message text uses [imgN](path) */
let pendingImages = [];
let imgSeq = 0;
let autoTimer = null;
let lastAutoDay = localStorage.getItem('ai_last_auto_report') || '';
let historyCache = [];
let historySearch = '';
const LAST_SESSION_KEY = 'ma_last_session_id';

function mdHtml(text) {
  if (typeof marked !== 'undefined') {
    try {
      return marked.parse(String(text ?? ''), { breaks: true, gfm: true });
    } catch { /* fallthrough */ }
  }
  return esc(text).replace(/\n/g, '<br>');
}

function highlight(root) {
  if (!root || typeof hljs === 'undefined') return;
  root.querySelectorAll('pre code').forEach((el) => {
    try { hljs.highlightElement(el); } catch {}
  });
}

/** Fetch SSE with auth (+ hub machine routing). */
async function streamSSE(path, body, handlers) {
  const headers = authHeaders({ 'Content-Type': 'application/json' });
  const res = await fetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let event = 'message';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n');
    buf = parts.pop() || '';
    for (const line of parts) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        const raw = line.slice(5).trim();
        if (!raw) continue;
        let data;
        try { data = JSON.parse(raw); } catch { continue; }
        handlers[event]?.(data);
        handlers.any?.(event, data);
        event = 'message';
      } else if (line.trim() === '') {
        event = 'message';
      }
    }
  }
}

function panelHTML() {
  return `
  <div id="meta-agent-panel" class="meta-agent-panel hidden" aria-hidden="true">
    <div class="meta-agent-backdrop" data-ma-close="1"></div>
    <div class="meta-agent-sheet">
      <header class="meta-agent-header">
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-base font-bold">✦ Meta Agent</span>
          <span class="text-[10px] text-base-content/40 hidden sm:inline">报告 · 问答 · VLM · 代码</span>
        </div>
        <div class="flex items-center gap-1">
          <button type="button" id="ma-btn-chat" class="btn btn-xs btn-ghost border border-primary/40 text-primary">对话</button>
          <button type="button" id="ma-btn-history" class="btn btn-xs btn-ghost border border-base-300" title="历史对话">历史</button>
          <button type="button" id="ma-btn-report" class="btn btn-xs btn-ghost border border-base-300">报告</button>
          <button type="button" id="ma-btn-config" class="btn btn-xs btn-ghost border border-base-300" title="AI 配置">⚙</button>
          <button type="button" id="ma-btn-close" class="btn btn-xs btn-ghost" data-ma-close="1">✕</button>
        </div>
      </header>

      <div id="ma-mode-chat" class="meta-agent-body flex flex-col min-h-0 flex-1">
        <div class="flex items-center gap-1 px-2 py-1 border-b border-base-300 flex-shrink-0 overflow-x-auto">
          <button type="button" id="ma-new-chat" class="btn btn-ghost btn-xs">＋ 新对话</button>
          <button type="button" id="ma-open-history" class="btn btn-ghost btn-xs" title="历史列表">☰ 历史</button>
          <span id="ma-session-title" class="text-[11px] text-base-content/55 truncate flex-1 min-w-0 px-1"></span>
          <button type="button" id="ma-del-session" class="btn btn-ghost btn-xs text-error" title="删除当前会话">🗑</button>
          <button type="button" id="ma-quick-today" class="btn btn-ghost btn-xs text-[10px]">今天做了啥</button>
          <button type="button" id="ma-quick-projects" class="btn btn-ghost btn-xs text-[10px]">项目概况</button>
        </div>
        <div id="ma-resume-bar" class="hidden px-3 py-1.5 border-b border-primary/30 bg-primary/10 text-[11px] flex items-center gap-2 flex-shrink-0">
          <span id="ma-resume-text" class="flex-1 min-w-0 truncate text-base-content/70"></span>
          <button type="button" id="ma-resume-focus" class="btn btn-primary btn-xs">继续聊</button>
        </div>
        <div id="ma-messages" class="flex-1 overflow-y-auto p-3 flex flex-col gap-2"></div>
        <div id="ma-attach-bar" class="hidden px-3 pt-1 flex flex-wrap gap-1"></div>
        <div class="flex gap-2 items-end px-3 py-2 border-t border-base-300 bg-base-200 flex-shrink-0">
          <label class="btn btn-ghost btn-sm px-2 cursor-pointer" title="添加图片 (VLM)" style="height:40px">
            🖼
            <input type="file" id="ma-image-input" accept="image/*" multiple class="hidden">
          </label>
          <textarea id="ma-input" rows="1" placeholder="继续提问… (⌘↵ 发送) · 历史会话会带着上下文"
            class="textarea textarea-bordered flex-1 text-sm resize-none leading-relaxed"
            style="min-height:40px;max-height:120px"></textarea>
          <button type="button" id="ma-send" class="btn btn-primary btn-sm" style="height:40px">发送</button>
        </div>
      </div>

      <div id="ma-mode-history" class="meta-agent-body hidden flex-col min-h-0 flex-1">
        <div class="flex items-center gap-2 px-3 py-2 border-b border-base-300 flex-shrink-0">
          <input id="ma-history-search" type="search" placeholder="搜索标题 / 预览…"
            class="input input-xs input-bordered flex-1 text-xs" autocomplete="off">
          <button type="button" id="ma-history-refresh" class="btn btn-ghost btn-xs">↻</button>
          <button type="button" id="ma-history-new" class="btn btn-primary btn-xs">＋ 新对话</button>
        </div>
        <div id="ma-history-list" class="flex-1 overflow-y-auto p-2 flex flex-col gap-1"></div>
        <p class="text-[10px] text-base-content/40 px-3 py-2 border-t border-base-300 flex-shrink-0">
          点击会话可查看完整记录；发送新消息即 resume（保留 tool / VLM 上下文）。
        </p>
      </div>

      <div id="ma-mode-report" class="meta-agent-body hidden flex-col min-h-0 flex-1">
        <div class="flex items-center gap-2 px-3 py-2 border-b border-base-300 flex-shrink-0 flex-wrap">
          <select id="ma-report-days" class="select select-xs select-bordered">
            <option value="1">今天</option>
            <option value="3">近 3 天</option>
            <option value="7">近 7 天</option>
          </select>
          <button type="button" id="ma-gen-report" class="btn btn-primary btn-xs">生成报告</button>
          <button type="button" id="ma-load-reports" class="btn btn-ghost btn-xs">历史</button>
          <label class="flex items-center gap-1 text-[11px] ml-auto cursor-pointer select-none">
            <input type="checkbox" id="ma-auto-report" class="checkbox checkbox-xs">
            自动日报
          </label>
          <select id="ma-auto-hour" class="select select-xs select-bordered w-16" title="自动生成时刻">
            ${Array.from({ length: 24 }, (_, h) => `<option value="${h}">${String(h).padStart(2, '0')}:00</option>`).join('')}
          </select>
        </div>
        <div id="ma-report-list" class="hidden border-b border-base-300 max-h-28 overflow-y-auto px-2 py-1"></div>
        <div id="ma-report-body" class="flex-1 overflow-y-auto p-4">
          <div class="text-sm text-base-content/45 text-center py-10">
            点击「生成报告」汇总会话与项目活动，或在对话里问「我今天做了什么」。
          </div>
        </div>
      </div>

      <div id="ma-mode-config" class="meta-agent-body hidden flex-col min-h-0 flex-1 overflow-y-auto p-4 gap-3">
        <p class="text-xs text-base-content/50">OpenAI 兼容 API（DeepSeek / OpenAI / 本地网关等）。Key 保存在服务端 <code>.ai_config.json</code>。</p>
        <label class="form-control">
          <span class="label-text text-xs">API URL</span>
          <input id="ma-cfg-url" class="input input-sm input-bordered font-mono text-xs" placeholder="https://api.deepseek.com/chat/completions">
        </label>
        <label class="form-control">
          <span class="label-text text-xs">API Key</span>
          <input id="ma-cfg-key" type="password" class="input input-sm input-bordered" placeholder="留空则不修改">
        </label>
        <label class="form-control">
          <span class="label-text text-xs">主模型</span>
          <input id="ma-cfg-model" class="input input-sm input-bordered font-mono text-xs" placeholder="deepseek-chat">
        </label>
        <div class="divider text-xs my-1">VLM 多模态（可留空共用上方）</div>
        <label class="form-control">
          <span class="label-text text-xs">VLM URL</span>
          <input id="ma-cfg-vlm-url" class="input input-sm input-bordered font-mono text-xs" placeholder="可选">
        </label>
        <label class="form-control">
          <span class="label-text text-xs">VLM Key</span>
          <input id="ma-cfg-vlm-key" type="password" class="input input-sm input-bordered" placeholder="可选">
        </label>
        <label class="form-control">
          <span class="label-text text-xs">VLM 模型</span>
          <input id="ma-cfg-vlm-model" class="input input-sm input-bordered font-mono text-xs" placeholder="gpt-4o-mini / …">
        </label>
        <label class="form-control">
          <span class="label-text text-xs">System Prompt</span>
          <textarea id="ma-cfg-system" class="textarea textarea-bordered textarea-sm text-xs min-h-[80px]"></textarea>
        </label>
        <div class="flex gap-2">
          <button type="button" id="ma-cfg-save" class="btn btn-primary btn-sm">保存</button>
          <span id="ma-cfg-status" class="text-xs text-base-content/50 self-center"></span>
        </div>
      </div>
    </div>
  </div>`;
}

function setMode(m) {
  mode = m;
  const chat = $('ma-mode-chat');
  const history = $('ma-mode-history');
  const report = $('ma-mode-report');
  const config = $('ma-mode-config');
  for (const [el, key] of [
    [chat, 'chat'],
    [history, 'history'],
    [report, 'report'],
    [config, 'config'],
  ]) {
    if (!el) continue;
    const on = m === key;
    el.classList.toggle('hidden', !on);
    el.classList.toggle('flex', on);
  }
  const tab = (id, on) => {
    const b = $(id);
    if (!b) return;
    b.classList.toggle('border-primary/40', on);
    b.classList.toggle('text-primary', on);
  };
  tab('ma-btn-chat', m === 'chat');
  tab('ma-btn-history', m === 'history');
  tab('ma-btn-report', m === 'report');
  if (m === 'history') renderHistoryList();
}

function updateSessionChrome() {
  const titleEl = $('ma-session-title');
  const resumeBar = $('ma-resume-bar');
  const resumeText = $('ma-resume-text');
  if (!chatSessionId) {
    if (titleEl) titleEl.textContent = '新对话';
    resumeBar?.classList.add('hidden');
    return;
  }
  const t = currentSessionMeta?.title || chatSessionId.slice(0, 8);
  const when = fmtSessionWhen(currentSessionMeta?.updatedAt);
  if (titleEl) titleEl.textContent = when ? `${t} · ${when}` : t;
  if (resumeBar && resumeText) {
    resumeBar.classList.remove('hidden');
    const n = currentSessionMeta?.messageCount;
    resumeText.textContent = n
      ? `已加载历史 · ${n} 条消息 · 发送即可继续`
      : '已加载历史会话 · 发送即可继续';
  }
}

export function openMetaAgent(initialMode = 'chat') {
  const panel = $('meta-agent-panel');
  if (!panel) return;
  panel.classList.remove('hidden');
  panel.setAttribute('aria-hidden', 'false');
  panelOpen = true;
  setMode(initialMode);
  if (initialMode === 'chat') {
    refreshHistoryCache();
    // restore last session if still empty view
    const last = localStorage.getItem(LAST_SESSION_KEY);
    if (!chatSessionId && last) {
      loadSession(last, { silent: true }).catch(() => {
        localStorage.removeItem(LAST_SESSION_KEY);
      });
    } else {
      updateSessionChrome();
    }
  }
  if (initialMode === 'history') refreshHistoryCache().then(() => renderHistoryList());
  if (initialMode === 'report') loadTodayReportQuiet();
  if (initialMode === 'config') loadConfigForm();
  setTimeout(() => {
    if (mode === 'chat') $('ma-input')?.focus();
    if (mode === 'history') $('ma-history-search')?.focus();
  }, 50);
}

export function closeMetaAgent() {
  const panel = $('meta-agent-panel');
  if (!panel) return;
  panel.classList.add('hidden');
  panel.setAttribute('aria-hidden', 'true');
  panelOpen = false;
}

export function toggleMetaAgent() {
  if (panelOpen) closeMetaAgent();
  else openMetaAgent(mode === 'config' ? 'chat' : mode);
}

function appendMsg(kind, text, opts = {}) {
  const box = $('ma-messages');
  if (!box) return null;
  const el = document.createElement('div');
  el.className = `ma-msg ma-msg-${kind}`;
  if (kind === 'user') {
    el.innerHTML = `<div class="ma-bubble user">${esc(text)}</div>`;
  } else if (kind === 'assistant') {
    el.innerHTML = `<div class="ma-bubble assistant md">${mdHtml(text)}</div>`;
    highlight(el);
  } else if (kind === 'error') {
    el.innerHTML = `<div class="ma-bubble error">${esc(text)}</div>`;
  } else if (kind === 'system') {
    el.innerHTML = `<div class="ma-sys">${esc(text)}</div>`;
  } else if (kind === 'tool') {
    el.innerHTML = `<div class="ma-tool" data-tool-id="${esc(opts.id || '')}">
      <span class="ma-tool-name">${esc(opts.name || 'tool')}</span>
      <span class="ma-tool-phase">${esc(opts.phase || '')}</span>
      <pre class="ma-tool-args">${esc(JSON.stringify(opts.args || {}, null, 0).slice(0, 200))}</pre>
    </div>`;
  }
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  return el;
}

function updateAssistant(el, text) {
  const body = el?.querySelector('.ma-bubble');
  if (!body) return;
  body.innerHTML = mdHtml(text);
  highlight(body);
  $('ma-messages').scrollTop = $('ma-messages').scrollHeight;
}

function updateToolChip(id, phase, result) {
  const box = $('ma-messages');
  if (!box) return;
  const el = box.querySelector(`[data-tool-id="${CSS.escape(id)}"]`);
  if (!el) return;
  el.classList.toggle('done', phase === 'done');
  el.classList.toggle('error', phase === 'error');
  const ph = el.querySelector('.ma-tool-phase');
  if (ph) ph.textContent = phase;
  if (result && phase !== 'start') {
    let pre = el.querySelector('.ma-tool-result');
    if (!pre) {
      pre = document.createElement('pre');
      pre.className = 'ma-tool-result';
      el.appendChild(pre);
    }
    pre.textContent = JSON.stringify(result, null, 0).slice(0, 500);
  }
}

function nextImgLabel() {
  imgSeq += 1;
  return `img${imgSeq}`;
}

function insertAtCursor(ta, text) {
  if (!ta) return;
  const s = ta.selectionStart ?? ta.value.length;
  const e = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + text.length;
  ta.dispatchEvent(new Event('input'));
}

/** Upload blob → server path; insert [imgN](path) into input. */
async function uploadAndInsertImage(blob, filename) {
  const headers = authHeaders({ 'x-filename': filename || `paste-${Date.now()}.png` });
  // raw body upload — do not set Content-Type (browser sets multipart/stream)
  delete headers['Content-Type'];
  const res = await fetch('/api/upload-image', {
    method: 'POST',
    headers,
    body: blob,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Upload failed: ${res.status}`);
  }
  const { path: filePath } = await res.json();
  if (!filePath) throw new Error('upload returned no path');
  const label = nextImgLabel();
  const ref = `[${label}](${filePath})`;
  const ta = $('ma-input');
  insertAtCursor(ta, (ta?.value && !ta.value.endsWith('\n') && ta.value.length ? '\n' : '') + ref + '\n');
  let previewUrl = '';
  try {
    previewUrl = URL.createObjectURL(blob);
  } catch { /* ignore */ }
  pendingImages.push({ path: filePath, previewUrl, label, ref });
  renderAttachBar();
  return { path: filePath, ref, label };
}

function renderAttachBar() {
  const bar = $('ma-attach-bar');
  if (!bar) return;
  if (!pendingImages.length) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }
  bar.classList.remove('hidden');
  bar.innerHTML = pendingImages.map((item, i) => `
    <div class="ma-thumb relative" title="${esc(item.ref || item.path)}">
      ${item.previewUrl ? `<img src="${item.previewUrl}" alt="${esc(item.label || 'img')}">` : `<span class="ma-thumb-path">${esc(item.label || 'img')}</span>`}
      <span class="ma-thumb-label">${esc(item.label || '')}</span>
      <button type="button" class="ma-thumb-x" data-rm-img="${i}">✕</button>
    </div>`).join('');
  bar.querySelectorAll('[data-rm-img]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.rmImg, 10);
      const item = pendingImages[i];
      if (item?.previewUrl) {
        try { URL.revokeObjectURL(item.previewUrl); } catch {}
      }
      // remove matching ref from input if still present
      const ta = $('ma-input');
      if (ta && item?.ref) {
        ta.value = ta.value.split(item.ref).join('').replace(/\n{3,}/g, '\n\n');
        ta.dispatchEvent(new Event('input'));
      }
      pendingImages.splice(i, 1);
      renderAttachBar();
    });
  });
}

function fmtSessionWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

async function refreshHistoryCache() {
  try {
    const data = await api('GET', '/api/ai/sessions');
    historyCache = data.sessions || [];
  } catch {
    historyCache = [];
  }
  return historyCache;
}

function renderHistoryList() {
  const list = $('ma-history-list');
  if (!list) return;
  const q = (historySearch || '').trim().toLowerCase();
  let rows = historyCache;
  if (q) {
    rows = rows.filter((s) => {
      const hay = `${s.title || ''} ${s.preview || ''} ${s.id || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }
  if (!rows.length) {
    list.innerHTML = `<div class="text-center text-xs text-base-content/40 py-10">
      ${q ? '没有匹配的会话' : '还没有历史对话。发一条消息后会出现在这里。'}
    </div>`;
    return;
  }
  list.innerHTML = rows.map((s) => {
    const active = s.id === chatSessionId;
    const when = fmtSessionWhen(s.updatedAt) || '';
    const n = s.messageCount || 0;
    return `
      <div class="ma-hist-item ${active ? 'active' : ''}" data-hist-id="${esc(s.id)}">
        <div class="flex items-start gap-2">
          <button type="button" class="ma-hist-open flex-1 min-w-0 text-left" data-hist-open="${esc(s.id)}">
            <div class="font-medium text-xs truncate">${esc(s.title || s.id.slice(0, 8))}</div>
            <div class="text-[10px] text-base-content/45 mt-0.5 line-clamp-2">${esc(s.preview || '（无预览）')}</div>
            <div class="text-[10px] text-base-content/35 mt-1">${esc(when)}${n ? ` · ${n} 条` : ''}${active ? ' · 当前' : ''}</div>
          </button>
          <div class="flex flex-col gap-0.5 flex-shrink-0">
            <button type="button" class="btn btn-ghost btn-xs px-1" data-hist-resume="${esc(s.id)}" title="打开并继续">↵</button>
            <button type="button" class="btn btn-ghost btn-xs px-1 text-error" data-hist-del="${esc(s.id)}" title="删除">✕</button>
          </div>
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('[data-hist-open]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await loadSession(btn.dataset.histOpen);
      setMode('chat');
      $('ma-input')?.focus();
    });
  });
  list.querySelectorAll('[data-hist-resume]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await loadSession(btn.dataset.histResume);
      setMode('chat');
      $('ma-input')?.focus();
    });
  });
  list.querySelectorAll('[data-hist-del]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.histDel;
      if (!confirm('删除该历史会话？不可恢复。')) return;
      try {
        await api('DELETE', `/api/ai/sessions/${id}`);
        if (chatSessionId === id) {
          chatSessionId = null;
          currentSessionMeta = null;
          localStorage.removeItem(LAST_SESSION_KEY);
          loadSession(null);
        }
        await refreshHistoryCache();
        renderHistoryList();
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

function userContentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p?.type === 'text') return p.text || '';
        if (p?.type === 'image_url') return '[图片]';
        return '';
      })
      .filter(Boolean)
      .join('\n') || '[…]';
  }
  return '[…]';
}

function renderHistoryMessages(messages) {
  const box = $('ma-messages');
  if (!box) return;
  box.innerHTML = '';
  if (!messages?.length) {
    appendMsg('system', '此会话暂无消息。');
    return;
  }
  for (const m of messages) {
    if (m.role === 'user') {
      appendMsg('user', userContentToText(m.content));
      continue;
    }
    if (m.role === 'assistant') {
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          const name = tc.function?.name || tc.name || 'tool';
          let args = {};
          try {
            args = JSON.parse(tc.function?.arguments || tc.arguments || '{}');
          } catch { /* empty */ }
          appendMsg('tool', '', {
            name,
            args,
            phase: 'history',
            id: tc.id || name,
          });
        }
      }
      if (m.content) {
        appendMsg('assistant', typeof m.content === 'string' ? m.content : userContentToText(m.content));
      }
      continue;
    }
    if (m.role === 'tool') {
      let result = m.content;
      try {
        result = JSON.parse(m.content);
      } catch { /* keep string */ }
      // attach to last matching tool chip if possible
      const id = m.tool_call_id || '';
      if (id) updateToolChip(id, 'done', result);
      else {
        appendMsg('tool', '', {
          name: 'tool_result',
          args: {},
          phase: 'done',
          id: `tr_${Math.random().toString(36).slice(2, 8)}`,
        });
        // best-effort show result on last tool
        const chips = box.querySelectorAll('.ma-tool');
        const last = chips[chips.length - 1];
        if (last) {
          last.classList.add('done');
          let pre = last.querySelector('.ma-tool-result');
          if (!pre) {
            pre = document.createElement('pre');
            pre.className = 'ma-tool-result';
            last.appendChild(pre);
          }
          pre.textContent = typeof result === 'string'
            ? result.slice(0, 500)
            : JSON.stringify(result, null, 0).slice(0, 500);
        }
      }
    }
  }
  box.scrollTop = box.scrollHeight;
}

async function deleteCurrentSession() {
  if (!chatSessionId) {
    await loadSession(null);
    return;
  }
  if (!confirm('删除当前 Meta Agent 会话？此操作不可恢复。')) return;
  try {
    await api('DELETE', `/api/ai/sessions/${chatSessionId}`);
    chatSessionId = null;
    currentSessionMeta = null;
    localStorage.removeItem(LAST_SESSION_KEY);
    await refreshHistoryCache();
    await loadSession(null);
    if (mode === 'history') renderHistoryList();
  } catch (e) {
    appendMsg('error', e.message);
  }
}

/**
 * Load session for viewing + resume.
 * Server keeps full tool history; next send uses same sessionId.
 */
async function loadSession(id, opts = {}) {
  if (!id) {
    chatSessionId = null;
    currentSessionMeta = null;
    localStorage.removeItem(LAST_SESSION_KEY);
    const box = $('ma-messages');
    if (box) box.innerHTML = '';
    appendMsg('system', '新对话 — 贴图 → [imgN](路径)；需要看图时调用 VLM。历史在「历史」页，可随时 resume。');
    updateSessionChrome();
    return null;
  }
  try {
    const s = await api('GET', `/api/ai/sessions/${id}`);
    chatSessionId = s.id;
    currentSessionMeta = {
      id: s.id,
      title: s.title,
      updatedAt: s.updatedAt,
      messageCount: (s.messages || []).length,
    };
    localStorage.setItem(LAST_SESSION_KEY, s.id);
    renderHistoryMessages(s.messages || []);
    if (!opts.silent) {
      appendMsg('system', '↑ 历史已加载。在下方继续输入即可 resume（服务端保留完整 tool / VLM 上下文）。');
    }
    updateSessionChrome();
    // refresh list active state if visible
    if (mode === 'history') renderHistoryList();
    return s;
  } catch (e) {
    if (!opts.silent) appendMsg('error', e.message);
    throw e;
  }
}

async function sendChat() {
  if (streaming) return;
  const input = $('ma-input');
  const text = (input?.value || '').trim();
  if (!text) return;

  streaming = true;
  $('ma-send').disabled = true;
  appendMsg('user', text);
  input.value = '';
  input.style.height = '';
  // clear local previews (paths already in message text)
  for (const item of pendingImages) {
    if (item.previewUrl) {
      try { URL.revokeObjectURL(item.previewUrl); } catch {}
    }
  }
  pendingImages = [];
  renderAttachBar();

  let asstEl = null;
  let content = '';

  try {
    await streamSSE('/api/ai/chat', {
      message: text,
      sessionId: chatSessionId,
    }, {
      session: (d) => {
        chatSessionId = d.id;
        currentSessionMeta = {
          ...(currentSessionMeta || {}),
          id: d.id,
          title: d.title || currentSessionMeta?.title || text.slice(0, 40),
          updatedAt: Date.now(),
        };
        localStorage.setItem(LAST_SESSION_KEY, d.id);
        updateSessionChrome();
      },
      content: (d) => {
        content = d.content || '';
        if (!asstEl) asstEl = appendMsg('assistant', '');
        updateAssistant(asstEl, content);
      },
      tool: (d) => {
        if (d.phase === 'start') {
          appendMsg('tool', '', { name: d.name, args: d.args, phase: 'start', id: d.id });
        } else {
          updateToolChip(d.id, d.phase, d.result);
        }
      },
      done: (d) => {
        if (d.sessionId) {
          chatSessionId = d.sessionId;
          localStorage.setItem(LAST_SESSION_KEY, d.sessionId);
        }
        if (d.title || d.sessionId) {
          currentSessionMeta = {
            id: chatSessionId,
            title: d.title || currentSessionMeta?.title || '对话',
            updatedAt: Date.now(),
            messageCount: (currentSessionMeta?.messageCount || 0) + 2,
          };
        }
        if (d.content && asstEl) updateAssistant(asstEl, d.content);
        updateSessionChrome();
        refreshHistoryCache();
      },
      error: (d) => {
        appendMsg('error', d.message || 'error');
      },
    });
  } catch (e) {
    appendMsg('error', e.message);
  } finally {
    streaming = false;
    $('ma-send').disabled = false;
  }
}

async function generateReport() {
  if (streaming) return;
  streaming = true;
  const days = parseInt($('ma-report-days')?.value || '1', 10);
  const body = $('ma-report-body');
  body.innerHTML = `<div class="text-sm text-base-content/50 py-6 text-center">正在汇总近 ${days} 天活动…</div>`;
  $('ma-gen-report').disabled = true;
  let content = '';
  const tools = document.createElement('div');
  tools.className = 'ma-report-tools flex flex-col gap-1 mb-3';

  try {
    await streamSSE('/api/ai/report', { days }, {
      content: (d) => {
        content = d.content || '';
        body.innerHTML = '';
        body.appendChild(tools);
        const md = document.createElement('div');
        md.className = 'md ma-report-md';
        md.innerHTML = mdHtml(content);
        highlight(md);
        body.appendChild(md);
      },
      tool: (d) => {
        if (d.phase === 'start') {
          const chip = document.createElement('div');
          chip.className = 'ma-tool';
          chip.dataset.toolId = d.id || d.name;
          chip.innerHTML = `<span class="ma-tool-name">${esc(d.name)}</span> <span class="ma-tool-phase">start</span>`;
          tools.appendChild(chip);
        } else {
          const chip = tools.querySelector(`[data-tool-id="${CSS.escape(d.id || d.name)}"]`);
          if (chip) {
            chip.classList.add(d.phase === 'error' ? 'error' : 'done');
            chip.querySelector('.ma-tool-phase').textContent = d.phase;
          }
        }
      },
      done: (d) => {
        if (d.content) {
          body.innerHTML = '';
          body.appendChild(tools);
          const md = document.createElement('div');
          md.className = 'md ma-report-md';
          md.innerHTML = mdHtml(d.content);
          highlight(md);
          body.appendChild(md);
        }
      },
      error: (d) => {
        body.innerHTML = `<div class="alert alert-error text-sm">${esc(d.message)}</div>`;
      },
    });
  } catch (e) {
    body.innerHTML = `<div class="alert alert-error text-sm">${esc(e.message)}</div>`;
  } finally {
    streaming = false;
    $('ma-gen-report').disabled = false;
  }
}

async function loadTodayReportQuiet() {
  try {
    const today = new Date();
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const r = await api('GET', `/api/ai/reports/${day}`);
    if (r?.markdown) {
      const body = $('ma-report-body');
      body.innerHTML = `
        <div class="text-[10px] text-base-content/40 mb-2">${esc(r.title || day)} · ${esc(r.generatedAt || '')}</div>
        <div class="md ma-report-md">${mdHtml(r.markdown)}</div>`;
      highlight(body);
    }
  } catch { /* none */ }
}

async function loadReportList() {
  const list = $('ma-report-list');
  try {
    const data = await api('GET', '/api/ai/reports');
    list.classList.remove('hidden');
    const rows = data.reports || [];
    if (!rows.length) {
      list.innerHTML = '<div class="text-xs text-base-content/40 px-2 py-1">暂无历史报告</div>';
      return;
    }
    list.innerHTML = rows.map((r) => `
      <button type="button" class="ma-report-item w-full text-left px-2 py-1 rounded hover:bg-base-200 text-xs"
        data-day="${esc(r.day)}">
        <span class="font-semibold">${esc(r.day)}</span>
        <span class="text-base-content/45 ml-1">${esc(r.title || '')}</span>
      </button>`).join('');
    list.querySelectorAll('[data-day]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const r = await api('GET', `/api/ai/reports/${btn.dataset.day}`);
          const body = $('ma-report-body');
          body.innerHTML = `
            <div class="text-[10px] text-base-content/40 mb-2">${esc(r.title || r.day)} · ${esc(r.generatedAt || '')}</div>
            <div class="md ma-report-md">${mdHtml(r.markdown)}</div>`;
          highlight(body);
        } catch (e) {
          $('ma-report-body').innerHTML = `<div class="alert alert-error text-sm">${esc(e.message)}</div>`;
        }
      });
    });
  } catch (e) {
    list.classList.remove('hidden');
    list.innerHTML = `<div class="text-xs text-error px-2">${esc(e.message)}</div>`;
  }
}

async function loadConfigForm() {
  try {
    const c = await api('GET', '/api/ai/config');
    $('ma-cfg-url').value = c.url || '';
    $('ma-cfg-model').value = c.model || '';
    $('ma-cfg-key').placeholder = c.hasKey ? '已配置 · 留空不修改' : 'API Key';
    $('ma-cfg-key').value = '';
    $('ma-cfg-vlm-url').value = c.vlm_url || '';
    $('ma-cfg-vlm-model').value = c.vlm_model || '';
    $('ma-cfg-vlm-key').value = '';
    $('ma-cfg-vlm-key').placeholder = c.hasVlmKey ? '已配置 · 留空不修改' : '可选';
    $('ma-cfg-system').value = c.system || '';
    if ($('ma-auto-report')) $('ma-auto-report').checked = !!c.auto_report;
    if ($('ma-auto-hour')) $('ma-auto-hour').value = String(c.auto_report_hour ?? 18);
    scheduleAutoReport(c);
  } catch (e) {
    $('ma-cfg-status').textContent = e.message;
  }
}

async function saveConfig() {
  const status = $('ma-cfg-status');
  status.textContent = '保存中…';
  try {
    const patch = {
      url: $('ma-cfg-url').value.trim(),
      model: $('ma-cfg-model').value.trim(),
      vlm_url: $('ma-cfg-vlm-url').value.trim(),
      vlm_model: $('ma-cfg-vlm-model').value.trim(),
      system: $('ma-cfg-system').value,
      auto_report: !!$('ma-auto-report')?.checked,
      auto_report_hour: parseInt($('ma-auto-hour')?.value || '18', 10),
    };
    const key = $('ma-cfg-key').value.trim();
    const vlmKey = $('ma-cfg-vlm-key').value.trim();
    if (key) patch.key = key;
    if (vlmKey) patch.vlm_key = vlmKey;
    const c = await api('PUT', '/api/ai/config', patch);
    status.textContent = c.hasKey ? '已保存 ✓' : '已保存（未设置 Key）';
    $('ma-cfg-key').value = '';
    $('ma-cfg-vlm-key').value = '';
    scheduleAutoReport(c);
  } catch (e) {
    status.textContent = e.message;
  }
}

function scheduleAutoReport(cfg) {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
  if (!cfg?.auto_report) return;
  const hour = cfg.auto_report_hour ?? 18;
  autoTimer = setInterval(async () => {
    if (!ctx.token) return;
    const now = new Date();
    if (now.getHours() !== hour) return;
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (lastAutoDay === day) return;
    // only fire in the first 10 minutes of the hour
    if (now.getMinutes() > 10) return;
    try {
      lastAutoDay = day;
      localStorage.setItem('ai_last_auto_report', day);
      await streamSSE('/api/ai/report', { days: cfg.auto_report_days || 1 }, {
        done: () => {
          console.info('[meta-agent] auto report saved for', day);
        },
        error: (d) => console.warn('[meta-agent] auto report', d.message),
      });
    } catch (e) {
      console.warn('[meta-agent] auto report failed', e);
      lastAutoDay = ''; // allow retry
      localStorage.removeItem('ai_last_auto_report');
    }
  }, 60 * 1000);
}

export function initMetaAgent() {
  if ($('meta-agent-panel')) return;
  document.getElementById('root')?.insertAdjacentHTML('beforeend', panelHTML());

  document.querySelectorAll('[data-ma-close]').forEach((el) => {
    el.addEventListener('click', closeMetaAgent);
  });
  $('ma-btn-chat')?.addEventListener('click', () => setMode('chat'));
  $('ma-btn-history')?.addEventListener('click', async () => {
    await refreshHistoryCache();
    setMode('history');
  });
  $('ma-open-history')?.addEventListener('click', async () => {
    await refreshHistoryCache();
    setMode('history');
  });
  $('ma-btn-report')?.addEventListener('click', () => {
    setMode('report');
    loadTodayReportQuiet();
  });
  $('ma-btn-config')?.addEventListener('click', () => {
    setMode('config');
    loadConfigForm();
  });
  $('ma-send')?.addEventListener('click', sendChat);
  $('ma-input')?.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      sendChat();
    }
  });
  $('ma-input')?.addEventListener('input', () => {
    const el = $('ma-input');
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  });
  $('ma-new-chat')?.addEventListener('click', () => {
    loadSession(null);
    setMode('chat');
  });
  $('ma-del-session')?.addEventListener('click', deleteCurrentSession);
  $('ma-resume-focus')?.addEventListener('click', () => {
    $('ma-input')?.focus();
  });
  $('ma-history-refresh')?.addEventListener('click', async () => {
    await refreshHistoryCache();
    renderHistoryList();
  });
  $('ma-history-new')?.addEventListener('click', () => {
    loadSession(null);
    setMode('chat');
  });
  $('ma-history-search')?.addEventListener('input', (e) => {
    historySearch = e.target.value || '';
    renderHistoryList();
  });
  $('ma-quick-today')?.addEventListener('click', () => {
    setMode('chat');
    $('ma-input').value = '根据我最近的会话，总结今天我做了什么？按项目列出亮点与未完成事项。';
    sendChat();
  });
  $('ma-quick-projects')?.addEventListener('click', () => {
    setMode('chat');
    $('ma-input').value = '列出最近 14 天活跃的项目，每个项目一句话说明最近在做什么。';
    sendChat();
  });
  $('ma-gen-report')?.addEventListener('click', generateReport);
  $('ma-load-reports')?.addEventListener('click', loadReportList);
  $('ma-cfg-save')?.addEventListener('click', saveConfig);
  $('ma-auto-report')?.addEventListener('change', async () => {
    try {
      const c = await api('PUT', '/api/ai/config', {
        auto_report: !!$('ma-auto-report').checked,
        auto_report_hour: parseInt($('ma-auto-hour')?.value || '18', 10),
      });
      scheduleAutoReport(c);
    } catch {}
  });
  $('ma-auto-hour')?.addEventListener('change', async () => {
    try {
      const c = await api('PUT', '/api/ai/config', {
        auto_report: !!$('ma-auto-report')?.checked,
        auto_report_hour: parseInt($('ma-auto-hour').value || '18', 10),
      });
      scheduleAutoReport(c);
    } catch {}
  });
  $('ma-image-input')?.addEventListener('change', async (e) => {
    const files = [...(e.target.files || [])];
    const ta = $('ma-input');
    if (ta) ta.disabled = true;
    try {
      for (const f of files) {
        if (!f.type.startsWith('image/')) continue;
        if (f.size > 12 * 1024 * 1024) {
          appendMsg('error', `${f.name} 过大 (>12MB)`);
          continue;
        }
        await uploadAndInsertImage(f, f.name || `upload-${Date.now()}.png`);
      }
    } catch (err) {
      appendMsg('error', `图片上传失败: ${err.message}`);
    } finally {
      e.target.value = '';
      if (ta) { ta.disabled = false; ta.focus(); }
    }
  });

  // paste image → upload → insert [imgN](path)
  document.addEventListener('paste', async (e) => {
    if (!panelOpen || mode !== 'chat') return;
    const ta = $('ma-input');
    const panel = $('meta-agent-panel');
    const ae = document.activeElement;
    // only when focus is inside the agent panel
    if (!panel || !ae || !panel.contains(ae)) return;
    const items = [...(e.clipboardData?.items || [])];
    const imageItems = items.filter((it) => it.type.startsWith('image/'));
    if (!imageItems.length) return;
    e.preventDefault();
    if (ta) ta.disabled = true;
    try {
      for (const it of imageItems) {
        const f = it.getAsFile();
        if (!f) continue;
        const ext = (it.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
        await uploadAndInsertImage(f, `paste-${Date.now()}.${ext}`);
      }
    } catch (err) {
      appendMsg('error', `粘贴图片失败: ${err.message}`);
    } finally {
      if (ta) { ta.disabled = false; ta.focus(); }
    }
  });

  // bootstrap: empty chat (last session restored on openMetaAgent)
  loadSession(null, { silent: true });
  refreshHistoryCache();
  api('GET', '/api/ai/config').then(scheduleAutoReport).catch(() => {});
}

// unused import guard for hub — kept for future machine-scoped AI
void hubMode;
void currentMachineId;
