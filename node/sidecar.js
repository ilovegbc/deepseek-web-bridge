'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { PROVIDERS, getProvider } = require('./providers');
const bridge = require('./bridge');
const { chat } = require('./webdriver');
const { AccountPool, profilePath } = require('./pool');

const PORT = parseInt(process.env.SIDECAR_PORT || '8090', 10);
const HOST = process.env.SIDECAR_HOST || '127.0.0.1';
const PROFILE_DIR = path.join(__dirname, 'profiles');
const CHAT_TIMEOUT_SEC = parseInt(process.env.CHAT_TIMEOUT_SEC || '120', 10);

if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

/** @type {import('playwright').Browser|null} */
let browser = null;
const pool = new AccountPool();

async function ensureBrowser() {
  if (browser && browser.isConnected()) return browser;
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ].filter(Boolean);
  let executablePath = null;
  for (const c of candidates) {
    try { if (fs.existsSync(c)) { executablePath = c; break; } } catch (_) {}
  }
  const launchOpts = {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run']
  };
  if (executablePath) launchOpts.executablePath = executablePath;
  browser = await chromium.launch(launchOpts);
  return browser;
}

function startLoginPoll(slot) {
  if (slot.pollTimer) return;
  slot.pollTimer = setInterval(async () => {
    try {
      if (!slot.page || slot.page.isClosed()) return;
      await bridge.configurePage(slot.page, slot.def.provider || 'deepseek');
      const st = await bridge.readState(slot.page);
      if (st && st.loggedIn) {
        if (!slot.loggedIn) {
          slot.loggedIn = true;
          try {
            await slot.context.storageState({ path: profilePath(slot.def.id) });
          } catch (_) {}
        }
      } else {
        slot.loggedIn = false;
      }
    } catch (_) {}
  }, 1000);
}

async function ensureSession(slot) {
  const providerId = slot.def.provider || 'deepseek';
  const p = getProvider(providerId);
  if (!p) throw new Error('unknown_provider');

  if (slot.page && !slot.page.isClosed() && slot.context) return slot;

  const b = await ensureBrowser();
  const sp = profilePath(slot.def.id);
  const ctxOpts = {
    viewport: { width: 1280, height: 800 },
    userAgent: p.desktopUserAgent || p.desktopMode
      ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      : undefined,
    ignoreHTTPSErrors: true
  };
  if (fs.existsSync(sp)) {
    try { ctxOpts.storageState = sp; } catch (_) {}
  }
  const context = await b.newContext(ctxOpts);
  const page = await context.newPage();
  await page.goto(p.homeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await bridge.configurePage(page, providerId);
  slot.context = context;
  slot.page = page;
  startLoginPoll(slot);
  return slot;
}

async function refreshLogin(slot) {
  if (!slot.page || slot.page.isClosed()) return false;
  try {
    await bridge.configurePage(slot.page, slot.def.provider || 'deepseek');
    const st = await bridge.readState(slot.page);
    if (st && st.loggedIn) {
      if (!slot.loggedIn) {
        slot.loggedIn = true;
        try { await slot.context.storageState({ path: profilePath(slot.def.id) }); } catch (_) {}
      }
      return true;
    }
    slot.loggedIn = false;
    return false;
  } catch (_) {
    return false;
  }
}

async function openLoginWindow(accountId) {
  pool.reloadConfig();
  const def = pool.listDefs().find(a => a.id === accountId)
    || pool.listDefs().find(a => !a.running && !a.loggedIn)
    || pool.listDefs()[0];
  if (!def) return { error: 'no accounts configured' };
  const slot = await pool.ensureSlot({ id: def.id, label: def.label, provider: def.provider, enabled: def.enabled });
  await ensureSession(slot);
  const p = getProvider(slot.def.provider || 'deepseek');
  if (slot.page.isClosed()) {
    slot.page = await slot.context.newPage();
  }
  await slot.page.goto(p.homeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await bridge.configurePage(slot.page, p.id);
  await slot.page.bringToFront().catch(() => {});
  await refreshLogin(slot);
  return { ok: true, accountId: def.id, homeUrl: p.homeUrl, loggedIn: slot.loggedIn };
}

async function getStatus(accountId) {
  pool.reloadConfig();
  if (accountId) {
    const def = pool.listDefs().find(a => a.id === accountId);
    if (!def) return { error: 'unknown_account' };
    const slot = pool.slots.get(accountId);
    if (!slot || !slot.page || slot.page.isClosed()) {
      return {
        accountId, label: def.label, provider: def.provider,
        running: false, loggedIn: false, busy: false, state: null
      };
    }
    await refreshLogin(slot);
    return {
      accountId, label: def.label, provider: def.provider,
      running: true, loggedIn: slot.loggedIn, busy: slot.busy, state: null
    };
  }

  const out = {};
  for (const def of pool.listDefs()) {
    const slot = pool.slots.get(def.id);
    if (slot && slot.page && !slot.page.isClosed()) {
      await refreshLogin(slot);
      out[def.id] = {
        accountId: def.id, label: def.label, provider: def.provider,
        running: true, loggedIn: slot.loggedIn, busy: slot.busy, state: null
      };
    } else {
      out[def.id] = {
        accountId: def.id, label: def.label, provider: def.provider,
        running: false, loggedIn: false, busy: false, state: null
      };
    }
  }
  return out;
}

function anyLoggedIn(providerId) {
  for (const def of pool.listDefs()) {
    if (def.provider !== (providerId || 'deepseek')) continue;
    const slot = pool.slots.get(def.id);
    if (slot && slot.loggedIn) return true;
  }
  return false;
}

async function handleChat(body, res) {
  const providerId = body.provider || 'deepseek';
  const prompt = body.prompt || '';
  const stream = !!body.stream;
  const timeoutSec = body.timeoutSec || CHAT_TIMEOUT_SEC;
  const traceId = body.traceId || String(Date.now());
  const queueWaitMs = Number.isFinite(body.queueWaitMs) ? body.queueWaitMs : 90000;
  const wantAccount = body.accountId ? String(body.accountId) : null;

  if (!prompt) {
    return sendJson(res, 400, { error: { message: 'no message content' } });
  }
  const p = getProvider(providerId);
  if (!p) {
    return sendJson(res, 400, { error: { message: 'unknown provider' } });
  }

  pool.reloadConfig();
  const enabled = pool.listDefs().filter(a => a.enabled && a.provider === providerId);
  if (enabled.length === 0) {
    return sendJson(res, 503, { error: { message: 'no accounts in pool' }, traceId, reason: 'pool_empty' });
  }

  let def = null;
  if (wantAccount) {
    def = enabled.find(a => a.id === wantAccount) || null;
    if (!def) return sendJson(res, 400, { error: { message: 'unknown accountId' }, traceId });
    const slot = pool.slots.get(def.id);
    if (slot && slot.busy) {
      def = await pool.acquire(providerId, queueWaitMs).catch(() => null) || def;
    }
  } else {
    def = await acquireWithProvider(pool, providerId, queueWaitMs);
  }

  if (!def) {
    return sendJson(res, 429, { error: { message: 'gateway busy: pool exhausted' }, traceId, reason: 'pool_busy' });
  }

  pool.markBusy(def.id);
  let slot = null;
  try {
    slot = await pool.ensureSlot(def);
    await ensureSession(slot);
    if (slot.page.isClosed()) {
      slot.page = await slot.context.newPage();
      await slot.page.goto(p.homeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await bridge.configurePage(slot.page, providerId);
    } else {
      await bridge.configurePage(slot.page, providerId);
    }
    await slot.page.bringToFront().catch(() => {});

    const loggedIn = await refreshLogin(slot);
    if (!loggedIn) {
      if (stream) {
        res.writeHead(503, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'close',
          'Access-Control-Allow-Origin': '*'
        });
        res.write(JSON.stringify({ type: 'error', message: 'gateway busy: account not logged in' }) + '\n');
        res.end();
        return;
      }
      return sendJson(res, 503, {
        error: { message: 'gateway busy: account not logged in' },
        traceId, accountId: def.id, reason: 'not_logged_in'
      });
    }

    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'close',
        'Access-Control-Allow-Origin': '*'
      });
      const onChunk = async (kind, chunk) => {
        try {
          res.write(JSON.stringify({ type: 'chunk', kind, chunk }) + '\n');
        } catch (_) {}
      };
      const result = await chat(slot.page, providerId, prompt, { timeoutSec, onChunk });
      try {
        res.write(JSON.stringify({
          type: 'done', thinking: result.thinking, answer: result.answer,
          traceId, accountId: def.id
        }) + '\n');
      } catch (_) {}
      res.end();
    } else {
      const result = await chat(slot.page, providerId, prompt, { timeoutSec });
      try { await slot.context.storageState({ path: profilePath(def.id) }); } catch (_) {}
      if (!result.answer && !result.thinking) {
        return sendJson(res, 503, { error: { message: 'gateway busy' }, traceId, accountId: def.id });
      }
      sendJson(res, 200, {
        thinking: result.thinking, answer: result.answer,
        provider: providerId, model: p.model, traceId, accountId: def.id
      });
    }
  } catch (e) {
    if (!res.headersSent) {
      sendJson(res, 500, { error: { message: String(e.message || e) }, traceId, accountId: def && def.id });
    } else {
      try { res.write(JSON.stringify({ type: 'error', message: String(e.message || e) }) + '\n'); } catch (_) {}
      res.end();
    }
  } finally {
    pool.markIdle(def.id);
  }
}

async function acquireWithProvider(poolRef, providerId, waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const def = await poolRef.acquire(providerId, Math.min(2000, Math.max(500, deadline - Date.now())));
    if (def) return def;
    if (Date.now() >= deadline) return null;
  }
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Connection': 'close'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 8 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const route = u.pathname;
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Content-Length': '0'
      });
      return res.end();
    }

    if (route === '/health') {
      return sendJson(res, 200, {
        ok: true, sidecar: true, port: PORT,
        accounts: pool.listDefs().length,
        busy: pool.busyCount(),
        loggedIn: pool.loggedInCount()
      });
    }

    if (route === '/accounts' && req.method === 'GET') {
      return sendJson(res, 200, {
        strategy: pool.strategy(),
        accounts: pool.snapshot()
      });
    }

    if (route === '/accounts' && req.method === 'POST') {
      const body = await readBody(req);
      const r = pool.addAccount(body);
      return sendJson(res, r.ok ? 200 : 400, r);
    }

    if (route === '/accounts' && req.method === 'DELETE') {
      const id = u.searchParams.get('id') || '';
      const r = await pool.removeAccount(id);
      return sendJson(res, r.ok ? 200 : 400, r);
    }

    if (route === '/login' && req.method === 'POST') {
      const body = await readBody(req);
      const r = await openLoginWindow(body.accountId || null);
      return sendJson(res, r.error ? 400 : 200, r);
    }

    if (route === '/login/status' && req.method === 'GET') {
      const accountId = u.searchParams.get('account') || u.searchParams.get('accountId');
      const data = await getStatus(accountId);
      return sendJson(res, 200, data);
    }

    if (route === '/chat' && req.method === 'POST') {
      const body = await readBody(req);
      return await handleChat(body, res);
    }

    if (route === '/providers') {
      const list = Object.values(PROVIDERS).map(p => ({
        id: p.id, displayName: p.displayName, homeUrl: p.homeUrl, model: p.model,
        loginStrategy: p.loginStrategy, freshChatPerApiRequest: p.freshChatPerApiRequest
      }));
      return sendJson(res, 200, list);
    }

    sendJson(res, 404, { error: { message: 'not found' } });
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: { message: String(e.message || e) } });
    else try { res.end(); } catch (_) {}
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[sidecar] listening http://${HOST}:${PORT}`);
  console.log(`[sidecar] accounts: ${pool.listDefs().length}, profiles: ${PROFILE_DIR}`);
});

async function shutdown() {
  try {
    await pool.closeAll();
    if (browser) await browser.close();
  } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
