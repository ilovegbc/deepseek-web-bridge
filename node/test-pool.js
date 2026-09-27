'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { AccountPool } = require('./pool');

const accountsFile = path.join(__dirname, 'accounts.json');
const bak = accountsFile + '.test.bak';
let hadOriginal = false;
if (fs.existsSync(accountsFile)) {
  fs.copyFileSync(accountsFile, bak);
  hadOriginal = true;
}

function writeAccounts(obj) {
  fs.writeFileSync(accountsFile, JSON.stringify(obj, null, 2), 'utf8');
}

async function main() {
  writeAccounts({
    strategy: 'least_busy',
    accounts: [
      { id: 'a1', label: 'A1', provider: 'deepseek', enabled: true },
      { id: 'a2', label: 'A2', provider: 'deepseek', enabled: true },
      { id: 'a3', label: 'A3', provider: 'deepseek', enabled: false }
    ]
  });

  const pool = new AccountPool();
  pool.reloadConfig();

  assert.strictEqual(pool.listDefs().length, 3, 'defs count');
  assert.strictEqual(pool.listDefs().filter(a => a.enabled).length, 2, 'enabled count');

  // cold acquire: no sessions yet -> returns a slot
  const d1 = await pool.acquire('deepseek', 100);
  assert.ok(d1 && d1.id, 'cold acquire returns def');

  // simulate busy slots for a1, a2
  for (const id of ['a1', 'a2']) {
    await pool.ensureSlot({ id, label: id, provider: 'deepseek', enabled: true });
    pool.slots.get(id).loggedIn = true;
    pool.slots.get(id).page = { isClosed: () => false };
    pool.markBusy(id);
  }

  // all busy -> queue then timeout
  const t0 = Date.now();
  const timedOut = await pool.acquire('deepseek', 400);
  assert.strictEqual(timedOut, null, 'timeout returns null');
  assert.ok(Date.now() - t0 >= 350, 'waited');

  // release one -> waiter gets it
  const waiter = pool.acquire('deepseek', 5000);
  setTimeout(() => pool.markIdle('a1'), 100);
  const got = await waiter;
  assert.ok(got, 'waiter resolved');
  assert.strictEqual(got.id, 'a1', 'released account handed to waiter');

  // disabled account never picked
  pool.markIdle('a1');
  pool.markIdle('a2');
  const d2 = await pool.acquire('deepseek', 100);
  assert.ok(d2.id !== 'a3', 'disabled skipped');

  // add / remove
  const add = pool.addAccount({ id: 'a9', label: 'X', provider: 'deepseek' });
  assert.strictEqual(add.ok, true, 'add ok');
  assert.strictEqual(pool.listDefs().length, 4, 'after add');
  const addDup = pool.addAccount({ id: 'a9', label: 'X', provider: 'deepseek' });
  assert.strictEqual(addDup.ok, false, 'dup rejected');
  const bad = pool.addAccount({ id: 'bad id!', label: 'x', provider: 'deepseek' });
  assert.strictEqual(bad.ok, false, 'bad id rejected');

  pool.markBusy('a1');
  const rmBusy = await pool.removeAccount('a1');
  assert.strictEqual(rmBusy.ok, false, 'busy cannot remove');
  pool.markIdle('a1');
  const rm = await pool.removeAccount('a1');
  assert.strictEqual(rm.ok, true, 'remove idle');

  await pool.closeAll();
  console.log('pool tests: OK');
}

main()
  .catch((e) => {
    console.error('pool tests: FAIL', e);
    process.exitCode = 1;
  })
  .finally(() => {
    if (hadOriginal) fs.copyFileSync(bak, accountsFile);
    else if (fs.existsSync(accountsFile)) fs.unlinkSync(accountsFile);
    if (fs.existsSync(bak)) fs.unlinkSync(bak);
  });
