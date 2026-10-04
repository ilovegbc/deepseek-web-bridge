'use strict';

const bridge = require('./bridge');
const { getProvider } = require('./providers');

const POLL_INTERVAL_MS = 200;
const READY_POLL_INTERVAL_MS = 500;
const PAGE_READY_TIMEOUT_SEC = 60;
const IDLE_TIMEOUT_SEC = 15;
const IDLE_POLL_INTERVAL_MS = 200;
const IDLE_STABLE_POLLS = 2;
const POST_MODE_DELAY_MS = 800;
const FRESH_READY_TIMEOUT_MS = 1500;
const READY_POLL_FAST_MS = 50;
const PROVIDER_MIN_HYDRATION_MS = 5000;
const SESSION_STABLE_POLLS = 8;

// 页面已确认干净（刚 freshChat 过且 composer 就绪）时，跳过 waitUntilIdle / freshChat
const knownClean = new WeakSet();

class RewriteTolerantStream {
  constructor(opts = {}) {
    this.buffer = '';
    this.last = '';        // 页面最新全文
    this.emittedBuf = '';  // 已发给客户端、且保证是 last 前缀的文本
    this.emitted = 0;
    this.rewriteConflicts = 0;
    this.holdTail = opts.holdTail === undefined ? 300 : opts.holdTail; // 默认扣住尾部 300 字符
  }
  safeBoundary(full) {
    // 段落边界（最后一个空行）之后视为"未稳定区"；另外至少扣住尾部 holdTail 字符
    const byBlank = full.lastIndexOf('\n\n');
    let b = byBlank >= 0 ? byBlank + 2 : 0;
    if (b < full.length - this.holdTail) b = full.length - this.holdTail;
    if (b > 0 && b < full.length) {
      const c = full.charCodeAt(b - 1);
      if (c >= 0xD800 && c <= 0xDBFF) b += 1; // 不拆代理对
    }
    return Math.max(0, Math.min(b, full.length));
  }
  observe(full) {
    if (full === this.last) return null;
    this.last = full;
    // 已发出的前缀被页面改写：无法安全追加，暂不输出（收尾时再对齐）
    if (!full.startsWith(this.emittedBuf)) {
      this.rewriteConflicts += 1;
      return null;
    }
    const safe = this.safeBoundary(full);
    if (safe <= this.emittedBuf.length) return null;
    const chunk = full.slice(this.emittedBuf.length, safe);
    this.emittedBuf = full.slice(0, safe);
    if (chunk) this.emitted += chunk.length;
    return chunk || null;
  }
  flush() {
    if (this.last.length > this.emittedBuf.length && this.last.startsWith(this.emittedBuf)) {
      const chunk = this.last.slice(this.emittedBuf.length);
      this.emittedBuf = this.last;
      this.emitted += chunk.length;
      return chunk || null;
    }
    if (this.last === this.emittedBuf) return null;
    // 已发部分与最终不一致（中途重写）：从最长公共前缀补发，保证客户端拿到完整文本
    let i = 0;
    const m = Math.min(this.emittedBuf.length, this.last.length);
    while (i < m && this.emittedBuf[i] === this.last[i]) i++;
    const chunk = this.last.slice(i);
    this.emittedBuf = this.last;
    if (chunk) this.emitted += chunk.length;
    return chunk || null;
  }
  getRewriteConflicts() { return this.rewriteConflicts; }
}

async function waitUntilReady(page, provider, shouldCancel) {
  const start = Date.now();
  const deadline = start + PAGE_READY_TIMEOUT_SEC * 1000;
  let lastSession = -1;
  let stable = 0;

  while (Date.now() < deadline) {
    if (shouldCancel && shouldCancel()) return false;
    const st = await bridge.readState(page);
    if (!st) { await bridge.sleep(READY_POLL_INTERVAL_MS); continue; }
    const ready = st.composerReady && (!provider.desktopMode || (st.documentComplete && st.providerReady));
    if (ready) {
      if (st.sessionCount === lastSession) stable += 1;
      else stable = 0;
      lastSession = st.sessionCount;
      const elapsed = Date.now() - start;
      if (!provider.desktopMode || (elapsed >= PROVIDER_MIN_HYDRATION_MS && stable >= SESSION_STABLE_POLLS)) {
        return true;
      }
    } else {
      stable = 0;
      lastSession = -1;
    }
    await bridge.sleep(READY_POLL_INTERVAL_MS);
  }
  return false;
}

async function waitUntilIdle(page, shouldCancel) {
  const deadline = Date.now() + IDLE_TIMEOUT_SEC * 1000;
  let prev = '';
  let stable = 0;
  while (Date.now() < deadline) {
    if (shouldCancel && shouldCancel()) return false;
    const st = await bridge.readState(page);
    if (!st) break;
    if (!st.composerReady || st.generating) break;
    if (st.answer === prev) {
      stable += 1;
      if (stable >= IDLE_STABLE_POLLS) return true;
    } else {
      stable = 0;
    }
    prev = st.answer;
    await bridge.sleep(IDLE_POLL_INTERVAL_MS);
  }
  return false;
}

async function waitFreshReady(page) {
  const deadline = Date.now() + FRESH_READY_TIMEOUT_MS;
  for (;;) {
    const st = await bridge.readState(page);
    if (st && st.composerReady && !st.generating) return true;
    if (Date.now() >= deadline) return false;
    await bridge.sleep(READY_POLL_FAST_MS);
  }
}

async function chat(page, providerId, prompt, opts = {}) {
  const provider = getProvider(providerId);
  if (!provider) return { thinking: '', answer: '' };
  const timeoutSec = opts.timeoutSec || 120;
  const onChunk = opts.onChunk || null;
  const shouldCancel = opts.shouldCancel || (() => false);
  const images = Array.isArray(opts.images) ? opts.images : [];

  const t0 = Date.now();
  const ready = await waitUntilReady(page, provider, shouldCancel);
  const tReady = Date.now();
  if (!ready || shouldCancel()) return { thinking: '', answer: '' };

  const clean = knownClean.has(page);
  const st0 = await bridge.readState(page);
  const generating0 = st0 ? st0.generating : false;
  const reallyClean = clean && !!st0 && !generating0 && st0.composerReady && !st0.answer;
  if (providerId === 'deepseek' || generating0) {
    // 页面刚 freshChat 过且确认干净 → 跳过 ~1s 的 idle 等待
    if (!reallyClean) {
      const idle = await waitUntilIdle(page, shouldCancel);
      if (provider.freshChatPerApiRequest && !idle) return { thinking: '', answer: '' };
    }
  }
  if (shouldCancel()) return { thinking: '', answer: '' };

  if (provider.freshChatPerApiRequest) {
    if (!reallyClean) {
      const ok = await bridge.freshChat(page);
      if (!ok) return { thinking: '', answer: '' };
      if (!(await waitFreshReady(page))) return { thinking: '', answer: '' };
    }
    knownClean.delete(page);
  }
  const tFresh = Date.now();

  if (providerId === 'deepseek') {
    const modes = String(await bridge.ensureModes(page) || '');
    // 只有真的点了 toggle 才需要等界面稳定
    const m = /on:(\d+) off:(\d+)/.exec(modes);
    const changed = m && (parseInt(m[1], 10) > 0 || parseInt(m[2], 10) > 0);
    if (changed) await bridge.sleep(POST_MODE_DELAY_MS);
    if (changed || process.env.MODES_LOG === '1') console.log('[modes] ' + modes);
  }

  const base = await bridge.readState(page);
  const baseAnswer = base ? base.answer : '';
  const baseThinking = base ? base.thinking : '';
  if (shouldCancel()) return { thinking: '', answer: '' };

  const sendResult = await bridge.sendPrompt(page, prompt, images);
  const tSend = Date.now();
  if (images.length) {
    const msg = '[images] attach=' + String(sendResult) + ' count=' + images.length;
    console.log(msg);
    try { require('fs').appendFileSync(require('path').join(__dirname, 'images.log'), new Date().toISOString() + ' ' + msg + '\n'); } catch (_) {}
  }
  if (!sendResult || !String(sendResult).includes('ok')) {
    return { thinking: '', answer: '' };
  }

  const deadline = Date.now() + timeoutSec * 1000;
  const answerStream = new RewriteTolerantStream();
  const thinkingStream = new RewriteTolerantStream();
  let thinking = baseThinking;
  let answer = baseAnswer;
  let latestAnswer = '';
  let firstAnswerLogged = false;
  let firstContentAt = 0;
  let firstGeneratingAt = 0;
  let debugDumped = false;
  let stableCount = 0;
  let prevAnswer = '';
  let finishGraceAt = 0;
  let lastChangeAt = Date.now();
  let thinkingDirty = false;
  let sawAnswer = false;
  const graceMs = provider.completionGraceMs || 0;
  const stallFailsafeMs = 90000; // 停止信号常亮但文本 90s 无变化：按卡死处理

  while (Date.now() < deadline) {
    if (shouldCancel()) break;
    await bridge.sleep(POLL_INTERVAL_MS);
    const st = await bridge.readState(page, { answer: answer.length, thinking: thinking.length });
    if (!st) continue;
    if (st.generating && !firstGeneratingAt) firstGeneratingAt = Date.now();
    // 增量模式：answer/thinking 为 null 表示只回了新增片段
    if (st.answer === null) {
      answer += st.answerDelta || '';
      st.answer = answer;
    } else {
      answer = st.answer;
    }
    if (st.thinking === null) {
      thinking += st.thinkingDelta || '';
      st.thinking = thinking;
    } else {
      thinking = st.thinking;
    }

    if (st.thinking && st.thinking !== baseThinking) {
      if (!firstContentAt) firstContentAt = Date.now();
      if (!firstGeneratingAt && !debugDumped) {
        debugDumped = true;
        try { console.log('[debug] stop-buttons=' + JSON.stringify(await bridge.debugStop(page))); } catch (_) {}
      }
      if (onChunk && !thinkingDirty) {
        const flushed = thinkingStream.flush();
        if (flushed) await onChunk('thinking', flushed);
        thinkingDirty = true;
      }
      if (onChunk) {
        const piece = thinkingStream.observe(st.thinking);
        if (piece) await onChunk('thinking', piece);
      } else {
        thinkingStream.observe(st.thinking);
      }
      thinking = st.thinking;
    }

    if (st.answer && st.answer !== baseAnswer) {
      if (!firstContentAt) firstContentAt = Date.now();
      if (!firstGeneratingAt && !debugDumped) {
        debugDumped = true;
        try { console.log('[debug] stop-buttons=' + JSON.stringify(await bridge.debugStop(page))); } catch (_) {}
      }
      sawAnswer = true;
      if (onChunk) {
        if (!thinkingDirty) {
          const flushed = thinkingStream.flush();
          if (flushed) await onChunk('thinking', flushed);
          thinkingDirty = true;
        }
        const piece = answerStream.observe(st.answer);
        if (piece) await onChunk('answer', piece);
      } else {
        answerStream.observe(st.answer);
      }
      if (!firstAnswerLogged) firstAnswerLogged = true;
      latestAnswer = st.answer;
      answer = st.answer;

      if (st.answer !== prevAnswer) lastChangeAt = Date.now();
      const stalled = Date.now() - lastChangeAt > stallFailsafeMs;
      if (!st.generating && (!st.stopVisible || stalled) && st.answer === prevAnswer) {
        stableCount += 1;
        if (stableCount >= provider.completionStablePolls) {
          if (!finishGraceAt) finishGraceAt = Date.now();
          if (Date.now() - finishGraceAt >= graceMs) break;
        }
      } else {
        stableCount = 0;
        finishGraceAt = 0;
      }
      prevAnswer = st.answer;
    } else if (sawAnswer && !st.generating && !st.stopVisible) {
      if (st.answer === prevAnswer) {
        stableCount += 1;
        if (stableCount >= provider.completionStablePolls) {
          if (!finishGraceAt) finishGraceAt = Date.now();
          if (Date.now() - finishGraceAt >= graceMs) break;
        }
      }
    } else {
      stableCount = 0;
      finishGraceAt = 0;
      if (st.answer) prevAnswer = st.answer;
    }
  }

  if (onChunk) {
    if (!thinkingDirty) {
      const flushed = thinkingStream.flush();
      if (flushed) await onChunk('thinking', flushed);
    }
    const flushedA = answerStream.flush();
    if (flushedA) await onChunk('answer', flushedA);
  }

  if (provider.freshChatPerApiRequest && !opts.keep) {
    try {
      const ok = await bridge.freshChat(page);
      if (ok) {
        if (await waitFreshReady(page)) knownClean.add(page);
        else knownClean.delete(page);
      } else {
        knownClean.delete(page);
      }
    } catch (_) {
      knownClean.delete(page);
    }
  }

  const tEnd = Date.now();
  console.log(`[perf] ready=${tReady - t0}ms fresh=${tFresh - tReady}ms send=${tSend - tFresh}ms gen=${firstGeneratingAt ? firstGeneratingAt - tSend : -1}ms first=${firstContentAt ? firstContentAt - tSend : -1}ms tail=${tEnd - (firstContentAt || tSend)}ms total=${tEnd - t0}ms clean=${clean ? 1 : 0}${reallyClean ? '+skip' : ''} rw=${answerStream.getRewriteConflicts()}`);

  // 缺字漏字自查：长段英文字母里 c/d/e/f/n/r 占比异常低 => 文本曾被"删字母"腐蚀，落盘取证
  try {
    const runs = String(answer || '').match(/[A-Za-z .,;:'"()\[\]{}\-_/\\|@#$%^&*+=<>?!~`0-9]{300,}/g) || [];
    for (const run of runs) {
      const letters = run.replace(/[^A-Za-z]/g, '');
      if (letters.length < 200) continue;
      const bad = (letters.match(/[cdefnr]/g) || []).length;
      const ratio = bad / letters.length;
      if (ratio < 0.05) {
        const fs = require('fs');
        const path = require('path');
        fs.appendFileSync(path.join(__dirname, 'corruption.log'),
          new Date().toISOString() + ' SUSPECT ratio=' + ratio.toFixed(4) + ' letters=' + letters.length + ' snippet=' + JSON.stringify(letters.slice(0, 160)) + '\n');
      }
    }
  } catch (_) {}

  return { thinking, answer };
}

module.exports = { chat, waitUntilReady, waitUntilIdle, RewriteTolerantStream };
