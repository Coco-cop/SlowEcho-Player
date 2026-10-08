/* Feature: export. See ARCHITECTURE.md for dependencies and contracts. */
EchoPlayer.define("export", () => {
'use strict';
/* ---------- 导出 ---------- */
function download(name, text) {
  const b = new Blob([text], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(b); a.download = name;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function exportSubtitle() {
  if (!S.segments.length) { toast("还没有字幕", true); return; }
  const srt = S.segments.map((s, i) =>
    `${i + 1}\n${fmtSrt(subStart(s))} --> ${fmtSrt(subEnd(s))}\n${s.text}\n`).join("\n");
  download((S.videoName.replace(/\.[^.]+$/, "") || "subtitle") + ".srt", srt);
  toast("已导出 SRT");
}
function exportVocab() {
  const arr = Array.from(VOCAB.values());
  if (!arr.length) { toast("生词本为空", true); return; }
  const tsv = ["word\tphonetic\tdefinition\texample\tcontext"]
    .concat(arr.map(v => [v.word, v.phonetic, v.defs.join(" | "), v.example, v.ctx].join("\t"))).join("\n");
  download("vocab-" + new Date().toISOString().slice(0, 10) + ".tsv", tsv);
  toast("已导出生词本（可直接导入 Anki）");
}


return {
get download(){return download;}, set download(value){download=value;},
get exportSubtitle(){return exportSubtitle;}, set exportSubtitle(value){exportSubtitle=value;},
get exportVocab(){return exportVocab;}, set exportVocab(value){exportVocab=value;}
};
});
