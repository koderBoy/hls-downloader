'use strict';
/**
 * 渲染进程：只管界面，不碰 Node。
 * 所有跟系统打交道的事都走 preload 暴露的 window.api。
 */
(() => {
  const $ = (id) => document.getElementById(id);

  const el = {
    url: $('url'), output: $('output'), pick: $('pick'),
    quality: $('quality'), period: $('period'), concurrency: $('concurrency'),
    timeout: $('timeout'), referer: $('referer'), userAgent: $('userAgent'),
    cookie: $('cookie'), ffmpeg: $('ffmpeg'),
    probe: $('probe'), headed: $('headed'), keepTemp: $('keepTemp'),
    noVerify: $('noVerify'), useProxy: $('useProxy'),
    go: $('go'), stop: $('stop'), clearLog: $('clearLog'),
    fill: $('fill'), status: $('status'), tracks: $('tracks'),
    log: $('log'), env: $('env'), adv: $('adv'), advHint: $('advHint'),
    result: $('result'), resultPath: $('resultPath'), resultSize: $('resultSize'),
    openFile: $('openFile'), revealFile: $('revealFile'),
  };

  // 粘进来的地址如果本身就是流地址，就别让 CLI 去开浏览器嗅探了——
  // 直接当流地址喂给 -m。同时也把它作为位置参数传过去，这样 CLI 还能
  // 从它的 origin 自动推导 Referer（少了这个头很多 CDN 直接 403）。
  const STREAM_RE = /\.(m3u8|mpd|mp4|webm|mkv|mov|flv|m4v|avi|ts|m4s)(\?|#|$)/i;
  const looksLikeStream = (u) => STREAM_RE.test(String(u).trim());

  // ── 日志 ──────────────────────────────────────────────────
  const MAX_LINES = 3000;
  const ANSI_RE = /\x1b\[[0-9;]*m/g;

  function classify(text) {
    if (text.startsWith('$')) return 'l-cmd';
    if (text.startsWith('✓')) return 'l-ok';
    if (text.startsWith('!')) return 'l-warn';
    if (text.startsWith('✗')) return 'l-err';
    if (text.startsWith('›')) return 'l-dim';
    return 'l-out';
  }

  function nearBottom() {
    return el.log.scrollHeight - el.log.scrollTop - el.log.clientHeight < 48;
  }

  function appendLog(text, kind) {
    const stick = nearBottom();
    const line = document.createElement('div');
    const clean = String(text).replace(ANSI_RE, '');
    line.className = kind || classify(clean);
    line.textContent = clean || ' ';
    el.log.appendChild(line);
    while (el.log.childElementCount > MAX_LINES) el.log.removeChild(el.log.firstChild);
    if (stick) el.log.scrollTop = el.log.scrollHeight;
  }

  el.clearLog.addEventListener('click', () => { el.log.textContent = ''; });

  // ── 进度 ──────────────────────────────────────────────────
  const trackState = new Map();   // label -> {done,total,bytes,failed}
  let currentLabel = null;
  let running = false;

  const fmtSize = (n) => {
    if (!n && n !== 0) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = Number(n);
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
  };

  function renderTracks() {
    el.tracks.textContent = [...trackState.entries()]
      .map(([k, v]) => `${k} ${v.done}/${v.total}`)
      .join('   ');
  }

  function setBar(pct, cls) {
    el.fill.classList.remove('done', 'err');
    if (cls) el.fill.classList.add(cls);
    el.fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }

  function onProgress(ev) {
    if (ev.t === 'seg' || ev.t === 'bytes') {
      trackState.set(ev.label, {
        done: ev.done, total: ev.total || 0,
        bytes: ev.bytes || 0, failed: ev.failed || 0,
      });
      currentLabel = ev.label;
      const pct = ev.total > 0 ? ev.done / ev.total * 100 : 0;
      setBar(pct, null);
      const bits = [`${ev.label} ${ev.done}/${ev.total || '?'}`];
      if (ev.bytes) bits.push(fmtSize(ev.bytes));
      if (ev.failed) bits.push(`失败 ${ev.failed}`);
      if (ev.missing) bits.push(`截断 ${ev.missing}`);
      el.status.textContent = bits.join('   ');
      renderTracks();
    } else if (ev.t === 'result') {
      el.resultPath.textContent = ev.file;
      el.resultSize.textContent = fmtSize(ev.size);
      el.result.hidden = false;
      el.result.dataset.file = ev.file;
    } else if (ev.t === 'error') {
      appendLog(ev.message, 'l-err');
    }
  }

  // ── 环境自检 ──────────────────────────────────────────────
  let envReady = null;   // 自检是异步的，冒烟测试要等它落地

  function chip(label, res, extra) {
    const d = document.createElement('span');
    d.className = 'chip ' + (res.ok ? 'ok' : 'bad');
    const b = document.createElement('b');
    b.textContent = label;
    d.appendChild(b);
    d.appendChild(document.createTextNode(' ' + (extra || res.text || (res.ok ? 'OK' : '不可用'))));
    d.title = res.text || '';
    return d;
  }

  async function refreshEnv() {
    const r = await window.api.envCheck();
    el.env.textContent = '';
    el.env.appendChild(chip('CLI', r.cli, r.cli.ok ? r.cli.text.split(/[\\/]/).pop() : r.cli.text));
    el.env.appendChild(chip('Node', r.node, r.node.ok ? r.node.text : '不可用'));
    el.env.appendChild(chip('ffmpeg', r.ffmpeg, r.ffmpeg.ok ? r.ffmpeg.text.replace(/^ffmpeg version /, 'v').split(' ')[0] : '不可用'));
    if (!r.cli.ok) {
      appendLog('没找到 hls-downloader.js。可用环境变量 HLSDL_CLI 指定它的完整路径。', 'l-err');
    }
    if (!r.ffmpeg.ok) {
      appendLog('没找到 ffmpeg。切片能下下来，但没法封装成 MP4 —— 请把它加进 PATH，或在「选项」里指定路径。', 'l-warn');
    }
    if (!el.output.value) el.output.placeholder = `留空 = 存到 ${r.defaultDir}`;
    return r;
  }

  // ── 选项记忆 ──────────────────────────────────────────────
  const REMEMBER = ['quality', 'period', 'concurrency', 'timeout', 'referer',
    'userAgent', 'cookie', 'ffmpeg'];
  const REMEMBER_CHK = ['probe', 'headed', 'keepTemp', 'noVerify', 'useProxy'];

  function saveOpts() {
    try {
      const o = {};
      for (const k of REMEMBER) o[k] = el[k].value;
      for (const k of REMEMBER_CHK) o[k] = el[k].checked;
      localStorage.setItem('hlsdl-gui', JSON.stringify(o));
    } catch { /* 隐私模式之类，忽略 */ }
  }

  function loadOpts() {
    try {
      const o = JSON.parse(localStorage.getItem('hlsdl-gui') || '{}');
      for (const k of REMEMBER) if (typeof o[k] === 'string') el[k].value = o[k];
      for (const k of REMEMBER_CHK) if (typeof o[k] === 'boolean') el[k].checked = o[k];
    } catch { /* ignore */ }
  }

  function updateAdvHint() {
    const on = [];
    if (el.probe.checked) on.push('只探测');
    if (el.headed.checked) on.push('显示浏览器');
    if (el.keepTemp.checked) on.push('保留中间文件');
    if (el.noVerify.checked) on.push('跳过校验');
    if (el.useProxy.checked) on.push('走系统代理');
    if (el.period.value) on.push(`Period ${el.period.value}`);
    if (el.quality.value && el.quality.value !== 'best') on.push(el.quality.value);
    el.advHint.textContent = on.length ? `（${on.join('、')}）` : '';
  }

  // ── 开始 / 取消 ───────────────────────────────────────────
  function collect() {
    const raw = el.url.value.trim();
    const isStream = looksLikeStream(raw);
    return {
      url: raw,                         // 位置参数：页面 URL，或流地址（只为推导 Referer）
      stream: isStream ? raw : '',      // 是流地址时再补一个 -m，跳过浏览器嗅探
      output: el.output.value.trim(),
      quality: el.quality.value.trim() || 'best',
      period: el.period.value ? Number(el.period.value) : null,
      concurrency: el.concurrency.value ? Number(el.concurrency.value) : 16,
      timeout: el.timeout.value ? Number(el.timeout.value) : 30,
      referer: el.referer.value.trim(),
      userAgent: el.userAgent.value.trim(),
      cookie: el.cookie.value.trim(),
      ffmpeg: el.ffmpeg.value.trim(),
      probe: el.probe.checked,
      headed: el.headed.checked,
      keepTemp: el.keepTemp.checked,
      noVerify: el.noVerify.checked,
      useProxy: el.useProxy.checked,
    };
  }

  function setRunning(on) {
    running = on;
    el.go.disabled = on;
    el.stop.disabled = !on;
    el.go.textContent = on ? '下载中…' : '开始下载';
  }

  async function start() {
    const raw = el.url.value.trim();
    if (!raw) { el.url.focus(); appendLog('先填个地址吧。', 'l-warn'); return; }

    saveOpts();
    el.result.hidden = true;
    delete el.result.dataset.file;
    trackState.clear();
    el.tracks.textContent = '';
    setBar(0, null);

    const opts = collect();
    const r = await window.api.start(opts);
    if (!r.ok) {
      appendLog(r.error || '启动失败', 'l-err');
      el.status.textContent = '启动失败';
      setBar(0, 'err');
      return;
    }
    setRunning(true);
    el.status.textContent = '启动中…';
    appendLog('', 'l-blank');
  }

  el.go.addEventListener('click', start);
  el.stop.addEventListener('click', async () => {
    await window.api.cancel();
    appendLog('已请求取消，正在收尾…', 'l-warn');
  });
  el.url.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !running) start(); });

  el.pick.addEventListener('click', async () => {
    const p = await window.api.pickOutput(el.output.value.trim() || undefined);
    if (p) el.output.value = p;
  });

  el.openFile.addEventListener('click', async () => {
    const f = el.result.dataset.file;
    if (!f) return;
    const err = await window.api.openFile(f);
    if (err) appendLog('打不开：' + err, 'l-err');
  });
  el.revealFile.addEventListener('click', async () => {
    const f = el.result.dataset.file;
    if (f) await window.api.revealFile(f);
  });

  // ── 事件订阅 ──────────────────────────────────────────────
  window.api.onLog((p) => appendLog(p.text, p.kind === 'cmd' ? 'l-cmd' : (p.kind === 'err' ? 'l-err' : null)));
  window.api.onProgress(onProgress);
  window.api.onDone((p) => {
    setRunning(false);
    if (p.code === 0) {
      if (el.result.dataset.file) {
        setBar(100, 'done');
        el.status.textContent = '完成';
      } else {
        setBar(100, 'done');
        el.status.textContent = '完成（未生成文件）';
      }
    } else {
      setBar(100, 'err');
      el.status.textContent = p.error ? `失败：${p.error}` : `失败（退出码 ${p.code}）`;
    }
    updateAdvHint();
  });

  for (const k of [...REMEMBER, ...REMEMBER_CHK]) {
    el[k].addEventListener('change', () => { updateAdvHint(); saveOpts(); });
  }

  // ── 自检钩子（--smoke-test 用）────────────────────────────
  // 环境自检是异步的，必须等它落地再取结果，否则 chip 数永远是 0
  window.__smoke = async () => {
    try { await envReady; } catch { /* 自检失败也照样把现场返回去 */ }
    return {
      title: document.title,
      hasApi: typeof window.api === 'object' && window.api !== null,
      apiMethods: window.api ? Object.keys(window.api).length : 0,
      hasUrlInput: !!el.url,
      hasStartButton: !!el.go,
      envChips: el.env.querySelectorAll('.chip').length,
      envText: el.env.textContent.trim(),
      defaultDirHint: el.output.placeholder,
    };
  };

  // ── 初始化 ────────────────────────────────────────────────
  loadOpts();
  updateAdvHint();
  envReady = refreshEnv().catch((e) => appendLog('环境自检失败：' + e.message, 'l-err'));
  el.url.focus();
})();
