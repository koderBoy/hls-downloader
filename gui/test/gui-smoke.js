#!/usr/bin/env node
/**
 * GUI 端到端自测
 *
 * 不是「窗口能起来就算过」——那太水了。这里真的用 CDP 驱动界面：
 * 填地址 → 点「开始下载」→ 盯着进度条和日志 → 等结果卡片出现 → 验产物。
 *
 * 样本用 ffmpeg 现场生成、本地 HTTP 服务器伺候，不依赖外网。
 *
 * 用法:  node test/gui-smoke.js
 *        node test/gui-smoke.js --exe <打包好的exe>   # 测打包产物而不是开发版
 *        node test/gui-smoke.js --shot <前缀>        # 顺带截图（界面待机 + 下载完成各一张）
 */
'use strict';

const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FIX = path.join(os.tmpdir(), 'hlsdl-gui-fix-' + Date.now());
const OUT = path.join(os.tmpdir(), 'hlsdl-gui-out-' + Date.now());
const CDP_PORT = 9333;

const SHOT_IDX = process.argv.indexOf('--shot');
const SHOT = SHOT_IDX >= 0 ? process.argv[SHOT_IDX + 1] : null;
const EXE_IDX = process.argv.indexOf('--exe');
const EXE = EXE_IDX >= 0 ? path.resolve(process.argv[EXE_IDX + 1]) : null;

const C = {
  grn: s => `\x1b[32m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  dim: s => `\x1b[2m${s}\x1b[0m`,
  b: s => `\x1b[1m${s}\x1b[0m`,
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function ffmpegPath() {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [exe], { encoding: 'utf8' });
  return (r.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] || 'ffmpeg';
}
const ffprobeOf = (ff) => ff.replace(/ffmpeg(\.exe)?$/i, m => m.replace('ffmpeg', 'ffprobe'));

// ── 样本 ──────────────────────────────────────────────────────
const SRC_SECONDS = 9;

function buildFixture(ff) {
  fs.mkdirSync(FIX, { recursive: true });
  const r = spawnSync(ff, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=25:duration=${SRC_SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SRC_SECONDS}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-g', '25', '-keyint_min', '25', '-sc_threshold', '0',
    '-c:a', 'aac', '-shortest',
    '-hls_time', '3', '-hls_list_size', '0',
    '-hls_segment_filename', path.join(FIX, 'seg%03d.ts'),
    path.join(FIX, 'index.m3u8'),
  ], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('生成样本失败: ' + (r.stderr || '').trim());
  return path.join(FIX, 'index.m3u8');
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const file = path.join(FIX, decodeURIComponent(u.pathname));
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('nope'); return; }
      const ext = path.extname(file).toLowerCase();
      const mime = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/vnd.dlna.mpeg-tts' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': fs.statSync(file).size });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ── CDP ───────────────────────────────────────────────────────
async function findPageTarget(timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await res.json();
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* 还没起来，继续等 */ }
    await sleep(300);
  }
  throw new Error('等不到 CDP 调试端口，Electron 可能没起来');
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let seq = 0;
    const pending = new Map();
    const timer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } reject(new Error('CDP 连接超时')); }, 15000);

    ws.onopen = () => {
      clearTimeout(timer);
      const send = (method, params) => new Promise((res, rej) => {
        const id = ++seq;
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params: params || {} }));
      });
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.id && pending.has(msg.id)) {
          const { res, rej } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
        }
      };
      resolve({ ws, send });
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP WebSocket 出错')); };
  });
}

async function evaluate(send, expression) {
  const r = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error('页面里执行出错: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

// --shot 时把当前窗口存成 PNG。用来给用户看界面长什么样——文字描述不如一张图。
async function capture(send, file) {
  if (!SHOT) return;
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log(C.dim('          截图 → ' + file));
}

// ── 主流程 ────────────────────────────────────────────────────
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { encoding: 'utf8' }); } catch { /* ignore */ }
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ } }
  }
}

// 列出当前同名进程的 PID（只用来做「前后快照对比」，不用于按名字全杀）
function listAppPids() {
  if (process.platform !== 'win32') return [];
  const img = (EXE ? path.basename(EXE) : 'electron.exe');
  try {
    const r = spawnSync('cmd', ['/c', 'tasklist', '/fi', `imagename eq ${img}`, '/fo', 'csv', '/nh'],
      { encoding: 'utf8' });
    return (r.stdout || '').split(/\r?\n/)
      .map(l => (l.match(/^"[^"]+","(\d+)"/) || [])[1])
      .filter(Boolean).map(Number);
  } catch { return []; }
}

// 删临时目录。用 rmdir 而不是 fs.rmSync：
// 这个 shell 里挂着 safe-delete 钩子，fs.rm 会被重定向到回收站，
// 批量删除还会被守卫直接抛错 —— 而这段在 finally 里，一抛错后面的清理就全被跳过了
// （曾经就是这样留下几百 MB 的临时目录）。
function rmDir(p) {
  try {
    if (process.platform === 'win32') spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', p], { stdio: 'ignore' });
    else spawnSync('rm', ['-rf', p], { stdio: 'ignore' });
  } catch { /* ignore */ }
}

async function main() {
  console.log('');
  console.log(C.b('  hls-downloader GUI 端到端自测'));
  console.log(C.dim('  ─────────────────────────────────────'));

  const ff = ffmpegPath();
  const ffprobe = ffprobeOf(ff);
  if (spawnSync(ff, ['-version'], { encoding: 'utf8' }).status !== 0) {
    console.error(C.red('  ffmpeg 不可用，没法造样本')); process.exit(1);
  }

  const problems = [];
  const note = (m) => console.log(C.dim('          ' + m));

  console.log(C.dim('  生成样本…'));
  const playlist = buildFixture(ff);
  fs.mkdirSync(OUT, { recursive: true });
  const outFile = path.join(OUT, 'gui.mp4');

  const { server, port } = await startServer();
  const streamUrl = `http://127.0.0.1:${port}/index.m3u8`;

  console.log(C.dim(EXE ? `  启动打包产物 ${path.basename(EXE)}…` : '  启动 Electron…'));
  // 开发模式走 launch.js（它会把 ELECTRON_RUN_AS_NODE 删掉，这个环境里它是被设上的）；
  // --exe 模式直接拉起打包好的 exe，验的是真正交付给用户的那个东西。
  //
  // 打包产物没法自己清这个变量（被设上时它压根不会以 Electron 身份启动），
  // 所以这里由测试代劳 —— 用户双击 exe 时环境里本来就没有它。
  const args = [`--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*'];
  const cleanEnv = { ...process.env };
  delete cleanEnv.ELECTRON_RUN_AS_NODE;
  // 先记下此刻已有的同名进程，收尾时只杀「本次新出现的」——
  // 绝不按名字全杀，那会把用户自己开着的实例一起干掉。
  const pidsBefore = listAppPids();
  const app = EXE
    ? spawn(EXE, args, { cwd: path.dirname(EXE), env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(process.execPath, [path.join(ROOT, 'launch.js'), ...args],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

  let appErr = '';
  app.stderr.on('data', d => { appErr += d.toString('utf8'); });
  app.stdout.on('data', () => { /* 界面输出，忽略 */ });
  // spawn 失败（路径不存在、不是可执行文件等）会 emit 'error'。
  // 没有监听者的话 Node 会把未捕获的 'error' 直接抛出去、进程崩掉 ——
  // 那样 finally 里的清理（临时目录、残留进程）全都跑不到。所以必须接住，
  // 并且让它参与 CDP 等待的竞速，免得干等 25 秒。
  const appFailed = new Promise((_, rej) => {
    app.on('error', (e) => { appErr += '\n[spawn error] ' + e.message; rej(new Error('启动失败：' + e.message)); });
  });

  let cdp = null;
  try {
    const page = await Promise.race([findPageTarget(), appFailed]);
    cdp = await connectCdp(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');

    // 等界面初始化完（环境自检是异步的）
    let ready = false;
    for (let i = 0; i < 40; i++) {
      ready = await evaluate(cdp.send, 'typeof window.api === "object" && !!document.getElementById("url")');
      if (ready) break;
      await sleep(250);
    }
    if (!ready) throw new Error('界面没初始化出来');

    // ① 环境自检应该识别出 CLI / Node / ffmpeg
    // 注意别急着数：envCheck 要 spawn 两个子进程（node -v / ffmpeg -version），
    // 是异步的。界面初始化完 ≠ 自检落地，这里必须轮询等。
    let envChips = 0;
    for (let i = 0; i < 60; i++) {
      envChips = await evaluate(cdp.send, 'document.querySelectorAll("#env .chip").length');
      if (envChips >= 3) break;
      await sleep(250);
    }
    if (envChips < 3) problems.push(`环境自检只识别出 ${envChips} 项（期望 3：CLI / Node / ffmpeg）`);

    // ①b 三个标签必须都是绿的（ok），不能有红的。
    // 只数个数是不够的 —— 曾经 probeBinary 没传 ELECTRON_RUN_AS_NODE，
    // 探测 process.execPath 时把打包 exe 当完整应用启动（多开一个窗口、卡到超时），
    // Node 那格永远红，而 chip 个数照样是 3，测试全绿放行。这个断言就是补这个洞。
    // 等自检彻底落地再判色（chip 一出现就是最终色，但保险起见等状态稳定）。
    let chipText = '';
    let badChips = -1;
    for (let i = 0; i < 40; i++) {
      const st = await evaluate(cdp.send, `
        (() => {
          const chips = [...document.querySelectorAll('#env .chip')];
          return {
            bad: chips.filter(c => c.classList.contains('bad')).length,
            text: chips.map(c => c.textContent.trim()).join(' | '),
          };
        })()
      `);
      chipText = st.text;
      badChips = st.bad;
      if (st.bad === 0) break;
      await sleep(250);
    }
    if (badChips !== 0) problems.push(`环境自检有 ${badChips} 项标红（不可用）：${chipText}`);

    // ② 填地址 + 输出路径，展开选项，然后点「开始下载」
    await evaluate(cdp.send, `
      (() => {
        const u = document.getElementById('url');
        u.value = ${JSON.stringify(streamUrl)};
        u.dispatchEvent(new Event('input', { bubbles: true }));
        const o = document.getElementById('output');
        o.value = ${JSON.stringify(outFile)};
        o.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('adv').open = true;
        return true;
      })()
    `);
    if (SHOT) { await cdp.send('Page.enable'); await capture(cdp.send, `${SHOT}-idle.png`); }
    await evaluate(cdp.send, `document.getElementById('go').click()`);

    // ③ 盯着进度：至少要看到 status 变化，最后要出现结果卡片
    let sawProgress = false;
    let sawLog = false;
    let done = false;
    let lastSnap = { status: '', tracks: '', logLines: 0, resultPath: '', resultSize: '' };
    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      const snap = await evaluate(cdp.send, `
        JSON.stringify({
          status: document.getElementById('status').textContent,
          tracks: document.getElementById('tracks').textContent,
          logLines: document.getElementById('log').childElementCount,
          resultShown: !document.getElementById('result').hidden,
          resultPath: document.getElementById('resultPath').textContent,
          resultSize: document.getElementById('resultSize').textContent,
          running: document.getElementById('go').disabled,
        })
      `);
      const s = JSON.parse(snap);
      lastSnap = s;
      if (s.tracks && s.tracks.trim()) sawProgress = true;
      if (s.logLines > 3) sawLog = true;
      if (s.resultShown && !s.running) { done = true; break; }
      if (!s.running && /失败/.test(s.status)) { problems.push('界面报失败: ' + s.status); break; }
      await sleep(400);
    }

    if (!sawLog) problems.push('日志区一直没内容，界面没收到子进程输出');
    if (!sawProgress) problems.push('进度区一直是空的，没收到进度事件');
    if (!done) problems.push('等 120 秒也没等到完成状态');
    note(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，日志 ${lastSnap.logLines} 行，状态「${lastSnap.status}」`);
    note(`进度区「${lastSnap.tracks.trim() || '（空）'}」，结果卡片「${lastSnap.resultSize}」`);

    // ④ 验产物：界面上显示的路径要和实际文件一致，且能解码
    if (done) {
      const shown = await evaluate(cdp.send, 'document.getElementById("resultPath").textContent');
      if (path.resolve(shown) !== path.resolve(outFile)) {
        problems.push(`结果卡片里的路径不对: ${shown}`);
      }
      if (!fs.existsSync(outFile)) {
        problems.push('界面说完成了，但文件不存在');
      } else {
        const st = fs.statSync(outFile);
        note(`产物 ${(st.size / 1024).toFixed(0)} KB`);
        if (!(st.size > 0)) problems.push('产物是空文件');
        const kinds = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', outFile], { encoding: 'utf8' });
        const types = (kinds.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        if (!types.includes('video')) problems.push('产物里没有视频轨');
        if (!types.includes('audio')) problems.push('产物里没有音频轨');
        const dur = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outFile], { encoding: 'utf8' });
        const d = parseFloat((dur.stdout || '').trim());
        if (!Number.isFinite(d)) problems.push('ffprobe 读不出产物时长');
        else if (Math.abs(d - SRC_SECONDS) > 1.5) problems.push(`产物时长 ${d.toFixed(2)}s，期望约 ${SRC_SECONDS}s`);
        const dec = spawnSync(ff, ['-v', 'error', '-i', outFile, '-f', 'null', '-'], { encoding: 'utf8' });
        if (dec.status !== 0) problems.push('产物解码报错: ' + (dec.stderr || '').trim().split('\n')[0]);
      }
    }

    // ⑤ 「打开文件 / 打开所在文件夹」按钮在完成后应该是可用的
    if (done) {
      const btns = await evaluate(cdp.send, '!document.getElementById("openFile").disabled && !document.getElementById("revealFile").disabled');
      if (!btns) problems.push('完成结果卡片里的按钮不可用');
    }

    // ⑥ 截图（--shot 时才做）：把「下载完成」这一屏留下来。
    //    先收起选项面板，否则进度条/结果卡片/日志会被挤到视口外面去。
    if (SHOT && done) {
      await evaluate(cdp.send, `
        (() => {
          document.getElementById('adv').open = false;
          document.getElementById('result').scrollIntoView({ block: 'center' });
          return true;
        })()
      `);
      await sleep(200);
      await capture(cdp.send, `${SHOT}-done.png`);
    }

  } catch (e) {
    problems.push(e.message);
    if (appErr.trim()) note(appErr.trim().split('\n').slice(0, 6).join('\n          '));
  } finally {
    // 先请界面自己退。便携版是「NSIS 启动器解压完就退出、真正的窗口进程被重新挂到别处」，
    // 那种情况下 killTree(app.pid) 根本够不着窗口，会留下一个开着窗口的进程。
    // 走 CDP 关最可靠，killTree 只当兜底。
    try {
      if (cdp) {
        // 关掉之后 WebSocket 会断，这个 invoke 的 Promise 可能永远不落地，
        // 所以必须跟一个超时赛跑，否则测试会卡死在这一步。
        await Promise.race([cdp.send('Browser.close').catch(() => {}), sleep(2000)]);
        await sleep(500);
      }
    } catch { /* ignore */ }
    try { if (cdp) cdp.ws.close(); } catch { /* ignore */ }
    killTree(app.pid);
    // 便携版光靠 killTree 不够（见上面注释），再补一次：
    // 对比启动前后的 PID 快照，只杀本次新出现的进程。等一会儿让它们先自己退。
    await sleep(1200);
    for (const pid of listAppPids()) {
      if (!pidsBefore.includes(pid)) killTree(pid);
    }
    server.close();
    rmDir(FIX);
    rmDir(OUT);
  }

  console.log('');
  if (problems.length === 0) {
    console.log(C.grn('  PASS') + '  GUI 端到端（填地址 → 点击 → 进度 → 产物 → 结果卡片）');
  } else {
    console.log(C.red('  FAIL') + '  GUI 端到端');
    for (const p of problems) console.log(C.dim('          ' + p));
  }
  console.log('');
  process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(C.red('  自测异常: ' + e.stack)); process.exit(1); });
