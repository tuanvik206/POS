import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const evidenceDir = join(root, 'report', 'evidence');
const envText = await readFile(join(root, '.env'), 'utf8');
const env = Object.fromEntries(envText.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).map((line) => {
  const index = line.indexOf('=');
  return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^(['"])(.*)\1$/, '$2')];
}));

const appPort = Number(env.APP_PORT || 8080);
const baseUrl = `http://127.0.0.1:${appPort}`;
const required = ['ADMIN_USERNAME', 'ADMIN_PASSWORD', 'GRAFANA_ADMIN_USER', 'GRAFANA_ADMIN_PASSWORD', 'MYSQL_USER', 'MYSQL_PASSWORD'];
for (const key of required) if (!env[key]) throw new Error(`Missing ${key} in .env`);

const edgePath = process.env.POS_EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
await access(edgePath);
const loginResponse = await fetch(`${baseUrl}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD }),
});
if (!loginResponse.ok) throw new Error(`POS login failed (${loginResponse.status})`);
const login = await loginResponse.json();

await mkdir(evidenceDir, { recursive: true });
const profileDir = await mkdtemp(join(tmpdir(), 'pos-report-'));
const profileRoot = resolve(tmpdir()) + sep;
if (!resolve(profileDir).startsWith(profileRoot)) throw new Error('Temporary browser profile escaped the temp directory');

let browser;
let socket;
let nextId = 0;
const pending = new Map();

function cdp(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolveCommand, rejectCommand) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      rejectCommand(new Error(`Browser command timed out: ${method}`));
    }, 15000);
    pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error('Browser page evaluation failed');
  return result.result?.value;
}

async function navigate(url, delay = 1800) {
  await cdp('Page.navigate', { url });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
}

async function waitFor(expression, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(expression)) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  return false;
}

async function screenshot(filename) {
  const result = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(evidenceDir, filename), Buffer.from(result.data, 'base64'));
}

try {
  browser = spawn(edgePath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', '--remote-allow-origins=*', `--user-data-dir=${profileDir}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  let debugPort;
  const activePortFile = join(profileDir, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 40 && !debugPort; attempt += 1) {
    try { debugPort = Number((await readFile(activePortFile, 'utf8')).split(/\r?\n/)[0]); }
    catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 250)); }
  }
  if (!debugPort) throw new Error('Microsoft Edge did not start its local debugging endpoint');

  let targets;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json(); break; }
    catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 250)); }
  }
  const target = targets?.find((item) => item.type === 'page');
  if (!target) throw new Error('Microsoft Edge did not open a page target');

  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', rejectOpen, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const command = pending.get(message.id);
    if (!command) return;
    clearTimeout(command.timeout);
    pending.delete(message.id);
    if (message.error) command.reject(new Error(message.error.message));
    else command.resolve(message.result || {});
  });

  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Network.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await navigate(baseUrl, 1000);
  const token = JSON.stringify(login.token);
  const user = JSON.stringify(JSON.stringify(login.user));
  await evaluate(`localStorage.setItem('pos_token',${token});localStorage.setItem('pos_user',${user});location.reload();true`);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 2500));
  await screenshot('pos-overview.png');

  for (const [label, filename] of [['Sản phẩm & kho', 'pos-products.png'], ['Hóa đơn', 'pos-orders.png']]) {
    const clicked = await evaluate(`(()=>{const b=[...document.querySelectorAll('aside nav button')].find(x=>x.innerText.includes(${JSON.stringify(label)}));if(!b)return false;b.click();return true})()`);
    if (!clicked) throw new Error(`POS page was not found: ${label}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
    await screenshot(filename);
  }

  await navigate(`${baseUrl}/prometheus/targets`, 3500);
  await screenshot('prometheus-targets.png');

  const grafanaAuth = Buffer.from(`${env.GRAFANA_ADMIN_USER}:${env.GRAFANA_ADMIN_PASSWORD}`).toString('base64');
  await cdp('Network.setExtraHTTPHeaders', { headers: { Authorization: `Basic ${grafanaAuth}` } });
  await navigate(`${baseUrl}/grafana/d/pos-overview/pos-store-tong-quan-ha-tang`, 2500);
  const dashboardTitle = await waitFor(`document.body.innerText.includes('POS Store - Tổng quan hạ tầng')`);
  if (!dashboardTitle) {
    const state = await evaluate(`JSON.stringify({url:location.href,title:document.title,text:document.body.innerText.slice(0,500)})`);
    throw new Error(`Grafana dashboard did not load: ${state}`);
  }
  await screenshot('grafana-dashboard.png');
  await evaluate('window.scrollTo(0, document.body.scrollHeight)');
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 2500));
  await screenshot('grafana-logql.png');

  await cdp('Network.setExtraHTTPHeaders', { headers: {} });
  await navigate(`${baseUrl}/phpmyadmin/`, 2000);
  const pmaForm = await evaluate(`(()=>{const u=document.querySelector('input[name="pma_username"]');const p=document.querySelector('input[name="pma_password"]');return Boolean(u&&p)})()`);
  if (pmaForm) {
    await evaluate(`(()=>{const set=(e,v)=>{const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');d.set.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}))};const u=document.querySelector('input[name="pma_username"]');const p=document.querySelector('input[name="pma_password"]');set(u,${JSON.stringify(env.MYSQL_USER)});set(p,${JSON.stringify(env.MYSQL_PASSWORD)});const f=u.closest('form');f.requestSubmit();return true})()`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 3500));
  }
  const database = encodeURIComponent(env.MYSQL_DATABASE || 'pos_store');
  await navigate(`${baseUrl}/phpmyadmin/index.php?route=/database/structure&db=${database}`, 1600);
  const structureLoaded = await evaluate(`document.body.innerText.includes('stock_movements')`);
  if (!structureLoaded) throw new Error('phpMyAdmin database structure did not load');
  await screenshot('phpmyadmin.png');
  const salesUrl = await evaluate(`([...document.querySelectorAll('a')].find(a=>a.innerText.trim()==='Browse'&&a.closest('tr')?.innerText.includes('sales'))||{}).href||''`);
  if (!salesUrl) throw new Error('phpMyAdmin sales table link was not found');
  await navigate(salesUrl, 1800);
  const salesLoaded = await evaluate(`document.body.innerText.includes('POS-MVKZ4396-6EA63A0B')`);
  if (!salesLoaded) {
    const salesState = await evaluate(`JSON.stringify({url:location.href,text:document.body.innerText.slice(0,1800)})`);
    throw new Error(`phpMyAdmin sales table did not show the demo invoice: ${salesState}`);
  }
  await screenshot('phpmyadmin-sales.png');

  const files = ['pos-overview.png', 'pos-products.png', 'pos-orders.png', 'phpmyadmin.png', 'phpmyadmin-sales.png', 'prometheus-targets.png', 'grafana-dashboard.png', 'grafana-logql.png'];
  const sizes = await Promise.all(files.map(async (file) => [file, (await readFile(join(evidenceDir, file))).byteLength]));
  console.log(JSON.stringify({ captured: sizes.map(([file, bytes]) => ({ file, bytes })) }));
} finally {
  try { if (socket?.readyState === WebSocket.OPEN) await cdp('Browser.close'); } catch {}
  try { browser?.kill(); } catch {}
  try { await rm(profileDir, { recursive: true, force: true }); } catch {}
}
