# hls-downloader

网页视频流下载工具。给它一个视频页面链接，它自己找出视频流、抓下来、存成本地 MP4。

支持三类流，嗅探后自动判断：

- **HLS**（m3u8 分片）——含 master 选流、AES-128 解密、fMP4 初始化段
- **DASH**（mpd 清单）——音视频轨分别下载后混流
- **直链媒体**（mp4 / webm / mkv / mov / flv）——直接下载，必要时无损转封装

零第三方依赖——只用 Node 自带的 `WebSocket` / `fetch` / `crypto`，外加系统里的 ffmpeg。

不想敲命令行的话，同仓库的 [`gui/`](gui/) 有个 Electron 界面，也能直接打包成单个 exe：

![图形界面](gui/docs/screenshot-done.png)

---

## 仓库结构

```
hls-downloader/
├── hls-downloader.js        # CLI 主体（约 1500 行，零运行时依赖）
├── mp4-boxes.js             # MP4 盒子诊断小工具（排查 ffmpeg 打不开的文件）
├── test/run-tests.js        # CLI 自测：21 项，不需要联网
└── gui/                     # Electron 图形界面
    ├── main.js              #   主进程：找 CLI、拼参数、spawn、转事件
    ├── preload.js           #   contextBridge 白名单桥
    ├── launch.js            #   启动器：清掉 ELECTRON_RUN_AS_NODE 再拉起 Electron
    ├── renderer/            #   界面（HTML / CSS / JS，纯 UI 不碰 Node）
    ├── tools/               #   构建脚本：图标、拉 ffmpeg、打包
    └── test/gui-smoke.js    #   CDP 驱动的端到端自测
```

命令行和图形界面是**同一套下载逻辑**：界面只是个壳，真正的活儿全交给 `hls-downloader.js`。
所以 CLI 那 21 项自测覆盖的代码路径，就是界面实际走的路径。

---

## 环境要求

| 依赖 | 说明 |
|---|---|
| Node.js | 18 以上（用到全局 `WebSocket` 和 `fetch`） |
| Chrome 或 Edge | 用来嗅探页面里的视频流地址。装在哪都行，脚本会自动找 |
| ffmpeg | 用来把切片封装成 MP4。需在 PATH 里，或用 `--ffmpeg` 指定 |

检查一下：

```bash
node -v          # 应 >= v18
ffmpeg -version
```

---

## 快速开始

```bash
# 最简用法：一个链接搞定
node hls-downloader.js "https://example.com/video/123"

# 指定输出文件名
node hls-downloader.js "https://example.com/video/123" -o "我的视频.mp4"

# 只看有哪些视频流，不下载
node hls-downloader.js "https://example.com/video/123" --probe
```

输出文件默认落在当前目录，文件名优先取链接里的 `viewkey` / `id` 之类参数，取不到就用时间戳。

---

## 不想敲命令行？用图形界面

同目录下有个 `gui/`（Electron 封装），界面只是个壳，实际还是调这个 CLI：

```bash
cd gui
npm install
npm start
```

**也可以直接打包成单个 exe**——内置 Node、CLI 和 ffmpeg，拷到任何 Windows 机器上双击就能用，
目标机器什么都不用装：

```bash
cd gui
npm run build        # 产出 dist/hls-downloader-<版本>-portable.exe（133 MB）
```

代价是单文件便携版**每次启动要自解压约 12 秒**（无缓存）；追求启动速度用同时产出的 zip 版
（解压后启动约 0.2 秒）。详见 [`gui/README.md`](gui/README.md)。

那个文件里还写了 `npm install` 拉不到 Electron 二进制时怎么走镜像、`ELECTRON_RUN_AS_NODE`
那个会让 Electron 启动即崩的坑，以及打包时 `No JSON content found in output` 的根因和修法。

---

## 工作原理

```
页面 URL
   │
   ├─ 1. 无头 Chrome 打开页面，CDP 录制全部网络请求
   │       ├─ 找到 .m3u8  → 走 HLS 分支
   │       ├─ 找到 .mpd   → 走 DASH 分支
   │       └─ 只找到 .mp4 等直链 → 走直链分支
   │
   ├─ 【HLS 分支】
   │   ├─ 拉取 m3u8 清单
   │   │     ├─ 是 master playlist？ → 按码率选一路
   │   │     ├─ 有 #EXT-X-KEY？     → AES-128 自动解密
   │   │     └─ 有 #EXT-X-MAP？     → 先下初始化段
   │   ├─ 并发抓全部切片（默认 16 并发，带正确的 Referer / UA）
   │   ├─ 按序拼接 → ffmpeg 无损封装（-c copy，不重编码）
   │   └─ 解码校验头尾 → 清理中间文件 → MP4
   │
   ├─ 【DASH 分支】
   │   ├─ 解析 MPD，按码率挑一路视频 + 一路音频
   │   ├─ 支持四种分片寻址：SegmentTemplate($Number$/$Time$)、SegmentList、
   │   │   SegmentList+字节范围、SegmentBase（后两者整文件下载）
   │   ├─ 两条轨道分别并发下载 → 各自拼接
   │   ├─ 单文件轨若带分层索引（sidx type-1）→ 自动剥掉索引再封装
   │   ├─ 有多个 Period？→ 每个 Period 各自封装，再按序无损拼接
   │   ├─ ffmpeg 混流（-c copy）
   │   └─ 解码校验 → 完成
   │
   └─ 【直链分支】
       ├─ 流式下载（带进度）
       ├─ 已是 mp4 直接落地；否则 ffmpeg 无损转封装，失败则保留原文件
       └─ 解码校验 → 完成
```

**Referer 会自动推导**：只要给了页面 URL，就取其 origin 作为 Referer——即使用 `-m` 直接指定流地址也一样。很多 CDN 强制校验 Referer，少了这个头会直接 403。

**为什么不用 ffmpeg 直接吃 m3u8？** 实测过：ffmpeg 的 HLS 解复用器**不会**把 `-headers` / `-user_agent` 透传给切片请求，切片是拿默认 UA `Lavf/xx` 且不带 Referer 去拉的。碰上校验 Referer 的 CDN 就全段 403。本工具用 Node 自己发请求，header 完全可控，绕开这个坑。

**为什么要手动剥 MP4 索引？** 有些 DASH 单文件轨道（`isoff-on-demand` profile——清单里 Representation 只有 `<BaseURL>`，没有 `<SegmentBase>`）是「分层索引」MP4：顶层 `sidx` 的引用类型是 1，指向下一级 `sidx` 而不是媒体数据。ffmpeg 直到 8.x 都没实现 type-1 引用，读到直接拒开文件（`sidx reference_type 1 is not implemented`）。而 `sidx` / `ssix` 只是给播放器做字节寻址用的索引，顺序解码根本不需要，所以工具会在封装前把它们摘掉。摘之前会先确认 `moof` 里的 `tfhd` 是 moof 相对寻址——不满足就保持原样，宁可让 ffmpeg 报错也不写坏文件。

---

## 参数

| 参数 | 说明 |
|---|---|
| `-o, --output <文件>` | 输出路径。默认 `./<viewkey或时间戳>.mp4` |
| `-m, --m3u8 <URL>` | 跳过浏览器嗅探，直接指定流地址（m3u8 / mpd / mp4 均可） |
| `--referer <URL>` | 手动指定 Referer，默认自动取页面 origin |
| `--user-agent <UA>` | 自定义 User-Agent |
| `-c, --concurrency <N>` | 切片并发数，默认 16（HLS 与 DASH 通用）。站点限流时可调低 |
| `-t, --timeout <秒>` | 单请求超时，默认 30 |
| `--quality <规格>` | 选流：`best`（默认）/ `worst` / 分辨率如 `1280x720` / 带宽数字 |
| `--period <N>` | 多 Period 的 MPD 只下第 N 个 Period（默认全部按序拼接） |
| `--probe` | 只嗅探并列出视频流，不下载 |
| `--headed` | 显示浏览器窗口（默认无头）。页面需要手动点击才播放时有用 |
| `--keep-temp` | 保留中间文件（切片、拼接文件），排查问题用 |
| `--cookie <字符串>` | 附加 Cookie 头，需要登录的站用得上 |
| `--ffmpeg <路径>` | 指定 ffmpeg 可执行文件 |
| `--no-verify` | 跳过最终解码校验，快一点 |
| `--progress-json` | 进度事件以 JSON 打到 stderr（`@@HLSDL@@ ` 前缀），供 GUI / 脚本解析。不加则完全不输出 |
| `-h, --help` | 帮助 |

### `--progress-json` 进度协议

给人看的输出照旧走 **stdout**；进度事件走 **stderr**，一行一个 JSON，带 `@@HLSDL@@ ` 前缀。
两边互不污染，所以正常使用和自测都不受影响。

```
@@HLSDL@@ {"t":"seg","label":"切片","done":8,"total":16,"bytes":1234567,"failed":0}
@@HLSDL@@ {"t":"result","file":"D:\\videos\\a.mp4","size":21210211}
```

| 事件 | 字段 | 什么时候发 |
|---|---|---|
| `seg` | `label` `done` `total` `bytes` `failed` `missing` | HLS / DASH 切片进度，节流 150ms |
| `bytes` | `label` `done` `total` `bytes` | 直链媒体下载进度，节流 150ms |
| `result` | `file` `size` | 下载完成，一次 |
| `error` | `message` | 出错，一次 |

外部程序按行读 stderr、认前缀就能拿到进度，不需要解析任何人类可读文本。

---

## 常见情况处理

### 抓不到 m3u8

页面可能需要手动点一下播放器才开始加载。两步走：

```bash
# 第一步：开有头浏览器，手动点播放，观察它到底请求了什么
node hls-downloader.js "<页面URL>" --headed
```

还是不行的话，用浏览器自带的开发者工具抓：

1. 按 `F12` 打开开发者工具（Developer Tools）
2. 切到 **网络**（Network）面板
3. 在过滤框输入 `m3u8`
4. 刷新页面并点播放，找到那条请求，复制完整地址
5. 用 `--m3u8` 传进来：

```bash
node hls-downloader.js "<页面URL>" -m "<复制到的m3u8地址>"
```

### 报 403 Forbidden

多半是 Referer 或 Cookie 的问题：

```bash
node hls-downloader.js "<页面URL>" --referer "https://站点域名/"
node hls-downloader.js "<页面URL>" --cookie "sessionid=xxxx"
```

### 切片大量失败

站点在限流。把并发调低：

```bash
node hls-downloader.js "<页面URL>" -c 4
```

### 清单签名过期

部分站点给 m3u8 加了短时效签名（有效期内只有两三分钟）。本工具嗅探到地址后**立刻**就去拉清单，一般来得及。如果还是报错，重跑一次即可——每次重跑都会拿到新签名。

### 多 Period 的清单

有些 MPD 把内容切成多个 Period（插播广告、或按编码参数分段）。工具会**按顺序全部下载再拼接**，不会只取第一段。

需要注意的是：**各 Period 编码参数不一致时，无损拼接出来的文件容器元数据只会记录第一段的参数**。实测 ffmpeg 这时并不报错（只吐一句 `Non-monotonic DTS` 警告、退出码仍是 0），但后半段的分辨率实际对不上，部分播放器可能显示异常。工具会在下载前把各段参数列出来并明确警告。

想要干净的分段文件，用 `--period N` 只下其中一段：

```bash
node hls-downloader.js "<页面URL>" --period 2
```

---

## 支持的格式

| 项 | 支持情况 |
|---|---|
| **HLS** MPEG-TS 切片 | ✅ 完整支持 |
| **HLS** fMP4 切片（`#EXT-X-MAP` + `.m4s`） | ✅ 支持 |
| **HLS** master playlist 多码流 | ✅ 支持，可用 `--quality` 选 |
| **HLS** 无加密 | ✅ |
| **HLS** AES-128 加密 | ✅ 自动解密 |
| **DASH** SegmentTemplate（`$Number$` / `$Time$`） | ✅ 支持 |
| **DASH** SegmentTimeline | ✅ 支持 |
| **DASH** SegmentList（`media` 或 `mediaRange`） | ✅ 支持 |
| **DASH** SegmentBase（单文件 + 字节范围） | ✅ 支持（整文件下载） |
| **DASH** isoff-on-demand（Representation 只有 `<BaseURL>`） | ✅ 支持，自动剥离 ffmpeg 不认的分层索引（sidx type-1） |
| **DASH** 多 Period 的 MPD | ✅ 全部按序下载后无损拼接；各 Period 参数不一致时会警告，可用 `--period N` 只取一段 |
| **DASH** 音视频分轨 | ✅ 分别下载后混流 |
| 直链 mp4 / webm / mkv / mov / flv | ✅ 直接下载，非 mp4 会尝试无损转封装 |
| SAMPLE-AES / SAMPLE-AES-CTR / Widevine 等 DRM | ❌ 不支持，会明确报错 |

---

## 自测

```bash
node test/run-tests.js
```

不需要联网。脚本会用 ffmpeg 现场生成测试样本，起一个**强制校验 Referer** 的本地服务器（复现真实站点的防盗链），把每条代码路径真跑一遍：

| 用例 | 验证内容 |
|---|---|
| 明文TS·嗅探路径 | CDP 嗅探能定位 m3u8，且正确识别明文 / MPEG-TS |
| AES128·自动解密 | `#EXT-X-KEY` 识别 + 解密后能正常解码（关键帧完整） |
| fMP4·含初始化段 | `#EXT-X-MAP` 初始化段处理，输出可解码 |
| master·默认最高码率 | master playlist 解析 + 默认选流 |
| master·quality选流 | `--quality` 能命中指定分辨率 |
| 直链MP4·-m指定 | 直链媒体识别 + 下载（顺带验证 Referer 自动推导） |
| 直链MP4·嗅探路径 | 页面无 m3u8 时能嗅探到直链媒体并走对分支 |
| DASH·模板+时间线 | `SegmentTemplate` + `SegmentTimeline`（`$Number%05d$` 补零、`$RepresentationID$`） |
| DASH·Number模式 | `SegmentTemplate` 纯 `$Number$`（按 `@duration` 推算段数） |
| DASH·SegmentList | `SegmentList` + `media` 寻址 |
| DASH·单文件 | `SegmentList` + `mediaRange`（整文件下载） |
| DASH·SegmentBase | `SegmentBase` + 字节范围（手写清单，ffmpeg 产不出这种） |
| DASH·段数虚高容错 | 清单声明段数多于实际时，尾部 404 按正常截断处理而非报错 |
| DASH·分层索引单文件 | 复刻 `isoff-on-demand` 结构（手插 type-1 `sidx`）：自动剥离索引后 ffmpeg 才能封装 |
| DASH·多Period拼接 | 双 Period 清单按序全部下载并无损拼接，总时长正确 |
| DASH·多Period参数不一致警告 | 各段分辨率不同时给出明确警告（ffmpeg 自己不会报错，只会静默产出元数据错的文件） |
| DASH·--period选段 | `--period N` 只下指定的一段，且不走拼接路径 |
| DASH·嗅探路径 | 页面里能嗅探到 `.mpd` 并走对分支 |
| --probe 只探测 | 不落盘 |
| --progress-json 进度协议 | 事件全在 stderr 且都能解析成 JSON、stdout 不混协议行、`result` 事件路径与大小正确；不加开关时一个协议行都不出现 |
| 防盗链生效性 | 确认服务器真的会拦掉不带 Referer 的请求（否则测试形同虚设） |

跑完自动清理所有中间产物。

---

## 附带小工具：mp4-boxes

排查「ffmpeg 打不开某个 MP4」用的零依赖诊断脚本：

```bash
node mp4-boxes.js <文件>                  # 列出顶层盒子、sidx 引用类型、tfhd 寻址方式
node mp4-boxes.js <文件> --strip <输出>    # 摘掉 sidx/ssix 另存（结构不安全时拒绝执行）
```

主要用来确认 DASH 单文件轨是不是「分层索引」结构（`sidx` 带 type-1 引用）。这种情况工具会自动处理，但万一自动剥离被跳过（`tfhd` 用了绝对偏移），就需要拿它看清楚再决定下一步。

---

## 注意事项

- 本工具只做技术实现。下载内容的版权归原站，请仅用于个人合理使用，不要二次分发。
- 请遵守目标站点的服务条款与当地法律法规。
- 如果发现内容涉及未成年人或明显违法，请立即停止使用。

---

## 许可

[MIT](LICENSE)。
