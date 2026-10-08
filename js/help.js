/* Feature: help. See ARCHITECTURE.md for dependencies and contracts. */
EchoPlayer.define("help", () => {
'use strict';
/* 帮助 */
$("#btnHelp").onclick = () => {
  const d = document.createElement("div");
  d.className = "modal";
  d.innerHTML = `
  <div class="card">
    <h3>使用说明 & 快捷键</h3>
    <div class="sub">SlowEcho Player · 喜欢的视频，一句一句听懂</div>
    <div style="font-size:13px;line-height:1.95;color:var(--tx2)">
      <b style="color:var(--tx)">三步开始</b><br>
      1. 拖入视频（或点「打开视频」）<br>
      2. 拖入 <code>.srt/.vtt</code> 字幕；没有字幕就点「AI 生成字幕」，或用 README 里的离线脚本生成后导入<br>
      3. 点字幕里的任意单词 → 查释义 / 音标 / 发音 / 例句
      <div style="height:14px"></div>
      <b style="color:var(--tx)">快捷键</b><br>
      <kbd>空格</kbd> 播放/暂停 &nbsp; <kbd>←</kbd> <kbd>→</kbd> 上一句 / 下一句<br>
      <kbd>R</kbd> 重复本句 &nbsp; <kbd>L</kbd> 单句循环 &nbsp; <kbd>↑</kbd> <kbd>↓</kbd> 倍速<br>
      <kbd>S</kbd> 显示/隐藏英文 &nbsp; <kbd>V</kbd> 显示/隐藏中文 &nbsp; <kbd>Esc</kbd> 关闭卡片
      <div style="height:14px"></div>
      <b style="color:var(--tx)">字幕里的下划线</b><br>
      <span style="border-bottom:2px solid var(--warn);color:var(--warn)">橙色实线</span> = 已加入生词本 &nbsp;
      <span style="border-bottom:1px dotted var(--ok);color:var(--ok)">绿色虚线</span> = 查过的词
    </div>
    <div class="actions"><button class="btn primary" data-a="ok">知道了</button></div>
  </div>`;
  document.body.appendChild(d);
  d.querySelector('[data-a="ok"]').onclick = () => d.remove();
  d.onclick = e => { if (e.target === d) d.remove(); };
};


return {

};
});
