/* Feature: recognition. See ARCHITECTURE.md for dependencies and contracts. */
EchoPlayer.define("recognition", () => {
'use strict';
/* ============================================================
   电脑识别字幕（本机识别服务）
   手机的算力跑不动 Whisper，所以把视频临时发到同一台电脑上识别。
   后端契约（由电脑端服务实现，前端只碰同源相对路径）：
     GET    /api/status              -> {available,recognizer,busy}
     POST   /api/transcribe?model=X  原始视频字节 -> 202 {id}
     GET    /api/jobs/{id}           -> {status,progress,message,segments,error}
     DELETE /api/jobs/{id}           取消并删除
   写操作都带 X-EchoPlayer: 1，避免被别的站点顺手触发。
   ============================================================ */
const LOCAL_MODELS = {
  tiny: "tiny（最快，精度最低）",
  base: "base（推荐，均衡）",
  small: "small（更准，更慢）"
};
let localBusy = false;
let localPollTimer = 0;

function localHeaders(extra) {
  return Object.assign({ "X-EchoPlayer": "1" }, extra || {});
}
async function localJson(path, opt) {
  const r = await fetch(path, opt);
  let j = null;
  try { j = await r.json(); } catch {}
  return { ok: r.ok, status: r.status, j };
}
function localErrText(payload, status) {
  const m = (payload && (payload.message || payload.error)) || "";
  if (status === 404) return "识别服务不可用（HTTP 404）：请确认电脑上已启动识别服务，且手机和电脑连的是同一个 Wi-Fi。";
  if (status === 501 || /模型|下载|依赖|安装|model|download|package|install/i.test(m)) {
    return "电脑上的识别服务缺少模型或依赖：" + (m || "请在电脑上完成安装/模型下载后重试");
  }
  return m || ("识别服务返回错误（HTTP " + status + "）");
}
// 取消本机识别：作废请求序号、清定时器、通知服务端删除任务与临时文件。
// silent=true 用于"换视频"这种用户没主动点取消的场景。
function cancelLocalJob(silent) {
  S.localSeq++;
  if (localPollTimer) { clearTimeout(localPollTimer); localPollTimer = 0; }
  const id = S.localJobId;
  S.localJobId = null;
  localBusy = false;
  if (id) fetch("/api/jobs/" + encodeURIComponent(id), { method: "DELETE", headers: localHeaders() }).catch(() => {});
  if (!silent) toast("已取消电脑识别");
}

async function openLocalAsrDialog() {
  const d = document.createElement("div");
  d.className = "modal"; d.id = "localAsrModal";
  d.innerHTML = `
  <div class="card">
    <h3>字幕工具</h3>
    ${subtitleWorkflowTabs('generate')}${subtitleKeyField()}
    <div class="sub">先识别视频，再默认用 DeepSeek 检查并润色英文。识别在本机完成；DeepSeek 只接收字幕文本。点击「生成字幕」后才会开始处理。</div>
    <div class="pane-note" id="lasStatus">正在连接电脑上的识别服务…</div>
    <div class="field">
      <p class="hint">自动按词间停顿和意群分成短句，通常每段约 3～6 秒，最多约 18 个词。</p><label>模型</label>
      <select id="lasModel">${Object.entries(LOCAL_MODELS).map(([k, v]) => `<option value="${k}"${k === "base" ? " selected" : ""}>${v}</option>`).join("")}</select>
      <div class="hint">默认 <b>base</b>，英语精听够用。电脑较慢或第一次要下载模型时可先选 <b>tiny</b> 试跑。</div>
    </div>
    <label class="subtitle-option"><input type="checkbox" id="lasPolish" ${S.settings.dsPolish===false?'':'checked'}> DeepSeek 检查与润色</label>
    <p class="hint" id="lasPolishHint">${!S.settings.net?'联网功能已关闭，将保留识别原文。':S.settings.dsKey?'识别完成后自动检查润色。':'未设置 DeepSeek Key，将先保留识别原文；填写 Key 后可在这里优化已有字幕。'}</p>
    <label class="subtitle-option"><input type="checkbox" id="lasTranslate"> 同时翻译中文</label>
    <div class="log" id="lasLog">就绪。点击「生成字幕」。</div>
    <div class="progress-bar"><i id="lasBar"></i></div>
    <div class="actions">
      <button class="btn" data-a="cancel" hidden>取消识别</button>
      <button class="btn" data-a="close">关闭</button>
      <button class="btn primary" data-a="run">生成字幕</button>
    </div>
  </div>`;
  document.body.appendChild(d);
  if(!bindSubtitleDialog(d,'generate'))return;
  const $d = s => d.querySelector(s);
  const logEl = $d("#lasLog"), barEl = $d("#lasBar");
  const log = t => { logEl.textContent = t; logEl.scrollTop = logEl.scrollHeight; };
  const bar = p => { barEl.style.width = Math.max(0, Math.min(100, p || 0)) + "%"; };
  const idle = () => {
    localBusy = false;
    $d('[data-a="run"]').disabled = false;
    $d('[data-a="cancel"]').hidden = true;
    setSubtitleDialogBusy(d,false);
    $d('#lasModel').disabled = $d('#lasPolish').disabled = $d('#lasTranslate').disabled = false;
  };

  const close = () => { d.cancelKeyTest?.();if (localBusy) cancelLocalJob(true); d.remove(); };
  d.closeDialog = close;
  $d('[data-a="close"]').onclick = close;
  d.onclick = e => { if (e.target === d) close(); };
  $d('[data-a="cancel"]').onclick = () => {
    cancelLocalJob();
    idle();
    bar(0);
    log("已取消，电脑上的临时文件已请求删除。");
  };
  $d('[data-a="run"]').onclick = async () => {
    const file = S.videoFile;
    const savedKey=S.savedMedia?.key;
    if (!file&&!savedKey) { toast("请先打开视频，再生成字幕", true); return; }
    if (localBusy) { toast("已有一个识别任务在跑，等它结束或先点「取消识别」", true); return; }
    const model = $d("#lasModel").value;
    const token = S.videoToken;
    const seq = ++S.localSeq;
    localBusy = true;
    $d('[data-a="run"]').disabled = true;
    $d('[data-a="cancel"]').hidden = false;
    setSubtitleDialogBusy(d,true);
    $d('#lasModel').disabled = $d('#lasPolish').disabled = $d('#lasTranslate').disabled = true;
    bar(2);
    log(savedKey?'正在直接读取电脑上的原视频…':"正在把视频（" + (file.size / 1048576).toFixed(1) + " MB）临时发送到这台电脑…\n上传期间请保持页面在前台，别切走。");
    try {
      if(!LIB.key) {
        const key=await videoLibraryId(file);
        if(token!==S.videoToken || seq!==S.localSeq)return;
        LIB.key=key;
    window.EchoPlayer.storage?.autoSave(file,key,token);
      }
      const r = await fetch("/api/transcribe?model=" + encodeURIComponent(model)+(savedKey?'&key='+encodeURIComponent(savedKey):''), {
        method: "POST",
        headers: localHeaders({
          "Content-Type": "application/octet-stream",
          "X-Filename": encodeURIComponent(file?.name||S.videoName)
          ,"X-Video-Id": LIB.key
        }),
        body: savedKey?'{}':file
      });
      let j = null; try { j = await r.json(); } catch {}
      if (seq !== S.localSeq) return;                 // 已被取消 / 已换视频
      if (!r.ok || !j || !j.id) {
        idle(); bar(0);
        log("✗ " + localErrText(j, r.status));
        toast("电脑识别失败，请查看日志，或换 tiny 模型重试", true);
        return;
      }
      S.localJobId = j.id;
      bar(6);
      log("任务已提交（" + j.id + "），等待识别…");
      poll();
    } catch (e) {
      if (seq !== S.localSeq) return;
      idle(); bar(0);
      log("✗ 连不上电脑上的识别服务：" + (e && e.message ? e.message : e) +
          "\n请确认服务已启动，且手机和电脑在同一个网络。");
    }
  };

  async function poll() {
    const seq = S.localSeq, id = S.localJobId, token = S.videoToken;
    if (!id) return;
    let res;
    try {
      res = await localJson("/api/jobs/" + encodeURIComponent(id));
    } catch {
      if (seq !== S.localSeq) return;
      localPollTimer = setTimeout(poll, 2500);        // 网络抖动：退避重试
      return;
    }
    if (seq !== S.localSeq || token !== S.videoToken) return;   // 陈旧结果，直接丢弃
    const { ok, status, j } = res;
    if (!ok || !j) {
      idle(); bar(0);
      log("✗ " + localErrText(j, status));
      return;
    }
    if (typeof j.progress === "number") bar(j.progress);
    if (j.message) log("… " + j.message + "（" + Math.round(j.progress || 0) + "%）");
    if (j.status === "done") {
      const raw = Array.isArray(j.segments) ? j.segments : [];
      const segs = raw
        .map(s => ({ start: +s.start, end: +s.end, text: String(s.text == null ? "" : s.text).trim(), words:s.words }))
        .filter(s => s.text && isFinite(s.start))
        .map(s => ({ start: s.start, end: isFinite(s.end) && s.end > s.start ? s.end : s.start + 3, text: s.text, words:s.words }));
      S.localJobId = null;
      bar(100);
      if (!segs.length) { idle(); log("✓ 识别完成，但服务没有返回字幕内容。"); toast("识别完成，但没有字幕内容", true); return; }
      let note = '';
      try {
      loadSegments(segs, true);
      await libraryFlush(true);
      if(seq!==S.localSeq || token!==S.videoToken)return;
      if($d('#lasPolish').checked && S.settings.dsKey && S.settings.net) {
        log('英文字幕已保存，正在用 DeepSeek 检查润色…');
        const before=S.segments;
        try {
          const polished=await polishSegments(before,m=>{log(m);if(m.includes('失败'))note='部分润色未完成，已保留对应原文。';},()=>seq===S.localSeq&&token===S.videoToken&&d.isConnected);
          if(seq!==S.localSeq || token!==S.videoToken || S.segments!==before)return;
          loadSegments(polished,true);await libraryFlush(true);
        } catch(e){note='DeepSeek 润色失败，已保留英文原文：'+e.message;log(note);}
      } else if($d('#lasPolish').checked) {note=S.settings.net?'未设置 DeepSeek Key，已跳过润色并保留识别原文。':'联网功能已关闭，已跳过润色并保留识别原文。';}
      if(seq!==S.localSeq || token!==S.videoToken)return;
      if($d('#lasTranslate').checked) {await translateAll();await libraryFlush(true);}
      if(seq!==S.localSeq || token!==S.videoToken)return;
      log("✓ 已载入 " + segs.length + " 条字幕。" + (note?'\n'+note:''));
      toast("已生成 " + segs.length + " 条字幕" + (note?'；'+note:''));
      } catch(e) {log('字幕已识别，后续处理未完成：'+e.message);}
      finally {if(seq===S.localSeq && token===S.videoToken)idle();}
    } else if (j.status === "error") {
      S.localJobId = null;
      idle(); bar(0);
      log("✗ " + localErrText(j, 500));
    } else {
      localPollTimer = setTimeout(poll, 1200);
    }
  }

  // 打开时先探一下服务状态，把"能不能用"直接说清楚
  (async () => {
    const st = $d("#lasStatus");
    let bad = false, txt = "";
    try {
      const { ok, j } = await localJson("/api/status");
      if (ok && j && j.available && j.recognizer) {
        txt = j.busy
          ? "识别服务在线，正在处理其他任务。点击「生成字幕」可排队。"
          : "识别服务在线。点击「生成字幕」开始处理；临时上传的素材会在识别后删除。";
      } else {
        bad = true;
        txt = "⚠ 电脑上的识别服务不可用。请先在电脑上启动识别服务，并确认手机和电脑连的是同一个 Wi-Fi。\n也可以导入已有 SRT / VTT 字幕。";
      }
    } catch {
      bad = true;
      txt = "⚠ 连不上电脑上的识别服务（同一 Wi-Fi 下才能用）。\n请确认电脑端服务已启动；也可以导入已有 SRT / VTT 字幕。";
    }
    if (!d.isConnected) return;
    st.textContent = txt;
    if (bad) {
      st.style.background = "rgba(242,181,68,.12)";
      st.style.borderColor = "rgba(242,181,68,.4)";
    }
  })();
}


return {
get LOCAL_MODELS(){return LOCAL_MODELS;},
get localBusy(){return localBusy;}, set localBusy(value){localBusy=value;},
get localPollTimer(){return localPollTimer;}, set localPollTimer(value){localPollTimer=value;},
get localHeaders(){return localHeaders;}, set localHeaders(value){localHeaders=value;},
get localJson(){return localJson;}, set localJson(value){localJson=value;},
get localErrText(){return localErrText;}, set localErrText(value){localErrText=value;},
get cancelLocalJob(){return cancelLocalJob;}, set cancelLocalJob(value){cancelLocalJob=value;},
get openLocalAsrDialog(){return openLocalAsrDialog;}, set openLocalAsrDialog(value){openLocalAsrDialog=value;}
};
});
