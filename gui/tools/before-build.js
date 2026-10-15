/**
 * electron-builder 的 beforeBuild 钩子。
 *
 * 返回 false = 告诉打包器「node_modules 我来管，你不用处理」。
 * 打包器收到 false 之后会整个跳过依赖安装 / 重建 / **依赖树收集**。
 *
 * 为什么这里必须返回 false：
 *
 * 1. 本项目零运行时依赖（electron / electron-builder 都是 devDependency），
 *    而且 electron-builder.yml 的 files 白名单里根本没有 node_modules。
 *    也就是说收集结果本来就没人用。
 *
 * 2. electron-builder 26 在 Windows 上是通过 `powershell.exe -EncodedCommand`
 *    去跑 `npm list --json` 的。这台机器的 PowerShell 环境下这条路走不通：
 *    - 无扩展名的 `npm` 会被解析成 npm.ps1（PowerShell 的 ExternalScript 优先级
 *      高于 .cmd，且是全局优先，往 PATH 前面塞目录没用）；
 *    - 那个 npm.ps1 垫片在非交互模式下会在 `$LASTEXITCODE` 上直接崩，npm 一行都没跑；
 *    - 即使换 npm.cmd，原生命令的 stdout 也捕获不到。
 *    最终打包器只拿到一坨 CLIXML，报 "No JSON content found in output"。
 *
 * 官方既然留了 beforeBuild 这个口子，就用它，别去改 package.json 或打 node_modules 补丁。
 */
'use strict';

module.exports = async function beforeBuild() {
  return false;
};
