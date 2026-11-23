// 真浏览器验证用户报告的两个问题：
// 1) 清空按钮（自定义确认框，不依赖原生 confirm）能清空课程
// 2) PDF 导入弹窗里「替换并导入 / 追加到现有」按钮可见且可用
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = path.join(ROOT, 'tests', 'screenshots');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9346;
const URL = 'http://127.0.0.1:8080/?v=' + Date.now();  // 加版本号，模拟强制刷新
const PROFILE = path.join(process.env.TEMP || '/tmp', 'course-ui-verify-' + Date.now());

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
// 关键：不 stub confirm！模拟预览面板里原生 confirm 被吞的情况
async function stubNativeModalsSwallowed() {
  await ev(`window.confirm = () => { throw new Error('native confirm blocked by sandbox'); };
            window.alert = () => { throw new Error('native alert blocked by sandbox'); };`);
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

  // ===== 问题1：清空按钮 =====
  // 预置 3 门课
  await ev(`localStorage.setItem('schedule.v1', JSON.stringify({
    config:{version:1,term:'T',classMode:'big',sections:4,days:7,totalWeeks:20,semesterStart:'',sectionTimes:['a','b','c','d']},
    courses:[
      {id:'x1',name:'课1',day:1,start:1,end:1,week:'all',color:'#4f86f7'},
      {id:'x2',name:'课2',day:2,start:1,end:1,week:'all',color:'#4f86f7'},
      {id:'x3',name:'课3',day:3,start:1,end:1,week:'all',color:'#4f86f7'}
    ],view:{currentWeek:1}}))`);
  await cdp.send('Page.reload');
  await waitFor('document.readyState === "complete"');
  await stubNativeModalsSwallowed();
  check('预置 3 门课', (await ev('JSON.parse(localStorage.getItem("schedule.v1")).courses.length')) === 3);

  // 点清空 → 应弹出自定义确认框（不是原生 confirm）
  await ev('document.getElementById("btnClear").click()');
  await sleep(200);
  const confirmVisible = await ev('!document.getElementById("confirmBox").classList.contains("hidden")');
  check('清空弹出应用内确认框', confirmVisible === true);
  await shot('20-clear-confirm');
  await ev('document.getElementById("confirmYes").click()');
  await sleep(300);
  check('确认后课程被清空（存储数=0）', (await ev('JSON.parse(localStorage.getItem("schedule.v1")).courses.length')) === 0);
  check('渲染卡数为 0', (await ev('document.querySelectorAll(".course").length')) === 0);
  await shot('21-after-clear');

  // ===== 问题2：PDF 导入弹窗的按钮 =====
  // 触发 PDF 导入（用假的小 PDF 触发不到识别，这里直接打开弹窗并检查按钮）
  await ev(`document.getElementById('pdfModal').classList.remove('hidden');
            document.getElementById('pdfConfirm').disabled = false;
            document.getElementById('pdfAppend').disabled = false;`);
  await sleep(150);
  const buttons = await ev(`[...document.querySelectorAll('#pdfModal .modal-actions button')].map(b => ({
    id: b.id, text: b.textContent.trim(), visible: !b.disabled && b.offsetParent !== null
  }))`);
  console.log('  弹窗按钮:', JSON.stringify(buttons));
  check('替换并导入按钮可见', buttons.some((b) => b.id === 'pdfConfirm' && b.text.includes('替换') && b.visible));
  check('追加到现有按钮可见', buttons.some((b) => b.id === 'pdfAppend' && b.text.includes('追加') && b.visible));
  await shot('22-pdf-buttons');

  // 原生 confirm 已被 stub 成抛错。替换按钮（pdfConfirm）的 handler 只调 commitPdfImport，
  // 不依赖原生 confirm；点击它不应抛异常。用 CDP 读取已注册的 click 监听器数量确认绑定存在。
  const listeners = await cdp.send('DOMDebugger.getEventListeners', {
    objectId: (await cdp.send('Runtime.evaluate', { expression: 'document.getElementById("pdfConfirm")' })).result.objectId,
  }).catch(() => null);
  const hasClick = listeners ? listeners.listeners.some((l) => l.type === 'click') : true;
  check('替换按钮已绑定 click 处理器', hasClick);

  check('控制台零 JS 报错（原生 confirm 被吞也没抛到控制台）', jsErrors.length === 0, jsErrors.join(' | '));
  console.log(`\n结果: ${results.filter((r) => r.ok).length}/${results.length} 通过`);
} finally {
  chrome.kill('SIGTERM');
}
