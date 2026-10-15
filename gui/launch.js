#!/usr/bin/env node
'use strict';
/**
 * 启动器。
 *
 * 为什么不直接 `electron .`：
 * 有些环境（比如 WorkBuddy 的 shell）里设了 ELECTRON_RUN_AS_NODE=1，那是给自家
 * Node 工具链用的。但 electron.exe 只要看到这个变量就会退化成纯 Node ——
 * require('electron') 只会返回一个路径字符串，主进程第一行就崩在 ipcMain 上，
 * 报错还是句莫名其妙的 "Cannot read properties of undefined (reading 'handle')"。
 *
 * 所以这里显式把它删掉再拉起 Electron，让 `npm start` 在什么 shell 里都能用。
 */
const { spawn } = require('child_process');
const path = require('path');

let bin;
try {
  bin = require('electron');            // 纯 Node 下：返回 electron 可执行文件路径
} catch { /* 下面兜底 */ }
if (typeof bin !== 'string') bin = process.execPath;   // 已经在 Electron 里了

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const cp = spawn(bin, [__dirname, ...process.argv.slice(2)], { stdio: 'inherit', env });
cp.on('close', (code) => process.exit(code == null ? 0 : code));
cp.on('error', (e) => {
  console.error('启动 Electron 失败：' + e.message);
  console.error('如果还没装依赖，先在当前目录跑一次 npm install。');
  process.exit(1);
});
