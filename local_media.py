#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""EchoPlayer 本机原始视频路径登记（local_media.py）。

只做一件事：记住用户在本机通过原生文件选择器「亲自点选」的原始视频路径，之后
再次打开时直接按登记路径播放，**绝不复制视频**。

设计约定：
  * 私有登记表 local-media.json 与 storage_config.config_path() 同目录（兄弟文件），
    里面保存绝对路径，只给本进程用；对外 API 一律不吐绝对路径（只有 key / 文件名 /
    字节大小），根服务靠 size 判断「小视频可直接内嵌导出（<=80MB）」；
  * 键（key）必须与 js/library.js 的 videoLibraryId 完全一致：文件大小 +
    固定 192KB 抽样字节（0 / 中点-32KB / 末尾-64KB，各 64KB）喂进 4 路 32 位
    FNV 变体，输出 32 位十六进制；只流式读抽样，绝不整段读视频；
  * resolve 以「当前 stat 的 size + mtime_ns 与登记时一致」为准，文件没了 /
    改了 / 扩展名不在白名单 / 读不了，一律返回 None；
  * register 只应在「用户显式原生选择」后调用（根服务负责守门，不暴露任意路径接口）；
  * 写盘先加锁再原子落盘（同目录临时文件 + fsync + os.replace），断电不留半个文件。
"""
from __future__ import annotations

import contextlib
import json
import os
import re
import tempfile
import threading
import time

import storage_config

REGISTRY_FILENAME = "local-media.json"
LOCK_SUFFIX = ".lock"
LOCK_TIMEOUT = 5.0
LOCK_STALE = 60.0

_SAMPLE_BYTES = 65536          # 单个抽样窗口 64KB
_HALF_WINDOW = 32768           # 中点偏移
_FNV_INIT = (2166136261, 2246822519, 3266489917, 668265263)
_FNV_PRIME = 16777619
_HEADER = "elp-v1:%d:"
_KEY_RE = re.compile(r"^[0-9a-f]{32}$")

_THREAD_LOCK = threading.RLock()


class LocalMediaError(Exception):
    """本机媒体登记相关的输入问题（非法路径 / 不支持的格式 / 登记表被占用）。"""

    def __init__(self, message, code=400):
        super().__init__(message)
        self.message = message
        self.code = code


# --------------------------------------------------------------------------
# 登记表位置 / 读写
# --------------------------------------------------------------------------
def registry_path():
    """私有登记表路径：storage_config 配置文件的同目录兄弟文件。"""
    base = os.path.dirname(os.path.abspath(storage_config.config_path()))
    return os.path.join(base, REGISTRY_FILENAME)


def _read_entries():
    """读登记表；不存在 / 坏掉 / 结构不对都当空表（不抛异常）。"""
    try:
        with open(registry_path(), "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    entries = data.get("entries") if isinstance(data, dict) else None
    return entries if isinstance(entries, dict) else {}


def _atomic_write(path, data):
    """同目录临时文件 + fsync + os.replace（与 storage_config 同款做法）。"""
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
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


def _write_entries(entries):
    payload = {"version": 1, "entries": entries}
    _atomic_write(registry_path(),
                  json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8"))


@contextlib.contextmanager
def _locked():
    """跨进程写锁：独占创建锁文件，卡住就轮询；陈旧锁自动清理。"""
    with _THREAD_LOCK:
        path = registry_path() + LOCK_SUFFIX
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        deadline = time.monotonic() + LOCK_TIMEOUT
        while True:
            try:
                fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                break
            except FileExistsError:
                if _lock_is_stale(path):
                    _drop_lock(path)
                    continue
                if time.monotonic() >= deadline:
                    raise LocalMediaError("本机媒体登记表正被占用，请稍后重试", 503)
                time.sleep(0.02)
        try:
            yield
        finally:
            os.close(fd)
            _drop_lock(path)


def _lock_is_stale(path):
    try:
        return (time.time() - os.stat(path).st_mtime) > LOCK_STALE
    except OSError:
        return True


def _drop_lock(path):
    try:
        os.remove(path)
    except OSError:
        pass


# --------------------------------------------------------------------------
# 内容键：必须与 js/library.js 的 videoLibraryId 逐位一致
# --------------------------------------------------------------------------
def library_id(path):
    """按「大小 + 固定 192KB 抽样」算出 32 位十六进制键；只读抽样，不读整段视频。"""
    size = os.stat(path).st_size
    hashes = list(_FNV_INIT)

    def mix(chunk):
        for b in chunk:
            for i in range(4):
                hashes[i] = ((hashes[i] ^ b) * (_FNV_PRIME + i * 2)) & 0xFFFFFFFF

    mix((_HEADER % size).encode("utf-8"))
    starts = []
    for start in (0, max(0, size // 2 - _HALF_WINDOW), max(0, size - 65536)):
        if start not in starts:
            starts.append(start)
    with open(path, "rb") as handle:
        for start in starts:
            handle.seek(start)
            mix(handle.read(_SAMPLE_BYTES))
    return "".join("%08x" % h for h in hashes)


# --------------------------------------------------------------------------
# 对外 API
# --------------------------------------------------------------------------
def _extension(name):
    ext = os.path.splitext(name or "")[1].lower()
    return ext if ext in storage_config.MEDIA_EXTS else None


def _public(key, entry):
    """对外形状：key / 文件名 / 字节大小 / 布尔标记，绝不带绝对路径。

    size 是登记时原始文件的大小（字节），供导出端判断能否内嵌（<=80MB）；
    数值异常一律退化成 0，绝不把路径信息顺带吐出去。
    """
    try:
        size = int(entry.get("size"))
    except (TypeError, ValueError):
        size = 0
    return {"key": key, "videoName": entry.get("videoName") or "", "size": max(0, size),
            "hasVideo": True, "localPath": True, "count": 0}

def register(path):
    """登记用户显式选择的原始视频，返回公开 entry（内部保存绝对路径）。"""
    if not isinstance(path, str) or not path.strip():
        raise LocalMediaError("必须要一个本机视频文件路径")
    target = os.path.abspath(os.path.expanduser(path))
    if not os.path.isfile(target):
        raise LocalMediaError("文件不存在或不是普通文件：%s" % target)
    if _extension(target) is None:
        raise LocalMediaError("不支持的视频/音频格式：%s" % (os.path.splitext(target)[1] or "无扩展名"))
    if not os.access(target, os.R_OK):
        raise LocalMediaError("文件不可读：%s" % target)
    stat = os.stat(target)
    key = library_id(target)
    entry = {"path": target, "videoName": os.path.basename(target),
             "size": stat.st_size, "mtime_ns": stat.st_mtime_ns}
    with _locked():
        entries = _read_entries()
        entries[key] = entry
        _write_entries(entries)
    return _public(key, entry)


def resolve(key):
    """按键取回绝对路径；键不合法 / 没登记 / 文件没了或改了，一律 None。"""
    norm = key.strip().lower() if isinstance(key, str) else ""
    if not _KEY_RE.match(norm):
        return None
    entry = _read_entries().get(norm)
    if not isinstance(entry, dict):
        return None
    path = entry.get("path")
    if not isinstance(path, str) or _extension(path) is None:
        return None
    try:
        if not os.path.isfile(path) or not os.access(path, os.R_OK):
            return None
        stat = os.stat(path)
    except OSError:
        return None
    if stat.st_size != entry.get("size") or stat.st_mtime_ns != entry.get("mtime_ns"):
        return None
    return os.path.abspath(path)


def entries():
    """列出已登记视频的公开信息（无绝对路径），按文件名排序。"""
    listed = []
    for key, entry in _read_entries().items():
        if not _KEY_RE.match(key) or not isinstance(entry, dict):
            continue
        if not isinstance(entry.get("videoName"), str):
            continue
        if resolve(key) is None:
            continue
        listed.append(_public(key, entry))
    listed.sort(key=lambda item: (item["videoName"].lower(), item["key"]))
    return listed


def _ask_open_filename():
    """Windows 直接使用系统对话框；其他平台使用 Tk。取消返回 None。"""
    if os.name == "nt":
        from native_dialogs import NativeDialogError, pick_file
        try:
            return pick_file("选择本机视频（只记住路径，不复制文件）",
                             sorted(storage_config.MEDIA_EXTS))
        except NativeDialogError as exc:
            raise LocalMediaError("无法打开 Windows 文件选择器：%s" % exc, 503) from exc
    try:
        import tkinter
        from tkinter import filedialog
    except Exception as exc:  # tkinter 没装 / 没有 Tk
        raise LocalMediaError("这台电脑上无法打开文件选择器（缺少 tkinter）：%s" % exc, 503)
    try:
        root = tkinter.Tk()
    except Exception as exc:  # 没有图形界面 / 无显示
        raise LocalMediaError("无法打开文件选择器（可能没有图形界面）：%s" % exc, 503)
    try:
        root.withdraw()
        try:
            root.attributes("-topmost", True)
        except Exception:
            pass
        patterns = ["*" + ext for ext in sorted(storage_config.MEDIA_EXTS)]
        chosen = filedialog.askopenfilename(
            title="选择本机视频（只记住路径，不复制文件）",
            filetypes=[("视频/音频", patterns), ("所有文件", "*.*")])
    finally:
        try:
            root.destroy()
        except Exception:
            pass
    return chosen or None


def choose():
    """原生选一个本机视频并登记；用户取消返回 None。"""
    picked = _ask_open_filename()
    if not picked:
        return None
    return register(picked)
