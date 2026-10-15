#!/usr/bin/env node
/**
 * hls-downloader —— 网页 HLS 视频流下载工具
 *
 * 输入一个视频页面 URL，自动嗅探 m3u8、抓取全部切片、封装成本地 MP4。
 * 零第三方依赖（Node 18+ 自带 WebSocket / fetch / crypto）。
 *
 * 用法:
 *   node hls-downloader.js "<页面URL>" [选项]
 *
 * 详见同目录 README.md
 */
'use strict';

const { spawn, spawnSync } = require('child_process');
const { Readable } = require('stream');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ───────────────────────────── 参数解析 ─────────────────────────────

const HELP = `
hls-downloader —— 网页视频流下载工具

用法:
  node hls-downloader.js <页面URL> [选项]

支持三类流，嗅探后自动判断：
  HLS（m3u8 分片）/ DASH（mpd 清单）/ 直链媒体（mp4 / webm / mkv / mov / flv）

选项:
  -o, --output <文件>     输出文件路径（默认 ./<viewkey或时间戳>.mp4）
  -m, --m3u8 <URL>        跳过浏览器嗅探，直接指定流地址（m3u8 / mpd / mp4 均可）
      --referer <URL>     手动指定 Referer（默认自动取页面 origin）
      --user-agent <UA>   自定义 User-Agent
  -c, --concurrency <N>   切片并发数（默认 16，HLS 与 DASH 通用）
  -t, --timeout <秒>      单个请求超时（默认 30）
      --quality <规格>    选流：best(默认) | worst | 分辨率如 1280x720 | 带宽数字
      --period <N>        多 Period 的 MPD 只下第 N 个 Period（默认全部按序拼接）
      --probe             只嗅探并列出找到的视频流，不下载
      --headed            显示浏览器窗口（默认无头）
      --keep-temp         保留中间文件（切片、m3u8、mpd）
      --cookie <字符串>   附加 Cookie 头
      --ffmpeg <路径>     指定 ffmpeg 可执行文件
      --no-verify         跳过最终解码校验
      --progress-json     进度事件以 JSON 打到 stderr（@@HLSDL@@ 前缀），供 GUI / 脚本解析
  -h, --help              显示本帮助

示例:
  node hls-downloader.js "https://example.com/video/123"
  node hls-downloader.js "https://example.com/v/123" -o "我的视频.mp4" -c 32
  node hls-downloader.js "https://example.com/v/123" --probe
  node hls-downloader.js "https://example.com/v/123" -m "https://cdn.x.com/a/index.m3u8?sign=..."
  node hls-downloader.js "https://example.com/v/123" -m "https://cdn.x.com/a/manifest.mpd"
`;

function parseArgs(argv) {
  const o = {
    url: null, output: null, m3u8: null, referer: null, userAgent: null,
    concurrency: 16, timeout: 30, quality: 'best', probe: false,
    headed: false, keepTemp: false, cookie: null, ffmpeg: null, verify: true,
    period: null, progressJson: false,
  };
  const need = (i, name) => {
    if (i + 1 >= argv.length) { console.error(`参数 ${name} 缺少值`); process.exit(2); }
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '--help': console.log(HELP); process.exit(0); break;
      case '-o': case '--output': o.output = need(i, a); i++; break;
      case '-m': case '--m3u8': o.m3u8 = need(i, a); i++; break;
      case '--referer': o.referer = need(i, a); i++; break;
      case '--user-agent': o.userAgent = need(i, a); i++; break;
      case '-c': case '--concurrency': o.concurrency = parseInt(need(i, a), 10); i++; break;
      case '-t': case '--timeout': o.timeout = parseInt(need(i, a), 10); i++; break;
      case '--quality': o.quality = need(i, a); i++; break;
      case '--period': o.period = parseInt(need(i, a), 10); i++; break;
      case '--progress-json': o.progressJson = true; break;
      case '--probe': o.probe = true; break;
      case '--headed': o.headed = true; break;
      case '--keep-temp': o.keepTemp = true; break;
      case '--cookie': o.cookie = need(i, a); i++; break;
      case '--ffmpeg': o.ffmpeg = need(i, a); i++; break;
      case '--no-verify': o.verify = false; break;
      default:
        if (a.startsWith('-')) { console.error(`未知参数: ${a}\n${HELP}`); process.exit(2); }
        else o.url = a;
    }
  }
  if (!o.url && !o.m3u8) { console.error('必须提供页面 URL 或 --m3u8\n' + HELP); process.exit(2); }
  if (!Number.isFinite(o.concurrency) || o.concurrency < 1) o.concurrency = 16;
  if (!Number.isFinite(o.timeout) || o.timeout < 1) o.timeout = 30;
  return o;
}

// ───────────────────────────── 通用工具 ─────────────────────────────

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const C = {
  dim: s => `\x1b[2m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  grn: s => `\x1b[32m${s}\x1b[0m`,
  yel: s => `\x1b[33m${s}\x1b[0m`,
  cyn: s => `\x1b[36m${s}\x1b[0m`,
  b: s => `\x1b[1m${s}\x1b[0m`,
};
const log = (...a) => console.log(...a);
const info = (m) => log(`${C.cyn('›')} ${m}`);
const ok = (m) => log(`${C.grn('✓')} ${m}`);
const warn = (m) => log(`${C.yel('!')} ${m}`);

// ── 机器可读进度（--progress-json）──────────────────────────────────────
// 给人看的输出照旧走 stdout；进度事件带 @@HLSDL@@ 前缀走 stderr。
// 这样正常输出完全不受影响，外部程序（比如 GUI）逐行找前缀就能解析。
const PROGRESS_TAG = '@@HLSDL@@ ';
let PROGRESS_JSON = false;
function emitProgress(obj) {
  if (!PROGRESS_JSON) return;
  try { process.stderr.write(PROGRESS_TAG + JSON.stringify(obj) + '\n'); } catch { /* ignore */ }
}

const die = (m) => {
  console.error(`${C.red('✗')} ${m}`);
  emitProgress({ t: 'error', message: String(m) });
  process.exit(1);
};

function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function fmtTime(sec) {
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  return `${m}分${s % 60}秒`;
}

function sanitizeName(s) {
  return String(s).replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\.+$/, '').slice(0, 120) || 'video';
}

function findChrome() {
  const cands = process.platform === 'win32' ? [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ] : [
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ];
  for (const p of cands) { try { if (fs.existsSync(p)) return p; } catch { /* ignore */ } }
  return null;
}

function findFfmpeg(explicit) {
  if (explicit) return explicit;
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [exe], { encoding: 'utf8' });
  if (r.status === 0) {
    const first = r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
    if (first) return first;
  }
  return exe; // 交给 PATH 解析
}

// 直链媒体文件（非分片流）
const DIRECT_MEDIA_RE = /\.(mp4|webm|mkv|mov|flv|m4v|avi)(\?|$)/i;
function isDirectMedia(url) {
  if (!url || url.startsWith('blob:') || url.startsWith('data:')) return false;
  return DIRECT_MEDIA_RE.test(url);
}

// 带自定义头的请求（header 完全可控，这是相对 ffmpeg 的核心优势）
async function httpGet(url, opts, extraHeaders = {}) {
  const { referer, userAgent, cookie, timeout = 30 } = opts;
  const headers = { 'User-Agent': userAgent || DEFAULT_UA, Accept: '*/*', ...extraHeaders };
  if (referer) headers.Referer = referer;
  if (cookie) headers.Cookie = cookie;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout * 1000);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal, redirect: 'follow' });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${res.statusText}`);
      err.status = res.status;
      throw err;
    }
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function retry(fn, times = 3, delayMs = 700) {
  let last;
  for (let i = 0; i < times; i++) {
    try { return await fn(i); }
    catch (e) { last = e; if (i < times - 1) await sleep(delayMs * (i + 1)); }
  }
  throw last;
}

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  }));
  return out;
}

// ─────────────────────────── 第 1 步：CDP 嗅探 ───────────────────────────

async function sniff(pageUrl, opts) {
  const chromePath = findChrome();
  if (!chromePath) die('找不到 Chrome / Edge，请安装后重试；或改用 --m3u8 直接指定清单地址');

  const port = 9333 + Math.floor(Math.random() * 500);
  const profile = path.join(os.tmpdir(), `hlsdl-${Date.now()}`);
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,800',
    `--user-agent=${opts.userAgent || DEFAULT_UA}`,
    'about:blank',
  ];
  if (!opts.headed) args.unshift('--headless=new');

  const chrome = spawn(chromePath, args, { stdio: 'ignore' });
  const cleanup = () => {
    try { chrome.kill(); } catch { /* ignore */ }
    setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } }, 500);
  };
  process.on('exit', cleanup);

  // 等 CDP 就绪
  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json`);
      const list = await r.json();
      target = list.find(t => t.type === 'page');
      if (target) break;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  if (!target) { cleanup(); die('Chrome 远程调试端口未就绪'); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  const seen = new Map();      // requestId -> {url,type,mime,status}
  const m3u8Order = [];        // 按出现顺序记录 m3u8
  const mpdOrder = [];         // 按出现顺序记录 DASH 清单
  const mediaOrder = [];       // 按出现顺序记录直链媒体（mp4 等）

  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
    if (m.method === 'Network.requestWillBeSent') {
      const url = m.params.request.url;
      seen.set(m.params.requestId, { url, type: m.params.type });
      if (/\.m3u8(\?|$)/i.test(url) || /mpegurl/i.test(m.params.type || '')) {
        if (!m3u8Order.includes(url)) m3u8Order.push(url);
      } else if (/\.mpd(\?|$)/i.test(url)) {
        if (!mpdOrder.includes(url)) mpdOrder.push(url);
      } else if (isDirectMedia(url)) {
        if (!mediaOrder.includes(url)) mediaOrder.push(url);
      }
    }
    if (m.method === 'Network.responseReceived') {
      const rec = seen.get(m.params.requestId);
      if (rec) { rec.status = m.params.response.status; rec.mime = m.params.response.mimeType; }
    }
  };

  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('连接 Chrome 调试端口超时')), 15000);
    ws.onopen = () => { clearTimeout(t); res(); };
    ws.onerror = (e) => { clearTimeout(t); rej(e instanceof Error ? e : new Error('WebSocket 连接失败')); };
  });
  await send('Network.enable');
  await send('Page.enable');
  await send('Runtime.enable');
  info(`打开页面: ${pageUrl}`);
  await send('Page.navigate', { url: pageUrl });

  // 轮询等目标出现（清单类优先；只有直链媒体时多给 4 秒看会不会再冒出清单）
  const deadline = Date.now() + 25000;
  let clicked = false;
  let mediaSeenAt = 0;
  const hasManifest = () => m3u8Order.length > 0 || mpdOrder.length > 0;
  while (Date.now() < deadline) {
    await sleep(500);
    if (hasManifest()) break;
    if (mediaOrder.length > 0) {
      if (!mediaSeenAt) mediaSeenAt = Date.now();
      if (Date.now() - mediaSeenAt > 4000) break;
    }
    if (!clicked && Date.now() > deadline - 17000) {
      clicked = true;
      try {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 640, y: 400, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 640, y: 400, button: 'left', clickCount: 1 });
      } catch { /* ignore */ }
    }
  }

  if (!hasManifest() && mediaOrder.length === 0) {
    warn('页面里没抓到视频地址，尝试点一下播放区再等一会儿…');
    try {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 640, y: 400, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 640, y: 400, button: 'left', clickCount: 1 });
    } catch { /* ignore */ }
    await sleep(8000);
  }

  // 顺带从 DOM 里再捞一把
  let domUrls = [];
  try {
    const r = await send('Runtime.evaluate', {
      expression: `(() => { const o=[]; try{ document.querySelectorAll('video').forEach(v=>{ if(v.src)o.push(v.src); v.querySelectorAll('source').forEach(s=>{ if(s.src)o.push(s.src); }); }); }catch(e){} const m=document.documentElement.innerHTML.match(/https?:[^"'\\s]+\\.(m3u8|mpd|mp4|webm|mkv|mov|flv|m4v)[^"'\\s]*/g); if(m)m.forEach(x=>o.push(x)); return o.join('\\n'); })()`,
      returnByValue: true,
    });
    domUrls = (r.result.value || '').split('\n').map(s => s.trim()).filter(Boolean);
  } catch { /* ignore */ }

  for (const u of domUrls) {
    if (u.startsWith('blob:')) continue;
    if (/\.m3u8/i.test(u)) { if (!m3u8Order.includes(u)) m3u8Order.push(u); }
    else if (/\.mpd/i.test(u)) { if (!mpdOrder.includes(u)) mpdOrder.push(u); }
    else if (isDirectMedia(u) && !mediaOrder.includes(u)) mediaOrder.push(u);
  }

  try { ws.close(); } catch { /* ignore */ }
  cleanup();

  return { candidates: m3u8Order, mpd: mpdOrder, media: mediaOrder, requests: [...seen.values()] };
}

// ─────────────────────── 第 2 步：解析清单 / 选流 ───────────────────────

function parseAttrs(line) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(line))) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}

async function fetchPlaylist(url, opts) {
  const buf = await retry(() => httpGet(url, opts), 3);
  return buf.toString('utf8');
}

async function resolveMediaPlaylist(url, opts) {
  const text = await fetchPlaylist(url, opts);
  const lines = text.split(/\r?\n/).map(l => l.trim());

  // master playlist：选一路码率
  if (lines.some(l => l.startsWith('#EXT-X-STREAM-INF'))) {
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
      const attrs = parseAttrs(lines[i]);
      let next = i + 1;
      while (next < lines.length && (!lines[next] || lines[next].startsWith('#'))) next++;
      if (next >= lines.length) continue;
      variants.push({
        url: new URL(lines[next], url).href,
        bandwidth: parseInt(attrs.BANDWIDTH || attrs['AVERAGE-BANDWIDTH'] || '0', 10),
        resolution: attrs.RESOLUTION || '',
      });
    }
    if (variants.length === 0) throw new Error('master playlist 里没解析出可用码流');
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    const q = opts.quality;
    let pick = variants[0];
    if (q === 'worst') pick = variants[variants.length - 1];
    else if (q && q !== 'best') {
      const found = variants.find(v => v.resolution === q) ||
        variants.find(v => String(v.bandwidth) === String(q));
      if (found) pick = found;
      else warn(`没有匹配 "${q}" 的码流，回退到最高码率`);
    }
    info(`master 清单含 ${variants.length} 路码流，选中 ${pick.resolution || pick.bandwidth + 'bps'}`);
    const sub = await resolveMediaPlaylist(pick.url, opts);
    sub.pickedVariant = pick;
    return sub;
  }

  // media playlist
  const segs = [];
  let key = null;            // 当前生效的加密信息
  let initSegment = null;    // #EXT-X-MAP
  let mediaSequence = 0;
  let dur = 0;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) mediaSequence = parseInt(line.split(':')[1], 10) || 0;
    else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(line.slice(11));
      if (!a.METHOD || a.METHOD === 'NONE') key = null;
      else if (a.METHOD === 'AES-128') key = { method: 'AES-128', uri: a.URI ? new URL(a.URI, url).href : null, iv: a.IV || null };
      else key = { method: a.METHOD, uri: a.URI ? new URL(a.URI, url).href : null, iv: a.IV || null, unsupported: true };
    }
    else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(line.slice(11));
      if (a.URI) initSegment = new URL(a.URI, url).href;
    }
    else if (line.startsWith('#EXTINF:')) dur = parseFloat(line.split(':')[1]) || 0;
    else if (line && !line.startsWith('#')) {
      segs.push({
        url: new URL(line, url).href,
        duration: dur,
        seq: mediaSequence + segs.length,
        key: key ? { ...key } : null,
      });
    }
  }

  if (segs.length === 0) throw new Error('清单里没有切片');

  const encrypted = segs.some(s => s.key);
  const unsupported = segs.some(s => s.key && s.key.unsupported);

  return {
    playlistUrl: url,
    segments: segs,
    initSegment,
    encrypted,
    unsupported,
    isFmp4: segs.some(s => /\.(m4s|mp4|cmfv|cmfa)(\?|$)/i.test(s.url)) || !!initSegment,
    totalDuration: segs.reduce((a, s) => a + s.duration, 0),
  };
}

// ─────────────────────── 第 3 步：解密 / 下载切片 ───────────────────────

function deriveIv(seq) {
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(seq >>> 0, 12);
  return iv;
}

function aesCbcDecrypt(buf, key, iv) {
  const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([d.update(buf), d.final()]);
}

async function downloadSegments(pl, opts, tmpDir) {
  const segDir = path.join(tmpDir, 'seg');
  fs.mkdirSync(segDir, { recursive: true });

  // 缓存密钥，避免每个切片都请求一次
  const keyCache = new Map();
  const getKey = async (uri) => {
    if (!keyCache.has(uri)) keyCache.set(uri, await retry(() => httpGet(uri, opts), 3));
    return keyCache.get(uri);
  };

  // 清单的查询串（某些站点切片也要带签名，裸下 403 时回退用）
  let plQuery = '';
  try { plQuery = new URL(pl.playlistUrl).search; } catch { /* ignore */ }

  const total = pl.segments.length;
  let done = 0, failed = 0, bytes = 0;
  const errors = [];
  const t0 = Date.now();

  const isTTY = process.stdout.isTTY;
  let lastDraw = 0, lastEmit = 0;
  const draw = (force) => {
    const now = Date.now();
    // 进度事件与 TTY 无关：管道/重定向时也要发，否则 GUI 只能干等
    if (force || now - lastEmit >= 150 || done + failed === total) {
      lastEmit = now;
      emitProgress({ t: 'seg', label: '切片', done: done + failed, total, bytes, failed });
    }
    if (!isTTY) return;                    // 管道/重定向时不要刷 \r
    if (!force && now - lastDraw < 120) return;
    lastDraw = now;
    const pct = ((done + failed) / total * 100).toFixed(1);
    const speed = bytes / Math.max(0.001, (Date.now() - t0) / 1000);
    process.stdout.write(`\r  进度 ${String(done + failed).padStart(String(total).length)}/${total} (${pct}%)  ${humanSize(bytes)}  ${humanSize(speed)}/s    `);
  };

  // fMP4 的初始化段（#EXT-X-MAP）必须先取，且要拼在最前面
  if (pl.initSegment) {
    try {
      const raw = await retry(() => httpGet(pl.initSegment, opts), 3);
      fs.writeFileSync(path.join(segDir, 'seg_init.bin'), raw);
    } catch (e) {
      throw new Error(`初始化段下载失败: ${e.message}`);
    }
  }

  const tasks = pl.segments.map((seg, idx) => async () => {
    const file = path.join(segDir, `seg${String(idx).padStart(5, '0')}.bin`);
    try {
      let raw = await retry(async () => {
        try {
          return await httpGet(seg.url, opts);
        } catch (e) {
          // 裸下失败时带上清单签名再试
          if (plQuery && (e.status === 403 || e.status === 401)) {
            const u = seg.url.includes('?') ? `${seg.url}&${plQuery.slice(1)}` : `${seg.url}${plQuery}`;
            return await httpGet(u, opts);
          }
          throw e;
        }
      }, 3);

      if (seg.key) {
        if (seg.key.unsupported) throw new Error(`不支持的加密方式 ${seg.key.method}`);
        const key = await getKey(seg.key.uri);
        const iv = seg.key.iv ? Buffer.from(seg.key.iv.replace(/^0x/i, ''), 'hex') : deriveIv(seg.seq);
        raw = aesCbcDecrypt(raw, key, iv);
      }

      fs.writeFileSync(file, raw);
      bytes += raw.length;
      done++;
    } catch (e) {
      failed++;
      errors.push(`#${idx} ${e.message}`);
    }
    draw();
  });

  await pool(tasks, opts.concurrency, fn => fn());
  draw(true);
  if (isTTY) process.stdout.write('\n');
  else log(`  已下载 ${done}/${total} 个切片，失败 ${failed} 个，共 ${humanSize(bytes)}`);

  return { segDir, total, done, failed, errors };
}

// ───────────────────────────── DASH (MPD) ─────────────────────────────
// 不引第三方 XML 库，MPD 结构足够规整，用定点提取即可。

function parseXmlAttrs(tag) {
  const out = {};
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(tag))) out[m[1]] = m[2];
  return out;
}

function xmlText(xml, tag) {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? m[1].trim() : null;
}

// 提取所有 <tag ...>...</tag> 或 <tag .../>，返回 [{attrs, inner}]
function xmlBlocks(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b([^>]*?)(/?)>`, 'g');
  let m;
  while ((m = re.exec(xml))) {
    const attrs = parseXmlAttrs(m[1]);
    let inner = '';
    if (m[2] !== '/') {
      const close = `</${tag}>`;
      const end = xml.indexOf(close, re.lastIndex);
      if (end >= 0) { inner = xml.slice(re.lastIndex, end); re.lastIndex = end + close.length; }
    }
    out.push({ attrs, inner });
  }
  return out;
}

// ISO 8601 时长 → 秒，如 PT1H2M3.5S
function iso8601ToSeconds(s) {
  if (!s) return 0;
  const m = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(s).trim());
  if (!m) return 0;
  const [Y, Mo, D, H, Mi, S] = m.slice(1).map(v => parseFloat(v || '0'));
  return (Y || 0) * 31536000 + (Mo || 0) * 2592000 + (D || 0) * 86400
    + (H || 0) * 3600 + (Mi || 0) * 60 + (S || 0);
}

function resolveUrl(base, ref) {
  if (!ref) return base;
  try { return new URL(ref, base).href; } catch { return ref; }
}

// 替换 $Number$ / $Time$ / $RepresentationID$ / $Bandwidth$，支持 $Number%05d$ 补零
function fillTemplate(tpl, vars) {
  return String(tpl)
    .replace(/\$\$|\$(\w+)(?:%0(\d+)d)?\$/g, (m, name, pad) => {
      if (m === '$$') return '$';
      if (vars[name] === undefined) return m;
      const v = String(vars[name]);
      return pad ? v.padStart(parseInt(pad, 10), '0') : v;
    });
}

function classifyTrack(mime, codecs) {
  if (/^video\//i.test(mime) || /^(avc|hev|hvc|vp0?8|vp0?9|av01|dvh|dav1)/i.test(codecs)) return 'video';
  if (/^audio\//i.test(mime) || /^(mp4a|opus|vorbis|ac-3|ec-3|flac|dts)/i.test(codecs)) return 'audio';
  return null;
}

function fillFromTemplate(rep, tpl, duration) {
  const a = tpl.attrs;
  const timescale = parseInt(a.timescale || '1', 10) || 1;
  const vars = { RepresentationID: rep.id, Bandwidth: rep.bandwidth };
  if (a.initialization) rep.init = resolveUrl(rep.base, fillTemplate(a.initialization, vars));

  const timeline = xmlBlocks(tpl.inner, 'SegmentTimeline')[0];
  const startNumber = parseInt(a.startNumber || '1', 10);
  const urls = [];

  if (timeline) {
    // $Time$ 模式（SegmentTimeline）
    let time = 0;
    for (const s of xmlBlocks(timeline.inner, 'S')) {
      const t = s.attrs.t !== undefined ? parseInt(s.attrs.t, 10) : time;
      const d = parseInt(s.attrs.d || '0', 10);
      const r = parseInt(s.attrs.r || '0', 10);
      time = t;
      for (let i = 0; i <= r; i++) {
        urls.push(resolveUrl(rep.base, fillTemplate(a.media, {
          ...vars, Time: time, Number: startNumber + urls.length,
        })));
        time += d;
      }
    }
  } else {
    // $Number$ 模式
    const segDur = parseInt(a.duration || '0', 10);
    const start = startNumber;
    let count = 0;
    if (segDur > 0 && duration > 0) count = Math.ceil(duration * timescale / segDur);
    else if (a.endNumber) count = parseInt(a.endNumber, 10) - start + 1;
    if (count <= 0) throw new Error('无法推算切片数量（既没有时长也没有 endNumber）');
    for (let i = 0; i < count; i++) {
      urls.push(resolveUrl(rep.base, fillTemplate(a.media, {
        ...vars, Number: start + i, Time: Math.round(i * segDur),
      })));
    }
  }
  rep.segments = urls;
}

function fillFromList(rep, list, base) {
  const initEl = xmlBlocks(list.inner, 'Initialization')[0];
  const entries = xmlBlocks(list.inner, 'SegmentURL');
  const withMedia = entries.filter(s => s.attrs.media);

  if (withMedia.length > 0) {
    if (initEl && initEl.attrs.sourceURL) rep.init = resolveUrl(base, initEl.attrs.sourceURL);
    rep.segments = withMedia.map(s => resolveUrl(base, s.attrs.media));
    return;
  }

  // 只有 mediaRange / indexRange（单文件 + 字节范围）：
  // 所有分片都在同一个文件里，整文件下载即可。
  if (entries.some(s => s.attrs.mediaRange)) {
    if (!base || /\/$/.test(base)) throw new Error('SegmentList 用字节范围寻址但缺少 BaseURL');
    rep.init = null;
    rep.segments = [base];
    rep.mode = 'SegmentList(整文件)';
    return;
  }

  rep.segments = [];
}

function parseMpd(xml, mpdUrl) {
  const mpdTag = /<MPD\b([^>]*)>/.exec(xml);
  if (!mpdTag) throw new Error('不是合法的 MPD（找不到 <MPD> 标签）');
  const mpdAttrs = parseXmlAttrs(mpdTag[1]);

  const periodBlocks = xmlBlocks(xml, 'Period');
  if (periodBlocks.length === 0) throw new Error('MPD 里没有 Period');

  const duration = iso8601ToSeconds(mpdAttrs.mediaPresentationDuration)
    || iso8601ToSeconds(periodBlocks[0].attrs.duration) || 0;

  // 每个 Period 各自的时长：优先 @duration；没有就用下一个 Period 的 @start 推；
  // 最后一个用 MPD 总时长减它的起点。都推不出来就退回 MPD 总时长——$Number$
  // 模式会因此多算几段，但 404 容错兜得住，代价只是几个无用请求。
  const periodDuration = (i) => {
    const own = iso8601ToSeconds(periodBlocks[i].attrs.duration);
    if (own > 0) return own;
    const start = iso8601ToSeconds(periodBlocks[i].attrs.start);
    if (i + 1 < periodBlocks.length) {
      const next = iso8601ToSeconds(periodBlocks[i + 1].attrs.start);
      if (next > start) return next - start;
    }
    if (duration > start) return duration - start;
    return duration;
  };

  const periods = [];

  for (let pi = 0; pi < periodBlocks.length; pi++) {
    const period = periodBlocks[pi];
    const periodBase = resolveUrl(mpdUrl, xmlText(period.inner, 'BaseURL') || '');
    const pDur = periodDuration(pi);
    const tracks = { video: [], audio: [] };

    for (const set of xmlBlocks(period.inner, 'AdaptationSet')) {
      const setBase = xmlText(set.inner, 'BaseURL');
      const setMime = set.attrs.mimeType || '';
      const setCodecs = set.attrs.codecs || '';
      const setTemplate = xmlBlocks(set.inner, 'SegmentTemplate')[0] || null;
      const setList = xmlBlocks(set.inner, 'SegmentList')[0] || null;
      const setBaseEl = xmlBlocks(set.inner, 'SegmentBase')[0] || null;

      for (const rep of xmlBlocks(set.inner, 'Representation')) {
        const mime = rep.attrs.mimeType || setMime || '';
        const codecs = rep.attrs.codecs || setCodecs || '';
        const type = classifyTrack(mime, codecs);
        if (!type) continue;

        const tpl = xmlBlocks(rep.inner, 'SegmentTemplate')[0] || setTemplate;
        const list = xmlBlocks(rep.inner, 'SegmentList')[0] || setList;
        const baseEl = xmlBlocks(rep.inner, 'SegmentBase')[0] || setBaseEl;
        const base = resolveUrl(periodBase, xmlText(rep.inner, 'BaseURL') || setBase || '');

        const info = {
          id: rep.attrs.id || '',
          type, mime, codecs, base, init: null, segments: [], mode: '',
          bandwidth: parseInt(rep.attrs.bandwidth || '0', 10) || 0,
          width: parseInt(rep.attrs.width || '0', 10) || 0,
          height: parseInt(rep.attrs.height || '0', 10) || 0,
        };

        try {
          // mode 先给默认值，具体实现里可以覆盖成更精确的描述
          if (tpl) { info.mode = 'SegmentTemplate'; fillFromTemplate(info, tpl, pDur); }
          else if (list) { info.mode = 'SegmentList'; fillFromList(info, list, base); }
          else if (baseEl) {
            // 单文件 + 字节范围：整文件下载即可（fMP4 自带初始化信息）
            if (!base || /\/$/.test(base)) throw new Error('SegmentBase 模式缺少 BaseURL');
            info.segments = [base]; info.mode = 'SegmentBase(整文件)';
          } else {
            if (!base || /\/$/.test(base)) throw new Error('既没有分片模板也没有可用的 BaseURL');
            info.segments = [base]; info.mode = '单文件';
          }
        } catch (e) {
          warn(`跳过一条 ${type} 轨道（${rep.attrs.id || '无 id'}）: ${e.message}`);
          continue;
        }

        if (info.segments.length === 0) continue;
        tracks[type].push(info);
      }
    }

    // 只保留真解析出轨道的 Period；多 Period 清单按顺序全部保留
    if (tracks.video.length || tracks.audio.length) {
      periods.push({
        id: period.attrs.id || '',
        duration: pDur,
        video: tracks.video,
        audio: tracks.audio,
      });
    }
  }

  if (periods.length === 0) {
    throw new Error('MPD 里没有解析出可用的音视频轨道');
  }
  return { duration, periods };
}

function concatFiles(files, out) {
  const fd = fs.openSync(out, 'w');
  try {
    for (const f of files) {
      if (!fs.existsSync(f)) continue;
      if (fs.statSync(f).size === 0) continue;
      fs.writeSync(fd, fs.readFileSync(f));
    }
  } finally { fs.closeSync(fd); }
  return out;
}

// ── MP4 分层索引（sidx / ssix）剥离 ─────────────────────────────────────────
// 有些 DASH 单文件轨道（isoff-on-demand profile，Representation 里只有 <BaseURL>）
// 是「分层索引」MP4：顶层 sidx 的引用类型是 1——指向下一级 sidx，而不是媒体数据。
// ffmpeg 直到 8.x 都没实现 type-1 引用，读到就拒开文件：
//   [mov,mp4] sidx reference_type 1 is not implemented ... Error opening input
// 而 sidx / ssix 只是给播放器做字节寻址的索引，顺序解码根本不需要。把它们摘掉，
// ffmpeg 顺着 moof/mdat 自然顺序就能读——实测全片解码零错误。
//
// 安全前提：只有每个 moof 里的 tfhd 都是 default-base-is-moof（媒体偏移相对 moof
// 起点）时，删掉前置字节才不会让偏移错位。任何一项检查不过就原样不动，宁可让
// ffmpeg 报错，也不写坏文件。
function walkBoxes(d, start, end, cb) {
  let off = start;
  while (off + 8 <= end) {
    let size = d.readUInt32BE(off);
    const type = d.toString('latin1', off + 4, off + 8);
    let hdr = 8;
    if (size === 1) {
      if (off + 16 > end) return;
      size = Number(d.readBigUInt64BE(off + 8));
      hdr = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < hdr || off + size > end) return;
    cb(off, size, type, hdr);
    off += size;
  }
}

function sidxHasType1(d, off, size, hdr) {
  const body = off + hdr;
  const ver = d[body];
  const p = ver === 0 ? body + 20 : body + 28;
  if (p + 4 > off + size) return false;
  const cnt = d.readUInt16BE(p + 2);
  for (let i = 0, q = p + 4; i < cnt && q + 12 <= off + size; i++, q += 12) {
    if (d[q] & 0x80) return true;   // reference_type 占 32 位引用的最高位
  }
  return false;
}

function tfhdIsMoofRelative(d, moof) {
  let safe = true;
  walkBoxes(d, moof.off + moof.hdr, moof.off + moof.size, (o, s, t, h) => {
    if (t !== 'traf') return;
    walkBoxes(d, o + h, o + s, (o2, s2, t2, h2) => {
      if (t2 !== 'tfhd') return;
      const flags = d.readUInt32BE(o2 + h2) & 0xffffff;
      if (flags & 0x000001) safe = false;   // base-data-offset-present：绝对偏移，删字节会错位
    });
  });
  return safe;
}

function stripMp4Index(file) {
  const fd = fs.openSync(file, 'r');
  let magic = '';
  try {
    const buf = Buffer.alloc(12);
    if (fs.readSync(fd, buf, 0, 12, 0) >= 8) magic = buf.toString('latin1', 4, 8);
  } finally { fs.closeSync(fd); }
  // 只处理 MP4（TS 文件开头是 0x47 同步字节），避免把上百 MB 的 TS 读进内存
  if (magic !== 'ftyp') return { stripped: 0, reason: 'not-mp4' };

  const d = fs.readFileSync(file);
  const boxes = [];
  let needStrip = false;
  walkBoxes(d, 0, d.length, (off, size, type, hdr) => {
    boxes.push({ off, size, type, hdr });
    if (type === 'sidx' && sidxHasType1(d, off, size, hdr)) needStrip = true;
  });

  if (!needStrip) return { stripped: 0, reason: 'no-type1' };
  // 盒子必须完整覆盖整个文件，否则说明结构没吃透，不动
  if (boxes.reduce((n, b) => n + b.size, 0) !== d.length) return { stripped: 0, reason: 'trailing-bytes' };

  const moof = boxes.find(b => b.type === 'moof');
  if (moof && !tfhdIsMoofRelative(d, moof)) return { stripped: 0, reason: 'absolute-offsets' };

  const keep = boxes.filter(b => b.type !== 'sidx' && b.type !== 'ssix');
  fs.writeFileSync(file, Buffer.concat(keep.map(b => d.subarray(b.off, b.off + b.size))));
  return { stripped: boxes.length - keep.length, reason: 'ok' };
}

// 对每个待封装的输入做一次索引剥离，把结果说清楚（成功/为何跳过）
function sanitizeInputs(files) {
  for (const f of files) {
    const r = stripMp4Index(f);
    if (r.reason === 'ok') {
      info(`已剥离分层索引（sidx/ssix ×${r.stripped}）：${path.basename(f)}`);
    } else if (r.reason === 'absolute-offsets' || r.reason === 'trailing-bytes') {
      warn(`${path.basename(f)} 是分层索引 MP4，但结构不允许安全剥离（${r.reason}），保持原样`);
    }
  }
}

async function fetchTrack(rep, opts, tmpDir, label) {
  const dir = path.join(tmpDir, 'dash-' + label);
  fs.mkdirSync(dir, { recursive: true });

  const files = [];
  if (rep.init) {
    const b = await retry(() => httpGet(rep.init, opts), 3);
    const f = path.join(dir, 'init.bin');
    fs.writeFileSync(f, b);
    files.push(f);
  }

  const total = rep.segments.length;
  const isTTY = process.stdout.isTTY;
  let done = 0, failed = 0, missing = 0, bytes = 0;
  let lastEmit = 0;
  const tick = (force) => {
    const now = Date.now();
    if (force || now - lastEmit >= 150 || done + failed + missing === total) {
      lastEmit = now;
      emitProgress({ t: 'seg', label, done: done + failed + missing, total, bytes, failed, missing });
    }
    if (isTTY) process.stdout.write(`\r  ${label} ${done + failed + missing}/${total}  ${humanSize(bytes)}    `);
  };

  const segFiles = await pool(rep.segments.map((u, i) => async () => {
    const f = path.join(dir, `s${String(i).padStart(5, '0')}.bin`);
    try {
      const b = await retry(() => httpGet(u, opts), 3);
      fs.writeFileSync(f, b);
      done++; bytes += b.length;
    } catch (e) {
      // $Number$ 模式是按 @duration 推算段数的，实际段数更少时尾部会 404。
      // 这属于正常截断，不能当成下载失败——否则整个轨道会被误判为失败。
      if (e && e.status === 404) missing++; else failed++;
      tick();
      return null;
    }
    tick();
    return f;
  }), opts.concurrency, fn => fn());

  tick(true);
  if (isTTY) process.stdout.write('\n');
  else log(`  ${label}: ${done}/${total} 个切片，${humanSize(bytes)}`);

  if (missing > 0) warn(`${label}轨道有 ${missing} 个切片返回 404（清单声明的段数多于实际，按正常截断处理）`);
  if (failed > 0) warn(`${label}轨道有 ${failed}/${total} 个切片下载失败`);
  if (done === 0) die(`${label}轨道一个切片都没下下来`);
  if (failed > total * 0.05) die(`${label}轨道失败比例过高，中止`);

  return files.concat(segFiles.filter(Boolean));
}

function pickTrack(list, quality) {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => b.bandwidth - a.bandwidth);
  if (quality && quality !== 'best') {
    if (quality === 'worst') return sorted[sorted.length - 1];
    const hit = sorted.find(r => r.width && `${r.width}x${r.height}` === quality)
      || sorted.find(r => String(r.bandwidth) === String(quality));
    if (hit) return hit;
    warn(`没有匹配 "${quality}" 的轨道，回退到最高码率`);
  }
  return sorted[0];
}

// 把已拼好的整轨文件无损混流成一个 MP4
function muxInputs(inputs, outFile, ffmpeg) {
  const args = ['-hide_banner', '-loglevel', 'warning', '-y'];
  for (const f of inputs) args.push('-i', f);
  args.push('-c', 'copy', '-movflags', '+faststart', outFile);
  const r = spawnSync(ffmpeg, args, { encoding: 'utf8' });
  if (r.status === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 0) return;

  let msg = (r.stderr || '').trim();
  if (/sidx reference_type 1 is not implemented/.test(msg)) {
    msg += '\n提示：该轨道是 ffmpeg 不支持的分层索引 MP4（sidx type-1 引用），自动剥离没生效。'
      + '可换一个 Representation（--quality），或用 MP4Box / GPAC 手动剥掉 sidx 后再封装。';
  }
  die(`ffmpeg 混流失败（退出码 ${r.status}）\n${msg}`);
}

// 用 concat 解复用器把多个 MP4 按序拼成一个（无损，要求各段编码参数一致）
function concatMp4(parts, outFile, ffmpeg) {
  const listFile = path.join(path.dirname(parts[0]), 'concat-list.txt');
  // concat 解复用器自己的转义规则：单引号要写成 '\''
  const esc = (p) => p.replace(/\\/g, '/').replace(/'/g, "'\\''");
  fs.writeFileSync(listFile, parts.map(p => `file '${esc(p)}'`).join('\n') + '\n');

  const r = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'warning', '-y',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c', 'copy', '-movflags', '+faststart', outFile,
  ], { encoding: 'utf8' });
  if (r.status === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 0) {
    return { ok: true };
  }

  // 无损拼接失败，多半是各 Period 的分辨率 / 编码参数不一致。
  // 不硬凑——把每个 Period 单独存出来交给用户，也比给个坏文件强。
  const dir = path.dirname(outFile);
  const stem = path.basename(outFile).replace(/\.mp4$/i, '');
  const saved = [];
  parts.forEach((p, i) => {
    const dst = path.join(dir, `${stem}.period${i + 1}.mp4`);
    try { fs.copyFileSync(p, dst); saved.push(dst); } catch { /* 存不出来就算了 */ }
  });
  return { ok: false, saved, stderr: (r.stderr || '').trim() };
}

async function runDash(mpdUrl, netOpts, opts, tmpDir, ffmpeg, ffprobe) {
  info('拉取 MPD 清单…');
  const xml = (await retry(() => httpGet(mpdUrl, netOpts), 3)).toString('utf8');
  const mpd = parseMpd(xml, mpdUrl);

  const allPeriods = mpd.periods;
  let periods = allPeriods;
  if (opts.period) {
    const n = opts.period;
    if (!Number.isInteger(n) || n < 1 || n > allPeriods.length) {
      die(`--period ${opts.period} 无效：清单里有 ${allPeriods.length} 个 Period（可选 1-${allPeriods.length}）`);
    }
    periods = [allPeriods[n - 1]];
  }
  const multi = periods.length > 1;

  log('');
  ok(`选中 DASH 流: ${C.b(path.basename((() => { try { return new URL(mpdUrl).pathname; } catch { return 'index.mpd'; } })()) || 'index.mpd')}`);
  if (multi) warn(`清单含 ${periods.length} 个 Period，将按顺序全部下载后拼接`);
  else if (opts.period && allPeriods.length > 1) {
    info(`按 --period 只下第 ${opts.period} 个 Period（清单共 ${allPeriods.length} 个）`);
  }

  const chosen = periods.map((per, i) => {
    const video = pickTrack(per.video, opts.quality);
    const audio = pickTrack(per.audio, null);
    const pad = multi ? '    ' : '  ';
    if (multi) log(`  Period ${i + 1}${per.id ? ` (${per.id})` : ''}${per.duration ? `  ${fmtTime(per.duration)}` : ''}`);
    if (video) {
      log(`${pad}视频      ${video.width ? video.width + 'x' + video.height + '  ' : ''}${Math.round(video.bandwidth / 1000)} kbps  ${video.codecs}`);
      log(`${pad}视频切片  ${video.segments.length}（${video.mode}）`);
    } else warn(`${pad}该 Period 没有视频轨道，只下音频`);
    if (audio) {
      log(`${pad}音频      ${Math.round(audio.bandwidth / 1000)} kbps  ${audio.codecs}`);
      log(`${pad}音频切片  ${audio.segments.length}（${audio.mode}）`);
    } else warn(`${pad}该 Period 没有音频轨道，只下视频`);
    return { video, audio };
  });
  if (mpd.duration) log(`  总时长    ${fmtTime(mpd.duration)}`);

  // 各 Period 编码参数不一致时，-c copy 拼接出来的文件容器元数据只会记第一段的
  // 参数。实测 ffmpeg 并不会报错（只吐个 Non-monotonic DTS 警告），照样退出 0，
  // 但后半段的分辨率实际对不上——所以必须提前讲清楚，不能等"拼接失败"来兜。
  if (multi) {
    const sig = (t) => (t ? `${t.codecs || '?'} ${t.width ? t.width + 'x' + t.height : ''}`.trim() : '无');
    const vSig = chosen.map(c => sig(c.video));
    const aSig = chosen.map(c => sig(c.audio));
    if (new Set(vSig).size > 1 || new Set(aSig).size > 1) {
      warn('各 Period 的编码参数不一致：无损拼接后画面会在中途切换，'
        + '且容器元数据只记录第一段的参数，部分播放器后半段可能显示异常。');
      chosen.forEach((c, i) => log(C.dim(`      Period ${i + 1}: 视频 ${vSig[i]} / 音频 ${aSig[i]}`)));
      log(C.dim('      想要干净的分段文件，可用 --period N 只下其中一段。'));
    }
  }

  if (opts.probe) {
    log('');
    ok('--probe 模式：仅探测，未下载。');
    return;
  }

  const outFile = path.resolve(opts.output || `${guessName(opts.url, mpdUrl)}.mp4`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  // 下载一个 Period 的音视频轨并各自拼成整轨文件，返回待混流的输入列表
  const fetchPeriod = async (c, tag, labelPrefix) => {
    const vFiles = c.video ? await fetchTrack(c.video, netOpts, tmpDir, `${labelPrefix}视频`) : null;
    const aFiles = c.audio ? await fetchTrack(c.audio, netOpts, tmpDir, `${labelPrefix}音频`) : null;
    const inputs = [];
    if (vFiles && vFiles.length) inputs.push(concatFiles(vFiles, path.join(tmpDir, `dash-${tag}-v.mp4`)));
    if (aFiles && aFiles.length) inputs.push(concatFiles(aFiles, path.join(tmpDir, `dash-${tag}-a.mp4`)));
    if (inputs.length === 0) return null;
    sanitizeInputs(inputs);
    return inputs;
  };

  log('');
  info('开始下载音视频轨道…');

  if (!multi) {
    // 单 Period：直接混流，一步到位
    const inputs = await fetchPeriod(chosen[0], 's', '');
    if (!inputs) die('没有下载到任何轨道');
    info('混流封装…');
    muxInputs(inputs, outFile, ffmpeg);
  } else {
    // 多 Period：每个 Period 先各自封装，再按序拼接
    const parts = [];
    for (let i = 0; i < chosen.length; i++) {
      info(`Period ${i + 1}/${chosen.length}：下载中…`);
      const inputs = await fetchPeriod(chosen[i], `p${i + 1}`, `P${i + 1} `);
      if (!inputs) { warn(`Period ${i + 1} 没有下到任何轨道，跳过`); continue; }
      const part = path.join(tmpDir, `period-${i + 1}.mp4`);
      info(`Period ${i + 1}：封装中…`);
      muxInputs(inputs, part, ffmpeg);
      parts.push(part);
    }
    if (parts.length === 0) die('所有 Period 都没有下到轨道');

    if (parts.length === 1) {
      fs.copyFileSync(parts[0], outFile);
    } else {
      info(`按序拼接 ${parts.length} 个 Period…`);
      const c = concatMp4(parts, outFile, ffmpeg);
      if (!c.ok) {
        die('多 Period 无损拼接失败（各 Period 的分辨率 / 编码参数可能不一致，没法直接接流）。\n'
          + `已把 ${c.saved.length} 个 Period 分别保存到:\n${c.saved.map(s => '  ' + s).join('\n')}`
          + `\n\nffmpeg 输出:\n${c.stderr || '(无)'}`);
      }
    }
  }

  log('');
  ok(`完成: ${C.b(outFile)}`);
  emitProgress({ t: 'result', file: outFile, size: fs.statSync(outFile).size });
  log(`  大小      ${humanSize(fs.statSync(outFile).size)}`);
  if (opts.verify) {
    const dur = probeDuration(ffprobe, outFile);
    if (dur) log(`  时长      ${fmtTime(dur)}`);
    const v = verifyDecode(ffmpeg, outFile);
    if (v.ok) ok('  解码校验  头尾均无错误');
    else warn(`  解码校验  发现问题\n${v.head}\n${v.tail}`);
  }
  if (opts.keepTemp) log(C.dim(`  中间文件保留在 ${tmpDir}`));
  log('');
}

// ─────────────────── 直链媒体下载（mp4 / webm / mkv 等） ───────────────────

async function downloadDirect(url, opts, destFile) {
  const { referer, userAgent, cookie, timeout = 30 } = opts;
  const headers = { 'User-Agent': userAgent || DEFAULT_UA, Accept: '*/*' };
  if (referer) headers.Referer = referer;
  if (cookie) headers.Cookie = cookie;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.max(timeout, 60) * 1000);

  let res;
  try {
    res = await fetch(url, { headers, signal: ctl.signal, redirect: 'follow' });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(`请求失败: ${e.message}`);
  }
  if (!res.ok) {
    clearTimeout(timer);
    const err = new Error(`HTTP ${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }

  const total = parseInt(res.headers.get('content-length') || '0', 10);
  const isTTY = process.stdout.isTTY;
  const t0 = Date.now();
  let got = 0, lastDraw = 0, lastEmit = 0;

  await new Promise((resolve, reject) => {
    const src = Readable.fromWeb(res.body);
    const out = fs.createWriteStream(destFile);
    src.on('data', (chunk) => {
      got += chunk.length;
      const now = Date.now();
      if (now - lastEmit > 150) {
        lastEmit = now;
        emitProgress({ t: 'bytes', label: '直链', done: got, total, bytes: got });
      }
      if (isTTY && now - lastDraw > 120) {
        lastDraw = now;
        const speed = got / Math.max(0.001, (now - t0) / 1000);
        const pct = total ? ` (${(got / total * 100).toFixed(1)}%)` : '';
        process.stdout.write(`\r  进度 ${humanSize(got)}${pct}  ${humanSize(speed)}/s    `);
      }
    });
    src.on('error', reject);
    out.on('error', reject);
    out.on('close', resolve);
    src.pipe(out);
  });
  clearTimeout(timer);
  emitProgress({ t: 'bytes', label: '直链', done: got, total, bytes: got });
  if (isTTY) process.stdout.write('\n');
  else log(`  已下载 ${humanSize(got)}`);

  return { bytes: got, total };
}

// ─────────────────────── 第 4 步：拼接 + 封装 + 校验 ───────────────────────

function concatSegments(pl, segDir, tmpDir) {
  const out = path.join(tmpDir, 'all.bin');
  const fd = fs.openSync(out, 'w');
  try {
    // fMP4 需要先写 init 段
    const initFile = path.join(segDir, 'seg_init.bin');
    if (fs.existsSync(initFile)) fs.writeSync(fd, fs.readFileSync(initFile));

    for (let i = 0; i < pl.segments.length; i++) {
      const f = path.join(segDir, `seg${String(i).padStart(5, '0')}.bin`);
      if (!fs.existsSync(f)) continue;
      const st = fs.statSync(f);
      if (st.size === 0) continue;
      fs.writeSync(fd, fs.readFileSync(f));
    }
  } finally {
    fs.closeSync(fd);
  }
  return out;
}

function remux(ffmpeg, input, output, isFmp4) {
  const args = ['-hide_banner', '-loglevel', 'warning', '-y', '-i', input, '-c', 'copy'];
  if (!isFmp4) args.push('-bsf:a', 'aac_adtstoasc');
  args.push('-movflags', '+faststart', output);
  const r = spawnSync(ffmpeg, args, { encoding: 'utf8' });
  return { code: r.status, stderr: (r.stderr || '').trim() };
}

function probeDuration(ffprobe, file) {
  const r = spawnSync(ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
  ], { encoding: 'utf8' });
  const v = parseFloat((r.stdout || '').trim());
  return Number.isFinite(v) ? v : null;
}

function verifyDecode(ffmpeg, file) {
  const head = spawnSync(ffmpeg, ['-v', 'error', '-t', '10', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  const tail = spawnSync(ffmpeg, ['-v', 'error', '-sseof', '-10', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  return {
    ok: head.status === 0 && tail.status === 0,
    head: (head.stderr || '').trim(),
    tail: (tail.stderr || '').trim(),
  };
}

// ─────────────────────────────── 主流程 ───────────────────────────────

function guessName(pageUrl, m3u8Url) {
  for (const u of [pageUrl, m3u8Url].filter(Boolean)) {
    try {
      const q = new URL(u).searchParams;
      for (const k of ['viewkey', 'viewKey', 'id', 'vid', 'videoId']) {
        if (q.get(k)) return sanitizeName(q.get(k));
      }
    } catch { /* ignore */ }
  }
  return 'video_' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

// ───────────────────── 直链媒体：下载 + 封装 + 校验 ─────────────────────

async function runDirect(url, netOpts, opts, tmpDir, ffmpeg, ffprobe) {
  let name = 'video';
  try { name = path.basename(new URL(url).pathname) || 'video'; } catch { /* ignore */ }
  log('');
  ok(`检测到直链媒体: ${C.b(name)}`);
  log(`  地址      ${C.dim(url)}`);

  if (opts.probe) {
    log('');
    ok('--probe 模式：仅探测，未下载。');
    return;
  }

  const ext = (() => { try { return path.extname(new URL(url).pathname).toLowerCase(); } catch { return ''; } })();
  const tmpFile = path.join(tmpDir, 'direct' + (ext || '.bin'));

  info('开始下载…');
  await downloadDirect(url, netOpts, tmpFile);
  if (!fs.existsSync(tmpFile) || fs.statSync(tmpFile).size === 0) die('下载结果为空');

  const outFile = path.resolve(opts.output || `${guessName(opts.url, url)}.mp4`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  // 源文件本身就是 mp4 就直接搬；否则尝试无损转封装
  let ok_ = false;
  if (ext === '.mp4') {
    fs.copyFileSync(tmpFile, outFile);
    ok_ = true;
  } else {
    info(`转封装为 MP4（源格式 ${ext || '未知'}）…`);
    const rr = spawnSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'warning', '-y', '-i', tmpFile,
      '-c', 'copy', '-movflags', '+faststart', outFile,
    ], { encoding: 'utf8' });
    ok_ = rr.status === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 0;
    if (!ok_) warn(`转封装失败，保留原始文件${ext ? `（${ext}）` : ''}`);
  }
  if (!ok_) fs.copyFileSync(tmpFile, outFile);

  log('');
  ok(`完成: ${C.b(outFile)}`);
  emitProgress({ t: 'result', file: outFile, size: fs.statSync(outFile).size });
  log(`  大小      ${humanSize(fs.statSync(outFile).size)}`);
  if (opts.verify) {
    const dur = probeDuration(ffprobe, outFile);
    if (dur) log(`  时长      ${fmtTime(dur)}`);
    const v = verifyDecode(ffmpeg, outFile);
    if (v.ok) ok('  解码校验  头尾均无错误');
    else warn(`  解码校验  发现问题\n${v.head}\n${v.tail}`);
  }
  if (opts.keepTemp) log(C.dim(`  中间文件保留在 ${tmpDir}`));
  log('');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  PROGRESS_JSON = !!opts.progressJson;

  log('');
  log(C.b('  hls-downloader') + C.dim('  网页视频流下载'));
  log(C.dim('  ─────────────────────────────────────'));

  const ffmpeg = findFfmpeg(opts.ffmpeg);
  const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace('ffmpeg', 'ffprobe'));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hlsdl-work-'));
  const cleanTmp = () => { if (!opts.keepTemp) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } } };
  process.on('exit', cleanTmp);

  let referer = opts.referer;
  // Referer 优先取页面 origin。注意：即使用 -m 直接给流地址，
  // 只要同时给了页面 URL 也能推导出来——否则很容易被防盗链拦。
  if (!referer && opts.url) {
    try { referer = new URL(opts.url).origin + '/'; } catch { /* ignore */ }
  }

  const streamUrl = opts.m3u8;
  let candidates = [];
  let mpdCandidates = [];
  let mediaCandidates = [];

  // 1) 嗅探
  if (!streamUrl) {
    const r = await sniff(opts.url, opts);
    candidates = r.candidates;
    mpdCandidates = r.mpd || [];
    mediaCandidates = r.media || [];
    if (candidates.length === 0 && mpdCandidates.length === 0 && mediaCandidates.length === 0) {
      die('没有在页面里嗅探到视频地址。可尝试：\n' +
        '   - 用 --headed 打开浏览器手动点一下播放，再跑一次\n' +
        '   - 用浏览器 F12 → 网络(Network) → 过滤 m3u8 / mpd / mp4，把地址用 -m 传进来');
    }
    const show = (list, label) => {
      if (!list.length) return;
      info(`嗅探到 ${list.length} 个${label}`);
      for (const c of list) log(C.dim(`    ${c}`));
    };
    show(candidates, ' m3u8 候选');
    show(mpdCandidates, ' DASH 清单候选');
    show(mediaCandidates, '直链媒体候选');
  }

  const netOpts = { ...opts, referer, userAgent: opts.userAgent || DEFAULT_UA };

  // 2) 分流：HLS（m3u8）→ DASH（mpd）→ 直链媒体
  const isMpdUrl = (u) => /\.mpd(\?|$)/i.test(u);
  let kind, target;
  if (streamUrl) {
    if (isMpdUrl(streamUrl)) { kind = 'dash'; target = streamUrl; }
    else if (isDirectMedia(streamUrl)) { kind = 'direct'; target = streamUrl; }
    else { kind = 'hls'; target = streamUrl; }
  } else if (candidates.length > 0) { kind = 'hls'; target = candidates[0]; }
  else if (mpdCandidates.length > 0) { kind = 'dash'; target = mpdCandidates[0]; }
  else { kind = 'direct'; target = mediaCandidates[0]; }

  if (kind === 'dash') return runDash(target, netOpts, opts, tmpDir, ffmpeg, ffprobe);
  if (kind === 'direct') return runDirect(target, netOpts, opts, tmpDir, ffmpeg, ffprobe);

  // 3) HLS：逐个解析，挑切片最多的那路
  const probeList = streamUrl ? [streamUrl] : candidates;
  const parsed = [];
  for (const u of probeList) {
    try {
      const pl = await resolveMediaPlaylist(u, netOpts);
      parsed.push(pl);
    } catch (e) {
      warn(`清单解析失败（跳过）: ${u}\n    ${e.message}`);
    }
  }
  if (parsed.length === 0) die('所有 m3u8 候选都解析失败。若清单带短时效签名，请重跑一次。');

  parsed.sort((a, b) => b.totalDuration - a.totalDuration || b.segments.length - a.segments.length);
  const picked = parsed[0];

  log('');
  ok(`选中视频流: ${C.b(path.basename(new URL(picked.playlistUrl).pathname) || 'index.m3u8')}`);
  log(`  切片数    ${picked.segments.length}`);
  log(`  总时长    ${fmtTime(picked.totalDuration)}`);
  log(`  加密      ${picked.encrypted ? (picked.unsupported ? C.red(picked.segments.find(s => s.key)?.key.method + '（不支持）') : C.yel('AES-128（将自动解密）')) : C.grn('无')}`);
  log(`  容器      ${picked.isFmp4 ? 'fMP4' : 'MPEG-TS'}`);
  if (picked.pickedVariant) log(`  码流      ${picked.pickedVariant.resolution || picked.pickedVariant.bandwidth + 'bps'}`);

  if (picked.unsupported) die(`清单使用了不支持的加密方式（SAMPLE-AES / SAMPLE-AES-CTR 等），本工具无法处理。`);

  if (opts.probe) {
    log('');
    ok('--probe 模式：仅探测，未下载。');
    return;
  }

  // 3) 下载切片
  log('');
  info(`开始下载 ${picked.segments.length} 个切片（并发 ${opts.concurrency}）…`);
  const dl = await downloadSegments(picked, netOpts, tmpDir);
  if (dl.failed > 0) {
    warn(`${dl.failed}/${dl.total} 个切片下载失败`);
    for (const e of dl.errors.slice(0, 5)) log(C.dim('    ' + e));
    if (dl.failed > dl.total * 0.05) die('失败比例过高，中止。若是签名过期请重跑，或降低 --concurrency。');
    warn('失败比例较低，继续合成（成品可能有个别花帧）');
  }

  // 4) 拼接 + 封装
  const allBin = concatSegments(picked, dl.segDir, tmpDir);
  sanitizeInputs([allBin]);
  const outFile = path.resolve(opts.output || `${guessName(opts.url, picked.playlistUrl)}.mp4`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  info('封装为 MP4…');
  const r = remux(ffmpeg, allBin, outFile, picked.isFmp4);
  if (r.code !== 0 || !fs.existsSync(outFile) || fs.statSync(outFile).size === 0) {
    let msg = r.stderr || '(无输出)';
    if (/sidx reference_type 1 is not implemented/.test(msg)) {
      msg += '\n提示：该流是 ffmpeg 不支持的分层索引 MP4（sidx type-1 引用），自动剥离没生效。';
    }
    die(`ffmpeg 封装失败（退出码 ${r.code}）\n${msg}`);
  }

  // 5) 校验
  const size = fs.statSync(outFile).size;
  log('');
  ok(`完成: ${C.b(outFile)}`);
  emitProgress({ t: 'result', file: outFile, size });
  log(`  大小      ${humanSize(size)}`);
  if (opts.verify) {
    const dur = probeDuration(ffprobe, outFile);
    if (dur) log(`  时长      ${fmtTime(dur)}`);
    const v = verifyDecode(ffmpeg, outFile);
    if (v.ok) ok('  解码校验  头尾均无错误');
    else warn(`  解码校验  发现问题\n${v.head}\n${v.tail}`);
  }
  if (opts.keepTemp) log(C.dim(`  中间文件保留在 ${tmpDir}`));
  log('');
}

main().catch(e => die(e && e.stack ? e.stack : String(e)));
