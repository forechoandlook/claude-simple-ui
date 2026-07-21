/**
 * Discover available models for Claude / Codex / Grok from local CLI homes.
 * Never returns secrets (API keys, tokens, base URLs with credentials).
 */
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

/** Static fallbacks when local cache/config is missing. */
export const FALLBACK_MODELS = {
  claude: {
    model: 'claude-sonnet-4-5',
    models: [
      { value: 'claude-sonnet-4-5', label: 'sonnet-4-5' },
      { value: 'claude-sonnet-4-6', label: 'sonnet-4-6' },
      { value: 'claude-opus-4-5', label: 'opus-4-5' },
      { value: 'claude-haiku-4-5', label: 'haiku-4-5' },
    ],
  },
  codex: {
    model: 'gpt-5.4',
    models: [
      { value: 'gpt-5.4', label: 'gpt-5.4' },
      { value: 'gpt-5.3', label: 'gpt-5.3' },
      { value: 'gpt-5.2', label: 'gpt-5.2' },
      { value: 'o3', label: 'o3' },
      { value: 'o4-mini', label: 'o4-mini' },
      { value: 'codex-mini-latest', label: 'codex-mini' },
    ],
  },
  grok: {
    model: 'grok-4.5',
    models: [
      { value: 'grok-4.5', label: 'grok-4.5' },
      { value: 'grok-4', label: 'grok-4' },
      { value: 'grok-3', label: 'grok-3' },
      { value: 'grok-3-mini', label: 'grok-3-mini' },
    ],
  },
};

const DEFAULT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function shortLabel(id) {
  if (!id) return '';
  // claude-sonnet-4-5 → sonnet-4-5 when long
  const m = String(id).match(/^claude-(.+)$/i);
  if (m) return m[1];
  return String(id);
}

function uniqModels(list) {
  const seen = new Set();
  const out = [];
  for (const m of list) {
    if (!m?.value) continue;
    const v = String(m.value).trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push({
      value: v,
      label: m.label || shortLabel(v),
      ...(m.efforts?.length ? { efforts: m.efforts } : {}),
      ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}),
    });
  }
  return out;
}

function ensureDefaultInList(models, model) {
  if (!model) return models;
  if (models.some(m => m.value === model)) return models;
  return [{ value: model, label: shortLabel(model) }, ...models];
}

async function readText(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function readJson(file) {
  const t = await readText(file);
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** Minimal TOML string-value reader (no full parser). */
function tomlTopLevelString(content, key) {
  if (!content) return null;
  const re = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"\\s*$`, 'm');
  const m = content.match(re);
  return m ? m[1] : null;
}

function tomlSectionString(content, section, key) {
  if (!content) return null;
  const secRe = new RegExp(`\\[${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]([\\s\\S]*?)(?=\\n\\[|$)`);
  const sm = content.match(secRe);
  if (!sm) return null;
  const body = sm[1];
  const re = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"\\s*$`, 'm');
  const m = body.match(re);
  return m ? m[1] : null;
}

function effortsFromCodexModel(entry) {
  const levels = entry?.supported_reasoning_levels;
  if (!Array.isArray(levels) || !levels.length) return null;
  const efforts = levels
    .map(l => (typeof l === 'string' ? l : l?.effort || l?.id || l?.value))
    .filter(Boolean)
    .map(String);
  return efforts.length ? efforts : null;
}

function effortsFromGrokInfo(info) {
  const list = info?.reasoning_efforts;
  if (Array.isArray(list) && list.length) {
    const efforts = list
      .map(e => e?.value || e?.id || e?.effort)
      .filter(Boolean)
      .map(String);
    if (efforts.length) return efforts;
  }
  if (info?.supports_reasoning_effort) return ['low', 'medium', 'high'];
  return null;
}

async function discoverClaude(claudeConfigDirs = []) {
  const dirs = claudeConfigDirs?.length
    ? claudeConfigDirs
    : [path.join(os.homedir(), '.claude')];

  const found = [];
  let defaultModel = null;
  const sources = [];

  for (const dir of dirs) {
    for (const name of ['settings.json', 'settings.local.json']) {
      const data = await readJson(path.join(dir, name));
      if (!data || typeof data !== 'object') continue;
      const env = data.env && typeof data.env === 'object' ? data.env : {};
      // Only model-related keys — never auth tokens / base URLs
      const keys = [
        'ANTHROPIC_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL',
        'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL',
        'ANTHROPIC_SMALL_FAST_MODEL',
        'CLAUDE_MODEL',
      ];
      for (const k of keys) {
        const v = env[k];
        if (typeof v === 'string' && v.trim()) {
          found.push({ value: v.trim(), label: shortLabel(v.trim()) });
          if (k === 'ANTHROPIC_MODEL' || k === 'CLAUDE_MODEL') {
            if (!defaultModel) defaultModel = v.trim();
          }
        }
      }
      if (typeof data.model === 'string' && data.model.trim()) {
        found.push({ value: data.model.trim(), label: shortLabel(data.model.trim()) });
        if (!defaultModel) defaultModel = data.model.trim();
      }
      if (found.length) sources.push(path.join(dir, name));
    }
  }

  let models = uniqModels(found);
  let source = 'fallback';
  if (models.length) {
    source = 'settings';
    // Custom gateway / third-party models: list only what is configured
  } else {
    models = FALLBACK_MODELS.claude.models.map(m => ({ ...m }));
    defaultModel = FALLBACK_MODELS.claude.model;
  }

  if (!defaultModel) defaultModel = models[0]?.value || FALLBACK_MODELS.claude.model;
  models = ensureDefaultInList(models, defaultModel);

  return {
    model: defaultModel,
    models,
    efforts: DEFAULT_EFFORTS,
    source,
    sources: sources.slice(0, 4),
  };
}

async function discoverCodex(codexHome) {
  const home = codexHome || path.join(os.homedir(), '.codex');
  const cache = await readJson(path.join(home, 'models_cache.json'));
  const cfgText = await readText(path.join(home, 'config.toml'));
  const cfgModel = tomlTopLevelString(cfgText, 'model');
  const cfgEffort = tomlTopLevelString(cfgText, 'model_reasoning_effort');

  let models = [];
  let source = 'fallback';

  if (cache && Array.isArray(cache.models) && cache.models.length) {
    source = 'cache';
    models = cache.models
      .filter(m => m && (m.visibility == null || m.visibility === 'list' || m.visibility === 'visible'))
      .map(m => {
        const value = m.slug || m.id || m.model;
        if (!value) return null;
        const efforts = effortsFromCodexModel(m);
        return {
          value: String(value),
          label: m.display_name || shortLabel(value),
          ...(efforts ? { efforts } : {}),
          ...(m.default_reasoning_level ? { defaultEffort: String(m.default_reasoning_level) } : {}),
        };
      })
      .filter(Boolean);
    // Prefer priority order if present
    if (cache.models.some(m => m?.priority != null)) {
      const prio = new Map(cache.models.map(m => [m.slug || m.id, m.priority ?? 999]));
      models.sort((a, b) => (prio.get(a.value) ?? 999) - (prio.get(b.value) ?? 999));
    }
  }

  if (!models.length) {
    models = FALLBACK_MODELS.codex.models.map(m => ({ ...m }));
    source = 'fallback';
  }

  let defaultModel = cfgModel || models[0]?.value || FALLBACK_MODELS.codex.model;
  if (cfgModel) source = source === 'fallback' ? 'config' : `${source}+config`;
  models = uniqModels(ensureDefaultInList(models, defaultModel));

  const active = models.find(m => m.value === defaultModel);
  const efforts = active?.efforts || DEFAULT_EFFORTS;
  const effortDefault = cfgEffort || active?.defaultEffort || null;

  return {
    model: defaultModel,
    models,
    efforts,
    effortDefault,
    source,
    fetchedAt: cache?.fetched_at || null,
    clientVersion: cache?.client_version || null,
  };
}

async function discoverGrok(grokHome) {
  const home = grokHome || path.join(os.homedir(), '.grok');
  const cache = await readJson(path.join(home, 'models_cache.json'));
  const cfgText = await readText(path.join(home, 'config.toml'));
  const cfgDefault = tomlSectionString(cfgText, 'models', 'default');

  let models = [];
  let source = 'fallback';

  if (cache?.models && typeof cache.models === 'object') {
    source = 'cache';
    if (Array.isArray(cache.models)) {
      models = cache.models.map(m => {
        if (typeof m === 'string') return { value: m, label: shortLabel(m) };
        const value = m.id || m.model || m.slug || m.name;
        if (!value) return null;
        const info = m.info || m;
        const efforts = effortsFromGrokInfo(info);
        return {
          value: String(value),
          label: info?.name || m.display_name || shortLabel(value),
          ...(efforts ? { efforts } : {}),
          ...(info?.reasoning_effort ? { defaultEffort: String(info.reasoning_effort) } : {}),
        };
      }).filter(Boolean);
    } else {
      models = Object.entries(cache.models).map(([id, entry]) => {
        const info = entry?.info || entry || {};
        if (info.hidden === true) return null;
        const value = info.id || info.model || id;
        const efforts = effortsFromGrokInfo(info);
        return {
          value: String(value),
          label: info.name || info.system_prompt_label || shortLabel(value),
          ...(efforts ? { efforts } : {}),
          ...(info.reasoning_effort ? { defaultEffort: String(info.reasoning_effort) } : {}),
        };
      }).filter(Boolean);
    }
  }

  if (!models.length) {
    models = FALLBACK_MODELS.grok.models.map(m => ({ ...m }));
    source = 'fallback';
  }

  let defaultModel = cfgDefault || models[0]?.value || FALLBACK_MODELS.grok.model;
  if (cfgDefault) source = source === 'fallback' ? 'config' : `${source}+config`;
  models = uniqModels(ensureDefaultInList(models, defaultModel));

  const active = models.find(m => m.value === defaultModel);
  const efforts = active?.efforts || DEFAULT_EFFORTS;
  const effortDefault = active?.defaultEffort || tomlSectionString(cfgText, 'models', 'default_reasoning_effort') || null;

  return {
    model: defaultModel,
    models,
    efforts,
    effortDefault,
    source,
    fetchedAt: cache?.fetched_at || null,
    clientVersion: cache?.grok_version || null,
  };
}

/**
 * @param {{ claudeConfigDirs?: string[], codexHome?: string, grokHome?: string, agents?: string[] }} opts
 */
export async function discoverAllAgentModels(opts = {}) {
  const agents = opts.agents?.length ? opts.agents : ['claude', 'codex', 'grok'];
  const want = new Set(agents);
  const defaults = {};

  if (want.has('claude')) {
    defaults.claude = await discoverClaude(opts.claudeConfigDirs);
  }
  if (want.has('codex')) {
    defaults.codex = await discoverCodex(opts.codexHome);
  }
  if (want.has('grok')) {
    defaults.grok = await discoverGrok(opts.grokHome);
  }

  return defaults;
}
