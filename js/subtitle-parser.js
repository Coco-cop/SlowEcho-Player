/* Feature: subtitle-parser. See ARCHITECTURE.md for dependencies and contracts. */
EchoPlayer.define("subtitle-parser", () => {
'use strict';
/* ---------- 字幕解析 ---------- */
function cleanText(t) {
  return String(t)
    .replace(/\{\\?[^}]*\}/g, "")               // 去除 {\an8} 之类的 ASS 标签
    .replace(/<\/?[^>]+>/g, "")                  // 去除 <i> <font> 等 HTML
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .trim();
}
function tcToSec(s) {
  s = s.trim().replace(",", ".");
  const m = s.match(/(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return NaN;
  return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
}
/** 解析 SRT / VTT，返回 [{start,end,text}] */
function parseSubtitle(raw) {
  const text = String(raw).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const out = [];
  const blocks = text.split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").filter(l => l.trim() !== "");
    if (!lines.length) continue;
    let ti = lines.findIndex(l => l.includes("-->"));
    if (ti === -1) continue;
    const tm = lines[ti].match(/([^\n]*?)\s*-->\s*([^\n]*)/);
    if (!tm) continue;
    const start = tcToSec(tm[1]);
    const end = tcToSec(tm[2].split(/\s+/)[0]);
    if (!isFinite(start)) continue;
    const bodyLines = lines.slice(ti + 1).map(cleanText).filter(x => x);
    if (!bodyLines.length) continue;
    // 双语字幕识别：末行含中日韩文字时，视为中文译文（这样外部生成的双语 SRT 拖进来就能直接对照）
    let en = bodyLines.join(" "), zh = "";
    if (bodyLines.length >= 2) {
      const last = bodyLines[bodyLines.length - 1];
      if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(last) && !/[\u4e00-\u9fff]/.test(bodyLines[0])) {
        zh = last;
        en = bodyLines.slice(0, -1).join(" ");
      }
    }
    if (!en) continue;
    // 跳过纯音效/音乐标记
    if (/^[\[(](music|applause|laughter|sound)[)\]]?/i.test(en) && en.length < 24) continue;
    const item = { start, end: isFinite(end) && end > start ? end : start + 3, text: en };
    if (zh) item.zh = zh;
    out.push(item);
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}
/** 无时间轴纯文本 → 按视频时长平均分配 */
function textToSegments(txt, duration) {
  const lines = String(txt).replace(/\r\n?/g, "\n").split("\n")
    .map(l => cleanText(l)).filter(l => l.length > 1);
  const sentences = [];
  for (const l of lines) {
    // 一行可能包含多句，按句末标点再切
    const parts = l.split(/(?<=[.!?])\s+(?=[A-Z"'])/);
    for (const p of parts) if (p.trim()) sentences.push(p.trim());
  }
  if (!sentences.length) return [];
  const total = duration && isFinite(duration) && duration > 1 ? duration : sentences.length * 3;
  const each = total / sentences.length;
  return sentences.map((t, i) => ({
    start: +(i * each).toFixed(2),
    end: +Math.min(total, (i + 1) * each).toFixed(2),
    text: t
  }));
}


return {
get cleanText(){return cleanText;}, set cleanText(value){cleanText=value;},
get tcToSec(){return tcToSec;}, set tcToSec(value){tcToSec=value;},
get parseSubtitle(){return parseSubtitle;}, set parseSubtitle(value){parseSubtitle=value;},
get textToSegments(){return textToSegments;}, set textToSegments(value){textToSegments=value;}
};
});
