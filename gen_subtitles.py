#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_subtitles.py —— 用 faster-whisper 在本地批量把视频/音频转成字幕

为什么需要它：
    页面上的识别由本机 Python 服务处理；这个命令行入口便于批量处理、
    指定模型与导出格式，不必在页面中逐个选择文件。
    生成的 .srt 直接拖进 SlowEcho Player 即可。

依赖：
    pip install faster-whisper

用法：
    # 单个文件
    python gen_subtitles.py movie.mp4

    # 批量（通配符 / 目录）
    python gen_subtitles.py "D:/videos/*.mp4"
    python gen_subtitles.py D:/videos --recursive

    # 指定模型与合并整句（推荐！让字幕按完整句子切分，方便单句循环）
    python gen_subtitles.py movie.mp4 --model small --sentence

    # 输出 VTT
    python gen_subtitles.py movie.mp4 --format vtt
"""
import argparse
import glob
import json
import os
import math
import re
import sys
import time
import urllib.request
from pathlib import Path

MEDIA_EXT = {".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v", ".flv", ".ts",
             ".mp3", ".m4a", ".wav", ".flac", ".aac", ".ogg", ".opus", ".wma"}

DS_URL = "https://api.deepseek.com/v1/chat/completions"
DS_POLISH_SYS = (
    "你是字幕校对员。用户给出若干条 Whisper 语音识别结果，标点缺失或错误、断句混乱。"
    "请为每条补全标点并合理断句。要求：\n"
    "1) 不得增删或改写任何词语，只加标点和调整大小写\n"
    "2) 必须原样保留行首的 [编号]，输出条数与输入完全一致\n"
    "3) 不翻译、不解释，每条输出一行\n"
    "4) 若某条无需修改，原样输出"
)
DS_TRANS_SYS = (
    "把用户给的每行英文字幕翻译成自然、口语化的中文，用于对照学习。要求：\n"
    "1) 原样保留行首的 [编号]，输出条数与输入完全一致\n"
    "2) 每条一行，只输出译文，不要解释\n"
    "3) 保持口语化，符合字幕语气"
)


def load_ds_key() -> str:
    """读取 DeepSeek Key：优先环境变量，其次 ~/.echoplayer/deepseek.key
    （故意放在用户目录而不是项目目录——项目目录会同步到网盘，Key 不该跟着走）"""
    k = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if k:
        return k
    p = Path.home() / ".echoplayer" / "deepseek.key"
    try:
        if p.exists():
            return p.read_text(encoding="utf-8").strip()
    except OSError:
        pass
    return ""


def ds_chat(key: str, model: str, system: str, user: str, timeout: int = 600) -> str:
    body = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": user}],
        "temperature": 0.2, "stream": False,
    }).encode("utf-8")
    req = urllib.request.Request(DS_URL, data=body, headers={
        "Content-Type": "application/json",
        "Authorization": "Bearer " + key,
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        j = json.loads(r.read().decode("utf-8"))
    return j["choices"][0]["message"]["content"]


def ds_batch(key, model, system, lines, batch=20, label=""):
    """分批调用 DeepSeek，用 [编号] 协议保证行数对齐。"""
    out = list(lines)
    total = math.ceil(len(lines) / batch)
    for k in range(0, len(lines), batch):
        part = lines[k:k + batch]
        n = len(part)
        prompt = "\n".join(f"[{i+1}] {t}" for i, t in enumerate(part))
        got = None
        for attempt in (1, 2):
            try:
                raw = ds_chat(key, model, system, prompt)
                m = {}
                cur = None
                for ln in raw.split("\n"):
                    mm = re.match(r"^\s*\[(\d+)\]\s*(.*)$", ln)
                    if mm:
                        cur = int(mm.group(1))
                        m[cur] = mm.group(2)
                    elif cur is not None and ln.strip():
                        m[cur] = (m.get(cur, "") + " " + ln.strip()).strip()
                got = [m.get(i + 1, "") for i in range(n)]
                if sum(1 for x in got if x) < n * 0.6:
                    raise ValueError("返回条数明显不足")
                break
            except Exception as e:
                if attempt == 2:
                    print(f"    ! 该批{label}失败，保留原文：{e}")
                else:
                    time.sleep(3)
        if got:
            for i, t in enumerate(got):
                if t and t.strip():
                    out[k + i] = t.strip()
        print(f"    {label} 第 {k // batch + 1}/{total} 批完成", flush=True)
    return out


def fmt_ts(t: float, comma: bool = True) -> str:
    """秒 -> 00:00:00,000 (SRT) / 00:00:00.000 (VTT)"""
    if t < 0:
        t = 0.0
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = int(t % 60)
    ms = int(round((t - int(t)) * 1000))
    if ms == 1000:            # 四舍五入进位
        ms = 0
        s += 1
        if s == 60:
            s = 0
            m += 1
            if m == 60:
                m = 0
                h += 1
    sep = "," if comma else "."
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def collect_inputs(paths, recursive: bool):
    """把命令行参数展开成实际存在的媒体文件列表"""
    out = []
    for p in paths:
        p = p.strip().strip('"').strip("'")
        if any(ch in p for ch in "*?["):
            out += [f for f in glob.glob(p, recursive=recursive) if Path(f).suffix.lower() in MEDIA_EXT]
            continue
        pp = Path(p)
        if pp.is_dir():
            pat = "**/*" if recursive else "*"
            out += [str(f) for f in pp.glob(pat) if f.is_file() and f.suffix.lower() in MEDIA_EXT]
        elif pp.is_file():
            out.append(str(pp))
        else:
            print(f"  ! 找不到：{p}")
    # 去重 + 排序
    return sorted(set(out))


def merge_into_sentences(segments, max_chars=160, max_dur=14.0):
    """
    Whisper 常把一句话切在从句中间。合并成「完整句子」后，
    SlowEcho Player 的单句循环体验会好很多。
    """
    merged = []
    buf = None
    for seg in segments:
        text = seg["text"].strip()
        if not text:
            continue
        if buf is None:
            buf = {"start": seg["start"], "end": seg["end"], "text": text}
        else:
            buf["text"] = (buf["text"] + " " + text).strip()
            buf["end"] = seg["end"]
        ends_sentence = text.endswith((".", "!", "?", '"', "'", "。", "！", "？"))
        too_long = len(buf["text"]) >= max_chars or (buf["end"] - buf["start"]) >= max_dur
        if ends_sentence or too_long:
            merged.append(buf)
            buf = None
    if buf:
        merged.append(buf)
    return merged


# 句末标点 + 空格 + 大写开头，视为句子边界
SENT_SPLIT = re.compile(r'(?<=[.!?])\s+(?=[A-Z"\'(])')
# 但这些不该算句末：常见缩写，以及人名缩写（单个大写字母 + 句点）
ABBREV = re.compile(
    r'\b(?:Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs|etc|Inc|Ltd|No|Fig|Vol'
    r'|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Oct|Nov|Dec'
    r'|a\.m|p\.m|U\.S|U\.K|U\.N|B\.C|A\.D)\.$', re.I)
INITIAL = re.compile(r'(?:^|\s)[A-Z]\.$')


def load_audio(path, sr=16000):
    """用 PyAV 把音频解码成 16kHz 单声道 float32 数组。
    失败时返回 None，调用方可以退回"直接把文件路径交给 faster-whisper"。"""
    try:
        import av
        import numpy as np
    except Exception:
        return None
    try:
        container = av.open(path)
        if not container.streams.audio:
            container.close()
            return None
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="fltp", layout="mono", rate=sr)
        parts = []
        for frame in container.decode(stream):
            frame.pts = None
            out = resampler.resample(frame)
            for f in (out if isinstance(out, (list, tuple)) else [out]):
                if f is not None:
                    parts.append(f.to_ndarray().reshape(-1))
        flush = resampler.resample(None)
        for f in (flush if isinstance(flush, (list, tuple)) else [flush]):
            if f is not None:
                parts.append(f.to_ndarray().reshape(-1))
        container.close()
        if not parts:
            return None
        return np.concatenate(parts).astype(np.float32)
    except Exception as e:
        print(f"    音频解码降级（将退回整文件处理）：{e}")
        return None


def transcribe_windowed(model, audio, sr, win_sec, **kw):
    """分段识别。为什么要分段：
    faster-whisper 会一次性对整段音频算梅尔频谱，20 分钟音频需要约
    386MB 的 complex128 临时数组，内存紧张时直接
    "Unable to allocate ... MiB" 崩掉。分段后内存恒定，还能看进度。"""
    n = len(audio)
    step = int(win_sec * sr)          # 必须是 int，否则 range() 报 "cannot be interpreted as an integer"
    if step <= 0:
        step = sr
    total = max(1, math.ceil(n / step))
    for w, start in enumerate(range(0, n, step)):
        chunk = audio[start:start + step]
        if len(chunk) < sr:            # 尾部不足 1 秒，忽略
            continue
        segs, info = model.transcribe(chunk, **kw)
        off = start / sr
        for s in segs:
            yield off + s.start, off + s.end, s.text, segment_words(s)
        print(f"    第 {w + 1}/{total} 段完成", flush=True)


def segment_words(segment):
    """读取 faster-whisper 的词级时间戳。

    只有在 kw 里打开 word_timestamps=True 时模型才会给出 words；
    拿不到就返回空列表，调用方会退回旧的按标点/词数切分。
    """
    raw = getattr(segment, "words", None) or []
    out = []
    for word in raw:
        text = str(getattr(word, "word", "") or "").strip()
        start = getattr(word, "start", None)
        end = getattr(word, "end", None)
        if not text or start is None or end is None:
            continue
        if float(end) < float(start):
            continue
        out.append({"word": text, "start": float(start), "end": float(end)})
    return out


def group_into_sentences(segs):
    """按换气停顿把识别结果切成意群，和播放器「电脑引擎」用的是同一套逻辑。"""
    from listening_segments import group_words_into_sentences
    ordered = sorted(segs, key=lambda item: item["start"])
    words = [word for item in ordered for word in item.get("words") or []]
    if not words:
        return None
    return [{"start": g["start"], "end": g["end"], "text": g["text"], "words": g["words"]}
            for g in group_words_into_sentences(words)]


def split_sentences(text):
    """按句末标点切句，但避开 Mr. / U.S. / Susan B. Anthony 这类缩写。"""
    parts, last = [], 0
    for m in SENT_SPLIT.finditer(text):
        head = text[last:m.start()]
        if INITIAL.search(head) or ABBREV.search(head):
            continue                      # 是缩写，不算句末
        parts.append(head)
        last = m.end()
    parts.append(text[last:])
    return [p.strip() for p in parts if p.strip()]


def split_long(segments, max_chars=110, max_dur=9.0):
    """
    合并后仍可能得到很长的条目（Whisper 的 base/small 段落本来就粗）。
    单句循环是按条目循环的，一条 25 秒实在没法跟读，所以再按句子边界拆一次，
    时间按字符数比例分配。
    """
    out = []
    for s in segments:
        text = s["text"].strip()
        dur = s["end"] - s["start"]
        if len(text) <= max_chars and dur <= max_dur:
            out.append(s)
            continue
        parts = split_sentences(text)
        if len(parts) <= 1:
            out.append(s)
            continue
        total = sum(len(p) for p in parts) or 1
        t = s["start"]
        for p in parts:
            d = dur * len(p) / total
            out.append({"start": round(t, 3), "end": round(t + d, 3), "text": p})
            t += d
    return out


def force_split(segments, max_dur=10.0, max_words=24):
    """
    最后兜底。Whisper 的 base 模型对英文标点支持很差，经常吐出一整段没有句号的
    长串（"…for one man This game fate brought us here as strangers…"），
    上面按标点拆的那一步对它无效。这里再按词数硬切，时间按词数比例分配。
    单句循环宁可听 8 秒的半句，也不要 22 秒的一整段。
    """
    out = []
    for s in segments:
        dur = s["end"] - s["start"]
        words = s["text"].split()
        if dur <= max_dur or len(words) <= max_words:
            out.append(s)
            continue
        n = max(2, math.ceil(dur / max_dur))
        per = math.ceil(len(words) / n)
        groups = [" ".join(words[i:i + per]) for i in range(0, len(words), per)]
        total = sum(len(g) for g in groups) or 1
        t = s["start"]
        for g in groups:
            d = dur * len(g) / total
            out.append({"start": round(t, 3), "end": round(t + d, 3), "text": g})
            t += d
    return out


def to_srt(segs):
    lines = []
    for i, s in enumerate(segs, 1):
        lines.append(str(i))
        lines.append(f"{fmt_ts(s['start'])} --> {fmt_ts(s['end'])}")
        lines.append(s["text"])
        if s.get("zh"):
            lines.append(s["zh"])
        lines.append("")
    return "\n".join(lines)


def to_vtt(segs):
    lines = ["WEBVTT", ""]
    for s in segs:
        lines.append(f"{fmt_ts(s['start'], False)} --> {fmt_ts(s['end'], False)}")
        lines.append(s["text"])
        if s.get("zh"):
            lines.append(s["zh"])
        lines.append("")
    return "\n".join(lines)


def to_txt(segs):
    out = []
    for s in segs:
        out.append(s["text"])
        if s.get("zh"):
            out.append(s["zh"])
    return "\n".join(out) + "\n"


def main():
    ap = argparse.ArgumentParser(
        description="用 faster-whisper 批量生成字幕（本地离线，无需联网）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="示例：\n  python gen_subtitles.py \"D:/videos/*.mp4\" --model small --sentence\n"
    )
    ap.add_argument("inputs", nargs="+", help="视频/音频文件、通配符或目录")
    ap.add_argument("-r", "--recursive", action="store_true", help="递归扫描目录")
    ap.add_argument("-m", "--model", default="small",
                    help="模型：tiny / base / small / medium / large-v3（默认 small）")
    ap.add_argument("-l", "--lang", default="en", help="语言代码，默认 en；填 auto 自动检测")
    ap.add_argument("-d", "--device", default="auto", choices=["auto", "cpu", "cuda"],
                    help="推理设备，默认 auto")
    ap.add_argument("-c", "--compute-type", default="default",
                    help="精度：default / int8 / int8_float16 / float16")
    ap.add_argument("-f", "--format", default="srt", choices=["srt", "vtt", "txt", "json"],
                    help="输出格式，默认 srt")
    ap.add_argument("-o", "--out-dir", default=None, help="输出目录（默认与源文件同目录）")
    ap.add_argument("--sentence", action="store_true",
                    help="把零碎片段合并成完整句子（推荐，便于单句循环）")
    ap.add_argument("--no-vad", action="store_true", help="关闭 VAD 静音过滤")
    ap.add_argument("--chunk-minutes", type=float, default=5.0,
                    help="分段识别的窗口长度（分钟），默认 5；内存紧张可改 2")
    ap.add_argument("--no-chunk", action="store_true",
                    help="不做分段，整文件一次性识别（长视频可能因内存不足失败）")
    ap.add_argument("--hf-endpoint", default="https://hf-mirror.com",
                    help="模型下载源，默认国内镜像 hf-mirror.com；填 none 则用官方 huggingface.co")
    ap.add_argument("--polish", action="store_true",
                    help="用 DeepSeek 修复标点、断句、大小写（Whisper 英文标点很差，强烈建议开）")
    ap.add_argument("--zh", action="store_true",
                    help="用 DeepSeek 翻译，输出「英文 + 中文」双语字幕")
    ap.add_argument("--ds-key", default=load_ds_key(),
                    help="DeepSeek API Key；也可用环境变量 DEEPSEEK_API_KEY，"
                         "或写到 ~/.echoplayer/deepseek.key")
    ap.add_argument("--ds-model", default="deepseek-flash",
                    help="DeepSeek 模型，固定使用最新 V4.1 Flash（API ID: deepseek-flash）")
    ap.add_argument("--ds-batch", type=int, default=20, help="每批发送多少条给 DeepSeek，默认 20")
    ap.add_argument("--force", action="store_true", help="已存在同名字幕时也重新生成")
    args = ap.parse_args()
    # DeepSeek 官方已将 V4.1 Flash 的 API ID 定为 deepseek-flash；统一覆盖旧配置/旧命令。
    args.ds_model = "deepseek-flash"

    if (args.polish or args.zh) and not args.ds_key:
        print("使用了 --polish 或 --zh，但没有提供 DeepSeek Key。\n"
              "请加 --ds-key sk-xxxx，或设置环境变量 DEEPSEEK_API_KEY。\n"
              "申请地址：https://platform.deepseek.com  （api.deepseek.com 国内可直连，不需要代理）")
        sys.exit(1)

    # 模型下载走镜像：faster-whisper 底层用 huggingface_hub，认 HF_ENDPOINT 环境变量。
    # 注意：hf-mirror 在【浏览器】里因 CORS 用不了，但命令行工具完全没问题。
    if args.hf_endpoint.lower() != "none":
        os.environ["HF_ENDPOINT"] = args.hf_endpoint
        print(f"模型下载源：{args.hf_endpoint}")

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("缺少依赖，请先安装：\n    pip install faster-whisper\n")
        sys.exit(1)

    files = collect_inputs(args.inputs, args.recursive)
    if not files:
        print("没有找到可处理的媒体文件。")
        sys.exit(1)

    lang = None if args.lang.lower() in ("auto", "") else args.lang
    print(f"共 {len(files)} 个文件 | 模型={args.model} 语言={lang or 'auto'} "
          f"设备={args.device} 精度={args.compute_type}")
    print("首次运行会自动下载模型（small 约 460MB）...\n")

    print("加载模型中...")
    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    print("模型就绪。\n")

    ok = skipped = failed = 0
    for idx, f in enumerate(files, 1):
        src = Path(f)
        out_dir = Path(args.out_dir) if args.out_dir else src.parent
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"{src.stem}.{args.format}"

        if out_path.exists() and not args.force:
            print(f"[{idx}/{len(files)}] 跳过（已存在）{out_path.name}")
            skipped += 1
            continue

        print(f"[{idx}/{len(files)}] {src.name}")
        try:
            kw = dict(
                language=lang,
                vad_filter=not args.no_vad,
                vad_parameters={"min_silence_duration_ms": 400},
                beam_size=5,
            )
            if args.sentence:
                kw["word_timestamps"] = True   # 意群切分要真实停顿，必须拿词级时间
            segs = []
            # 优先分段处理（内存恒定；整文件处理长视频会 OOM），解码失败则退回原方式
            audio = None
            if not args.no_chunk:
                audio = load_audio(str(src), 16000)
            if audio is not None and len(audio):
                print(f"    音频 {len(audio)/16000:.0f} 秒，按 {args.chunk_minutes} 分钟分段识别")
                for st, en, text, words in transcribe_windowed(
                        model, audio, 16000, args.chunk_minutes * 60, **kw):
                    text = (text or "").strip()
                    if text:
                        segs.append({"start": st, "end": en, "text": text, "words": words})
            else:
                print("    整文件识别（未分段，长视频可能因内存不足失败）")
                segments, info = model.transcribe(str(src), **kw)
                for s in segments:      # 生成器，边解码边产出
                    text = (s.text or "").strip()
                    if text:
                        segs.append({"start": float(s.start),
                                     "end": float(s.end), "text": text,
                                     "words": segment_words(s)})
            segs.sort(key=lambda x: x["start"])
            for s in segs[-6:]:
                print(f"    {fmt_ts(s['start'])}  {s['text'][:70]}", flush=True)
        except Exception as e:
            print(f"    ✗ 失败：{e}")
            failed += 1
            continue

        if not segs:
            print("    ✗ 没识别到内容")
            failed += 1
            continue

        if args.sentence:
            before = len(segs)
            grouped = group_into_sentences(segs)
            if grouped:
                segs = grouped
                print(f"    整句处理：{before} 段 -> 按换气停顿切成 {len(segs)} 条意群")
            else:
                # 模型没给词级时间（例如关掉了 timestamps），退回旧的按标点/词数切分
                segs = merge_into_sentences(segs)
                n2 = len(segs)
                segs = split_long(segs)
                n3 = len(segs)
                segs = force_split(segs)
                print(f"    整句处理：{before} 段 -> 合并 {n2} 句 -> 断句 {n3} 条 -> 限长后 {len(segs)} 条")
            long_ones = [x for x in segs if x["end"] - x["start"] > 12]
            if long_ones:
                print(f"    （仍有 {len(long_ones)} 条超过 12 秒）")

        # ---- DeepSeek 后处理 ----
        if args.polish or args.zh:
            texts = [s["text"] for s in segs]
            if args.polish:
                print(f"    用 DeepSeek 修标点断句（{len(texts)} 条，模型 {args.ds_model}）…")
                texts = ds_batch(args.ds_key, args.ds_model, DS_POLISH_SYS, texts,
                                 batch=args.ds_batch, label="润色")
            if args.zh:
                print(f"    用 DeepSeek 翻译成中文…")
                zhs = ds_batch(args.ds_key, args.ds_model, DS_TRANS_SYS, texts,
                               batch=args.ds_batch, label="翻译")
                for s, z in zip(segs, zhs):
                    if z:
                        s["zh"] = z
            for s, t in zip(segs, texts):
                if args.polish and s.get("text") != t:
                    s.pop("words", None)   # 文字被改写后，旧词级时间对不上
                s["text"] = t

        if args.format == "srt":
            content = to_srt(segs)
        elif args.format == "vtt":
            content = to_vtt(segs)
        elif args.format == "txt":
            content = to_txt(segs)
        else:
            import json
            content = json.dumps({"language": info.language, "segments": segs},
                                 ensure_ascii=False, indent=2)

        out_path.write_text(content, encoding="utf-8")
        print(f"    ✓ 已保存 {out_path}  ({len(segs)} 条)\n")
        ok += 1

    print(f"完成：成功 {ok}，跳过 {skipped}，失败 {failed}")
    if ok:
        print("\n把生成的 .srt 直接拖进 SlowEcho Player 即可。")


if __name__ == "__main__":
    main()
