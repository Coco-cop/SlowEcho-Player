#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""便携运行时路径探测（portable_paths.py）。

只做一件事：判断「这个项目是不是被打包成了便携版」，也就是
项目目录下有没有 ``runtime/``。有的话，模型和 Python 都在包内，
一律优先用包内的，绝不去碰用户主目录、也绝不联网下载。

目录约定（打包后的样子）::

    EchoPlayer/
      runtime/
        python/python.exe          # 便携 Python
        models/                    # HuggingFace 缓存格式的模型
          models--Systran--faster-whisper-base/
        site-packages/             # （可选）额外依赖
      recognition_server.py
      ...

设计约定：
  * 探测只看文件系统，不做任何 import，启动时零成本；
  * 每个函数都能安全地在「非便携」环境下调用，返回 None 表示"没找到"；
  * 环境变量永远优先（ECHOPLAYER_MODEL_DIR / HF_ENDPOINT 等），
    这样高级用户依然可以覆盖；
  * 便携模式下会把 HF_HUB_OFFLINE=1 打开，从根上杜绝联网尝试——
    即使有人误删了模型，也是立刻报错，而不是卡在下载上。
"""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

MODEL_DIR_ENV = "ECHOPLAYER_MODEL_DIR"
PORTABLE_FLAG_ENV = "ECHOPLAYER_PORTABLE"


def project_root():
    """项目根目录 = 本文件所在目录。"""
    return HERE


def runtime_dir():
    """便携运行时目录；不存在返回 None。"""
    path = os.path.join(HERE, "runtime")
    return path if os.path.isdir(path) else None


def is_portable():
    """是否处于便携包内（有 runtime/ 目录）。"""
    return runtime_dir() is not None


def bundled_models_dir():
    """包内模型缓存目录；不存在返回 None。

    返回的是可以直接喂给 faster-whisper ``download_root`` 的目录，
    即 HuggingFace 的 hub 缓存格式。
    """
    base = runtime_dir()
    if not base:
        return None
    candidate = os.path.join(base, "models")
    return candidate if os.path.isdir(candidate) else None


def bundled_model_path(model_name):
    """包内已经下载好的某个模型目录；没有返回 None。

    model_name 可以是 'base' / 'tiny' / 'small'，也可以是完整的
    repo id（如 Systran/faster-whisper-base）。
    """
    hub = bundled_models_dir()
    if not hub:
        return None
    name = (model_name or "").strip()
    if not name:
        return None
    # 'base' -> 'models--Systran--faster-whisper-base'
    if "/" not in name:
        repo = "Systran/faster-whisper-%s" % name
    else:
        repo = name
    folder = "models--" + repo.replace("/", "--")
    path = os.path.join(hub, folder)
    return path if os.path.isdir(path) else None


def resolved_model_dir():
    """最终应该传给 download_root 的目录。

    优先级：ECHOPLAYER_MODEL_DIR 环境变量 → 包内 runtime/models → None
    （None 表示交给 faster-whisper 自己决定，也就是走用户主目录缓存）。
    """
    env = (os.environ.get(MODEL_DIR_ENV) or "").strip()
    if env:
        return os.path.abspath(os.path.expanduser(env))
    return bundled_models_dir()


def apply_offline_env():
    """便携模式下锁死离线，避免运行时再去联网。

    返回 True 表示确实开启了离线模式。
    """
    if not is_portable():
        return False
    # 用户显式设了 HF_ENDPOINT（比如想用镜像在线拉别的模型），就尊重他。
    if (os.environ.get("HF_ENDPOINT") or "").strip():
        return False
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    # 有些库会用 HF_HUB_DISABLE_TELEMETRY / DO_NOT_TRACK 决定是否发统计请求
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("DO_NOT_TRACK", "1")
    return True


def model_available(model_name):
    """包内是否真的有这个模型（用于启动时给出友好提示）。"""
    path = bundled_model_path(model_name)
    if not path:
        return False
    snapshots = os.path.join(path, "snapshots")
    if not os.path.isdir(snapshots):
        return False
    for entry in os.listdir(snapshots):
        full = os.path.join(snapshots, entry)
        if os.path.isdir(full) and os.path.isfile(os.path.join(full, "model.bin")):
            return True
    return False


def bundled_python():
    """包内的便携 Python 解释器路径；没有返回 None。"""
    base = runtime_dir()
    if not base:
        return None
    for rel in ("python/python.exe", "python/bin/python3", "python/bin/python"):
        candidate = os.path.join(base, *rel.split("/"))
        if os.path.isfile(candidate):
            return candidate
    return None


def bundled_data_dir(create=True):
    """便携包的数据目录（字幕库 / 视频库默认落这里）；非便携环境返回 None。

    放在项目根的 data/ 下，这样整个包可以随手拷到 U 盘或别的机器，
    学习记录跟着走，也不用假设 E 盘一定存在。
    """
    if not is_portable():
        return None
    path = os.path.join(HERE, "data")
    if create:
        try:
            os.makedirs(path, exist_ok=True)
        except OSError:
            return None
    return path if os.path.isdir(path) else None


def describe():
    """给启动日志用的一行摘要。"""
    if not is_portable():
        return "便携模式：关闭（使用系统 Python 与用户主目录模型缓存）"
    bits = ["便携模式：开启"]
    models = bundled_models_dir()
    if models:
        found = [m for m in ("tiny", "base", "small") if model_available(m)]
        bits.append("包内模型：%s" % (", ".join(found) if found else "无"))
    else:
        bits.append("包内模型：无")
    return "  ".join(bits)


if __name__ == "__main__":
    print("project_root   =", project_root())
    print("is_portable    =", is_portable())
    print("models_dir     =", bundled_models_dir())
    print("model_dir(env) =", resolved_model_dir())
    print("bundled_python =", bundled_python())
    for name in ("tiny", "base", "small"):
        print("  %-6s available=%s path=%s" % (
            name, model_available(name), bundled_model_path(name)))
    print(describe())
