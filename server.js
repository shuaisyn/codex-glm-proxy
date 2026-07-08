'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const PORT = Math.max(1, parseInt(process.env.GLM_PROXY_PORT || '3017', 10) || 3017);
const DEFAULT_PROVIDER_ID = process.env.XF_PROVIDER_ID || '5672307d-a380-433f-9a28-23c6b2ba95ea';
const DEFAULT_PROVIDERS_FILE = path.resolve(__dirname, '..', 'MultiCC', 'providers.json');
const PROVIDERS_FILE = process.env.MULTICC_PROVIDERS_JSON || DEFAULT_PROVIDERS_FILE;
const BUSY_RETRY_MAX = Math.max(1, parseInt(process.env.XF_BUSY_RETRY_MAX || '8', 10) || 8);
const BUSY_RETRY_DELAYS_MS = [250, 600, 1200, 2200, 4000, 6500, 9000];
const CHAT_BUSY_RETRY_MAX = Math.max(
  BUSY_RETRY_MAX,
  parseInt(process.env.XF_CHAT_BUSY_RETRY_MAX || '12', 10) || 12
);
const CHAT_BUSY_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 7000, 10000, 10000, 10000, 10000, 10000, 10000];
const DEFAULT_CODEX_MODEL_CATALOG = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.codex',
  'model-catalogs',
  'maas-xf-only-models.json'
);
const CODEX_MODEL_CATALOG = process.env.CODEX_GLM_MODEL_CATALOG || DEFAULT_CODEX_MODEL_CATALOG;

let requestSeq = 0;
let codexModelCatalogBySlug = null;

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

function isTransientXfBusy(message) {
  return /EngineInternalError:1105|system is busy|try again later|code:\s*10012/i.test(String(message || ''));
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

  const provider = providerList(raw).find(p => p && (p.id === providerId || p.name === providerId));
  if (!provider) throw new Error(`provider not found: ${providerId}`);

  const cfg = provider.settingsConfig && typeof provider.settingsConfig === 'object'
    ? provider.settingsConfig
    : {};
  const target = cfg.proxyTarget || {};
  const apiKey = target.apiKey || provider.authToken || cfg.auth?.OPENAI_API_KEY || process.env.XF_MAAS_API_KEY || '';
  const baseUrl = target.baseUrl
    || process.env.XF_MAAS_RESPONSES_URL
    || 'https://maas-coding-api.cn-huabei-1.xf-yun.com/v1/responses';
  const chatCompletionsUrl = target.chatCompletionsUrl
    || process.env.XF_MAAS_CHAT_COMPLETIONS_URL
    || 'https://maas-coding-api.cn-huabei-1.xf-yun.com/v2/chat/completions';

  if (!apiKey) throw new Error(`provider has no local api key: ${providerId}`);

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
    xopdeepseekv4pro: {
      displayName: 'DeepSeek-V4-Pro',
      description: 'iFlytek MaaS Coding Plan DeepSeek-V4-Pro.',
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
      name: id,
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
    response: { status: 'failed', error: { message } },
  })}\n\n`);
  try { res.end(); } catch (_) {}
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function trackEventFactory(stats, state) {
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
        stats.failedMessage = String(msg).replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer ***').slice(0, 300);
      }
    }
    if (obj && obj.response && typeof obj.response === 'object') {
      state.responseMeta = { ...(state.responseMeta || {}), ...obj.response };
      if (obj.response.usage) state.usage = obj.response.usage;
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
    json(res, 400, { error: `invalid json body: ${e.message}` });
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
  req.on('aborted', () => {
    clientClosed = true;
    try { if (currentAborter) currentAborter.abort(); } catch (_) {}
  });
  res.on('close', () => { clientClosed = true; });

  setSseHeaders(res);

  for (let attempt = 1; attempt <= BUSY_RETRY_MAX; attempt++) {
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
        signal: aborter.signal,
      });
    } catch (e) {
      sendFailed(res, `fetch upstream failed: ${e && e.message ? e.message : String(e)}`);
      return;
    }

    if (!upstream.ok || !upstream.body) {
      let detail = '';
      try { detail = await upstream.text(); } catch (_) {}
      sendFailed(res, `upstream ${upstream.status}: ${String(detail).slice(0, 500)}`);
      return;
    }

    let committed = false;
    let retryBusy = false;
    let stopAfterTerminalEvent = false;
    const pendingWrites = [];
    const trackLine = trackEventFactory(stats, state);

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
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          trackLine(line);
          writeOut(line + '\n');

          if (state.sawOutput || state.completed) commit();
          if (state.failed) {
            if (!committed && !state.sawOutput && isTransientXfBusy(stats.failedMessage) && attempt < BUSY_RETRY_MAX) {
              retryBusy = true;
              stats.busyRetry = true;
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
        console.warn(`[glm-proxy] [${reqId}] upstream busy; retrying ${attempt + 1}/${BUSY_RETRY_MAX}: ${stats.failedMessage}`);
        const delay = BUSY_RETRY_DELAYS_MS[Math.min(attempt - 1, BUSY_RETRY_DELAYS_MS.length - 1)] || 1000;
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
          response: { status: 'failed', error: { message: `stream error: ${e && e.message ? e.message : String(e)}` } },
        })}\n\n`);
      }
    } finally {
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
    json(res, 400, { error: `invalid json body: ${e.message}` });
    return;
  }

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

  for (let attempt = 1; attempt <= BUSY_RETRY_MAX; attempt++) {
    let upstream;
    try {
      upstream = await fetch(provider.chatCompletionsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: body && body.stream ? 'text/event-stream' : 'application/json',
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify(body || {}),
      });
    } catch (e) {
      json(res, 502, { error: `fetch upstream failed: ${e && e.message ? e.message : String(e)}` });
      return;
    }

    if (!upstream.ok) {
      let detail = '';
      try { detail = await upstream.text(); } catch (_) {}
      if (isTransientXfBusy(detail) && attempt < CHAT_BUSY_RETRY_MAX) {
        const delay = CHAT_BUSY_RETRY_DELAYS_MS[Math.min(attempt - 1, CHAT_BUSY_RETRY_DELAYS_MS.length - 1)] || 1000;
        console.warn(`[glm-proxy] [${reqId}] chat upstream busy; retrying ${attempt + 1}/${CHAT_BUSY_RETRY_MAX}`);
        await sleep(delay);
        continue;
      }
      if (isTransientXfBusy(detail)) {
        console.warn(`[glm-proxy] [${reqId}] chat upstream busy exhausted after ${attempt} attempts`);
      }
      res.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(detail || JSON.stringify({ error: `upstream ${upstream.status}` }));
      return;
    }

    const contentType = upstream.headers.get('content-type') || (body && body.stream ? 'text/event-stream' : 'application/json');
    res.writeHead(upstream.status, {
      'Content-Type': contentType,
      'Cache-Control': body && body.stream ? 'no-cache' : 'no-store',
      Connection: body && body.stream ? 'keep-alive' : 'close',
    });

    if (!upstream.body) {
      res.end();
      return;
    }

    try {
      for await (const chunk of upstream.body) {
        res.write(Buffer.from(chunk));
      }
    } catch (e) {
      if (!res.destroyed) {
        res.write(`\n${JSON.stringify({ error: `stream error: ${e && e.message ? e.message : String(e)}` })}`);
      }
    } finally {
      console.log(`[glm-proxy] [${reqId}] chat end ${JSON.stringify({
        status: upstream.status,
        attempt,
        durMs: Date.now() - startedAt,
      })}`);
      try { res.end(); } catch (_) {}
    }
    return;
  }
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const providerId = url.searchParams.get('provider') || DEFAULT_PROVIDER_ID;

  let provider;
  try {
    provider = readProvider(providerId);
  } catch (e) {
    if (url.pathname === '/health') json(res, 503, { ok: false, error: e.message });
    else json(res, 500, { error: e.message });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, {
      ok: true,
      providerId: provider.id,
      providerName: provider.name,
      models: provider.models,
      retryMax: BUSY_RETRY_MAX,
      chatRetryMax: CHAT_BUSY_RETRY_MAX,
      upstream: provider.baseUrl,
      chatCompletionsUpstream: provider.chatCompletionsUrl,
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
  route(req, res).catch(e => json(res, 500, { error: e && e.message ? e.message : String(e) }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[glm-proxy] listening on http://127.0.0.1:${PORT}/v1`);
  console.log(`[glm-proxy] provider config: ${PROVIDERS_FILE}`);
});
