'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const PORT = Math.max(1, parseInt(process.env.GLM_PROXY_PORT || '3017', 10) || 3017);
const DEFAULT_PROVIDER_ID = process.env.XF_PROVIDER_ID || '5672307d-a380-433f-9a28-23c6b2ba95ea';
const DEFAULT_PROVIDERS_FILE = path.resolve(__dirname, 'providers.json');
const PROVIDERS_FILE = path.resolve(
  process.env.GLM_PROVIDERS_JSON
  || process.env.XF_PROVIDERS_JSON
  || process.env.MULTICC_PROVIDERS_JSON
  || DEFAULT_PROVIDERS_FILE
);
const MAX_JSON_BODY_BYTES = Math.max(
  1024,
  parseInt(process.env.XF_MAX_JSON_BODY_BYTES || process.env.XF_MAX_REQUEST_BYTES || '2097152', 10) || 2097152
);
const UPSTREAM_TIMEOUT_MS = Math.max(3000, parseInt(process.env.XF_UPSTREAM_TIMEOUT_MS || '30000', 10) || 30000);
const MAAS_API_KEY = process.env.XF_MAAS_API_KEY || '';
const RESPONSES_BUSY_RETRY_MAX = Math.max(
  1,
  parseInt(process.env.XF_BUSY_RETRY_MAX || process.env.XF_RESPONSES_BUSY_RETRY_MAX || '8', 10) || 8
);
const BUSY_RETRY_DELAYS_MS = [250, 600, 1200, 2200, 4000, 6500, 9000];
const RESPONSES_TOTAL_ATTEMPTS = RESPONSES_BUSY_RETRY_MAX + 1;
const CHAT_DIAGNOSTIC_EVERY = Math.max(1, parseInt(process.env.XF_CHAT_DIAGNOSTIC_EVERY || '5', 10) || 5);
const CHAT_BUSY_RETRY_DELAYS_MS = [2000, 5000, 10000, 15000];
const CHAT_BUSY_RETRY_MAX = Math.max(1, parseInt(process.env.XF_CHAT_BUSY_RETRY_MAX || '5', 10) || 5);
const CHAT_STEADY_RETRY_DELAY_MS = Math.max(
  1000,
  parseInt(process.env.XF_CHAT_STEADY_RETRY_DELAY_MS || '15000', 10) || 15000
);
const CHAT_PANEL_DIAGNOSTICS = process.env.XF_CHAT_PANEL_DIAGNOSTICS !== '0';
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const PROXY_DIAGNOSTIC_LINE_RE = /^\s*`?\s*proxy\s+(?:retry\b|·\s+upstream\b)[^\r\n`]*`?\s*$/i;
const DEFAULT_CODEX_MODEL_CATALOG = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.codex',
  'model-catalogs',
  'maas-xf-only-models.json'
);
const CODEX_MODEL_CATALOG = process.env.CODEX_GLM_MODEL_CATALOG || DEFAULT_CODEX_MODEL_CATALOG;
const PACKAGE_VERSION = (() => {
  try {
    const rawPkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    return String(rawPkg.version || '0.0.0');
  } catch (_) {
    return '0.0.0';
  }
})();
const STARTED_AT = Date.now();
const CHAT_TOTAL_ATTEMPTS = CHAT_BUSY_RETRY_MAX + 1;

let requestSeq = 0;
let codexModelCatalogBySlug = null;

function canRetryAfterFailure(failures, maxFailures) {
  return failures <= maxFailures;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sanitizeErrorText(value, maxLen = 1200) {
  if (value == null) return '';
  const text = String(value);
  return text
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .replace(/(")?api[_-]?key(")?\s*[:=]\s*"[A-Za-z0-9._-]+"/gi, '"apiKey":"***"')
    .slice(0, maxLen);
}

function isZeroLikeProvider(value) {
  if (value == null) return true;
  if (typeof value === 'number') return value === 0;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '' || normalized === '0' || normalized === 'null' || normalized === 'undefined';
}

function toTokenNumber(value) {
  if (value == null || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.floor(num);
}

function pickTokenNumber(source, ...names) {
  if (!source || typeof source !== 'object') return null;
  for (const name of names) {
    const value = pickTokenNumberFromKey(source, name);
    if (value != null) return value;
  }
  return null;
}

function pickTokenNumberFromKey(source, key) {
  if (!Object.prototype.hasOwnProperty.call(source, key)) return null;
  return toTokenNumber(source[key]);
}

function normalizeUsage(rawUsage, provider) {
  if (!rawUsage || typeof rawUsage !== 'object') return null;

  const promptTokens = pickTokenNumber(
    rawUsage,
    'prompt_tokens',
    'promptTokens',
    'input_tokens',
    'inputTokens',
    'input_token_count',
    'inputTokensCount',
  );
  const completionTokens = pickTokenNumber(
    rawUsage,
    'completion_tokens',
    'completionTokens',
    'output_tokens',
    'outputTokens',
    'output_token_count',
    'outputTokensCount',
  );
  let totalTokens = pickTokenNumber(
    rawUsage,
    'total_tokens',
    'totalTokens',
    'all_tokens',
    'token_count',
    'total_token_count',
  );
  if (totalTokens == null && promptTokens != null && completionTokens != null) {
    totalTokens = promptTokens + completionTokens;
  }
  const usage = {
    ...rawUsage,
  };

  if (isZeroLikeProvider(rawUsage.provider)) {
    usage.provider = provider.id;
  } else if (Object.prototype.hasOwnProperty.call(rawUsage, 'provider')) {
    usage.provider = rawUsage.provider;
  } else {
    usage.provider = provider.id;
  }

  if (promptTokens != null) usage.prompt_tokens = promptTokens;
  if (completionTokens != null) usage.completion_tokens = completionTokens;
  if (totalTokens != null) usage.total_tokens = totalTokens;

  if (usage.prompt_tokens == null && usage.completion_tokens == null && usage.total_tokens == null) {
    return null;
  }
  return usage;
}

function extractUsageFromObj(obj, provider) {
  if (!obj || typeof obj !== 'object') return null;
  const directUsage = obj.usage && normalizeUsage(obj.usage, provider);
  if (directUsage) return directUsage;

  const response = obj.response;
  if (response && typeof response === 'object') {
    const nestedUsage = normalizeUsage(response.usage, provider);
    if (nestedUsage) return nestedUsage;

    const metricsUsage = normalizeUsage(response.metrics, provider);
    if (metricsUsage) return metricsUsage;

    const responseFieldsUsage = normalizeUsage({
      provider: response.provider,
      prompt_tokens: response.prompt_tokens,
      input_tokens: response.input_tokens,
      completion_tokens: response.completion_tokens,
      output_tokens: response.output_tokens,
      total_tokens: response.total_tokens,
    }, provider);
    if (responseFieldsUsage) return responseFieldsUsage;
  }

  return null;
}

function patchCompletedResponsePayload(payload, provider) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.type !== 'response.completed' || !payload.response || typeof payload.response !== 'object') return null;

  const usage = extractUsageFromObj(payload, provider) || buildFallbackUsage(provider);
  if (!usage) return null;
  const existingUsage = payload.response.usage && typeof payload.response.usage === 'object'
    ? normalizeUsage(payload.response.usage, provider)
    : null;

  const finalUsage = existingUsage || usage;
  const rawUsage = payload.response.usage || {};
  const hasProviderKey = rawUsage && Object.prototype.hasOwnProperty.call(rawUsage, 'provider');
  const shouldPatchProvider = !hasProviderKey || isZeroLikeProvider(rawUsage.provider);
  const shouldPatchTokens = !existingUsage
    || existingUsage.prompt_tokens == null
    || existingUsage.completion_tokens == null
    || existingUsage.total_tokens == null;

  if (!shouldPatchProvider && !shouldPatchTokens) return null;

  if (finalUsage) {
    return {
      ...payload,
      response: {
        ...(payload.response || {}),
        usage: finalUsage,
      },
    };
  }

  return null;
}

function buildFallbackUsage(provider) {
  return {
    provider: provider.id,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
}

function normalizeProviderQueryId(providerId = DEFAULT_PROVIDER_ID) {
  if (providerId == null) return DEFAULT_PROVIDER_ID;
  const normalized = String(providerId).trim();
  if (!normalized || normalized === '0' || normalized === 'false' || normalized === 'null' || normalized === 'undefined') {
    return DEFAULT_PROVIDER_ID;
  }
  return normalized;
}

function isTransientXfBusy(message) {
  return /EngineInternalError:1105|system is busy|try again later|code:\s*10012/i.test(String(message || ''));
}

function isRetryableUpstreamFailure(status, detail) {
  return RETRYABLE_HTTP_STATUSES.has(Number(status)) || isTransientXfBusy(detail);
}

function chatChunk(body, content, finishReason = null) {
  return {
    id: `chatcmpl_glm_proxy_${Date.now().toString(36)}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: body && body.model || 'unknown',
    choices: [{
      index: 0,
      delta: content ? { role: 'assistant', content } : {},
      finish_reason: finishReason,
    }],
  };
}

function writeChatDiagnosticChunk(res, body, content, finishReason = null) {
  res.write(`data: ${JSON.stringify(chatChunk(body, content, finishReason))}\n\n`);
}

function retryDiagnosticText({ failures, delay, status }) {
  return `\`proxy · upstream ${status} · ${failures} failures · retrying every ${Math.round(delay / 1000)}s\`\n\n`;
}

function retryDelayMs(failures) {
  if (failures >= CHAT_DIAGNOSTIC_EVERY) return CHAT_STEADY_RETRY_DELAY_MS;
  return CHAT_BUSY_RETRY_DELAYS_MS[Math.min(failures - 1, CHAT_BUSY_RETRY_DELAYS_MS.length - 1)]
    || CHAT_STEADY_RETRY_DELAY_MS;
}

function writeChatRetryExhausted(res, body, failures, status) {
  const content = `\`proxy · upstream ${status} · ${failures} failures · reached retry limit (${CHAT_BUSY_RETRY_MAX}); please retry later\`\n\n`;
  if (body && body.stream) {
    if (!res.headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
    }
    writeChatDiagnosticChunk(res, body, content);
    if (!res.destroyed) {
      try { res.end(); } catch (_) {}
    }
    return;
  }

  if (!res.headersSent) {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      error: `upstream ${status} retry limit reached`,
      failures: failures,
      retryLimit: CHAT_BUSY_RETRY_MAX,
    }));
    return;
  }

  try { res.end(); } catch (_) {}
}

function shouldShowChatDiagnostic(failures) {
  return failures > 0 && failures % CHAT_DIAGNOSTIC_EVERY === 0;
}

function stripProxyDiagnosticText(value) {
  if (typeof value !== 'string' || !value.toLowerCase().includes('proxy')) return value;
  const lines = value.split(/\r?\n/);
  const kept = lines.filter(line => !PROXY_DIAGNOSTIC_LINE_RE.test(line));
  if (kept.length === lines.length) return value;
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function sanitizeMessageContent(content) {
  if (typeof content === 'string') return stripProxyDiagnosticText(content);
  if (Array.isArray(content)) {
    return content.map(part => {
      if (!part || typeof part !== 'object') return part;
      if (typeof part.text === 'string') {
        return { ...part, text: stripProxyDiagnosticText(part.text) };
      }
      if (typeof part.content === 'string') {
        return { ...part, content: stripProxyDiagnosticText(part.content) };
      }
      return part;
    }).filter(part => {
      if (!part || typeof part !== 'object') return true;
      if (Object.prototype.hasOwnProperty.call(part, 'text')) return part.text !== '';
      if (Object.prototype.hasOwnProperty.call(part, 'content')) return part.content !== '';
      return true;
    });
  }
  return content;
}

function sanitizeChatBody(body) {
  if (!body || !Array.isArray(body.messages)) return body;
  return {
    ...body,
    messages: body.messages.map(message => {
      if (!message || typeof message !== 'object') return message;
      return { ...message, content: sanitizeMessageContent(message.content) };
    }).filter(message => {
      if (!message || typeof message !== 'object') return true;
      if (Array.isArray(message.content)) return message.content.length > 0;
      return message.content !== '';
    }),
  };
}

function providerList(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.providers)) return raw.providers;
  if (raw && typeof raw === 'object') return Object.values(raw).filter(v => v && typeof v === 'object');
  return [];
}

function addModelId(ids, value) {
  const id = String(value || '').trim();
  if (id) ids.add(id);
}

function modelIds(provider, cfg) {
  const localCatalogIds = Object.keys(readCodexModelCatalogBySlug());
  if (localCatalogIds.length) return localCatalogIds;

  const ids = new Set();
  const catalog = cfg.modelCatalog && Array.isArray(cfg.modelCatalog.models)
    ? cfg.modelCatalog.models
    : [];
  for (const item of catalog) {
    addModelId(ids, typeof item === 'string' ? item : item && (item.model || item.id || item.slug));
  }
  if (ids.size) return [...ids];
  addModelId(ids, provider.model);
  if (typeof provider.models === 'string') provider.models.split(/\r?\n|,/).forEach(v => addModelId(ids, v));
  if (!ids.size) {
    addModelId(ids, 'xopglm52');
    addModelId(ids, 'xopdeepseekv4pro');
  }
  return [...ids];
}

function readCodexModelCatalogBySlug() {
  if (codexModelCatalogBySlug) return codexModelCatalogBySlug;
  codexModelCatalogBySlug = {};
  try {
    const raw = JSON.parse(fs.readFileSync(CODEX_MODEL_CATALOG, 'utf8'));
    const models = Array.isArray(raw.models) ? raw.models : [];
    for (const model of models) {
      if (model && model.slug) codexModelCatalogBySlug[model.slug] = model;
    }
  } catch (_) {
    codexModelCatalogBySlug = {};
  }
  return codexModelCatalogBySlug;
}

function readProvider(providerId = DEFAULT_PROVIDER_ID) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read provider config: ${PROVIDERS_FILE}`);
  }

  const providers = providerList(raw);
  const provider = providers.find(p => p && (p.id === providerId || p.name === providerId));
  if (!provider) throw new Error(`provider not found: ${providerId}`);

  const cfg = provider.settingsConfig && typeof provider.settingsConfig === 'object'
    ? provider.settingsConfig
    : {};
  const target = cfg.proxyTarget || {};
  const apiKey = MAAS_API_KEY;
  const baseUrl = target.baseUrl
    || process.env.XF_MAAS_RESPONSES_URL
    || 'https://maas-coding-api.cn-huabei-1.xf-yun.com/v1/responses';
  const chatCompletionsUrl = target.chatCompletionsUrl
    || process.env.XF_MAAS_CHAT_COMPLETIONS_URL
    || 'https://maas-coding-api.cn-huabei-1.xf-yun.com/v2/chat/completions';

  if (!apiKey) {
    const hasLocalKey = Boolean(target.apiKey || provider.authToken || cfg.auth?.OPENAI_API_KEY);
    if (hasLocalKey) {
      throw new Error(`provider ${providerId} has no env api key: set XF_MAAS_API_KEY for secret injection`);
    }
    throw new Error(`provider ${providerId} has no api key`);
  }
  if (target.apiKey || provider.authToken || cfg.auth?.OPENAI_API_KEY) {
    console.warn(`[glm-proxy] [${providerId}] provider config contains api key fields, but XF_MAAS_API_KEY is used for authentication`);
  }

  return {
    id: provider.id || providerId,
    name: provider.name || providerId,
    baseUrl,
    chatCompletionsUrl,
    apiKey,
    models: modelIds(provider, cfg),
  };
}

function modelPayload(provider) {
  const supportedReasoningLevels = [
    { effort: 'low', description: 'Fast responses with lighter reasoning' },
    { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
    { effort: 'high', description: 'Greater reasoning depth for complex problems' },
  ];
  const metadata = {
    'astron-code-latest': {
      displayName: 'Astron Code Latest',
      description: 'iFlytek MaaS Coding Plan Astron Code Latest.',
      priority: 10,
    },
    xopglm52: {
      displayName: 'GLM5.2',
      description: 'iFlytek MaaS Coding Plan GLM-5.2.',
      priority: 15,
    },
    xopdeepseekv4pro: {
      displayName: 'DeepSeek V4 Pro',
      description: 'iFlytek MaaS Coding Plan DeepSeek V4 Pro.',
      priority: 20,
    },
    xopdeepseekv4flash: {
      displayName: 'DeepSeek-V4-Flash',
      description: 'iFlytek MaaS Coding Plan DeepSeek-V4-Flash.',
      priority: 30,
    },
    xopdeepseekv32: {
      displayName: 'DeepSeek-V3.2',
      description: 'iFlytek MaaS Coding Plan DeepSeek-V3.2.',
      priority: 40,
    },
  };
  const models = provider.models.map(id => {
    const cached = readCodexModelCatalogBySlug()[id] || {};
    const info = metadata[id] || {
      displayName: id,
      description: `iFlytek MaaS Coding Plan ${id}.`,
      priority: 30,
    };
    return {
      ...cached,
      id,
      slug: id,
      name: info.displayName,
      display_name: info.displayName,
      displayName: info.displayName,
      description: info.description,
      object: 'model',
      created: 0,
      owned_by: 'codex-glm-proxy',
      provider: 'xf_maas_coding',
      default_reasoning_level: 'high',
      supported_reasoning_levels: supportedReasoningLevels,
      shell_type: 'shell_command',
      visibility: 'list',
      supported_in_api: true,
      priority: info.priority,
      additional_speed_tiers: [],
      service_tiers: [],
      availability_nux: null,
      upgrade: null,
      base_instructions: cached.base_instructions || 'You are Codex, a coding agent. Work carefully, verify results, and answer in the user language.',
      model_messages: cached.model_messages || {
        instructions_template: '{{ personality }}\n\nYou are Codex, a coding agent. Work carefully, verify results, and answer in the user language.',
        instructions_variables: {
          personality_default: '',
          personality_friendly: '',
          personality_pragmatic: '',
        },
      },
      supports_reasoning: true,
      supports_reasoning_summaries: true,
      default_reasoning_summary: 'none',
      support_verbosity: true,
      default_verbosity: 'medium',
      apply_patch_tool_type: 'freeform',
      web_search_tool_type: 'text_and_image',
      truncation_policy: { mode: 'tokens', limit: 10000 },
      supports_parallel_tool_calls: true,
      supports_image_detail_original: true,
      context_window: 200000,
      max_context_window: 200000,
      max_output_tokens: 8192,
      comp_hash: 'local',
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      input_modalities: ['text'],
      supports_search_tool: true,
      use_responses_lite: false,
      hidden: false,
    };
  });
  return { object: 'list', data: models, models };
}

function setSseHeaders(res) {
  if (res.headersSent) return;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

function sendFailed(res, message) {
  setSseHeaders(res);
  res.write(`event: response.failed\ndata: ${JSON.stringify({
    type: 'response.failed',
    response: { status: 'failed', error: { message: sanitizeErrorText(message) } },
  })}\n\n`);
  try { res.end(); } catch (_) {}
}

async function readJsonBody(req) {
  const chunks = [];
  const contentLength = parseInt(req.headers['content-length'] || '', 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
    const err = new Error(`request body too large: ${contentLength} > ${MAX_JSON_BODY_BYTES}`);
    err.code = 'PAYLOAD_TOO_LARGE';
    throw err;
  }

  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buf.length;
    if (total > MAX_JSON_BODY_BYTES) {
      const err = new Error(`request body too large: ${total} > ${MAX_JSON_BODY_BYTES}`);
      err.code = 'PAYLOAD_TOO_LARGE';
      throw err;
    }
    chunks.push(buf);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    const err = new Error(`invalid json body: ${e.message}`);
    throw err;
  }
}

function createTimedAbortController(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`upstream timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  const clear = () => {
    clearTimeout(timeout);
  };

  if (!parentSignal) return { signal: controller.signal, clear };
  if (parentSignal.aborted) {
    clear();
    controller.abort(parentSignal.reason || new Error('request aborted'));
    return { signal: controller.signal, clear };
  }

  const forwardAbort = () => {
    clear();
    if (!controller.signal.aborted) controller.abort(parentSignal.reason || new Error('request aborted'));
  };

  parentSignal.addEventListener('abort', forwardAbort, { once: true });

  const cleanup = () => {
    clear();
    parentSignal.removeEventListener('abort', forwardAbort);
  };

  return { signal: controller.signal, clear: cleanup };
}

function trackEventFactory(stats, state, provider) {
  let currentEvent = '';
  let currentData = [];
  return function track(rawLine) {
    const line = String(rawLine || '').replace(/\r$/, '');
    stats.lines++;
    if (!line.trim()) {
      finish();
      return;
    }
    if (line.startsWith('event:')) {
      currentEvent = line.slice(6).trim();
      return;
    }
    if (line.startsWith('data:')) {
      currentData.push(line.slice(5).trimStart());
    }
  };

  function finish() {
    if (!currentEvent && currentData.length === 0) return;
    const payload = currentData.join('\n');
    let obj = null;
    if (payload && payload !== '[DONE]') {
      try { obj = JSON.parse(payload); } catch (_) {}
    }
    const typ = currentEvent || (obj && obj.type) || '';
    if (typ) stats.events++;
    if (/^response\.(output_|content_part|function_call|reasoning)/.test(typ)) state.sawOutput = true;
    if (typ === 'response.output_text.delta') stats.deltas++;
    if (typ === 'response.output_text.done') stats.outputDone++;
    if (typ === 'response.completed') {
      state.completed = true;
      stats.completedEvents++;
    }
    if (typ === 'response.failed' || typ === 'error') {
      state.failed = true;
      stats.failedEvents++;
      const msg = obj && obj.response && obj.response.error && obj.response.error.message
        ? obj.response.error.message
        : obj && obj.error && obj.error.message
          ? obj.error.message
          : '';
      if (msg && !stats.failedMessage) {
        stats.failedMessage = sanitizeErrorText(msg).slice(0, 300);
      }
    }
    const usage = extractUsageFromObj(obj, provider);
    if (usage) {
      state.usage = usage;
    }
    if (obj && obj.response && typeof obj.response === 'object') {
      state.responseMeta = { ...(state.responseMeta || {}), ...obj.response };
      if (Array.isArray(obj.response.output)) {
        obj.response.output.forEach((item, idx) => { state.outputItems[idx] = item; });
      }
    }
    if (obj && obj.item && /^response\.output_item\.(added|done)$/.test(typ)) {
      const idx = Number.isInteger(obj.output_index) ? obj.output_index : state.outputItems.length;
      state.outputItems[idx] = obj.item;
    }
    currentEvent = '';
    currentData = [];
  }
}

async function proxyResponses(req, res, provider) {
  let body;
  try {
    body = { ...(await readJsonBody(req)), stream: true };
  } catch (e) {
    const status = e && e.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400;
    json(res, status, { error: sanitizeErrorText(e && e.message ? e.message : String(e)) });
    return;
  }

  const reqId = `glm-${(++requestSeq).toString(36)}`;
  const startedAt = Date.now();
  console.log(`[glm-proxy] [${reqId}] start ${JSON.stringify({
    model: body.model || null,
    inputItems: Array.isArray(body.input) ? body.input.length : null,
    tools: Array.isArray(body.tools) ? body.tools.length : 0,
    reasoningEffort: body.reasoning && body.reasoning.effort || null,
  })}`);

  let clientClosed = false;
  let currentAborter = null;
  const abortStream = () => {
    clientClosed = true;
    try { if (currentAborter) currentAborter.abort(); } catch (_) {}
  };
  req.on('aborted', () => abortStream());
  res.on('close', () => { clientClosed = true; abortStream(); });

  setSseHeaders(res);

  let consecutiveFailures = 0;
  for (let attempt = 1; attempt <= RESPONSES_TOTAL_ATTEMPTS; attempt++) {
    const stats = {
      attempt,
      events: 0,
      lines: 0,
      bytes: 0,
      deltas: 0,
      outputDone: 0,
      completedEvents: 0,
      failedEvents: 0,
      injectedCompleted: false,
      upstreamDone: false,
      failedMessage: '',
      busyRetry: false,
    };
    const state = {
      completed: false,
      failed: false,
      sawOutput: false,
      responseMeta: null,
      usage: null,
      outputItems: [],
    };

    const aborter = new AbortController();
    currentAborter = aborter;
    const upstreamTimer = createTimedAbortController(aborter.signal, UPSTREAM_TIMEOUT_MS);
    let upstream;
    try {
      upstream = await fetch(provider.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: upstreamTimer.signal,
      });
    } catch (e) {
      upstreamTimer.clear();
      if (currentAborter === aborter) currentAborter = null;
      consecutiveFailures += 1;
      const message = sanitizeErrorText(`fetch upstream failed: ${e && e.message ? e.message : String(e)}`);
      if (!canRetryAfterFailure(consecutiveFailures, RESPONSES_BUSY_RETRY_MAX)) {
        sendFailed(res, message);
        return;
      }
      const delay = BUSY_RETRY_DELAYS_MS[Math.min(consecutiveFailures - 1, BUSY_RETRY_DELAYS_MS.length - 1)] || 1000;
      console.warn(`[glm-proxy] [${reqId}] responses upstream fetch failed; failure ${consecutiveFailures}; next ${delay}ms`);
      await sleep(delay);
      continue;
    }

    if (!upstream.ok || !upstream.body) {
      let detail = '';
      try { detail = await upstream.text(); } catch (_) {}
      upstreamTimer.clear();
      if (currentAborter === aborter) currentAborter = null;
      sendFailed(res, sanitizeErrorText(`upstream ${upstream.status}: ${String(detail).slice(0, 500)}`));
      return;
    }

    let committed = false;
    let retryBusy = false;
    let stopAfterTerminalEvent = false;
    const pendingWrites = [];
    const trackLine = trackEventFactory(stats, state, provider);

    const writeOut = (text) => {
      if (clientClosed) return;
      if (committed) {
        try { res.write(text); } catch (_) {}
      } else {
        pendingWrites.push(text);
      }
    };
    const commit = () => {
      if (committed || clientClosed) return;
      committed = true;
      for (const text of pendingWrites.splice(0)) {
        try { res.write(text); } catch (_) {}
      }
    };

    const reader = upstream.body.getReader();
    const decoder = new StringDecoder('utf8');
    let buffer = '';

    try {
      while (!clientClosed) {
        const { done, value } = await reader.read();
        if (done) {
          stats.upstreamDone = true;
          break;
        }
        stats.bytes += value.byteLength;
        buffer += decoder.write(value);
        let nl;
        let currentEventLine = '';
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.startsWith('event:')) {
            currentEventLine = line.slice(6).trim();
            trackLine(line);
            writeOut(line + '\n');
            continue;
          }

          if (line.startsWith('data:')) {
            let outLine = line;
            if (currentEventLine === 'response.completed') {
              const dataLine = line.slice(5).trimStart();
              if (dataLine && dataLine !== '[DONE]') {
                try {
                  const parsed = JSON.parse(dataLine);
                  const patched = patchCompletedResponsePayload(parsed, provider);
                  if (patched && patched.response) {
                    if (patched.response.usage) {
                      state.responseMeta = { ...(state.responseMeta || {}), ...patched.response };
                      state.usage = patched.response.usage;
                    }
                    outLine = `data: ${JSON.stringify(patched)}`;
                  }
                } catch (_) {}
              }
            }
            trackLine(line);
            writeOut(outLine + '\n');
            continue;
          }

          trackLine(line);
          writeOut(line + '\n');

          if (state.sawOutput || state.completed) commit();
          if (state.failed) {
            if (!committed && !state.sawOutput && isTransientXfBusy(stats.failedMessage)) {
              consecutiveFailures += 1;
              retryBusy = canRetryAfterFailure(consecutiveFailures, RESPONSES_BUSY_RETRY_MAX);
              stats.busyRetry = retryBusy;
              if (!retryBusy) {
                commit();
              }
            } else {
              commit();
            }
          }
          if (retryBusy) break;
          if (state.completed || state.failed) {
            stopAfterTerminalEvent = true;
            break;
          }
        }
        if (retryBusy || stopAfterTerminalEvent) break;
      }

      if (retryBusy || stopAfterTerminalEvent) {
        try { await reader.cancel(); } catch (_) {}
      } else {
        const tail = decoder.end();
        if (tail) buffer += tail;
        if (buffer.length) {
          trackLine(buffer);
          writeOut(buffer);
          buffer = '';
        }
      }

      if (retryBusy) {
        console.warn(`[glm-proxy] [${reqId}] responses upstream busy; retrying ${attempt + 1}/${RESPONSES_TOTAL_ATTEMPTS}: ${stats.failedMessage}`);
        const delay = BUSY_RETRY_DELAYS_MS[Math.min(consecutiveFailures - 1, BUSY_RETRY_DELAYS_MS.length - 1)] || 1000;
        await sleep(delay);
        continue;
      }

      if (!clientClosed && !state.completed && !state.failed) {
        commit();
        const response = {
          ...(state.responseMeta || {}),
          id: (state.responseMeta && state.responseMeta.id) || `resp_glm_proxy_${Date.now().toString(36)}`,
          object: 'response',
          status: 'completed',
          output: state.outputItems.filter(Boolean),
        };
        if (!state.usage && (state.completed || state.responseMeta)) {
          state.usage = buildFallbackUsage(provider);
        }
        if (state.usage) response.usage = state.usage;
        stats.injectedCompleted = true;
        res.write(`\n\nevent: response.completed\ndata: ${JSON.stringify({
          type: 'response.completed',
          response,
        })}\n\n`);
      }
    } catch (e) {
      if (!clientClosed) {
        commit();
        res.write(`\n\nevent: response.failed\ndata: ${JSON.stringify({
          type: 'response.failed',
          response: { status: 'failed', error: { message: `stream error: ${sanitizeErrorText(e && e.message ? e.message : String(e))}` } },
        })}\n\n`);
      }
    } finally {
      upstreamTimer.clear();
      currentAborter = null;
      console.log(`[glm-proxy] [${reqId}] attempt ${attempt} end ${JSON.stringify({
        durMs: Date.now() - startedAt,
        ...stats,
        completed: state.completed,
        failed: state.failed,
        clientClosed,
      })}`);
    }

    try { res.end(); } catch (_) {}
    return;
  }

  try { res.end(); } catch (_) {}
}

async function proxyChatCompletions(req, res, provider) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    const status = e && e.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400;
    json(res, status, { error: sanitizeErrorText(e && e.message ? e.message : String(e)) });
    return;
  }

  body = sanitizeChatBody(body);

  const reqId = `chat-${(++requestSeq).toString(36)}`;
  const startedAt = Date.now();
  console.log(`[glm-proxy] [${reqId}] chat start ${JSON.stringify({
    model: body && body.model || null,
    stream: Boolean(body && body.stream),
    messages: Array.isArray(body && body.messages) ? body.messages.length : null,
    reasoningEffort: body && (
      body.reasoning_effort
      || body.reasoning && body.reasoning.effort
      || body.extra_body && body.extra_body.reasoning_effort
      || body.extra_body && body.extra_body.reasoning && body.extra_body.reasoning.effort
    ) || null,
  })}`);

  let streamedDiagnostics = false;
  let lastFailure = null;
  let consecutiveFailures = 0;
  let clientClosed = false;
  let currentAborter = null;

  const abortStream = () => {
    clientClosed = true;
    if (currentAborter) {
      try { currentAborter.abort(new Error('client closed')); } catch (_) {}
    }
  };
  req.on('aborted', () => abortStream());
  res.on('close', () => { clientClosed = true; });

  for (let attempt = 1; attempt <= CHAT_TOTAL_ATTEMPTS && !res.destroyed; attempt++) {
    let upstream;
    const aborter = new AbortController();
    currentAborter = aborter;
    const upstreamTimer = createTimedAbortController(aborter.signal, UPSTREAM_TIMEOUT_MS);
    try {
      upstream = await fetch(provider.chatCompletionsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: body && body.stream ? 'text/event-stream' : 'application/json',
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify(body || {}),
        signal: upstreamTimer.signal,
      });
    } catch (e) {
      const detail = sanitizeErrorText(`fetch upstream failed: ${e && e.message ? e.message : String(e)}`);
      upstreamTimer.clear();
      currentAborter = null;
      lastFailure = { status: 502, detail };
      consecutiveFailures += 1;
      if (!canRetryAfterFailure(consecutiveFailures, CHAT_BUSY_RETRY_MAX)) {
        console.warn(`[glm-proxy] [${reqId}] chat upstream fetch failed; failure ${consecutiveFailures}; reached retry limit ${CHAT_BUSY_RETRY_MAX}`);
        writeChatRetryExhausted(res, body, consecutiveFailures, 502);
        return;
      }
      const delay = retryDelayMs(consecutiveFailures);
      console.warn(`[glm-proxy] [${reqId}] chat upstream fetch failed; failure ${consecutiveFailures}; next ${delay}ms`);
      if (body && body.stream && CHAT_PANEL_DIAGNOSTICS && shouldShowChatDiagnostic(consecutiveFailures)) {
        if (!res.headersSent) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
        }
        streamedDiagnostics = true;
        writeChatDiagnosticChunk(res, body, retryDiagnosticText({
          failures: consecutiveFailures,
          delay: CHAT_STEADY_RETRY_DELAY_MS,
          status: 502,
        }));
      }
      await sleep(delay);
      continue;
    }

    if (!upstream.ok) {
      let detail = '';
      try { detail = await upstream.text(); } catch (_) {}
      upstreamTimer.clear();
      currentAborter = null;
      lastFailure = { status: upstream.status, detail: sanitizeErrorText(detail) };
      if (isRetryableUpstreamFailure(upstream.status, detail)) {
        consecutiveFailures += 1;
        if (!canRetryAfterFailure(consecutiveFailures, CHAT_BUSY_RETRY_MAX)) {
          console.warn(`[glm-proxy] [${reqId}] chat upstream ${upstream.status}; failure ${consecutiveFailures}; reached retry limit ${CHAT_BUSY_RETRY_MAX}`);
          writeChatRetryExhausted(res, body, consecutiveFailures, upstream.status);
          return;
        }
        const delay = retryDelayMs(consecutiveFailures);
        console.warn(`[glm-proxy] [${reqId}] chat upstream ${upstream.status}; failure ${consecutiveFailures}; next ${delay}ms`);
        if (body && body.stream && CHAT_PANEL_DIAGNOSTICS && shouldShowChatDiagnostic(consecutiveFailures)) {
          if (!res.headersSent) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            });
          }
          streamedDiagnostics = true;
          writeChatDiagnosticChunk(res, body, retryDiagnosticText({
            failures: consecutiveFailures,
            delay: CHAT_STEADY_RETRY_DELAY_MS,
            status: upstream.status,
          }));
        }
        await sleep(delay);
        continue;
      }
      if (res.headersSent) {
        res.destroy(new Error(`upstream ${upstream.status}`));
        return;
      }
      res.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(detail || JSON.stringify({ error: `upstream ${upstream.status}` }));
      return;
    }

    const contentType = body && body.stream ? 'text/event-stream' : 'application/json';
    if (!res.headersSent) {
      res.writeHead(upstream.status, {
        'Content-Type': contentType,
        'Cache-Control': body && body.stream ? 'no-cache' : 'no-store',
        Connection: body && body.stream ? 'keep-alive' : 'close',
      });
    }

    if (!upstream.body) {
      upstreamTimer.clear();
      currentAborter = null;
      res.end();
      return;
    }

    try {
      for await (const chunk of upstream.body) {
        res.write(Buffer.from(chunk));
      }
    } catch (e) {
      if (!res.destroyed) {
        res.write(`\n${JSON.stringify({ error: `stream error: ${sanitizeErrorText(e && e.message ? e.message : String(e))}` })}`);
      }
    } finally {
      upstreamTimer.clear();
      currentAborter = null;
      console.log(`[glm-proxy] [${reqId}] chat end ${JSON.stringify({
        status: upstream.status,
        attempt,
        streamedDiagnostics,
        clientClosed,
        durMs: Date.now() - startedAt,
      })}`);
      try { res.end(); } catch (_) {}
    }
    return;
  }

  if (lastFailure && !res.destroyed) {
    console.warn(`[glm-proxy] [${reqId}] chat stopped after client closed with last failure ${lastFailure.status}`);
  }
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const providerId = normalizeProviderQueryId(url.searchParams.get('provider'));

  let provider;
  try {
    provider = readProvider(providerId);
  } catch (e) {
    const errorMessage = sanitizeErrorText(e && e.message ? e.message : String(e));
    if (url.pathname === '/health') json(res, 503, { ok: false, error: errorMessage });
    else json(res, 500, { error: errorMessage });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, {
      ok: true,
      providerId: provider.id,
      providerName: provider.name,
      models: provider.models,
      version: PACKAGE_VERSION,
      retryMax: RESPONSES_BUSY_RETRY_MAX,
      responsesRetryMax: RESPONSES_BUSY_RETRY_MAX,
      chatRetryMax: CHAT_BUSY_RETRY_MAX,
      chatRetryMaxAttempts: CHAT_TOTAL_ATTEMPTS,
      chatDiagnosticEvery: CHAT_DIAGNOSTIC_EVERY,
      chatSteadyRetryDelayMs: CHAT_STEADY_RETRY_DELAY_MS,
      providerConfigFile: PROVIDERS_FILE,
      upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
      maxRequestBytes: MAX_JSON_BODY_BYTES,
      upstream: provider.baseUrl,
      chatCompletionsUpstream: provider.chatCompletionsUrl,
      uptimeMs: Date.now() - STARTED_AT,
      startedAt: STARTED_AT,
    });
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname.endsWith('/models'))) {
    json(res, 200, modelPayload(provider));
    return;
  }

  if (req.method === 'POST' && (url.pathname === '/v1/responses' || url.pathname.endsWith('/responses'))) {
    await proxyResponses(req, res, provider);
    return;
  }

  if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname.endsWith('/chat/completions'))) {
    await proxyChatCompletions(req, res, provider);
    return;
  }

  json(res, 404, { error: `not found: ${req.method} ${url.pathname}` });
}

const server = http.createServer((req, res) => {
  route(req, res).catch(e => json(res, 500, { error: sanitizeErrorText(e && e.message ? e.message : String(e)) }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[glm-proxy] listening on http://127.0.0.1:${PORT}/v1`);
  console.log(`[glm-proxy] provider config: ${PROVIDERS_FILE}`);
});
