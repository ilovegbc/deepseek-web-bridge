'use strict';

const PROVIDERS = require('./providers');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const BRIDGE_SCRIPT = `
(() => {
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

  function lastText(sel, excludeSel) {
    if (!sel) return '';
    const nodes = document.querySelectorAll(sel);
    for (let i = nodes.length - 1; i >= 0; i--) {
      const el = nodes[i];
      if (!visible(el)) continue;
      if (excludeSel && el.closest(excludeSel)) continue;
      const t = (el.innerText || '').trim();
      if (t) return t;
    }
    return '';
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
  return {
    composerReady: any(s.composer),
    documentComplete: document.readyState === 'complete',
    providerReady: !cfg.readySelector || any(cfg.readySelector),
    sessionCount: s.sessionLink ? document.querySelectorAll(s.sessionLink).length : 0,
    answer: lastText(s.answer, s.thinking),
    thinking: lastText(s.thinking, null),
    generating: any(s.generating),
    loggedIn: loggedIn()
  };
})()
`;

const SEND_SCRIPT = `
((text) => {
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

  if (cfg.selectors.contentEditableComposer) submitContentEditable(composer, text);
  else submitTextarea(composer, text);
  return 'ok';
})((%j))
`;

const ENSURE_MODES_SCRIPT = `
(() => {
  const cfg = window.__aiGatewayConfig;
  if (!cfg || !cfg.selectors.toggleButtons) return 'unsupported';
  const buttons = document.querySelectorAll(cfg.selectors.toggleButtons);
  let toggled = 0;
  for (const b of buttons) {
    const cls = typeof b.className === 'string' ? b.className : '';
    const enabled = b.getAttribute('aria-pressed') === 'true' ||
      b.getAttribute('aria-checked') === 'true' || cls.includes('--selected');
    if (!enabled) { b.click(); toggled += 1; }
  }
  return 'toggled:' + toggled + '/' + buttons.length;
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

async function readState(page) {
  return await page.evaluate(BRIDGE_SCRIPT);
}

async function sendPrompt(page, text) {
  const script = SEND_SCRIPT.replace('%j', JSON.stringify(text));
  return await page.evaluate(script);
}

async function ensureModes(page) {
  return await page.evaluate(ENSURE_MODES_SCRIPT);
}

async function freshChat(page) {
  return await page.evaluate(FRESH_CHAT_SCRIPT);
}

module.exports = {
  configurePage,
  readState,
  sendPrompt,
  ensureModes,
  freshChat,
  sleep
};
