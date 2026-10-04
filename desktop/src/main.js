'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

// 固定用户数据目录（设置/日志持久化位置）
try { app.setPath('userData', path.join(app.getPath('appData'), 'DeepSeek Web Bridge')); } catch (_) {}

// ---- 路径 ----------------------------------------------------------------
// 打包后: resources/gateway + resources/env/{php,node}
// 开发态: desktop/resources/gateway + desktop/build/env/{php,node}
const gwDir = () => app.isPackaged
  ? path.join(process.resourcesPath, 'gateway')
  : path.join(__dirname, '..', 'resources', 'gateway');
const phpHome = () => app.isPackaged
  ? path.join(process.resourcesPath, 'env', 'php')
  : path.join(__dirname, '..', 'build', 'env', 'php');
const nodeHome = () => app.isPackaged
  ? path.join(process.resourcesPath, 'env', 'node')
  : path.join(__dirname, '..', 'build', 'env', 'node');

// ---- 设置 ----------------------------------------------------------------
const DEFAULTS = {
  gatewayPort: 8080,
  sidecarPort: 8090,
  bindLan: 0,               // 0=127.0.0.1 1=0.0.0.0
  apiKey: 'sk-test-local-proxy-key',
  chatTimeoutSec: 120,
  phpWorkers: 8,
  phpPath: '',              // 留空 = 使用内置 PHP
  chromePath: '',           // 留空 = 使用内置 Playwright Chromium
  extraEnv: ''              // 每行 KEY=VALUE
};
let settings = { ...DEFAULTS };

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    settings = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (_) { settings = { ...DEFAULTS }; }
}
function saveSettings() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (e) { log('settings', 'save failed: ' + e.message); }
}

// ---- 日志 ----------------------------------------------------------------
const logs = [];
let win = null;
function log(tag, msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`;
  logs.push(line);
  if (logs.length > 2000) logs.splice(0, logs.length - 2000);
  if (win && !win.isDestroyed()) win.webContents.send('log', line);
}

// ---- 进程 ----------------------------------------------------------------
let gwProc = null;
let scProc = null;
let healthTimer = null;
const state = { gateway: false, sidecar: false, accounts: null, busy: null, running: false };

function killTree(pid) {
  if (!pid) return;
  try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); }
  catch (_) { try { process.kill(pid); } catch (_) {} }
}

function parseExtraEnv() {
  const out = {};
  for (const line of String(settings.extraEnv || '').split(/[\r\n]+/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i <= 0) continue;
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  }
  return out;
}

function findBundledChromium() {
  const root = path.join(gwDir(), 'browsers');
  try {
    for (const d of fs.readdirSync(root)) {
      if (/^chromium-\d+$/.test(d)) {
        for (const sub of ['chrome-win64', 'chrome-win']) {
          const p = path.join(root, d, sub, 'chrome.exe');
          if (fs.existsSync(p)) return p;
        }
      }
    }
  } catch (_) {}
  return '';
}

function buildEnv() {
  const bind = settings.bindLan ? '0.0.0.0' : '127.0.0.1';
  const env = {
    ...process.env,
    GATEWAY_PORT: String(settings.gatewayPort),
    SIDECAR_PORT: String(settings.sidecarPort),
    SIDECAR_HOST: '127.0.0.1',
    BIND_LAN: settings.bindLan ? '1' : '0',
    API_KEY: String(settings.apiKey || ''),
    CHAT_TIMEOUT_SEC: String(settings.chatTimeoutSec),
    PHP_CLI_SERVER_WORKERS: String(settings.phpWorkers),
    POOL_HEADLESS: '1',
    PLAYWRIGHT_BROWSERS_PATH: path.join(gwDir(), 'browsers'),
    ...parseExtraEnv()
  };
  if (!env.CHROME_PATH) {
    const bundled = findBundledChromium();
    if (bundled) env.CHROME_PATH = bundled;
  }
  // 显式指定 php.ini 所在目录，避免继承外部的 PHPRC 而漏加载 curl 等扩展
  env.PHPRC = path.dirname(settings.phpPath || path.join(phpHome(), 'php.exe'));
  delete env.PHP_BIN;
  delete env.NODE_BIN;
  return env;
}

function pipeLog(proc, tag) {
  const onData = (buf) => {
    for (const line of buf.toString('utf8').split(/[\r\n]+/)) {
      if (line.trim()) log(tag, line);
    }
  };
  if (proc.stdout) proc.stdout.on('data', onData);
  if (proc.stderr) proc.stderr.on('data', onData);
}

function checkRuntime() {
  const problems = [];
  const gw = gwDir();
  if (!fs.existsSync(path.join(gw, 'index.php'))) problems.push('网关源码缺失: ' + gw);
  const phpExe = settings.phpPath || path.join(phpHome(), 'php.exe');
  if (!fs.existsSync(phpExe)) problems.push('PHP 不存在: ' + phpExe);
  const nodeExe = path.join(nodeHome(), 'node.exe');
  if (!fs.existsSync(nodeExe)) problems.push('Node 不存在: ' + nodeExe);
  if (!fs.existsSync(path.join(gw, 'node', 'node_modules', 'playwright')))
    problems.push('载荷依赖缺失（请先运行 npm run prepare-payload）');
  return problems;
}

function portInUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' }, () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.setTimeout(700, () => { sock.destroy(); resolve(false); });
  });
}

async function start() {
  if (state.running) return { ok: false, error: '已经在运行' };
  if (await portInUse(settings.gatewayPort)) {
    return { ok: false, error: `网关端口 ${settings.gatewayPort} 已被占用（可能已有服务在运行）。请先停止占用方，或在设置中更换端口。` };
  }
  if (await portInUse(settings.sidecarPort)) {
    return { ok: false, error: `Sidecar 端口 ${settings.sidecarPort} 已被占用。请先停止占用方，或在设置中更换端口。` };
  }
  const problems = checkRuntime();
  if (problems.length) { problems.forEach(p => log('error', p)); return { ok: false, error: problems.join('；') }; }

  const env = buildEnv();
  const gw = gwDir();
  const phpExe = settings.phpPath || path.join(phpHome(), 'php.exe');
  const nodeExe = path.join(nodeHome(), 'node.exe');
  const bind = settings.bindLan ? '0.0.0.0' : '127.0.0.1';

  log('start', `gateway ${phpExe} -S ${bind}:${settings.gatewayPort}`);
  gwProc = spawn(phpExe, ['-S', `${bind}:${settings.gatewayPort}`, '-t', gw], { cwd: gw, env, windowsHide: true });
  pipeLog(gwProc, 'php');
  gwProc.on('exit', (code, sig) => {
    log('php', `exited code=${code} sig=${sig}`);
    gwProc = null; state.gateway = false; pushState();
  });
  gwProc.on('error', (e) => { log('php', 'spawn error: ' + e.message); gwProc = null; });

  log('start', `sidecar ${nodeExe} sidecar.js (port ${settings.sidecarPort})`);
  scProc = spawn(nodeExe, ['sidecar.js'], { cwd: path.join(gw, 'node'), env, windowsHide: true });
  pipeLog(scProc, 'sidecar');
  scProc.on('exit', (code, sig) => {
    log('sidecar', `exited code=${code} sig=${sig}`);
    scProc = null; state.sidecar = false; pushState();
  });
  scProc.on('error', (e) => { log('sidecar', 'spawn error: ' + e.message); scProc = null; });

  state.running = true;
  startHealth();
  pushState();
  return { ok: true };
}

async function stop() {
  state.running = false;
  stopHealth();
  if (gwProc) { killTree(gwProc.pid); gwProc = null; }
  if (scProc) { killTree(scProc.pid); scProc = null; }
  state.gateway = false; state.sidecar = false;
  log('stop', 'stopped');
  pushState();
  return { ok: true };
}

function getJson(url, ms) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: ms }, (res) => {
      let b = '';
      res.on('data', d => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function pollHealth() {
  const gw = await getJson(`http://127.0.0.1:${settings.gatewayPort}/health`, 2500);
  const sc = await getJson(`http://127.0.0.1:${settings.sidecarPort}/health`, 2500);
  const sav = await getJson(`http://127.0.0.1:${settings.gatewayPort}/savings`, 2500);
  const before = JSON.stringify(state);
  state.savings = (sav && sav.ok && sav.savings) ? sav.savings : null;
  state.gateway = !!(gw && gw.ok);
  state.sidecar = !!(sc && sc.ok);
  state.accounts = sc && typeof sc.accounts === 'number' ? sc.accounts : null;
  state.loggedIn = sc && typeof sc.loggedIn === 'number' ? sc.loggedIn : null;
  state.busy = sc && typeof sc.busy === 'number' ? sc.busy : null;
  if (state.running && !gwProc && !scProc) {
    state.running = false;
    log('app', '进程已全部退出');
  }
  if (JSON.stringify(state) !== before) pushState();
}
function startHealth() {
  stopHealth();
  pollHealth();
  healthTimer = setInterval(pollHealth, 3000);
}
function stopHealth() { if (healthTimer) { clearInterval(healthTimer); healthTimer = null; } }
function pushState() { if (win && !win.isDestroyed()) win.webContents.send('state', { ...state }); }

// ---- 窗口 ----------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: 'DeepSeek Web Bridge',
    backgroundColor: '#111418',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 渲染层控制台透传到日志（便于排查界面问题）
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) {
      log('ui', '[error] ' + message);
      console.log('[ui:error] ' + message);
    }
  });

  // 内嵌页面里不允许弹出外部浏览器
  win.webContents.on('did-attach-webview', (_e, wv) => {
    wv.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
  win.on('closed', () => { win = null; });
}

// ---- IPC -----------------------------------------------------------------
ipcMain.handle('start', () => start());
ipcMain.handle('stop', () => stop());
ipcMain.handle('state', () => ({ ...state, running: state.running }));
ipcMain.handle('logs', () => logs.slice(-1000));
ipcMain.handle('getSettings', () => ({ ...settings }));
ipcMain.handle('setSettings', (_e, s) => {
  settings = { ...DEFAULTS, ...s };
  saveSettings();
  log('settings', 'saved');
  if (state.running) log('settings', '端口/环境改动需重启服务后生效');
  return { ok: true };
});
ipcMain.handle('paths', () => ({
  gateway: gwDir(),
  php: settings.phpPath || path.join(phpHome(), 'php.exe'),
  node: path.join(nodeHome(), 'node.exe'),
  browsers: path.join(gwDir(), 'browsers'),
  userData: app.getPath('userData'),
  packaged: app.isPackaged
}));
ipcMain.handle('appInfo', () => ({ version: app.getVersion() }));

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runSelfTest() {
  const out = (m) => { console.log('[selftest] ' + m); log('selftest', m); };
  const gwUrl = `http://127.0.0.1:${settings.gatewayPort}/health`;
  const scUrl = `http://127.0.0.1:${settings.sidecarPort}/health`;
  let failed = false;
  try {
    out(`ports gw=${settings.gatewayPort} sc=${settings.sidecarPort}`);
    const r = await start();
    if (!r.ok) throw new Error('start failed: ' + r.error);
    out('started, waiting health...');
    let gw = null, sc = null;
    for (let i = 0; i < 60; i++) {
      gw = gw || await getJson(gwUrl, 2000);
      sc = sc || await getJson(scUrl, 2000);
      if (gw && gw.ok && sc && sc.ok) break;
      await sleep(1000);
    }
    if (!gw || !gw.ok) { failed = true; out('FAIL gateway health: ' + JSON.stringify(gw)); }
    if (!sc || !sc.ok) { failed = true; out('FAIL sidecar health: ' + JSON.stringify(sc)); }
    if (!failed) out(`PASS both healthy (accounts=${sc.accounts} loggedIn=${sc.loggedIn})`);

    await stop();
    await sleep(1500);
    const gw2 = await getJson(gwUrl, 1500);
    const sc2 = await getJson(scUrl, 1500);
    if (gw2) { failed = true; out('FAIL gateway still responding after stop'); }
    if (sc2) { failed = true; out('FAIL sidecar still responding after stop'); }
    if (!gw2 && !sc2) out('PASS stopped cleanly');
  } catch (e) {
    failed = true;
    out('FAIL ' + (e && e.message));
  } finally {
    out(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
    setTimeout(() => app.exit(failed ? 1 : 0), 500);
  }
}

app.whenReady().then(async () => {
  loadSettings();
  createWindow();
  startHealth();
  if (process.argv.includes('--selftest')) {
    setTimeout(runSelfTest, 1500);
  }
});
app.on('window-all-closed', () => {
  stop().finally(() => app.quit());
});
app.on('before-quit', () => {
  stopHealth();
  if (gwProc) killTree(gwProc.pid);
  if (scProc) killTree(scProc.pid);
});
