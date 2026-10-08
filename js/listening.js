/* Listening phrases: timing-aware previews, audio-pause suggestions and exact manual cuts. */
(() => {
  'use strict';
  const tokens=text=>String(text||'').match(/\S+/g)||[];
  const normalized=text=>String(text||'').toLowerCase().replace(/[^a-z0-9']/g,'');
  let undo=null;
  function timedWords(segment) {
    const words=segment.words, text=tokens(segment.text);
    return Array.isArray(words) && words.length===text.length && words.every((w,i)=>
      Number.isFinite(w.start)&&Number.isFinite(w.end)&&w.end>=w.start && w.start>=segment.start && w.end<=segment.end &&
      (!i || w.start>=words[i-1].end) && normalized(w.word)===normalized(text[i])) ? words : null;
  }
  function semanticScore(words,i) {
    const left=words[i-1],next=words[i]||'',lower=normalized(next);
    if (/^(a|an|the|to|of|in|on|at|for|with|through|your|my)$/i.test(normalized(left)))return -5;
    if (/[.!?]["')]*$/.test(left))return 5;
    let score=/[,;:]["')]*$/.test(left)?2.5:0;
    if(['and','but','because','while','which','who','when','just'].includes(lower))score+=2;
    if(lower==='to' && /^(see|get|make|be|find|understand|show)$/i.test(normalized(words[i+1]||'')))score+=3;
    return score;
  }
  function suggest(segment,pauses=[]) {
    const text=tokens(segment.text), timed=timedWords(segment), n=text.length;
    if(n<4)return [];
    const duration=segment.end-segment.start, splits=Math.max(Math.ceil(n/18),Math.ceil(duration/6));
    if(splits<=1)return [];
    const cuts=[];let from=0, previous=segment.start;
    while(n-from>18 || segment.end-previous>6.5) {
      const remaining=Math.max(2,Math.ceil((n-from)/18),Math.ceil((segment.end-previous)/6));
      const target=from+(n-from)/remaining;
      let best=null;
      for(let i=from+3;i<=Math.min(n-3,from+18);i++) {
        const estimated=segment.start+duration*i/n;
        let time=timed?(timed[i-1].end+timed[i].start)/2:estimated;
        let score=semanticScore(text,i)-Math.abs(i-target)*.3;
        const gap=timed?Math.max(0,timed[i].start-timed[i-1].end):0;
        if(gap>=.25)score+=Math.min(gap,1)*12;
        let measured=false;
        if(!timed && pauses.length) {
          const candidates=pauses.filter(p=>p.time>previous+1 && p.time<segment.end-.5 && Math.abs(p.time-estimated)<1.2);
          candidates.sort((a,b)=>Math.abs(a.time-estimated)-Math.abs(b.time-estimated));
          if(candidates[0]){time=candidates[0].time;measured=true;score+=3-Math.abs(time-estimated)*2;}
        }
        if(time<=previous+.3 || time>=segment.end-.3)continue;
        if(time-previous>6.5)score-=(time-previous-6.5)*2;
        if(!best || score>best.score)best={after:i,time,score,measured};
      }
      if(!best)break;
      cuts.push(best);from=best.after;previous=best.time;
      if(cuts.length>=12)break;
    }
    return cuts;
  }
  function partsFor(segment,cuts,{manual=false}={}) {
    const text=tokens(segment.text), timed=timedWords(segment);
    const ordered=cuts.slice().sort((a,b)=>a.after-b.after);
    if(timed && !manual)for(const cut of ordered){
      if(!Number.isInteger(cut.after)||cut.after<1||cut.after>=text.length)throw new Error('请选择有效的切词位置');
      if(cut.time<timed[cut.after-1].end || cut.time>timed[cut.after].start)
        throw new Error('切点与选定单词的时间不一致。请按词间时间切分；若原词级时间错误，请先试听并确认手动校正。');
    }
    let cursor=0,start=segment.start;
    const parts=[];
    for(const cut of [...ordered,{after:text.length,time:segment.end}]){
      if(!Number.isInteger(cut.after)||cut.after<=cursor||cut.after>text.length||!Number.isFinite(cut.time)||cut.time<=start||cut.time>segment.end)throw new Error('分段位置或时间顺序不正确，请调整后重试');
      const item={start,end:cut.time,text:text.slice(cursor,cut.after).join(' ')};
      if(timed && !manual) {
        const slice=timed.slice(cursor,cut.after);
        if(!slice.every(w=>w.start>=start&&w.end<=cut.time))throw new Error('词级时间超出新分段范围，请校正后重试');
        item.words=slice.map(w=>({...w}));
      }
      if(segment.starred)item.starred=true;
      parts.push(item);cursor=cut.after;start=cut.time;
    }
    return parts;
  }
  function commit(index,original,parts,token,replaced=[original]) {
    if(S.videoToken!==token || !replaced.every((s,n)=>S.segments[index+n]===s))throw new Error('字幕或视频已改变，请重新打开分段面板');
    if(parts.length<2)throw new Error('没有需要拆分的边界');
    const before=S.segments.slice(), offset=S.offset;
    const next=[...before.slice(0,index),...parts,...before.slice(index+replaced.length)];
    clearGapTimer();$('#video').pause();S.translating=false;
    S.segments=next;LIB.revision++;S.active=-1;S.loopLock=-1;
    renderList();S.offset=offset;setActive(index);
    if(S.loopSentence)S.loopLock=index;
    undo={before,after:next,token,offset,index};
    $('#btnUndoSplit').hidden=false;
    libraryFlush(true);
    // Old whole-sentence translations/IPA cannot simply be cut by character count.
    if(S.settings.net)parts.forEach((_,n)=>{if(S.settings.autoTranslate)translateSeg(index+n);});
    if(S.settings.showIpa)parts.forEach((_,n)=>ensureIpa(index+n));
    toast('已拆成 '+parts.length+' 个精听意群；可撤销本次分段');
  }
  function undoSplit(){
    if(!undo || undo.token!==S.videoToken || S.segments!==undo.after){toast('字幕已发生变化，无法撤销旧分段',true);return;}
    const old=undo;undo=null;clearGapTimer();$('#video').pause();S.translating=false;
    S.segments=old.before;LIB.revision++;S.offset=old.offset;S.active=-1;S.loopLock=-1;
    renderList();setActive(Math.min(old.index,S.segments.length-1));libraryFlush(true);$('#btnUndoSplit').hidden=true;
    toast('已恢复分段前的字幕、译文和音标');
  }
  async function audioPauses(segment) {
    if(!/^https?:$/.test(location.protocol))throw new Error('音频停顿检测需要通过电脑启动器打开；离线时可手动拆句');
    const start=Math.max(0,segment.start+S.offset), end=segment.end+S.offset;
    const url='/api/listening/pauses?start='+start+'&end='+end+'&key='+encodeURIComponent(LIB.key||'');
    let response=await fetch(url,{method:'POST',headers:{'X-EchoPlayer':'1','Content-Type':'application/json'},body:'{}',signal:timeout(90000)});
    if(response.status===404 && S.videoFile)response=await fetch(url,{method:'POST',headers:{'X-EchoPlayer':'1','Content-Type':'application/octet-stream'},body:S.videoFile,signal:timeout(180000)});
    const data=await response.json();if(!response.ok)throw new Error(data.error||'停顿检测失败');
    return data.pauses.map(p=>({...p,start:p.start-S.offset,end:p.end-S.offset,time:p.time-S.offset}));
  }
  function open(index=S.active,repair=false) {
    if(index<0)index=segAt(viewSegments(),$('#video').currentTime);
    let original=S.segments[index];
    if(!original){toast('请先选择需要拆分的那句字幕',true);return;}
    const replaced=[original], following=S.segments[index+1];
    const oldBoundary=tokens(original.text).length;
    if(repair){
      if(!following){toast('已经是最后一句，没有下一句边界可校正');return;}
      replaced.push(following);
      const words=timedWords(original)&&timedWords(following)?[...original.words,...following.words]:undefined;
      original={start:original.start,end:following.end,text:original.text+' '+following.text,words,starred:original.starred||following.starred};
    }
    const text=tokens(original.text);if(text.length<2){toast('这句已经很短了');return;}
    const token=S.videoToken,rawTime=$('#video').currentTime-S.offset;
    clearGapTimer();$('#video').pause();
    let timed=timedWords(original),stopPreview=()=>{};
    let cuts=repair?[{after:oldBoundary,time:following.start}]:suggest(original);
    const validWords=timed && cuts.every(c=>c.time>=timed[c.after-1].end&&c.time<=timed[c.after].start);
    const dlg=document.createElement('dialog');dlg.className='listening-dialog';
    dlg.innerHTML='<h2>精听分段</h2><p id="splitHint"></p><p id="splitOriginal"></p><button class="btn" id="detectPauses">检测本句音频停顿</button><p id="splitStatus" role="status"></p><div id="splitPreview"></div><div class="actions"><button class="btn primary" id="applySplit">应用预览分段</button></div><hr><h3>在听到的停顿处拆开</h3><p>先在视频中听到停顿并暂停，再打开此面板，选择停顿前的最后一个词。</p><label>从这个词后切开 <select id="manualWord"></select></label><label> 视频时间（秒）<input type="number" step="0.05" id="manualTime"></label><button class="btn" id="manualSplit">按选定词和时间拆开</button><p>拆开的句子会重新生成译文和音标；原字幕可通过“撤销分段”恢复。</p><button class="btn" id="closeSplit">关闭</button>';
    document.body.append(dlg);dlg.showModal();const q=s=>dlg.querySelector(s),status=t=>q('#splitStatus').textContent=t;
    q('h2').textContent=repair?'校正本句与下一句的边界':'精听分段';
    const confirmation=document.createElement('label');
    confirmation.innerHTML='<input type="checkbox" id="confirmTiming"> 我已试听切点两侧，确认画面时间与所选单词一致（手动校正）';
    q('#applySplit').parentElement.before(confirmation);
    if(following&&!repair){const fix=document.createElement('button');fix.className='btn';fix.textContent='校正本句与下一句边界';fix.onclick=()=>{dlg.close();open(index,true);};q('#splitOriginal').after(fix);}
    q('#splitOriginal').textContent=original.text;
    q('#splitHint').textContent=timed?'按逐词时间生成边界；手动改时间须试听确认。':'缺少逐词时间，文字估时和静音检测都不能确定说到哪个词。请试听切点两侧、调整后勾选确认，才可应用。';
    if(repair)status('例如下一句的 just automatically 已在本句听到：将时间切点提前到 just 开始之前，或同步调整切词位置。');
    const manual=()=>q('#confirmTiming').checked;
    function ready(){q('#applySplit').disabled=cuts.length===0||((!validWords||changedTiming)&&!manual());q('#manualSplit').disabled=!manual();}
    q('#confirmTiming').onchange=ready;
    let changedTiming=false;
    function requireReview(){changedTiming=true;q('#confirmTiming').checked=false;ready();q('#applySplit').disabled=true;}
    function draw(){
      const box=q('#splitPreview');box.replaceChildren();
      const parts=partsFor(original,cuts,{manual:true});
      parts.forEach((part,i)=>{
        const row=document.createElement('div');row.className='split-row';
        const line=document.createElement('p');line.textContent=fmt(part.start+S.offset)+' – '+fmt(part.end+S.offset)+'  '+part.text;row.append(line);
        const play=document.createElement('button');play.className='btn';play.textContent='试听此段';play.onclick=()=>{
          stopPreview();const v=$('#video');clearGapTimer();const oldLoop=S.loopSentence;S.loopSentence=false;
          const stop=()=>{if(v.currentTime>=part.end+S.offset || v.paused)stopPreview();};
          stopPreview=()=>{v.removeEventListener('timeupdate',stop);v.pause();S.loopSentence=oldLoop;stopPreview=()=>{};};
          v.currentTime=part.start+S.offset+.005;v.addEventListener('timeupdate',stop);v.play().catch(()=>stopPreview());
        };row.append(play);
        if(i<cuts.length){
          const label=document.createElement('label');label.textContent=' 切点（视频秒）：';const input=document.createElement('input');input.type='number';input.step='.05';input.value=(cuts[i].time+S.offset).toFixed(2);input.onchange=()=>{const prev=cuts[i].time;cuts[i].time=Number(input.value)-S.offset;try{draw();}catch(e){cuts[i].time=prev;status(e.message);draw();}};label.append(input);row.append(label);
          const onChange=input.onchange;input.onchange=()=>{stopPreview();onChange();requireReview();};
          const words=document.createElement('select');words.setAttribute('aria-label','切词位置');
          const lo=i?cuts[i-1].after+1:1,hi=i+1<cuts.length?cuts[i+1].after-1:text.length-1;
          for(let n=lo;n<=hi;n++){const opt=document.createElement('option');opt.value=n;opt.textContent=text[n-1]+' | '+text[n];words.append(opt);}
          words.value=cuts[i].after;words.onchange=()=>{stopPreview();cuts[i].after=Number(words.value);if(timed)cuts[i].time=(timed[cuts[i].after-1].end+timed[cuts[i].after].start)/2;draw();requireReview();};row.append(words);
          const around=document.createElement('button');around.className='btn';around.textContent='试听切点前后';around.onclick=()=>{
            stopPreview();const v=$('#video'),loop=S.loopSentence;clearGapTimer();S.loopSentence=false;
            const end=Math.min(original.end+S.offset,cuts[i].time+S.offset+1.5);
            let frame=0;const check=()=>{if(v.currentTime>=end){stopPreview();return;}frame=requestAnimationFrame(check);};
            stopPreview=()=>{cancelAnimationFrame(frame);v.pause();S.loopSentence=loop;stopPreview=()=>{};};
            v.currentTime=Math.max(0,original.start+S.offset,cuts[i].time+S.offset-1.5);v.play().then(check).catch(()=>stopPreview());
          };row.append(around);
          const use=document.createElement('button');use.className='btn';use.textContent='用当前暂停位置';use.onclick=()=>{const time=$('#video').currentTime-S.offset;stopPreview();const old=cuts[i].time;cuts[i].time=time;try{draw();requireReview();}catch(e){cuts[i].time=old;draw();status(e.message);}};row.append(use);
        }
        box.append(row);
      });ready();if(changedTiming&&!manual())q('#applySplit').disabled=true;
    }
    draw();
    text.slice(0,-1).forEach((word,i)=>{const opt=document.createElement('option');opt.value=i+1;opt.textContent=(i+1)+'. '+word+' | '+text[i+1];q('#manualWord').append(opt);});
    const after=timed?timed.filter(w=>w.end<=rawTime).length:Math.round((rawTime-original.start)/(original.end-original.start)*text.length);
    q('#manualWord').value=Math.min(text.length-1,Math.max(1,after));q('#manualTime').value=(rawTime+S.offset).toFixed(2);
    q('#manualTime').oninput=q('#manualWord').onchange=requireReview;
    q('#manualSplit').onclick=()=>{try{if(!manual())throw new Error('请先试听并勾选时间确认');stopPreview();commit(index,original,partsFor(original,[{after:Number(q('#manualWord').value),time:Number(q('#manualTime').value)-S.offset}],{manual:true}),token,replaced);dlg.close();}catch(e){status(e.message);}};
    q('#applySplit').onclick=()=>{try{if((!timed||changedTiming||!validWords)&&!manual())throw new Error('请先试听并勾选时间确认');stopPreview();commit(index,original,partsFor(original,cuts,{manual:manual()}),token,replaced);dlg.close();}catch(e){status(e.message);}};
    q('#detectPauses').onclick=async()=>{q('#detectPauses').disabled=true;status('正在读取本句音频；未存到文件库的视频会临时传给电脑，不重新识别…');try{
      const pauses=await audioPauses(original);
      if(S.videoToken!==token||!replaced.every((s,n)=>S.segments[index+n]===s)||!dlg.isConnected)return;
      if(!repair)cuts=suggest(original,pauses);draw();requireReview();status(pauses.length?'找到停顿（视频秒）：'+pauses.map(p=>(p.time+S.offset).toFixed(2)).join('、')+'。静音不能定位单词，请试听确认。':'没有检测到清晰静音，请手动校正边界。');
    }catch(e){status(e.message);}finally{q('#detectPauses').disabled=false;}};
    q('#closeSplit').onclick=()=>dlg.close();dlg.addEventListener('close',()=>{stopPreview();dlg.remove();},{once:true});
  }
  EchoPlayer.listening={open,suggest,partsFor,timedWords,undoSplit};
  $('#btnSplit').onclick=()=>open();$('#btnUndoSplit').onclick=undoSplit;
})();
