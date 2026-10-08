/* Feature: library. See ARCHITECTURE.md for dependencies and contracts. */
EchoPlayer.define("library", () => {
'use strict';
/* ---------- 视频加载 ---------- */
const LIB = {key:null, revision:0, restoring:false, timer:0, signature:'', pending:false, writes:new Map()};
function libraryStatus(text) { const el=$('#libraryStatus'); if(el) el.textContent=text; }
// 固定抽样 192KB；普通 HTTP 与 file:// 使用完全相同的标识，不依赖安全上下文。
async function videoLibraryId(file) {
  const hashes=[2166136261,2246822519,3266489917,668265263];
  const mix=bytes=>{for(const b of bytes) for(let i=0;i<4;i++) hashes[i]=Math.imul(hashes[i]^b,16777619+i*2)>>>0;};
  mix(new TextEncoder().encode('elp-v1:'+file.size+':'));
  for(const start of [...new Set([0,Math.max(0,Math.floor(file.size/2)-32768),Math.max(0,file.size-65536)])])
    mix(new Uint8Array(await file.slice(start,start+65536).arrayBuffer()));
  return hashes.map(h=>h.toString(16).padStart(8,'0')).join('');
}
function libraryPayload() {
  return {videoName:S.videoName,segments:S.segments.map(s=>({start:s.start,end:s.end,text:s.text,zh:s.zh||'',ipa:s.ipa||'',words:s.words})),offset:S.offset||0};
}
function librarySchedule() {
  if(LIB.restoring || (!S.videoFile && !S.savedMedia) || !S.segments.length) return;
  LIB.pending=true;
  if(!LIB.timer) LIB.timer=setTimeout(()=>{LIB.timer=0;libraryFlush();},800);
}
function libraryFlush(force=false) {
  clearTimeout(LIB.timer);LIB.timer=0;
  if(!LIB.key || !S.segments.length || LIB.restoring) return Promise.resolve();
  const key=LIB.key, payload=libraryPayload(), signature=JSON.stringify(payload), token=S.videoToken;
  if(!force && signature===LIB.signature) return Promise.resolve();
  LIB.signature=signature;LIB.pending=false;
  let localOK=false;
  try {localStorage.setItem('elp.lesson.'+key,JSON.stringify({payload,unsynced:true}));localOK=true;} catch{}
  const current=()=>token===S.videoToken && key===LIB.key;
  if(!/^https?:$/.test(location.protocol)) {
    if(current()) libraryStatus(localOK?'仅保存到此浏览器（启动电脑服务可写入字幕库）':'保存失败：请导出 SRT 备份');
    return Promise.resolve();
  }
  if(current())libraryStatus('正在保存字幕…');
  const task=(LIB.writes.get(key)||Promise.resolve()).catch(()=>{}).then(async()=>{
    try {
      const r=await fetch('/api/library/'+key,{method:'POST',headers:{'X-EchoPlayer':'1','Content-Type':'application/json'},body:JSON.stringify(payload),signal:timeout(15000)});
      if(!r.ok)throw new Error('HTTP '+r.status);
      const cached=LS.get('elp.lesson.'+key,null);
      if(cached && JSON.stringify(cached.payload)===signature) {try{localStorage.setItem('elp.lesson.'+key,JSON.stringify({payload,unsynced:false}));}catch{}}
      if(current() && LIB.signature===signature)libraryStatus('已保存到电脑字幕库');
    } catch(e) {
      if(current() && LIB.signature===signature){LIB.signature='';LIB.pending=true;libraryStatus(localOK?'仅保存到此浏览器；电脑保存失败，点击重试':'保存失败，点击重试或导出 SRT');}
    }
  });
  LIB.writes.set(key,task);
  task.finally(()=>{if(LIB.writes.get(key)===task)LIB.writes.delete(key);});
  return task;
}
async function libraryRestore(file,token,revision) {
  libraryStatus('正在查找已保存字幕…');
  try {
    const key=await videoLibraryId(file);
    if(token!==S.videoToken)return;
    LIB.key=key;
    window.EchoPlayer.storage?.autoSave(file,key,token);
    window.EchoPlayer.modules.resume?.onKeyResolved(key,token);
    let cached=LS.get('elp.lesson.'+key,null), payload=cached?.payload, fromServer=false;
    if(/^https?:$/.test(location.protocol)) {
      try {
        const r=await fetch('/api/library/'+key,{signal:timeout(6000)});
        if(r.ok && !cached?.unsynced) {const data=await r.json();payload=data.lesson||data;fromServer=true;}
      } catch{}
    }
    if(token!==S.videoToken)return;
    if(revision!==LIB.revision || S.segments.length){librarySchedule();return;}
    if(payload && Array.isArray(payload.segments) && payload.segments.length) {
      LIB.restoring=true;
      try {loadSegments(payload.segments,true);S.offset=Number(payload.offset)||0;$('#offsetInput').value=S.offset;} finally{LIB.restoring=false;}
      LIB.signature=JSON.stringify(libraryPayload());
      if(fromServer) {try {localStorage.setItem('elp.lesson.'+key,JSON.stringify({payload:libraryPayload(),unsynced:false}));}catch{}}
      libraryStatus(fromServer?'已从电脑字幕库恢复':'已从浏览器恢复字幕');
      toast('已恢复 '+payload.segments.length+' 条字幕，无需重新识别');
      if(cached?.unsynced)libraryFlush(true);
    } else libraryStatus('尚无保存字幕，生成后自动保存');
  } catch(e){if(token===S.videoToken)libraryStatus('无法读取字幕缓存：'+e.message);}
}
$('#libraryStatus').onclick=()=>libraryFlush(true);
window.addEventListener('pagehide',()=>libraryFlush());
window.addEventListener('online',()=>libraryFlush(true));
function loadVideoFile(file) {
  libraryFlush();
  if (S.currentObjUrl) URL.revokeObjectURL(S.currentObjUrl);
  const url = URL.createObjectURL(file);
  S.currentObjUrl = url;
  S.savedMedia = null;
  S.videoName = file.name;
  S.videoFile = file;          // 供其它脚本（如离线学习包导出）取当前文件
  window.__currentVideoFile = file;
  S.videoToken++;              // 换视频：让在途的识别/轮询结果全部作废
  S.translating = false;
  LIB.key = null; LIB.revision++; LIB.signature = ''; LIB.pending = false;
  libraryRestore(file, S.videoToken, LIB.revision);
  cancelLocalJob(true);        // 顺手取消还没跑完的本机识别任务
  clearGapTimer();
  // 清掉上一部视频的字幕与当前状态，避免残留字幕套到新视频上
  S.segments = []; S.active = -1; S.loopLock = -1; S.offset = 0;
  $("#segList").innerHTML = "";
  $("#subsEmpty").hidden = false;
  const oi = $("#offsetInput"); if (oi) oi.value = "0";
  renderOverlay();
  const v = $("#video");
  // 换视频前摘掉旧句柄，否则连换几部视频会叠出一堆 timeupdate 监听
  if (S.posHandler) v.removeEventListener("timeupdate", S.posHandler);
  if (S.metaHandler) v.removeEventListener("loadedmetadata", S.metaHandler);
  v.src = url;
  v.load();
  $("#dropzone").classList.add("hide");
  $("#overlay").classList.remove("hidden");
  $("#statusBadge").textContent = file.name.length > 28 ? file.name.slice(0, 26) + "…" : file.name;
  // 记忆播放位置
  const key = "elp.pos." + file.name + "." + file.size;
  S.metaHandler = () => {
    $("#tDur").textContent = fmt(v.duration);
    const p = LS.get(key, 0);
    if (p > 5 && p < v.duration - 10) {
      v.currentTime = p;
      toast("已恢复到上次播放位置 " + fmt(p));
    }
  };
  v.addEventListener("loadedmetadata", S.metaHandler, { once: true });
  S.posHandler = () => LS.set(key, v.currentTime);
  v.addEventListener("timeupdate", S.posHandler);
}

/* ---------- 增量追加字幕（转写过程中边跑边出） ---------- */
function appendSegments(newOnes) {
  if (!newOnes.length) return;
  if (S.segments.length === 0) S.active = -1;
  S.segments = S.segments.concat(newOnes);
  $("#subsEmpty").hidden = true;
  renderList();
}
/* 在 target 附近 ±4 秒内找能量最低点作为切点，避免把单词切两半 */
function findQuietCut(a, target, SR) {
  const span = 4 * SR, step = Math.floor(SR / 25), win = Math.floor(SR / 25);
  const from = Math.max(0, target - span), to = Math.min(a.length - win - 1, target + span);
  let best = target, bestE = Infinity;
  for (let i = from; i < to; i += step) {
    let e = 0;
    for (let j = 0; j < win; j += 6) { const v = a[i + j] || 0; e += v * v; }
    if (e < bestE) { bestE = e; best = i; }
  }
  return best;
}

/* ---------- 加载字幕 ---------- */
function loadSegments(segs, silent) {
  if (!LIB.restoring) LIB.revision++;
  S.segments = segs;
  S.active = -1;
  S.loopLock = -1;
  S.offset = 0;
  const oi = $("#offsetInput"); if (oi) oi.value = "0";
  $("#subsEmpty").hidden = segs.length > 0;
  renderList();
  if (!silent) toast(`已载入 ${segs.length} 条字幕`);
  updateSubVisibility();
  if (S.settings.showIpa) fillSentenceIpas(30);   // 开关开着：新字幕也补美音音标
}
function loadSubtitleText(raw, name) {
  if (/\.json$/i.test(name || '') || /^\s*[\[{]/.test(raw)) {
    try {
      const data=JSON.parse(raw), items=Array.isArray(data)?data:data.segments;
      if(!Array.isArray(items))throw new Error('JSON 中缺少 segments 数组');
      const segs=items.map(s=>({start:Number(s.start),end:Number(s.end),text:String(s.text||''),zh:String(s.zh||''),ipa:String(s.ipa||''),words:s.words}))
        .filter(s=>Number.isFinite(s.start) && Number.isFinite(s.end) && s.end>s.start && s.text);
      if(!segs.length)throw new Error('没有有效的字幕时间轴');
      loadSegments(segs);
      S.offset=Number(data.offset)||0;$('#offsetInput').value=S.offset;librarySchedule();return;
    }catch(e){toast('字幕 JSON 无法导入：'+e.message,true);return;}
  }
  const segs = parseSubtitle(raw);
  if (!segs.length) {
    // 不是标准字幕 → 尝试当纯文本处理
    const v = $("#video");
    const segs2 = textToSegments(raw, v.duration);
    if (segs2.length) {
      loadSegments(segs2, true);
      toast(`未能识别时间轴，已按视频时长平均分配 ${segs2.length} 句（建议用 AI 生成字幕）`, true);
      return;
    }
    toast("字幕文件解析失败，请检查格式", true);
    return;
  }
  loadSegments(segs);
}


return {
get LIB(){return LIB;},
get libraryStatus(){return libraryStatus;}, set libraryStatus(value){libraryStatus=value;},
get videoLibraryId(){return videoLibraryId;}, set videoLibraryId(value){videoLibraryId=value;},
get libraryPayload(){return libraryPayload;}, set libraryPayload(value){libraryPayload=value;},
get librarySchedule(){return librarySchedule;}, set librarySchedule(value){librarySchedule=value;},
get libraryFlush(){return libraryFlush;}, set libraryFlush(value){libraryFlush=value;},
get libraryRestore(){return libraryRestore;}, set libraryRestore(value){libraryRestore=value;},
get loadVideoFile(){return loadVideoFile;}, set loadVideoFile(value){loadVideoFile=value;},
get appendSegments(){return appendSegments;}, set appendSegments(value){appendSegments=value;},
get findQuietCut(){return findQuietCut;}, set findQuietCut(value){findQuietCut=value;},
get loadSegments(){return loadSegments;}, set loadSegments(value){loadSegments=value;},
get loadSubtitleText(){return loadSubtitleText;}, set loadSubtitleText(value){loadSubtitleText=value;}
};
});
