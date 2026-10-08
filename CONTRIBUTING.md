# 为 SlowEcho Player 贡献

感谢你愿意参与。本项目是自托管的本地英语学习播放器，仓库只包含源码版。

## 环境准备

推荐 Python 3.11 或 3.12，开发检查建议 Node 20+。

```bat
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python serve_phone.py
```

Windows 上也可用 `setup.cmd` / `start.cmd`；`start.cmd` 在缺少虚拟环境或依赖时会先请求运行 `setup.cmd`，不会启动任何二进制 EXE。服务在终端中运行，**Ctrl+C** 关闭。其他平台可用 `.venv/bin/python` 形式，但原生对话框仅支持 Windows，且 Linux/macOS 未经完整验证。

可选工具依赖不在基础 `requirements.txt` 中：

- `requirements-ocr.txt`：`ocr_subtitles.py` 所需的 rapidocr-onnxruntime、opencv-python。
- `requirements-tools.txt`：`split_video.py` 所需的 imageio-ffmpeg 或系统 ffmpeg。

请把 `gen_subtitles.py`、`ocr_subtitles.py`、`split_video.py`、`merge_subtitles.py` 保留在仓库根目录，以维持相对导入。

## 运行检查

```bash
python -m unittest discover -s tests -p "test_*.py"
node tests/player.test.cjs
```

`node tests/player.test.cjs` 同时检查前端脚本语法；Python 测试同时解析源码语法。CI 在 Windows 上覆盖 Python 3.11/3.12 与 Node 22，不下载模型、不使用真实媒体或 API 密钥。请在 PR 中说明你实际运行了哪些命令；不要声称未运行过的检查已通过。

## 不要提交私有数据

请勿提交以下私有内容，也请在 PR、issue 和截图中主动移除它们（`.gitignore` 无法识别截图里的信息）：

- 浏览器配置文件、学习数据、日志与包含密钥的截图；
- 真实 DeepSeek API 密钥或任何凭据；
- 本地原片登记、会话、缓存、`.env`、发布归档；
- 私有绝对路径（例如你机器上的原片位置）。

注意不要用通配符忽略所有 JSON/SRT/HTML：开发夹具与源码元数据是合法内容，应按具体路径忽略运行时数据。

## 提交 PR

- 保持主题聚焦：一个 PR 解决一类问题，避免夹带无关重构或格式化。
- 兼容性优先：EchoPlayer 内部标识、`elp.*` 存储键、`ECHOPLAYER_*` 变量与 `X-EchoPlayer` 头为兼容保留，重命名需单独讨论。
- 前端改动需同步更新 `index.html` 的脚本加载顺序与注册表登记。
- 涉及导出字段的改动必须更新安全字段白名单并说明理由。
- 新增运行时依赖前先讨论；基础依赖保持精简。
- 提交前自查：无密钥、无真实用户数据、无私有路径。

## 许可

项目自有代码采用 [MIT 许可](LICENSE)。请确保你贡献的代码有权按此许可分发；第三方组件列表见 `THIRD_PARTY_NOTICES.md`。你导入的视频与外部依赖不受本项目许可重新授权。
