/* Feature: events. See ARCHITECTURE.md for dependencies and contracts. */
EchoPlayer.define("events", () => {
'use strict';
/* ============================================================
   事件绑定
   ============================================================ */
const video = $("#video");

/* 文件选择 */
$("#btnOpenVideo").onclick = () => {
  const native=/^https?:$/.test(location.protocol)&&/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)&&!document.querySelector('meta[name="echoplayer-offline"]');
  if(native&&EchoPlayer.storage?.pickVideo)EchoPlayer.storage.pickVideo();else $("#fileVideo").click();
};
$("#btnOpenSub").onclick = $("#btnOpenSub2").onclick = () => openSubtitleTools();
$("#fileVideo").onchange = e => { const f = e.target.files[0]; if (f) { window.__currentVideoFile = f; loadVideoFile(f); } e.target.value = ""; };
$("#fileSub").onchange = e => {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  const importDialog = $('.modal[data-subtitle-tools][data-mode="import"]');
  r.onload = () => {
    const previous = S.segments;
    loadSubtitleText(r.result, f.name);
    if (S.segments !== previous && S.segments.length && importDialog?.isConnected) importDialog.closeDialog?importDialog.closeDialog():importDialog.remove();
  };
  r.readAsText(f, "UTF-8");
  e.target.value = "";
};

/* 拖拽导入 */
const vwrap = $("#vwrap");
["dragenter", "dragover"].forEach(ev => document.addEventListener(ev, e => {
  e.preventDefault(); vwrap.classList.add("dragover");
}));
["dragleave", "drop"].forEach(ev => document.addEventListener(ev, e => {
  e.preventDefault();
  if (ev === "dragleave" && e.relatedTarget) return;
  vwrap.classList.remove("dragover");
}));
document.addEventListener("drop", e => {
  const files = Array.from(e.dataTransfer?.files || []);
  if (!files.length) return;
  for (const f of files) {
    const n = f.name.toLowerCase();
    if (/\.(srt|vtt|ass|ssa|txt|json)$/.test(n)) {
      const r = new FileReader();
      r.onload = () => loadSubtitleText(r.result, f.name);
      r.readAsText(f, "UTF-8");
    } else if (/\.(mp4|webm|mkv|mov|avi|m4v|mp3|m4a|wav|flac|ogg|aac)$/.test(n) || f.type.startsWith("video") || f.type.startsWith("audio")) {
      window.__currentVideoFile = f;
      loadVideoFile(f);
    }
  }
});

/* 播放器控制 */
$("#btnPlay").onclick = () => video.paused ? video.play() : video.pause();
video.addEventListener("play", () => $("#btnPlay").dataset.playing = "true");
video.addEventListener("pause", () => {
  $("#btnPlay").dataset.playing = "false";
  if (!S.internalPause) clearGapTimer();
});
$("#btnPrev").onclick = () => gotoRelative(-1);
$("#btnNext").onclick = () => gotoRelative(1);
$("#btnRepeat").onclick = () => {
  if (S.active < 0) gotoRelative(1);
  else playSegment(S.active, { keepPlaying: true });
};
$("#btnLoop").onclick = e => {
  S.loopSentence = !S.loopSentence;
  e.currentTarget.classList.toggle("on", S.loopSentence);
  if (!S.loopSentence) { clearGapTimer(); S.loopLock = -1; }   // 关循环：取消延时续播与锁定
  toast(S.loopSentence ? "单句循环：开" : "单句循环：关");
};
$("#btnLoopGap").onclick = e => {
  S.loopGap = S.loopGap === 0 ? 0.5 : S.loopGap === 0.5 ? 1 : 0;
  e.currentTarget.textContent = "停顿 " + S.loopGap + "s";
  e.currentTarget.classList.toggle("on", S.loopGap > 0);
};
function setPlaybackSpeed(value) {
  const slider = $('#speed');
  const min = Number(slider.min), max = Number(slider.max), step = Number(slider.step);
  let speed = Number(value);
  if (!Number.isFinite(speed)) speed = 1;
  speed = Math.max(min, Math.min(max, Math.round(speed / step) * step));
  speed = Number(speed.toFixed(2));
  S.speed = speed; slider.value = String(speed);
  if (Math.abs(video.playbackRate - speed) > .001) video.playbackRate = speed;
  const label = speed.toFixed(2) + '×';
  $('#speedValue').textContent = label;
  $('#speedCurrent').textContent = label;
  $('#speedToggle').setAttribute('aria-label', '当前 ' + speed.toFixed(2) + ' 倍，' + ($('#speedPanel').hidden ? '展开' : '收起') + '自定义倍速');
  $$('.speed-presets [data-speed]').forEach(button => button.setAttribute('aria-pressed', String(Math.abs(Number(button.dataset.speed) - speed) < .001)));
  $('#speedValue').setAttribute('aria-label', '当前 ' + speed.toFixed(2) + ' 倍，点击恢复正常速度');
  slider.setAttribute('aria-valuetext', speed.toFixed(2) + ' 倍');
  slider.style.setProperty('--speed-progress', ((speed - min) / (max - min) * 100) + '%');
  return speed;
}
$('#speed').oninput = $('#speed').onchange = e => setPlaybackSpeed(e.target.value);
$('#speedValue').onclick = () => setPlaybackSpeed(1);
const speedControl = $('.speed-control');
function toggleSpeedPanel(open, restoreFocus = false) {
  $('#speedPanel').hidden = !open;
  $('#speedToggle').setAttribute('aria-expanded', String(open));
  $('#speedToggle').setAttribute('aria-label', '当前 ' + S.speed.toFixed(2) + ' 倍，' + (open ? '收起' : '展开') + '自定义倍速');
  $('#speedToggle').title = open ? '收起自定义倍速' : '展开自定义倍速';
  if (open) $('#speed').focus({preventScroll:true});
  else if (restoreFocus) $('#speedToggle').focus({preventScroll:true});
}
$('#speedToggle').onclick = () => toggleSpeedPanel($('#speedPanel').hidden);
$$('.speed-presets [data-speed]').forEach(button => button.onclick = () => {
  setPlaybackSpeed(button.dataset.speed);
  toggleSpeedPanel(false);
});
document.addEventListener('click', e => { if (!speedControl.contains(e.target)) toggleSpeedPanel(false); });
speedControl.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#speedPanel').hidden) {
    e.preventDefault(); e.stopPropagation(); toggleSpeedPanel(false, true);
  }
});
speedControl.addEventListener('focusout', () => requestAnimationFrame(() => {
  if (!speedControl.contains(document.activeElement)) toggleSpeedPanel(false);
}));
video.addEventListener('ratechange', () => setPlaybackSpeed(video.playbackRate));
setPlaybackSpeed(S.speed);
$("#offsetInput").onchange = e => setOffset(e.target.value);
$("#btnOverlay").onclick = e => {
  S.showOverlay = !S.showOverlay;
  LS.set("elp.showOverlay", S.showOverlay);
  e.currentTarget.classList.toggle("on", S.showOverlay);
  e.currentTarget.setAttribute("aria-pressed", String(S.showOverlay));
  renderOverlay();
};
$("#btnEn").onclick = e => { S.showEn = !S.showEn; e.currentTarget.classList.toggle("on", S.showEn); updateSubVisibility(); };
$("#btnZh").onclick = e => {
  S.showZh = !S.showZh; e.currentTarget.classList.toggle("on", S.showZh);
  if (S.showZh && S.active >= 0) maybeTranslate(S.active);
  updateSubVisibility();
};
$("#btnTranslateAll").onclick = translateAll;
$("#btnAutoScroll").onclick = e => {
  S.autoScroll = !S.autoScroll; e.currentTarget.classList.toggle("on", S.autoScroll);
  toast(S.autoScroll ? "跟随播放滚动：开" : "跟随播放滚动：关");
};
$("#seek").addEventListener("input", e => {
  if (!video.duration) return;
  clearGapTimer();          // 手动拖动进度条：取消待续播的停顿定时器
  S.loopLock = -1;          // 让 tick 重新锁定拖动后所在的句子
  video.currentTime = (e.target.value / 1000) * video.duration;
});
video.addEventListener("timeupdate", () => {
  if (!video.duration) return;
  $("#tCur").textContent = fmt(video.currentTime);
  $("#seek").value = Math.round((video.currentTime / video.duration) * 1000);
});
video.addEventListener("loadedmetadata", () => { $("#tDur").textContent = fmt(video.duration); });
// 视频播到结尾：最后一 cue 常常到不了 end 就 ended，这里按锁定句兜底重播
video.addEventListener("ended", () => {
  if (!S.segments.length) return;
  const p = planEnded({ segments: viewSegments(), loop: S.loopSentence, locked: S.loopLock });
  if (p.repeat && p.seekTo != null) {
    video.currentTime = p.seekTo;
    video.play().catch(() => {});
  } else if (S.loopSentence && S.active >= 0) {
    playSegment(S.active, { keepPlaying: true });
  }
});

/* 字幕列表交互 */
$("#segList").addEventListener("click", e => {
  const segEl = e.target.closest(".seg");
  if (!segEl) return;
  const i = +segEl.dataset.i;
  const wordEl = e.target.closest(".word");
  if (wordEl) {
    const r = wordEl.getBoundingClientRect();
    openWord(wordEl.dataset.w, S.segments[i].text, r.left + r.width / 2, r.bottom);
    return;
  }
  const act = e.target.closest("button[data-act]")?.dataset.act;
  if (act === "play" || act === "rep") { playSegment(i, { keepPlaying: true }); return; }
  if (act === "split") { EchoPlayer.listening?.open(i); return; }
  if (act === "tr") { translateSeg(i, true); return; }
  if (act === "star") {
    S.segments[i].starred = !S.segments[i].starred;
    e.target.closest("button").classList.toggle("starred", S.segments[i].starred);
    e.target.closest("button").textContent = S.segments[i].starred ? "★" : "☆";
    return;
  }
  playSegment(i, { keepPlaying: true });
});
$("#overlay").addEventListener("click", e => {
  const wordEl = e.target.closest(".word");
  if (wordEl && S.active >= 0) {
    const r = wordEl.getBoundingClientRect();
    openWord(wordEl.dataset.w, S.segments[S.active].text, r.left + r.width / 2, r.bottom);
  }
});
/* 弹窗内点击外部关闭 */
document.addEventListener("mousedown", e => {
  const p = $("#popup");
  if (p && !p.contains(e.target) && !e.target.closest(".word")) closePopup();
});

/* Tab 切换 */
$$(".tab").forEach(t => t.onclick = () => {
  $$(".tab").forEach(x => x.classList.remove("on"));
  t.classList.add("on");
  const k = t.dataset.tab;
  $("#paneSubs").hidden = k !== "subs";
  $("#paneVocab").hidden = k !== "vocab";
  $("#panePaste").hidden = k !== "paste";
});

/* 粘贴文本 */
$("#btnPasteLoad").onclick = () => {
  const txt = $("#pasteText").value.trim();
  if (!txt) { toast("请先粘贴文本", true); return; }
  const segs = textToSegments(txt, video.duration);
  if (!segs.length) { toast("没有解析出句子", true); return; }
  loadSegments(segs, true);
  toast(`已生成 ${segs.length} 句（时间轴按视频时长平均分配，不精确）`, true);
};
$("#btnPasteDemo").onclick = () => {
  $("#pasteText").value = `That is start and finish, I think, for everybody.\nI really am excited and scared and therefore wonderful, working on this problem.\nIt's exciting and scary and therefore worthwhile.\nI think it's going to be incredibly fun.`;
};

/* 导出 */
$("#btnExportSub").onclick = exportSubtitle;
$("#btnExportVocab").onclick = exportVocab;
$("#btnIpa").onclick = () => setShowIpa(!S.settings.showIpa);

/* 快捷键 */
document.addEventListener("keydown", e => {
  if (e.defaultPrevented) return;
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  if (e.key === "Escape") { closePopup(); return; }
  if (e.target.closest?.('button,summary,a,[contenteditable="true"],[role="tab"],.modal')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.key) {
    case " ": e.preventDefault(); if (video.currentSrc && !video.error) video.paused ? video.play() : video.pause(); break;
    case "ArrowLeft": e.preventDefault(); gotoRelative(-1); break;
    case "ArrowRight": e.preventDefault(); gotoRelative(1); break;
    case "R": case "r": $("#btnRepeat").click(); break;
    case "L": case "l": $("#btnLoop").click(); break;
    case "ArrowUp": {
      e.preventDefault();
      const nv = setPlaybackSpeed(S.speed + Number($('#speed').step));
      toast("倍速 " + nv + "×");
      break;
    }
    case "ArrowDown": {
      e.preventDefault();
      const nv = setPlaybackSpeed(S.speed - Number($('#speed').step));
      toast("倍速 " + nv + "×");
      break;
    }
    case "v": case "V": $("#btnZh").click(); break;
    case "s": case "S": $("#btnEn").click(); break;
  }
});


return {
get video(){return video;},
get setPlaybackSpeed(){return setPlaybackSpeed;}, set setPlaybackSpeed(value){setPlaybackSpeed=value;},
get vwrap(){return vwrap;}
};
});
