/* Feature: subtitle-tools. See ARCHITECTURE.md for dependencies and contracts. */
EchoPlayer.define("subtitle-tools", () => {
'use strict';
/* 字幕文本润色和翻译；语音识别由 recognition.js 调用电脑服务。 */
let asrLog = "";
let subtitleKeyResult = null;
function logLine(t) {
  asrLog += t + "\n";
  const el = $("#asrLog");
  if (el) { el.innerHTML = asrLog.replace(/</g, "&lt;"); el.scrollTop = el.scrollHeight; }
}
const subtitleOffline = () => !!document.querySelector('meta[name="echoplayer-offline"]');
function subtitleWorkflowTabs(active) {
  return `<div class="subtitle-workflows" role="group" aria-label="字幕处理方式">${[['import','导入字幕'],['generate','生成字幕'],['existing','优化字幕']].map(([mode,label])=>`<button class="btn" data-a="${mode}" aria-pressed="${mode===active}" ${(mode==='existing'&&!S.segments.length)||(mode!=='import'&&subtitleOffline())?'disabled':''}>${label}</button>`).join('')}</div>`;
}
function subtitleKeyField() {
  if(subtitleOffline())return '';
  return `<div class="field subtitle-key"><label for="subtitleKey">DeepSeek API Key</label><div class="subtitle-key-row"><input type="password" id="subtitleKey" placeholder="填写 Key，保存后自动测试连接" autocomplete="off" spellcheck="false"><button class="btn" data-a="save-key">保存并测试</button></div><label class="subtitle-option"><input type="checkbox" id="subtitleNet">允许联网检查与润色</label><div class="hint" id="subtitleKeyStatus" role="status"></div></div>`;
}
function subtitleKeyFeedback(d,message,state='idle') {
  const status=d.querySelector('#subtitleKeyStatus');
  if(status){status.textContent=message;status.dataset.state=state;}
}
function refreshSubtitleKeyStatus(d) {
  const status=d.querySelector('#subtitleKeyStatus');
  if(!status)return;
  const previous=subtitleKeyResult?.key===S.settings.dsKey&&subtitleKeyResult?.model===(S.settings.dsModel||'deepseek-flash')?subtitleKeyResult:null;
  const message=!S.settings.net?'设置已保存，联网已关闭，未测试连接。':!S.settings.dsKey?'尚未设置 Key。填写后点击“保存并测试”；留空保存可清除 Key。':previous?previous.message:'Key 已保存，尚未验证；点击“保存并测试”验证连接。';
  subtitleKeyFeedback(d,message,S.settings.net&&previous?previous.state:'idle');
  const hint=d.querySelector('#lasPolishHint');
  if(hint)hint.textContent=!S.settings.net?'联网已关闭，将保留识别原文。':S.settings.dsKey?'识别完成后自动检查润色。':'未设置 Key，将先保留识别原文。';
}
function setSubtitleDialogBusy(d,busy) {
  d.dataset.busy=String(busy);
  if(busy)d.cancelKeyTest?.();
  d.querySelectorAll('.subtitle-workflows button,.subtitle-key input,.subtitle-key button').forEach(el=>el.disabled=busy);
  if(!busy)d.querySelector('[data-a="existing"]').disabled=!S.segments.length||subtitleOffline();
}
function bindSubtitleDialog(d,mode) {
  for(const old of document.querySelectorAll('.modal[data-subtitle-tools]')) {
    if(old===d)continue;
    if(old.dataset.busy==='true'){d.remove();toast('字幕正在处理中，请等待完成或先取消',true);return false;}
    old.closeDialog?old.closeDialog():old.remove();
  }
  d.dataset.subtitleTools='true';d.dataset.mode=mode;
  d.closeDialog=()=>{d.cancelKeyTest?.();d.remove();};
  d.querySelectorAll('.subtitle-workflows [data-a]').forEach(button=>button.onclick=()=>{
    if(d.dataset.busy==='true'||button.dataset.a===mode)return;
    d.closeDialog?d.closeDialog():d.remove();openSubtitleTools(button.dataset.a);
  });
  const input=d.querySelector('#subtitleKey'),net=d.querySelector('#subtitleNet');
  if(!input)return true;
  input.value=S.settings.dsKey||'';net.checked=!!S.settings.net;
  refreshSubtitleKeyStatus(d);
  const save=d.querySelector('[data-a="save-key"]');
  let testSequence=0,testController=null;
  const cancelTest=()=>{testSequence++;testController?.abort();testController=null;save.textContent='保存并测试';save.disabled=d.dataset.busy==='true';};
  d.cancelKeyTest=cancelTest;
  const unsaved=()=>{cancelTest();subtitleKeyFeedback(d,'尚未保存，请点击“保存并测试”使更改生效。');};
  input.oninput=net.onchange=unsaved;
  save.onclick=async()=>{
    cancelTest();
    const next={...S.settings,dsKey:input.value.trim(),net:net.checked};
    try{localStorage.setItem('elp.settings',JSON.stringify(next));}
    catch{subtitleKeyFeedback(d,'保存失败：浏览器无法写入本地设置。输入内容仍保留，请重试。','error');return;}
    Object.assign(S.settings,next);input.value=next.dsKey;
    TR_PROVIDER=null;
    S.segments.forEach(s=>{s._ipaRetryAt=0;s._ipaError='';});
    subtitleKeyResult=null;
    refreshSubtitleKeyStatus(d);
    if(!next.dsKey){toast('Key 已清除');return;}
    if(!next.net){toast('Key 已保存，联网已关闭，未测试连接');return;}
    const sequence=++testSequence,model=next.dsModel||'deepseek-flash';
    const controller=new AbortController();testController=controller;
    save.disabled=true;save.textContent='测试中…';
    subtitleKeyFeedback(d,'Key 已保存，正在测试 DeepSeek 连接…','testing');
    const current=()=>d.isConnected&&sequence===testSequence&&S.settings.dsKey===next.dsKey&&S.settings.net&&(S.settings.dsModel||'deepseek-flash')===model;
    try {
      const result=await testDeepSeekConnection(next.dsKey,model,controller.signal);
      if(!current())return;
      const message='✓ 连接成功，Key 可用。模型：'+result.model;
      subtitleKeyResult={key:next.dsKey,model,state:'success',message};
      subtitleKeyFeedback(d,message,'success');toast('DeepSeek 连接成功');
    } catch(e) {
      if(!current())return;
      const message='✗ 连接测试失败：'+e.message+'。Key 已保存，可修改后重试。';
      subtitleKeyResult={key:next.dsKey,model,state:'error',message};
      subtitleKeyFeedback(d,message,'error');
    } finally {if(sequence===testSequence){testController=null;save.textContent='保存并测试';save.disabled=d.dataset.busy==='true';}}
  };
  return true;
}
function openSubtitleTools(mode='import') {
  if(mode==='generate')return openLocalAsrDialog();
  if(mode==='existing')return openAsrDialog();
  const d=document.createElement('div');d.className='modal';d.id='subtitleImportModal';
  d.innerHTML=`<div class="card"><h3>字幕工具</h3>${subtitleWorkflowTabs('import')}${subtitleKeyField()}<div class="subtitle-import"><p>导入已有字幕，或切换到生成、优化字幕。</p><button class="btn primary" data-a="pick-subtitle">选择字幕文件</button><p class="hint">支持 SRT / VTT / ASS / TXT / JSON；导入后可在“优化字幕”中检查润色。</p></div><div class="actions"><button class="btn" data-a="close">关闭</button></div></div>`;
  document.body.append(d);
  if(!bindSubtitleDialog(d,'import'))return;
  d.querySelector('[data-a="pick-subtitle"]').onclick=()=>$('#fileSub').click();
  d.querySelector('[data-a="close"]').onclick=()=>d.closeDialog();
  d.onclick=e=>{if(e.target===d)d.closeDialog();};
}
function openAsrDialog() {
  const d=document.createElement('div');d.className='modal';d.id='asrModal';
  d.innerHTML=`<div class="card"><h3>字幕工具</h3>
  ${subtitleWorkflowTabs('existing')}${subtitleKeyField()}
  <p>默认用 DeepSeek 检查标点并润色英文，保留字幕时间轴。只发送字幕文本。</p>
  <label class="subtitle-option"><input type="checkbox" id="subtitlePolish" ${S.settings.dsPolish===false?'':'checked'}> DeepSeek 检查与润色</label>
  <label class="subtitle-option"><input type="checkbox" id="subtitleTranslate"> 同时翻译中文</label>
  <div class="log" id="asrLog">已载入 ${S.segments.length} 条字幕。</div><div class="progress-bar"><i id="asrBar"></i></div>
  <div class="actions"><button class="btn" data-a="close">关闭</button><button class="btn primary" data-a="b-run">开始优化</button></div></div>`;
  document.body.append(d);
  if(!bindSubtitleDialog(d,'existing'))return;
  d.querySelector('[data-a="b-run"]').onclick=()=>{
    const polish=d.querySelector('#subtitlePolish').checked, trans=d.querySelector('#subtitleTranslate').checked;
    if (!polish&&!trans) { toast('请选择检查润色或翻译中文',true); return; }
    return runDeepSeekJob(d,polish?(trans?'both':'polish'):'trans');
  };
  d.querySelector('[data-a="close"]').onclick=()=>d.closeDialog();
  d.onclick=e=>{if(e.target===d)d.closeDialog();};
}

/** 用 DeepSeek 给识别结果补标点、断句。
    Whisper（尤其 base）对英文标点支持很差，常吐出一整段没有句号的跑句，
    单句循环根本没法用。这一步能显著改善，且不改动词句。 */
async function polishSegments(segs, onProgress, shouldContinue = () => true) {
  const BATCH = 20;
  const texts = segs.map(s => s.text);
  const out = texts.slice();
  for (let k = 0; k < texts.length; k += BATCH) {
    if (!shouldContinue()) throw new Error('处理已取消');
    const part = texts.slice(k, k + BATCH);
    try {
      const raw = await dsChat(DS_POLISH_SYS, part.map((t, i) => `[${i + 1}] ${t}`).join("\n"));
      const res = parseNumbered(raw, part.length);
      res.forEach((t, i) => { if (t && t.trim()) out[k + i] = t.trim(); });
      onProgress && onProgress(`第 ${Math.floor(k / BATCH) + 1} 批完成（${Math.min(k + BATCH, texts.length)}/${texts.length}）`);
    } catch (e) {
      onProgress && onProgress("该批润色失败，保留原文：" + e.message);
    }
  }
  return segs.map((s,i)=>{
    const item={...s,text:out[i]};
    if(out[i]!==s.text){delete item.ipa;delete item.zh;}
    if(s.text.toLowerCase().replace(/[^a-z0-9']/g,'')!==out[i].toLowerCase().replace(/[^a-z0-9']/g,''))delete item.words;
    return item;
  });
}

/** 方案 B 的执行入口：对「已载入的字幕」跑 DeepSeek 润色 / 翻译。
    mode: polish | trans | both
    本项目的 DeepSeek 请求只发送字幕文字，不发送音频。 */
async function runDeepSeekJob(dlg, mode) {
  const dsToken=S.videoToken, dsSegments=S.segments;
  if (!S.segments.length) {
    toast("还没有字幕，请先生成或导入字幕", true);
    return;
  }
  if (!S.settings.dsKey) {
    toast("请在此窗口填写并保存 DeepSeek API Key", true);

    dlg.querySelector("#subtitleKey").focus();
    return;
  }
  if (!S.settings.net) { toast("已在设置中关闭联网功能", true); return; }

  const btns = dlg.querySelectorAll('[data-a^="b-"],[data-a="generate"],[data-a="settings"],input');
  btns.forEach(b => { b.disabled = true; });
  setSubtitleDialogBusy(dlg,true);
  const bar = dlg.querySelector("#asrBar");
  asrLog = "";

  const jobName = mode === "polish" ? "修复标点断句"
    : mode === "trans" ? "翻译成中文" : "润色 + 翻译";
  logLine(jobName + "，共 " + S.segments.length + " 条");
  let partialFailure = false;

  try {
    if (mode === "polish" || mode === "both") {
      logLine("· 修复标点与断句…");
      const polished = await polishSegments(S.segments, m => {
        logLine("  " + m);
        if(m.includes('失败'))partialFailure=true;
        bar.style.width = "45%";
      },()=>dlg.isConnected&&dsToken===S.videoToken&&dsSegments===S.segments);
      if(dsToken!==S.videoToken || dsSegments!==S.segments || !dlg.isConnected)return;
      polished.forEach((s, i) => { if (s.text && S.segments[i].text!==s.text) {
        S.segments[i].text=s.text; delete S.segments[i].ipa; delete S.segments[i].zh;
        if(s.words)S.segments[i].words=s.words;else delete S.segments[i].words;
        S.segments[i]._ipaRetryAt=0;
      } });
      renderList();
      logLine(partialFailure ? "  部分润色未完成，已保留对应原文" : "  ✓ 标点断句已修复");
    }
    if (mode === "trans" || mode === "both") {
      logLine("· 翻译成中文…");
      const todo = [];
      S.segments.forEach((s, i) => { if (!s.zh) todo.push(i); });
      const BATCH = 20;
      for (let k = 0; k < todo.length; k += BATCH) {
        const idxs = todo.slice(k, k + BATCH);
        try {
          const res = await trDeepSeekBatch(idxs.map(i => S.segments[i].text));
          if(dsToken!==S.videoToken || dsSegments!==S.segments || !dlg.isConnected)return;
          const hit = idxs.filter((i, n) => res[n]).length;
          idxs.forEach((i, n) => {
            if (res[n]) { S.segments[i].zh = res[n]; trSaveCache(S.segments[i].text.trim(), res[n]); renderSeg(i); }
          });
          logLine("  第 " + (Math.floor(k / BATCH) + 1) + " 批完成（" + Math.min(k + BATCH, todo.length) + "/" + todo.length + "，成功 " + hit + "）");
          bar.style.width = (45 + Math.round(55 * (k + idxs.length) / Math.max(1, todo.length))) + "%";
        } catch (e) {
          partialFailure = true;
          logLine("  ! 该批失败：" + e.message);
          if (/401|密钥|Key/i.test(e.message)) { toast("API Key 无效或已失效", true); break; }
        }
      }
      updateSubVisibility();
      logLine("  ✓ 翻译完成");
    }
    bar.style.width = "100%";
    if(dsToken!==S.videoToken || dsSegments!==S.segments || !dlg.isConnected)return;
    await libraryFlush(true);
    logLine(partialFailure ? "部分处理未完成，原文已保留；请查看日志后重试" : "✓ 全部完成");
    toast(partialFailure ? "部分处理失败，原文已保留" : "已用 DeepSeek " + jobName, partialFailure);
  } catch (e) {
    logLine("✗ 失败：" + (e && e.message));
    toast("处理失败，详见日志", true);
  } finally {
    btns.forEach(b => { b.disabled = false; });
    setSubtitleDialogBusy(dlg,false);
  }
}

/** 设置面板是内联写的，这里做个桥接，方便别处复用（比如方案 B 的「填 Key」按钮） */
function openSettings() { $("#btnSettings").click(); }

return {
get openSubtitleTools(){return openSubtitleTools;},
get subtitleWorkflowTabs(){return subtitleWorkflowTabs;},
get subtitleKeyField(){return subtitleKeyField;},
get bindSubtitleDialog(){return bindSubtitleDialog;},
get setSubtitleDialogBusy(){return setSubtitleDialogBusy;},
get asrLog(){return asrLog;}, set asrLog(value){asrLog=value;},
get logLine(){return logLine;}, set logLine(value){logLine=value;},
get openAsrDialog(){return openAsrDialog;}, set openAsrDialog(value){openAsrDialog=value;},
get polishSegments(){return polishSegments;}, set polishSegments(value){polishSegments=value;},
get runDeepSeekJob(){return runDeepSeekJob;}, set runDeepSeekJob(value){runDeepSeekJob=value;},
get openSettings(){return openSettings;}, set openSettings(value){openSettings=value;}
};
});
