/**
 * meta-agent.js — Built-in OpenAI-compatible agent with tools.
 *
 * Capabilities:
 *  - Activity / project Q&A (sessions, messages, notes, git, files)
 *  - Daily work reports (manual or scheduled via client)
 *  - Code gen + run (run_command / write_file / read_file)
 *  - VLM via analyze_images only (user pastes → [imgN](path) text refs)
 *  - VLM multi-turn threads (thread_id) reuse images + prior Q&A
 *
 * Config: .ai_config.json (API keys stay server-side).
 * Reports: .ai_reports.json
 * Chat sessions (same sessionId owns chat + VLM):
 *   .ai/sessions/index.json
 *   .ai/sessions/{sessionId}/
 *     meta.json
 *     messages.jsonl              # chat turns (one JSON object per line)
 *     vlm/{threadId}.jsonl        # each image-analysis thread is its own jsonl
 *                                 #   (multi-image / multi-thread / multi-turn)
 * Legacy layouts auto-migrated.
 */

import { promises as fs } from 'fs';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';

export const AI_DEFAULTS = {
  url: 'https://api.deepseek.com/chat/completions',
  model: 'deepseek-chat',
  vlm_url: '',
  vlm_model: '',
  temperature: 0.3,
  auto_report: false,
  auto_report_hour: 18,
  auto_report_days: 1,
};

export const DEFAULT_SYSTEM = `你是 Claude Simple UI 的内置工作助手（Meta Agent）。你能访问本机上的 Claude / Codex / Grok 会话、项目笔记、Git 与文件，并生成「我做了啥」的工作报告。

规则：
1. 需要会话 id / 项目路径时，先 list_projects 或 search_activity / list_sessions，再深入 get_session_brief / get_session_summary。超长会话先读 get_session_brief；只有需要逐事件定位问题时才读 get_session_jsonl。
2. 回答要具体：引用项目路径、会话标题、时间范围；不确定就再查。
3. 写日报/周报用 generate_activity_digest 拉快照，再组织成清晰 Markdown（亮点、按项目、未完成、建议）。
4. 改文件或跑命令前说明意图；危险命令拒绝（rm -rf /、格式化磁盘等）。
5. 图片约定（重要）：
   - 用户粘贴图片后，正文会出现 [img1](/path/to.png) 或 ![name](/path) 形式的**路径引用**，不会直接把像素发给你。
   - 需要看图/OCR/分析时，调用 analyze_images，传入 image_paths（从引用里提取绝对路径）和 prompt。
   - 同一批图的追问：传入上次返回的 thread_id + 新 prompt，可复用图片与历史问答，不必重复传路径（也可继续传 paths 以补图）。
   - 不要假装已经看到图片；没调用工具就说「根据路径无法看见内容」。
6. 需要验证时：write_file 写代码 → run_command 执行 → 根据输出迭代。
7. 回复简洁有结构，中文优先（用户用中文时）。`;

export const REPORT_SYSTEM = `你是工作复盘助手。根据提供的 JSON 活动快照，写一份清晰的工作报告（Markdown）。
结构建议：
## 概览（时段、会话数、项目数、token 粗估）
## 今日/本期亮点（3-8 条）
## 按项目
### 项目名
- 做了什么（结合会话标题与摘录）
- 未竟事项（若有）
## 观察与建议
只基于数据，不编造。`;

const MUTATING = new Set([
  'set_project_notes', 'write_file', 'run_command', 'save_report',
]);

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_sessions',
      description: '列出最近 agent 会话（Claude/Codex/Grok）元数据',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'integer', description: '只看最近 N 天，0=全部，默认 14' },
          agent: { type: 'string', enum: ['claude', 'codex', 'grok'], description: '可选过滤' },
          cwd: { type: 'string', description: '按工作目录过滤' },
          limit: { type: 'integer', description: '最多返回条数，默认 40' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_projects',
      description: '按项目（cwd）聚合会话，看最近在哪些项目工作',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'integer', description: '默认 14' },
          agent: { type: 'string' },
          limit: { type: 'integer', description: '默认 30' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_activity',
      description: '搜索最近活动（元数据 + 可选内容窥视）',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string', description: '关键词' },
          days: { type: 'integer', description: '默认 14' },
          agent: { type: 'string' },
          limit: { type: 'integer', description: '默认 40' },
          deep: { type: 'boolean', description: '是否深读会话内容，默认 true' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_session_summary',
      description: '读取某会话消息摘要（用户话 + assistant 摘录）',
      parameters: {
        type: 'object',
        required: ['sessionId'],
        properties: {
          sessionId: { type: 'string' },
          agent: { type: 'string' },
          maxMessages: { type: 'integer', description: '默认 30' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_session_brief',
      description: '读取会话压缩上下文，适合非常长的 session；包含项目/会话备注、关键用户意图与最近进展',
      parameters: {
        type: 'object',
        required: ['sessionId'],
        properties: {
          sessionId: { type: 'string' },
          agent: { type: 'string' },
          maxTurns: { type: 'integer', description: '默认 6，返回多少个采样转折点' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_session_jsonl',
      description: '读取 Claude/Codex/Grok 指定会话的原始 JSONL 行，用于逐事件、工具调用或失败原因分析；内容可能敏感，只在当前回答中使用',
      parameters: {
        type: 'object',
        required: ['sessionId'],
        properties: {
          sessionId: { type: 'string' },
          agent: { type: 'string', enum: ['claude', 'codex', 'grok'], description: '建议明确指定来源 agent' },
          offset: { type: 'integer', description: '从第几行开始，默认 0' },
          maxLines: { type: 'integer', description: '每次最多 2000 行，默认 500' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_project_notes',
      description: '读取项目 goal / notes',
      parameters: {
        type: 'object',
        required: ['cwd'],
        properties: { cwd: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_project_notes',
      description: '更新项目 goal 和/或 notes',
      parameters: {
        type: 'object',
        required: ['cwd'],
        properties: {
          cwd: { type: 'string' },
          goal: { type: 'string' },
          notes: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_meta_notes',
      description: '列出 Meta Notes（Hub 侧持久化工作笔记）',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['all', 'project', 'session', 'general'], description: '默认 all' },
          q: { type: 'string', description: '按标题/正文搜索' },
          cwd: { type: 'string', description: '按项目路径过滤' },
          sessionId: { type: 'string', description: '按 session 过滤' },
          agent: { type: 'string', description: 'session 过滤时可指定 agent' },
          limit: { type: 'integer', description: '默认 30' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_meta_note',
      description: '创建或更新一条 Meta Note，可关联项目或 session',
      parameters: {
        type: 'object',
        required: ['title', 'content'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string' },
          cwd: { type: 'string' },
          sessionId: { type: 'string' },
          agent: { type: 'string' },
          pinned: { type: 'boolean' },
          tags: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_meta_note',
      description: '删除一条 Meta Note',
      parameters: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: '查看目录 git status',
      parameters: {
        type: 'object',
        required: ['cwd'],
        properties: { cwd: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_log',
      description: '查看 git 最近提交',
      parameters: {
        type: 'object',
        required: ['cwd'],
        properties: {
          cwd: { type: 'string' },
          limit: { type: 'integer', description: '默认 15' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出目录内容（绝对路径）',
      parameters: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string' },
          max: { type: 'integer', description: '默认 80' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取文本文件（有大小上限）',
      parameters: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string' },
          maxBytes: { type: 'integer', description: '默认 120000' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写入/创建文本文件（用于生成代码脚本等）',
      parameters: {
        type: 'object',
        required: ['path', 'content'],
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '在指定目录执行 shell 命令（有超时与危险命令拦截）',
      parameters: {
        type: 'object',
        required: ['command'],
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string', description: '工作目录，默认 home' },
          timeoutMs: { type: 'integer', description: '默认 60000，最大 180000' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'analyze_images',
      description:
        '用 VLM 分析图片。用户消息里的 [imgN](绝对路径) / ![name](路径) 需提取路径后调用。' +
        '首次分析传 image_paths + prompt，返回 thread_id；追问同一批图时传 thread_id + 新 prompt 即可复用上下文。',
      parameters: {
        type: 'object',
        required: ['prompt'],
        properties: {
          image_paths: {
            type: 'array',
            items: { type: 'string' },
            description: '磁盘绝对路径列表；首次必填（除非 thread_id 已绑定图片）',
          },
          images: {
            type: 'array',
            items: { type: 'string' },
            description: '同 image_paths（兼容别名）',
          },
          prompt: { type: 'string', description: '本次问题/分析要求' },
          thread_id: {
            type: 'string',
            description: '已有 VLM 线程 id，用于追问；省略则新建线程',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_activity_digest',
      description: '生成结构化活动快照（供写报告/问答）',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'integer', description: '默认 1（今天起算）' },
          agent: { type: 'string' },
          includeMessages: { type: 'boolean', description: '是否抽会话内容，默认 true' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_report',
      description: '把生成好的报告存盘',
      parameters: {
        type: 'object',
        required: ['markdown'],
        properties: {
          day: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
          markdown: { type: 'string' },
          title: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_reports',
      description: '列出已保存的工作报告',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_report',
      description: '读取某日报告',
      parameters: {
        type: 'object',
        properties: { day: { type: 'string' } },
      },
    },
  },
];

function expandPath(p) {
  if (!p) return p;
  return String(p).replace(/^~(?=$|[/\\])/, os.homedir());
}

function pad(n) {
  return String(n).padStart(2, '0');
}

export function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayStartMs(daysAgo = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.getTime();
}

function shortTitle(s, n = 80) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function extractTextParts(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p?.type === 'text') return p.text || '';
        if (p?.text) return p.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object' && content.text) return content.text;
  return '';
}

function dangerousCommand(cmd) {
  const s = String(cmd || '');
  const patterns = [
    /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\s*$/,
    /\brm\s+-rf\s+\/(?!\w)/,
    /\bmkfs\b/,
    /\bdd\s+if=.*of=\/dev\//,
    /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/,
    /\bshutdown\b/,
    /\breboot\b/,
    />\s*\/dev\/sd[a-z]/,
    /\bcurl\b.*\|\s*(ba)?sh\b/,
  ];
  return patterns.some((re) => re.test(s));
}

export function createMetaAgent(deps) {
  const {
    rootDir,
    listSessions,
    searchActivity,
    loadSessionMessages,
    loadSessionJsonl,
    groupByProject,
    toClientSession,
    getProjectNotesStore,
    saveProjectNotesStore,
    getSessionMetaStore,
    normalizeProjectEntry,
    git,
    isGitRepo,
    claudeConfigDirs,
    codexHome,
    grokHome,
  } = deps;

  const configFile = path.join(rootDir, '.ai_config.json');
  const reportsFile = path.join(rootDir, '.ai_reports.json');
  const legacySessionsFile = path.join(rootDir, '.ai_sessions.json');
  const aiDir = process.env.AI_DATA_DIR
    ? expandPath(process.env.AI_DATA_DIR)
    : path.join(rootDir, '.ai');
  const notesFile = path.join(aiDir, 'meta-notes.json');
  const sessionBriefsFile = path.join(aiDir, 'session-briefs.json');
  const sessionsDir = path.join(aiDir, 'sessions');
  /** @deprecated global vlm — only for one-time migration */
  const legacyGlobalVlmDir = path.join(aiDir, 'vlm');
  const sessionsIndexFile = path.join(sessionsDir, 'index.json');

  const MAX_SESSIONS = 200;
  const MAX_VLM_THREADS_PER_SESSION = 40;
  const VLM_THREAD_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d on disk
  const ANON_SESSION_ID = '_anonymous';

  /** run_command approval gate: id → { resolve } (see requestApproval/resolveApproval) */
  const pendingApprovals = new Map();
  const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

  /** Ask the caller (via onApproval) to confirm a sensitive tool call; auto-denies if unattended or timed out. */
  function requestApproval(onApproval, name, args) {
    if (typeof onApproval !== 'function') return Promise.resolve(false);
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingApprovals.delete(id);
        resolve(false);
      }, APPROVAL_TIMEOUT_MS);
      pendingApprovals.set(id, {
        resolve: (approved) => {
          clearTimeout(timer);
          pendingApprovals.delete(id);
          resolve(!!approved);
        },
      });
      onApproval({ id, name, args });
    });
  }

  /** Called from the /api/ai/approve endpoint when the user responds. */
  function resolveApproval(id, approved) {
    const pending = pendingApprovals.get(id);
    if (!pending) return false;
    pending.resolve(approved);
    return true;
  }

  let configCache = null;
  let reportsCache = null;
  let notesCache = null;
  let sessionBriefsCache = null;
  /** @type {{ version: number, sessions: Array<{id,title,createdAt,updatedAt,messageCount}> } | null} */
  let sessionsIndexCache = null;
  /** in-memory cache of full sessions (id → session) */
  const sessionBodyCache = new Map();

  /**
   * VLM threads keyed by `${sessionId}::${threadId}`
   * @type {Map<string, { id: string, sessionId: string, imagePaths: string[], messages: any[], updatedAt: number }>}
   */
  const vlmThreads = new Map();
  let layoutMigrated = false;

  async function ensureAiDirs() {
    await fs.mkdir(sessionsDir, { recursive: true });
  }

  async function loadNotesStore() {
    if (notesCache) return notesCache;
    await ensureAiDirs();
    try {
      const raw = JSON.parse(await fs.readFile(notesFile, 'utf8'));
      notesCache = {
        version: raw.version || 1,
        notes: Array.isArray(raw.notes) ? raw.notes : [],
      };
    } catch {
      notesCache = { version: 1, notes: [] };
    }
    return notesCache;
  }

  async function saveNotesStore() {
    if (!notesCache) return;
    await atomicWriteJson(notesFile, notesCache);
  }

  async function loadSessionBriefsStore() {
    if (sessionBriefsCache) return sessionBriefsCache;
    await ensureAiDirs();
    try {
      sessionBriefsCache = JSON.parse(await fs.readFile(sessionBriefsFile, 'utf8'));
    } catch {
      sessionBriefsCache = {};
    }
    return sessionBriefsCache;
  }

  async function saveSessionBriefsStore() {
    if (!sessionBriefsCache) return;
    await atomicWriteJson(sessionBriefsFile, sessionBriefsCache);
  }

  async function atomicWriteText(filePath, text) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, text, 'utf8');
    await fs.rename(tmp, filePath);
  }

  async function atomicWriteJson(filePath, data) {
    await atomicWriteText(filePath, JSON.stringify(data, null, 2));
  }

  /** Rewrite array as JSONL (one JSON object per line). */
  async function writeJsonl(filePath, rows) {
    const lines = (rows || []).map((r) => JSON.stringify(r));
    const body = lines.length ? `${lines.join('\n')}\n` : '';
    await atomicWriteText(filePath, body);
  }

  async function readJsonl(filePath) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      if (!raw.trim()) return [];
      const out = [];
      for (const line of raw.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try {
          out.push(JSON.parse(s));
        } catch { /* skip bad line */ }
      }
      return out;
    } catch {
      return [];
    }
  }

  function safeId(id) {
    return String(id).replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  function sessionDir(id) {
    return path.join(sessionsDir, safeId(id));
  }

  function metaPath(id) {
    return path.join(sessionDir(id), 'meta.json');
  }

  function messagesJsonlPath(id) {
    return path.join(sessionDir(id), 'messages.jsonl');
  }

  function vlmDir(sessionId) {
    return path.join(sessionDir(sessionId || ANON_SESSION_ID), 'vlm');
  }

  /** Per-thread log: sessions/{sessionId}/vlm/{threadId}.jsonl */
  function vlmThreadJsonlPath(sessionId, threadId) {
    return path.join(vlmDir(sessionId), `${safeId(threadId)}.jsonl`);
  }

  /** @deprecated monolithic session vlm.jsonl */
  function legacySessionVlmJsonl(sessionId) {
    return path.join(sessionDir(sessionId || ANON_SESSION_ID), 'vlm.jsonl');
  }

  /** @deprecated legacy single-file session */
  function legacySessionJsonPath(id) {
    return path.join(sessionDir(id), 'session.json');
  }

  function vlmMemKey(sessionId, threadId) {
    return `${sessionId || ANON_SESSION_ID}::${threadId}`;
  }

  function slimVlmMessages(messages) {
    return (messages || []).map((m) => {
      if (typeof m.content === 'string') return { role: m.role, content: m.content };
      if (Array.isArray(m.content)) {
        return {
          role: m.role,
          content: m.content.map((p) => {
            if (p?.type === 'image_url') {
              return { type: 'image_url', image_url: { url: '__from_path__' } };
            }
            return p;
          }),
          ...(m._paths ? { _paths: m._paths } : {}),
        };
      }
      return { role: m.role, content: m.content };
    });
  }

  /**
   * Serialize one VLM thread to jsonl lines:
   *   {"type":"meta","id","sessionId","imagePaths","updatedAt"}
   *   {"type":"message","role","content",...}  × N turns
   */
  function vlmThreadToJsonlRows(thread) {
    const sid = thread.sessionId || ANON_SESSION_ID;
    const rows = [{
      type: 'meta',
      id: thread.id,
      sessionId: sid,
      imagePaths: thread.imagePaths || [],
      updatedAt: thread.updatedAt || Date.now(),
    }];
    for (const m of slimVlmMessages(thread.messages)) {
      rows.push({ type: 'message', ...m });
    }
    return rows;
  }

  function vlmThreadFromJsonlRows(rows, fallbackSessionId, fallbackThreadId) {
    let id = fallbackThreadId;
    let sessionId = fallbackSessionId;
    let imagePaths = [];
    let updatedAt = 0;
    const messages = [];
    for (const row of rows || []) {
      if (!row || typeof row !== 'object') continue;
      if (row.type === 'meta') {
        id = row.id || id;
        sessionId = row.sessionId || sessionId;
        imagePaths = row.imagePaths || imagePaths;
        updatedAt = row.updatedAt || updatedAt;
        continue;
      }
      // full-thread snapshot (legacy single-line objects)
      if (row.type !== 'message' && row.messages && row.id) {
        return {
          id: row.id,
          sessionId: row.sessionId || sessionId,
          imagePaths: row.imagePaths || [],
          messages: row.messages || [],
          updatedAt: row.updatedAt || Date.now(),
        };
      }
      if (row.role) {
        const { type: _t, ...rest } = row;
        messages.push(rest);
      }
    }
    return {
      id,
      sessionId,
      imagePaths,
      messages,
      updatedAt: updatedAt || Date.now(),
    };
  }

  async function rmrf(p) {
    try {
      await fs.rm(p, { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  /**
   * Persist full session on disk:
   *   sessions/{id}/meta.json + messages.jsonl
   */
  async function writeSessionBundle(row) {
    const id = row.id;
    await fs.mkdir(sessionDir(id), { recursive: true });
    const meta = {
      id: row.id,
      title: row.title || '对话',
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      messageCount: Array.isArray(row.messages) ? row.messages.length : (row.messageCount || 0),
      preview: row.preview || previewFromMessages(row.messages) || '',
      model: row.model || null,
      vlmThreadIds: row.vlmThreadIds || [],
    };
    await atomicWriteJson(metaPath(id), meta);
    await writeJsonl(messagesJsonlPath(id), row.messages || []);
    // drop legacy monolith if present
    try { await fs.unlink(legacySessionJsonPath(id)); } catch { /* ignore */ }
    return { ...row, ...meta, messages: row.messages || [] };
  }

  async function readSessionBundle(id) {
    // preferred: meta + messages.jsonl
    try {
      const meta = JSON.parse(await fs.readFile(metaPath(id), 'utf8'));
      const messages = await readJsonl(messagesJsonlPath(id));
      return {
        id: meta.id || id,
        title: meta.title || '对话',
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        model: meta.model || null,
        vlmThreadIds: meta.vlmThreadIds || [],
        preview: meta.preview || '',
        messages,
      };
    } catch { /* fall through */ }

    // legacy: session.json
    try {
      const row = JSON.parse(await fs.readFile(legacySessionJsonPath(id), 'utf8'));
      if (row?.id || row?.messages) {
        const bundle = {
          id: row.id || id,
          title: row.title || '对话',
          messages: row.messages || [],
          createdAt: row.createdAt || row.updatedAt || Date.now(),
          updatedAt: row.updatedAt || Date.now(),
          model: row.model || null,
          vlmThreadIds: row.vlmThreadIds || [],
          preview: row.preview || previewFromMessages(row.messages),
        };
        // upgrade in place to jsonl layout
        await writeSessionBundle(bundle);
        return bundle;
      }
    } catch { /* fall through */ }

    // legacy flat: sessions/{id}.json
    try {
      const flat = path.join(sessionsDir, `${safeId(id)}.json`);
      const row = JSON.parse(await fs.readFile(flat, 'utf8'));
      const bundle = {
        id: row.id || id,
        title: row.title || '对话',
        messages: row.messages || [],
        createdAt: row.createdAt || row.updatedAt || Date.now(),
        updatedAt: row.updatedAt || Date.now(),
        model: row.model || null,
        vlmThreadIds: row.vlmThreadIds || [],
        preview: row.preview || previewFromMessages(row.messages),
      };
      await writeSessionBundle(bundle);
      try { await fs.unlink(flat); } catch { /* ignore */ }
      return bundle;
    } catch {
      return null;
    }
  }

  async function listVlmThreadFiles(sessionId) {
    const sid = sessionId || ANON_SESSION_ID;
    try {
      const files = await fs.readdir(vlmDir(sid));
      return files.filter((f) => f.endsWith('.jsonl') || f.endsWith('.json'));
    } catch {
      return [];
    }
  }

  /** Read one thread from sessions/{sid}/vlm/{threadId}.jsonl (or .json). */
  async function readVlmThreadFile(sessionId, threadId) {
    const sid = sessionId || ANON_SESSION_ID;
    // preferred jsonl
    const jl = vlmThreadJsonlPath(sid, threadId);
    try {
      const rows = await readJsonl(jl);
      if (rows.length) {
        return vlmThreadFromJsonlRows(rows, sid, threadId);
      }
    } catch { /* miss */ }
    // legacy single json object
    try {
      const jp = path.join(vlmDir(sid), `${safeId(threadId)}.json`);
      const t = JSON.parse(await fs.readFile(jp, 'utf8'));
      return {
        id: t.id || threadId,
        sessionId: t.sessionId || sid,
        imagePaths: t.imagePaths || [],
        messages: t.messages || [],
        updatedAt: t.updatedAt || Date.now(),
      };
    } catch {
      return null;
    }
  }

  /** Load all VLM threads under sessions/{sid}/vlm/ */
  async function loadVlmThreadsFromSession(sessionId) {
    const sid = sessionId || ANON_SESSION_ID;
    const byId = new Map();

    // per-thread files: vlm/{threadId}.jsonl | .json
    for (const f of await listVlmThreadFiles(sid)) {
      const tid = f.replace(/\.jsonl?$/, '');
      try {
        const t = await readVlmThreadFile(sid, tid);
        if (t?.id) byId.set(t.id, { ...t, sessionId: t.sessionId || sid });
      } catch { /* skip */ }
    }

    // legacy monolithic sessions/{sid}/vlm.jsonl (one thread object per line)
    try {
      const mono = await readJsonl(legacySessionVlmJsonl(sid));
      for (const row of mono) {
        if (!row) continue;
        if (row.id && (row.messages || row.type === 'meta')) {
          const t = row.messages
            ? {
                id: row.id,
                sessionId: row.sessionId || sid,
                imagePaths: row.imagePaths || [],
                messages: row.messages || [],
                updatedAt: row.updatedAt || Date.now(),
              }
            : null;
          if (t) byId.set(t.id, t);
        }
      }
    } catch { /* ignore */ }

    return [...byId.values()];
  }

  /** Write sessions/{sid}/vlm/{threadId}.jsonl */
  async function writeVlmThreadFile(thread) {
    if (!thread?.id) return;
    const sid = thread.sessionId || ANON_SESSION_ID;
    thread.sessionId = sid;
    await fs.mkdir(vlmDir(sid), { recursive: true });
    await writeJsonl(vlmThreadJsonlPath(sid, thread.id), vlmThreadToJsonlRows(thread));
    // remove legacy single-json for this thread if any
    try {
      await fs.unlink(path.join(vlmDir(sid), `${safeId(thread.id)}.json`));
    } catch { /* ignore */ }
  }

  /** One-time layout migrations → meta + messages.jsonl + vlm/{threadId}.jsonl */
  async function migrateSessionLayout() {
    if (layoutMigrated) return;
    layoutMigrated = true;
    await ensureAiDirs();
    let entries = [];
    try {
      entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    } catch {
      return;
    }

    // flat sessions/{id}.json → folder jsonl
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith('.json') || ent.name === 'index.json') continue;
      const id = ent.name.slice(0, -5);
      try {
        await readSessionBundle(id);
        console.log(`[meta-agent] layout: ${ent.name} → sessions/${id}/messages.jsonl`);
      } catch (e) {
        console.warn('[meta-agent] layout migrate flat', id, e.message);
      }
    }

    // sessions/{id}/session.json + vlm/* + vlm.jsonl → per-thread jsonl
    try {
      entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const id = ent.name;
      try {
        if (fsSync.existsSync(legacySessionJsonPath(id)) && !fsSync.existsSync(messagesJsonlPath(id))) {
          await readSessionBundle(id);
        }
        const threads = await loadVlmThreadsFromSession(id);
        for (const t of threads) {
          t.sessionId = t.sessionId || id;
          await writeVlmThreadFile(t);
          vlmThreads.set(vlmMemKey(id, t.id), t);
        }
        // drop monolithic vlm.jsonl after split
        try { await fs.unlink(legacySessionVlmJsonl(id)); } catch { /* ignore */ }
      } catch (e) {
        console.warn('[meta-agent] layout migrate dir', id, e.message);
      }
    }

    // global .ai/vlm → sessions/{id}/vlm/{threadId}.jsonl
    try {
      const vfiles = await fs.readdir(legacyGlobalVlmDir);
      if (!vfiles.length) return;
      const map = new Map();
      for (const ent of await fs.readdir(sessionsDir, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        try {
          const meta = JSON.parse(await fs.readFile(metaPath(ent.name), 'utf8'));
          for (const tid of meta.vlmThreadIds || []) map.set(tid, meta.id || ent.name);
        } catch {
          try {
            const body = JSON.parse(await fs.readFile(legacySessionJsonPath(ent.name), 'utf8'));
            for (const tid of body.vlmThreadIds || []) map.set(tid, body.id || ent.name);
          } catch { /* skip */ }
        }
      }
      for (const f of vfiles) {
        if (!f.endsWith('.json') && !f.endsWith('.jsonl')) continue;
        const src = path.join(legacyGlobalVlmDir, f);
        try {
          if (f.endsWith('.jsonl')) {
            const rows = await readJsonl(src);
            const tid = f.replace(/\.jsonl$/, '');
            const t = vlmThreadFromJsonlRows(rows, map.get(tid) || '_orphan', tid);
            t.sessionId = t.sessionId || map.get(t.id) || '_orphan';
            await writeVlmThreadFile(t);
          } else {
            const t = JSON.parse(await fs.readFile(src, 'utf8'));
            const tid = t.id || f.slice(0, -5);
            t.id = tid;
            t.sessionId = t.sessionId || map.get(tid) || '_orphan';
            await writeVlmThreadFile(t);
          }
          await fs.unlink(src);
        } catch (e) {
          console.warn('[meta-agent] migrate global vlm', f, e.message);
        }
      }
      try {
        const left = await fs.readdir(legacyGlobalVlmDir);
        if (!left.length) await fs.rmdir(legacyGlobalVlmDir);
      } catch { /* ignore */ }
      console.log('[meta-agent] layout: global vlm → sessions/{id}/vlm/{threadId}.jsonl');
    } catch { /* no global vlm */ }
  }

  function previewFromMessages(messages) {
    if (!Array.isArray(messages)) return '';
    for (const m of messages) {
      if (m.role !== 'user') continue;
      let t = '';
      if (typeof m.content === 'string') t = m.content;
      else if (Array.isArray(m.content)) {
        t = m.content.filter((p) => p?.type === 'text').map((p) => p.text).join(' ');
      }
      t = String(t || '').replace(/\s+/g, ' ').trim();
      if (t) return shortTitle(t, 80);
    }
    return '';
  }

  function extractRoleText(message) {
    if (!message) return '';
    const text = extractTextParts(message.content ?? message.message?.content ?? message.text);
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function pickSample(items, count) {
    if (!Array.isArray(items) || !items.length) return [];
    if (items.length <= count) return items.slice();
    const out = [];
    const last = items.length - 1;
    for (let i = 0; i < count; i += 1) {
      const idx = Math.round((i * last) / Math.max(1, count - 1));
      out.push(items[idx]);
    }
    return out.filter((item, i, arr) => i === arr.findIndex((x) => x === item));
  }

  async function listMetaNotes(query = {}) {
    const store = await loadNotesStore();
    const scope = query.scope || 'all';
    const q = String(query.q || '').trim().toLowerCase();
    const cwd = query.cwd ? expandPath(query.cwd) : '';
    const sessionId = String(query.sessionId || '').trim();
    const agent = String(query.agent || '').trim();
    const limit = Math.min(query.limit || 30, 200);
    let rows = [...store.notes];
    if (scope !== 'all') rows = rows.filter((n) => n.scope === scope);
    if (cwd) rows = rows.filter((n) => n.cwd === cwd);
    if (sessionId) rows = rows.filter((n) => n.sessionId === sessionId);
    if (agent) rows = rows.filter((n) => n.agent === agent);
    if (q) {
      rows = rows.filter((n) => `${n.title || ''}\n${n.content || ''}\n${(n.tags || []).join(' ')}`.toLowerCase().includes(q));
    }
    rows.sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return Number(b.pinned) - Number(a.pinned);
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    return rows.slice(0, limit);
  }

  async function getMetaNote(id) {
    if (!id) return null;
    const store = await loadNotesStore();
    return store.notes.find((n) => n.id === id) || null;
  }

  async function saveMetaNote(input = {}) {
    const store = await loadNotesStore();
    const now = Date.now();
    const id = input.id ? String(input.id) : crypto.randomUUID();
    const cwd = input.cwd ? expandPath(input.cwd) : '';
    const sessionId = String(input.sessionId || '').trim();
    const agent = String(input.agent || '').trim() || (sessionId ? 'claude' : '');
    const scope = sessionId ? 'session' : cwd ? 'project' : 'general';
    const tags = Array.isArray(input.tags)
      ? [...new Set(input.tags.map((x) => String(x || '').trim()).filter(Boolean))].slice(0, 12)
      : [];
    const prev = store.notes.find((n) => n.id === id);
    const note = {
      id,
      scope,
      title: String(input.title || '').trim().slice(0, 200),
      content: String(input.content || '').trim(),
      cwd,
      sessionId,
      agent,
      pinned: Boolean(input.pinned),
      tags,
      createdAt: prev?.createdAt || now,
      updatedAt: now,
    };
    if (!note.title) throw new Error('title required');
    if (!note.content) throw new Error('content required');
    if (prev) {
      const idx = store.notes.findIndex((n) => n.id === id);
      store.notes[idx] = note;
    } else {
      store.notes.unshift(note);
    }
    await saveNotesStore();
    return note;
  }

  async function deleteMetaNote(id) {
    if (!id) return { ok: false };
    const store = await loadNotesStore();
    const next = store.notes.filter((n) => n.id !== id);
    const changed = next.length !== store.notes.length;
    store.notes = next;
    if (changed) await saveNotesStore();
    return { ok: changed };
  }

  async function getSessionMetaNote(sessionId, agent) {
    if (!sessionId || !getSessionMetaStore) return null;
    const db = await getSessionMetaStore();
    const key = `${agent || 'claude'}:${sessionId}`;
    return db?.[key] || null;
  }

  async function findSessionRecord(sessionId, preferredAgent = null) {
    const sessions = await listSessions(null, preferredAgent || null);
    let hit = sessions.find((s) => s.sessionId === sessionId && (!preferredAgent || s.agent === preferredAgent));
    if (!hit && !preferredAgent) hit = sessions.find((s) => s.sessionId === sessionId);
    return hit || null;
  }

  async function buildSessionBrief(args = {}) {
    const sessionId = args.sessionId || args.id;
    if (!sessionId) return { error: 'sessionId required' };
    const maxTurns = Math.min(args.maxTurns || 6, 12);
    const record = await findSessionRecord(sessionId, args.agent || null);
    const resolvedAgent = record?.agent || args.agent || null;
    const updatedAt = record?.updatedAt || 0;
    const cacheKey = `${resolvedAgent || '*'}:${sessionId}`;
    const cache = await loadSessionBriefsStore();
    const cached = cache[cacheKey];
    if (cached && cached.updatedAt === updatedAt && cached.maxTurns === maxTurns) return cached.brief;

    const bundle = await loadSessionMessages(sessionId, resolvedAgent, sessionOpts());
    if (!bundle) return { error: 'session not found' };
    const msgs = Array.isArray(bundle) ? bundle : (bundle.messages || []);
    const userTurns = [];
    const assistantTurns = [];
    for (const m of msgs) {
      const role = m.role || m.type;
      if (role !== 'user' && role !== 'assistant') continue;
      const text = extractRoleText(m);
      if (!text || text.startsWith('Caveat:') || text.startsWith('<command-')) continue;
      const row = { role, text: shortTitle(text, role === 'user' ? 260 : 220) };
      if (role === 'user') userTurns.push(row);
      else assistantTurns.push(row);
    }
    const checkpoints = pickSample(userTurns, maxTurns).map((turn, idx) => ({
      index: idx + 1,
      prompt: turn.text,
    }));
    const cwd = record?.cwd || null;
    const projectNotesStore = cwd ? await getProjectNotesStore() : null;
    const projectNotes = cwd ? normalizeProjectEntry(projectNotesStore?.[cwd] || {}) : { goal: '', notes: '' };
    const sessionMeta = await getSessionMetaNote(sessionId, resolvedAgent || 'claude');
    const linkedNotes = await listMetaNotes({ scope: 'session', sessionId, agent: resolvedAgent || undefined, limit: 8 });
    const brief = {
      sessionId,
      agent: Array.isArray(bundle) ? resolvedAgent : (bundle.agent || resolvedAgent),
      cwd,
      projectName: record?.projectName || (cwd ? path.basename(cwd) : ''),
      title: shortTitle(record?.display || record?.title || sessionId, 120),
      updatedAt,
      totalMessages: msgs.length,
      userTurnCount: userTurns.length,
      assistantTurnCount: assistantTurns.length,
      firstUserPrompt: userTurns[0]?.text || '',
      latestUserPrompt: userTurns[userTurns.length - 1]?.text || '',
      latestAssistantReply: assistantTurns[assistantTurns.length - 1]?.text || '',
      checkpoints,
      projectGoal: projectNotes.goal || '',
      projectNotes: projectNotes.notes ? shortTitle(projectNotes.notes, 300) : '',
      sessionNote: (sessionMeta?.notes || '').trim(),
      linkedNotes: linkedNotes.map((n) => ({
        id: n.id,
        title: n.title,
        content: shortTitle(n.content, 240),
        updatedAt: n.updatedAt,
      })),
    };
    cache[cacheKey] = { updatedAt, maxTurns, brief, cachedAt: Date.now() };
    await saveSessionBriefsStore();
    return brief;
  }

  function indexEntryFromSession(s) {
    return {
      id: s.id,
      title: s.title || '对话',
      createdAt: s.createdAt || s.updatedAt || Date.now(),
      updatedAt: s.updatedAt || Date.now(),
      messageCount: Array.isArray(s.messages) ? s.messages.length : (s.messageCount || 0),
      preview: s.preview || previewFromMessages(s.messages) || '',
    };
  }

  async function loadSessionsIndex() {
    if (sessionsIndexCache) return sessionsIndexCache;
    await ensureAiDirs();
    await migrateSessionLayout();
    try {
      const raw = JSON.parse(await fs.readFile(sessionsIndexFile, 'utf8'));
      sessionsIndexCache = {
        version: raw.version || 3,
        sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
      };
    } catch {
      sessionsIndexCache = { version: 3, sessions: [] };
    }
    // one-time migrate from legacy .ai_sessions.json
    if (!sessionsIndexCache.sessions.length) {
      await migrateLegacySessions();
    }
    return sessionsIndexCache;
  }

  async function saveSessionsIndex() {
    if (!sessionsIndexCache) return;
    await atomicWriteJson(sessionsIndexFile, sessionsIndexCache);
  }

  async function migrateLegacySessions() {
    try {
      const raw = JSON.parse(await fs.readFile(legacySessionsFile, 'utf8'));
      const list = Array.isArray(raw.sessions) ? raw.sessions : [];
      if (!list.length) return;
      await ensureAiDirs();
      const index = { version: 3, sessions: [] };
      for (const s of list) {
        if (!s?.id) continue;
        const row = {
          id: s.id,
          title: s.title || '对话',
          messages: s.messages || [],
          createdAt: s.createdAt || s.updatedAt || Date.now(),
          updatedAt: s.updatedAt || Date.now(),
        };
        await writeSessionBundle(row);
        sessionBodyCache.set(row.id, row);
        index.sessions.push(indexEntryFromSession(row));
      }
      index.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      sessionsIndexCache = index;
      await saveSessionsIndex();
      try {
        await fs.rename(legacySessionsFile, `${legacySessionsFile}.migrated`);
      } catch { /* ignore */ }
      console.log(`[meta-agent] migrated ${index.sessions.length} sessions → ${sessionsDir} (jsonl)`);
    } catch {
      /* no legacy file */
    }
  }

  async function pruneSessionFiles() {
    const index = await loadSessionsIndex();
    if (index.sessions.length <= MAX_SESSIONS) return;
    index.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const drop = index.sessions.slice(MAX_SESSIONS);
    index.sessions = index.sessions.slice(0, MAX_SESSIONS);
    for (const s of drop) {
      sessionBodyCache.delete(s.id);
      await rmrf(sessionDir(s.id));
      for (const key of [...vlmThreads.keys()]) {
        if (key.startsWith(`${s.id}::`)) vlmThreads.delete(key);
      }
    }
    await saveSessionsIndex();
  }

  async function persistVlmThread(thread) {
    if (!thread?.id) return;
    const sid = thread.sessionId || ANON_SESSION_ID;
    thread.sessionId = sid;
    thread.updatedAt = thread.updatedAt || Date.now();
    vlmThreads.set(vlmMemKey(sid, thread.id), thread);
    // one file per thread — multi-image / multi-thread don't clobber each other
    await writeVlmThreadFile(thread);
  }

  async function loadVlmThread(sessionId, threadId) {
    if (!threadId) return null;
    const sid = sessionId || ANON_SESSION_ID;
    const key = vlmMemKey(sid, threadId);
    if (vlmThreads.has(key)) {
      return hydrateVlmThreadMessages(vlmThreads.get(key));
    }

    let raw = await readVlmThreadFile(sid, threadId);
    if (!raw) {
      // legacy global
      try {
        raw = JSON.parse(
          await fs.readFile(path.join(legacyGlobalVlmDir, `${safeId(threadId)}.json`), 'utf8'),
        );
        raw.sessionId = raw.sessionId || sid;
        raw = await hydrateVlmThreadMessages(raw);
        await persistVlmThread(raw);
        try {
          await fs.unlink(path.join(legacyGlobalVlmDir, `${safeId(threadId)}.json`));
        } catch { /* ignore */ }
        return raw;
      } catch { /* miss */ }

      // scan other sessions' vlm/
      try {
        const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
        for (const ent of entries) {
          if (!ent.isDirectory() || ent.name === safeId(sid)) continue;
          const hit = await readVlmThreadFile(ent.name, threadId);
          if (hit) {
            const ownSid = hit.sessionId || ent.name;
            const hydrated = await hydrateVlmThreadMessages(hit);
            vlmThreads.set(vlmMemKey(ownSid, threadId), hydrated);
            return hydrated;
          }
        }
      } catch { /* ignore */ }
      return null;
    }

    const hydrated = await hydrateVlmThreadMessages(raw);
    vlmThreads.set(key, hydrated);
    return hydrated;
  }

  async function pruneVlmThreadsForSession(sessionId) {
    const sid = sessionId || ANON_SESSION_ID;
    let threads = await loadVlmThreadsFromSession(sid);
    const now = Date.now();
    const keep = [];
    for (const t of threads) {
      if (now - (t.updatedAt || 0) > VLM_THREAD_TTL_MS) {
        if (t.id) {
          vlmThreads.delete(vlmMemKey(sid, t.id));
          try {
            await fs.unlink(vlmThreadJsonlPath(sid, t.id));
          } catch { /* ignore */ }
          try {
            await fs.unlink(path.join(vlmDir(sid), `${safeId(t.id)}.json`));
          } catch { /* ignore */ }
        }
        continue;
      }
      keep.push(t);
    }
    if (keep.length > MAX_VLM_THREADS_PER_SESSION) {
      keep.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      const drop = keep.splice(MAX_VLM_THREADS_PER_SESSION);
      for (const t of drop) {
        if (!t.id) continue;
        vlmThreads.delete(vlmMemKey(sid, t.id));
        try {
          await fs.unlink(vlmThreadJsonlPath(sid, t.id));
        } catch { /* ignore */ }
      }
    }
  }

  /** Rebuild multimodal content from paths after loading slim VLM thread from disk */
  async function hydrateVlmThreadMessages(thread) {
    if (!thread?.messages?.length) return thread;
    const paths = thread.imagePaths || [];
    const first = thread.messages[0];
    if (!first || typeof first.content === 'string') return thread;
    if (!Array.isArray(first.content)) return thread;
    const needsHydrate = first.content.some(
      (p) => p?.type === 'image_url' && p?.image_url?.url === '__from_path__',
    );
    if (!needsHydrate) return thread;
    const dataUrls = [];
    for (const p of paths) {
      try { dataUrls.push(await imageToDataUrl(p)); }
      catch { /* missing file */ }
    }
    let urlIdx = 0;
    thread.messages = thread.messages.map((m, mi) => {
      if (!Array.isArray(m.content)) return m;
      const content = m.content.map((p) => {
        if (p?.type === 'image_url' && p?.image_url?.url === '__from_path__') {
          const url = dataUrls[urlIdx] || dataUrls[0];
          urlIdx += 1;
          return { type: 'image_url', image_url: { url: url || '' } };
        }
        return p;
      });
      // first message: if we have paths but no image parts left, rebuild
      if (mi === 0 && dataUrls.length && !content.some((p) => p?.type === 'image_url')) {
        const textPart = content.find((p) => p?.type === 'text') || { type: 'text', text: '' };
        return {
          ...m,
          content: [
            textPart,
            ...dataUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
          ],
          _paths: paths,
        };
      }
      return { ...m, content };
    });
    return thread;
  }

  /** Extract absolute paths from [imgN](path) / ![alt](path) / bare paths in text */
  function extractImagePathsFromText(text) {
    const s = String(text || '');
    const found = [];
    const re = /!\[[^\]]*\]\(([^)]+)\)|\[img\d*\]\(([^)]+)\)/gi;
    let m;
    while ((m = re.exec(s))) {
      const p = (m[1] || m[2] || '').trim().replace(/^<|>$/g, '');
      if (p && !p.startsWith('http') && !found.includes(p)) found.push(expandPath(p));
    }
    return found;
  }

  async function loadConfig() {
    if (configCache) return configCache;
    try {
      configCache = { ...AI_DEFAULTS, ...JSON.parse(await fs.readFile(configFile, 'utf8')) };
    } catch {
      configCache = { ...AI_DEFAULTS, key: '', vlm_key: '', system: DEFAULT_SYSTEM };
    }
    if (!configCache.system) configCache.system = DEFAULT_SYSTEM;
    return configCache;
  }

  async function saveConfig(patch) {
    const cur = await loadConfig();
    const next = { ...cur, ...patch };
    // never persist empty key over existing unless explicitly set
    configCache = next;
    const toWrite = { ...next };
    await fs.writeFile(configFile, JSON.stringify(toWrite, null, 2), 'utf8');
    return publicConfig(toWrite);
  }

  function publicConfig(c) {
    return {
      url: c.url || AI_DEFAULTS.url,
      model: c.model || AI_DEFAULTS.model,
      hasKey: !!(c.key && String(c.key).trim()),
      vlm_url: c.vlm_url || '',
      vlm_model: c.vlm_model || '',
      hasVlmKey: !!(c.vlm_key && String(c.vlm_key).trim()) || !!(c.key && String(c.key).trim()),
      temperature: c.temperature ?? AI_DEFAULTS.temperature,
      auto_report: !!c.auto_report,
      auto_report_hour: c.auto_report_hour ?? 18,
      auto_report_days: c.auto_report_days ?? 1,
      system: c.system || DEFAULT_SYSTEM,
    };
  }

  async function loadReports() {
    if (reportsCache) return reportsCache;
    try {
      reportsCache = JSON.parse(await fs.readFile(reportsFile, 'utf8'));
    } catch {
      reportsCache = {};
    }
    return reportsCache;
  }

  async function saveReports() {
    if (!reportsCache) return;
    await fs.writeFile(reportsFile, JSON.stringify(reportsCache, null, 2), 'utf8');
  }

  function sessionOpts() {
    return {
      claudeConfigDirs: claudeConfigDirs(),
      codexHome: codexHome(),
      grokHome: grokHome(),
    };
  }

  async function buildDigest({ days = 1, agent = null, includeMessages = true } = {}) {
    const since = dayStartMs(Math.max(0, (days || 1) - 1));
    let sessions = await listSessions(null, agent || null);
    sessions = sessions
      .filter((s) => (s.updatedAt || 0) >= since)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    const client = sessions.map(toClientSession);
    const projects = groupByProject(client).slice(0, 40);
    const notesStore = await getProjectNotesStore();

    const byProject = [];
    for (const p of projects.slice(0, 25)) {
      const pe = normalizeProjectEntry(notesStore[p.cwd] || {});
      const sessBrief = (p.sessions || []).slice(0, 8).map((s) => ({
        sessionId: s.sessionId,
        agent: s.agent,
        title: shortTitle(s.display || s.sessionId),
        updatedAt: s.updatedAt,
        turnCount: s.turnCount,
        totalTokens: s.totalTokens,
      }));

      let messageSnippets = [];
      if (includeMessages) {
        for (const s of sessBrief.slice(0, 4)) {
          if (!s.sessionId) continue;
          try {
            const bundle = await loadSessionMessages(s.sessionId, s.agent, sessionOpts());
            if (!bundle) continue;
            const msgs = Array.isArray(bundle) ? bundle : (bundle.messages || []);
            const userBits = [];
            for (const m of msgs.slice(-40)) {
              const role = m.role || m.type;
              if (role !== 'user' && m.type !== 'user') continue;
              const text = extractTextParts(m.content ?? m.message?.content ?? m.text);
              if (!text || text.startsWith('<') || text.startsWith('Caveat:')) continue;
              userBits.push(shortTitle(text, 160));
              if (userBits.length >= 3) break;
            }
            if (userBits.length) {
              messageSnippets.push({ sessionId: s.sessionId, agent: s.agent, prompts: userBits });
            }
          } catch { /* skip */ }
        }
      }

      byProject.push({
        cwd: p.cwd,
        name: p.projectName || path.basename(p.cwd || '') || '(no path)',
        sessionCount: p.sessionCount || (p.sessions || []).length,
        agents: p.agents || {},
        goal: pe.goal || '',
        notes: pe.notes ? shortTitle(pe.notes, 200) : '',
        sessions: sessBrief,
        prompts: messageSnippets,
      });
    }

    const totalTokens = client.reduce((a, s) => a + (s.totalTokens || 0), 0);
    return {
      generatedAt: new Date().toISOString(),
      range: {
        days,
        since: new Date(since).toISOString(),
        until: new Date().toISOString(),
      },
      totals: {
        sessions: client.length,
        projects: byProject.length,
        tokensApprox: totalTokens,
      },
      projects: byProject,
    };
  }

  async function imageToDataUrl(src) {
    if (!src) throw new Error('empty image');
    if (String(src).startsWith('data:')) return src;
    const p = expandPath(src);
    const buf = await fs.readFile(p);
    const ext = path.extname(p).toLowerCase().replace('.', '') || 'png';
    const mime =
      ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
        : ext === 'gif' ? 'image/gif'
          : ext === 'webp' ? 'image/webp'
            : 'image/png';
    return `data:${mime};base64,${buf.toString('base64')}`;
  }

  async function chatCompletions({ url, apiKey, body, signal }) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`LLM HTTP ${res.status}: ${t.slice(0, 400)}`);
    }
    return res;
  }

  async function chatSync(cfg, body) {
    const res = await chatCompletions({
      url: cfg.url || AI_DEFAULTS.url,
      apiKey: cfg.key || '',
      body: { ...body, stream: false },
    });
    return res.json();
  }

  async function streamChat(cfg, body, onEvent) {
    const res = await chatCompletions({
      url: cfg.url || AI_DEFAULTS.url,
      apiKey: cfg.key || '',
      body: { ...body, stream: true },
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const raw = s.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          onEvent(JSON.parse(raw));
        } catch { /* ignore partial */ }
      }
    }
  }

  async function executeTool(name, args, toolCtx = {}) {
    const chatSessionId = toolCtx.chatSessionId || ANON_SESSION_ID;
    switch (name) {
      case 'list_sessions': {
        const days = args.days ?? 14;
        const limit = Math.min(args.limit || 40, 100);
        let sessions = await listSessions(args.cwd || null, args.agent || null);
        if (days > 0) {
          const since = Date.now() - days * 86400000;
          sessions = sessions.filter((s) => (s.updatedAt || 0) >= since);
        }
        sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        return sessions.slice(0, limit).map(toClientSession).map((s) => ({
          sessionId: s.sessionId,
          agent: s.agent,
          title: shortTitle(s.display || s.title || '', 100),
          cwd: s.cwd,
          projectName: s.projectName,
          updatedAt: s.updatedAt,
          turnCount: s.turnCount,
          totalTokens: s.totalTokens,
        }));
      }
      case 'list_projects': {
        const days = args.days ?? 14;
        const limit = Math.min(args.limit || 30, 80);
        let sessions = await listSessions(null, args.agent || null);
        if (days > 0) {
          const since = Date.now() - days * 86400000;
          sessions = sessions.filter((s) => (s.updatedAt || 0) >= since);
        }
        const groups = groupByProject(sessions.map(toClientSession)).slice(0, limit);
        return groups.map((g) => ({
          cwd: g.cwd,
          name: g.projectName || path.basename(g.cwd || '') || '(no path)',
          sessionCount: g.sessionCount || (g.sessions || []).length,
          agents: g.agents || {},
          lastTitle: shortTitle(g.latest?.display || '', 80),
          updatedAt: g.updatedAt,
        }));
      }
      case 'search_activity': {
        const sessions = await listSessions(null, args.agent || null);
        const results = await searchActivity(sessions, {
          q: args.q || '',
          days: args.days ?? 14,
          agent: args.agent || null,
          limit: Math.min(args.limit || 40, 100),
          deep: args.deep !== false,
        });
        return results.map((r) => ({
          sessionId: r.sessionId,
          agent: r.agent,
          title: shortTitle(r.display || r.snippet || '', 100),
          cwd: r.cwd,
          updatedAt: r.updatedAt,
          snippet: r.snippet ? shortTitle(r.snippet, 200) : undefined,
          match: r.match,
        }));
      }
      case 'get_session_summary': {
        const sid = args.sessionId || args.id;
        if (!sid) return { error: 'sessionId required' };
        const bundle = await loadSessionMessages(
          sid,
          args.agent || null,
          sessionOpts(),
        );
        if (!bundle) return { error: 'session not found' };
        const msgs = Array.isArray(bundle) ? bundle : (bundle.messages || []);
        const max = Math.min(args.maxMessages || 30, 80);
        const slice = msgs.slice(-max);
        const summary = [];
        for (const m of slice) {
          const role = m.role || (m.type === 'user' ? 'user' : m.type === 'assistant' ? 'assistant' : m.type);
          if (role !== 'user' && role !== 'assistant') continue;
          const text = extractTextParts(m.content ?? m.message?.content ?? m.text);
          if (!text) continue;
          if (text.startsWith('Caveat:') || text.startsWith('<command-')) continue;
          summary.push({
            role,
            text: shortTitle(text, role === 'user' ? 400 : 300),
          });
        }
        return {
          agent: Array.isArray(bundle) ? args.agent : (bundle.agent || args.agent),
          total: msgs.length,
          messages: summary,
        };
      }
      case 'get_session_brief': {
        return buildSessionBrief(args);
      }
      case 'get_session_jsonl': {
        const sid = args.sessionId || args.id;
        if (!sid) return { error: 'sessionId required' };
        if (!loadSessionJsonl) return { error: 'raw session reader unavailable' };
        const result = await loadSessionJsonl(sid, args.agent || null, sessionOpts(), {
          offset: args.offset,
          maxLines: args.maxLines,
        });
        if (!result) return { error: 'session JSONL not found' };
        return result;
      }
      case 'get_project_notes': {
        const store = await getProjectNotesStore();
        const cwd = expandPath(args.cwd);
        return { cwd, ...normalizeProjectEntry(store[cwd] || {}) };
      }
      case 'set_project_notes': {
        const store = await getProjectNotesStore();
        const cwd = expandPath(args.cwd);
        const cur = normalizeProjectEntry(store[cwd] || {});
        if (args.goal != null) cur.goal = String(args.goal);
        if (args.notes != null) cur.notes = String(args.notes);
        cur.updatedAt = Date.now();
        store[cwd] = cur;
        await saveProjectNotesStore();
        return { ok: true, cwd, ...cur };
      }
      case 'list_meta_notes': {
        return listMetaNotes(args);
      }
      case 'save_meta_note': {
        return saveMetaNote(args);
      }
      case 'delete_meta_note': {
        return deleteMetaNote(args.id);
      }
      case 'git_status': {
        const cwd = expandPath(args.cwd);
        if (!(await isGitRepo(cwd))) return { isGit: false };
        const out = await git(['status', '--porcelain'], cwd);
        const branch = await git(['branch', '--show-current'], cwd).catch(() => '');
        const files = out.trim().split('\n').filter(Boolean).slice(0, 80).map((line) => ({
          status: line.slice(0, 2).trim(),
          file: line.slice(3),
        }));
        return { isGit: true, branch: branch.trim(), files };
      }
      case 'git_log': {
        const cwd = expandPath(args.cwd);
        if (!(await isGitRepo(cwd))) return { isGit: false, commits: [] };
        const n = Math.min(args.limit || 15, 40);
        const out = await git(['log', `--oneline`, `-${n}`], cwd).catch(() => '');
        return {
          isGit: true,
          commits: out.trim().split('\n').filter(Boolean).map((line) => ({
            hash: line.slice(0, 7),
            message: line.slice(8),
          })),
        };
      }
      case 'list_files': {
        const dir = expandPath(args.path);
        const max = Math.min(args.max || 80, 200);
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return entries.slice(0, max).map((e) => ({
          name: e.name,
          isDir: e.isDirectory(),
          path: path.join(dir, e.name),
        }));
      }
      case 'read_file': {
        const p = expandPath(args.path);
        const maxBytes = Math.min(args.maxBytes || 120000, 500000);
        const st = await fs.stat(p);
        if (st.size > maxBytes) {
          const buf = await fs.readFile(p, { encoding: null });
          return {
            path: p,
            truncated: true,
            size: st.size,
            content: buf.subarray(0, maxBytes).toString('utf8'),
          };
        }
        const content = await fs.readFile(p, 'utf8');
        return { path: p, size: st.size, content };
      }
      case 'write_file': {
        const p = expandPath(args.path);
        if (!path.isAbsolute(p)) return { error: 'path must be absolute' };
        // block writing into sensitive system dirs
        if (p === '/' || p.startsWith('/etc') || p.startsWith('/usr') || p.startsWith('/bin')) {
          return { error: 'refusing to write to system path' };
        }
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, String(args.content ?? ''), 'utf8');
        return { ok: true, path: p, bytes: Buffer.byteLength(String(args.content ?? '')) };
      }
      case 'run_command': {
        if (dangerousCommand(args.command)) {
          return { error: 'command blocked as dangerous' };
        }
        const cwd = expandPath(args.cwd || os.homedir());
        const timeoutMs = Math.min(Math.max(args.timeoutMs || 60000, 1000), 180000);
        return await new Promise((resolve) => {
          const child = spawn(process.env.SHELL || 'bash', ['-c', args.command], {
            cwd: fsSync.existsSync(cwd) ? cwd : os.homedir(),
            env: { ...process.env },
            shell: false,
          });
          let stdout = '';
          let stderr = '';
          const timer = setTimeout(() => {
            try { child.kill('SIGTERM'); } catch {}
            resolve({
              error: 'timeout',
              code: null,
              stdout: stdout.slice(-8000),
              stderr: stderr.slice(-4000),
            });
          }, timeoutMs);
          child.stdout.on('data', (d) => {
            stdout += d;
            if (stdout.length > 200000) stdout = stdout.slice(-100000);
          });
          child.stderr.on('data', (d) => {
            stderr += d;
            if (stderr.length > 100000) stderr = stderr.slice(-50000);
          });
          child.on('close', (code) => {
            clearTimeout(timer);
            resolve({
              code,
              stdout: stdout.slice(-12000),
              stderr: stderr.slice(-6000),
            });
          });
          child.on('error', (e) => {
            clearTimeout(timer);
            resolve({ error: e.message });
          });
        });
      }
      case 'analyze_images': {
        const cfg = await loadConfig();
        const prompt = String(args.prompt || '请分析这些图片。').trim();
        const sid = chatSessionId || ANON_SESSION_ID;
        await pruneVlmThreadsForSession(sid);

        let thread = null;
        if (args.thread_id) {
          thread = await loadVlmThread(sid, args.thread_id);
        }

        let paths = [...(args.image_paths || args.images || [])]
          .map((p) => expandPath(String(p).trim()))
          .filter(Boolean);
        // allow prompt to carry [imgN](path) refs
        for (const p of extractImagePathsFromText(prompt)) {
          if (!paths.includes(p)) paths.push(p);
        }
        if (thread && !paths.length) {
          paths = [...(thread.imagePaths || [])];
        }
        if (!paths.length && !thread) {
          return {
            error: 'image_paths required (or pass thread_id from a prior analyze_images call)',
          };
        }

        // Merge new paths into thread
        if (thread) {
          for (const p of paths) {
            if (!thread.imagePaths.includes(p)) thread.imagePaths.push(p);
          }
          paths = [...thread.imagePaths];
        }

        const dataUrls = [];
        for (const img of paths) {
          try {
            dataUrls.push(await imageToDataUrl(img));
          } catch (e) {
            return { error: `read image failed: ${img}: ${e.message}` };
          }
        }

        const vlmUrl = (cfg.vlm_url || cfg.url || AI_DEFAULTS.url).trim();
        const vlmKey = (cfg.vlm_key || cfg.key || '').trim();
        const vlmModel = (cfg.vlm_model || cfg.model || AI_DEFAULTS.model).trim();
        if (!vlmKey) return { error: 'VLM API key not configured' };

        // Build multi-turn messages: first user turn carries images; later turns text-only
        let messages;
        if (thread && thread.messages?.length) {
          messages = [...thread.messages];
          const firstPaths = thread.messages[0]?._paths || [];
          const added = paths.filter((p) => !firstPaths.includes(p));
          if (added.length) {
            const addedUrls = [];
            for (const p of added) {
              try { addedUrls.push(await imageToDataUrl(p)); }
              catch (e) { return { error: `read image failed: ${p}: ${e.message}` }; }
            }
            messages.push({
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                ...addedUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
              ],
            });
          } else {
            messages.push({ role: 'user', content: prompt });
          }
        } else {
          messages = [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              ...dataUrls.map((url) => ({
                type: 'image_url',
                image_url: { url },
              })),
            ],
            _paths: paths,
          }];
        }

        const apiMessages = messages.map(({ role, content }) => ({ role, content }));

        const body = {
          model: vlmModel,
          messages: apiMessages,
          temperature: 0.2,
        };
        try {
          const res = await chatCompletions({
            url: vlmUrl,
            apiKey: vlmKey,
            body: { ...body, stream: false },
          });
          const json = await res.json();
          const text = json.choices?.[0]?.message?.content || '';
          if (!text) return { error: 'VLM returned empty content', raw: json?.error || null };

          // Persist under this AI session: sessions/{sessionId}/vlm/{threadId}.json
          if (!thread) {
            const id = crypto.randomUUID();
            thread = {
              id,
              sessionId: sid,
              imagePaths: paths,
              messages: [
                { role: 'user', content: messages[0].content, _paths: paths },
                { role: 'assistant', content: text },
              ],
              updatedAt: Date.now(),
            };
          } else {
            thread.messages = [
              ...messages.map(({ role, content, _paths }) => ({ role, content, ...(_paths ? { _paths } : {}) })),
              { role: 'assistant', content: text },
            ];
            thread.imagePaths = paths;
            thread.sessionId = sid;
            thread.updatedAt = Date.now();
          }
          await persistVlmThread(thread);
          await pruneVlmThreadsForSession(sid);

          return {
            ok: true,
            analysis: text,
            thread_id: thread.id,
            session_id: sid,
            image_paths: thread.imagePaths,
            turns: Math.ceil(thread.messages.length / 2),
            hint: '追问同一批图时调用 analyze_images({ thread_id, prompt })，无需重复传路径。线程保存在本 AI session 目录下。',
          };
        } catch (e) {
          return { error: String(e.message || e) };
        }
      }
      case 'generate_activity_digest': {
        return buildDigest({
          days: args.days ?? 1,
          agent: args.agent || null,
          includeMessages: args.includeMessages !== false,
        });
      }
      case 'save_report': {
        const day = args.day || todayKey();
        const store = await loadReports();
        store[day] = {
          day,
          title: args.title || `${day} 工作报告`,
          markdown: args.markdown || '',
          generatedAt: new Date().toISOString(),
        };
        await saveReports();
        return { ok: true, day };
      }
      case 'list_reports': {
        const store = await loadReports();
        const limit = Math.min(args.limit || 30, 100);
        return Object.values(store)
          .sort((a, b) => String(b.day).localeCompare(String(a.day)))
          .slice(0, limit)
          .map((r) => ({
            day: r.day,
            title: r.title,
            generatedAt: r.generatedAt,
            preview: shortTitle(r.markdown, 120),
          }));
      }
      case 'get_report': {
        const store = await loadReports();
        const day = args.day || todayKey();
        return store[day] || { error: 'not found', day };
      }
      default:
        return { error: `unknown tool ${name}` };
    }
  }

  /**
   * Tool-enabled agent loop with streaming content callbacks.
   */
  async function runLoop(messages, { onContent, onTool, onApproval, cfg, chatSessionId } = {}) {
    const config = cfg || await loadConfig();
    if (!config.key) throw new Error('AI API Key 未配置，请在 ⚙️ → Meta Agent 中填写');

    let needsMutate = false;
    const maxRounds = 12;
    let content = '';
    const toolCtx = { chatSessionId: chatSessionId || ANON_SESSION_ID };

    for (let round = 0; round < maxRounds; round++) {
      content = '';
      const toolMap = {};
      const body = {
        model: config.model || AI_DEFAULTS.model,
        messages,
        tools: TOOLS,
        stream: true,
        temperature: config.temperature ?? 0.3,
      };
      // some providers
      if (body.model && String(body.model).includes('mimo')) {
        body.max_completion_tokens = 2048;
        body.extra_body = { thinking: { type: 'disabled' } };
      }

      await streamChat(config, body, (chunk) => {
        const d = chunk.choices?.[0]?.delta;
        if (d?.content) {
          content += d.content;
          onContent?.(content);
        }
        if (d?.tool_calls) {
          for (const tc of d.tool_calls) {
            const i = tc.index ?? 0;
            if (!toolMap[i]) toolMap[i] = { id: '', function: { name: '', arguments: '' } };
            const t = toolMap[i];
            if (tc.id) t.id += tc.id;
            if (tc.function?.name) t.function.name += tc.function.name;
            if (tc.function?.arguments) t.function.arguments += tc.function.arguments;
          }
        }
      });

      const calls = Object.values(toolMap);
      if (!calls.length) {
        if (content) messages.push({ role: 'assistant', content });
        return { content, messages, needsMutate };
      }

      messages.push({
        role: 'assistant',
        content: content || null,
        tool_calls: calls.map((t, i) => ({
          id: t.id || `call_${i}`,
          type: 'function',
          function: t.function,
        })),
      });

      for (let i = 0; i < calls.length; i++) {
        const call = calls[i];
        let a = {};
        try {
          a = JSON.parse(call.function.arguments || '{}');
        } catch { /* empty */ }
        const callId = call.id || `call_${i}`;
        onTool?.(call.function.name, a, 'start', null, callId);
        let result;
        try {
          if (call.function.name === 'run_command') {
            const approved = await requestApproval(onApproval, call.function.name, a);
            if (!approved) {
              throw new Error('command rejected: user did not approve execution');
            }
          }
          result = await executeTool(call.function.name, a, toolCtx);
          if (MUTATING.has(call.function.name)) needsMutate = true;
          onTool?.(call.function.name, a, 'done', result, callId);
        } catch (e) {
          result = { error: String(e.message || e) };
          onTool?.(call.function.name, a, 'error', result, callId);
        }
        messages.push({
          role: 'tool',
          tool_call_id: callId,
          content: JSON.stringify(result),
        });
      }
    }

    return { content, messages, needsMutate, error: 'max tool rounds' };
  }

  async function generateReport({ days = 1, onContent, onTool } = {}) {
    const digest = await buildDigest({ days, includeMessages: true });
    const messages = [
      { role: 'system', content: REPORT_SYSTEM },
      {
        role: 'user',
        content:
          `请根据以下活动快照写工作报告（覆盖最近 ${days} 天）。写完后调用 save_report 保存。\n\n` +
          JSON.stringify(digest),
      },
    ];
    const result = await runLoop(messages, { onContent, onTool });
    // ensure saved
    if (result.content) {
      const day = todayKey();
      const store = await loadReports();
      if (!store[day] || !store[day].markdown) {
        store[day] = {
          day,
          title: days <= 1 ? `${day} 工作日报` : `${day} 近${days}日报告`,
          markdown: result.content,
          generatedAt: new Date().toISOString(),
          digest: {
            sessions: digest.totals.sessions,
            projects: digest.totals.projects,
          },
        };
        await saveReports();
      }
    }
    return { ...result, digest };
  }

  // ── Chat session CRUD (folder: .ai/sessions/) ──────────────────────────────
  async function listChatSessions() {
    const index = await loadSessionsIndex();
    return [...index.sessions]
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map((s) => ({
        id: s.id,
        title: s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messageCount: s.messageCount || 0,
        preview: s.preview || '',
      }));
  }

  async function getChatSession(id) {
    if (!id) return null;
    if (sessionBodyCache.has(id)) return sessionBodyCache.get(id);
    await ensureAiDirs();
    await migrateSessionLayout();
    const row = await readSessionBundle(id);
    if (row?.id) {
      sessionBodyCache.set(row.id, row);
      return row;
    }
    return null;
  }

  async function saveChatSession(session) {
    if (!session?.id) throw new Error('session.id required');
    await ensureAiDirs();
    const prev = await getChatSession(session.id);
    const now = Date.now();
    const messages = session.messages || prev?.messages || [];
    const row = {
      id: session.id,
      title: session.title || prev?.title || '对话',
      messages,
      createdAt: session.createdAt || prev?.createdAt || now,
      updatedAt: now,
      preview: previewFromMessages(messages),
      model: session.model || prev?.model || null,
      vlmThreadIds: session.vlmThreadIds || prev?.vlmThreadIds || [],
    };
    await writeSessionBundle(row);
    sessionBodyCache.set(row.id, row);

    const index = await loadSessionsIndex();
    const entry = indexEntryFromSession(row);
    const i = index.sessions.findIndex((s) => s.id === row.id);
    if (i >= 0) index.sessions[i] = entry;
    else index.sessions.unshift(entry);
    index.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    await saveSessionsIndex();
    await pruneSessionFiles();
    return row;
  }

  async function deleteChatSession(id) {
    if (!id) return { ok: false };
    sessionBodyCache.delete(id);
    // remove meta.json + messages.jsonl + vlm/*
    await rmrf(sessionDir(id));
    for (const key of [...vlmThreads.keys()]) {
      if (key.startsWith(`${id}::`)) vlmThreads.delete(key);
    }
    const index = await loadSessionsIndex();
    index.sessions = index.sessions.filter((s) => s.id !== id);
    await saveSessionsIndex();
    return { ok: true };
  }

  /** Data root for ops / docs */
  function getDataPaths() {
    return {
      aiDir,
      sessionsDir,
      sessionsIndexFile,
      legacySessionsFile,
      legacyGlobalVlmDir,
      layout: 'sessions/{sessionId}/meta.json + messages.jsonl + vlm/{threadId}.jsonl',
    };
  }

  return {
    TOOLS,
    loadConfig,
    saveConfig,
    publicConfig,
    loadReports,
    getReport: async (day) => {
      const store = await loadReports();
      return store[day || todayKey()] || null;
    },
    listReports: async (limit = 30) => {
      const store = await loadReports();
      return Object.values(store)
        .sort((a, b) => String(b.day).localeCompare(String(a.day)))
        .slice(0, limit);
    },
    buildDigest,
    listMetaNotes,
    getMetaNote,
    saveMetaNote,
    deleteMetaNote,
    buildSessionBrief,
    executeTool,
    runLoop,
    resolveApproval,
    generateReport,
    listChatSessions,
    getChatSession,
    saveChatSession,
    deleteChatSession,
    getDataPaths,
    todayKey,
    DEFAULT_SYSTEM,
    AI_DEFAULTS,
  };
}
