/* Shared local file library. Videos stream directly to/from the PC; no whole-file ArrayBuffer. */
(() => {
  'use strict';
  let config=null;
  const uploads=new Map();
  async function request(path,body) {
    if(!/^https?:$/.test(location.protocol))throw new Error('请通过 start-player.bat 启动播放器后使用电脑文件库');
    const response=await fetch(path,body===undefined?{}:{method:'POST',headers:{'X-EchoPlayer':'1','Content-Type':'application/json'},body:JSON.stringify(body)});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||'HTTP '+response.status);
    return data;
  }
  async function refreshConfig(){config=await request('/api/storage/config');return config;}
  /** 打开「导入视频时也自动保存视频」。只有本机能改目录配置，手机端调用会被服务拒绝。 */
  async function enableVideoAutoSave(){
    const current=await refreshConfig();
    config=await request('/api/storage/config',{directory:current.directory,autoSaveVideo:true});
    return config;
  }
  async function autoSave(file,key,token) {
    try {
      if(!file || !key || uploads.has(key))return;
      // Startup continuation needs durable media, even when subtitle-only storage was configured.
      if(S.settings.autoResume===false && !(await refreshConfig()).autoSaveVideo)return;
      try {
        const index=await request('/api/library-index');
        if((index.lessons||[]).some(e=>e.key===key&&e.hasVideo))return;
      } catch {} // Index is only an optimization; an unavailable index must not prevent saving.
      if(token===S.videoToken)libraryStatus('正在保存续播视频，请等保存完成后关闭页面…');
      await saveVideo(file,key,token);
    } catch(error){if(token===S.videoToken)libraryStatus('视频保存未完成：'+error.message+'；可在文件库重试');}
  }
  function saveVideo(file,key,token=S.videoToken) {
    if(uploads.has(key))return uploads.get(key);
    const task=new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();
      xhr.open('POST','/api/library-media/'+key+'?name='+encodeURIComponent(file.name));
      xhr.setRequestHeader('X-EchoPlayer','1');
      xhr.setRequestHeader('Content-Type','application/octet-stream');
      xhr.timeout=30*60*1000;
      xhr.upload.onprogress=e=>{if(token===S.videoToken && e.lengthComputable)libraryStatus('正在保存视频到电脑文件库：'+Math.round(e.loaded/e.total*100)+'%');};
      xhr.onload=()=>{
        let data;try{data=JSON.parse(xhr.responseText);}catch{data={};}
        if(xhr.status>=200 && xhr.status<300){if(token===S.videoToken){libraryStatus('视频已保存，下次可直接继续学习');toast('续播视频已保存，下次无需重新选择文件');}resolve(data);}
        else reject(new Error(data.error||'HTTP '+xhr.status));
      };
      xhr.onerror=()=>reject(new Error('连接失败，请确认电脑服务在线'));
      xhr.ontimeout=()=>reject(new Error('上传超时，可重新保存'));
      xhr.send(file);
    });
    uploads.set(key,task);
    task.finally(()=>uploads.delete(key)).catch(()=>{});
    return task;
  }
  async function openLesson(entry) {
    await libraryFlush();
    const response=await fetch('/api/library/'+entry.key);
    if(!response.ok&&response.status!==404)throw new Error('字幕库读取失败：HTTP '+response.status);
    let lesson=response.ok?await response.json():{videoName:entry.videoName,segments:[]};
    const cache=LS.get('elp.lesson.'+entry.key,null);
    if(cache?.unsynced&&cache.payload)lesson=cache.payload;
    if(!entry.hasVideo){toast('此记录只有字幕；请打开对应视频，播放器会自动匹配',true);return;}
    cancelLocalJob(true);clearGapTimer();
    if(S.currentObjUrl)URL.revokeObjectURL(S.currentObjUrl);
    S.currentObjUrl=null;S.videoFile=null;window.__currentVideoFile=null;
    S.videoToken++;S.translating=false;S.videoName=lesson.videoName;
    S.savedMedia={key:entry.key,name:lesson.videoName,size:entry.size};
    LIB.key=entry.key;LIB.revision++;LIB.signature='';LIB.pending=false;
    S.active=-1;S.loopLock=-1;S.offset=Number(lesson.offset)||0;
    const v=$('#video');
    if(S.posHandler)v.removeEventListener('timeupdate',S.posHandler);
    if(S.metaHandler)v.removeEventListener('loadedmetadata',S.metaHandler);
    v.src='/api/library-media/'+entry.key;v.load();v.playbackRate=S.speed;
    $('#dropzone').classList.add('hide');$('#overlay').classList.remove('hidden');
    $('#statusBadge').textContent=lesson.videoName;$('#offsetInput').value=S.offset;
    LIB.restoring=true;
    try{loadSegments(lesson.segments,true);S.offset=Number(lesson.offset)||0;$("#offsetInput").value=S.offset;}finally{LIB.restoring=false;}
    LIB.signature=JSON.stringify(libraryPayload());libraryStatus(entry.localPath?'已记住原视频位置，直接读取原文件；下次无需重新选择':'已从共享文件库打开，无需重新识别');
    if(cache?.unsynced)libraryFlush(true);
  }
  let picking=false;
  async function pickVideo() {
    if(picking)return;
    picking=true;const token=S.videoToken;
    try {
      const result=await request('/api/local-media/pick',{});
      if(result.cancelled||!result.entry){EchoPlayer.modules.resume?.cancelPending();return;}
      if(token!==S.videoToken)return;
      const saved=EchoPlayer.modules.resume?.session();
      await openLesson(result.entry);
      EchoPlayer.modules.resume?.onNativeOpened(result.entry.key,saved);
      toast('已记住视频路径，以后可直接继续学习');
    } catch(e){EchoPlayer.modules.resume?.cancelPending();toast('打开视频失败：'+e.message+'。请确认已重启新版电脑服务。',true);}
    finally{picking=false;}
  }
  async function showLibrary() {
    const dlg=document.createElement('dialog');
    dlg.className='storage-dialog';
    dlg.style.cssText='max-width:700px;width:calc(100% - 32px);max-height:85vh;overflow:auto;border:1px solid #444;border-radius:16px;background:#191c24;color:#eee;padding:24px';
    dlg.innerHTML='<h2>共享文件库</h2><p>字幕自动保存为 JSON + 通用 SRT。选择同一个目录的版本可以复用这些字幕。这里的位置是电脑磁盘，手机通过局域网访问。</p><label>存放目录<input id="libraryDir" style="display:block;width:100%;box-sizing:border-box;margin:8px 0" placeholder="例如 D:\\SlowEchoLibrary"></label><div><button class="btn" id="pickLibraryDir">选择文件夹</button> <button class="btn primary" id="applyLibraryDir">应用设置</button></div><label style="display:block;margin:16px 0"><input type="checkbox" id="autoSaveVideo"> 导入视频时，也自动保存视频到此目录</label><p class="hint">电脑请从 localhost 地址选择目录；手机端只能使用已设置的目录。更换目录不会删除或自动搬迁旧文件。</p><button class="btn" id="saveMediaNow">保存当前视频</button> <button class="btn" id="refreshLibrary">刷新列表</button><p class="storage-status" id="storageStatus">正在读取…</p><div id="savedLessons"></div><button class="btn" id="closeLibrary" style="margin-top:16px">关闭</button>';
    document.body.append(dlg);dlg.showModal();
    const q=s=>dlg.querySelector(s),status=t=>q('#storageStatus').textContent=t;
    q('#closeLibrary').onclick=()=>dlg.close();dlg.onclose=()=>dlg.remove();
    async function list(){
      const data=await request('/api/library-index');
      const entries=data.lessons||[];
      q('#savedLessons').replaceChildren();
      for(const entry of entries){
        const b=document.createElement('button');b.className='btn';b.style.cssText='display:block;width:100%;text-align:left;margin:8px 0;white-space:normal';
        b.textContent=entry.videoName+' · '+entry.count+' 句 · '+(entry.hasVideo?'打开视频':'仅字幕');
        b.onclick=async()=>{try{await openLesson(entry);if(entry.hasVideo)dlg.close();}catch(e){status(e.message);}};
        q('#savedLessons').append(b);
      }
      if(!entries.length)q('#savedLessons').textContent='还没有已保存的字幕。导入视频并生成或导入字幕后会自动保存。';
    }
    q('#pickLibraryDir').onclick=async()=>{try{status('请在电脑弹出的窗口中选择文件夹…');const d=await request('/api/storage/pick',{});if(d.directory)q('#libraryDir').value=d.directory;status(d.directory?'已选择，请点击应用设置':'已取消选择');}catch(e){status(e.message);}};
    q('#applyLibraryDir').onclick=async()=>{
      try{
        await libraryFlush();await Promise.all([...uploads.values()]);
        config=await request('/api/storage/config',{directory:q('#libraryDir').value.trim(),autoSaveVideo:q('#autoSaveVideo').checked});
        LIB.signature='';await libraryFlush(true);
        status('设置已保存：'+config.directory);
        if(S.videoFile && LIB.key)autoSave(S.videoFile,LIB.key,S.videoToken);
        await list();
      }catch(e){status(e.message);}
    };
    q('#saveMediaNow').onclick=async()=>{
      if(!S.videoFile || !LIB.key){status('请先用“打开视频”选择本地文件');return;}
      try{status('正在保存，请保持页面打开…');await saveVideo(S.videoFile,LIB.key);status('视频保存完成');await list();}catch(e){status(e.message);}
    };
    q('#refreshLibrary').onclick=()=>list().catch(e=>status(e.message));
    try{const cfg=await refreshConfig();q('#libraryDir').value=cfg.directory;q('#autoSaveVideo').checked=cfg.autoSaveVideo;status('字幕与视频目录：'+cfg.directory);await list();}
    catch(e){status(e.message);}
  }
  EchoPlayer.storage={showLibrary,autoSave,saveVideo,refreshConfig,openLesson,enableVideoAutoSave,pickVideo};
  document.getElementById('btnLibrary').onclick=showLibrary;
})();
