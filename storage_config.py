#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SlowEcho Player 共享库目录配置（storage_config.py）。

只做一件事：记住「字幕 + 视频共享库放在哪个文件夹」，让字幕库（subtitle_store.py）
和视频库（recognition_server.py 的 /api/library-media）共用同一个根目录。

设计约定：
  * 配置文件放在每个用户自己的 ~/.echoplayer/storage.json；环境变量
    ECHOPLAYER_STORAGE_CONFIG 可以覆盖它的位置（测试就靠这个把配置写进临时目录，
    绝不碰真实用户配置）；
  * 落盘字段是白名单（directory / autoSaveVideo），别的键一律丢弃；
  * directory 必须是绝对路径；apply 时先建目录、再真写一个临时文件试可写，
    任何一步失败都保持原配置不变（先验证后提交）；
  * 写盘原子：同目录临时文件 + fsync + os.replace，断电不会留半个配置；
  * 目录优先级永远是：ECHOPLAYER_LIBRARY_DIR（环境变量）→ 用户配置 → 内置默认；
  * 视频/音频只按内容键（32 位十六进制）+ 白名单扩展名拼路径，
    客户端给的路径片段永远进不了磁盘路径（从根上杜绝目录穿越）。
"""
from __future__ import annotations

import json
import os
import re
import tempfile
import urllib.parse

import subtitle_store

CONFIG_ENV = "ECHOPLAYER_STORAGE_CONFIG"
CONFIG_DIRNAME = ".echoplayer"
CONFIG_FILENAME = "storage.json"

AUTO_SAVE_VIDEO_DEFAULT = False

# 视频库上限：单个文件最大 2GB（与上传上限一致）
MAX_MEDIA_BYTES = 2 * 1024 * 1024 * 1024

# 允许落进共享库的常见音视频扩展名（其余一律拒绝）
MEDIA_EXTS = frozenset((
    ".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi", ".flv", ".wmv",
    ".mpg", ".mpeg", ".ts", ".m2ts", ".3gp", ".ogv", ".vob", ".rmvb",
    ".ogg", ".mp3", ".m4a", ".aac", ".wav", ".flac", ".opus", ".wma", ".amr", ".oga",
))

_MEDIA_KEY_RE = re.compile(r"^[0-9a-f]{32}$")


class StorageConfigError(Exception):
    """共享库配置的输入有问题（目录不合法 / 不可写 / 键不合法 / 格式不支持）。"""

    def __init__(self, message, code=400):
        super().__init__(message)
        self.message = message
        self.code = code


# --------------------------------------------------------------------------
# 配置文件位置 / 读写
# --------------------------------------------------------------------------
def config_path():
    """配置文件路径。有环境变量就无条件用它（测试隔离用）。"""
    env = (os.environ.get(CONFIG_ENV) or "").strip()
    if env:
        return os.path.abspath(os.path.expanduser(env))
    return os.path.join(os.path.expanduser("~"), CONFIG_DIRNAME, CONFIG_FILENAME)


def _read_stored():
    """读原始配置；不存在 / 坏掉都当空配置（不抛异常）。"""
    try:
        with open(config_path(), "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _clean_directory(value):
    """把候选目录规整成绝对路径；不是字符串 / 空 / 相对路径一律返回 None。"""
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text or "\x00" in text:
        return None
    expanded = os.path.expanduser(text)
    if not os.path.isabs(expanded):
        return None
    return os.path.abspath(expanded)


def _atomic_write_bytes(path, data):
    """同目录临时文件 + fsync + os.replace（与 subtitle_store 同款做法）。"""
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


# --------------------------------------------------------------------------
# 目录解析
# --------------------------------------------------------------------------
def default_directory():
    """没有用户配置时的默认共享库目录（环境变量优先，便于测试/便携）。"""
    env = (os.environ.get(subtitle_store.LIBRARY_ENV) or "").strip()
    if env:
        return os.path.abspath(os.path.expanduser(env))
    return subtitle_store.default_library_root()


def configured_directory():
    """用户配置里那个合法目录；没配置 / 不合法返回 None。"""
    return _clean_directory(_read_stored().get("directory"))


def load_config():
    """当前生效配置：{directory, autoSaveVideo}。读不到就回退默认。"""
    stored = _read_stored()
    auto = stored.get("autoSaveVideo")
    return {
        "directory": _clean_directory(os.environ.get(subtitle_store.LIBRARY_ENV)) or _clean_directory(stored.get("directory")) or default_directory(),
        "autoSaveVideo": auto if isinstance(auto, bool) else AUTO_SAVE_VIDEO_DEFAULT,
    }


def save_config(config):
    """原子写入配置（只落 directory / autoSaveVideo 两个白名单字段）。"""
    if not isinstance(config, dict):
        raise StorageConfigError("配置必须是对象")
    directory = _clean_directory(config.get("directory"))
    if directory is None:
        raise StorageConfigError("目录必须是绝对路径")
    auto = config.get("autoSaveVideo")
    payload = {
        "directory": directory,
        "autoSaveVideo": auto if isinstance(auto, bool) else AUTO_SAVE_VIDEO_DEFAULT,
    }
    _atomic_write_bytes(config_path(),
                        json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8"))
    return payload


def _probe_writable(directory):
    """真写一个临时文件再删掉，确认目录确实可写。"""
    try:
        fd, tmp = tempfile.mkstemp(prefix=".tmp-write-", dir=directory)
    except OSError as exc:
        raise StorageConfigError("目录不可写：%s（%s）" % (directory, exc))
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(b"echoplayer")
            handle.flush()
            os.fsync(handle.fileno())
    except OSError as exc:
        raise StorageConfigError("目录不可写：%s（%s）" % (directory, exc))
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def apply_config(directory, auto_save_video):
    """校验 + 落盘新配置；任何一步失败都抛错且不动原配置。"""
    target = _clean_directory(directory)
    if target is None:
        raise StorageConfigError("目录必须是绝对路径")
    forced = _clean_directory(os.environ.get(subtitle_store.LIBRARY_ENV))
    if forced and os.path.normcase(forced) != os.path.normcase(target):
        raise StorageConfigError("当前目录由 ECHOPLAYER_LIBRARY_DIR 环境变量指定，请先取消环境变量再更改目录")
    if not isinstance(auto_save_video, bool):
        raise StorageConfigError("autoSaveVideo 必须是 true / false")
    if os.path.exists(target) and not os.path.isdir(target):
        raise StorageConfigError("这个路径已经是一个文件，不能作为库目录：%s" % target)
    try:
        os.makedirs(target, exist_ok=True)
    except OSError as exc:
        raise StorageConfigError("无法创建目录：%s（%s）" % (target, exc))
    _probe_writable(target)
    return save_config({"directory": target, "autoSaveVideo": auto_save_video})


# --------------------------------------------------------------------------
# 视频库（共享库目录下的 videos/）
# --------------------------------------------------------------------------
def videos_dir(root=None, create=False):
    """视频库目录 = <库根>/videos；create=True 时顺带建好。"""
    base = root or subtitle_store.library_root()
    path = os.path.join(base, "videos")
    if create:
        os.makedirs(path, exist_ok=True)
    return path


def media_key(key):
    """校验媒体内容键：只允许 32 位十六进制小写。"""
    norm = key.strip().lower() if isinstance(key, str) else ""
    if not _MEDIA_KEY_RE.match(norm):
        raise StorageConfigError("媒体库 ID 必须是 32 位十六进制字符")
    return norm


def media_extension(name):
    """从客户端给的视频名里取扩展名；带路径 / 穿越 / 非音视频一律拒绝。"""
    text = urllib.parse.unquote(name or "")
    if not text or "\x00" in text or "/" in text or "\\" in text:
        raise StorageConfigError("视频文件名不合法")
    base = text.strip().strip(". ")
    if not base or base in (".", ".."):
        raise StorageConfigError("视频文件名不合法")
    ext = os.path.splitext(base)[1].lower()
    if ext not in MEDIA_EXTS:
        raise StorageConfigError("不支持的视频/音频格式：%s" % (ext or "无扩展名"))
    return ext


def media_path(key, root=None):
    """按键找已存的媒体文件；没有返回 None。"""
    norm = media_key(key)
    base = os.path.join(videos_dir(root), norm)
    for ext in sorted(MEDIA_EXTS):
        candidate = base + ext
        real = os.path.realpath(candidate)
        parent = os.path.realpath(videos_dir(root))
        if os.path.isfile(candidate) and os.path.commonpath([parent, real]) == parent:
            return candidate
    return None


def media_target(key, ext, root=None):
    """给出该键的最终落盘路径（顺带建好 videos 目录）。"""
    norm = media_key(key)
    suffix = (ext or "").lower()
    if suffix not in MEDIA_EXTS:
        raise StorageConfigError("不支持的视频/音频格式")
    return os.path.join(videos_dir(root, create=True), norm + suffix)


# --------------------------------------------------------------------------
# 系统文件夹选择器（Windows 无额外依赖；其他平台使用 tkinter）
# --------------------------------------------------------------------------
def pick_directory(initial=None):
    """弹系统文件夹选择器；用户取消返回 None，环境不支持则抛错。"""
    if os.name == "nt":
        from native_dialogs import NativeDialogError, pick_folder
        start = initial or load_config().get("directory") or os.path.expanduser("~")
        try:
            chosen = pick_folder("选择 SlowEcho Player 共享字幕/视频库文件夹", start)
        except NativeDialogError as exc:
            raise StorageConfigError("无法打开 Windows 文件夹选择器：%s" % exc, 503) from exc
        return os.path.abspath(chosen) if chosen else None
    try:
        import tkinter
        from tkinter import filedialog
    except Exception as exc:  # tkinter 没装 / 没有 Tk
        raise StorageConfigError(
            "这台电脑上无法打开文件夹选择器（缺少 tkinter）：%s" % exc, 503)
    try:
        root = tkinter.Tk()
    except Exception as exc:  # 没有图形界面 / 无显示
        raise StorageConfigError(
            "无法打开文件夹选择器（可能没有图形界面）：%s" % exc, 503)
    try:
        root.withdraw()
        try:
            root.attributes("-topmost", True)
        except Exception:
            pass
        start = initial or load_config().get("directory") or os.path.expanduser("~")
        chosen = filedialog.askdirectory(initialdir=start,
                                         title="选择 SlowEcho Player 共享字幕/视频库文件夹")
    finally:
        try:
            root.destroy()
        except Exception:
            pass
    if not chosen:
        return None
    return os.path.abspath(chosen)
