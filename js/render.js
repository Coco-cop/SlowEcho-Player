/* Feature: render. See ARCHITECTURE.md for dependencies and contracts. */
EchoPlayer.define("render", () => {
'use strict';
/* ---------- 渲染 ---------- */
const WORD_RE = /[A-Za-z]+(?:['’\-][A-Za-z]+)*/g;
function markWords(text) {
  return esc(text).replace(WORD_RE, m => {
    const k = m.toLowerCase();
    let cls = "word";
    if (VOCAB.has(k)) cls += " saved";
    else if (SEEN.has(k)) cls += " seen";
    return `<span class="${cls}" data-w="${k}">${m}</span>`;
  });
}
function renderList() {
  librarySchedule();
  const box = $("#segList");
  box.innerHTML = S.segments.map((s, i) => `
    <div class="seg" data-i="${i}">
      <div class="head">
        <span class="t">${fmt(s.start)}</span>
        <span class="acts">
          <button data-act="play" title="播放本句" aria-label="播放本句">▶</button>
          <button data-act="rep" title="重复本句" aria-label="重复本句">↻</button>
          <button data-act="split" title="拆分这句，按意群精听" aria-label="拆分这句，按意群精听">✂</button>
          <button data-act="tr" title="翻译本句" aria-label="翻译本句">译</button>
          <button data-act="star" class="${s.starred ? "starred" : ""}" title="收藏本句" aria-label="收藏本句">${s.starred ? "★" : "☆"}</button>
        </span>
      </div>
      <div class="en">${markWords(s.text)}</div>
      <div class="ipa" data-ipa="${i}">${esc(sentenceIpaDisplay(s))}</div>
      <div class="zh" data-zh="${i}">${s.zh ? esc(s.zh) : ""}</div>
    </div>`).join("");
  updateSubVisibility();
}
function renderSeg(i) {
  librarySchedule();
  const el = $(`.seg[data-i="${i}"]`);
  if (!el) return;
  const s = S.segments[i];
  const ipaEl=el.querySelector(".ipa");
  ipaEl.textContent=sentenceIpaDisplay(s);
  ipaEl.style.display=(S.showEn && S.settings.showIpa)?'':'none';
  ipaEl.onclick=()=>{if(!hasSentenceIpa(s) && !s._ipaBusy)ensureIpa(i,true);};
  el.querySelector(".en").innerHTML = markWords(s.text);
  const zh = el.querySelector(".zh");
  zh.classList.remove("loading");
  zh.textContent = s.zh || "";
}
function setActive(i, opt = {}) {
  if (i < 0 || i >= S.segments.length) return;
  const changed = i !== S.active;
  if (S.active >= 0) {
    const prev = $(`.seg[data-i="${S.active}"]`);
    if (prev) prev.classList.remove("active");
  }
  S.active = i;
  const el = $(`.seg[data-i="${i}"]`);
  if (el) {
    el.classList.add("active");
    if (S.autoScroll && changed) {
      const reduceMotion = document.documentElement?.dataset?.reduceMotion === "true" ||
        (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
      // Scroll only the subtitle pane: the phone video and bottom dock stay visible.
      const pane = $("#paneSubs"), row = el.getBoundingClientRect(), viewport = pane.getBoundingClientRect();
      pane.scrollTo({top:pane.scrollTop + row.top - viewport.top - (viewport.height-row.height)/2,
        behavior:reduceMotion ? "auto" : "smooth"});
    }
  }
  renderOverlay();
  if (opt.seek) {
    const v = $("#video");
    v.currentTime = subStart(S.segments[i]) + 0.001;
  }
  // 懒加载：翻译 & 音标
  if (changed) {
    maybeTranslate(i);
    ensureIpa(i);
  }
}
function renderOverlay() {
  const s = S.segments[S.active];
  const o = $("#overlay");
  o.classList.toggle("subtitles-off", !S.showOverlay);
  if (!s) { $("#oEn").innerHTML = ""; $("#oZh").innerHTML = ""; return; }
  $("#oEn").innerHTML = S.showEn ? markWords(s.text) : "";
  const zh = $("#oZh");
  zh.classList.toggle("hidden", !S.showZh || !s.zh);
  zh.innerHTML = s.zh ? esc(s.zh) : "";
}
function updateSubVisibility() {
  const list = $("#segList");
  list.classList.toggle("hide-en", !S.showEn);
  S.segments.forEach((_, i) => {
    const el = $(`.seg[data-i="${i}"]`);
    if (!el) return;
    el.querySelector(".en").style.display = S.showEn ? "" : "none";
    el.querySelector(".zh").style.display = S.showZh ? "" : "none";
    const ipaEl=el.querySelector(".ipa");
    ipaEl.textContent=sentenceIpaDisplay(S.segments[i]);
    ipaEl.style.display = (S.showEn && S.settings.showIpa) ? "" : "none";
    ipaEl.onclick=()=>{if(!hasSentenceIpa(S.segments[i]) && !S.segments[i]._ipaBusy)ensureIpa(i,true);};
  });
  renderOverlay();
}


return {
get WORD_RE(){return WORD_RE;},
get markWords(){return markWords;}, set markWords(value){markWords=value;},
get renderList(){return renderList;}, set renderList(value){renderList=value;},
get renderSeg(){return renderSeg;}, set renderSeg(value){renderSeg=value;},
get setActive(){return setActive;}, set setActive(value){setActive=value;},
get renderOverlay(){return renderOverlay;}, set renderOverlay(value){renderOverlay=value;},
get updateSubVisibility(){return updateSubVisibility;}, set updateSubVisibility(value){updateSubVisibility=value;}
};
});
