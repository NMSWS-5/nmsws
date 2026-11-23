// 课表网页版浏览器验收：用本机 Chrome + DevTools 协议驱动，不依赖 npm 包。
// 运行前需先起静态服务：python -m http.server 8080 --directory web
// 用法：node tests/verify.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = path.join(ROOT, 'tests', 'screenshots');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const URL = 'http://127.0.0.1:8080/';
const PROFILE = path.join(process.env.TEMP || '/tmp', 'course-verify-' + Date.now());

fs.mkdirSync(SHOT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const jsErrors = [];
let passed = 0, failed = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  ok ? passed++ : failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
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
      } else if (msg.method) {
        this.listeners.forEach((fn) => fn(msg));
      }
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
async function ev(expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description || ''));
  return r.result?.value;
}
async function waitFor(expr, timeout = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await ev(expr)) return true; } catch {}
    await sleep(150);
  }
  throw new Error('等待超时: ' + expr);
}
async function shot(name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const p = path.join(SHOT, name + '.png');
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  return path.relative(ROOT, p);
}
const click = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).click()`);

async function dragTo(srcSel, dstSel) {
  return await ev(`(() => {
    const s = document.querySelector(${JSON.stringify(srcSel)});
    const d = document.querySelector(${JSON.stringify(dstSel)});
    if (!s || !d) return { ok:false, why:'元素不存在' };
    const dt = new DataTransfer();
    const r = d.getBoundingClientRect();
    const pt = { bubbles:true, cancelable:true, dataTransfer:dt,
                 clientX: r.left + r.width/2, clientY: r.top + r.height/2 };
    s.dispatchEvent(new DragEvent('dragstart', pt));
    d.dispatchEvent(new DragEvent('dragover', pt));
    d.dispatchEvent(new DragEvent('drop', pt));
    s.dispatchEvent(new DragEvent('dragend', pt));
    return { ok:true };
  })()`);
}

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--disable-extensions', '--hide-scrollbars', '--disable-background-networking',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1440,1000', 'about:blank'
], { stdio: 'ignore' });

try {
  let wsUrl;
  for (let i = 0; i < 80 && !wsUrl; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
    } catch {}
    if (!wsUrl) await sleep(250);
  }
  if (!wsUrl) throw new Error('Chrome DevTools 未就绪');

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  cdp = new CDP(ws);
  cdp.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      jsErrors.push('exception: ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      jsErrors.push('console.error: ' + m.params.args.map((a) => a.value || a.description).join(' '));
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' &&
        !/favicon\.ico/.test(m.params.entry.url || '')) {
      jsErrors.push('log: ' + m.params.entry.text);
    }
  });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  // 注入真实课表数据（与项目里的 课表数据.json 同源同格式）
  const seed = fs.readFileSync(path.join(ROOT, '课表数据.json'), 'utf8');
  await cdp.send('Page.navigate', { url: URL });
  await waitFor(`location.href.indexOf('127.0.0.1:8080') >= 0 && document.readyState === 'complete'`);
  // 首次加载会自动写入空的 v2，先清掉才能走旧数据迁移路径
  await ev(`localStorage.removeItem('schedule.v2'); localStorage.setItem('schedule.v1', ${JSON.stringify(seed)})`);
  await cdp.send('Page.reload');
  await waitFor('document.readyState === "complete" && document.querySelectorAll(".course").length > 0');

  // 1. 初始渲染
  const week1 = await ev(`document.querySelectorAll('#grid .course').length`);
  check('第1周课表渲染出课程', week1 > 0, `渲染 ${week1} 门`);
  const label1 = await ev(`document.getElementById('weekLabel').textContent.trim()`);
  check('周次标签显示第1周', /第\s*1\s*周/.test(label1), label1);
  await shot('01-week1');

  // 2. 周次切换（第1周 -> 第5周，范围课 5-8 应出现）
  for (let i = 0; i < 4; i++) await click('#nextWeek');
  await sleep(400);
  const label5 = await ev(`document.getElementById('weekLabel').textContent.trim()`);
  const week5 = await ev(`document.querySelectorAll('#grid .course').length`);
  check('点击 › 切到第5周', /第\s*5\s*周/.test(label5), label5);
  check('周次过滤生效（第5周课程数变化）', week5 !== week1, `第1周 ${week1} → 第5周 ${week5}`);
  await shot('02-week5');

  // 3. 回到第1周
  for (let i = 0; i < 4; i++) await click('#prevWeek');
  await sleep(400);
  check('点击 ‹ 回到第1周', /第\s*1\s*周/.test(await ev(`document.getElementById('weekLabel').textContent.trim()`)));

  // 4. 拖动换课：把第1周可见的第一门课拖到周六第1节空格
  // 当前数据存于 schedule.v2 的活动课表中
  const T = `(()=>{const d=JSON.parse(localStorage.getItem('schedule.v2'));return d.tables.find(t=>t.id===d.activeId)||d.tables[0];})()`;
  const before = await ev(`${T}.courses.map(c => c.id + ':' + c.day + '/' + c.start).join(',')`);
  const src = await ev(`(() => { const b = document.querySelector('#grid .course'); return b ? b.closest('td').dataset.day + '/' + b.closest('td').dataset.section : null; })()`);
  const target = 'td.cell[data-day="6"][data-section="1"]';
  const dstEmpty = await ev(`(() => { const d = document.querySelector(${JSON.stringify(target)}); return !!d && !d.querySelector('.course'); })()`);
  check('找到空格目标（周六第1节）', dstEmpty);
  if (dstEmpty) {
    const d = await dragTo('#grid .course', target);
    await sleep(500);
    const after = await ev(`${T}.courses.map(c => c.id + ':' + c.day + '/' + c.start).join(',')`);
    check('拖动换课写回 localStorage', d.ok && before !== after, `源格 ${src}`);
    await shot('03-after-drag');
  }

  // 5. 设置：大节 -> 小节，课程不丢
  const countBig = await ev(`document.querySelectorAll('#grid .course').length`);
  await click('#btnSettings');
  await sleep(200);
  await ev(`(() => { const s = document.getElementById('sMode'); s.value = 'small'; s.dispatchEvent(new Event('change', {bubbles:true})); return s.value; })()`);
  await ev(`document.querySelector('#settingsForm button[type=submit]').click()`);
  await sleep(500);
  const countSmall = await ev(`document.querySelectorAll('#grid .course').length`);
  const modeSmall = await ev(`${T}.config.classMode`);
  check('设置切换为小节视图', modeSmall === 'small', `classMode=${modeSmall}`);
  check('粒度切换后课程不丢', countSmall === countBig, `${countBig} → ${countSmall}`);
  await shot('04-small-mode');

  // 6. 切回大节
  await click('#btnSettings');
  await sleep(200);
  await ev(`(() => { const s = document.getElementById('sMode'); s.value = 'big'; s.dispatchEvent(new Event('change', {bubbles:true})); return s.value; })()`);
  await ev(`document.querySelector('#settingsForm button[type=submit]').click()`);
  await sleep(500);
  check('切回大节视图', (await ev(`${T}.config.classMode`)) === 'big');
  await shot('05-big-mode');

  // 7. 刷新后数据持久化
  const beforeReload = await ev(`localStorage.getItem('schedule.v2')`);
  await cdp.send('Page.reload');
  await waitFor('document.readyState === "complete" && document.querySelectorAll(".course").length > 0');
  const afterReload = await ev(`localStorage.getItem('schedule.v2')`);
  const countReload = await ev(`document.querySelectorAll('#grid .course').length`);
  check('刷新后数据仍在且渲染正常', beforeReload === afterReload && countReload === countBig, `渲染 ${countReload} 门`);
  await shot('06-after-reload');

  // 8. 控制台零报错
  check('浏览器控制台零 JS 报错', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | ') || '无');
} catch (e) {
  check('测试脚本自身执行完成', false, e.message);
  console.error(e);
} finally {
  console.log('\n===== 汇总 =====');
  console.log(`通过 ${passed} / 失败 ${failed}`);
  results.filter((r) => !r.ok).forEach((r) => console.log(`  FAIL: ${r.name} ${r.detail}`));
  try { cdp?.ws.close(); } catch {}
  chrome.kill();
  process.exit(failed ? 1 : 0);
}
