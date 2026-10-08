# 第三方组件与服务

SlowEcho Player 自有代码使用 MIT 许可。下面的依赖、模型、在线数据和导入媒体分别适用各自的许可与条款。本源码仓库没有捆绑第三方 Python 环境、FFmpeg 二进制或模型权重；安装时由包管理器从上游获取。

## 基础依赖

| 组件 | 用途 | 上游许可 / 来源 |
| --- | --- | --- |
| faster-whisper | 本机语音识别 | [MIT](https://github.com/SYSTRAN/faster-whisper/blob/master/LICENSE) |
| CTranslate2 | faster-whisper 推理引擎 | [MIT](https://github.com/OpenNMT/CTranslate2/blob/master/LICENSE) |
| PyAV | 音视频解码、音频分析 | [BSD-3-Clause](https://github.com/PyAV-Org/PyAV/blob/master/LICENSE.txt)；其 FFmpeg 库另有许可 |
| NumPy | 音频数值处理 | [BSD-3-Clause](https://github.com/numpy/numpy/blob/main/LICENSE.txt) |
| qrcode | 局域网地址 / 分享二维码 | [BSD](https://github.com/lincolnloop/python-qrcode/blob/main/LICENSE) |
| Pillow | 二维码图片输出 | [许可文本](https://github.com/python-pillow/Pillow/blob/main/LICENSE)（包含历史 PIL 许可） |

faster-whisper 还会安装 huggingface-hub、tokenizers、onnxruntime 等传递依赖。请以实际安装版本中的 LICENSE / NOTICE 为准，上表不是完整软件物料清单。

## 模型与可选工具

- 语音模型来自 [SYSTRAN faster-whisper 模型](https://huggingface.co/Systran/faster-whisper-base)，基于 [OpenAI Whisper](https://github.com/openai/whisper/blob/main/LICENSE)。对应 base 模型卡标注 MIT；选用其他模型前请检查其模型卡。
- 硬字幕 OCR 使用 [RapidOCR](https://github.com/RapidAI/RapidOCR/blob/main/LICENSE)（Apache-2.0）及 [OpenCV](https://github.com/opencv/opencv/blob/4.x/LICENSE)（当前 4.x 为 Apache-2.0）。OCR 模型及 ONNX Runtime 也适用各自上游许可。
- 可选视频切分依赖 [imageio-ffmpeg](https://github.com/imageio/imageio-ffmpeg/blob/main/LICENSE)（BSD-2-Clause）或系统 FFmpeg。**FFmpeg 的实际许可取决于构建选项**，启用某些组件会适用 GPL。重新打包或分发二进制前，请核对 [FFmpeg 官方许可说明](https://ffmpeg.org/legal.html) 以及所用构建的许可和源码提供义务。

## 在线服务与媒体

前端可调用 Wiktionary、Free Dictionary API、MyMemory、Google 翻译、DeepSeek 和浏览器语音服务。它们的服务条款、数据许可、费用、可用性和隐私规则分别由服务提供方决定，不属于本项目 MIT 许可的授权范围。启用在线功能时请查看相关服务条款。

导入的视频、字幕、词汇及导出的离线课程包属于使用者或原权利人。本项目许可不授予这些内容的传播权。请仅分享你有权分享的媒体。
