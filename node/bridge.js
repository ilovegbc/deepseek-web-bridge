'use strict';

const PROVIDERS = require('./providers');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const BRIDGE_SCRIPT = `
((since) => {
  const cfg = window.__aiGatewayConfig;
  if (!cfg) return null;

  function visible(el) {
    if (!el || !el.isConnected || el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden';
  }

  function any(sel) {
    if (!sel) return false;
    for (const el of document.querySelectorAll(sel)) if (visible(el)) return true;
    return false;
  }

  function lastNode(sel, excludeSel) {
    if (!sel) return null;
    let last = null;
    for (const el of document.querySelectorAll(sel)) {
      if (!visible(el)) continue;
      if (excludeSel && el.closest(excludeSel)) continue;
      last = el;
    }
    return last;
  }

  const cache = window.__aiGatewayCache || (window.__aiGatewayCache = {});
  function cachedText(node, key) {
    if (!node) { cache[key] = null; return ''; }
    const tcLen = (node.textContent || '').length;
    const c = cache[key];
    if (c && c.node === node && c.tcLen === tcLen) return c.text;
    const text = (node.innerText || '').trim();
    cache[key] = { node, tcLen, text };
    return text;
  }

  // React fiber 上的 markdown 属性 = 渲染前的原始 markdown 源码
  // （表格/加粗/列表等语法完整；innerText 只是渲染后的纯文本）
  function fiberMarkdown(node) {
    try {
      let key = null;
      for (const k of Object.keys(node)) {
        if (k.indexOf('__reactFiber$') === 0) { key = k; break; }
      }
      if (!key) return null;
      let f = node[key];
      let d = 0;
      while (f && d < 40) {
        const mp = f.memoizedProps;
        if (mp && typeof mp.markdown === 'string') return mp.markdown;
        f = f.return;
        d++;
      }
    } catch (_) {}
    return null;
  }

  // 引用占位 [reference:N] 直接剥掉（API 不输出引用链接）
  function substRefs(md) {
    if (!md || md.indexOf('[reference:') < 0) return md;
    return md.replace(/\[reference:\d+\]/g, '');
  }

  function answerText(node) {
    if (!node) return '';
    const fm = fiberMarkdown(node);
    const raw = (fm != null) ? fm : (node.innerText || '').trim();
    return substRefs(raw);
  }

  function loggedIn() {
    try {
      switch (cfg.loginStrategy) {
        case 'deepseek_storage': {
          if (location.pathname.includes('sign_in')) return false;
          const stored = localStorage.getItem('userToken');
          if (!stored) return false;
          let token = '';
          try {
            const p = JSON.parse(stored);
            token = p && p.value ? String(p.value) : '';
          } catch (_) { token = String(stored); }
          return token.length > 4;
        }
        case 'ready_selector':
          return any(cfg.readySelector);
        default:
          return false;
      }
    } catch (_) { return false; }
  }

  const s = cfg.selectors;
  const answer = answerText(lastNode(s.answer, s.thinking));
  const thinking = cachedText(lastNode(s.thinking, null), 'thinking');

  // since 携带调用方已累积的长度；与页面基准长度一致时只回增量（answer/thinking=null），
  // 否则（首次/失步/回退）回全文并重置基准，调用方以全文重同步
  let answerOut = answer, thinkingOut = thinking;
  let answerDelta = null, thinkingDelta = null;
  if (since && typeof since.answer === 'number') {
    const last = window.__aiGatewayDelta;
    if (last && last.answerLen === since.answer && answer.startsWith(last.answer)) {
      answerDelta = answer.slice(last.answerLen);
      answerOut = null;
    }
    if (last && last.thinkingLen === since.thinking && thinking.startsWith(last.thinking)) {
      thinkingDelta = thinking.slice(last.thinkingLen);
      thinkingOut = null;
    }
    window.__aiGatewayDelta = {
      answer, answerLen: answer.length,
      thinking, thinkingLen: thinking.length
    };
  }

  return {
    composerReady: any(s.composer),
    documentComplete: document.readyState === 'complete',
    providerReady: !cfg.readySelector || any(cfg.readySelector),
    sessionCount: s.sessionLink ? document.querySelectorAll(s.sessionLink).length : 0,
    answer: answerOut,
    answerDelta,
    thinking: thinkingOut,
    thinkingDelta,
    generating: any(s.generating),
    loggedIn: loggedIn()
  };
})(%s)
`;

const SEND_SCRIPT = `
((text, images) => {
  const cfg = window.__aiGatewayConfig;
  if (!cfg) return 'no_config';
  const composer = document.querySelector(cfg.selectors.composer);
  if (!composer) return 'no_composer';

  function visible(el) {
    if (!el || !el.isConnected || el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden';
  }

  function submitContentEditable(editor, value) {
    editor.focus();
    editor.innerHTML = '';
    const p = document.createElement('p');
    p.textContent = value;
    editor.appendChild(p);
    try {
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    } catch (_) {
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }
    let tries = 0;
    const submit = () => {
      const btn = document.querySelector(cfg.selectors.sendButton);
      if (btn && !btn.disabled) { btn.click(); return; }
      tries += 1;
      if (tries < 50) setTimeout(submit, 50);
      else editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    };
    submit();
  }

  function submitTextarea(ta, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, value);
    ta.focus();
    try {
      ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    } catch (_) {
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (cfg.selectors.submitWithEnter) {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      return;
    }
    let tries = 0;
    const submit = () => {
      const btn = document.querySelector(cfg.selectors.sendButton);
      if (btn && !btn.disabled) { btn.click(); return; }
      tries += 1;
      if (tries < 50) setTimeout(submit, 100);
      else ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    };
    setTimeout(submit, 100);
  }

  async function attachImages(list) {
    if (!list || !list.length) return 'none';
    let input = null;
    for (const el of document.querySelectorAll('input[type="file"]')) {
      const acc = el.getAttribute('accept') || '';
      if (acc.includes('image')) { input = el; break; }
      if (!input) input = el;
    }
    if (!input) return 'no_input';
    const dt = new DataTransfer();
    for (const img of list) {
      try {
        const res = await fetch(img.url);
        const blob = await res.blob();
        let ext = (blob.type.split('/')[1] || 'png').split('+')[0];
        if (ext === 'jpeg') ext = 'jpg';
        dt.items.add(new File([blob], 'image.' + ext, { type: blob.type || 'image/png' }));
      } catch (_) {}
    }
    if (!dt.items.length) return 'fetch_failed';
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const started = Date.now();
    const deadline = started + 20000;
    for (;;) {
      const previews = Array.from(document.querySelectorAll('img')).filter(el => {
        const src = el.currentSrc || el.src || '';
        if (src.indexOf('blob:') !== 0 && src.indexOf('data:') !== 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 16 && r.height > 16 && r.top > window.innerHeight * 0.3;
      });
      if (previews.length > 0) { await new Promise(r => setTimeout(r, 400)); return 'ok'; }
      const n = input.files ? input.files.length : 0;
      if (n === 0 && Date.now() - started > 1500) return 'ok';
      if (Date.now() >= deadline) return 'timeout';
      await new Promise(r => setTimeout(r, 250));
    }
  }

  return (async () => {
    const attached = await attachImages(images);
    if (cfg.selectors.contentEditableComposer) submitContentEditable(composer, text);
    else submitTextarea(composer, text);
    return 'ok;attach=' + attached;
  })();
})((%j), (%k))
`;

const ENSURE_MODES_SCRIPT = `
(() => {
  const cfg = window.__aiGatewayConfig;
  if (!cfg || !cfg.selectors.toggleButtons) return 'unsupported';
  const buttons = Array.from(document.querySelectorAll(cfg.selectors.toggleButtons));
  let on = 0, off = 0;
  const info = [];
  for (const b of buttons) {
    const cls = typeof b.className === 'string' ? b.className : '';
    const label = ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '') + ' ' + (b.getAttribute('title') || '')).trim().replace(/\\s+/g, '');
    const enabled = b.getAttribute('aria-pressed') === 'true' ||
      b.getAttribute('aria-checked') === 'true' || cls.includes('--selected');
    const isSearch = /联网|搜索|search/i.test(label);
    info.push((isSearch ? 'S' : 'o') + '=' + label.slice(0, 12) + ':' + (enabled ? 1 : 0));
    if (isSearch) {
      if (enabled) { b.click(); off += 1; }
    } else if (!enabled) {
      b.click();
      on += 1;
    }
  }
  return 'on:' + on + ' off:' + off + ' [' + info.join(' | ') + ']';
})()
`;

const FRESH_CHAT_SCRIPT = `
(() => {
  const cfg = window.__aiGatewayConfig;
  if (!cfg) return false;

  function visible(el) {
    if (!el || !el.isConnected || el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden';
  }

  function clickable(el) {
    for (let i = 0; i < 6 && el; i++) {
      if (visible(el)) {
        const s = getComputedStyle(el);
        const tag = el.tagName;
        if (s.cursor === 'pointer' || tag === 'BUTTON' || tag === 'A' || el.getAttribute('role') === 'button') {
          el.click();
          return true;
        }
      }
      el = el.parentElement;
    }
    return false;
  }

  const sel = cfg.selectors.newChatButton;
  const text = (cfg.selectors.newChatText || '').trim();

  if (sel) {
    let hit = false;
    for (const b of document.querySelectorAll(sel)) {
      if (visible(b)) { b.click(); return true; }
      hit = true;
    }
    if (!hit && !text) return true;
  }

  if (text) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      const t = (n.textContent || '').trim();
      if (!t || (t !== text && !t.includes(text))) continue;
      if (clickable(n.parentElement)) return true;
    }
    return false;
  }

  return true;
})()
`;

async function configurePage(page, providerId) {
  const p = PROVIDERS.getProvider(providerId);
  if (!p) throw new Error('unknown_provider:' + providerId);
  const cfg = {
    provider: p.id,
    readySelector: p.readySelector,
    loginStrategy: p.loginStrategy,
    sessionPattern: p.sessionPattern,
    selectors: p.selectors
  };
  await page.evaluate(c => { window.__aiGatewayConfig = c; }, cfg);
}

async function readState(page, since) {
  const script = BRIDGE_SCRIPT.replace('%s', () => JSON.stringify(since || null));
  return await page.evaluate(script);
}

async function sendPrompt(page, text, images) {
  const script = SEND_SCRIPT.replace('%j', () => JSON.stringify(text)).replace('%k', () => JSON.stringify(images || []));
  return await page.evaluate(script);
}

async function ensureModes(page) {
  return await page.evaluate(ENSURE_MODES_SCRIPT);
}

async function freshChat(page) {
  return await page.evaluate(FRESH_CHAT_SCRIPT);
}

const DUMP_SCRIPT = `
(() => {
  const nodes = Array.from(document.querySelectorAll('.ds-markdown')).filter(el => {
    const r = el.getBoundingClientRect();
    return el.isConnected && r.width > 0 && (el.innerText || '').length > 0;
  });
  const last = nodes[nodes.length - 1];
  if (!last) return { found: false, allCount: nodes.length };

  const out = { found: true, count: nodes.length };
  out.html = (last.outerHTML || '').slice(0, 2500);
  out.text = (last.innerText || '').slice(0, 1200);

  // React fiber：向上找带字符串型内容的 props
  const fibers = [];
  let rootKey = null;
  for (const k of Object.keys(last)) {
    if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactProps$') === 0) rootKey = rootKey || k;
  }
  if (rootKey) {
    let f = last[rootKey];
    let depth = 0;
    while (f && depth < 40 && fibers.length < 6) {
      const mp = f.memoizedProps;
      if (mp) {
        const entry = { keys: Object.keys(mp), samples: [] };
        for (const k of Object.keys(mp)) {
          const v = mp[k];
          if (typeof v === 'string' && v.length > 20) entry.samples.push(k + '=' + v.slice(0, 400));
          else if (k === 'ast') { try { entry.ast = JSON.stringify(v).slice(0, 2500); } catch (_) {} }
          else if (v && typeof v === 'object' && k !== 'children') {
            try {
              const j = JSON.stringify(v);
              if (j && j.length > 40 && j.length < 3000) entry.samples.push(k + '=>' + j.slice(0, 600));
            } catch (_) {}
          }
        }
        fibers.push(entry);
      }
      f = f.return;
      depth++;
    }
  }
  out.fibers = fibers;

  // 思考区节点的 fiber markdown
  const thinks = Array.from(document.querySelectorAll('.ds-think-content')).filter(el => el.isConnected && el.getBoundingClientRect().width > 0);
  const lastThink = thinks[thinks.length - 1];
  if (lastThink) {
    let tk = null;
    for (const k of Object.keys(lastThink)) { if (k.indexOf('__reactFiber$') === 0) { tk = k; break; } }
    if (tk) {
      let f = lastThink[tk], d = 0;
      while (f && d < 40) {
        const mp = f.memoizedProps;
        if (mp && typeof mp.markdown === 'string') { out.thinkMarkdown = mp.markdown.slice(0, 600); break; }
        f = f.return; d++;
      }
    }
    if (!out.thinkMarkdown) out.thinkText = (lastThink.innerText || '').slice(0, 300);
  }

  // 页面上所有复制类按钮
  out.copyButtons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(b => {
    const a = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-testid') || '') + ' ' + String(b.textContent || '');
    return /复制|copy/i.test(a);
  }).slice(0, 8).map(b => ({
    aria: b.getAttribute('aria-label') || '',
    testid: b.getAttribute('data-testid') || '',
    text: String(b.textContent || '').slice(0, 30),
    html: (b.outerHTML || '').replace(/\s+/g, ' ').slice(0, 180)
  }));

  // 消息行内的按钮（含复制按钮）
  const row = last.closest('[class*="message"], [class*="msg"], [data-testid*="message"]') || last.parentElement;
  if (row) {
    out.rowClass = row.className ? String(row.className).slice(0, 200) : '';
    out.buttons = Array.from(row.querySelectorAll('button, [role="button"]')).slice(0, 12).map(b => ({
      aria: b.getAttribute('aria-label') || '',
      cls: (b.className && b.className.baseVal !== undefined ? b.className.baseVal : String(b.className || '')).slice(0, 120),
      testid: b.getAttribute('data-testid') || '',
      html: (b.outerHTML || '').replace(/\\s+/g, ' ').slice(0, 200)
    }));
  }
  return out;
})()
`;

async function debugStop(page) {
  return await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('button, [role="button"]').forEach(el => {
      const r = el.getBoundingClientRect();
      const vis = el.isConnected && !el.hidden && r.width > 0 && r.height > 0;
      if (!vis) return;
      const svg = el.querySelector('svg');
      const icon = svg ? (svg.innerHTML || '').replace(/\s+/g, ' ').slice(0, 120) : '';
      out.push({
        aria: el.getAttribute('aria-label') || '',
        testid: el.getAttribute('data-testid') || '',
        title: el.getAttribute('title') || '',
        text: (el.textContent || '').trim().slice(0, 40),
        cls: (typeof el.className === 'string' ? el.className : '').replace(/\s+/g, ' ').slice(0, 120),
        hasRect: !!(svg && svg.querySelector('rect')),
        hasPath: !!(svg && svg.querySelector('path')),
        icon
      });
    });
    return out.slice(0, 20);
  });
}

async function debugDump(page) {
  return await page.evaluate(DUMP_SCRIPT);
}

module.exports = {
  configurePage,
  readState,
  sendPrompt,
  ensureModes,
  freshChat,
  debugStop,
  debugDump,
  sleep
};
