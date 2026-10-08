/* Feature: playback. See ARCHITECTURE.md for dependencies and contracts. */
EchoPlayer.define("playback", () => {
'use strict';
/* ---------- 字幕时间偏移 ----------
   有些片源音画/字幕本身对不齐，整体挪一下比手改字幕快得多。
   正数 = 字幕延后（字幕比声音慢），负数 = 字幕提前。            */
function subStart(s) { return Math.max(0, s.start + S.offset); }
function subEnd(s) { return Math.max(0, s.end + S.offset); }
// 纯函数：返回偏移后的时间轴副本（不改变 S.segments 里的原始数据）
function shiftSegments(segs, off) {
  return (segs || []).map(s => ({
    start: Math.max(0, s.start + off),
    end: Math.max(0, s.end + off)
  }));
}
// 带偏移的视图片段，供 segAt / planTick / planEnded 使用
function viewSegments() {
  return S.offset ? shiftSegments(S.segments, S.offset) : S.segments;
}
function setOffset(sec) {
  const n = Math.max(-60, Math.min(60, Number(sec) || 0));
  S.offset = Math.round(n * 100) / 100;
  const oi = $("#offsetInput"); if (oi) oi.value = String(S.offset);
  clearGapTimer();
  S.loopLock = -1;           // 时间轴变了，重新锁定当前句
  if (S.segments.length) toast("字幕偏移 " + (S.offset > 0 ? "+" : "") + S.offset + "s");
}

/* ---------- 循环决策（纯函数，便于单元测试） ---------- */
// 返回 t 所在的句下标；落在句与句的空隙里返回 -1
function segAt(segments, t) {
  for (let i = 0; i < segments.length; i++) {
    if (t >= segments[i].start && t < segments[i].end) return i;
  }
  return -1;
}
// 一次 tick 该做什么：要不要换 active、要不要回跳重播。
// 关键修复：单句循环时以 locked 为准，播放头越界也绝不切到下一句。
function planTick(st, t) {
  const segs = st.segments || [];
  if (!segs.length) return { active: st.active, seekTo: null, repeat: false };
  const locked = st.loop && st.locked >= 0 && st.locked < segs.length ? st.locked : -1;
  if (locked >= 0) {
    const s = segs[locked];
    if (t >= s.end - 0.04) return { active: locked, seekTo: s.start, repeat: true };
    return { active: locked, seekTo: null, repeat: false };
  }
  const idx = segAt(segs, t);
  return { active: idx === -1 ? st.active : idx, seekTo: null, repeat: false };
}
// 视频播到结尾：最后一 cue 常常走不到 end 就 ended，这里兜底重播
function planEnded(st) {
  const segs = st.segments || [];
  if (!st.loop || st.locked < 0 || st.locked >= segs.length) return { seekTo: null, repeat: false };
  return { seekTo: segs[st.locked].start, repeat: true };
}

/* ---------- 播放控制 ---------- */
function clearGapTimer() {
  if (S.gapTimer) { clearTimeout(S.gapTimer); S.gapTimer = 0; }
  S.internalPause = false;
}
// 循环停顿：到点自动续播。pause / seek / 切句 / 关循环 / 换视频都会取消它。
function scheduleGapResume(sec) {
  clearGapTimer();
  const token = S.videoToken;
  S.gapTimer = setTimeout(() => {
    S.gapTimer = 0;
    if (token !== S.videoToken || !S.loopSentence) return;
    $("#video").play().catch(() => {});
  }, Math.max(0, sec) * 1000);
}
function playSegment(i, { keepPlaying = true } = {}) {
  clearGapTimer();
  S.loopLock = i;            // 用户明确选中的句子 → 锁成循环目标
  setActive(i, { seek: true });
  if (keepPlaying) $("#video").play().catch(() => {});
}
function gotoRelative(d) {
  if (!S.segments.length) { toast("还没有字幕", true); return; }
  let i = S.active < 0 ? (d > 0 ? 0 : 0) : S.active + d;
  i = Math.max(0, Math.min(S.segments.length - 1, i));
  playSegment(i, { keepPlaying: true });
}
function tick() {
  S.rafId = requestAnimationFrame(tick);
  const v = $("#video");
  if (!S.segments.length || v.paused) return;
  const t = v.currentTime;
  const view = viewSegments();
  // 单句循环但还没锁定时：把播放头所在的句子锁住
  if (S.loopSentence && S.loopLock < 0) {
    const a = segAt(view, t);
    if (a >= 0) S.loopLock = a;
  }
  const plan = planTick(
    { segments: view, active: S.active, loop: S.loopSentence, locked: S.loopLock },
    t
  );
  // 先回跳再切高亮：锁定句不会被播放头带跑
  if (plan.active !== S.active && plan.active >= 0) setActive(plan.active);
  if (plan.repeat) {
    v.currentTime = plan.seekTo;
    if (S.loopGap > 0) { S.internalPause = true; v.pause(); scheduleGapResume(S.loopGap); }
  }
}


return {
get subStart(){return subStart;}, set subStart(value){subStart=value;},
get subEnd(){return subEnd;}, set subEnd(value){subEnd=value;},
get shiftSegments(){return shiftSegments;}, set shiftSegments(value){shiftSegments=value;},
get viewSegments(){return viewSegments;}, set viewSegments(value){viewSegments=value;},
get setOffset(){return setOffset;}, set setOffset(value){setOffset=value;},
get segAt(){return segAt;}, set segAt(value){segAt=value;},
get planTick(){return planTick;}, set planTick(value){planTick=value;},
get planEnded(){return planEnded;}, set planEnded(value){planEnded=value;},
get clearGapTimer(){return clearGapTimer;}, set clearGapTimer(value){clearGapTimer=value;},
get scheduleGapResume(){return scheduleGapResume;}, set scheduleGapResume(value){scheduleGapResume=value;},
get playSegment(){return playSegment;}, set playSegment(value){playSegment=value;},
get gotoRelative(){return gotoRelative;}, set gotoRelative(value){gotoRelative=value;},
get tick(){return tick;}, set tick(value){tick=value;}
};
});
