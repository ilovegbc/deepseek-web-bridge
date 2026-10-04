'use strict';

const fs = require('fs');
const path = require('path');
const { PROVIDERS, getProvider } = require('./providers');

const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const PROFILE_DIR = path.join(__dirname, 'profiles');

const DEFAULT_ACCOUNTS = {
  strategy: 'least_busy',
  accounts: [
    { id: 'acc1', label: '账号1', provider: 'deepseek', enabled: true }
  ]
};

function loadConfig() {
  if (!fs.existsSync(ACCOUNTS_FILE)) {
    try {
      fs.mkdirSync(PROFILE_DIR, { recursive: true });
      fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(DEFAULT_ACCOUNTS, null, 2), 'utf8');
    } catch (_) {}
    return JSON.parse(JSON.stringify(DEFAULT_ACCOUNTS));
  }
  try {
    const raw = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    if (!raw || !Array.isArray(raw.accounts) || raw.accounts.length === 0) {
      return JSON.parse(JSON.stringify(DEFAULT_ACCOUNTS));
    }
    return raw;
  } catch (_) {
    return JSON.parse(JSON.stringify(DEFAULT_ACCOUNTS));
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true });
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

function profilePath(accountId) {
  return path.join(PROFILE_DIR, accountId + '.json');
}

class AccountPool {
  constructor() {
    this.cfg = loadConfig();
    this.slots = new Map();
    this.waiters = [];
    this.rrIndex = 0;
  }

  reloadConfig() {
    this.cfg = loadConfig();
    for (const [id, slot] of this.slots) {
      const def = this.cfg.accounts.find(a => a.id === id);
      if (!def) {
        this._closeSlot(slot).catch(() => {});
        this.slots.delete(id);
      } else {
        slot.def = def;
      }
    }
  }

  listDefs() {
    return this.cfg.accounts.map(a => ({
      id: a.id,
      label: a.label || a.id,
      provider: a.provider || 'deepseek',
      enabled: a.enabled !== false,
      profile: fs.existsSync(profilePath(a.id))
    }));
  }

  addAccount({ id, label, provider }) {
    const aid = String(id || '').trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(aid)) return { ok: false, error: 'invalid account id' };
    if (this.cfg.accounts.some(a => a.id === aid)) return { ok: false, error: 'account exists' };
    this.cfg.accounts.push({
      id: aid,
      label: label || aid,
      provider: provider || 'deepseek',
      enabled: true
    });
    saveConfig(this.cfg);
    return { ok: true, id: aid };
  }

  async removeAccount(id) {
    const slot = this.slots.get(id);
    if (slot && slot.busy) return { ok: false, error: 'account busy' };
    this.cfg.accounts = this.cfg.accounts.filter(a => a.id !== id);
    saveConfig(this.cfg);
    if (slot) {
      await this._closeSlot(slot);
      this.slots.delete(id);
    }
    try { fs.unlinkSync(profilePath(id)); } catch (_) {}
    return { ok: true };
  }

  _candidates(provider) {
    return this.cfg.accounts.filter(a =>
      a.enabled !== false &&
      (a.provider || 'deepseek') === provider &&
      getProvider(a.provider || 'deepseek')
    );
  }

  async ensureSlot(def) {
    if (this.slots.has(def.id)) {
      const slot = this.slots.get(def.id);
      if (slot.context && slot.context.browser && !slot.context.browser().isConnected?.()) {
        await this._closeSlot(slot);
        this.slots.delete(def.id);
      } else {
        slot.def = def;
        return slot;
      }
    }
    const slot = {
      def,
      context: null,
      page: null,
      loggedIn: false,
      banned: false,
      busy: false,
      lastUsedAt: 0,
      pollTimer: null
    };
    this.slots.set(def.id, slot);
    return slot;
  }

  async _closeSlot(slot) {
    if (slot.pollTimer) {
      clearInterval(slot.pollTimer);
      slot.pollTimer = null;
    }
    try { await slot.context?.close(); } catch (_) {}
    slot.context = null;
    slot.page = null;
  }

  strategy() {
    return this.cfg.strategy || 'least_busy';
  }

  pickIdle(provider) {
    const defs = this._candidates(provider).filter(d => d.enabled !== false);
    const ready = defs
      .map(d => ({ def: d, slot: this.slots.get(d.id) }))
      .filter(x => x.slot && !x.slot.busy && !x.slot.banned && x.slot.loggedIn && x.slot.page && !x.slot.page.isClosed());

    if (ready.length === 0) return null;

    if (this.strategy() === 'round_robin') {
      this.rrIndex = (this.rrIndex + 1) % ready.length;
      return ready[this.rrIndex].def;
    }
    ready.sort((a, b) => (a.slot.lastUsedAt || 0) - (b.slot.lastUsedAt || 0));
    return ready[0].def;
  }

  pickLoggedOutOrCold(provider) {
    const defs = this._candidates(provider).filter(d => d.enabled !== false);
    return defs.find(d => {
      const s = this.slots.get(d.id);
      return (!s || !s.busy) && !(s && s.banned);
    }) || null;
  }

  markBusy(accountId) {
    const slot = this.slots.get(accountId);
    if (slot) {
      slot.busy = true;
      slot.lastUsedAt = Date.now();
    }
  }

  markIdle(accountId) {
    const slot = this.slots.get(accountId);
    if (slot) slot.busy = false;
    this._drainWaiters();
  }

  busyCount(provider) {
    let n = 0;
    for (const slot of this.slots.values()) {
      if (slot.busy && (!provider || (slot.def.provider || 'deepseek') === provider)) n++;
    }
    return n;
  }

  loggedInCount(provider) {
    let n = 0;
    for (const slot of this.slots.values()) {
      if (slot.loggedIn && !slot.banned && (!provider || (slot.def.provider || 'deepseek') === provider)) n++;
    }
    return n;
  }

  bannedCount(provider) {
    let n = 0;
    for (const slot of this.slots.values()) {
      if (slot.banned && (!provider || (slot.def.provider || 'deepseek') === provider)) n++;
    }
    return n;
  }

  poolSize(provider) {
    return this._candidates(provider).length;
  }

  acquire(provider, waitMs = 90000) {
    const idle = this.pickIdle(provider);
    if (idle) return Promise.resolve(idle);

    const hasAnyLoggedOut = this.pickLoggedOutOrCold(provider);
    if (hasAnyLoggedOut && this.loggedInCount(provider) === 0 && this.busyCount(provider) === 0) {
      return Promise.resolve(hasAnyLoggedOut);
    }

    return new Promise((resolve) => {
      let done = false;
      const entry = (def) => {
        if (done) return;
        done = true;
        if (entry._timer) clearTimeout(entry._timer);
        resolve(def);
      };
      entry._provider = provider;
      entry._timer = setTimeout(() => {
        if (done) return;
        done = true;
        const i = this.waiters.indexOf(entry);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(null);
      }, waitMs);
      this.waiters.push(entry);
    });
  }

  _drainWaiters() {
    let i = 0;
    while (i < this.waiters.length) {
      const entry = this.waiters[i];
      const provider = entry._provider || 'deepseek';
      const def = this.pickIdle(provider);
      if (!def) {
        i++;
        continue;
      }
      this.waiters.splice(i, 1);
      entry(def);
    }
  }

  snapshot() {
    const out = [];
    for (const def of this.listDefs()) {
      const slot = this.slots.get(def.id);
      out.push({
        id: def.id,
        label: def.label,
        provider: def.provider,
        enabled: def.enabled,
        running: !!(slot && slot.page && !slot.page.isClosed()),
        loggedIn: !!(slot && slot.loggedIn),
        banned: !!(slot && slot.banned),
        busy: !!(slot && slot.busy),
        profile: def.profile
      });
    }
    return out;
  }

  async closeAll() {
    for (const id of [...this.slots.keys()]) {
      const slot = this.slots.get(id);
      await this._closeSlot(slot);
      this.slots.delete(id);
    }
  }
}

module.exports = { AccountPool, profilePath, ACCOUNTS_FILE };
