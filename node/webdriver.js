'use strict';

const bridge = require('./bridge');
const { getProvider } = require('./providers');

const POLL_INTERVAL_MS = 400;
const READY_POLL_INTERVAL_MS = 500;
const PAGE_READY_TIMEOUT_SEC = 60;
const IDLE_TIMEOUT_SEC = 15;
const IDLE_POLL_INTERVAL_MS = 500;
const IDLE_STABLE_POLLS = 2;
const POST_MODE_DELAY_MS = 800;
const FRESH_CHAT_DELAY_MS = 600;
const PROVIDER_MIN_HYDRATION_MS = 5000;
const SESSION_STABLE_POLLS = 8;

class RewriteTolerantStream {
  constructor() {
    this.buffer = '';
    this.last = '';
    this.emitted = 0;
    this.rewriteConflicts = 0;
  }
  observe(full) {
    if (full === this.last) return null;
    if (full.startsWith(this.last)) {
      const chunk = full.slice(this.last.length);
      this.last = full;
      if (chunk) this.emitted += chunk.length;
      return chunk || null;
    }
    this.rewriteConflicts += 1;
    let i = 0;
    const min = Math.min(full.length, this.last.length);
    while (i < min && full[i] === this.last[i]) i++;
    this.last = full;
    const chunk = full.slice(i);
    if (chunk) this.emitted += chunk.length;
    return chunk || null;
  }
  flush() {
    return null;
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

async function chat(page, providerId, prompt, opts = {}) {
  const provider = getProvider(providerId);
  if (!provider) return { thinking: '', answer: '' };
  const timeoutSec = opts.timeoutSec || 120;
  const onChunk = opts.onChunk || null;
  const shouldCancel = opts.shouldCancel || (() => false);

  const ready = await waitUntilReady(page, provider, shouldCancel);
  if (!ready || shouldCancel()) return { thinking: '', answer: '' };

  const st0 = await bridge.readState(page);
  const generating0 = st0 ? st0.generating : false;
  if (providerId === 'deepseek' || generating0) {
    const idle = await waitUntilIdle(page, shouldCancel);
    if (provider.freshChatPerApiRequest && !idle) return { thinking: '', answer: '' };
  }
  if (shouldCancel()) return { thinking: '', answer: '' };

  if (provider.freshChatPerApiRequest) {
    const ok = await bridge.freshChat(page);
    await bridge.sleep(FRESH_CHAT_DELAY_MS);
    if (!ok) return { thinking: '', answer: '' };
    const st = await bridge.readState(page);
    if (!st || !st.composerReady || st.generating) return { thinking: '', answer: '' };
  }

  if (providerId === 'deepseek') {
    await bridge.ensureModes(page);
    await bridge.sleep(POST_MODE_DELAY_MS);
  }

  const base = await bridge.readState(page);
  const baseAnswer = base ? base.answer : '';
  const baseThinking = base ? base.thinking : '';
  if (shouldCancel()) return { thinking: '', answer: '' };

  const sendResult = await bridge.sendPrompt(page, prompt);
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
  let stableCount = 0;
  let prevAnswer = '';
  let thinkingDirty = false;
  let sawAnswer = false;

  while (Date.now() < deadline) {
    if (shouldCancel()) break;
    await bridge.sleep(POLL_INTERVAL_MS);
    const st = await bridge.readState(page);
    if (!st) continue;

    if (st.thinking && st.thinking !== baseThinking) {
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

      if (!st.generating && st.answer === prevAnswer) {
        stableCount += 1;
        if (stableCount >= provider.completionStablePolls) break;
      } else {
        stableCount = 0;
      }
      prevAnswer = st.answer;
    } else if (sawAnswer && !st.generating) {
      if (st.answer === prevAnswer) {
        stableCount += 1;
        if (stableCount >= provider.completionStablePolls) break;
      }
    } else {
      stableCount = 0;
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

  if (provider.freshChatPerApiRequest) {
    try {
      await bridge.freshChat(page);
      await bridge.sleep(FRESH_CHAT_DELAY_MS);
    } catch (_) {}
  }

  return { thinking, answer };
}

module.exports = { chat, waitUntilReady, waitUntilIdle, RewriteTolerantStream };
