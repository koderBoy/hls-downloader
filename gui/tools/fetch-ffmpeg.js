#!/usr/bin/env node
/**
 * 拉取打包要用的 ffmpeg / ffprobe 静态二进制。
 *
 * 为什么不直接用系统里那个 ffmpeg：用户装的是 gyan.dev 的 full_build，
 * 单个 exe 就 227MB（ffmpeg + ffprobe 合计 454MB），打进便携版完全不能接受。
 * 这里换成 BtbN 的精简静态构建，每个 77MB，gzip 后只有 29MB。
 *
 * 走 npmmirror 的二进制镜像，国内可直连，不依赖 GitHub。
 *
 * 用法:  node tools/fetch-ffmpeg.js [--force]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

const BASE = process.env.FFMPEG_MIRROR
  || 'https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.0';

// 目标平台。要打别的平台就在这儿加。
const PLATFORM = process.env.FFMPEG_PLATFORM || 'win32-x64';
const SUFFIX = PLATFORM.startsWith('win32') ? '.exe' : '';

const VENDOR = path.join(__dirname, '..', 'vendor', PLATFORM);

const WANT = [
  { out: 'ffmpeg' + SUFFIX, src: `ffmpeg-${PLATFORM}.gz`, minBytes: 20 * 1024 * 1024 },
  { out: 'ffprobe' + SUFFIX, src: `ffprobe-${PLATFORM}.gz`, minBytes: 20 * 1024 * 1024 },
];

const force = process.argv.includes('--force');

const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get('content-length') || 0);
  let got = 0;
  let lastPrint = 0;

  const gunzip = zlib.createGunzip();
  const out = fs.createWriteStream(dest);

  const source = res.body;
  source.on?.('error', () => {});
  await pipeline(source, gunzip, out).catch(async (e) => {
    // Node 的 ReadableStream 出错时信息很糙，补一句人话
    throw new Error(`下载或解压失败：${e.message}（${url}）`);
  });
  return { total, got: fs.statSync(dest).size };
}

async function main() {
  fs.mkdirSync(VENDOR, { recursive: true });
  console.log('');
  console.log(`  拉取静态 ffmpeg  (${PLATFORM})`);
  console.log(`  源: ${BASE}`);
  console.log('  ─────────────────────────────────────');

  for (const w of WANT) {
    const dest = path.join(VENDOR, w.out);
    if (!force && fs.existsSync(dest) && fs.statSync(dest).size >= w.minBytes) {
      console.log(`  跳过 ${w.out}  （已存在，${mb(fs.statSync(dest).size)}）`);
      continue;
    }
    const url = `${BASE}/${w.src}`;
    process.stdout.write(`  下载 ${w.out} … `);
    const t0 = Date.now();
    try {
      await download(url, dest);
    } catch (e) {
      try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
      console.log('失败');
      console.error('  ✗ ' + e.message);
      process.exit(1);
    }
    const size = fs.statSync(dest).size;
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (size < w.minBytes) {
      console.log('不对劲');
      console.error(`  ✗ 解出来只有 ${mb(size)}，比预期小太多，文件可能坏了`);
      process.exit(1);
    }
    console.log(`${mb(size)}  ${secs}s`);
  }

  console.log('');
  console.log(`  就绪: ${VENDOR}`);
  console.log('');
}

main().catch((e) => { console.error('  ✗ ' + e.message); process.exit(1); });
