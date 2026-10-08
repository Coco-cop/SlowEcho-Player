"""Bounded pause detection for an existing cue; no speech model or cloud call."""
import math
import os
import tempfile
import threading
from urllib.parse import parse_qs, urlsplit

_analysis_lock = threading.Lock()


def detect_pauses(path, start, end):
    import av
    import numpy as np

    rate = 16000
    samples = np.zeros(math.ceil((end - start) * rate), dtype=np.float32)
    covered = np.zeros(len(samples), dtype=bool)
    with av.open(path) as container:
        if not container.streams.audio:
            raise ValueError('视频没有音轨')
        container.seek(int(max(0, start - 1) * av.time_base), backward=True)
        resampler = av.AudioResampler(format='fltp', layout='mono', rate=rate)
        for frame in container.decode(audio=0):
            if frame.pts is None:
                continue
            if float(frame.pts * frame.time_base) > end + 1:
                break
            for out in resampler.resample(frame):
                if out.pts is None:
                    continue
                offset = round((float(out.pts * out.time_base) - start) * rate)
                audio = out.to_ndarray().reshape(-1)
                left, right = max(0, offset), min(len(samples), offset + len(audio))
                if right > left:
                    samples[left:right] = audio[left - offset:right - offset]
                    covered[left:right] = True
    if not covered.any():
        raise ValueError('本句时间范围内未能读取音频')
    window = 320
    size = len(samples) // window
    rms = np.sqrt(np.mean(samples[:size*window].reshape(-1,window)**2, axis=1))
    valid = covered[:size*window].reshape(-1,window).all(axis=1)
    threshold = max(0.003, min(0.025, float(np.percentile(rms[valid], 75))*0.18)) if valid.any() else 0.003
    quiet = (rms < threshold) & valid
    pauses, began = [], None
    for i, silent in enumerate(list(quiet) + [False]):
        if silent and began is None:
            began = i
        if not silent and began is not None:
            a, b = start+began*0.02, start+i*0.02
            if b-a >= 0.18 and a > start+0.35 and b < end-0.35:
                pauses.append({'start':round(a,3),'end':round(b,3),'time':round((a+b)/2,3)})
            began = None
    return pauses


def handle_pauses(handler):
    """Called only after the existing same-origin write prelude."""
    import storage_config
    query = parse_qs(urlsplit(handler.path).query)
    try:
        start = float(query.get('start',[''])[0]); end = float(query.get('end',[''])[0])
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or not 0.3 <= end-start <= 60:
            raise ValueError('请选择 0.3～60 秒以内的一句字幕')
    except (ValueError, TypeError):
        handler._json(400, {'error':'请选择有效的本句时间范围（最长 60 秒）'},close=True);return
    if not _analysis_lock.acquire(blocking=False):
        handler._json(409, {'error':'正在分析另一句的停顿，请稍后重试'},close=True);return
    temporary = None
    try:
        if handler.headers.get('Content-Type','').startswith('application/json'):
            key = query.get('key',[''])[0]
            try:
                import local_media
                path = storage_config.media_path(key) or local_media.resolve(key)
            except storage_config.StorageConfigError: path = None
            if not path:
                handler._json(404, {'error':'视频未保存在电脑文件库'},close=True);return
        else:
            try: length = int(handler.headers.get('Content-Length','0'))
            except ValueError: length = 0
            if not 0 < length <= 2*1024**3:
                handler._json(413, {'error':'视频为空或超过 2 GB'},close=True);return
            fd, temporary = tempfile.mkstemp(prefix='echoplayer-pause-',suffix='.media')
            with os.fdopen(fd,'wb') as out:
                remaining = length
                while remaining:
                    data=handler.rfile.read(min(1024*1024,remaining))
                    if not data: raise ValueError('视频传输中断')
                    out.write(data);remaining-=len(data)
            path=temporary
        handler._json(200, {'pauses':detect_pauses(path,start,end),'source':'audio-silence'},close=True)
    except Exception as error:
        handler._json(400, {'error':'无法分析停顿：'+str(error)},close=True)
    finally:
        if temporary:
            try: os.remove(temporary)
            except OSError: pass
        _analysis_lock.release()
