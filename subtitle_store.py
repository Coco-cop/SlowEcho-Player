#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""EchoPlayer 字幕库（服务端持久化，subtitle_store.py）。

只做一件事：把「某个视频对应的字幕」按稳定的内容键存下来，重启后还能读回来。

设计约定：
  * 键只允许十六进制（16~64 位），绝不用它拼任意路径 —— 从根上杜绝目录穿越；
  * 目录优先级：ECHOPLAYER_LIBRARY_DIR → 用户配置 → 便携包 data/
    → ~/.echoplayer/subtitles；
  * 写入原子：同目录临时文件 + fsync + os.replace，断电不会留半个文件；
  * 每份字幕同时写一份人类可读的 .srt（含中英对照）；
  * payload 有硬上限（条数 / 单字段长度 / 总量），超限直接拒绝，不写盘；
  * 落盘字段是白名单（version / videoId / videoName / duration / offset / source /
    count / savedAt / segments），payload 里的其它东西一律丢弃 —— 凭据不是「被清洗掉」，
    而是根本进不了落盘对象（不靠黑名单，也就不怕漏网的名字）；
  * 数值一律要求有限：NaN / ±inf 在入口就回退，免得生成 SRT 时崩掉。
"""
from __future__ import annotations

import json
import math
import os
import re
import tempfile
import time

# 沿用旧版用户数据目录，改名后仍能读取既有字幕。
FALLBACK_LIBRARY_DIR = os.path.join(os.path.expanduser("~"), ".echoplayer", "subtitles")
LIBRARY_ENV = "ECHOPLAYER_LIBRARY_DIR"

# 上限：单条字幕字段 / 条数 / 请求体总量
MAX_SEGMENTS = 5000
MAX_TEXT_CHARS = 2000
MAX_ZH_CHARS = 2000
MAX_IPA_CHARS = 1200
MAX_NAME_CHARS = 300
MAX_BODY_BYTES = 8 * 1024 * 1024

_KEY_RE = re.compile(r"^[0-9a-f]{16,64}$")


class LibraryError(Exception):
    """字幕库调用方的输入有问题（键不合法 / 内容超限 / JSON 坏掉）。"""

    def __init__(self, message, code=400):
        super().__init__(message)
        self.message = message
        self.code = code


# --------------------------------------------------------------------------
# 目录 / 键
# --------------------------------------------------------------------------
def default_library_root():
    """内置默认目录（不看用户配置）。

    便携包（项目下有 runtime/）优先用包内的 data/ 目录，这样换台电脑、
    即可开箱即用；源码版默认使用当前用户的主目录。
    """
    try:
        import portable_paths
        bundled = portable_paths.bundled_data_dir()
        if bundled:
            return bundled
    except Exception:
        pass
    return FALLBACK_LIBRARY_DIR


def _configured_root():
    """用户配置（storage_config.py）里的共享库目录；没有配置 / 读不到就 None。"""
    try:
        import storage_config
        return storage_config.configured_directory()
    except Exception:
        return None


def library_root():
    """字幕库目录（不创建）。优先级：环境变量 → 用户配置 → 内置默认。"""
    env = (os.environ.get(LIBRARY_ENV) or "").strip()
    if env:
        return os.path.abspath(os.path.expanduser(env))
    configured = _configured_root()
    if configured:
        return configured
    return default_library_root()


def ensure_root():
    """确保目录存在并返回它。"""
    root = library_root()
    os.makedirs(root, exist_ok=True)
    return root


def validate_key(key):
    """校验视频内容键：只允许 16~64 位十六进制字符（大小写归一为小写）。"""
    if not isinstance(key, str):
        raise LibraryError("字幕库 ID 必须是字符串")
    norm = key.strip().lower()
    if not _KEY_RE.match(norm):
        raise LibraryError("字幕库 ID 不合法：只允许 16~64 位十六进制字符")
    return norm


def _paths(key):
    root = ensure_root()
    # 键已通过白名单正则，拼出来的路径必然落在 root 里
    return os.path.join(root, key + ".json"), os.path.join(root, key + ".srt")


def _atomic_write_bytes(path, data):
    directory = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=directory)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        tmp = None
    finally:
        if tmp and os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


# --------------------------------------------------------------------------
# 清洗
# --------------------------------------------------------------------------
def _num(value, default=0.0):
    """转成有限浮点数。非数字 / NaN / ±inf / 超大整数一律回退到 default。"""
    if isinstance(value, bool) or value is None:
        return default
    try:
        out = float(value.strip()) if isinstance(value, str) else float(value)
    except (TypeError, ValueError, OverflowError):
        return default
    return out if math.isfinite(out) else default


def _text(value, limit):
    if value is None:
        return ""
    if not isinstance(value, str):
        value = str(value)
    value = value.strip()
    if len(value) > limit:
        value = value[:limit]
    return value


def _clean_words(raw, start, end):
    """Optional word times survive saving, but arbitrary payload fields never do."""
    if not isinstance(raw, list) or not 1 <= len(raw) <= 400:
        return []
    out = []
    for item in raw:
        if not isinstance(item, dict):
            return []
        word = _text(item.get('word'), 150)
        try:
            a, b = float(item['start']), float(item['end'])
        except (ValueError, TypeError, KeyError):
            return []
        if not word or not math.isfinite(a) or not math.isfinite(b) or a < start-.1 or b < a or b > end+.1:
            return []
        if out and a < out[-1]['start']:
            return []
        out.append({'word':word,'start':round(a,3),'end':round(b,3)})
    return out


def _clean_segments(raw):
    if not isinstance(raw, list):
        raise LibraryError("segments 必须是数组")
    if len(raw) > MAX_SEGMENTS:
        raise LibraryError("字幕条数超限：最多 %d 条，收到 %d 条" % (MAX_SEGMENTS, len(raw)), 413)
    out = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        text = _text(item.get("text"), MAX_TEXT_CHARS)
        if not text:
            continue
        start = max(0.0, _num(item.get("start"), 0.0))
        end = max(start, _num(item.get("end"), start))
        seg = {"start": round(start, 3), "end": round(end, 3), "text": text}
        zh = _text(item.get("zh"), MAX_ZH_CHARS)
        if zh:
            seg["zh"] = zh
        ipa = _text(item.get("ipa"), MAX_IPA_CHARS)
        if ipa:
            seg["ipa"] = ipa
        words = _clean_words(item.get('words'), start, end)
        if words:
            seg['words'] = words
        out.append(seg)
    if len(out) > MAX_SEGMENTS:
        raise LibraryError("字幕条数超限", 413)
    return out


def normalize(key, payload):
    """把 POST 上来的 payload 变成落盘用的干净结构（严格白名单）。

    只保留 version / videoId / videoName / duration / offset / source /
    count / savedAt / segments；payload 里其它字段（设置、密钥、个人信息……）
    一律不落盘，所以不需要靠字段名黑名单去猜。
    """
    if not isinstance(payload, dict):
        raise LibraryError("请求体必须是 JSON 对象")
    segments = _clean_segments(payload.get("segments"))
    version = int(_num(payload.get("version"), 1.0))
    if not 1 <= version <= 1000:
        version = 1
    clean = {
        "version": version,
        "videoId": key,
        "videoName": _text(payload.get("videoName"), MAX_NAME_CHARS),
        "count": len(segments),
        "savedAt": time.time(),
        "segments": segments,
    }
    duration = _num(payload.get("duration"), 0.0)
    if duration > 0:
        clean["duration"] = round(duration, 3)
    offset = _num(payload.get("offset"), 0.0)
    if offset:
        clean["offset"] = round(offset, 3)
    source = _text(payload.get("source"), 40)
    if source:
        clean["source"] = source
    body = json.dumps(clean, ensure_ascii=False).encode("utf-8")
    if len(body) > MAX_BODY_BYTES:
        raise LibraryError("字幕内容过大：上限 %d MB" % (MAX_BODY_BYTES // 1048576), 413)
    return clean, body


# --------------------------------------------------------------------------
# SRT
# --------------------------------------------------------------------------
def _fmt_srt(seconds):
    seconds = _num(seconds, 0.0)
    if seconds < 0:
        seconds = 0
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return "%02d:%02d:%02d,%03d" % (h, m, s, ms)


def to_srt(segments):
    """生成人类可读的 SRT（有中文时英文 + 译文两行）。"""
    blocks = []
    for i, seg in enumerate(segments, 1):
        lines = [str(i), "%s --> %s" % (_fmt_srt(seg.get("start", 0)), _fmt_srt(seg.get("end", 0))),
                 seg.get("text", "")]
        zh = seg.get("zh") or ""
        if zh:
            lines.append(zh)
        ipa = seg.get("ipa") or ""
        if ipa:
            lines.append(ipa)
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks) + ("\n" if blocks else "")


# --------------------------------------------------------------------------
# 读写
# --------------------------------------------------------------------------
def load(key):
    """按键读取；不存在/损坏返回 None。"""
    norm = validate_key(key)
    path, _ = _paths(norm)
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    if not isinstance(data.get("segments"), list):
        return None
    data.setdefault("videoId", norm)
    return data


def save(key, payload):
    """原子写入 <key>.json + <key>.srt；返回落盘摘要。"""
    norm = validate_key(key)
    clean, body = normalize(norm, payload)
    json_path, srt_path = _paths(norm)
    srt = to_srt(clean["segments"])
    _atomic_write_bytes(srt_path, srt.encode("utf-8"))
    _atomic_write_bytes(json_path, body)
    return {
        "ok": True,
        "key": norm,
        "count": clean["count"],
        "bytes": len(body),
        "savedAt": clean["savedAt"],
        "json": os.path.basename(json_path),
        "srt": os.path.basename(srt_path),
    }


def list_keys():
    """列出库里已有的键（调试 / 测试用）。"""
    root = library_root()
    try:
        names = os.listdir(root)
    except OSError:
        return []
    out = []
    for name in names:
        if name.endswith(".json"):
            stem = name[:-5]
            if _KEY_RE.match(stem):
                out.append(stem)
    return sorted(out)
