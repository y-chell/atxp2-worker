import { Hono } from 'hono';

export interface Env {
  DB: D1Database;
  API_KEY?: string;
  ADMIN_KEY?: string;
}

interface Account {
  id: number;
  email: string;
  refresh_token: string;
  access_token: string;
  token_expires: number;
  error_count: number;
  last_error: string;
  last_error_time: number;
}

const BASE_URL = 'https://chat.atxp.ai';
const TOKEN_TTL = 840; // 15min - 60s buffer
const ERROR_RESET_AFTER = 300; // 5min auto-recovery
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Best-effort in-memory models cache (per isolate instance)
let modelsCache: { data: unknown[] | null; expires: number } = { data: null, expires: 0 };

// ============================================================
// Account pool helpers
// ============================================================

async function acquireAccount(db: D1Database): Promise<Account | null> {
  const now = Math.floor(Date.now() / 1000);
  // Auto-recover error accounts past cooldown
  await db
    .prepare('UPDATE accounts SET error_count = 0, last_error = \'\' WHERE error_count >= 5 AND last_error_time < ?')
    .bind(now - ERROR_RESET_AFTER)
    .run();
  return db
    .prepare('SELECT * FROM accounts WHERE error_count < 5 ORDER BY RANDOM() LIMIT 1')
    .first<Account>();
}

async function releaseAccount(db: D1Database, acc: Account, error = '') {
  if (error) {
    await db
      .prepare(
        'UPDATE accounts SET error_count = error_count + 1, last_error = ?, last_error_time = ? WHERE id = ?',
      )
      .bind(error.slice(0, 200), Math.floor(Date.now() / 1000), acc.id)
      .run();
  } else {
    await db.prepare("UPDATE accounts SET error_count = 0, last_error = '' WHERE id = ?").bind(acc.id).run();
  }
}

async function ensureToken(db: D1Database, acc: Account): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (acc.access_token && now < acc.token_expires) return acc.access_token;

  const resp = await fetch(`${BASE_URL}/api/auth/refresh`, {
    method: 'POST',
    headers: {
      Cookie: `refreshToken=${acc.refresh_token}`,
      'Content-Type': 'application/json',
      'User-Agent': UA,
      Origin: BASE_URL,
      Referer: `${BASE_URL}/`,
    },
    body: '{}',
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`刷新失败 [${resp.status}]: ${text.slice(0, 200)}`);
  }

  const data = (await resp.json()) as { token?: string };
  if (!data.token) throw new Error(`无 token: ${JSON.stringify(data).slice(0, 100)}`);

  // Handle refreshToken rotation
  let newRefreshToken = acc.refresh_token;
  const setCookie = resp.headers.get('Set-Cookie') ?? '';
  const rtMatch = setCookie.match(/refreshToken=([^;]+)/);
  if (rtMatch && rtMatch[1] !== acc.refresh_token) {
    newRefreshToken = rtMatch[1];
  }

  await db
    .prepare('UPDATE accounts SET access_token = ?, token_expires = ?, refresh_token = ? WHERE id = ?')
    .bind(data.token, now + TOKEN_TTL, newRefreshToken, acc.id)
    .run();

  return data.token;
}

// ============================================================
// Conversion helpers
// ============================================================

function modelMap(model: string): string {
  if (model.includes('/')) return model;
  if (model.startsWith('claude-')) return `anthropic/${model}`;
  if (model.startsWith('gemini-')) return `google-ai-studio/${model}`;
  if (model.startsWith('grok-')) return `grok/${model}`;
  if (model.startsWith('deepseek-')) return `deepseek/${model}`;
  return `openai/${model}`;
}

function messagesToText(messages: Array<{ role: string; content: unknown }>): string {
  return messages
    .map((msg) => {
      let content: string;
      if (Array.isArray(msg.content)) {
        content = (msg.content as Array<{ type: string; text?: string }>)
          .filter((p) => p.type === 'text')
          .map((p) => p.text ?? '')
          .join(' ');
      } else {
        content = String(msg.content ?? '');
      }
      if (msg.role === 'system') return `[System] ${content}`;
      if (msg.role === 'assistant') return `[Assistant] ${content}`;
      return content;
    })
    .join('\n\n');
}

function extractDeltaText(data: unknown): string {
  if (typeof data !== 'object' || data === null) return '';
  const d = data as { event?: string; data?: { delta?: { content?: Array<{ type: string; text?: string }> } } };
  if (d.event !== 'on_message_delta') return '';
  for (const part of d.data?.delta?.content ?? []) {
    if (part.type === 'text') return part.text ?? '';
  }
  return '';
}

function oaiChunk(id: string, model: string, content: string, finishReason: string | null): string {
  return (
    'data: ' +
    JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
    }) +
    '\n\n'
  );
}

function roleChunk(id: string, model: string): string {
  return (
    'data: ' +
    JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    }) +
    '\n\n'
  );
}

// ============================================================
// App + routes
// ============================================================

const app = new Hono<{ Bindings: Env }>();

// API key auth for /v1/*
app.use('/v1/*', async (c, next) => {
  const key = c.env.API_KEY;
  if (!key) return next();
  const auth = c.req.header('Authorization') ?? '';
  if (auth.replace(/^Bearer\s+/, '') !== key) {
    return c.json({ error: { message: 'Invalid API key', type: 'invalid_request_error' } }, 401);
  }
  return next();
});

// Admin key auth for /admin/*
app.use('/admin/*', async (c, next) => {
  const key = c.env.ADMIN_KEY;
  if (!key) return next();
  const auth = c.req.header('Authorization') ?? '';
  if (auth.replace(/^Bearer\s+/, '') !== key) {
    return c.json({ error: { message: 'Unauthorized' } }, 401);
  }
  return next();
});

// ── POST /v1/chat/completions ────────────────────────────────
app.post('/v1/chat/completions', async (c) => {
  let body: { messages?: unknown[]; model?: string; stream?: boolean };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: 'Invalid JSON body' } }, 400);
  }

  const messages = (body.messages ?? []) as Array<{ role: string; content: unknown }>;
  const model = body.model ?? 'anthropic/claude-sonnet-4-6';
  const stream = body.stream ?? false;
  const lcModel = modelMap(model);
  const text = messagesToText(messages);
  if (!text) return c.json({ error: { message: 'No messages' } }, 400);

  const acc = await acquireAccount(c.env.DB);
  if (!acc) return c.json({ error: { message: 'No available accounts' } }, 503);

  let token: string;
  try {
    token = await ensureToken(c.env.DB, acc);
  } catch (e) {
    await releaseAccount(c.env.DB, acc, String(e));
    return c.json({ error: { message: `Token error: ${e}` } }, 502);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    Origin: BASE_URL,
    Referer: `${BASE_URL}/c/new`,
    'User-Agent': UA,
  };

  const payload = {
    text,
    sender: 'User',
    clientTimestamp: new Date().toISOString().slice(0, 19),
    isCreatedByUser: true,
    parentMessageId: '00000000-0000-0000-0000-000000000000',
    messageId: crypto.randomUUID(),
    error: false,
    endpoint: 'ATXP',
    endpointType: 'custom',
    model: lcModel,
    modelLabel: null,
    spec: lcModel,
    key: 'never',
    isTemporary: true,
    isRegenerate: false,
    isContinued: false,
    conversationId: null,
    ephemeralAgent: { mcp: ['sys__clear__sys'], web_search: false, file_search: false, execute_code: false, artifacts: false },
  };

  // Step 1: init chat (up to 3 retries for 429)
  let convId = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const initResp = await fetch(`${BASE_URL}/api/agents/chat/ATXP`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (initResp.status === 429) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
        continue;
      }
      await releaseAccount(c.env.DB, acc, 'concurrent_limit');
      return c.json({ error: { message: 'Server busy, please retry later', type: 'rate_limit' } }, 429);
    }

    if (!initResp.ok) {
      const err = await initResp.text();
      await releaseAccount(c.env.DB, acc, err.slice(0, 200));
      return c.json({ error: { message: `Chat init failed [${initResp.status}]: ${err.slice(0, 200)}` } }, 502);
    }

    const ct = initResp.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      const initData = (await initResp.json()) as { conversationId?: string };
      convId = initData.conversationId ?? '';
      if (!convId) {
        await releaseAccount(c.env.DB, acc, 'No conversationId');
        return c.json({ error: { message: 'No conversationId in response' } }, 502);
      }
      break;
    }

    // SSE error response (e.g. "Invalid model spec")
    const sseText = await initResp.text();
    for (const line of sseText.split('\n')) {
      const l = line.trim();
      if (!l.startsWith('data:')) continue;
      try {
        const d = JSON.parse(l.slice(5).trim()) as { text?: string; error?: boolean };
        if (d.text === 'Invalid model spec') {
          await releaseAccount(c.env.DB, acc);
          return c.json({ error: { message: `Model '${model}' is not available on this endpoint`, type: 'invalid_request_error' } }, 400);
        }
        if (d.error) {
          await releaseAccount(c.env.DB, acc, d.text ?? 'upstream error');
          return c.json({ error: { message: `Upstream error: ${d.text}` } }, 502);
        }
      } catch { /* ignore parse errors */ }
    }
    await releaseAccount(c.env.DB, acc, `unexpected SSE: ${sseText.slice(0, 100)}`);
    return c.json({ error: { message: 'Unexpected response format' } }, 502);
  }

  if (!convId) {
    await releaseAccount(c.env.DB, acc, 'max retries');
    return c.json({ error: { message: 'Max retries exceeded' } }, 502);
  }

  // Step 2: get stream
  const streamHeaders: Record<string, string> = { ...headers };
  delete streamHeaders['Content-Type'];

  const streamResp = await fetch(`${BASE_URL}/api/agents/chat/stream/${convId}`, { headers: streamHeaders });
  if (!streamResp.ok) {
    const err = await streamResp.text();
    await releaseAccount(c.env.DB, acc, `stream ${streamResp.status}`);
    return c.json({ error: { message: `Stream failed: ${err.slice(0, 200)}` } }, 502);
  }

  const chunkId = `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

  if (!stream) {
    // Non-stream: collect full response
    const raw = await streamResp.text();
    let fullContent = '';
    for (const line of raw.split('\n')) {
      const l = line.trim();
      if (!l.startsWith('data:')) continue;
      const ds = l.slice(5).trim();
      if (ds === '[DONE]') continue;
      try { fullContent += extractDeltaText(JSON.parse(ds)); } catch { /* ignore */ }
    }
    await releaseAccount(c.env.DB, acc);
    return c.json({
      id: chunkId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: fullContent }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  // Stream mode: pipe LibreChat SSE → OpenAI SSE via TransformStream
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  c.executionCtx.waitUntil(
    (async () => {
      try {
        await writer.write(encoder.encode(roleChunk(chunkId, model)));

        const reader = streamResp.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          while (buffer.includes('\n\n')) {
            const idx = buffer.indexOf('\n\n');
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);

            for (const line of block.split('\n')) {
              const l = line.trim();
              if (!l.startsWith('data:')) continue;
              const ds = l.slice(5).trim();
              if (ds === '[DONE]') {
                await writer.write(encoder.encode(oaiChunk(chunkId, model, '', 'stop')));
                await writer.write(encoder.encode('data: [DONE]\n\n'));
                await releaseAccount(c.env.DB, acc);
                writer.close();
                return;
              }
              try {
                const t = extractDeltaText(JSON.parse(ds));
                if (t) await writer.write(encoder.encode(oaiChunk(chunkId, model, t, null)));
              } catch { /* ignore */ }
            }
          }
        }

        // Stream ended without [DONE]
        await writer.write(encoder.encode(oaiChunk(chunkId, model, '', 'stop')));
        await writer.write(encoder.encode('data: [DONE]\n\n'));
        await releaseAccount(c.env.DB, acc);
      } catch (e) {
        await releaseAccount(c.env.DB, acc, String(e));
      } finally {
        writer.close().catch(() => { /* already closed */ });
      }
    })(),
  );

  return new Response(readable, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
});

// ── GET /v1/models ───────────────────────────────────────────
app.get('/v1/models', async (c) => {
  const now = Math.floor(Date.now() / 1000);
  if (modelsCache.data && now < modelsCache.expires) {
    return c.json({ object: 'list', data: modelsCache.data });
  }

  const acc = await acquireAccount(c.env.DB);
  if (!acc) return c.json({ error: { message: 'No accounts' } }, 503);

  let token: string;
  try {
    token = await ensureToken(c.env.DB, acc);
  } catch (e) {
    await releaseAccount(c.env.DB, acc, String(e));
    return c.json({ error: { message: String(e) } }, 502);
  }

  try {
    const resp = await fetch(`${BASE_URL}/api/models`, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': UA },
    });
    const data = (await resp.json()) as { ATXP?: string[] };
    const modelList = (data.ATXP ?? []).map((id) => ({
      id,
      object: 'model',
      created: now,
      owned_by: id.includes('/') ? id.split('/')[0] : 'unknown',
    }));
    modelsCache = { data: modelList, expires: now + 3600 };
    await releaseAccount(c.env.DB, acc);
    return c.json({ object: 'list', data: modelList });
  } catch (e) {
    await releaseAccount(c.env.DB, acc, String(e));
    return c.json({ error: { message: String(e) } }, 502);
  }
});

// ── GET /status ──────────────────────────────────────────────
app.get('/status', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT email, error_count, access_token, last_error FROM accounts',
  ).all<Account>();
  return c.json({
    total: results.length,
    available: results.filter((a) => a.error_count < 5).length,
    accounts: results.map((a) => ({
      email: a.email,
      errors: a.error_count,
      last_error: a.last_error,
      has_token: Boolean(a.access_token),
    })),
  });
});

// ── Admin: account management ────────────────────────────────
app.get('/admin/accounts', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, email, error_count, last_error FROM accounts ORDER BY id',
  ).all();
  return c.json(results);
});

app.post('/admin/accounts', async (c) => {
  const body = (await c.req.json()) as { email?: string; refresh_token?: string };
  if (!body.email || !body.refresh_token) {
    return c.json({ error: 'email and refresh_token required' }, 400);
  }
  await c.env.DB.prepare(
    "INSERT OR REPLACE INTO accounts (email, refresh_token, access_token, token_expires, error_count) VALUES (?, ?, '', 0, 0)",
  )
    .bind(body.email, body.refresh_token)
    .run();
  return c.json({ ok: true });
});

app.post('/admin/import', async (c) => {
  const list = (await c.req.json()) as Array<{ email?: string; refresh_token?: string }>;
  if (!Array.isArray(list)) return c.json({ error: 'expected array' }, 400);
  const valid = list.filter((a) => a.email && a.refresh_token) as Array<{ email: string; refresh_token: string }>;
  if (valid.length === 0) return c.json({ error: 'no valid accounts' }, 400);
  await c.env.DB.batch(
    valid.map((a) =>
      c.env.DB.prepare(
        "INSERT OR REPLACE INTO accounts (email, refresh_token, access_token, token_expires, error_count) VALUES (?, ?, '', 0, 0)",
      ).bind(a.email, a.refresh_token),
    ),
  );
  return c.json({ ok: true, imported: valid.length });
});

app.delete('/admin/accounts/:email', async (c) => {
  await c.env.DB.prepare('DELETE FROM accounts WHERE email = ?').bind(c.req.param('email')).run();
  return c.json({ ok: true });
});

// ── Admin UI ─────────────────────────────────────────────────
app.get('/', (c) => {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ATXP2 管理</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;color:#333}
.header{background:#1a1a2e;color:#fff;padding:16px 24px;display:flex;align-items:center;gap:12px}
.header h1{font-size:18px;font-weight:600}
.badge{background:#e94560;padding:2px 8px;border-radius:10px;font-size:12px}
.main{max-width:900px;margin:24px auto;padding:0 16px;display:flex;flex-direction:column;gap:20px}
.card{background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.1);overflow:hidden}
.card-header{padding:14px 20px;border-bottom:1px solid #eee;font-weight:600;font-size:14px;display:flex;justify-content:space-between;align-items:center}
.card-body{padding:20px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.stat{text-align:center;padding:16px;background:#f9f9f9;border-radius:6px}
.stat-num{font-size:28px;font-weight:700;color:#1a1a2e}
.stat-label{font-size:12px;color:#888;margin-top:4px}
.stat-num.ok{color:#16a34a}
.stat-num.err{color:#dc2626}
table{width:100%;border-collapse:collapse;font-size:13px}
th{background:#f9f9f9;padding:10px 12px;text-align:left;font-weight:600;color:#555;border-bottom:2px solid #eee}
td{padding:10px 12px;border-bottom:1px solid #f0f0f0}
tr:last-child td{border-bottom:none}
tr:hover td{background:#fafafa}
.tag{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:500}
.tag.ok{background:#dcfce7;color:#16a34a}
.tag.err{background:#fee2e2;color:#dc2626}
.tag.warn{background:#fef9c3;color:#ca8a04}
.btn{padding:6px 14px;border:none;border-radius:5px;cursor:pointer;font-size:13px;font-weight:500}
.btn-primary{background:#1a1a2e;color:#fff}
.btn-primary:hover{background:#16213e}
.btn-danger{background:#fee2e2;color:#dc2626}
.btn-danger:hover{background:#fecaca}
.btn-sm{padding:4px 10px;font-size:12px}
textarea{width:100%;border:1px solid #ddd;border-radius:5px;padding:10px;font-size:13px;font-family:monospace;resize:vertical;min-height:120px}
textarea:focus{outline:none;border-color:#1a1a2e}
.msg{padding:10px 14px;border-radius:5px;font-size:13px;margin-top:12px;display:none}
.msg.ok{background:#dcfce7;color:#16a34a}
.msg.err{background:#fee2e2;color:#dc2626}
.input-row{display:flex;gap:8px;margin-top:8px}
.input-row input{flex:1;border:1px solid #ddd;border-radius:5px;padding:8px 10px;font-size:13px}
.input-row input:focus{outline:none;border-color:#1a1a2e}
</style>
</head>
<body>
<div class="header">
  <h1>⚡ ATXP2 Worker</h1>
  <span class="badge" id="avail-badge">加载中...</span>
</div>
<div class="main">
  <div class="card">
    <div class="card-header">账号池状态 <button class="btn btn-primary btn-sm" onclick="loadStatus()">刷新</button></div>
    <div class="card-body">
      <div class="stats">
        <div class="stat"><div class="stat-num" id="s-total">-</div><div class="stat-label">总账号</div></div>
        <div class="stat"><div class="stat-num ok" id="s-avail">-</div><div class="stat-label">可用</div></div>
        <div class="stat"><div class="stat-num err" id="s-err">-</div><div class="stat-label">异常</div></div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-header">账号列表</div>
    <div class="card-body" style="padding:0">
      <table><thead><tr><th>邮箱</th><th>状态</th><th>错误次数</th><th>最近错误</th><th>操作</th></tr></thead>
      <tbody id="acc-table"><tr><td colspan="5" style="text-align:center;color:#aaa;padding:20px">加载中...</td></tr></tbody>
      </table>
    </div>
  </div>

  <div class="card">
    <div class="card-header">导入账号</div>
    <div class="card-body">
      <div style="font-size:13px;color:#666;margin-bottom:8px">粘贴 JSON 数组，格式：<code>[{"email":"...","refresh_token":"..."}]</code></div>
      <textarea id="import-json" placeholder='[{"email":"user@example.com","refresh_token":"xxx"}]'></textarea>
      <div style="margin-top:10px;display:flex;gap:8px">
        <button class="btn btn-primary" onclick="importAccounts()">导入</button>
        <button class="btn btn-primary" onclick="document.getElementById('import-json').value=''">清空</button>
      </div>
      <div class="msg" id="import-msg"></div>
    </div>
  </div>
</div>

<script>
const ADMIN_KEY = localStorage.getItem('admin_key') || prompt('请输入 ADMIN_KEY：') || '';
localStorage.setItem('admin_key', ADMIN_KEY);
const H = {'Content-Type':'application/json','Authorization':'Bearer '+ADMIN_KEY};

async function loadStatus(){
  try{
    const r=await fetch('/status');const d=await r.json();
    document.getElementById('s-total').textContent=d.total;
    document.getElementById('s-avail').textContent=d.available;
    document.getElementById('s-err').textContent=d.total-d.available;
    document.getElementById('avail-badge').textContent=d.available+'/'+d.total+' 可用';
  }catch(e){console.error(e)}
}

async function loadAccounts(){
  try{
    const r=await fetch('/admin/accounts',{headers:H});const list=await r.json();
    const tb=document.getElementById('acc-table');
    if(!list.length){tb.innerHTML='<tr><td colspan="5" style="text-align:center;color:#aaa;padding:20px">暂无账号</td></tr>';return;}
    tb.innerHTML=list.map(a=>{
      const ok=a.error_count<5;
      const tag=a.error_count===0?'<span class="tag ok">正常</span>':ok?'<span class="tag warn">警告</span>':'<span class="tag err">异常</span>';
      return \`<tr><td>\${a.email}</td><td>\${tag}</td><td>\${a.error_count}</td><td style="color:#aaa;font-size:12px">\${a.last_error||'-'}</td><td><button class="btn btn-danger btn-sm" onclick="delAccount('\${a.email}')">删除</button></td></tr>\`;
    }).join('');
  }catch(e){console.error(e)}
}

async function delAccount(email){
  if(!confirm('确认删除 '+email+' ?'))return;
  await fetch('/admin/accounts/'+encodeURIComponent(email),{method:'DELETE',headers:H});
  loadAccounts();loadStatus();
}

async function importAccounts(){
  const msg=document.getElementById('import-msg');
  try{
    const list=JSON.parse(document.getElementById('import-json').value);
    const r=await fetch('/admin/import',{method:'POST',headers:H,body:JSON.stringify(list)});
    const d=await r.json();
    msg.className='msg ok';msg.style.display='block';
    msg.textContent='成功导入 '+d.imported+' 个账号';
    loadAccounts();loadStatus();
  }catch(e){
    msg.className='msg err';msg.style.display='block';
    msg.textContent='导入失败：'+e.message;
  }
}

loadStatus();loadAccounts();
setInterval(loadStatus,30000);
</script>
</body>
</html>`;
  return c.html(html);
});

export default app;
