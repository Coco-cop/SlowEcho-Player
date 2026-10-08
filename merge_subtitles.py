#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
merge_subtitles.py —— 把拆分后各段的字幕合并成一个完整字幕

配合 split_video.py 使用：长视频被拆成 _part01 / _part02 …，
每段在播放器里各自生成了自己的 .srt（时间都是从 0 开始的）。
这个脚本按 split_video.py 记下的起始时间，把各段字幕换算回**原始视频的绝对时间**
再拼接起来。

用法：
    # 索引文件和 .srt 都在同一目录（srt 文件名与 _partNN.mp4 对应）
    python merge_subtitles.py "长视频.parts.json"

    # .srt 在别的目录（比如播放器导出到了下载文件夹）
    python merge_subtitles.py "长视频.parts.json" --srt-dir "D:/Subtitles"

    # 指定输出
    python merge_subtitles.py "长视频.parts.json" -o "完整字幕.srt"

    # 段间有重叠时，自动去掉接缝处重复的条目
    python merge_subtitles.py "长视频.parts.json" --dedupe
"""
import argparse
import json
import re
import sys
from pathlib import Path

TS = re.compile(r"(\d+):(\d+):(\d+)[,.](\d+)")


def ts_to_sec(s):
    h, m, sec, ms = TS.match(s.strip()).groups()
    return int(h) * 3600 + int(m) * 60 + int(sec) + int(ms) / (10 ** len(ms))


def sec_to_ts(t, comma=True):
    if t < 0:
        t = 0.0
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = int(t % 60)
    ms = int(round((t - int(t)) * 1000))
    if ms == 1000:
        ms = 0
        s += 1
        if s == 60:
            s, m = 0, m + 1
            if m == 60:
                m, h = 0, h + 1
    return f"{h:02d}:{m:02d}:{s:02d}{',' if comma else '.'}{ms:03d}"


def parse_srt(path):
    text = Path(path).read_text(encoding="utf-8", errors="replace")
    text = text.replace("\r\n", "\n").lstrip("\ufeff")
    out = []
    for block in text.split("\n\n"):
        lines = [x for x in block.strip().split("\n") if x.strip()]
        if not lines:
            continue
        ti = next((i for i, l in enumerate(lines) if "-->" in l), -1)
        if ti == -1:
            continue
        a, _, b = lines[ti].partition("-->")
        try:
            st, en = ts_to_sec(a), ts_to_sec(b.strip().split()[0])
        except Exception:
            continue
        body = [x.strip() for x in lines[ti + 1:] if x.strip()]
        if body:
            out.append({"start": st, "end": en, "lines": body})
    return out


def norm(s):
    return re.sub(r"[\s\W_]+", "", s).lower()


def main():
    ap = argparse.ArgumentParser(description="合并分段字幕，还原为完整时间轴")
    ap.add_argument("manifest", help="split_video.py 生成的 .parts.json")
    ap.add_argument("--srt-dir", default=None,
                    help="各段 .srt 所在目录（默认与索引文件同目录）")
    ap.add_argument("-o", "--out", default=None, help="输出文件，默认 <源名>.merged.srt")
    ap.add_argument("--dedupe", action="store_true",
                    help="去掉接缝处重复的条目（拆分时用了 --overlap 才需要）")
    ap.add_argument("--shift", type=float, default=0.0,
                    help="整体平移秒数，用于微调同步（正数=字幕往后推）")
    args = ap.parse_args()

    mpath = Path(args.manifest)
    if not mpath.exists():
        print("找不到索引文件:", mpath)
        return 1
    man = json.loads(mpath.read_text(encoding="utf-8"))
    srt_dir = Path(args.srt_dir) if args.srt_dir else mpath.parent
    out_path = Path(args.out) if args.out else mpath.parent / (Path(man["source"]).stem + ".merged.srt")

    print(f"源视频：{man['source']}   总时长 {man['duration']:.1f} 秒   共 {len(man['parts'])} 段")
    print(f"字幕目录：{srt_dir}")

    merged = []
    missing = []
    for i, part in enumerate(man["parts"], 1):
        stem = Path(part["file"]).stem
        cand = srt_dir / f"{stem}.srt"
        if not cand.exists():
            # 兼容播放器把文件名改掉的情况：在目录里找包含 partNN 的 srt
            hits = sorted(srt_dir.glob(f"*{stem}*.srt"))
            hits = [h for h in hits if h.name != out_path.name]
            if not hits:
                missing.append(stem)
                print(f"  [{i}/{len(man['parts'])}] ✗ 找不到 {stem}.srt，跳过")
                continue
            cand = hits[0]
        items = parse_srt(cand)
        off = part["start"] + args.shift
        for it in items:
            merged.append({
                "start": it["start"] + off,
                "end": it["end"] + off,
                "lines": it["lines"],
            })
        print(f"  [{i}/{len(man['parts'])}] {cand.name}  {len(items)} 条  (偏移 +{off:.1f}s)")

    if not merged:
        print("\n✗ 一条都没合并到。检查一下 .srt 是不是放在正确目录，"
              "或用 --srt-dir 指定。")
        return 1

    merged.sort(key=lambda x: x["start"])

    # 段间重叠会带来重复条目：相邻且文字相同就丢掉靠后的那条
    if args.dedupe:
        deduped = []
        for it in merged:
            if deduped:
                a = norm(" ".join(deduped[-1]["lines"]))
                b = norm(" ".join(it["lines"]))
                if a and b and (a == b or (len(a) > 8 and (a in b or b in a))):
                    deduped[-1]["end"] = max(deduped[-1]["end"], it["end"])
                    continue
            deduped.append(it)
        print(f"\n去重：{len(merged)} → {len(deduped)} 条")
        merged = deduped

    lines = []
    for i, it in enumerate(merged, 1):
        lines.append(str(i))
        lines.append(f"{sec_to_ts(it['start'])} --> {sec_to_ts(it['end'])}")
        lines.extend(it["lines"])
        lines.append("")
    out_path.write_text("\n".join(lines), encoding="utf-8")

    dur = [x["end"] - x["start"] for x in merged]
    print(f"\n✓ 已保存 {out_path}")
    print(f"  共 {len(merged)} 条，中位时长 {sorted(dur)[len(dur)//2]:.1f} 秒，"
          f"覆盖到 {max(x['end'] for x in merged)/60:.1f} 分钟")
    if missing:
        print(f"\n  ! 有 {len(missing)} 段没找到字幕：{', '.join(missing)}")
        print("    把这几段在播放器里补跑一遍，再重新合并即可。")
    print("\n把合并后的 .srt 和原始长视频一起用就行。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
