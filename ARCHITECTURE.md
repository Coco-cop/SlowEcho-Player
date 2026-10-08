# SlowEcho Player 架构说明

## 总体分层

浏览器前端（原生 JavaScript + EchoPlayer 注册表）→ 本地 Python HTTP 服务（`serve_phone.py`）→ 识别、字幕、媒体与存储模块。识别默认在本机执行；同一 WiFi 的手机也可作为浏览器端使用。

## 前端模块加载顺序与注册表

`js/runtime.js` 提供 `EchoPlayer` 模块注册表。前端在 `index.html` 中以普通 `<script>` 依次加载运行时、播放与字幕相关模块、`offline-pack.js`，样式为 `styles/player.css` 和 `styles/liquid-glass.css`。无打包器、无构建步骤，因此：

- 模块间的依赖必须通过注册表按加载顺序解析，不能依赖打包工具的静态提升。
- 新增模块需在 `index.html` 的加载序列中保持正确位置，并在注册表登记。
- 名称沿用 EchoPlayer 前缀，以兼容既有代码、`elp.*` 存储键、`ECHOPLAYER_*` 环境变量和 `X-EchoPlayer` 头。

## 前端职责划分

| 关注点 | 说明 |
| --- | --- |
| 播放 | 视频元素控制、倍速、按句循环、句间间隔 |
| 字幕 | SRT/VTT 解析、句子切分与撤销、时间偏移显示 |
| 学习辅助 | 词典、音标、翻译、词汇导出 |
| 库与进度 | 媒体库列表、进度续播，偏好写入 `localStorage` 的 `elp.*` |
| 离线课程包 | 由 `offline-pack.js` 生成 |

## 后端入口与模块映射

`serve_phone.py` 默认监听端口 **8876**，参数形式为 `[port] [--no-browser]`；它会导入 `recognition_server.py` 完成识别相关路由。`serve_phone.py` 绑定 `0.0.0.0` 以便局域网共享，同时支持本机桌面访问与同一 WiFi 手机访问。

服务提供白名单中的前端资源、`/api/transcribe`、`/api/jobs/{id}`、库/媒体、二维码、离线课程包与分享接口。

| 模块 | 职责 |
| --- | --- |
| `recognition_server.py` | 识别请求处理与模型调用 |
| `subtitle_store.py` | 字幕持久化 |
| `local_media.py` | 本地原片登记，`local-media.json` 保存私有绝对路径 |
| `listening_audio.py` | 听力音频处理 |
| `listening_segments.py` | 句子/片段切分 |
| `storage_config.py` | 配置读取，默认 `~/.echoplayer/storage.json` |
| `portable_paths.py` | 便携目录路径解析 |
| `native_dialogs.py` | 通过 ctypes 调用 Windows 原生对话框（仅 Windows） |
| `desktop_bootstrap.py` | 遗留隐藏便携后端入口，非原 EXE 启动器完整来源 |

## 请求校验

后端在敏感路由上同时检查请求头与来源/主机信息：`X-EchoPlayer` 标识用于区分本方前端请求，来源（Origin）与主机（Host）校验用于降低跨站或非预期主机名访问的风险。这两类校验共同构成对局域网共享场景的基本防护，不能替代网络层隔离。

## 离线课程包与字段白名单

导出离线课程包时，向包内写入的学习字段应经过**安全字段白名单**筛选，只保留白名单内的键值，避免把浏览器中的无关状态（如密钥、临时会话）带入导出文件。新增导出字段时必须先加入白名单并评估其敏感性。

## 存储与状态

| 状态 | 位置 |
| --- | --- |
| 字幕库 | `~/.echoplayer/subtitles` |
| 配置 | `~/.echoplayer/storage.json` |
| 原片登记 | `~/.echoplayer/local-media.json` |
| 浏览器偏好/进度/生词 | `localStorage` 的 `elp.*`（含 `elp.settings.dsKey`，初始为空） |
| 热点信息 | `localStorage` 的 `echoplayer.hotspot` |

`ECHOPLAYER_STORAGE_CONFIG`、`ECHOPLAYER_LIBRARY_DIR`、`ECHOPLAYER_MODEL_DIR` 可覆盖默认路径。浏览器源与端口变化会影响 `localStorage` 的可见范围。

## 测试结构

Python 测试通过 unittest 隔离到临时目录，覆盖源码语法、切分、库与本地 HTTP 冒烟；Node 测试用 VM/桩验证字幕解析与播放逻辑。CI 配置在 Windows 上运行 Python 3.11/3.12 与 Node 22；测试不下载模型、不使用真实媒体或 API 密钥。
