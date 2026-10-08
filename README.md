# SlowEcho Player

> 喜欢的视频，一句一句听懂。

一款以本地视频为素材的英语精听播放器。导入喜欢的视频，配上字幕，选一句反复听，再逐步听懂整段内容。支持电脑浏览器，也支持同一 WiFi 下的手机访问。

## 能做什么

- 导入本地视频与 SRT / VTT 字幕；没有字幕时，可在电脑上用 faster-whisper 生成。
- 单句循环、上一句 / 下一句、倍速、循环间隔与字幕时间偏移。
- 双语字幕、按词查释义和音标、翻译、生词本与导出。
- 编辑和切分字幕、撤销切分、共享文件库与学习进度续播。
- 导出选定视频和字幕的离线课程包。

在线词典、翻译和 DeepSeek 润色属于可选功能，依赖对应服务的网络、接口及费用规则。

## Windows 快速开始

推荐 **Windows 10/11 + Python 3.11 或 3.12**。请先安装 Python，并启用安装器中的 PATH 选项。

1. 下载本仓库并解压，或用 Git 克隆。
2. 双击 `setup.cmd`，创建 `.venv` 并安装依赖。安装需要联网，首次可能较慢。
3. 双击 `start.cmd`（也可用 `启动播放器.cmd`），浏览器会打开播放器。
4. 打开视频，导入字幕；选中字幕句子，开启“单句循环”。

停止服务：回到启动时打开的终端，按 **Ctrl+C**。下次使用只需运行 `start.cmd`。

也可以在项目目录手动执行：

```bat
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python serve_phone.py
```

默认电脑地址：`http://localhost:8876/index.html`。端口被占用时可运行：

```bat
start.cmd 9000
```

`start.cmd` 会检查虚拟环境和基础依赖；缺少时提示先运行 `setup.cmd`。源码版需要 Python。本仓库不分发便携 Python、模型或原启动 EXE；`desktop_bootstrap.py` 保留便携后端兼容逻辑，不能用它重建原 EXE。

Linux/macOS 可用 `.venv/bin/python` 执行相同 Python 命令，但原生文件对话框仅支持 Windows，这两个平台尚未完整验证。前端没有 npm 安装或构建步骤。

## 手机使用

电脑和手机连接同一可信 WiFi，保持电脑服务运行。用手机浏览器打开终端打印的局域网地址，或扫描生成的二维码。手机选择的视频可通过局域网发送到电脑进行识别；播放仍由浏览器负责。防火墙询问时，只在你信任的专用网络允许访问。

服务监听 `0.0.0.0`，可达的局域网设备可能访问共享内容。请勿直接映射到公网，也不要用于多用户托管。源码放在 GitHub 不代表后端功能能在 GitHub Pages 运行。

## 模型、存储与隐私

首次识别会下载所选 faster-whisper 模型；模型下载完成后，本机识别可离线运行。`ECHOPLAYER_MODEL_DIR` 可指定模型缓存目录，沿用 faster-whisper / Hugging Face 的缓存结构；它不是任意单个模型文件路径。

| 内容 | 默认位置 |
| --- | --- |
| 字幕 / 可选保存的视频 | `~/.echoplayer/subtitles` |
| 共享库配置 | `~/.echoplayer/storage.json` |
| 电脑原片路径登记 | `~/.echoplayer/local-media.json` |
| 设置、续播进度、生词 | 当前网址下的浏览器 localStorage |

在“共享文件库”中可改存放目录。环境变量 `ECHOPLAYER_LIBRARY_DIR` 与 `ECHOPLAYER_STORAGE_CONFIG` 可分别覆盖库目录和配置文件位置。浏览器打开视频与文件库保存是两个步骤；是否自动复制视频取决于设置，电脑原片登记也可能仅记录原路径。更换库目录不会自动搬迁旧文件。

为了兼容旧版学习记录，内部 `EchoPlayer` 模块名、`elp.*` 存储键、`ECHOPLAYER_*` 环境变量、请求头和 `.echoplayer` 目录沿用旧名。浏览器地址、端口或浏览器变化后，原 localStorage 可能不可见。

启用在线查词、发音、翻译或 AI 润色时，相关词条或字幕文字会发给对应服务。DeepSeek 密钥由用户自行提供，初始为空，保存在当前浏览器的 `elp.settings.dsKey`；请不要在截图或导出资料中公开密钥。WiFi 助手可能读取 / 保存热点名称和密码，并生成包含它们的 WiFi 二维码。详情见 [SECURITY.md](SECURITY.md)。

## 可选命令行工具

在项目根目录运行脚本的 `--help` 查看参数：

| 脚本 | 用途 | 额外依赖 |
| --- | --- | --- |
| `gen_subtitles.py` | 批量生成字幕 | 基础依赖 |
| `ocr_subtitles.py` | 硬字幕 OCR | `pip install -r requirements-ocr.txt` |
| `split_video.py` | 视频切分 | `pip install -r requirements-tools.txt`，或 PATH 上的 FFmpeg |
| `merge_subtitles.py` | 合并分段字幕 | Python 标准库 |

## 开发与检查

推荐开发环境安装 Node 22+。无须 npm：

```bash
python -m unittest discover -s tests -p "test_*.py" -v
node tests/player.test.cjs
```

测试使用合成字幕和临时目录，检查单句循环、字幕解析、存储过滤和本地 HTTP 接口，不下载模型或使用真实媒体 / API 密钥。CI 配置覆盖 Windows、Python 3.11/3.12 和 Node 22；完整模型识别和在线服务需要单独验证。

贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)，模块说明见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 许可

项目自有代码使用 [MIT 许可](LICENSE)。第三方组件和模型的许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。导入的视频、字幕及外部服务不因本项目许可而被重新授权，请仅分享你有权分享的内容。
