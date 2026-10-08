#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""听写友好的词级时间戳切分（纯 Python：不联网、不加载模型）。

输入：faster-whisper 风格的词级时间戳 ``[{word, start, end}, ...]``
输出：``[{start, end, text, words: [{word, start, end}, ...]}, ...]``

设计目标（便于「盲听 / 精听」）：
1. 时间戳全部来自真实词级数据（首词 start / 末词 end），不做平均估算。
2. 优先在「真实停顿 >= 0.25s」处切分（尤其像 ``...above | to see...`` 这种停顿）；
   只有停顿带来的组是「有意义的」（>= 3 个词或 >= 1.1s）才采用。
3. 兼顾标点 / 从句边界；句子结束（. ! ? … 等）一定切，
   但 Mr./Dr./e.g./U.S. 等缩写不算句末。
4. 在不超过 max_words / max_seconds 的窗口内做前瞻 + 打分，选最优边界；
   避免把限定词 / 介词和它的补语切开（the | screen、to | see），
   但 >= 0.7s 的长停顿可以压过这条规则。
5. 不丢词、不重词、顺序与时间戳保持原样；非法 / NaN / 空词安全跳过或兜底。

无任何第三方依赖，方便直接单测。
"""
from __future__ import annotations

import math
import re

__all__ = ["group_words_into_sentences", "DEFAULT_MAX_SECONDS", "DEFAULT_MAX_WORDS"]

# --------------------------------------------------------------------------
# 常量
# --------------------------------------------------------------------------
DEFAULT_MAX_SECONDS = 6.0
DEFAULT_MAX_WORDS = 18

# 「有意义」的最小分组：>= 3 个词 或 >= 1.1s（满足其一即可）
MIN_MEANINGFUL_WORDS = 3
MIN_MEANINGFUL_SECONDS = 1.1

# 停顿阈值
WEAK_PAUSE = 0.25      # 达到即视为可切分的真实停顿
STRONG_PAUSE = 0.7     # 长停顿：可以压过「限定词/介词」保护规则
MIN_SPLIT_PAUSE = 0.25  # 整段都在上限内时，只在这种停顿处才额外切分

# 浮点比较用的极小容差（保证 <= max 的判定不被二进制误差破坏）
_TOL = 1e-6

# 缺失 / 非法间隔的兜底值（不凭空制造停顿）
MISSING_GAP_FALLBACK = 0.0

# 句末标点（含中英文）
_SENTENCE_END_CHARS = ".!?\u2026\u3002\uff01\uff1f"
# 结尾可能跟着的引号 / 右括号（判断句末时先剥掉）
_CLOSERS = "\"'\u201d\u2019\u3009\u300b\u300d\u300f)]}"
# 从句子中间断开也很自然的标点（从句 / 列举）
_CLAUSE_END_CHARS = ",;:\u2014\u2013"
# 省略号（...）
_CLAUSE_TAIL_RE = re.compile(r"\.\.\.$")

# 常见缩写：其后句点不是句末
ABBREVIATIONS = frozenset({
    "mr.", "mrs.", "ms.", "dr.", "prof.", "sr.", "jr.", "st.", "mt.", "ft.",
    "vs.", "etc.", "e.g.", "i.e.", "cf.", "al.", "ca.", "ed.", "esp.",
    "a.m.", "p.m.", "u.s.", "u.k.", "u.n.", "e.u.", "d.c.",
    "no.", "nos.", "fig.", "figs.", "inc.", "ltd.", "co.", "corp.", "dept.",
    "est.", "approx.", "appt.", "apt.", "min.", "max.", "avg.", "vol.",
    "ch.", "p.", "pp.", "sec.", "gen.", "col.", "sgt.", "capt.", "gov.",
    "sen.", "rep.", "pres.", "messrs.", "jan.", "feb.", "mar.", "apr.",
    "jun.", "jul.", "aug.", "sept.", "sep.", "oct.", "nov.", "dec.",
    "mon.", "tue.", "wed.", "thu.", "fri.", "sat.", "sun.",
})

# 断在它们之后会把限定词 / 介词与补语切开（弱停顿时的惩罚对象）。
# 注意：above / below / through / across 等常作副词，故意不列入。
_WEAK_TAIL_WORDS = frozenset({
    # 限定词 / 冠词 / 指示词
    "the", "a", "an", "this", "that", "these", "those", "my", "your", "his",
    "her", "its", "our", "their", "some", "any", "no", "every", "each",
    "both", "all", "another", "such", "which", "whose",
    # 介词 / 不定式标记
    "to", "of", "in", "on", "at", "for", "with", "from", "by", "about",
    "into", "onto", "upon", "within", "without", "between", "among",
    "during", "against", "toward", "towards", "as", "than", "per", "via",
    "despite",
})

_STRIP_TAIL_RE = re.compile(r"[^\w']+$")


# --------------------------------------------------------------------------
# 安全取值
# --------------------------------------------------------------------------
def _as_float(value):
    """转 float；None / bool / 非法 / NaN / inf 一律返回 None。"""
    if value is None or isinstance(value, bool):
        return None
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(num) or math.isinf(num):
        return None
    return num


def _word_text(value):
    """把 word 字段安全转成去掉首尾空白的字符串；非法返回空串。"""
    if value is None:
        return ""
    if isinstance(value, bool):
        return ""
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return ""
    if isinstance(value, bytes):
        try:
            value = value.decode("utf-8", "ignore")
        except Exception:
            return ""
    try:
        return str(value).strip()
    except Exception:
        return ""


def _normalize_words(words):
    """清洗成 [{'word': str, 'start': float, 'end': float}]（保序、保时间）。

    - 非 dict 的输入（如 faster-whisper 的 namedtuple）按属性读取；
    - 空词 / 非字符串非法词（None、NaN）跳过；
    - 时间戳缺失时用相邻词兜底，保证单调、不出现负时长；
    - 不丢真实词、不重排。
    """
    if words is None:
        return []
    try:
        source = list(words)
    except TypeError:
        return []

    normalized = []
    prev_end = None
    for raw in source:
        if isinstance(raw, dict):
            item = raw
        else:
            item = {}
            for key in ("word", "text", "start", "end"):
                if hasattr(raw, key):
                    item[key] = getattr(raw, key)
            if "word" not in item and "text" in item:
                item["word"] = item["text"]
        if not item:
            continue

        text = _word_text(item.get("word"))
        if not text:
            continue

        start = _as_float(item.get("start"))
        end = _as_float(item.get("end"))
        estimated = end is None          # end 缺失 -> 其后的间隔不可信
        if start is None and end is None:
            # 完全没有时间信息：贴着上一个词的结束时间，兜底为 0
            start = prev_end if prev_end is not None else 0.0
            end = start
        elif start is None:
            start = prev_end if prev_end is not None else end
        elif end is None:
            end = start
        if end < start:
            end = start

        normalized.append({"word": text, "start": float(start),
                           "end": float(end), "_estimated": estimated})
        prev_end = end if prev_end is None else max(prev_end, end)
    return normalized


# --------------------------------------------------------------------------
# 标点 / 词性判定
# --------------------------------------------------------------------------
def _strip_closers(text):
    return (text or "").strip().rstrip(_CLOSERS).strip()


def is_sentence_end(text):
    """该词是否结束一个句子（缩写、单字母首字母、U.S. 这类不算）。"""
    stripped = _strip_closers(text)
    if not stripped:
        return False
    last = stripped[-1]
    if last in _SENTENCE_END_CHARS and last != ".":
        return True
    if last != ".":
        return False
    core = stripped.lower()
    if core in ABBREVIATIONS:
        return False
    if re.fullmatch(r"[a-z]\.", core):        # 单字母首字母：J.
        return False
    if re.fullmatch(r"(?:[a-z]\.){2,}", core):  # U.S. / e.g. / i.e.
        return False
    return True


def _ends_clause(text):
    """该词是否以从句 / 列举类标点结尾（逗号、分号、冒号、破折号、省略号）。"""
    stripped = _strip_closers(text)
    if not stripped:
        return False
    if stripped[-1] in _CLAUSE_END_CHARS:
        return True
    return bool(_CLAUSE_TAIL_RE.search(stripped))


def _ends_weak(text):
    """该词是否是限定词 / 介词（弱停顿处不宜断在它后面）。"""
    core = _STRIP_TAIL_RE.sub("", (text or "").strip().lower())
    return core in _WEAK_TAIL_WORDS


# --------------------------------------------------------------------------
# 停顿 / 窗口
# --------------------------------------------------------------------------
def _gap(items, index):
    """第 index 个词与下一个词之间的真实停顿；缺失 / 非法 -> 兜底 0。"""
    if index < 0 or index + 1 >= len(items):
        return MISSING_GAP_FALLBACK
    if items[index].get("_estimated") or items[index + 1].get("_estimated"):
        # 时间戳是兜底出来的 -> 间隔未知，不能凭空当作停顿
        return MISSING_GAP_FALLBACK
    gap = items[index + 1]["start"] - items[index]["end"]
    if gap < 0.0:
        return 0.0
    return gap


def _window_end(items, start, total, max_seconds, max_words):
    """从 start 起、不超过上限的最远位置（exclusive），至少包含一个词。"""
    limit = min(total, start + max_words)
    end = start + 1                       # 单个词哪怕超长也不可分割
    span_end = items[start]["end"]
    for pos in range(start + 2, limit + 1):
        span_end = max(span_end, items[pos - 1]["end"])
        if span_end - items[start]["start"] <= max_seconds + _TOL:
            end = pos
        else:
            break
    return end


def _sentence_cut(items, start, limit):
    """窗口内最早的句末位置（cut-after 下标），没有则 None。"""
    for pos in range(start + 1, limit + 1):
        if is_sentence_end(items[pos - 1]["word"]):
            return pos
    return None


# --------------------------------------------------------------------------
# 打分 / 选边界
# --------------------------------------------------------------------------
def _score_boundary(items, start, cut, total, max_seconds, max_words):
    """给「在 cut 处切开」打分：越大越想在这里切。"""
    count = cut - start
    span = items[cut - 1]["end"] - items[start]["start"]
    pause = _gap(items, cut - 1)
    tail = items[cut - 1]["word"]

    # 尽量少切：偏好更长的组（词数 + 时长双维度填充度）
    score = 0.8 * (count / max_words)
    score += 0.6 * min(1.0, span / max_seconds)

    # 真实停顿：达到 0.25s 即明显加分，越接近 0.7s 加分越多
    if pause >= WEAK_PAUSE:
        span_ratio = (pause - WEAK_PAUSE) / (STRONG_PAUSE - WEAK_PAUSE)
        score += 1.5 + 1.5 * min(1.0, span_ratio)

    # 从句标点（逗号 / 分号 / 破折号）
    if _ends_clause(tail):
        score += 0.5

    # 避免残缺碎片：1 个词最严重（唯一被明确点名的规则），2 个词从轻
    if count < MIN_MEANINGFUL_WORDS and span < MIN_MEANINGFUL_SECONDS:
        score -= 2.5 if count == 1 else 0.6

    # 弱停顿下不要把限定词 / 介词与补语切开（长停顿例外）
    if pause < STRONG_PAUSE and _ends_weak(tail) and not _ends_clause(tail):
        score -= 1.6

    # 不要把尾巴切成一个孤字 / 碎片（除非句末标点或长停顿）
    if cut < total:
        rest = total - cut
        if rest == 1 and not is_sentence_end(items[-1]["word"]) and pause < STRONG_PAUSE:
            score -= 1.4
        elif rest < MIN_MEANINGFUL_WORDS and pause < STRONG_PAUSE:
            rest_span = items[-1]["end"] - items[cut]["start"]
            if rest_span < MIN_MEANINGFUL_SECONDS:
                score -= 0.8

    # 前瞻：这一刀之后，下一段是否还能落在好位置
    if cut < total:
        nxt = _window_end(items, cut, total, max_seconds, max_words)
        best_next_pause = 0.0
        for pos in range(cut + 1, nxt + 1):
            best_next_pause = max(best_next_pause, _gap(items, pos - 1))
        if _sentence_cut(items, cut, nxt) is not None or best_next_pause >= 0.4:
            score += 0.25

    return score


def _best_boundary(items, start, limit, total, max_seconds, max_words, require_pause):
    """在 (start, limit] 内挑最优边界；require_pause 时只在真实停顿处切。"""
    best_cut = None
    best_score = None
    for cut in range(start + 1, limit + 1):
        count = cut - start
        span = items[cut - 1]["end"] - items[start]["start"]
        pause = _gap(items, cut - 1)

        if require_pause:
            if pause < MIN_SPLIT_PAUSE:
                continue
            # 弱停顿处不要切开限定词 / 介词（长停顿例外）
            if pause < STRONG_PAUSE and _ends_weak(items[cut - 1]["word"]):
                continue
            # 有停顿但会切出残片就放弃（句末已在上层单独处理）
            if count < MIN_MEANINGFUL_WORDS and span < MIN_MEANINGFUL_SECONDS:
                continue

        score = _score_boundary(items, start, cut, total, max_seconds, max_words)
        if best_score is None or score > best_score:
            best_score = score
            best_cut = cut
    return best_cut


# --------------------------------------------------------------------------
# 输出
# --------------------------------------------------------------------------
def _flush(items, start, stop):
    """把 items[start:stop] 组装成一个听写段落（保留真实时间戳）。"""
    group = items[start:stop]
    text = " ".join(item["word"] for item in group)
    # 英文标点前不留空格；左括号后不留空格
    text = re.sub(r"\s+([,.;:!?%\)\]\}\u3002\uff01\uff1f\uff0c\uff1a\uff1b\u201d\u2019])",
                  r"\1", text)
    text = re.sub(r"([\(\[\{\u2018\u201c\u3008\u300a])\s+", r"\1", text)
    return {
        "start": round(group[0]["start"], 3),
        "end": round(max(item["end"] for item in group), 3),
        "text": text,
        "words": [
            {"word": item["word"], "start": round(item["start"], 3),
             "end": round(item["end"], 3)}
            for item in group
        ],
    }


# --------------------------------------------------------------------------
# 主入口
# --------------------------------------------------------------------------
def group_words_into_sentences(words, max_seconds=DEFAULT_MAX_SECONDS,
                               max_words=DEFAULT_MAX_WORDS):
    """把词级时间戳切分成适合盲听的分组。

    参数
        words: faster-whisper 风格 ``[{word, start, end}, ...]``（可为 None/空/脏数据）
        max_seconds: 单个分组最大时长（秒）
        max_words: 单个分组最大词数

    返回
        ``[{start, end, text, words}, ...]``；时间戳取真实首词 start 与末词 end。
    """
    items = _normalize_words(words)
    total = len(items)
    if total == 0:
        return []

    try:
        max_words = int(max_words)
    except (TypeError, ValueError):
        max_words = DEFAULT_MAX_WORDS
    if max_words < 1:
        max_words = 1

    max_seconds = _as_float(max_seconds)
    if max_seconds is None or max_seconds < 0:
        max_seconds = DEFAULT_MAX_SECONDS

    groups = []
    start = 0
    while start < total:
        limit = _window_end(items, start, total, max_seconds, max_words)

        # 1) 句末一定切（缩写已排除）
        sentence_cut = _sentence_cut(items, start, limit)
        if sentence_cut is not None:
            groups.append(_flush(items, start, sentence_cut))
            start = sentence_cut
            continue

        # 2) 剩余部分完全在上限内：只在真实停顿处才额外拆分
        if limit >= total:
            cut = _best_boundary(items, start, total - 1, total,
                                 max_seconds, max_words, require_pause=True)
            if cut is not None and start < cut < total:
                groups.append(_flush(items, start, cut))
                start = cut
                continue
            groups.append(_flush(items, start, total))
            break

        # 3) 快超上限：在窗口内选最优边界，选不到就用窗口末端兜底
        cut = _best_boundary(items, start, limit, total,
                             max_seconds, max_words, require_pause=False)
        if cut is None or cut <= start:
            cut = limit
        groups.append(_flush(items, start, cut))
        start = cut

    return groups
