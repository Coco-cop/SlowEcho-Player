#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
split_video.py —— 把长视频拆成若干短片段，方便逐个处理

为什么需要它：
    把长视频拆成短片段，便于分别识别、编辑和重试。
    页面识别由本机 Python 服务处理；此工具不是使用播放器的必需步骤。

关键点：
    切点必须落在**关键帧**上（否则画面会花），而且要把「这一段在原始视频里的
    真实起始时间」记下来——合并字幕时要靠它还原绝对时间，不然字幕会整体偏移。

用法：
    python split_video.py "长视频.mp4"                  # 默认每段 5 分钟
    python split_video.py "长视频.mp4" --chunk-minutes 3
    python split_video.py "长视频.mp4" --overlap 2      # 段间重叠 2 秒，避免切断句子

产出：
    长视频_part01.mp4 / _part02.mp4 / ...
    长视频.parts.json      ← 记录每段的起始时间，合并字幕时要用
"""
import argparse
import json
import math
import os
import subprocess
import sys
from pathlib import Path


def get_ffmpeg():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return "ffmpeg"          # 退回到 PATH 里的 ffmpeg


def keyframe_times(path):
    """读出视频所有关键帧的时间点。只解容器不解码，很快。"""
    import av
    c = av.open(str(path))
    st = c.streams.video[0]
    tb = st.time_base
    out = []
    for pkt in c.demux(st):
        if pkt.pts is None:
            continue
        if getattr(pkt, "is_keyframe", False):
            out.append(float(pkt.pts * tb))
    c.close()
    return sorted(out)


def probe_duration(path):
    import av
    c = av.open(str(path))
    st = c.streams.video[0]
    d = None
    if st.duration:
        d = float(st.duration * st.time_base)
    else:
        d = float(c.duration / 1000000) if c.duration else 0.0
    c.close()
    return d


def pick_cut(kfs, target, min_gap):
    """在关键帧里挑一个最接近 target、且不会让前一段太短的点"""
    best = None
    for t in kfs:
        if t <= target and (best is None or t > best):
            best = t
    if best is None or best < min_gap:
        return None
    return best


def run_ffmpeg(ff, args):
    p = subprocess.run([ff, "-hide_banner", "-loglevel", "error", "-y"] + args,
                       capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError((p.stderr or "").strip()[:400] or "ffmpeg 失败")
    return p


def main():
    ap = argparse.ArgumentParser(description="把长视频拆成短片段（不重编码，很快）")
    ap.add_argument("video", help="输入视频")
    ap.add_argument("--chunk-minutes", type=float, default=5.0, help="每段长度，默认 5 分钟")
    ap.add_argument("--overlap", type=float, default=0.0,
                    help="段间重叠秒数，默认 0；设 1~2 可避免把句子切在边界上")
    ap.add_argument("-o", "--out-dir", default=None, help="输出目录，默认与源文件同目录")
    args = ap.parse_args()

    src = Path(args.video)
    if not src.exists():
        print("找不到视频:", src)
        return 1
    out_dir = Path(args.out_dir) if args.out_dir else src.parent
    out_dir.mkdir(parents=True, exist_ok=True)

    ff = get_ffmpeg()
    print(f"ffmpeg: {ff}")
    print(f"源文件: {src.name}")

    print("读取视频信息…")
    dur = probe_duration(src)
    print(f"  时长 {dur:.1f} 秒（{dur/60:.1f} 分钟）")
    if dur <= 0:
        print("读不到时长，无法拆分")
        return 1

    chunk = args.chunk_minutes * 60
    if dur <= chunk * 1.2:
        print(f"视频只有 {dur/60:.1f} 分钟，不需要拆（阈值 {args.chunk_minutes} 分钟）。")
        return 0

    print("扫描关键帧（切点必须落在关键帧上，否则画面会花）…")
    kfs = keyframe_times(src)
    print(f"  共 {len(kfs)} 个关键帧")
    if len(kfs) < 2:
        print("关键帧太少，无法安全拆分")
        return 1

    targets = []
    t = chunk
    while t < dur - 5:
        targets.append(t)
        t += chunk

    cuts = [0.0]
    for tg in targets:
        c = pick_cut(kfs, tg, cuts[-1] + 20)     # 保证每段至少 20 秒
        if c is not None:
            cuts.append(c)
    cuts.append(dur)

    print(f"\n将拆成 {len(cuts)-1} 段：")
    parts = []
    for i in range(len(cuts) - 1):
        start = max(0.0, cuts[i] - (args.overlap if i else 0))
        end = cuts[i + 1]
        seg_len = end - start
        name = f"{src.stem}_part{i+1:02d}{src.suffix}"
        out = out_dir / name
        print(f"  [{i+1}/{len(cuts)-1}] {start:8.1f}s → {end:8.1f}s  ({seg_len/60:.1f} 分钟)  {name}")
        try:
            run_ffmpeg(ff, ["-ss", f"{start:.3f}", "-i", str(src), "-t", f"{seg_len:.3f}",
                            "-c", "copy", "-avoid_negative_ts", "make_zero",
                            "-map", "0", str(out)])
        except RuntimeError as e:
            print(f"      ✗ 切这一段失败：{e}")
            return 1
        parts.append({"file": name, "start": round(start, 3), "duration": round(seg_len, 3)})

    manifest = {
        "source": src.name,
        "duration": round(dur, 3),
        "chunk_minutes": args.chunk_minutes,
        "overlap": args.overlap,
        "parts": parts,
    }
    mpath = out_dir / f"{src.stem}.parts.json"
    mpath.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n✓ 完成，共 {len(parts)} 段")
    print(f"  索引文件：{mpath}")
    print("\n接下来：")
    print("  1. 把每个 _partNN.mp4 依次拖进 SlowEcho Player，点「AI 生成字幕」，导出各自的 .srt")
    print("  2. 用 merge_subtitles.py 合并成一个完整字幕：")
    print(f'     python merge_subtitles.py "{mpath}"')
    return 0


if __name__ == "__main__":
    sys.exit(main())
