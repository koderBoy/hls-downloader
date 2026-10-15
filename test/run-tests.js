#!/usr/bin/env node
/**
 * hls-downloader 自测脚本
 *
 * 用 ffmpeg 现场生成四种 HLS 样本，起一个强制校验 Referer 的本地服务器，
 * 把工具的每条代码路径都真跑一遍。
 *
 * 用法:  node test/run-tests.js
 */
'use strict';

const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'hls-downloader.js');
const FIX = path.join(os.tmpdir(), 'hlsdl-fixtures-' + Date.now());
const OUT = path.join(os.tmpdir(), 'hlsdl-out-' + Date.now());

const C = {
  grn: s => `\x1b[32m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  dim: s => `\x1b[2m${s}\x1b[0m`,
  b: s => `\x1b[1m${s}\x1b[0m`,
  yel: s => `\x1b[33m${s}\x1b[0m`,
};

const SRC_SECONDS = 12;

function run(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { encoding: 'utf8', ...opts });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/**
 * 异步执行 —— 跑被测工具时必须用这个。
 * 测试用的 HTTP 服务器和测试脚本在同一个进程里，spawnSync 会阻塞事件循环，
 * 服务器就没法响应工具发出的请求，双方互等直接死锁。
 */
function runAsync(cmd, args, opts = {}, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const cp = spawn(cmd, args, opts);
    let out = '', err = '';
    cp.stdout.on('data', d => { out += d; });
    cp.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => { try { cp.kill('SIGKILL'); } catch { /* ignore */ } }, timeoutMs);
    cp.on('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
    cp.on('error', e => { clearTimeout(timer); resolve({ code: -1, out, err: err + e.message }); });
  });
}

function ffmpegPath() {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [exe], { encoding: 'utf8' });
  const first = r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
  return first || 'ffmpeg';
}

function ffprobePath(ff) {
  return ff.replace(/ffmpeg(\.exe)?$/i, m => m.replace('ffmpeg', 'ffprobe'));
}

// 工具输出带 ANSI 颜色码，断言前必须剥掉，否则 /加密\s+无/ 这类正则永远匹配不上
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

function durationOf(ffprobe, file) {
  const r = run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const v = parseFloat(r.out);
  return Number.isFinite(v) ? v : null;
}

// ───────────────────────── 生成测试样本 ─────────────────────────

/**
 * 造一个「分层索引」sidx 盒子：version=1，只有 1 个 reference，
 * 且 reference_type=1（指向下一级 sidx，而不是媒体数据）。
 *
 * 真实世界里的 isoff-on-demand 单文件流（如 Sony 的测试流）就是这个结构，
 * ffmpeg 直到 8.x 都没实现 type-1 引用，读到直接拒开文件：
 *   sidx reference_type 1 is not implemented ... Error opening input
 * 所以这里必须人工造出来——ffmpeg 自己产不出这种样本。
 */
function buildSidxType1() {
  const body = Buffer.alloc(4 + 4 + 4 + 8 + 8 + 2 + 2 + 12);
  let o = 0;
  body.writeUInt8(1, o); o += 1;                       // version = 1（64 位时间字段）
  o += 3;                                              // flags
  body.writeUInt32BE(1, o); o += 4;                    // reference_ID
  body.writeUInt32BE(24000, o); o += 4;                // timescale
  body.writeBigUInt64BE(0n, o); o += 8;                // earliest_presentation_time
  body.writeBigUInt64BE(0n, o); o += 8;                // first_offset
  o += 2;                                              // reserved
  body.writeUInt16BE(1, o); o += 2;                    // reference_count = 1
  body.writeUInt32BE((0x80000000 | 1000) >>> 0, o); o += 4;  // type=1, referenced_size=1000（>>>0 转无符号）
  body.writeUInt32BE(3000, o); o += 4;                 // subsegment_duration
  body.writeUInt32BE(0x90000000, o); o += 4;           // starts_with_SAP=1, SAP_type=1

  const hdr = Buffer.alloc(8);
  hdr.writeUInt32BE(8 + body.length, 0);
  hdr.write('sidx', 4, 'latin1');
  return Buffer.concat([hdr, body]);
}

/** 把分层索引 sidx 插到 moov 之后（tfhd 是 moof 相对寻址，插在前面不会破坏偏移） */
function injectType1Sidx(file) {
  const d = fs.readFileSync(file);
  let off = 0, insertAt = -1;
  while (off + 8 <= d.length) {
    const size = d.readUInt32BE(off);
    const type = d.toString('latin1', off + 4, off + 8);
    if (size < 8 || off + size > d.length) break;
    if (type === 'moov') { insertAt = off + size; break; }
    off += size;
  }
  if (insertAt < 0) throw new Error('样本里找不到 moov 盒子: ' + file);
  fs.writeFileSync(file, Buffer.concat([
    d.subarray(0, insertAt), buildSidxType1(), d.subarray(insertAt),
  ]));
}

/**
 * 造一份双 Period 的 MPD：分两段独立生成 DASH 流，再把各自的 <Period> 内容抠出来
 * 拼到一起——复用 ffmpeg 自己写的 SegmentTemplate，免得手抄模板写错。
 * sizes 传两个分辨率：给相同的值就是「可无损拼接」，给不同的值就是「参数不一致」。
 */
function buildMultiPeriodFixture(ff, dirName, sizes) {
  const root = path.join(FIX, dirName);
  fs.mkdirSync(root, { recursive: true });
  const half = SRC_SECONDS / 2;
  const inners = [];

  sizes.forEach((size, i) => {
    const name = `p${i + 1}`;
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    const r = run(ff, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=25:duration=${half}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${half}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-g', '25', '-keyint_min', '25', '-sc_threshold', '0',
      '-c:a', 'aac', '-shortest',
      '-f', 'dash', '-seg_duration', '3', '-use_template', '1', '-use_timeline', '0',
      'index.mpd',
    ], { cwd: dir });
    if (r.code !== 0) throw new Error(`生成多 Period 样本 ${dirName}/${name} 失败: ` + r.err);

    const mpd = fs.readFileSync(path.join(dir, 'index.mpd'), 'utf8');
    const inner = /<Period\b[^>]*>([\s\S]*?)<\/Period>/.exec(mpd);
    if (!inner) throw new Error(`${dirName}/${name}/index.mpd 里找不到 <Period> 内容`);
    // 抠出来的分片 URI 是相对 p1/ p2/ 的，补一个 <BaseURL> 指回去
    inners.push(`  <BaseURL>${name}/</BaseURL>\n${inner[1]}`);
  });

  const body = inners.map((inner, i) => [
    `  <Period id="P${i + 1}" start="PT${half * i}.0S" duration="PT${half}.0S">`,
    inner,
    '  </Period>',
  ].join('\n')).join('\n');

  fs.writeFileSync(path.join(root, 'index.mpd'), [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT${SRC_SECONDS}.0S"`,
    '     minBufferTime="PT2.0S" profiles="urn:mpeg:dash:profile:isoff-live:2011">',
    body,
    '</MPD>',
    '',
  ].join('\n'));
}

function buildFixtures(ff, ffprobe) {
  fs.mkdirSync(FIX, { recursive: true });
  const src = path.join(FIX, 'src.mp4');

  console.log(C.dim('  生成源视频…'));
  // -g 25：每秒一个关键帧，保证分片能均匀切开（否则 libx264 默认 GOP 是 250 帧 = 10 秒，
  // 会让 -seg_duration 3 切出 10s+2s 这种不规整的段，干扰 DASH 用例）
  let r = run(ff, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=size=640x360:rate=25:duration=${SRC_SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SRC_SECONDS}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-g', '25', '-keyint_min', '25', '-sc_threshold', '0',
    '-c:a', 'aac', '-shortest', src,
  ]);
  if (r.code !== 0) throw new Error('生成源视频失败: ' + r.err);

  // 1) 明文 MPEG-TS
  fs.mkdirSync(path.join(FIX, 'plain'), { recursive: true });
  r = run(ff, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', src,
    '-c', 'copy', '-hls_time', '3', '-hls_list_size', '0',
    '-hls_segment_filename', path.join(FIX, 'plain', 'seg%03d.ts'),
    path.join(FIX, 'plain', 'index.m3u8'),
  ]);
  if (r.code !== 0) throw new Error('生成明文 HLS 失败: ' + r.err);

  // 2) AES-128 加密
  fs.mkdirSync(path.join(FIX, 'aes'), { recursive: true });
  const keyFile = path.join(FIX, 'aes', 'enc.key');
  fs.writeFileSync(keyFile, crypto.randomBytes(16));
  const keyInfo = path.join(FIX, 'aes', 'key_info.txt');
  // 第一行是写进 m3u8 的 URI（用相对路径，顺便验证相对地址解析）
  fs.writeFileSync(keyInfo, `enc.key\n${keyFile}\n`);
  r = run(ff, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', src,
    '-c', 'copy', '-hls_time', '3', '-hls_list_size', '0',
    '-hls_key_info_file', keyInfo,
    '-hls_segment_filename', path.join(FIX, 'aes', 'seg%03d.ts'),
    path.join(FIX, 'aes', 'index.m3u8'),
  ]);
  if (r.code !== 0) throw new Error('生成 AES-128 HLS 失败: ' + r.err);

  // 3) fMP4（#EXT-X-MAP）
  // 注意：-hls_fmp4_init_filename 给裸文件名时，ffmpeg 是相对【当前工作目录】写文件的，
  // 不是相对播放列表目录。所以这里必须把 cwd 切到 fmp4 目录，否则 init.mp4 会掉到外面，
  // 而 m3u8 里写的却是相对 URI，导致 404。
  fs.mkdirSync(path.join(FIX, 'fmp4'), { recursive: true });
  r = run(ff, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', src,
    '-c', 'copy', '-hls_time', '3', '-hls_list_size', '0',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', path.join(FIX, 'fmp4', 'seg%03d.m4s'),
    'index.m3u8',
  ], { cwd: path.join(FIX, 'fmp4') });
  if (r.code !== 0) throw new Error('生成 fMP4 HLS 失败: ' + r.err);
  if (!fs.existsSync(path.join(FIX, 'fmp4', 'init.mp4'))) {
    throw new Error('fMP4 初始化段没有生成到 fmp4 目录，样本不可用');
  }

  // 4) master 多码流（两个不同分辨率的明文变体）
  for (const [dir, w, h] of [['v360', 640, 360], ['v180', 320, 180]]) {
    fs.mkdirSync(path.join(FIX, dir), { recursive: true });
    r = run(ff, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', src,
      '-vf', `scale=${w}:${h}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-hls_time', '3', '-hls_list_size', '0',
      '-hls_segment_filename', path.join(FIX, dir, 'seg%03d.ts'),
      path.join(FIX, dir, 'index.m3u8'),
    ]);
    if (r.code !== 0) throw new Error(`生成 ${dir} 变体失败: ` + r.err);
  }

  fs.mkdirSync(path.join(FIX, 'master'), { recursive: true });
  fs.writeFileSync(path.join(FIX, 'master', 'index.m3u8'), [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360',
    '/v360/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x180',
    '/v180/index.m3u8',
    '',
  ].join('\n'));

  // 5) 测试页面：主动 fetch master 清单，供嗅探路径使用
  fs.writeFileSync(path.join(FIX, 'page.html'), [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>test</title></head><body>',
    '<video id="v" controls></video>',
    '<script>fetch("/master/index.m3u8").then(r=>r.text()).catch(()=>{});</script>',
    '</body></html>',
  ].join('\n'));

  // 6) 直链 MP4（非分片）
  fs.mkdirSync(path.join(FIX, 'direct'), { recursive: true });
  fs.copyFileSync(src, path.join(FIX, 'direct', 'video.mp4'));

  // 7) DASH 四种分片寻址模式
  const dashVariants = [
    ['dash-tpl', ['-use_template', '1', '-use_timeline', '1']],   // SegmentTemplate + SegmentTimeline
    ['dash-num', ['-use_template', '1', '-use_timeline', '0']],   // SegmentTemplate + $Number$
    ['dash-list', ['-use_template', '0', '-use_timeline', '0']],  // SegmentList
    ['dash-single', ['-single_file', '1']],                       // SegmentBase 单文件
  ];
  for (const [dir, extra] of dashVariants) {
    fs.mkdirSync(path.join(FIX, dir), { recursive: true });
    r = run(ff, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', src,
      '-c', 'copy', '-f', 'dash', '-seg_duration', '3',
      ...extra, 'index.mpd',
    ], { cwd: path.join(FIX, dir) });
    if (r.code !== 0) throw new Error(`生成 DASH 样本 ${dir} 失败: ` + r.err);
    if (!fs.existsSync(path.join(FIX, dir, 'index.mpd'))) {
      throw new Error(`DASH 样本 ${dir} 的 index.mpd 没有生成到目标目录`);
    }
  }

  // 8) 故意把清单声明的时长改长，制造"声明段数多于实际段数"的场景，
  //    用来验证工具的 404 容错（真实 MPD 里这种情况很常见）
  fs.cpSync(path.join(FIX, 'dash-num'), path.join(FIX, 'dash-short'), { recursive: true });
  {
    const p = path.join(FIX, 'dash-short', 'index.mpd');
    const patched = fs.readFileSync(p, 'utf8')
      .replace(/mediaPresentationDuration="[^"]*"/, 'mediaPresentationDuration="PT30.0S"');
    fs.writeFileSync(p, patched);
  }

  // 9) 手写一份 SegmentBase 清单。
  //    ffmpeg 的 -single_file 实际产出的是 SegmentList + mediaRange，走不到 SegmentBase 分支，
  //    所以这里手工构造一份把该分支覆盖上。
  fs.cpSync(path.join(FIX, 'dash-single'), path.join(FIX, 'dash-base'), { recursive: true });
  fs.writeFileSync(path.join(FIX, 'dash-base', 'index.mpd'), [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT12.0S">',
    '  <Period id="0" start="PT0.0S">',
    '    <AdaptationSet id="0" mimeType="video/mp4" codecs="avc1.42c01e" frameRate="25/1">',
    '      <Representation id="0" bandwidth="175066" width="640" height="360">',
    '        <BaseURL>index-stream0.mp4</BaseURL>',
    '        <SegmentBase indexRange="829-880"><Initialization range="0-828"/></SegmentBase>',
    '      </Representation>',
    '    </AdaptationSet>',
    '    <AdaptationSet id="1" mimeType="audio/mp4" codecs="mp4a.40.2">',
    '      <Representation id="1" bandwidth="69221">',
    '        <BaseURL>index-stream1.mp4</BaseURL>',
    '        <SegmentBase indexRange="765-816"><Initialization range="0-764"/></SegmentBase>',
    '      </Representation>',
    '    </AdaptationSet>',
    '  </Period>',
    '</MPD>',
    '',
  ].join('\n'));

  // 10) 分层索引（type-1 sidx）单文件清单。
  //     复刻 isoff-on-demand profile 的真实结构：Representation 里只有 <BaseURL>，
  //     没有 <SegmentBase>，媒体文件自带一个引用下级 sidx 的顶层 sidx。
  //     ffmpeg 不支持 type-1 引用，不剥索引就封不了——这条用例专门盯这个回归。
  fs.mkdirSync(path.join(FIX, 'dash-hier'), { recursive: true });
  fs.copyFileSync(path.join(FIX, 'dash-single', 'index-stream0.mp4'), path.join(FIX, 'dash-hier', 'v.mp4'));
  fs.copyFileSync(path.join(FIX, 'dash-single', 'index-stream1.mp4'), path.join(FIX, 'dash-hier', 'a.mp4'));
  injectType1Sidx(path.join(FIX, 'dash-hier', 'v.mp4'));
  injectType1Sidx(path.join(FIX, 'dash-hier', 'a.mp4'));
  fs.writeFileSync(path.join(FIX, 'dash-hier', 'index.mpd'), [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT12.0S"',
    '     profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">',
    '  <Period id="0" start="PT0.0S">',
    '    <AdaptationSet id="0" mimeType="video/mp4" codecs="avc1.42c01e" frameRate="25/1">',
    '      <Representation id="0" bandwidth="175066" width="640" height="360">',
    '        <BaseURL>v.mp4</BaseURL>',
    '      </Representation>',
    '    </AdaptationSet>',
    '    <AdaptationSet id="1" mimeType="audio/mp4" codecs="mp4a.40.2">',
    '      <Representation id="1" bandwidth="69221">',
    '        <BaseURL>a.mp4</BaseURL>',
    '      </Representation>',
    '    </AdaptationSet>',
    '  </Period>',
    '</MPD>',
    '',
  ].join('\n'));

  // 11) 多 Period 清单（两段分辨率相同 → 可以无损拼接）
  buildMultiPeriodFixture(ff, 'dash-multi', ['640x360', '640x360']);
  // 12) 多 Period 且各段分辨率不同 → 应给出「参数不一致」警告
  buildMultiPeriodFixture(ff, 'dash-multi-diff', ['640x360', '480x360']);

  // 8) 直链媒体测试页。
  //    真站点用 <video> 元素；这里额外补一个 fetch 兜底，保证该 URL 一定出现在网络日志里
  //    （嗅探器按 URL 去重，重复请求不会产生重复候选）。
  fs.writeFileSync(path.join(FIX, 'page-mp4.html'), [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>test mp4</title></head><body>',
    '<video id="v" controls autoplay muted playsinline preload="auto" src="/direct/video.mp4"></video>',
    '<script>setTimeout(()=>fetch("/direct/video.mp4").catch(()=>{}), 800);</script>',
    '</body></html>',
  ].join('\n'));

  // 9) DASH 测试页
  fs.writeFileSync(path.join(FIX, 'page-dash.html'), [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>test dash</title></head><body>',
    '<video id="v" controls></video>',
    '<script>fetch("/dash-tpl/index.mpd").then(r=>r.text()).catch(()=>{});</script>',
    '</body></html>',
  ].join('\n'));

  const expect = durationOf(ffprobe, src);
  return { src, expectDuration: expect };
}

// ─────────────────── 强制校验 Referer 的本地服务器 ───────────────────

const MEDIA_RE = /\.(m3u8|mpd|ts|m4s|mp4|key)(\?|$)/i;

function startServer() {
  return new Promise((resolve) => {
    const hits = { noReferer: 0, ok: 0 };
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const file = path.join(FIX, decodeURIComponent(u.pathname));

      // 媒体文件强制要求 Referer——复现真实站点的防盗链
      if (MEDIA_RE.test(u.pathname) && !req.headers.referer) {
        hits.noReferer++;
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('no referer');
        return;
      }
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404); res.end('not found'); return;
      }
      hits.ok++;
      const ext = path.extname(file).toLowerCase();
      const mime = {
        '.m3u8': 'application/vnd.apple.mpegurl',
        '.mpd': 'application/dash+xml',
        '.ts': 'video/vnd.dlna.mpeg-tts',
        '.m4s': 'video/iso.segment',
        '.mp4': 'video/mp4',
        '.key': 'application/octet-stream',
        '.html': 'text/html; charset=utf-8',
      }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': fs.statSync(file).size });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, hits });
    });
  });
}

// ───────────────────────── 测试用例 ─────────────────────────

function main() {
  const ff = ffmpegPath();
  const ffprobe = ffprobePath(ff);

  console.log('');
  console.log(C.b('  hls-downloader 自测'));
  console.log(C.dim('  ─────────────────────────────────────'));

  if (run(ff, ['-version']).code !== 0) {
    console.error(C.red('  ffmpeg 不可用，无法自测')); process.exit(1);
  }

  const { expectDuration } = buildFixtures(ff, ffprobe);
  fs.mkdirSync(OUT, { recursive: true });

  return startServer().then(async ({ server, port, hits }) => {
    const base = `http://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      HTTPS_PROXY: '', HTTP_PROXY: '', https_proxy: '', http_proxy: '',
      ALL_PROXY: '', all_proxy: '',
    };

    const results = [];

    // expectSec：期望时长，默认用源视频时长；只下部分内容的用例（如 --period）需要单独指定
    async function caseRun(name, args, checks, expectSec) {
      const want = expectSec === undefined ? expectDuration : expectSec;
      const outFile = path.join(OUT, name.replace(/[^\w\u4e00-\u9fa5]+/g, '_') + '.mp4');
      fs.rmSync(outFile, { force: true });
      const r = await runAsync(process.execPath, [TOOL, ...args, '-o', outFile], { env });
      const combined = stripAnsi(r.out + r.err);
      const problems = [];
      if (r.code !== 0) problems.push(`退出码 ${r.code}`);
      if (!fs.existsSync(outFile)) problems.push('没有生成输出文件');
      else {
        const dur = durationOf(ffprobe, outFile);
        if (dur === null) problems.push('ffprobe 读不出时长');
        else if (Math.abs(dur - want) > 1.5) problems.push(`时长偏差过大: ${dur.toFixed(2)}s，期望约 ${want.toFixed(2)}s`);
        const dec = run(ff, ['-v', 'error', '-i', outFile, '-f', 'null', '-']);
        if (dec.code !== 0) problems.push('解码报错: ' + dec.err.split('\n')[0]);
      }
      if (checks) {
        const extra = checks(combined, outFile) || [];
        problems.push(...extra);
      }
      results.push({ name, problems, log: combined });
      const mark = problems.length === 0 ? C.grn('  PASS') : C.red('  FAIL');
      console.log(`${mark}  ${name}`);
      for (const p of problems) console.log(C.dim(`          ${p}`));
      if (problems.length > 0) {
        const tail = combined.split('\n').map(s => s.trimEnd()).filter(Boolean).slice(-12);
        for (const line of tail) console.log(C.dim(`          │ ${line}`));
      }
      return combined;
    }

    // ── 用例 1：明文 TS，走完整嗅探路径 ──
    await caseRun('明文TS·嗅探路径', [`${base}/page.html`], (log) => {
      const out = [];
      if (!/嗅探到 1 个 m3u8/.test(log)) out.push('嗅探结果不符合预期');
      if (!/加密\s+无/.test(log)) out.push('未正确识别为明文');
      if (!/容器\s+MPEG-TS/.test(log)) out.push('未正确识别容器类型');
      return out;
    });

    // ── 用例 2：AES-128 加密，验证解密 ──
    await caseRun('AES128·自动解密', [`${base}/page.html`, '-m', `${base}/aes/index.m3u8`, '--referer', base + '/'], (log) => {
      const out = [];
      if (!/AES-128/.test(log)) out.push('未识别出 AES-128 加密');
      return out;
    });

    // ── 用例 3：fMP4 + 初始化段 ──
    await caseRun('fMP4·含初始化段', [`${base}/page.html`, '-m', `${base}/fmp4/index.m3u8`], (log) => {
      const out = [];
      if (!/容器\s+fMP4/.test(log)) out.push('未正确识别为 fMP4');
      return out;
    });

    // ── 用例 4：master 选流，默认取最高码率 ──
    await caseRun('master·默认最高码率', [`${base}/page.html`, '-m', `${base}/master/index.m3u8`], (log) => {
      const out = [];
      if (!/master 清单含 2 路码流/.test(log)) out.push('未识别 master playlist');
      if (!/选中 640x360/.test(log)) out.push('未选中最高码率');
      return out;
    });

    // ── 用例 5：master 选流，--quality 指定低码率 ──
    await caseRun('master·quality选流', [`${base}/page.html`, '-m', `${base}/master/index.m3u8`, '--quality', '320x180'], (log) => {
      const out = [];
      if (!/选中 320x180/.test(log)) out.push('--quality 未生效');
      return out;
    });

    // ── 用例 6：直链 MP4，-m 直接指定（顺带验证 Referer 自动推导）──
    await caseRun('直链MP4·-m指定', [`${base}/page.html`, '-m', `${base}/direct/video.mp4`], (log) => {
      const out = [];
      if (!/检测到直链媒体/.test(log)) out.push('未识别为直链媒体');
      return out;
    });

    // ── 用例 7：直链 MP4，走嗅探路径 ──
    await caseRun('直链MP4·嗅探路径', [`${base}/page-mp4.html`], (log) => {
      const out = [];
      if (!/嗅探到 1 个直链媒体候选/.test(log)) out.push('未嗅探到直链媒体候选');
      if (!/检测到直链媒体/.test(log)) out.push('未走直链下载分支');
      return out;
    });

    // ── 用例 8-12：DASH 四种分片寻址模式 + 嗅探路径 ──
    await caseRun('DASH·模板+时间线', [`${base}/page.html`, '-m', `${base}/dash-tpl/index.mpd`], (log) => {
      const out = [];
      if (!/选中 DASH 流/.test(log)) out.push('未走 DASH 分支');
      if (!/SegmentTemplate/.test(log)) out.push('未识别 SegmentTemplate');
      if (!/视频切片\s+\d+/.test(log)) out.push('未解析出视频切片');
      return out;
    });

    await caseRun('DASH·Number模式', [`${base}/page.html`, '-m', `${base}/dash-num/index.mpd`], (log) => {
      const out = [];
      if (!/选中 DASH 流/.test(log)) out.push('未走 DASH 分支');
      return out;
    });

    await caseRun('DASH·SegmentList', [`${base}/page.html`, '-m', `${base}/dash-list/index.mpd`], (log) => {
      const out = [];
      if (!/SegmentList/.test(log)) out.push('未识别 SegmentList');
      return out;
    });

    await caseRun('DASH·单文件', [`${base}/page.html`, '-m', `${base}/dash-single/index.mpd`], (log) => {
      const out = [];
      if (!/SegmentList\(整文件\)/.test(log)) out.push('未识别 SegmentList 字节范围寻址');
      return out;
    });

    await caseRun('DASH·SegmentBase', [`${base}/page.html`, '-m', `${base}/dash-base/index.mpd`], (log) => {
      const out = [];
      if (!/SegmentBase\(整文件\)/.test(log)) out.push('未识别 SegmentBase 寻址');
      return out;
    });

    await caseRun('DASH·段数虚高容错', [`${base}/page.html`, '-m', `${base}/dash-short/index.mpd`], (log) => {
      const out = [];
      if (!/404（清单声明的段数多于实际/.test(log)) out.push('未触发 404 容错路径');
      return out;
    });

    await caseRun('DASH·嗅探路径', [`${base}/page-dash.html`], (log) => {
      const out = [];
      if (!/嗅探到 1 个 DASH 清单候选/.test(log)) out.push('未嗅探到 DASH 清单');
      if (!/选中 DASH 流/.test(log)) out.push('未走 DASH 分支');
      return out;
    });

    await caseRun('DASH·分层索引单文件', [`${base}/page.html`, '-m', `${base}/dash-hier/index.mpd`], (log) => {
      const out = [];
      if (!/单文件/.test(log)) out.push('未走单文件分支');
      if (!/已剥离分层索引/.test(log)) out.push('未剥离 sidx 分层索引（ffmpeg 会直接拒开文件）');
      return out;
    });

    await caseRun('DASH·多Period拼接', [`${base}/page.html`, '-m', `${base}/dash-multi/index.mpd`], (log) => {
      const out = [];
      if (!/清单含 2 个 Period/.test(log)) out.push('未识别出多个 Period');
      if (!/Period 1 \(P1\)/.test(log) || !/Period 2 \(P2\)/.test(log)) out.push('未按 Period 分别列出选流结果');
      if (!/按序拼接 2 个 Period/.test(log)) out.push('未走多 Period 拼接路径');
      return out;
    });

    // 各段分辨率不同时，ffmpeg 的 concat -c copy 其实不会报错（只吐 Non-monotonic DTS
    // 警告、退出码 0），但产出的文件容器元数据只记第一段参数，后半段实际对不上。
    // 所以工具必须在下载前就把参数差异讲出来，不能等"拼接失败"来兜。
    await caseRun('DASH·多Period参数不一致警告', [`${base}/page.html`, '-m', `${base}/dash-multi-diff/index.mpd`], (log) => {
      const out = [];
      if (!/各 Period 的编码参数不一致/.test(log)) out.push('未给出参数不一致警告');
      if (!/640x360/.test(log) || !/480x360/.test(log)) out.push('警告里没列出各段实际参数');
      return out;
    });

    await caseRun('DASH·--period选段', [`${base}/page.html`, '-m', `${base}/dash-multi/index.mpd`, '--period', '2'], (log) => {
      const out = [];
      if (!/只下第 2 个 Period/.test(log)) out.push('--period 未生效');
      if (/按序拼接/.test(log)) out.push('--period 时不该走拼接路径');
      return out;
    }, SRC_SECONDS / 2);

    // ── 用例 13：--probe 只探测不下载 ──
    {
      const r = await runAsync(process.execPath, [TOOL, `${base}/page.html`, '--probe'], { env });
      const log = r.out + r.err;
      const problems = [];
      if (r.code !== 0) problems.push(`退出码 ${r.code}`);
      if (!/--probe 模式：仅探测，未下载/.test(log)) problems.push('未进入 probe 模式');
      results.push({ name: '--probe 只探测', problems });
      console.log(`${problems.length === 0 ? C.grn('  PASS') : C.red('  FAIL')}  --probe 只探测`);
      for (const p of problems) console.log(C.dim(`          ${p}`));
    }

    // ── 用例 14：--progress-json 机器可读进度协议 ──
    // GUI 靠它显示进度。约定：事件带 @@HLSDL@@ 前缀走 stderr，
    // 人类可读输出照旧走 stdout —— 两边必须互不污染。
    {
      const TAG = '@@HLSDL@@ ';
      const problems = [];
      const pjOut = path.join(OUT, 'progress-json.mp4');
      fs.rmSync(pjOut, { force: true });
      const r = await runAsync(process.execPath,
        [TOOL, `${base}/page.html`, '-m', `${base}/plain/index.m3u8`, '-o', pjOut, '--progress-json'],
        { env });

      const tagged = r.err.split('\n').filter(l => l.startsWith(TAG));
      if (tagged.length === 0) problems.push('stderr 里没有任何 @@HLSDL@@ 进度事件');

      const events = [];
      for (const l of tagged) {
        try { events.push(JSON.parse(l.slice(TAG.length))); }
        catch { problems.push('进度事件不是合法 JSON: ' + l.slice(0, 80)); }
      }

      // stdout 是给人看的，不能混进协议行
      if (r.out.includes(TAG)) problems.push('stdout 里混进了 @@HLSDL@@ 事件（应该只走 stderr）');

      const segs = events.filter(e => e.t === 'seg' && e.label === '切片');
      if (!segs.length) problems.push('没有 t=seg 的切片进度事件');
      else {
        if (segs.some(e => !(e.total > 0) || !(e.done >= 0))) problems.push('seg 事件缺 done/total 字段');
        const last = segs[segs.length - 1];
        if (last.done !== last.total) problems.push(`最后一个 seg 事件没到齐: ${last.done}/${last.total}`);
      }
      const res = events.filter(e => e.t === 'result');
      if (res.length !== 1) problems.push(`应有且仅有 1 个 t=result 事件，实际 ${res.length}`);
      else {
        if (path.resolve(res[0].file) !== path.resolve(pjOut)) problems.push('result 事件里的路径不对: ' + res[0].file);
        if (!(res[0].size > 0)) problems.push('result 事件没带文件大小');
      }
      if (events.some(e => e.t === 'error')) problems.push('正常下载却发了 t=error 事件');
      // 人看的输出照旧要完整 —— 直接给了 -m 就不走嗅探，所以盯收尾那行
      if (!/完成:/.test(stripAnsi(r.out))) problems.push('stdout 的正常输出被影响了（没有收尾的「完成:」）');

      // 不加这个开关时，一个协议行都不该出现
      const offOut = path.join(OUT, 'progress-off.mp4');
      fs.rmSync(offOut, { force: true });
      const r2 = await runAsync(process.execPath,
        [TOOL, `${base}/page.html`, '-m', `${base}/plain/index.m3u8`, '-o', offOut],
        { env });
      if (r2.err.includes(TAG) || r2.out.includes(TAG)) problems.push('没加 --progress-json 却也打出了协议行');

      results.push({ name: '--progress-json 进度协议', problems });
      console.log(`${problems.length === 0 ? C.grn('  PASS') : C.red('  FAIL')}  --progress-json 进度协议`);
      for (const p of problems) console.log(C.dim(`          ${p}`));
      if (problems.length === 0) {
        console.log(C.dim(`          ${tagged.length} 个事件，类型: ${[...new Set(events.map(e => e.t))].join(' / ')}`));
      }
    }

    // ── 用例 15：服务器确实拦了不带 Referer 的请求 ──
    {
      const problems = [];
      const probe = await new Promise((res) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/plain/index.m3u8', method: 'GET' }, r => {
          r.resume(); res(r.statusCode);
        });
        req.on('error', () => res(0));
        req.end();
      });
      if (probe !== 403) problems.push(`不带 Referer 的请求应返回 403，实际 ${probe}`);
      if (hits.noReferer === 0) problems.push('服务器从未拒绝过缺 Referer 的请求，防盗链形同虚设');
      results.push({ name: '防盗链生效性', problems });
      console.log(`${problems.length === 0 ? C.grn('  PASS') : C.red('  FAIL')}  防盗链生效性`);
      for (const p of problems) console.log(C.dim(`          ${p}`));
    }

    server.close();

    const failed = results.filter(r => r.problems.length > 0);
    console.log('');
    console.log(C.b(`  结果: ${results.length - failed.length}/${results.length} 通过`));
    console.log('');

    // 清理
    fs.rmSync(FIX, { recursive: true, force: true });
    fs.rmSync(OUT, { recursive: true, force: true });

    process.exit(failed.length === 0 ? 0 : 1);
  }).catch(e => {
    try { fs.rmSync(FIX, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(OUT, { recursive: true, force: true }); } catch { /* ignore */ }
    console.error(C.red('  自测异常: ' + e.message));
    process.exit(1);
  });
}

main();
