// 真浏览器验证 PDF 导入全链路（prove-it）
// 场景1：干净状态导入 → 周三恰好 2 门；场景2：预置旧数据后导入 → 替换不叠加。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = path.join(ROOT, 'tests', 'screenshots');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9345;
const URL = 'http://127.0.0.1:8080/';
const PDF = 'C:/Users/nmsws/xwechat_files/wxid_dhopm0tbc5dr22_60b5/msg/file/2026-10/xskb.pdf';
const PROFILE = path.join(process.env.TEMP || '/tmp', 'course-pdf-verify-' + Date.now());

fs.mkdirSync(SHOT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, URL,
], { stdio: 'ignore' });

async function getWs() {
  for (let i = 0; i < 40; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:8080'));
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
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) this.listeners.forEach((fn) => fn(msg));
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
async function waitFor(expr, timeout = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await ev(expr)) return true; } catch {}
    await sleep(300);
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
async function wednesdayCards() {
  return await ev(`(() => {
    const out = [];
    document.querySelectorAll('#grid td[data-day="3"]').forEach(td => {
      if (td.style.display === 'none') return;
      td.querySelectorAll('.course .c-name').forEach(n => out.push({
        section: td.getAttribute('data-section'), name: n.textContent
      }));
    });
    return out;
  })()`);
}
async function importPdf() {
  const doc = await cdp.send('DOM.getDocument');
  const input = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#pdfInput' });
  await cdp.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [PDF] });
  await waitFor('!document.getElementById("pdfModal").classList.contains("hidden") && document.querySelectorAll("#pdfTable tr").length > 1', 90000);
  return await ev(`(() => [...document.querySelectorAll('#pdfTable tr')].slice(1).map(r => {
    const c = r.querySelectorAll('select,input');
    return { day: c[0].options[c[0].selectedIndex].value, start: c[1].value, name: c[2].value };
  }))()`);
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
  await ev('window.alert = () => {}; window.confirm = () => true;');
  await waitFor('document.readyState === "complete"');

  // ===== 场景1：干净导入 =====
  await ev('localStorage.clear()');
  await cdp.send('Page.reload');
  await waitFor('document.readyState === "complete"');
  await ev('window.alert = () => {}; window.confirm = () => true;');
  await sleep(400);
  check('场景1 起始课程数为 0', (await ev('document.querySelectorAll(".course").length')) === 0);

  const rows1 = await importPdf();
  const wed1 = rows1.filter((r) => r.day === '3');
  console.log('  核对表格周三:', JSON.stringify(wed1));
  check('核对表格共 14 门', rows1.length === 14, String(rows1.length));
  check('核对表格周三恰好 2 门', wed1.length === 2, JSON.stringify(wed1));
  await shot('10-pdf-table-clean');

  await ev('document.getElementById("pdfConfirm").click()');
  await sleep(500);
  const cards1 = await wednesdayCards();
  console.log('  渲染后周三:', JSON.stringify(cards1));
  check('渲染后周三恰好 2 张卡', cards1.length === 2, JSON.stringify(cards1));
  check('渲染后周三无重复 Web框架', cards1.filter((c) => c.name.includes('Web框架')).length === 1, JSON.stringify(cards1));
  await shot('11-grid-clean');

  // ===== 场景2：预置旧数据后导入（模拟用户的 bug）=====
  await ev(`localStorage.setItem('schedule.v1', JSON.stringify({
    config: { version:1, term:'2026 秋季学期', classMode:'big', sections:4, days:7, totalWeeks:20, semesterStart:'', sectionTimes:['08:00–09:40','10:00–11:40','13:30–15:10','15:30–17:10'] },
    courses: [
      {id:'old1',name:'旧课-重复Web框架',teacher:'旧',location:'X',day:3,start:2,end:2,week:'all',color:'#4f86f7',note:''},
      {id:'old2',name:'旧课-应被清掉',teacher:'旧',location:'X',day:1,start:1,end:1,week:'all',color:'#4f86f7',note:''}
    ], view:{currentWeek:1}}))`);
  await cdp.send('Page.reload');
  await waitFor('document.readyState === "complete"');
  await ev('window.alert = () => {}; window.confirm = () => true;');
  await sleep(400);
  check('场景2 预置旧数据 2 门已加载', (await ev('document.querySelectorAll(".course").length')) === 2);

  await importPdf();
  await ev('document.getElementById("pdfConfirm").click()');  // 默认替换
  await sleep(500);
  const total2 = await ev('JSON.parse(localStorage.getItem("schedule.v1")).courses.length');
  const cards2 = await wednesdayCards();
  console.log('  替换后存储课程数:', total2, '周三:', JSON.stringify(cards2));
  check('替换后存储课程数 = 14（旧数据已清，不叠加）', total2 === 14, String(total2));
  check('替换后旧课不再出现', !(await ev('document.body.innerText')).includes('旧课-'));
  check('替换后周三恰好 2 张卡', cards2.length === 2, JSON.stringify(cards2));
  await shot('12-grid-after-replace');

  check('控制台零 JS 报错', jsErrors.length === 0, jsErrors.join(' | '));
  console.log(`\n结果: ${results.filter((r) => r.ok).length}/${results.length} 通过`);
} finally {
  chrome.kill('SIGTERM');
}
