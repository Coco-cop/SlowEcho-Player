/* Feature: vocabulary. See ARCHITECTURE.md for dependencies and contracts. */
EchoPlayer.define("vocabulary", () => {
'use strict';
/* ---------- 生词本 ---------- */
function saveVocab() { LS.set("elp.vocab", Array.from(VOCAB.values())); renderVocab(); }
function toggleVocab(word, data, ctx) {
  if (VOCAB.has(word)) { VOCAB.delete(word); toast(`已移出生词本：${word}`); }
  else {
    VOCAB.set(word, {
      word,
      phonetic: data?.phonetic || "",
      defs: (data?.meanings || []).flatMap(m => m.defs.slice(0, 2).map(d => `${m.pos} ${d.def}`)).slice(0, 4),
      example: (data?.meanings || []).flatMap(m => m.defs).find(d => d.ex)?.ex || "",
      ctx: ctx || "",
      at: Date.now()
    });
    toast(`已加入生词本：${word}`);
  }
  saveVocab(); refreshWordClass(word);
}
function renderVocab() {
  const arr = Array.from(VOCAB.values()).sort((a, b) => b.at - a.at);
  $("#vocabCount").textContent = arr.length ? `(${arr.length})` : "";
  $("#vocabEmpty").hidden = arr.length > 0;
  $("#vocabList").innerHTML = arr.map(v => `
    <div class="vocab-item">
      <div class="vw">
        <b>${esc(v.word)}</b>
        <i>${esc(v.phonetic || "")}</i>
        <button data-w="${esc(v.word)}" title="移除">✕</button>
      </div>
      ${v.defs.length ? `<div class="vd">${v.defs.map(d => esc(d)).join("<br>")}</div>` : ""}
      ${v.example ? `<div class="vd" style="color:var(--tx3)">e.g. ${esc(v.example)}</div>` : ""}
      ${v.ctx ? `<div class="vc">${esc(v.ctx)}</div>` : ""}
    </div>`).join("");
  $$("#vocabList button[data-w]").forEach(b => b.onclick = () => {
    const w = b.dataset.w; VOCAB.delete(w); saveVocab(); refreshWordClass(w);
  });
}


return {
get saveVocab(){return saveVocab;}, set saveVocab(value){saveVocab=value;},
get toggleVocab(){return toggleVocab;}, set toggleVocab(value){toggleVocab=value;},
get renderVocab(){return renderVocab;}, set renderVocab(value){renderVocab=value;}
};
});
