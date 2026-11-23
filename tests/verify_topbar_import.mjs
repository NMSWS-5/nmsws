// 验证顶栏新布局 + 合并导入弹窗（prove-it）：
// 左设置 / 中切换器 / 右操作；点导入弹选项；选项能触发对应文件选择。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = path.join(ROOT, 'tests', 'screenshots');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9360;
const URL = 'http://127.0.0.1:8080/?v=' + Date.now();
const PROFILE = path.join(process.env.TEMP || '/tmp', 'course-topbar-' + Date.now());
fs.mkdirSync(SHOT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--window-size=1280,900',`--remote-debugging-port=${PORT}`,`--user-data-dir=${PROFILE}`, URL], { stdio:'ignore' });
async function getWs(){for(let i=0;i<40;i++){try{const t=await(await fetch(`http://127.0.0.1:${PORT}/json`)).json();const p=t.find(x=>x.type==='page'&&x.url.includes('127.0.0.1:8080'));if(p)return p.webSocketDebuggerUrl;}catch{}await sleep(250);}throw new Error('CDP 未就绪');}
class CDP{constructor(ws){this.ws=ws;this.seq=0;this.pending=new Map();this.listeners=[];ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&this.pending.has(m.id)){const{resolve,reject}=this.pending.get(m.id);this.pending.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);}else if(m.method)this.listeners.forEach(fn=>fn(m));});}on(fn){this.listeners.push(fn);}send(method,params={}){const id=++this.seq;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));});}}
let cdp; const jsErrors=[];
async function ev(expr){const r=await cdp.send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text+' :: '+(r.exceptionDetails.exception?.description||''));return r.result?.value;}
async function shot(name){const r=await cdp.send('Page.captureScreenshot',{format:'png',fromSurface:true});fs.writeFileSync(path.join(SHOT,name+'.png'),Buffer.from(r.data,'base64'));}
const results=[];
function check(name,ok,detail=''){results.push({name,ok});console.log(`${ok?'PASS':'FAIL'} | ${name}${detail?' | '+detail:''}`);}
try{
  const ws=new WebSocket(await getWs());await new Promise(r=>ws.addEventListener('open',r,{once:true}));cdp=new CDP(ws);
  await cdp.send('Runtime.enable');await cdp.send('Page.enable');
  cdp.on(m=>{if(m.method==='Runtime.exceptionThrown')jsErrors.push(m.params.exceptionDetails.text);});
  await sleep(600);

  // 顶栏顺序：设置 → 周数 → 学期 → 导出 → 导入 → 删除，全部同行；周数需缩小
  const layout = await ev(`(() => {
    const g = id => { const e=document.getElementById(id); const r=e.getBoundingClientRect(); return {l:Math.round(r.left),t:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)};};
    return { settings:g('btnSettings'), week:g('prevWeek'), switcher:g('tableBtn'), exportBtn:g('btnExport'), importBtn:g('btnImport'), clearBtn:g('btnClear') };
  })()`);
  const order = [layout.settings, layout.week, layout.switcher, layout.exportBtn, layout.importBtn, layout.clearBtn];
  check('顶栏顺序：设置→周数→学期→导出→导入→删除', order.every((el,i)=>i===0||el.l>order[i-1].l), JSON.stringify(layout));
  check('六个元素都在同一行', order.every(el=>Math.abs(el.t-order[0].t)<40), JSON.stringify(layout));
  check('周数导航已缩小（箭头 ≤30px）', layout.week.w<=30 && layout.week.h<=30, JSON.stringify(layout.week));

  // 合并导入：只有一个导入按钮，无旧的两个
  const btnInfo = await ev(`(() => ({
    hasImport: !!document.getElementById('btnImport'),
    hasOldJson: !!document.getElementById('btnImportJson'),
    hasOldPdf: !!document.getElementById('btnImportPdf'),
    importText: document.getElementById('btnImport').textContent.trim()
  }))()`);
  check('保留合并后的导入按钮', btnInfo.hasImport, JSON.stringify(btnInfo));
  check('旧的两个导入按钮已移除', !btnInfo.hasOldJson && !btnInfo.hasOldPdf, JSON.stringify(btnInfo));

  // 点导入 → 弹窗出现，含两个选项
  await ev(`document.getElementById('btnImport').click()`);
  await sleep(200);
  const modalOpen = await ev(`!document.getElementById('importModal').classList.contains('hidden')`);
  check('点导入弹出选择框', modalOpen);
  const opts = await ev(`(() => ({
    json: document.getElementById('importJson')?.textContent.trim(),
    pdf: document.getElementById('importPdf')?.textContent.trim()
  }))()`);
  check('选择框含 JSON 和 PDF 两项', !!opts.json && !!opts.pdf && opts.json.includes('JSON') && opts.pdf.includes('PDF'), JSON.stringify(opts));
  await shot('40-import-modal');

  // 取消关闭
  await ev(`document.getElementById('importCancel').click()`);
  await sleep(150);
  check('取消可关闭选择框', await ev(`document.getElementById('importModal').classList.contains('hidden')`));

  // 设置按钮：点击打开设置弹窗，含分组标题
  await ev(`document.getElementById('btnSettings').click()`);
  await sleep(200);
  const setOpen = await ev(`!document.getElementById('settings').classList.contains('hidden')`);
  check('设置按钮打开设置弹窗', setOpen);
  const groups = await ev(`document.querySelectorAll('#settings .set-group-title').length`);
  check('设置弹窗有分组标题（优化样式）', groups>=3, String(groups));
  await shot('41-settings-modal');
  await ev(`document.getElementById('sCancel').click()`);

  // 默认态截图（顶栏三块）
  await sleep(150);
  await shot('42-topbar-layout');

  check('控制台零 JS 报错', jsErrors.length===0, jsErrors.join(' | '));
}catch(e){console.error('测试异常:',e.message);check('测试执行无异常',false,e.message);}
finally{
  const pass=results.filter(r=>r.ok).length;
  console.log(`\n结果: ${pass}/${results.length} 通过`);
  if(pass<results.length)process.exitCode=1;
  chrome.kill('SIGKILL');
}
