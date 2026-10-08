#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""EchoPlayer 局域网伴生识别后端（recognition_server.py）。

只做三件事：

1. 静态托管：仅对外公开 PUBLIC_FILES 白名单里的文件
   （index.html / offline-pack.js / sw.js / manifest.webmanifest）
   以及根目录下的截图（*.png）。目录列表、源码、隐藏文件、
   路径穿越一律 404。
2. 识别接口：GET /api/status、POST /api/transcribe、GET|DELETE /api/jobs/{id}。
3. 子进程推理：faster-whisper 跑在 multiprocessing spawn 出来的子进程里，
   父进程只维护任务状态，所以「取消」能真正把推理掐掉。
4. 字幕库：GET|POST /api/library/{id}（见 subtitle_store.py）。
   id 只允许 16~64 位十六进制（内容指纹），路径永远由 id 拼出来且已被白名单
   正则卡死，所以拿不到库目录之外的任何文件；请求体上限 8MB、条数上限 5000。
   POST 走写操作前奏（X-EchoPlayer + Origin 校验），只落白名单字段，凭据进不来。
   识别任务跑完时（哪怕前端已经断线）也会按上传时带的 X-Video-Id 存一次。

安全约定（前端契约的一部分）：
  * 写操作必须带 X-EchoPlayer: 1
  * 带 Origin 的跨站请求一律拒绝（与 Host 比对），从不返回 CORS 头
  * Host 只允许 localhost / 127.* / ::1 / 本机局域网 IP，防 DNS rebinding
  * 上传内容只落盘到系统临时目录（不在托管目录内），上限 2GB
  * 字幕库只按十六进制 id 读写，不接受任何来自客户端的路径
"""
from __future__ import annotations

import http.server
import importlib.util
import json
import mimetypes
import multiprocessing
import os
import re
import shutil
import socket
import sys
import tempfile
import threading
import time
import urllib.parse
import uuid
from urllib.parse import urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import subtitle_store  # noqa: E402  （同目录模块，先补好 sys.path 再导入）
import storage_config  # noqa: E402  （共享库目录配置，见 storage_config.py）
import portable_paths  # noqa: E402  （便携包路径探测，见 portable_paths.py）

# 便携包：模型就在 runtime/models 里，锁死离线，绝不触发下载。
# 必须在 import faster_whisper 之前设置，否则 huggingface_hub 已经读走了环境变量。
PORTABLE_MODE = portable_paths.apply_offline_env()

DEFAULT_PORT = 8765
_SHARES = {}
_SHARES_LOCK = threading.RLock()
SHARE_TTL = 30 * 60

# 离线学习包暂存（电脑打包 -> 手机扫码直接下载）
_PACKS_LOCK = threading.RLock()
PACK_TTL = 2 * 60 * 60
PACK_MAX_BYTES = 120 * 1024 * 1024
# Windows 移动热点默认网段，手机连上热点后要用这个 IP 才通
HOTSPOT_PREFIXES = ("192.168.137.", "192.168.173.")


def _packs_dir():
    path = os.path.join(tempfile.gettempdir(), "echoplayer-packs")
    try:
        os.makedirs(path, exist_ok=True)
    except Exception:
        pass
    return path


def _pack_prune(now=None):
    """清掉过期的学习包（含 sidecar），避免临时目录堆积。"""
    now = time.time() if now is None else now
    try:
        for entry in os.listdir(_packs_dir()):
            target = os.path.join(_packs_dir(), entry)
            try:
                if os.path.isfile(target) and now - os.path.getmtime(target) > PACK_TTL:
                    os.remove(target)
            except Exception:
                continue
    except Exception:
        pass


def _hotspot_info():
    """读取 Windows「移动热点」的 SSID / 密码。

    来源：ICS 服务的 PrivateConnectionSettings 二进制块，
    布局是 [4B 标志][64B SSID UTF-16LE][64B 密码 UTF-16LE]。
    读不到（非 Windows / 没配过热点 / 权限不够）就返回空字典，
    前端退化成让用户手填，不影响主流程。
    """
    if os.name != "nt":
        return {}
    try:
        import winreg
    except Exception:
        return {}
    try:
        key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                             r"SYSTEM\CurrentControlSet\Services\icssvc\Settings")
        try:
            value, _ = winreg.QueryValueEx(key, "PrivateConnectionSettings")
        finally:
            winreg.CloseKey(key)
    except Exception:
        return {}
    try:
        blob = bytes(value)
    except Exception:
        return {}
    if len(blob) < 132:
        return {}

    def _u16(chunk):
        return chunk.decode("utf-16-le", errors="ignore").split("\x00", 1)[0].strip()

    # 布局：[0:4] 标志 [4:68] SSID(UTF-16LE) [68:70] 长度 [70:134] 密码(UTF-16LE)
    ssid = _u16(blob[4:68])
    password = _u16(blob[70:134]) if len(blob) >= 134 else ""
    if not ssid:
        return {}
    if not password:
        # 不同 Windows 版本偏移可能微调：退回到「扫描前两段可读 ASCII 串」
        runs = re.findall(r"[ -~]{3,}", blob.decode("utf-16-le", errors="ignore"))
        if len(runs) >= 2:
            password = runs[1].strip()
    return {"ssid": ssid, "password": password, "security": "WPA",
            "source": "windows-ics"}


def _wifi_payload(ssid, password, security="WPA"):
    """生成手机相机可直接识别的 WiFi 连接二维码内容（WIFI: URI 方案）。"""
    def esc(value):
        text = "" if value is None else str(value)
        for ch in ("\\", ";", ",", ":", '"', "'"):
            text = text.replace(ch, "\\" + ch)
        return text

    body = "S:%s;" % esc(ssid)
    if password:
        body += "P:%s;" % esc(password)
    return "WIFI:T:%s;%s;" % (security or "WPA", body)


def _preferred_host(fallback=""):
    """优先返回热点网段 IP，否则回落到局域网 IP。"""
    try:
        ips = lan_ips()
    except Exception:
        ips = []
    if not ips:
        return fallback
    for prefix in HOTSPOT_PREFIXES:
        for ip in ips:
            if ip.startswith(prefix):
                return ip
    return ips[0]

# 明确公开的文件白名单（不在这里的一律 404）；截图 = 根目录 *.png
PUBLIC_STATIC = "index.html"
PUBLIC_FILES = frozenset((
    "index.html",
    "js/listening.js",
    'js/core.js',
    'js/deepseek.js',
    'js/dictionary-core.js',
    'js/dictionary.js',
    'js/events.js',
    'js/export.js',
    'js/help.js',
    'js/init.js',
    'js/ipa-sentences.js',
    'js/ipa-words.js',
    'js/library.js',
    'js/playback.js',
    'js/recognition.js',
    'js/render.js',
    'js/resume.js',
    'js/runtime.js',
    'js/settings.js',
    'js/storage.js',
    'js/subtitle-parser.js',
    'js/subtitle-tools.js',
    'js/translation.js',
    'js/vocabulary.js',
    'styles/player.css',
    'styles/liquid-glass.css',
    'js/glass-ui.js',
    'echoplayer-icon.ico',

    "offline-pack.js",       # 离线导出脚本，由前端维护
    "sw.js",                 # 可选的 Service Worker（存在才服务）
    "manifest.webmanifest",  # 可选的 PWA manifest（存在才服务）
))
DEFAULT_MODEL = "base"
ALLOWED_MODELS = ("tiny", "base", "small")

MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024
UPLOAD_CHUNK = 1 << 20
MAX_LIBRARY_BYTES = subtitle_store.MAX_BODY_BYTES
MAX_MEDIA_BYTES = storage_config.MAX_MEDIA_BYTES
MAX_CONFIG_BYTES = 64 * 1024
MAX_JOBS = 24
JOB_TTL_SECONDS = 3600.0

SENTENCE_MAX_SECONDS = 6.0
SENTENCE_MAX_WORDS = 18

_SENTENCE_END = ".!?\u3002\uff01\uff1f\u2026"
_TRAILING = "\"'\u201d\u2019)]}\uff09\u3011\u300b"
_SAFE_EXT = re.compile(r"^\.[A-Za-z0-9]{1,8}$")

_HF_CACHE_HINT = (
    "模型下载失败：请检查网络（首次使用需要从 Hugging Face 下载模型），"
    "或设置 ECHOPLAYER_MODEL_DIR 指向已经下载好的模型目录。"
)


# --------------------------------------------------------------------------
# 本机地址 / 依赖探测
# --------------------------------------------------------------------------
def lan_ips():
    """列出本机局域网 IPv4，按「最可能是 WiFi/以太网」排序。"""
    found = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        primary = s.getsockname()[0]
        s.close()
        if primary and not primary.startswith("127."):
            found.append(primary)
    except Exception:
        pass

    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip and ip not in found and not ip.startswith("127."):
                found.append(ip)
    except Exception:
        pass

    def score(ip):
        if ip.startswith("192.168."):
            return 0
        if ip.startswith("10."):
            return 1
        if ip.startswith("172."):
            return 2
        return 3

    return sorted(dict.fromkeys(found), key=score)


_allowed_lock = threading.Lock()
_allowed_cache = (0.0, frozenset())


def allowed_hosts():
    """Host 头允许的取值集合（60 秒缓存）。"""
    global _allowed_cache
    now = time.time()
    with _allowed_lock:
        ts, cached = _allowed_cache
    if cached and now - ts < 60.0:
        return cached
    hosts = {"localhost", "::1", "127.0.0.1"}
    hosts.update(ip.lower() for ip in lan_ips())
    value = frozenset(hosts)
    with _allowed_lock:
        _allowed_cache = (now, value)
    return value


def _host_only(value):
    """从 Host / netloc 里取出主机名部分（去掉端口、IPv6 方括号）。"""
    value = (value or "").strip().lower()
    if not value:
        return ""
    if value.startswith("["):
        end = value.find("]")
        return value[1:end] if end > 0 else value
    if value.count(":") == 1:
        return value.split(":", 1)[0]
    return value


def _host_port(value):
    value = (value or "").strip()
    if not value:
        return None
    if value.startswith("["):
        end = value.find("]")
        rest = value[end + 1:] if end > 0 else ""
        return int(rest[1:]) if rest.startswith(":") and rest[1:].isdigit() else None
    if value.count(":") == 1:
        port = value.split(":", 1)[1]
        return int(port) if port.isdigit() else None
    return None


def host_is_trusted(host_header):
    host = _host_only(host_header)
    if host == "":
        return True  # HTTP/1.0 之类不带 Host 的请求
    if host == "localhost" or host == "::1":
        return True
    if host.startswith("127."):
        # 只认字面量回环 IP，别放行 "127.0.0.1.evil.example" 这种域名
        parts = host.split(".")
        return len(parts) == 4 and all(
            part.isdigit() and 0 <= int(part) <= 255 for part in parts)
    return host in allowed_hosts()


def is_local_client(address):
    """请求来源是不是本机回环地址（= 能弹系统窗口 / 改共享库根目录的那台电脑）。"""
    host = (address or "").strip().lower()
    if not host:
        return False
    if host in ("::1", "localhost"):
        return True
    if host.startswith("::ffff:"):
        host = host[len("::ffff:"):]
    if host.startswith("127."):
        parts = host.split(".")
        return len(parts) == 4 and all(p.isdigit() and 0 <= int(p) <= 255 for p in parts)
    return False


def _parse_byte_range(value, size):
    """解析单段 Range：返回 (start, end) / "full"（当整段返回）/ None（416）。"""
    text = (value or "").strip().lower()
    if not text.startswith("bytes="):
        return "full"
    spec = text[len("bytes="):].strip()
    if not spec or "," in spec:
        return "full"  # 多段范围不支持，退回整段，不算错误
    start_text, _, end_text = spec.partition("-")
    start_text = start_text.strip()
    end_text = end_text.strip()
    if not start_text and not end_text:
        return None
    try:
        if not start_text:  # 后缀范围：最后 N 字节
            suffix = int(end_text)
            if suffix <= 0 or size <= 0:
                return None
            return (max(0, size - suffix), size - 1)
        start = int(start_text)
        if start < 0 or start >= size:
            return None
        if not end_text:
            return (start, size - 1)
        end = int(end_text)
        if end < start:
            return None
        return (start, min(end, size - 1))
    except ValueError:
        return None


def recognizer_available():
    """faster-whisper / av 是否装好（不真正 import，避免拖慢启动）。"""
    try:
        return (
            importlib.util.find_spec("faster_whisper") is not None
            and importlib.util.find_spec("av") is not None
        )
    except Exception:
        return False


# --------------------------------------------------------------------------
# 句子切分（纯函数，方便单测）
# --------------------------------------------------------------------------
def _ends_sentence(text):
    stripped = (text or "").strip().rstrip(_TRAILING)
    return bool(stripped) and stripped[-1] in _SENTENCE_END


def _flush_group(group):
    start = float(group[0]["start"])
    end = max(float(item["end"]) for item in group)
    # faster-whisper 通常在词首带空格，但不同版本/模型不保证这一点。
    # 统一按词加空格，再清掉英文标点前的空格，避免出现“Helloworld”。
    text = " ".join(str(item["text"]).strip() for item in group if str(item["text"]).strip())
    text = re.sub(r"\s+([,.;!?%:\u3002\uff01\uff1f])", r"\1", text)
    text = re.sub(r"([([{\u3008\u300a])\s+", r"\1", text)
    return {"start": round(start, 3), "end": round(end, 3), "text": text}


def group_words_into_sentences(words, max_seconds=SENTENCE_MAX_SECONDS,
                               max_words=SENTENCE_MAX_WORDS):
    """使用独立精听模块，按词间停顿和意群分段，保留逐词时间。"""
    from listening_segments import group_words_into_sentences as group
    return group(words, max_seconds=max_seconds, max_words=max_words)


# --------------------------------------------------------------------------
# 子进程：真正的识别逻辑
# --------------------------------------------------------------------------
def _atomic_write_json(path, payload):
    tmp = "%s.%d.tmp" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def _read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return None


def _probe_media(path):
    """用 PyAV 打开一次，媒体不合法时抛出异常。"""
    import av  # 依赖不存在时由调用方兜底

    with av.open(path) as container:
        if not container.streams.audio and not container.streams.video:
            raise ValueError("文件里没有音频轨道")


def worker_entry(model_name, audio_path, out_path, model_dir):
    """子进程入口：加载模型、识别、把状态写进 out_path（JSON）。"""
    last = [0.0]

    def publish(status, progress, message, segments=None, error=None):
        payload = {
            "status": status,
            "progress": round(max(0.0, min(1.0, float(progress))), 4),
            "message": message,
        }
        if segments is not None:
            payload["segments"] = segments
        if error:
            payload["error"] = error
        try:
            _atomic_write_json(out_path, payload)
        except Exception:
            pass
        last[0] = time.time()

    def publish_progress(progress, message):
        if time.time() - last[0] >= 0.4:
            publish("running", progress, message)

    try:
        from faster_whisper import WhisperModel
    except Exception:
        message = ("缺少 faster-whisper 依赖：请在电脑上运行  "
                   "python -m pip install -r requirements.txt")
        publish("error", 0.0, message, error=message)
        return

    try:
        _probe_media(audio_path)
    except Exception as exc:
        message = "无法识别的音视频文件（请换 mp4/mkv/mov/mp3 再试）：%s" % exc
        publish("error", 0.0, message, error=message)
        return

    publish("running", 0.05,
            "正在加载模型 %s（已内置，无需下载）…" % model_name
            if PORTABLE_MODE and portable_paths.model_available(model_name)
            else "正在加载模型 %s（首次使用会自动下载，请耐心等待）…" % model_name)
    try:
        model = WhisperModel(model_name, device="cpu", compute_type="int8",
                             download_root=model_dir or None)
    except Exception as exc:
        if PORTABLE_MODE and not os.environ.get("HF_ENDPOINT"):
            message = ("包内没有找到模型 %s，且便携模式已关闭联网下载。"
                       "请确认 runtime/models 目录完整（原始错误：%s）"
                       % (model_name, exc))
        else:
            message = "%s（原始错误：%s）" % (_HF_CACHE_HINT, exc)
        publish("error", 0.05, message, error=message)
        return

    publish("running", 0.1, "正在识别…")
    words = []
    try:
        segments, info = model.transcribe(
            audio_path,
            language="en",
            word_timestamps=True,
            vad_filter=True,
            beam_size=1,
            condition_on_previous_text=False,
        )
        duration = float(getattr(info, "duration", 0.0) or 0.0)
        for segment in segments:
            seg_words = getattr(segment, "words", None) or []
            if seg_words:
                for word in seg_words:
                    start = float(getattr(word, "start", 0.0) or 0.0)
                    end = float(getattr(word, "end", start) or start)
                    words.append({"start": start, "end": end,
                                  "word": str(getattr(word, "word", ""))})
            else:
                start = float(getattr(segment, "start", 0.0) or 0.0)
                end = float(getattr(segment, "end", start) or start)
                words.append({"start": start, "end": end,
                              "word": str(getattr(segment, "text", ""))})
            if duration > 0:
                done = min(1.0, float(getattr(segment, "end", 0.0) or 0.0) / duration)
                publish_progress(0.1 + 0.85 * done, "正在识别… %d%%" % int(done * 100))
            else:
                publish_progress(min(0.9, 0.1 + 0.02 * len(words)), "正在识别…")
    except Exception as exc:
        message = "识别失败（文件可能损坏或不是英文音视频）：%s" % exc
        publish("error", 0.1, message, error=message)
        return

    sentences = group_words_into_sentences(words)
    publish("done", 1.0, "完成：共 %d 句" % len(sentences), segments=sentences)


# --------------------------------------------------------------------------
# 子进程包装 / 任务管理
# --------------------------------------------------------------------------
class SubprocessRunner:
    """把 multiprocessing.Process 包一层，方便测试替换。"""

    def __init__(self, ctx, target, args):
        self._proc = ctx.Process(target=target, args=args, daemon=True)

    def start(self):
        self._proc.start()

    def is_alive(self):
        try:
            return self._proc.is_alive()
        except Exception:
            return False

    def terminate(self):
        try:
            self._proc.terminate()
        except Exception:
            pass

    def kill(self):
        try:
            self._proc.kill()
        except Exception:
            pass

    def join(self, timeout=None):
        try:
            self._proc.join(timeout)
        except Exception:
            pass


def _snapshot(job):
    out = {
        "status": job["status"],
        "progress": round(float(job["progress"]), 4),
        "message": job["message"],
        "segments": job["segments"],
    }
    if job.get("error"):
        out["error"] = job["error"]
    if "librarySaved" in job:
        out["librarySaved"] = job["librarySaved"]
    if job.get("libraryError"):
        out["libraryError"] = job["libraryError"]
    return out


class JobManager:
    """任务表：排队、进度、结果、取消、TTL 清理。

    runner_factory 可注入（测试时用假进程替换真实子进程）。
    """

    def __init__(self, ctx=None, target=None, runner_factory=None,
                 max_jobs=MAX_JOBS, ttl=JOB_TTL_SECONDS, poll_interval=0.2):
        self._ctx = ctx or multiprocessing.get_context("spawn")
        self._target = target or worker_entry
        self._runner_factory = runner_factory or self._default_runner
        self._max_jobs = max(1, int(max_jobs))
        self._ttl = float(ttl)
        self._poll = float(poll_interval)
        self._lock = threading.RLock()
        self._jobs = {}
        self._uploading = False
        self._closed = False

    # -- 上传互斥 ---------------------------------------------------------
    def _default_runner(self, spec):
        return SubprocessRunner(
            self._ctx, self._target,
            (spec["model"], spec["audio"], spec["out"], spec["model_dir"]))

    def reserve_upload(self):
        with self._lock:
            if self._closed or self._uploading or self._has_active_locked():
                return False
            self._uploading = True
            return True

    def release_upload(self):
        with self._lock:
            self._uploading = False

    def _has_active_locked(self):
        return any(job["status"] in ("queued", "running") for job in self._jobs.values())

    def busy(self):
        with self._lock:
            return bool(self._uploading or self._has_active_locked())

    # -- 任务生命周期 -----------------------------------------------------
    def submit(self, model, audio_path, workdir, filename="audio", key=None):
        now = time.time()
        job_id = uuid.uuid4().hex[:12]
        job = {
            "id": job_id,
            "status": "queued",
            "progress": 0.0,
            "message": "已接收 %s，排队中…" % filename,
            "segments": [],
            "error": None,
            "created": now,
            "updated": now,
            "_workdir": workdir,
            "_audio": audio_path,
            "_out": os.path.join(workdir, "status.json"),
            "_model": model,
            "_name": filename,
            "_key": key,
            "_saved": False,
            "_model_dir": portable_paths.resolved_model_dir(),
            "_proc": None,
            "_cancel": False,
        }
        with self._lock:
            if self._closed:
                raise RuntimeError("服务正在关闭，无法接受新任务")
            self._uploading = False
            self._prune_locked(now)
            self._jobs[job_id] = job
        thread = threading.Thread(target=self._monitor, args=(job,),
                                  name="echoplayer-job-%s" % job_id, daemon=True)
        job["_thread"] = thread
        thread.start()
        return job_id

    def get(self, job_id):
        with self._lock:
            self._prune_locked(time.time())
            job = self._jobs.get(job_id)
            return _snapshot(job) if job else None

    def delete(self, job_id):
        with self._lock:
            job = self._jobs.pop(job_id, None)
            if job is None:
                return False
            job["_cancel"] = True
            job["status"] = "cancelled"
            proc = job.get("_proc")
        if proc is not None:
            try:
                if proc.is_alive():
                    proc.terminate()
            except Exception:
                pass
            try:
                proc.join(3.0)
            except Exception:
                pass
            try:
                if proc.is_alive():
                    proc.kill()
            except Exception:
                pass
        self._cleanup(job)
        return True

    def shutdown(self):
        with self._lock:
            self._closed = True
            jobs = list(self._jobs.values())
            self._jobs.clear()
        for job in jobs:
            job["_cancel"] = True
            proc = job.get("_proc")
            if proc is not None:
                try:
                    if proc.is_alive():
                        proc.terminate()
                except Exception:
                    pass
            self._cleanup(job)

    # -- 内部实现 ---------------------------------------------------------
    def _monitor(self, job):
        spec = {
            "model": job["_model"],
            "audio": job["_audio"],
            "out": job["_out"],
            "model_dir": job["_model_dir"],
        }
        try:
            proc = self._runner_factory(spec)
            with self._lock:
                job["_proc"] = proc
            proc.start()
        except Exception as exc:
            self._set_error(job, "无法启动识别子进程：%s" % exc)
            self._cleanup(job)
            return

        while True:
            if job["_cancel"]:
                return
            data = _read_json(job["_out"])
            if data:
                self._apply(job, data)
            else:
                with self._lock:
                    if job["status"] == "queued" and time.time() - job["created"] > 1.0:
                        job["status"] = "running"
                        job["updated"] = time.time()
            if not proc.is_alive():
                break
            time.sleep(self._poll)

        if job["_cancel"]:
            return
        proc.join(2.0)
        data = _read_json(job["_out"])
        if data:
            self._apply(job, data)
        with self._lock:
            if job["status"] not in ("done", "error"):
                job["status"] = "error"
                job["error"] = "识别进程异常退出（没有返回结果）"
                job["message"] = "识别失败"
            job["updated"] = time.time()
        self._cleanup(job)

    def _apply(self, job, data):
        with self._lock:
            status = data.get("status")
            if status in ("queued", "running", "done", "error"):
                if not (job["status"] in ("done", "error") and status in ("queued", "running")):
                    job["status"] = status
            if "progress" in data:
                try:
                    job["progress"] = max(job["progress"], min(1.0, float(data["progress"])))
                except (TypeError, ValueError):
                    pass
            if data.get("message"):
                job["message"] = str(data["message"])
            segments = data.get("segments")
            if isinstance(segments, list):
                job["segments"] = segments
            if data.get("error"):
                job["error"] = str(data["error"])
            job["updated"] = time.time()
            finished = job["status"] == "done"
            if finished:
                # 持久化完成后才允许轮询读到 done，避免覆盖前端随后保存的译文。
                self._persist(job)

    def _persist(self, job):
        """任务成功结束时把结果写进字幕库；每个任务最多写一次，失败绝不影响任务。"""
        with self._lock:
            key = job.get("_key")
            if not key or job.get("_saved") or job["status"] != "done":
                return
            job["_saved"] = True
            segments = [seg for seg in (job.get("segments") or ()) if isinstance(seg, dict)]
            name = job.get("_name") or ""
            model = job.get("_model") or ""
        if not segments:
            return
        try:
            subtitle_store.save(key, {
                "videoName": name,
                "source": "local-asr:%s" % model if model else "local-asr",
                "segments": segments,
            })
            job["librarySaved"] = True
        except Exception as exc:
            job["librarySaved"] = False
            job["libraryError"] = "字幕落盘失败：%s" % exc

    def _set_error(self, job, message):
        with self._lock:
            job["status"] = "error"
            job["error"] = message
            job["message"] = "识别失败"
            job["updated"] = time.time()

    def _cleanup(self, job):
        with self._lock:
            workdir = job.get("_workdir")
            job["_workdir"] = None
            job["_audio"] = None
        if workdir:
            shutil.rmtree(workdir, ignore_errors=True)

    def _prune_locked(self, now):
        finished = [j for j in self._jobs.values()
                    if j["status"] in ("done", "error", "cancelled") and not j["_cancel"]]
        for job in finished:
            if now - job["updated"] > self._ttl:
                self._jobs.pop(job["id"], None)
                self._drop_workdir(job)
        while len(self._jobs) > self._max_jobs:
            candidates = [j for j in self._jobs.values() if j["status"] in ("done", "error", "cancelled")]
            if not candidates:
                break
            oldest = min(candidates, key=lambda j: j["updated"])
            self._jobs.pop(oldest["id"], None)
            self._drop_workdir(oldest)

    def _drop_workdir(self, job):
        workdir = job.get("_workdir")
        job["_workdir"] = None
        if workdir:
            shutil.rmtree(workdir, ignore_errors=True)


# --------------------------------------------------------------------------
# HTTP 处理器
# --------------------------------------------------------------------------
class _UploadError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


class RecognitionHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "SlowEchoPlayer/1.0"
    root = HERE
    manager = None

    # -- 基础工具 ---------------------------------------------------------
    def log_message(self, fmt, *args):
        if os.environ.get("ECHOPLAYER_VERBOSE"):
            sys.stderr.write("[recognition] %s - %s\n" % (self.address_string(), fmt % args))

    def _respond(self, code, body=b"", content_type="application/json; charset=utf-8",
                 close=False):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if close:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        if body and self.command != "HEAD":
            try:
                self.wfile.write(body)
            except Exception:
                self.close_connection = True

    def _json(self, code, payload, close=False):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._respond(code, body, close=close)

    def _prelude(self, mutation=False):
        if not host_is_trusted(self.headers.get("Host")):
            self._json(403, {"error": "Host 不受信任：只允许本机或本机局域网 IP 访问"},
                       close=True)
            return False
        if not mutation:
            return True
        if self.headers.get("X-EchoPlayer") != "1":
            self._json(403, {"error": "缺少 X-EchoPlayer: 1 请求头，该接口只给播放器页面调用"},
                       close=True)
            return False
        origin = self.headers.get("Origin")
        if origin and not self._origin_matches_host(origin):
            self._json(403, {"error": "跨站请求被拒绝（Origin 与 Host 不一致）"}, close=True)
            return False
        return True

    def _origin_matches_host(self, origin):
        try:
            parsed = urlsplit(origin)
        except Exception:
            return False
        if parsed.scheme not in ("http", "https"):
            return False
        origin_host = _host_only(parsed.netloc)
        host_header = self.headers.get("Host", "")
        host_host = _host_only(host_header)
        if not origin_host or not host_host or origin_host != host_host:
            return False
        origin_port = parsed.port
        host_port = _host_port(host_header)
        if origin_port is not None and host_port is not None and origin_port != host_port:
            return False
        return True

    # -- 路由 -------------------------------------------------------------
    def do_GET(self):
        try:
            if not self._prelude():
                return
            path = urlsplit(self.path).path
            if path.startswith("/share/"):
                self._handle_share_page(path[len("/share/"):])
                return
            if path.startswith("/api/share/"):
                tail = path[len("/api/share/"):]
                if tail.endswith("/qr"):
                    self._handle_share_qr(tail[:-3].rstrip("/"))
                elif tail.endswith("/video"):
                    self._handle_share_video(tail[:-6].rstrip("/"))
                else:
                    self._json(404, {"error": "分享不存在或已过期"}, close=True)
                return
            if path == "/api/qr.png":
                self._handle_qr()
                return
            if path == "/api/hotspot":
                self._handle_hotspot()
                return
            if path.startswith("/pack/"):
                self._handle_pack_download(path[len("/pack/"):])
                return
            if path == "/api/status":
                manager = self.manager
                self._json(200, {
                    "available": True,
                    "edition": "SlowEcho Player",
                    "recognizer": recognizer_available(),
                    "busy": bool(manager.busy()) if manager else False,
                    "library": subtitle_store.library_root(),
                })
                return
            if path.startswith("/api/library/"):
                self._handle_library_get(path[len("/api/library/"):])
                return
            if path == "/api/storage/config":
                self._handle_storage_config_get()
                return
            if path == "/api/library-index":
                self._handle_library_index()
                return
            if path.startswith("/api/library-media/"):
                self._handle_library_media_get(path[len("/api/library-media/"):])
                return
            if path.startswith("/api/jobs/"):
                job_id = path[len("/api/jobs/"):]
                if not job_id or "/" in job_id:
                    self._json(404, {"error": "任务不存在"})
                    return
                snapshot = self.manager.get(job_id) if self.manager else None
                if snapshot is None:
                    self._json(404, {"error": "任务不存在或已过期"})
                    return
                self._json(200, snapshot)
                return
            if path.startswith("/api/"):
                self._json(404, {"error": "没有这个接口"})
                return
            self._serve_static(path)
        except Exception as exc:
            self._json(500, {"error": "服务器内部错误：%s" % exc}, close=True)

    def do_POST(self):
        try:
            if not self._prelude(mutation=True):
                return
            parsed = urlsplit(self.path)
            if parsed.path == "/api/share":
                self._handle_share_create()
                return
            if parsed.path == "/api/offline-pack":
                self._handle_offline_pack_create()
                return
            if parsed.path == "/api/listening/pauses":
                from listening_audio import handle_pauses
                handle_pauses(self)
                return
            if parsed.path == "/api/storage/config":
                self._handle_storage_config_post()
                return
            if parsed.path == "/api/storage/pick":
                self._handle_storage_pick()
                return
            if parsed.path == "/api/local-media/pick":
                if not self._require_local():
                    return
                payload, error = self._read_json_body(MAX_CONFIG_BYTES)
                if error or not isinstance(payload, dict):
                    self._json(error or 400, {"error": "请求体不合法"}, close=True)
                    return
                import local_media
                entry = local_media.choose()
                self._json(200, {"entry": entry, "cancelled": entry is None}, close=True)
                return
            if parsed.path.startswith("/api/library-media/"):
                self._handle_library_media_post(parsed.path[len("/api/library-media/"):],
                                                urllib.parse.parse_qs(parsed.query))
                return
            if parsed.path.startswith("/api/library/"):
                self._handle_library_post(parsed.path[len("/api/library/"):])
                return
            if parsed.path == "/api/transcribe":
                self._handle_transcribe(urllib.parse.parse_qs(parsed.query))
                return
            self._json(404, {"error": "没有这个接口"}, close=True)
        except Exception as exc:
            self._json(500, {"error": "服务器内部错误：%s" % exc}, close=True)

    def do_DELETE(self):
        try:
            if not self._prelude(mutation=True):
                return
            path = urlsplit(self.path).path
            prefix = "/api/jobs/"
            if not path.startswith(prefix):
                self._json(404, {"error": "没有这个接口"})
                return
            job_id = path[len(prefix):]
            if not job_id or "/" in job_id:
                self._json(404, {"error": "任务不存在"})
                return
            deleted = self.manager.delete(job_id) if self.manager else False
            if not deleted:
                self._json(404, {"error": "任务不存在或已过期"})
                return
            self._json(200, {"status": "cancelled", "id": job_id})
        except Exception as exc:
            self._json(500, {"error": "服务器内部错误：%s" % exc}, close=True)

    def do_OPTIONS(self):
        # 不提供 CORS，前端也不应该跨站调用
        self._json(405, {"error": "不支持跨站预检请求"}, close=True)

    # -- 字幕库 -----------------------------------------------------------
    def _handle_library_get(self, raw_key):
        try:
            key = subtitle_store.validate_key(urllib.parse.unquote(raw_key))
        except subtitle_store.LibraryError as exc:
            self._json(exc.code, {"error": exc.message})
            return
        try:
            data = subtitle_store.load(key)
        except Exception as exc:
            self._json(500, {"error": "读取字幕库失败：%s" % exc})
            return
        if data is None:
            self._json(404, {"error": "字幕库里还没有这个视频的字幕"})
            return
        self._json(200, data)

    def _handle_library_post(self, raw_key):
        try:
            key = subtitle_store.validate_key(urllib.parse.unquote(raw_key))
        except subtitle_store.LibraryError as exc:
            self._json(exc.code, {"error": exc.message}, close=True)
            return
        content_length = self.headers.get("Content-Length")
        if content_length is None:
            self._json(411, {"error": "缺少 Content-Length，无法确认请求体大小"}, close=True)
            return
        try:
            length = int(content_length)
        except (TypeError, ValueError):
            self._json(400, {"error": "Content-Length 不合法"}, close=True)
            return
        if length <= 0:
            self._json(400, {"error": "请求体为空"}, close=True)
            return
        if length > MAX_LIBRARY_BYTES:
            self._json(413, {"error": "字幕内容过大：上限 %d MB"
                                      % (MAX_LIBRARY_BYTES // 1048576)}, close=True)
            return
        try:
            raw = self.rfile.read(length)
        except Exception as exc:
            self._json(400, {"error": "读取请求体失败：%s" % exc}, close=True)
            return
        if len(raw) != length:
            self._json(400, {"error": "请求体不完整"}, close=True)
            return
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            self._json(400, {"error": "请求体不是合法 JSON"}, close=True)
            return
        try:
            summary = subtitle_store.save(key, payload)
        except subtitle_store.LibraryError as exc:
            self._json(exc.code, {"error": exc.message}, close=True)
            return
        except Exception as exc:
            self._json(500, {"error": "写入字幕库失败：%s" % exc}, close=True)
            return
        self._json(200, summary)

    # -- 共享库配置 / 视频库 ----------------------------------------------
    def _client_is_local(self):
        return is_local_client(self.client_address[0] if self.client_address else "")

    def _require_local(self):
        """改共享库根目录 / 弹系统窗口只允许在本机操作，局域网只能看配置。"""
        if self._client_is_local():
            return True
        self._json(403, {"error": "这个操作只能在运行服务的这台电脑上进行；"
                                  "远程设备只能查看共享库配置"}, close=True)
        return False

    def _read_json_body(self, limit):
        """读一个小 JSON 请求体；返回 (payload, None) 或 (None, 错误码)。"""
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            return None, 411
        try:
            length = int(raw_length)
        except (TypeError, ValueError):
            return None, 400
        if length <= 0 or length > limit:
            return None, 400 if length <= 0 else 413
        raw = self.rfile.read(length)
        if len(raw) != length:
            return None, 400
        try:
            return json.loads(raw.decode("utf-8")), None
        except (UnicodeDecodeError, ValueError):
            return None, 400

    def _handle_storage_config_get(self):
        """GET /api/storage/config：任何受信来源都能看（含局域网）。"""
        try:
            config = storage_config.load_config()
        except Exception as exc:
            self._json(500, {"error": "读取共享库配置失败：%s" % exc})
            return
        self._json(200, {"directory": config["directory"],
                         "autoSaveVideo": bool(config["autoSaveVideo"])})

    # -- 临时二维码分享 ---------------------------------------------------
    @staticmethod
    def _share_get(token):
        if not re.fullmatch(r"[0-9a-f]{32}", token or ""):
            return None
        with _SHARES_LOCK:
            item = _SHARES.get(token)
            if not item or item["expires"] < time.time():
                _SHARES.pop(token, None)
                return None
            return item

    def _handle_share_create(self):
        payload, error = self._read_json_body(8 * 1024 * 1024)
        if error or not isinstance(payload, dict):
            self._json(error or 400, {"error": "分享内容不合法"}, close=True); return
        key = str(payload.get("key") or "").lower()
        try:
            key = subtitle_store.validate_key(key)
        except Exception:
            self._json(400, {"error": "视频标识不合法，请先打开视频"}, close=True); return
        # Resolve through the existing safe library/local-media path allowlist.
        source = storage_config.media_path(key)
        if not source:
            try:
                import local_media
                source = local_media.resolve(key)
            except Exception:
                source = None
        if not source:
            self._json(409, {"error": "电脑服务找不到原视频；请先用电脑端打开一次视频"}, close=True); return
        raw_segments = payload.get("segments")
        if not isinstance(raw_segments, list) or not raw_segments or len(raw_segments) > 5000:
            self._json(400, {"error": "没有可分享的字幕"}, close=True); return
        segments=[]
        for raw in raw_segments:
            if not isinstance(raw, dict): continue
            try: start=float(raw.get("start")); end=float(raw.get("end"))
            except (TypeError,ValueError): continue
            text=str(raw.get("text") or "").strip()[:2000]
            if not text or not (0 <= start < end): continue
            segments.append({"start":round(start,3),"end":round(end,3),"text":text,
                             "zh":str(raw.get("zh") or "")[:4000],"ipa":str(raw.get("ipa") or "")[:4000]})
        if not segments:
            self._json(400, {"error": "没有有效字幕"}, close=True); return
        token=uuid.uuid4().hex
        host=_host_only(self.headers.get("Host", "")); port=_host_port(self.headers.get("Host", ""))
        try:
            ips=lan_ips(); host=ips[0] if ips else host
        except Exception: pass
        base="http://%s%s" % (host, (":"+str(port)) if port else "")
        with _SHARES_LOCK:
            now=time.time()
            for old in list(_SHARES):
                if _SHARES[old]["expires"] < now: _SHARES.pop(old,None)
            _SHARES[token]={"key":key,"videoName":str(payload.get("videoName") or os.path.basename(source))[:240],
                            "segments":segments,"expires":now+SHARE_TTL}
        self._json(200,{"token":token,"url":base+"/share/"+token,"expiresIn":SHARE_TTL},close=True)

    def _handle_share_page(self, token):
        item=self._share_get(token)
        if not item: self._not_found(); return
        data=json.dumps(item["segments"],ensure_ascii=False).replace("</","<\\/")
        title=json.dumps(item["videoName"],ensure_ascii=False)
        html="""<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SlowEcho Player 分享</title>
<style>body{font-family:system-ui;background:#111827;color:#eef2ff;margin:0;padding:18px}main{max-width:760px;margin:auto}video{width:100%;max-height:58vh;background:#000;border-radius:10px}li{padding:10px;border-bottom:1px solid #334155;cursor:pointer}li.on{background:#1d4ed8}small{display:block;color:#a5b4fc;margin-top:3px}a,button{color:#fff;background:#2563eb;border:0;border-radius:7px;padding:9px 12px;text-decoration:none;margin:6px 4px 12px 0}</style>
<main><h2>SlowEcho Player · 分享学习视频</h2><p id="name"></p><video id="v" controls playsinline src="/api/share/%s/video"></video><p><a href="/api/share/%s/video" download>下载视频</a><button id="sub">下载字幕 JSON</button></p><ol id="list"></ol></main>
<script>const segs=%s, v=document.querySelector('#v');document.querySelector('#name').textContent=%s;const list=document.querySelector('#list');segs.forEach((s,i)=>{const li=document.createElement('li');li.textContent=s.text; if(s.zh||s.ipa){const sm=document.createElement('small');sm.textContent=[s.ipa&&'/'+s.ipa+'/',s.zh].filter(Boolean).join(' · ');li.append(sm)}li.onclick=()=>{v.currentTime=s.start;v.play()};list.append(li)});v.ontimeupdate=()=>{[...list.children].forEach((li,i)=>li.classList.toggle('on',v.currentTime>=segs[i].start&&v.currentTime<segs[i].end))};document.querySelector('#sub').onclick=()=>{const b=new Blob([JSON.stringify({videoName:%s,segments:segs},null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='subtitle.json';a.click()};</script>""" % (token,token,data,title,title)
        self._respond(200,html.encode("utf-8"),"text/html; charset=utf-8")

    def _handle_share_video(self, token):
        item=self._share_get(token)
        if not item: self._not_found(); return
        # Reuse the existing Range-safe media implementation and its path allowlist.
        self._handle_library_media_get(item["key"])

    # -- 手机扫码连热点 + 一键下载离线学习包 -------------------------------
    def _handle_hotspot(self):
        """GET /api/hotspot：热点 SSID/密码只给本机看，不向局域网广播。"""
        if not self._require_local():
            return
        info = _hotspot_info()
        try:
            ips = lan_ips()
        except Exception:
            ips = []
        port = _host_port(self.headers.get("Host", ""))
        host = _preferred_host(_host_only(self.headers.get("Host", "")) or "127.0.0.1")
        self._json(200, {
            "ips": ips,
            "port": port,
            "host": host,
            "baseUrl": "http://%s%s" % (host, (":" + str(port)) if port else ""),
            "hotspot": info or None,
            "wifiPayload": _wifi_payload(info.get("ssid", ""), info.get("password", "")) if info else None,
        })

    def _handle_qr(self):
        """GET /api/qr.png?text=...&size=8：把一段短文本画成二维码 PNG。"""
        query = urllib.parse.parse_qs(urlsplit(self.path).query or "")
        text = (query.get("text") or [""])[0]
        if not text or len(text) > 600:
            self._json(400, {"error": "text 缺失或过长（上限 600 字符）"}, close=True)
            return
        try:
            box = int((query.get("size") or ["8"])[0])
        except (TypeError, ValueError):
            box = 8
        box = max(4, min(box, 16))
        try:
            import io
            import qrcode
            out = io.BytesIO()
            maker = qrcode.QRCode(version=None, box_size=box, border=2)
            maker.add_data(text)
            maker.make(fit=True)
            maker.make_image(fill_color="black", back_color="white").save(out, format="PNG")
            self._respond(200, out.getvalue(), "image/png")
        except Exception as exc:
            self._json(503, {"error": "二维码组件不可用：%s" % exc}, close=True)

    def _handle_offline_pack_create(self):
        """POST /api/offline-pack：电脑打包好的 HTML 暂存起来，手机扫码直接下载。"""
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self._json(411, {"error": "缺少 Content-Length"}, close=True)
            return
        try:
            length = int(raw_length)
        except (TypeError, ValueError):
            self._json(400, {"error": "Content-Length 不合法"}, close=True)
            return
        if length <= 0 or length > PACK_MAX_BYTES:
            self._json(413, {"error": "学习包超过 %d MB，请取消视频嵌入后重试"
                                      % (PACK_MAX_BYTES // (1024 * 1024))}, close=True)
            return
        raw = self.rfile.read(length)
        if len(raw) != length:
            self._json(400, {"error": "上传内容不完整"}, close=True)
            return
        query = urllib.parse.parse_qs(urlsplit(self.path).query or "")
        name = (query.get("name") or [""])[0].strip()[:180] or "SlowEcho Player 离线精听"
        token = uuid.uuid4().hex
        with _PACKS_LOCK:
            _pack_prune()
            target = os.path.join(_packs_dir(), token + ".html")
            with open(target, "wb") as handle:
                handle.write(raw)
        try:
            ips = lan_ips()
        except Exception:
            ips = []
        port = _host_port(self.headers.get("Host", ""))
        primary = _preferred_host(_host_only(self.headers.get("Host", "")) or "127.0.0.1")

        def url_for(host):
            return "http://%s%s/pack/%s" % (host, (":" + str(port)) if port else "", token)

        urls, seen = [], set()
        for host in [primary] + ips:
            if host and host not in seen:
                seen.add(host)
                urls.append(url_for(host))
        self._json(200, {"token": token, "url": urls[0], "urls": urls,
                         "size": len(raw), "expiresIn": PACK_TTL}, close=True)

    def _handle_pack_download(self, token):
        """GET /pack/{token}：直接以附件形式下发学习包 HTML。"""
        if not re.fullmatch(r"[0-9a-f]{32}", token or ""):
            self._not_found()
            return
        target = os.path.join(_packs_dir(), token + ".html")
        if not os.path.isfile(target):
            self._not_found()
            return
        query = urllib.parse.parse_qs(urlsplit(self.path).query or "")
        name = (query.get("name") or [""])[0].strip()[:180] or "SlowEcho-离线精听"
        if not name.lower().endswith(".html"):
            name += ".html"
        try:
            with open(target, "rb") as handle:
                body = handle.read()
        except Exception as exc:
            self._json(500, {"error": "读取学习包失败：%s" % exc}, close=True)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Disposition", "attachment; filename=\"echoplayer-pack.html\"; "
                                                "filename*=UTF-8''%s" % urllib.parse.quote(name))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except Exception:
                self.close_connection = True

    def _handle_share_qr(self, token):
        item=self._share_get(token)
        if not item: self._not_found(); return
        host=_host_only(self.headers.get("Host", "")); port=_host_port(self.headers.get("Host", ""))
        try: host=(lan_ips() or [host])[0]
        except Exception: pass
        url="http://%s%s/share/%s" % (host, (":"+str(port)) if port else "", token)
        try:
            import qrcode, io
            out=io.BytesIO(); qrcode.make(url).save(out,format="PNG")
            self._respond(200,out.getvalue(),"image/png"); return
        except Exception as exc:
            self._json(503,{"error":"二维码组件不可用：%s" % exc},close=True)

    def _handle_storage_config_post(self):
        """POST /api/storage/config：仅本机；校验目录可写后再原子落盘。"""
        if not self._require_local():
            return
        payload, error = self._read_json_body(MAX_CONFIG_BYTES)
        if error is not None:
            message = {411: "缺少 Content-Length，无法确认请求体大小",
                       413: "配置内容过大"}.get(error, "请求体不合法")
            self._json(error, {"error": message}, close=True)
            return
        if not isinstance(payload, dict):
            self._json(400, {"error": "请求体必须是 JSON 对象"}, close=True)
            return
        try:
            config = storage_config.apply_config(payload.get("directory"),
                                                 payload.get("autoSaveVideo"))
        except storage_config.StorageConfigError as exc:
            self._json(exc.code, {"error": exc.message}, close=True)
            return
        except Exception as exc:
            self._json(500, {"error": "保存共享库配置失败：%s" % exc}, close=True)
            return
        self._json(200, {"directory": config["directory"],
                         "autoSaveVideo": bool(config["autoSaveVideo"])})

    def _handle_storage_pick(self):
        """POST /api/storage/pick：仅本机；弹系统文件夹选择器，取消返回 null。"""
        if not self._require_local():
            return
        try:
            directory = storage_config.pick_directory()
        except storage_config.StorageConfigError as exc:
            self._json(exc.code, {"error": exc.message}, close=True)
            return
        except Exception as exc:
            self._json(500, {"error": "无法打开文件夹选择器：%s" % exc}, close=True)
            return
        self._json(200, {"directory": directory, "cancelled": directory is None}, close=True)

    def _handle_library_index(self):
        """GET /api/library-index：列出库里已保存的字幕（含是否已有视频）。"""
        lessons = []
        for key in subtitle_store.list_keys():
            data = subtitle_store.load(key)
            if not data or not isinstance(data.get("segments"), list):
                continue  # 只认校验通过的 JSON 记录
            try:
                media = storage_config.media_path(key)
            except storage_config.StorageConfigError:
                media = None
            lessons.append({
                "key": key,
                "videoName": data.get("videoName") or "",
                "count": int(data.get("count") or len(data["segments"])),
                "hasVideo": bool(media),
            })
        import local_media
        for entry in local_media.entries():
            existing = next((item for item in lessons if item["key"] == entry["key"]), None)
            if existing:
                existing.update(hasVideo=True, localPath=True, size=entry.get("size"))
            else:
                lessons.append(entry)
        self._json(200, {"lessons": lessons})

    def _drain_body(self, length):
        """把请求体读掉丢弃，保证 keep-alive 连接不错位。"""
        remaining = length
        while remaining > 0:
            chunk = self.rfile.read(min(UPLOAD_CHUNK, remaining))
            if not chunk:
                return
            remaining -= len(chunk)

    def _handle_library_media_post(self, raw_key, query):
        """POST /api/library-media/<key>?name=...：分块流式落盘，不整段进内存。"""
        try:
            key = storage_config.media_key(urllib.parse.unquote(raw_key))
        except storage_config.StorageConfigError as exc:
            self._json(exc.code, {"error": exc.message}, close=True)
            return
        name = (query.get("name") or [""])[0]
        try:
            ext = storage_config.media_extension(name)
        except storage_config.StorageConfigError as exc:
            self._json(exc.code, {"error": exc.message}, close=True)
            return
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self._json(411, {"error": "缺少 Content-Length，无法确认视频大小"}, close=True)
            return
        try:
            length = int(raw_length)
        except (TypeError, ValueError):
            self._json(400, {"error": "Content-Length 不合法"}, close=True)
            return
        if length <= 0:
            self._json(400, {"error": "视频内容为空"}, close=True)
            return
        if length > MAX_MEDIA_BYTES:
            self._json(413, {"error": "视频过大：上限 %d GB"
                                      % (MAX_MEDIA_BYTES // (1 << 30))}, close=True)
            return
        existing = storage_config.media_path(key)
        if existing:
            self._drain_body(length)  # 同一 id 不重复写，但把请求体读干净再关连接
            self._json(200, {"ok": True, "skipped": True, "key": key,
                             "name": os.path.basename(existing)}, close=True)
            return
        try:
            target = storage_config.media_target(key, ext)
        except storage_config.StorageConfigError as exc:
            self._json(exc.code, {"error": exc.message}, close=True)
            return
        fd, tmp = tempfile.mkstemp(prefix=".tmp-media-", dir=os.path.dirname(target))
        try:
            with os.fdopen(fd, "wb") as handle:
                remaining = length
                while remaining > 0:
                    chunk = self.rfile.read(min(UPLOAD_CHUNK, remaining))
                    if not chunk:
                        raise _UploadError(400, "上传中断：收到的数据比 Content-Length 少")
                    handle.write(chunk)
                    remaining -= len(chunk)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, target)
            tmp = None
        except _UploadError as exc:
            self._json(exc.code, {"error": exc.message}, close=True)
            return
        except OSError as exc:
            self._json(500, {"error": "写入视频库失败：%s" % exc}, close=True)
            return
        finally:
            if tmp and os.path.exists(tmp):
                try:
                    os.remove(tmp)
                except OSError:
                    pass
        self._json(200, {"ok": True, "key": key, "name": os.path.basename(target),
                         "bytes": length})

    def _handle_library_media_get(self, raw_key):
        """GET /api/library-media/<key>：支持 Range 的分块流式回放。"""
        try:
            key = storage_config.media_key(urllib.parse.unquote(raw_key))
        except storage_config.StorageConfigError as exc:
            self._json(exc.code, {"error": exc.message})
            return
        path = storage_config.media_path(key)
        if not path:
            import local_media
            path = local_media.resolve(key)
        if not path:
            self._json(404, {"error": "视频库里还没有这个视频"})
            return
        try:
            size = os.path.getsize(path)
        except OSError as exc:
            self._json(500, {"error": "读取视频失败：%s" % exc})
            return
        content_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
        start, end, partial = 0, max(0, size - 1), False
        raw_range = self.headers.get("Range")
        if raw_range:
            parsed_range = _parse_byte_range(raw_range, size)
            if parsed_range is None:
                self.send_response(416)
                self.send_header("Content-Range", "bytes */%d" % size)
                self.send_header("Content-Length", "0")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return
            if parsed_range != "full":
                start, end = parsed_range
                partial = True
        body_length = 0 if size == 0 else end - start + 1
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(body_length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if partial:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.end_headers()
        if self.command == "HEAD" or body_length <= 0:
            return
        try:
            with open(path, "rb") as handle:
                handle.seek(start)
                remaining = body_length
                while remaining > 0:
                    chunk = handle.read(min(UPLOAD_CHUNK, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except Exception:
            self.close_connection = True

    # -- 上传 + 识别 ------------------------------------------------------
    def _handle_transcribe(self, query):
        manager = self.manager
        model = (query.get("model") or [DEFAULT_MODEL])[0].strip() or DEFAULT_MODEL
        if model not in ALLOWED_MODELS:
            self._json(400, {"error": "不支持的模型 %r：只能用 tiny / base / small" % model},
                       close=True)
            return
        if manager is None:
            self._json(503, {"error": "识别服务未启动"}, close=True)
            return
        if not recognizer_available():
            self._json(503, {"error": "电脑上缺少 faster-whisper 依赖，请运行："
                                      "python -m pip install -r requirements.txt"},
                       close=True)
            return

        # The native picker already authorized this exact file. No browser upload/copy needed.
        source_key = (query.get("key") or [""])[0]
        if source_key:
            import local_media
            try:
                source = storage_config.media_path(source_key) or local_media.resolve(source_key)
            except storage_config.StorageConfigError:
                source = None
            if not source:
                self._json(404, {"error": "原视频已移动、修改或删除，请重新打开"}, close=True)
                return
            if not manager.reserve_upload():
                self._json(409, {"error": "已有一个识别任务在进行"}, close=True)
                return
            workdir = None
            try:
                workdir = tempfile.mkdtemp(prefix="echoplayer-job-")
                job_id = manager.submit(model, source, workdir, os.path.basename(source), key=source_key)
                workdir = None
                self._json(202, {"id": job_id}, close=True)
            except Exception as exc:
                manager.release_upload()
                self._drop(workdir)
                self._json(500, {"error": "无法读取原视频：%s" % exc}, close=True)
            return

        content_length = self.headers.get("Content-Length")
        if content_length is None:
            self._json(411, {"error": "缺少 Content-Length，无法确认上传大小"}, close=True)
            return
        try:
            length = int(content_length)
        except (TypeError, ValueError):
            self._json(400, {"error": "Content-Length 不合法"}, close=True)
            return
        if length <= 0:
            self._json(400, {"error": "上传内容为空"}, close=True)
            return
        if length > MAX_UPLOAD_BYTES:
            self._json(413, {"error": "文件太大：单个文件最大 2GB"}, close=True)
            return

        if not manager.reserve_upload():
            self._json(409, {"error": "已有一个识别任务在进行，请等它完成或先取消"}, close=True)
            return

        filename = self._safe_filename(self.headers.get("X-Filename"))
        video_key = None
        raw_key = (self.headers.get("X-Video-Id") or "").strip()
        if raw_key:
            try:
                video_key = subtitle_store.validate_key(raw_key)
            except subtitle_store.LibraryError:
                video_key = None  # 键不合法就当没带，绝不影响识别本身
        workdir = None
        try:
            workdir = tempfile.mkdtemp(prefix="echoplayer-job-")
            suffix = ""
            ext = os.path.splitext(filename)[1]
            if _SAFE_EXT.match(ext):
                suffix = ext.lower()
            audio_path = os.path.join(workdir, "upload" + suffix)
            remaining = length
            with open(audio_path, "wb") as handle:
                while remaining > 0:
                    chunk = self.rfile.read(min(UPLOAD_CHUNK, remaining))
                    if not chunk:
                        raise _UploadError(400, "上传中断：收到的数据比 Content-Length 少")
                    handle.write(chunk)
                    remaining -= len(chunk)
            if os.path.getsize(audio_path) == 0:
                raise _UploadError(400, "上传内容为空")
            job_id = manager.submit(model, audio_path, workdir, filename, key=video_key)
            workdir = None  # 所有权交给任务管理器
            self._json(202, {"id": job_id})
        except _UploadError as exc:
            manager.release_upload()
            self._drop(workdir)
            self._json(exc.code, {"error": exc.message}, close=True)
        except Exception as exc:
            manager.release_upload()
            self._drop(workdir)
            self._json(500, {"error": "无法接收上传：%s" % exc}, close=True)

    @staticmethod
    def _drop(workdir):
        if workdir:
            shutil.rmtree(workdir, ignore_errors=True)

    @staticmethod
    def _safe_filename(raw):
        name = urllib.parse.unquote(raw or "")
        name = name.replace("\\", "/").split("/")[-1].strip()
        name = name.strip(". ") or "audio"
        return name[:120]

    # -- 静态托管 ---------------------------------------------------------
    @staticmethod
    def _is_public(name):
        if not name or name.startswith("."):
            return False
        if name in PUBLIC_FILES:
            return True
        return "/" not in name and name.lower().endswith(".png")

    def _serve_static(self, path):
        try:
            decoded = urllib.parse.unquote(path, errors="strict")
        except Exception:
            self._not_found()
            return
        decoded = decoded.replace("\\", "/")
        if "\x00" in decoded:
            self._not_found()
            return
        parts = [part for part in decoded.split("/") if part not in ("", ".")]
        if any(part == ".." for part in parts):
            self._not_found()
            return
        if not parts or decoded.endswith("/"):
            parts = [PUBLIC_STATIC]
        name = '/'.join(parts)
        if not self._is_public(name):
            self._not_found()
            return

        root = os.path.realpath(self.root)
        full = os.path.realpath(os.path.join(root, name))
        if full != os.path.normpath(os.path.join(root, name)) or os.path.commonpath([root, full]) != root:
            self._not_found()
            return
        if not os.path.isfile(full):
            self._not_found()
            return
        try:
            with open(full, "rb") as handle:
                body = handle.read()
        except OSError:
            self._json(500, {"error": "读取文件失败"}, close=True)
            return
        content_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
        if content_type.startswith("text/") and "charset" not in content_type:
            content_type += "; charset=utf-8"
        self._respond(200, body, content_type)

    def _not_found(self):
        self._json(404, {"error": "没有这个文件"}, close=True)


def build_handler(root=None, manager=None):
    return type("EchoPlayerRecognitionHandler", (RecognitionHandler,), {
        "root": os.path.abspath(root or HERE),
        "manager": manager,
    })


def create_server(host, port, root=None, manager=None):
    """起一个 ThreadingHTTPServer；返回的 server 上带 .manager 方便关闭。"""
    manager = manager or JobManager()
    handler = build_handler(root, manager)

    class _Server(http.server.ThreadingHTTPServer):
        daemon_threads = True
        allow_reuse_address = True

    server = _Server((host, port), handler)
    server.manager = manager
    return server
