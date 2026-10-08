EchoPlayer.define("deepseek",()=>{
"use strict";
const DS_URL = "https://api.deepseek.com/v1/chat/completions";
const DS_HTTP_ERRORS = {400:'请求参数或模型不受支持',401:'Key 无效或已过期',402:'账户余额不足',403:'当前 Key 没有调用权限',429:'请求过于频繁，请稍后再试',500:'DeepSeek 服务异常，请稍后重试',503:'DeepSeek 服务繁忙，请稍后重试'};

/* A bounded connection check sends a fixed prompt, never learning content. */
async function testDeepSeekConnection(key, model='deepseek-flash', signal, maxWaitMs=20000) {
  if(!key.trim())throw new Error('请先填写 Key');
  const controller=new AbortController();let timedOut=false;
  const cancel=()=>controller.abort();
  signal?.addEventListener('abort',cancel,{once:true});
  if(signal?.aborted)cancel();
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},maxWaitMs);
  try {
    let response;
    try {
      response=await fetch(DS_URL,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key.trim()},body:JSON.stringify({model,messages:[{role:'user',content:'Reply with OK only.'}],stream:false,thinking:{type:'disabled'},max_tokens:16}),signal:controller.signal});
    } catch(e) {
      if(signal?.aborted)throw new DOMException('测试已取消','AbortError');
      throw new Error(timedOut?'请求超时（20 秒），请重试':'网络连接失败，请检查网络或代理后重试');
    }
    if(!response.ok)throw new Error((DS_HTTP_ERRORS[response.status]||'服务请求失败')+'（HTTP '+response.status+'）');
    let data;
    try{data=await response.json();}catch{throw new Error(timedOut?'请求超时，请重试':'接口返回的数据格式不正确，请重试');}
    const content=data?.choices?.[0]?.message?.content;
    if(typeof content!=='string'||!content.trim())throw new Error('接口没有返回有效回复，请重试');
    return {model:String(data.model||model)};
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}

async function dsChat(system, user, maxWaitMs) {
  const key = (S.settings.dsKey || "").trim();
  if (!key) throw new Error("未配置 DeepSeek API Key");
  let r;
  try { r = await fetch(DS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({
      model: S.settings.dsModel || "deepseek-flash",
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0.2, stream: false, thinking: {type: "disabled"}, max_tokens: 4096
    }),
    signal: timeout(maxWaitMs || 300000)
  });
  } catch(e) { throw new Error(e.name === "TimeoutError" || e.name === "AbortError" ? "请求超时，请重试" : "网络连接失败，请在设置中测试连接"); }
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    const reason = {401:'Key 无效或已过期',402:'账户余额不足',429:'请求过于频繁，请稍后再试',400:'请求参数或模型不受支持'}[r.status] || '服务请求失败';
    throw new Error(reason + '（HTTP ' + r.status + '）');
  }
  const j = await r.json();
  return j?.choices?.[0]?.message?.content || "";
}


return {DS_URL, dsChat, testDeepSeekConnection};
});
