// de-slop 前后截图：桌面 + 手机宽度，注入真实课表数据
// 用法：node tests/shot_deslop.mjs before|after
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = path.join(ROOT, 'tests', 'screenshots');
const TAG = process.argv[2] || 'before';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9401;
const URL = 'http://127.0.0.1:8080/?v=' + Date.now();
const PROFILE = path.join(process.env.TEMP || '/tmp', 'deslop-' + Date.now());
fs.mkdirSync(SHOT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',`--remote-debugging-port=${PORT}`,`--user-data-dir=${PROFILE}`,'about:blank'], { stdio:'ignore' });
let wsUrl;
for (let i=0;i<80 && !wsUrl;i++){ try { const l=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); wsUrl=l.find(t=>t.type==='page')?.webSocketDebuggerUrl; } catch {} if(!wsUrl) await sleep(250); }
if(!wsUrl) throw new Error('CDP 未就绪');
const ws = new WebSocket(wsUrl);
await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let seq=0; const pending=new Map();
ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const{resolve,reject}=pending.get(m.id);pending.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);}});
const send=(method,params={})=>{const id=++seq;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});};
const ev=async expr=>{const r=await send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true});return r.result?.value;};
const shot=async name=>{const r=await send('Page.captureScreenshot',{format:'png',fromSurface:true});fs.writeFileSync(path.join(SHOT,name+'.png'),Buffer.from(r.data,'base64'));console.log('saved',name+'.png');};
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
const seed=fs.readFileSync(path.join(ROOT,'课表数据.json'),'utf8');
await send('Page.navigate',{url:URL});
for(let i=0;i<30;i++){const s=await ev(`location.href.indexOf('127.0.0.1:8080')>=0&&document.readyState==='complete'`);if(s)break;await sleep(200);}
await ev(`localStorage.removeItem('schedule.v2');localStorage.setItem('schedule.v1',${JSON.stringify(seed)})`);
await send('Page.reload');
for(let i=0;i<40;i++){const n=await ev(`document.querySelectorAll('#grid .course').length`);if(n>0)break;await sleep(200);}
await sleep(300);
await shot(`deslop-${TAG}-desktop`);
await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true});
await sleep(500);
await shot(`deslop-${TAG}-mobile`);
chrome.kill('SIGKILL');
