'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { PROVIDERS, getProvider } = require('./providers');
const bridge = require('./bridge');
const { chat } = require('./webdriver');

const PORT = parseInt(process.env.SIDECAR_PORT || '8090', 10);
const HOST = process.env.SIDECAR_HOST || '127.0.0.1';
const PROFILE_DIR = path.join(__dirname, 'profiles');
const CHAT_TIMEOUT_SEC = parseInt(process.env.CHAT_TIMEOUT_SEC || '120', 10);

if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

/** @type {import('playwright').Browser|null} */
let browser = null;
const sessions = new Map();
let launching = false;

function profilePath(providerId) {
  return path.join(PROFILE_DIR, providerId + '.json');
}

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

async function ensureSession(providerId) {
  const p = getProvider(providerId);
  if (!p) throw new Error('unknown_provider');
  if (sessions.has(providerId)) {
    const s = sessions.get(providerId);
    if (s.context && !s.context.browser()?.isConnected?.()) {
      sessions.delete(providerId);
    } else {
      return s;
    }
  }
  const b = await ensureBrowser();
  const sp = profilePath(providerId);
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
  const session = { context, page, loggedIn: false, loginWindowOpen: false, providerId };
  sessions.set(providerId, session);
  startLoginPoll(session);
  return session;
}

function startLoginPoll(session) {
  if (session._pollTimer) return;
  session._pollTimer = setInterval(async () => {
    try {
      if (!session.page || session.page.isClosed()) return;
      await bridge.configurePage(session.page, session.providerId);
      const st = await bridge.readState(session.page);
      if (st && st.loggedIn) {
        if (!session.loggedIn) {
          session.loggedIn = true;
          try {
            await session.context.storageState({ path: profilePath(session.providerId) });
          } catch (_) {}
        }
      } else {
        session.loggedIn = false;
      }
    } catch (_) {}
  }, 1000);
}

async function openLoginWindow(providerId) {
  const session = await ensureSession(providerId);
  const p = getProvider(providerId);
  if (session.page.isClosed()) {
    session.page = await session.context.newPage();
  }
  await session.page.goto(p.homeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await bridge.configurePage(session.page, providerId);
  await session.page.bringToFront().catch(() => {});
  session.loginWindowOpen = true;
  return { ok: true, homeUrl: p.homeUrl, loggedIn: session.loggedIn };
}

async function getStatus(providerId) {
  const p = getProvider(providerId);
  if (!p) return { error: 'unknown_provider' };
  const session = sessions.get(providerId);
  if (!session || !session.page || session.page.isClosed()) {
    return {
      provider: providerId,
      homeUrl: p.homeUrl,
      running: false,
      loggedIn: false,
      state: null
    };
  }
  try {
    await bridge.configurePage(session.page, providerId);
    const st = await bridge.readState(session.page);
    if (st && st.loggedIn) {
      session.loggedIn = true;
      try { await session.context.storageState({ path: profilePath(providerId) }); } catch (_) {}
    }
    return {
      provider: providerId,
      homeUrl: p.homeUrl,
      running: true,
      loggedIn: !!(st && st.loggedIn),
      state: st
    };
  } catch (e) {
    return { provider: providerId, homeUrl: p.homeUrl, running: false, loggedIn: false, state: null, error: String(e.message || e) };
  }
}

let chatBusy = false;
const chatWaiters = [];

function releaseChatSlot() {
  chatBusy = false;
  const next = chatWaiters.shift();
  if (next) next();
}

async function acquireChatSlot(waitMs) {
  if (!chatBusy) {
    chatBusy = true;
    return true;
  }
  return await new Promise((resolve) => {
    let done = false;
    const entry = () => {
      if (done) return;
      done = true;
      chatBusy = true;
      resolve(true);
    };
    chatWaiters.push(entry);
    setTimeout(() => {
      if (done) return;
      done = true;
      const i = chatWaiters.indexOf(entry);
      if (i >= 0) chatWaiters.splice(i, 1);
      resolve(false);
    }, waitMs);
  });
}

async function handleChat(body, res) {
  const providerId = body.provider || 'deepseek';
  const prompt = body.prompt || '';
  const stream = !!body.stream;
  const timeoutSec = body.timeoutSec || CHAT_TIMEOUT_SEC;
  const traceId = body.traceId || String(Date.now());
  const queueWaitMs = Number.isFinite(body.queueWaitMs) ? body.queueWaitMs : 90000;

  if (!prompt) {
    return sendJson(res, 400, { error: { message: 'no message content' } });
  }
  const p = getProvider(providerId);
  if (!p) {
    return sendJson(res, 400, { error: { message: 'unknown provider' } });
  }

  const got = await acquireChatSlot(queueWaitMs);
  if (!got) {
    return sendJson(res, 429, { error: { message: 'gateway busy' } });
  }
  let session;
  try {
    session = await ensureSession(providerId);
    if (session.page.isClosed()) {
      session.page = await session.context.newPage();
      await session.page.goto(p.homeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await bridge.configurePage(session.page, providerId);
    } else {
      await bridge.configurePage(session.page, providerId);
    }
    await session.page.bringToFront().catch(() => {});

    let st = null;
    try { st = await bridge.readState(session.page); } catch (_) {}
    const loggedIn = !!(st && st.loggedIn);
    session.loggedIn = loggedIn;
    if (!loggedIn) {
      if (stream) {
        res.writeHead(503, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'close',
          'Access-Control-Allow-Origin': '*'
        });
        res.write(JSON.stringify({ type: 'error', message: 'gateway busy' }) + '\n');
        res.end();
        return;
      }
      return sendJson(res, 503, { error: { message: 'gateway busy' }, traceId, reason: 'not_logged_in' });
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
      const result = await chat(session.page, providerId, prompt, { timeoutSec, onChunk });
      try {
        res.write(JSON.stringify({ type: 'done', thinking: result.thinking, answer: result.answer, traceId }) + '\n');
      } catch (_) {}
      res.end();
    } else {
      const result = await chat(session.page, providerId, prompt, { timeoutSec });
      try { await session.context.storageState({ path: profilePath(providerId) }); } catch (_) {}
      if (!result.answer && !result.thinking) {
        return sendJson(res, 503, { error: { message: 'gateway busy' }, traceId });
      }
      sendJson(res, 200, { thinking: result.thinking, answer: result.answer, provider: providerId, model: p.model, traceId });
    }
  } catch (e) {
    if (!res.headersSent) {
      sendJson(res, 500, { error: { message: String(e.message || e) }, traceId });
    } else {
      try { res.write(JSON.stringify({ type: 'error', message: String(e.message || e) }) + '\n'); } catch (_) {}
      res.end();
    }
  } finally {
    releaseChatSlot();
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
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Content-Length': '0'
      });
      return res.end();
    }

    if (route === '/health') {
      return sendJson(res, 200, { ok: true, sidecar: true, port: PORT, sessions: sessions.size });
    }

    if (route === '/login' && req.method === 'POST') {
      const body = await readBody(req);
      const providerId = body.provider || 'deepseek';
      const r = await openLoginWindow(providerId);
      return sendJson(res, 200, r);
    }

    if (route === '/login/status' && req.method === 'GET') {
      const providerId = u.searchParams.get('provider');
      if (providerId) {
        return sendJson(res, 200, await getStatus(providerId));
      }
      const all = {};
      for (const id of Object.keys(PROVIDERS)) all[id] = await getStatus(id);
      return sendJson(res, 200, all);
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
  console.log(`[sidecar] profiles: ${PROFILE_DIR}`);
});

async function shutdown() {
  try {
    for (const s of sessions.values()) {
      if (s._pollTimer) clearInterval(s._pollTimer);
      try { await s.context?.close(); } catch (_) {}
    }
    if (browser) await browser.close();
  } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
