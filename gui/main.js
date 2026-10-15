'use strict';
/**
 * hls-downloader GUI —— Electron 主进程
 *
 * 设计取向：界面只是壳，真正的活儿全交给已经验证过的 CLI（hls-downloader.js）。
 * 主进程负责三件事：找到 CLI、把参数拼成命令行、把子进程的输出转成事件推给界面。
 * 这样 CLI 的每一条代码路径都还是自测覆盖过的那条，GUI 不需要重新实现任何下载逻辑。
 */
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let win = null;
let child = null;

const PROGRESS_TAG = '@@HLSDL@@ ';

// ── 打包后的资源位置 ─────────────────────────────────────────────
// 打包成 exe 之后，代码在 app.asar 里，但下面这两类东西必须放在 asar 外面：
//   1. CLI 脚本 —— 它要被当成普通脚本 spawn 起来（asar 里的路径不是真文件）
//   2. ffmpeg / ffprobe —— 要真的被当成可执行文件调用
// 所以走 extraResources，落到 resources/ 下面。
const RES = process.resourcesPath || '';

function resourcePath(...parts) {
  if (!app.isPackaged || !RES) return null;
  const p = path.join(RES, ...parts);
  try { return fs.statSync(p).isFile() ? p : null; } catch { return null; }
}

// 打包时随包附带的 ffmpeg；开发模式下没有，返回 null 让 CLI 自己去 PATH 找
function bundledFfmpeg() {
  return resourcePath('bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
}

// ── 定位 CLI 脚本 ────────────────────────────────────────────────
// 技能目录布局是 gui/ 和 hls-downloader.js 平级；工作区布局是 gui/ 和
// hls-downloader/ 平级。两种都找一遍，另外允许用环境变量硬指定。
function findCli() {
  const candidates = [
    process.env.HLSDL_CLI,
    resourcePath('cli', 'hls-downloader.js'),   // 打包后
    path.join(__dirname, '..', 'hls-downloader.js'),
    path.join(__dirname, '..', 'hls-downloader', 'hls-downloader.js'),
    path.join(__dirname, 'hls-downloader.js'),
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 继续找下一个 */ }
  }
  return null;
}

// 用 Electron 自带的 Node 跑 CLI，省得要求用户机器上另装一个 node。
// ELECTRON_RUN_AS_NODE=1 会让 electron.exe 表现得跟 node.exe 一样。
function nodeRunner() {
  return { cmd: process.execPath, extraEnv: { ELECTRON_RUN_AS_NODE: '1' } };
}

// ── 窗口 ────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 820,
    minHeight: 600,
    backgroundColor: '#f5f6f8',
    title: 'hls-downloader',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

// ── IPC：环境自检 ───────────────────────────────────────────────
// extraEnv 必须能传：探测 process.execPath 时如果不设 ELECTRON_RUN_AS_NODE=1，
// 打包后的 exe 会被当成完整 Electron 应用启动 —— 偷偷多开一个窗口、且不退出
// （表现为探针卡到 8 秒超时才被杀，环境自检里 Node 那格永远红）。
function probeBinary(cmd, args, extraEnv) {
  return new Promise((resolve) => {
    let out = '';
    let p;
    try {
      p = spawn(cmd, args, {
        windowsHide: true,
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
      });
    } catch (e) {
      resolve({ ok: false, text: e.message });
      return;
    }
    const timer = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } resolve({ ok: false, text: '超时' }); }, 8000);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, text: e.message }); });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, text: out.split('\n')[0].trim() });
    });
  });
}

ipcMain.handle('env-check', async () => {
  const cli = findCli();
  const runner = nodeRunner();
  // 一定要带上 runner.extraEnv：不然打包后的 exe 会被当完整应用启动，多开一个窗口
  const node = await probeBinary(runner.cmd, ['-v'], runner.extraEnv);
  // 打包版自带 ffmpeg，优先用它；开发模式才去 PATH 里找
  const bundled = bundledFfmpeg();
  const ff = await probeBinary(bundled || 'ffmpeg', ['-version']);
  return {
    cli: cli ? { ok: true, text: cli } : { ok: false, text: '没找到 hls-downloader.js' },
    node,
    ffmpeg: bundled ? { ...ff, text: ff.text, bundled: true } : ff,
    defaultDir: app.getPath('videos') || app.getPath('home'),
  };
});

// ── IPC：选择输出路径 ───────────────────────────────────────────
ipcMain.handle('pick-output', async (_e, defaultPath) => {
  const r = await dialog.showSaveDialog(win, {
    title: '保存为',
    defaultPath: defaultPath || path.join(app.getPath('videos'), 'video.mp4'),
    filters: [{ name: 'MP4 视频', extensions: ['mp4'] }, { name: '全部文件', extensions: ['*'] }],
  });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle('pick-dir', async (_e, defaultPath) => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择保存目录',
    defaultPath: defaultPath || app.getPath('videos'),
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

ipcMain.handle('open-file', async (_e, file) => {
  const r = await shell.openPath(file);
  return r || null;   // 返回非空字符串表示出错
});

ipcMain.handle('reveal-file', async (_e, file) => {
  shell.showItemInFolder(file);
  return true;
});

ipcMain.handle('open-external', async (_e, url) => {
  await shell.openExternal(url);
  return true;
});

// ── IPC：启动 / 取消下载 ────────────────────────────────────────
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// 按行切分，避免一次 data 事件里塞了半行或好几行
function makeLineSplitter(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  };
}

function buildArgs(opts) {
  const args = [];
  // CLI 位置参数是页面 URL；没给页面 URL 时用 -m 直接指定流地址
  if (opts.url) args.push(opts.url);
  if (opts.stream) args.push('-m', opts.stream);
  if (opts.output) args.push('-o', opts.output);
  if (opts.quality && opts.quality !== 'best') args.push('--quality', opts.quality);
  if (opts.period) args.push('--period', String(opts.period));
  if (opts.concurrency && Number(opts.concurrency) !== 16) args.push('-c', String(opts.concurrency));
  if (opts.timeout && Number(opts.timeout) !== 30) args.push('-t', String(opts.timeout));
  if (opts.referer) args.push('--referer', opts.referer);
  if (opts.userAgent) args.push('--user-agent', opts.userAgent);
  if (opts.cookie) args.push('--cookie', opts.cookie);
  // 用户手填的优先；没填就用打包自带的那份，最后才让 CLI 自己去 PATH 找
  if (opts.ffmpeg) args.push('--ffmpeg', opts.ffmpeg);
  else {
    const bundled = bundledFfmpeg();
    if (bundled) args.push('--ffmpeg', bundled);
  }
  if (opts.probe) args.push('--probe');
  if (opts.headed) args.push('--headed');
  if (opts.keepTemp) args.push('--keep-temp');
  if (opts.noVerify) args.push('--no-verify');
  args.push('--progress-json');
  return args;
}

ipcMain.handle('start-download', async (_e, opts) => {
  if (child) return { ok: false, error: '已有任务在跑' };

  const cli = findCli();
  if (!cli) return { ok: false, error: '没找到 hls-downloader.js，请设置环境变量 HLSDL_CLI 指向它' };
  if (!opts.url && !opts.stream) return { ok: false, error: '请填页面 URL，或直接填流地址' };

  const args = buildArgs(opts);
  const runner = nodeRunner();

  const env = { ...process.env, ...runner.extraEnv };
  // 这台机器上 https_proxy 常驻，走代理会让出口 IP 变化，按 IP 签名的清单会 403。
  // 所以默认清掉；用户勾了「使用系统代理」才保留。
  if (!opts.useProxy) {
    for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY',
      'https_proxy', 'http_proxy', 'all_proxy']) env[k] = '';
  }

  send('dl:log', { kind: 'cmd', text: `$ hls-downloader.js ${args.join(' ')}` });

  try {
    child = spawn(runner.cmd, [cli, ...args], { env, windowsHide: true });
  } catch (e) {
    child = null;
    return { ok: false, error: e.message };
  }

  const onOut = makeLineSplitter(line => send('dl:log', { kind: 'out', text: line }));
  const onErr = makeLineSplitter(line => {
    if (line.startsWith(PROGRESS_TAG)) {
      try {
        send('dl:progress', JSON.parse(line.slice(PROGRESS_TAG.length)));
      } catch { /* 半截 JSON，忽略 */ }
    } else {
      send('dl:log', { kind: 'err', text: line });
    }
  });

  child.stdout.on('data', d => onOut(d.toString('utf8')));
  child.stderr.on('data', d => onErr(d.toString('utf8')));

  child.on('error', (e) => {
    send('dl:done', { code: -1, error: e.message });
    child = null;
  });
  child.on('close', (code) => {
    send('dl:done', { code });
    child = null;
  });

  return { ok: true, pid: child.pid };
});

ipcMain.handle('cancel-download', async () => {
  if (!child) return { ok: false };
  const pid = child.pid;
  // 只杀这棵进程树（CLI 下面还挂着 ffmpeg），不要按名字全杀——
  // taskkill /IM 会把用户自己开的同名程序一起干掉，这个坑踩过一次了。
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }); } catch { /* ignore */ }
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
  }
  return { ok: true };
});

// ── 启动 ────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();

  // --smoke-test：加载完窗口后问渲染进程要一份自检结果，然后退出。
  // 用来在没有人工点击的情况下验证「窗口能起、preload 桥通了、界面元素齐了」。
  if (process.argv.includes('--smoke-test')) {
    win.webContents.once('did-finish-load', async () => {
      try {
        const info = await win.webContents.executeJavaScript('window.__smoke()');
        process.stdout.write('SMOKE_OK ' + JSON.stringify(info) + '\n');
        app.exit(0);
      } catch (e) {
        process.stdout.write('SMOKE_FAIL ' + (e && e.message) + '\n');
        app.exit(1);
      }
    });
    setTimeout(() => {
      process.stdout.write('SMOKE_FAIL 超时：窗口 20 秒内没加载完\n');
      app.exit(1);
    }, 20000).unref();
  }

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (child) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch { /* ignore */ }
  }
  app.quit();
});
