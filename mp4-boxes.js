#!/usr/bin/env node
/**
 * mp4-boxes —— MP4 盒子结构诊断小工具（零依赖）
 *
 * 用途：排查 ffmpeg 打不开的 MP4，尤其是 DASH 单文件轨报
 *   sidx reference_type 1 is not implemented ... Error opening input
 * 时，用它看清文件里到底有什么。
 *
 * 用法:
 *   node mp4-boxes.js <文件>                 只看结构
 *   node mp4-boxes.js <文件> --strip <输出>   摘掉 sidx/ssix 另存一份
 */
'use strict';

const fs = require('fs');

function walk(d, start, end, cb) {
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

function readSidx(d, off, size, hdr) {
  const body = off + hdr;
  const ver = d[body];
  const refId = d.readUInt32BE(body + 4);
  const timescale = d.readUInt32BE(body + 8);
  const p = ver === 0 ? body + 20 : body + 28;
  if (p + 4 > off + size) return { ver, refId, timescale, refs: [] };
  const count = d.readUInt16BE(p + 2);
  const refs = [];
  for (let i = 0, q = p + 4; i < count && q + 12 <= off + size; i++, q += 12) {
    const w = d.readUInt32BE(q);
    refs.push({ type: w >>> 31, size: w & 0x7fffffff });
  }
  return { ver, refId, timescale, refs };
}

function readTfhd(d, off, size, hdr) {
  const flags = d.readUInt32BE(off + hdr) & 0xffffff;
  return {
    flags,
    trackId: d.readUInt32BE(off + hdr + 4),
    moofRelative: !!(flags & 0x020000),
    absoluteOffset: !!(flags & 0x000001),
  };
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  if (!file) {
    console.error('用法: node mp4-boxes.js <文件> [--strip <输出>]');
    process.exit(1);
  }
  const stripIdx = args.indexOf('--strip');
  const outFile = stripIdx >= 0 ? args[stripIdx + 1] : null;

  const d = fs.readFileSync(file);
  console.log(`\n== ${file}  (${d.length} 字节) ==`);

  const counts = {};
  const boxes = [];
  let type1 = 0;
  let firstMoof = null;

  walk(d, 0, d.length, (off, size, type, hdr) => {
    counts[type] = (counts[type] || 0) + 1;
    boxes.push({ off, size, type, hdr });
    if (type === 'sidx') {
      const s = readSidx(d, off, size, hdr);
      const n1 = s.refs.filter(r => r.type === 1).length;
      type1 += n1;
      if (counts[type] <= 3) {
        console.log(`  sidx  @${off}  v${s.ver}  refID=${s.refId}  timescale=${s.timescale}  `
          + `引用 ${s.refs.length} 个（type0=${s.refs.length - n1} type1=${n1}）`);
      }
    }
    if (type === 'moof' && !firstMoof) firstMoof = { off, size, hdr };
  });

  console.log('\n  顶层盒子统计: ' + Object.entries(counts).map(([k, v]) => `${k}×${v}`).join('  '));

  if (firstMoof) {
    const tf = [];
    walk(d, firstMoof.off + firstMoof.hdr, firstMoof.off + firstMoof.size, (o, s, t, h) => {
      if (t !== 'traf') return;
      walk(d, o + h, o + s, (o2, s2, t2, h2) => { if (t2 === 'tfhd') tf.push(readTfhd(d, o2, s2, h2)); });
    });
    for (const t of tf) {
      console.log(`  首个 moof 的 tfhd: track=${t.trackId} flags=0x${t.flags.toString(16).padStart(6, '0')} `
        + `moof相对寻址=${t.moofRelative ? '是' : '否'} 绝对偏移=${t.absoluteOffset ? '是' : '否'}`);
    }
  }

  if (type1 > 0) {
    console.log(`\n  ⚠ 存在 ${type1} 个 type-1 引用（指向下级 sidx）`);
    console.log('    ffmpeg 至今未实现该特性，会直接拒开文件：sidx reference_type 1 is not implemented');
    console.log('    sidx/ssix 只是字节寻址索引，顺序解码不需要，可安全摘除。');
  }

  if (outFile) {
    const covered = boxes.reduce((n, b) => n + b.size, 0);
    if (covered !== d.length) {
      console.error(`\n  ✗ 盒子只覆盖 ${covered}/${d.length} 字节，结构没吃透，拒绝写出`);
      process.exit(1);
    }
    if (firstMoof) {
      const tf = [];
      walk(d, firstMoof.off + firstMoof.hdr, firstMoof.off + firstMoof.size, (o, s, t, h) => {
        if (t !== 'traf') return;
        walk(d, o + h, o + s, (o2, s2, t2, h2) => { if (t2 === 'tfhd') tf.push(readTfhd(d, o2, s2, h2)); });
      });
      if (tf.some(t => t.absoluteOffset)) {
        console.error('\n  ✗ tfhd 使用绝对偏移（base-data-offset-present），删字节会让媒体错位，拒绝写出');
        process.exit(1);
      }
    }
    const keep = boxes.filter(b => b.type !== 'sidx' && b.type !== 'ssix');
    fs.writeFileSync(outFile, Buffer.concat(keep.map(b => d.subarray(b.off, b.off + b.size))));
    console.log(`\n  ✓ 已写出 ${outFile}：摘掉 ${boxes.length - keep.length} 个索引盒子，`
      + `${d.length} → ${fs.statSync(outFile).size} 字节`);
  }
  console.log('');
}

main();
