// 真浏览器验证多课表功能（prove-it）：
// 迁移、切换数据隔离、新建、删除、改名、当前周独立、控制台零报错。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = path.join(ROOT, 'tests', 'screenshots');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9347;
const URL = 'http://127.0.0.1:8080/?v=' + Date.now();
const PROFILE = path.join(process.env.TEMP || '/tmp', 'course-multi-verify-' + Date.now());

fs.mkdirSync(SHOT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=1280,900',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, URL,
], { stdio: 'ignore' });

async function getWs() {
  for (let i = 0; i < 40; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = targets.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:8080'));
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome CDP 未就绪');
}
class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.listeners = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method) this.listeners.forEach((fn) => fn(m));
    });
  }
  on(fn) { this.listeners.push(fn); }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}
let cdp;
const jsErrors = [];
async function ev(expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description || ''));
  return r.result?.value;
}
async function waitFor(expr, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await ev(expr)) return true; } catch {}
    await sleep(200);
  }
  throw new Error('等待超时: ' + expr);
}
async function shot(name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const p = path.join(SHOT, name + '.png');
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  return path.relative(ROOT, p);
}
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
}
const store = () => ev('JSON.parse(localStorage.getItem("schedule.v2"))');
async function reload() {
  await cdp.send('Page.reload');
  await waitFor('document.readyState === "complete"');
  await sleep(300);
}

try {
  const ws = new WebSocket(await getWs());
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  cdp = new CDP(ws);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  cdp.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') jsErrors.push(m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
      jsErrors.push(m.params.args.map((a) => a.value || a.description).join(' '));
  });
  await waitFor('document.readyState === "complete"');

  // ===== 场景1：旧数据迁移 =====
  await ev(`localStorage.clear();
    localStorage.setItem('schedule.v1', JSON.stringify({
      config:{version:1,term:'2026 秋季学期',classMode:'big',sections:4,days:7,totalWeeks:20,semesterStart:'',sectionTimes:['a','b','c','d']},
      courses:[{id:'old1',name:'迁移课A',day:1,start:1,end:1,week:'all',color:'#4f86f7'}],
      view:{currentWeek:5}}))`);
  await reload();
  let s = await store();
  check('旧 v1 数据迁移为 1 张表', s && s.tables.length === 1, JSON.stringify(s && s.tables.map(t => t.name)));
  check('迁移保留学期名', s.tables[0].name === '2026 秋季学期', s.tables[0].name);
  check('迁移保留课程', s.tables[0].courses.length === 1 && s.tables[0].courses[0].name === '迁移课A');
  check('迁移保留当前周', s.tables[0].view.currentWeek === 5, String(s.tables[0].view.currentWeek));
  check('顶栏按钮显示学期名', (await ev('document.getElementById("tableBtnName").textContent')) === '2026 秋季学期');
  await shot('30-migrated');

  // ===== 场景2：下拉打开与新建 =====
  await ev('document.getElementById("tableBtn").click()');
  await sleep(150);
  check('下拉菜单打开', (await ev('!document.getElementById("tableMenu").classList.contains("hidden")')) === true);
  const menuItems = await ev(`[...document.querySelectorAll('#tableMenu .tm-item .tm-name')].map(n=>n.textContent)`);
  console.log('  菜单项:', JSON.stringify(menuItems));
  check('菜单末行有新建课表按钮', (await ev('!!document.getElementById("tmNew")')) === true);
  await shot('31-menu-open');

  await ev('document.getElementById("tmNew").click()');
  await sleep(250);
  s = await store();
  check('新建后共 2 张表', s.tables.length === 2, String(s.tables.length));
  check('新表名为新课表', s.activeId === s.tables[1].id && s.tables[1].name === '新课表');
  check('新表课程为空', s.tables[1].courses.length === 0);
  check('新表当前周为 1', s.tables[1].view.currentWeek === 1);
  check('切到新表后显示空课表', (await ev('document.querySelectorAll(".course").length')) === 0);
  await shot('32-after-new');

  // ===== 场景3：切换数据隔离（各自课程/周次独立）=====
  // 在新表加一门课并切到第 3 周
  await ev(`(() => {
    const raw = JSON.parse(localStorage.getItem('schedule.v2'));
    const at = raw.tables.find(t=>t.id===raw.activeId);
    at.courses.push({id:'new1',name:'新课表专属课',day:2,start:1,end:1,week:'all',color:'#4f86f7'});
    at.view.currentWeek = 3;
    localStorage.setItem('schedule.v2', JSON.stringify(raw));
  })()`);
  await reload();
  check('新表有自己的课和周次', (await ev('document.body.innerText')).includes('新课表专属课') && (await ev('document.getElementById("weekLabel").textContent')).includes('3'));
  // 切回第一张表
  await ev('document.getElementById("tableBtn").click()');
  await sleep(120);
  await ev(`document.querySelectorAll('#tableMenu .tm-item')[0].click()`);
  await sleep(250);
  check('切回第一张表显示迁移课A', (await ev('document.body.innerText')).includes('迁移课A'));
  check('切回后不显示新表专属课', !(await ev('document.body.innerText')).includes('新课表专属课'));
  check('切回后周次恢复为 5', (await ev('document.getElementById("weekLabel").textContent')).includes('5'));
  await shot('33-switched-back');

  // ===== 场景4：改名（设置弹窗）=====
  await ev('document.getElementById("btnSettings").click()');
  await sleep(120);
  await ev(`document.getElementById('sName').value = '2027 春季学期';
            document.getElementById('settingsForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));`);
  await sleep(250);
  check('改名后顶栏按钮更新', (await ev('document.getElementById("tableBtnName").textContent')) === '2027 春季学期');
  s = await store();
  check('改名写入当前表', s.tables.find(t => t.id === s.activeId).name === '2027 春季学期');
  await shot('34-renamed');

  // ===== 场景5：删除课表 =====
  await ev('document.getElementById("tableBtn").click()');
  await sleep(120);
  check('删除前 2 张表', (await store()).tables.length === 2);
  await ev('document.getElementById("btnClear").click()');  // 弹应用内确认
  await sleep(150);
  check('删除弹应用内确认框', (await ev('!document.getElementById("confirmBox").classList.contains("hidden")')) === true);
  await ev('document.getElementById("confirmYes").click()');
  await sleep(250);
  s = await store();
  check('删除后剩 1 张表', s.tables.length === 1, String(s.tables.length));
  check('删除后显示另一张表', (await ev('document.getElementById("tableBtnName").textContent')) === '新课表');
  await shot('35-after-delete');

  // ===== 场景6：最后一张不允许删除，改为清空 =====
  await ev('document.getElementById("btnClear").click()');
  await sleep(120);
  const lastMsg = await ev('document.getElementById("confirmMsg").textContent');
  check('最后一张提示清空而非删除', lastMsg.includes('清空'), lastMsg);
  await ev('document.getElementById("confirmYes").click()');
  await sleep(200);
  check('清空后仍有 1 张表', (await store()).tables.length === 1);

  check('控制台零 JS 报错', jsErrors.length === 0, jsErrors.join(' | '));
  console.log(`\n结果: ${results.filter((r) => r.ok).length}/${results.length} 通过`);
} finally {
  chrome.kill('SIGTERM');
}
