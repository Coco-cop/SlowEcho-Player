#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ocr_subtitles.py —— 从视频画面里 OCR 出「烧录的硬字幕」，生成 SRT

适用场景：
    视频已经把字幕烧进画面了（比如 B站 搬运的「盲听+英文字幕」类视频、
    自制的双语字幕视频）。这种情况下 OCR 比语音识别更快更准，
    而且能直接拿到原本就写好的译文，不用再翻译一遍。

原理：
    抽帧 → 裁出字幕所在的画面条带 → 逐帧 OCR → 把连续相同的文字合并成一条字幕。
    为了速度，只在画面条带「发生变化」时才跑 OCR。

依赖：
    pip install rapidocr-onnxruntime opencv-python Pillow av
    （RapidOCR 自带模型，完全离线，国内可用）

用法：
    # 基本用法（默认抓画面下方 70%~100% 区域）
    python ocr_subtitles.py "视频.mp4"

    # 字幕位置不在底部，或想调区域
    python ocr_subtitles.py "视频.mp4" --band 0.60,0.95

    # 顺手用 DeepSeek 修 OCR 错别字
    python ocr_subtitles.py "视频.mp4" --polish

    # 只有一种语言时（没有中英对照），--single 会只保留识别到的文本
    python ocr_subtitles.py "视频.mp4" --single
"""
import argparse
import difflib
import io
import math
import os
import re
import sys
import time
from pathlib import Path

# 复用 gen_subtitles.py 里的 DeepSeek 工具（同目录）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from gen_subtitles import load_ds_key, ds_batch, fmt_ts
except Exception:                                     # 允许单独拷出去用
    def load_ds_key():
        k = os.environ.get("DEEPSEEK_API_KEY", "").strip()
        if k:
            return k
        p = Path.home() / ".echoplayer" / "deepseek.key"
        try:
            return p.read_text(encoding="utf-8").strip() if p.exists() else ""
        except OSError:
            return ""

    def ds_batch(*a, **kw):
        raise RuntimeError("需要 gen_subtitles.py 才能用 --polish")

OCR_POLISH_SYS = (
    "你是 OCR 校对员。用户给出若干条从视频画面里 OCR 出来的字幕，其中可能有形近字、"
    "漏字、多余符号等识别错误。请修正这些明显的识别错误，保持原意和语言不变。要求：\n"
    "1) 只修错别字和明显的识别错误，不要改写、润色、翻译\n"
    "2) 中英对照的两行要保持两行，英文一行、中文一行\n"
    "3) 必须原样保留行首的 [编号]，输出条数与输入完全一致\n"
    "4) 若某条没有问题，原样输出"
)

CJK = re.compile(r"[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]")


def norm(s: str) -> str:
    """归一化文本，用于判断相邻帧是不是同一句字幕"""
    return re.sub(r"[\s\W_]+", "", s).lower()


def similar(a: str, b: str) -> float:
    """序列相似度（考虑语序）。
    用字符集合算是不行的——"顺序不同但用字相近"的两句会被误判成同一句。"""
    a, b = norm(a), norm(b)
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    return difflib.SequenceMatcher(None, a, b).ratio()


class FrameSource:
    """用 PyAV 逐帧解码，按目标 fps 抽帧（按 pts 判断，比按帧计数准）"""

    def __init__(self, path, fps):
        import av
        self.av = av
        self.container = av.open(path)
        self.stream = self.container.streams.video[0]
        self.fps = fps
        self.step = 1.0 / fps
        self.next_t = 0.0

    def __iter__(self):
        for frame in self.container.decode(self.stream):
            if frame.pts is None:
                continue
            t = float(frame.pts * self.stream.time_base)
            if t + 1e-6 < self.next_t:
                continue
            self.next_t = t + self.step
            yield t, frame

    def close(self):
        try:
            self.container.close()
        except Exception:
            pass


def band_mask(gray, thresh=190):
    """把字幕条带转成「亮色文字掩码」。

    为什么要这么做：字幕是亮色文字（白/黄）配深色描边，而人像、街道、天空都是暗的。
    直接对灰度做差分，画面里人一动就会被判定成「字幕变了」，于是疯狂跑 OCR
    （实测 361 帧里跑了 341 次，180 秒视频花了 399 秒）。
    先按亮度提取掩码，背景运动基本被滤掉，只有字幕本身变化才触发。
    """
    import cv2
    _, m = cv2.threshold(gray, thresh, 255, cv2.THRESH_BINARY)
    return cv2.resize(m, (128, 24), interpolation=cv2.INTER_AREA)



# B站浮动水印会飘进字幕区，必须滤掉，否则会混进译文里
# 画面上的浮层杂字：B站水印、UP主放的订阅/译制信息等，都要清掉，
# 否则会被当成译文混进字幕里（实测出现过 "订阅：12.9万 译制： xxx"）。
OVERLAY_PATTERNS = [
    r"[（(]?\s*(?:B站|bilibili|哔哩哔哩)\s*[^）)]{0,24}[）)]?",
    r"(?:订阅|关注|点赞|投币|收藏|转发|译制|翻译|校对|压制|字幕组|博主|UP主|up主)\s*[:：]?\s*[\d.]+\s*万?",
    r"(?:订阅|关注|点赞|译制|翻译|校对|压制|字幕|博主|UP主|up主)\s*[:：]",
    r"(?:Soleil|JJ)[-_.\w]*",
]


def strip_watermark(text: str) -> str:
    t = text
    for pat in OVERLAY_PATTERNS:
        t = re.sub(pat, " ", t, flags=re.I)
    t = re.sub(r"\s{2,}", " ", t)
    return t.strip(" 　,，、|·-—")


def text_roi(gray, bright=190, min_ratio=0.008, gap=32, pad=8):
    """定位「有文字的那几行」，把中英两行一起框进来。

    注意不能只取最长的连续行段——中英两行之间有空隙，会被切开，
    结果只 OCR 到中文、漏掉英文。这里把间隔小于 gap 的行段并成一组，
    再选「亮像素最多」的那一组（字幕两行的像素量远大于零散水印）。"""
    import numpy as np
    m = (gray > bright).astype(np.uint8)
    rows = m.sum(axis=1)
    ys = np.where(rows > gray.shape[1] * min_ratio)[0]
    if len(ys) == 0:
        return None
    groups = []
    start = prev = ys[0]
    for y in ys[1:]:
        if y - prev <= gap:
            prev = y
        else:
            groups.append((start, prev))
            start = prev = y
    groups.append((start, prev))
    best = max(groups, key=lambda g: int(m[g[0]:g[1] + 1].sum()))
    if best[1] - best[0] < 6:
        return None
    return max(0, best[0] - pad), min(gray.shape[0], best[1] + pad + 1)



def run(args):
    import cv2
    from rapidocr_onnxruntime import RapidOCR

    src = Path(args.video)
    if not src.exists():
        print("找不到视频:", src)
        return 1

    out_dir = Path(args.out_dir) if args.out_dir else src.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{src.stem}.srt"

    h0, h1 = args.band
    print(f"视频：{src.name}")
    print(f"字幕区域：画面高度 {h0:.0%} ~ {h1:.0%}    抽帧：{args.fps} fps    "
          f"变化阈值：{args.diff_thresh}")

    ocr = RapidOCR()
    src_frames = FrameSource(str(src), args.fps)

    entries = []          # [{start,end,en,zh,raw}]
    cur = None
    last_gray = None
    n_frames = 0
    n_ocr = 0
    t_start = time.time()

    try:
        for t, frame in src_frames:
            if args.max_seconds and t > args.max_seconds:
                break
            n_frames += 1
            img = frame.to_ndarray(format="bgr24")
            H, W = img.shape[:2]
            if not args._resolved_band:
                crop = img[int(H * h0):int(H * h1), :]
                args._crop_box = (int(H * h0), int(H * h1), W)
                args._resolved_band = True
            else:
                a, b, _w = args._crop_box
                crop = img[a:b, :]

            import numpy as np
            gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)

            # ① 先定位文字行（行求和，很便宜）
            roi = text_roi(gray, args.bright)
            if roi is None:
                if cur and t - cur["start"] >= args.min_dur:
                    cur["end"] = t
                    entries.append(cur)
                cur = None
                last_gray = None
                continue

            # ② 只在「文字行所在的那块区域」做变化检测。
            #    之前是对整条带做差分，画面里人一动、天一亮就被判定成字幕变化，
            #    结果 172 帧跑了 157 次 OCR。锁定到文字行后，静止的字幕签名完全一致。
            sig = band_mask(gray[roi[0]:roi[1], :], args.bright)
            changed = last_gray is None or float(np.mean(cv2.absdiff(sig, last_gray))) > args.diff_thresh
            last_gray = sig
            if not changed:
                continue

            sub = crop[roi[0]:roi[1], :]
            # 区域太小的帧直接跳过：OCR 模型的检测头对输入尺寸有下限，
            # 喂进去会直接抛 ONNXRuntimeError 把整轮跑挂掉。
            if sub.shape[0] < 12 or sub.shape[1] < 40:
                continue
            if sub.shape[0] < 90:               # 字幕条很矮时才放大，越高越慢，得不偿失
                sub = cv2.resize(sub, None, fx=1.6, fy=1.6, interpolation=cv2.INTER_CUBIC)
            n_ocr += 1
            try:
                res, _ = ocr(sub)
            except Exception as e:              # 单帧失败不该中断整轮
                print(f"    ! {t:.1f}s 这帧识别失败，跳过：{type(e).__name__}")
                continue
            lines, scores = [], []
            for item in (res or []):
                try:
                    box, text, score = item[0], item[1], float(item[2])
                except (IndexError, TypeError, ValueError):
                    continue
                if score < args.min_score or not text.strip():
                    continue
                cleaned = strip_watermark(text.strip())
                if len(re.sub(r"[\W_]", "", cleaned)) < 2:      # 有效字符太少 → 水印/噪声
                    continue
                if len(cleaned) < 2:
                    continue
                lines.append((float(box[0][1]), cleaned))
                scores.append(score)
            lines.sort(key=lambda x: x[0])
            avg_score = sum(scores) / len(scores) if scores else 0.0

            zh = " ".join(t for _, t in lines if CJK.search(t)).strip()
            en = " ".join(t for _, t in lines if not CJK.search(t)).strip()
            raw = "\n".join(t for _, t in lines)
            if not raw:
                # 这一帧没有字幕（可能刚切走）→ 结束当前条目
                if cur and t - cur["start"] >= args.min_dur:
                    cur["end"] = t
                    entries.append(cur)
                cur = None
                continue

            if cur and similar(cur["raw"], raw) > args.sim_thresh:
                cur["end"] = t + 1.0 / args.fps
                # 同一句的多个 OCR 变体里，留下置信度更高的那个读法
                if avg_score > cur.get("score", 0):
                    cur["raw"], cur["en"], cur["zh"], cur["score"] = raw, en, zh, avg_score
            else:
                if cur and cur["end"] - cur["start"] >= args.min_dur:
                    entries.append(cur)
                cur = {"start": t, "end": t + 1.0 / args.fps, "raw": raw, "en": en, "zh": zh,
                       "score": avg_score}

            if n_ocr % 25 == 0:
                el = time.time() - t_start
                print(f"    {t/60:.1f} 分钟处 | 已抽 {n_frames} 帧 / OCR {n_ocr} 次 | "
                      f"识别 {len(entries)} 条 | 用时 {el:.0f}s", flush=True)
    finally:
        src_frames.close()
        if cur and cur["end"] - cur["start"] >= args.min_dur:
            entries.append(cur)

    if not entries:
        print("\n✗ 没识别到任何字幕。多半是字幕区域设错了，试试：")
        print("    --band 0.55,1.0      （扩大范围）")
        print("    --diff-thresh 2      （更灵敏地检测变化）")
        print("    --min-score 0.3      （放宽置信度门槛）")
        return 1

    # 收拾一下：去掉同一句被拆成多条的情况
    merged = []
    for e in entries:
        if merged and similar(merged[-1]["raw"], e["raw"]) > args.merge_thresh:
            merged[-1]["end"] = max(merged[-1]["end"], e["end"])
            if e.get("score", 0) > merged[-1].get("score", 0):
                merged[-1].update({k: e[k] for k in ("raw", "en", "zh", "score")})
            continue
        merged.append(e)
    entries = merged

    print(f"\n抽帧 {n_frames} 次，实际 OCR {n_ocr} 次，得到 {len(entries)} 条字幕，"
          f"总用时 {time.time() - t_start:.0f} 秒")

    # DeepSeek 校对
    if args.polish:
        key = args.ds_key or load_ds_key()
        if not key:
            print("! 未提供 DeepSeek Key，跳过校对")
        else:
            payload = [(e["en"] + "\n" + e["zh"]).strip() if e["en"] and e["zh"]
                       else (e["en"] or e["zh"]) for e in entries]
            print(f"用 DeepSeek 校对 OCR 结果（{len(payload)} 条）…")
            fixed = ds_batch(key, args.ds_model, OCR_POLISH_SYS, payload,
                             batch=args.ds_batch, label="校对")
            for e, f in zip(entries, fixed):
                fl = [x.strip() for x in f.split("\n") if x.strip()]
                if len(fl) >= 2:
                    e["en"] = " ".join(x for x in fl if not CJK.search(x)).strip() or e["en"]
                    e["zh"] = " ".join(x for x in fl if CJK.search(x)).strip() or e["zh"]
                elif len(fl) == 1:
                    (e.__setitem__("zh", fl[0]) if CJK.search(fl[0]) else e.__setitem__("en", fl[0]))

    lines_out = []
    for i, e in enumerate(entries, 1):
        lines_out.append(str(i))
        lines_out.append(f"{fmt_ts(e['start'])} --> {fmt_ts(e['end'])}")
        if args.single:
            lines_out.append(e["zh"] or e["en"])
        else:
            if e["en"]:
                lines_out.append(e["en"])
            if e["zh"]:
                lines_out.append(e["zh"])
            if not e["en"] and not e["zh"]:
                lines_out.append(e["raw"])
        lines_out.append("")
    out_path.write_text("\n".join(lines_out), encoding="utf-8")

    dur = [e["end"] - e["start"] for e in entries]
    print(f"✓ 已保存 {out_path}")
    print(f"  中位时长 {sorted(dur)[len(dur)//2]:.1f} 秒，最长 {max(dur):.1f} 秒")
    bip = sum(1 for e in entries if e["en"] and e["zh"])
    print(f"  中英对照完整的有 {bip}/{len(entries)} 条")
    print("\n把 .srt 拖进 SlowEcho Player 即可（播放器会自动把中文认成译文）。")
    return 0


def main():
    ap = argparse.ArgumentParser(
        description="从视频画面里 OCR 出硬字幕，生成 SRT",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("video", help="视频文件")
    ap.add_argument("--band", default="0.66,1.00",
                    help="字幕所在的画面高度区间，如 0.70,1.00（默认画面下方 30%%）")
    ap.add_argument("--fps", type=float, default=2.0, help="抽帧频率，默认 2")
    ap.add_argument("--diff-thresh", type=float, default=1.5,
                    help="字幕掩码变化阈值，默认 1.5；误检多就调大，漏检就调小")
    ap.add_argument("--bright", type=int, default=190,
                    help="判定为「字幕文字」的亮度阈值，默认 190；字幕偏暗就调小")
    ap.add_argument("--min-score", type=float, default=0.5, help="OCR 置信度门槛，默认 0.5")
    ap.add_argument("--merge-thresh", type=float, default=0.55,
                    help="把同一句的多个 OCR 变体合并的相似度阈值，默认 0.55")
    ap.add_argument("--sim-thresh", type=float, default=0.80,
                    help="判定相邻帧是同一句的相似度阈值，默认 0.80")
    ap.add_argument("--min-dur", type=float, default=0.25,
                    help="短于这个时长的条目丢弃（过滤闪现的中间态）")
    ap.add_argument("--single", action="store_true", help="只输出一种语言（视频只有单语字幕时用）")
    ap.add_argument("--polish", action="store_true", help="用 DeepSeek 校对 OCR 错别字")
    ap.add_argument("--ds-key", default="", help="DeepSeek Key（默认读 ~/.echoplayer/deepseek.key）")
    ap.add_argument("--ds-model", default="deepseek-flash",
                    help="固定使用最新 DeepSeek V4.1 Flash（API ID: deepseek-flash）")
    ap.add_argument("--ds-batch", type=int, default=20)
    ap.add_argument("--max-seconds", type=float, default=0,
                    help="只处理前 N 秒（调参/试跑用），0 表示整片")
    ap.add_argument("-o", "--out-dir", default=None)
    args = ap.parse_args()
    args.ds_model = "deepseek-flash"

    try:
        a, b = [float(x) for x in args.band.split(",")]
        args.band = (max(0.0, a), min(1.0, b))
    except Exception:
        print("--band 格式不对，示例：--band 0.70,1.00")
        return 2
    args._resolved_band = False
    args._crop_box = None

    try:
        return run(args)
    except KeyboardInterrupt:
        print("\n已中断")
        return 130


if __name__ == "__main__":
    sys.exit(main())
