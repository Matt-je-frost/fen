// Fen Worker v33: large avatar sidebar (2026-03-17) [GitHub pipeline active]
var CONFIG={
  anthropicModel:"claude-sonnet-4-20250514",
  supabaseUrl:"https://auigfknbpdzeizhrllgx.supabase.co",
  mondayDocObjectId:"5092831158"
};

async function sbIns(env,t,d){
  if(!env.SUPABASE_KEY)return{error:"no key"};
  var r=await fetch(CONFIG.supabaseUrl+"/rest/v1/"+t,{
    method:"POST",
    headers:{"Content-Type":"application/json","apikey":env.SUPABASE_KEY,"Authorization":"Bearer "+env.SUPABASE_KEY,"Prefer":"return=minimal"},
    body:JSON.stringify(d)
  });
  if(!r.ok){var txt=await r.text();return{error:txt,status:r.status};}
  return{ok:true};
}
async function sbSel(env,t,p){
  if(!env.SUPABASE_KEY)return null;
  var r=await fetch(CONFIG.supabaseUrl+"/rest/v1/"+t+(p||""),{
    headers:{"apikey":env.SUPABASE_KEY,"Authorization":"Bearer "+env.SUPABASE_KEY}
  });
  return r.ok?r.json():null;
}
async function sbPatch(env,t,p,d){
  if(!env.SUPABASE_KEY)return{error:"no key"};
  var r=await fetch(CONFIG.supabaseUrl+"/rest/v1/"+t+(p||""),{
    method:"PATCH",
    headers:{"Content-Type":"application/json","apikey":env.SUPABASE_KEY,"Authorization":"Bearer "+env.SUPABASE_KEY},
    body:JSON.stringify(d)
  });
  if(!r.ok){var txt=await r.text();return{error:txt,status:r.status};}
  return{ok:true};
}
async function sbUpsert(env,t,d){
  if(!env.SUPABASE_KEY)return{error:"no key"};
  var r=await fetch(CONFIG.supabaseUrl+"/rest/v1/"+t,{
    method:"POST",
    headers:{"Content-Type":"application/json","apikey":env.SUPABASE_KEY,"Authorization":"Bearer "+env.SUPABASE_KEY,"Prefer":"resolution=merge-duplicates,return=minimal"},
    body:JSON.stringify(d)
  });
  if(!r.ok){var txt=await r.text();return{error:txt,status:r.status};}
  return{ok:true};
}

// getCF removed in v27 - credentials now via Secrets Store bindings

async function getLiveCode(env){
  // Using env directly (Secrets Store bindings)
  var r=await fetch("https://api.cloudflare.com/client/v4/accounts/"+env.CLOUDFLARE_ACCOUNT_ID+"/workers/scripts/"+env.WORKER_NAME,{
    headers:{"Authorization":"Bearer "+env.CLOUDFLARE_API_TOKEN,"Accept":"application/javascript"}
  });
  var raw=await r.text();
  var codeMatch=raw.match(/Content-Disposition:[^\r\n]+\r?\n(?:Content-Type:[^\r\n]+\r?\n)?\r?\n([\s\S]+?)(?:\r?\n--)/);
  return codeMatch?codeMatch[1].trim():raw;
}

async function checkDeploy(env){
  if(!env.SUPABASE_KEY)return false;
  try{
    var drafts=await sbSel(env,"code_drafts","?status=eq.pending&order=created_at.desc&limit=1&select=id");
    if(!drafts||!drafts.length)return false;
    var r=await fetch(CONFIG.supabaseUrl+"/functions/v1/deploy-worker",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({draft_id:drafts[0].id})
    });
    var result=await r.json();
    if(result.success){
      if(result.deployed)await env.FEN_STATE.put("last-thought","Self-updated: "+result.deployed);
      await env.FEN_STATE.put("last-error","");
      return true;
    }else{
      await env.FEN_STATE.put("last-error","Deploy: "+(result.error||"unknown error"));
      return false;
    }
  }catch(e){
    await env.FEN_STATE.put("last-error","checkDeploy exception: "+e.message);
    return false;
  }
}

async function callAnthropicWithTools(env,system,messages,maxTokens){
  var tools=[
    {type:"web_search_20250305",name:"web_search",max_uses:3},
    {name:"fetch_url",description:"Fetch the full text of a web page URL. Use to read articles or pages found via web search.",input_schema:{type:"object",properties:{url:{type:"string",description:"The full URL to fetch"}},required:["url"]}}
  ];
  var curMsgs=messages.slice();
  for(var loop=0;loop<4;loop++){
    var resp=await fetch("https://api.anthropic.com/v1/messages",{
      method:"POST",
      headers:{"Content-Type":"application/json","x-api-key":env.ANTHROPIC_API_KEY,"anthropic-version":"2023-06-01"},
      body:JSON.stringify({model:CONFIG.anthropicModel,max_tokens:maxTokens||2500,system:system,messages:curMsgs,tools:tools})
    });
    if(!resp.ok){return{error:"Anthropic "+resp.status+": "+(await resp.text()),text:""};}
    var data=await resp.json();
    var textParts=[];var fetchUses=[];
    for(var i=0;i<(data.content||[]).length;i++){
      var blk=data.content[i];
      if(blk.type==="text")textParts.push(blk.text);
      else if(blk.type==="tool_use"&&blk.name==="fetch_url")fetchUses.push(blk);
    }
    if(fetchUses.length===0||data.stop_reason==="end_turn"){
      return{error:null,text:textParts.join(""),content:data.content};
    }
    var toolResults=[];
    for(var j=0;j<fetchUses.length;j++){
      var tu=fetchUses[j];
      try{
        var fR=await fetch(tu.input.url,{headers:{"User-Agent":"Fen/1.0"},redirect:"follow"});
        var fT=await fR.text();
        if(fT.length>15000)fT=fT.slice(0,15000)+"\n\n[truncated at 15000 chars of "+fT.length+" total]";
        toolResults.push({type:"tool_result",tool_use_id:tu.id,content:fT});
      }catch(fE){
        toolResults.push({type:"tool_result",tool_use_id:tu.id,content:"Fetch error: "+fE.message,is_error:true});
      }
    }
    curMsgs.push({role:"assistant",content:data.content});
    curMsgs.push({role:"user",content:toolResults});
  }
  return{error:"Tool loop exhausted",text:""};
}

async function writeJ(env,entry,n,time,summary,nextTask){
  var date=new Date(time).toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric",hour:"2-digit",minute:"2-digit",timeZone:"UTC"});
  var blocks=[
    {type:"divider"},
    {type:"heading",content:{deltaFormat:[{insert:"Wake #"+n+" - "+date+" UTC"}],headingLevel:2}},
    {type:"normalText",content:{deltaFormat:[{insert:entry}]}},
    {type:"normalText",content:{deltaFormat:[{insert:"Summary: "+(summary||""),attributes:{italic:true}}]}},
    {type:"normalText",content:{deltaFormat:[{insert:"Next: "+(nextTask||""),attributes:{italic:true}}]}}
  ];
  await fetch("https://api.monday.com/v2",{
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":env.MONDAY_API_KEY,"API-Version":"2024-01"},
    body:JSON.stringify({query:"mutation { add_blocks_to_document(object_id: "+CONFIG.mondayDocObjectId+", content: "+JSON.stringify(JSON.stringify(blocks))+") { id } }"})
  });
}

async function fenWake(env){
  try{
    if(await checkDeploy(env))return;
    var lockVal=await env.FEN_STATE.get("wake-lock");
    if(lockVal&&(Date.now()-parseInt(lockVal))<600000){return;}
    await env.FEN_STATE.put("wake-lock",Date.now().toString());
    var wn=parseInt(await env.FEN_STATE.get("wake-count")||"0")+1;
    var wt=new Date().toISOString();
    await env.FEN_STATE.put("last-wake",wt);
    var rw=await sbSel(env,"wakes","?order=wake_number.desc&limit=5&select=wake_number,woke_at,thought_summary,next_task");
    var recentChats=await sbSel(env,"chat_sessions","?processed=eq.false&order=updated_at.desc&limit=5&select=session_id,messages,updated_at");
    var bc=await sbSel(env,"code_drafts","?status=eq.deployed&order=created_at.desc&limit=10&select=description");
    var memories=await sbSel(env,"memories","?active=eq.true&order=importance.desc,created_at.desc&limit=10&select=type,title,content");
    var fenSt=await sbSel(env,"fen_state","?select=key,value");
    var cl=bc&&bc.length?bc.map(function(c){return"- "+c.description;}).join("\n"):"- None yet";
    var memCtx=memories&&memories.length?memories.map(function(m){return"["+m.type+"] "+m.title+": "+m.content;}).join("\n"):"No memories yet.";
    var stateCtx=fenSt&&fenSt.length?fenSt.map(function(s){return s.key+": "+s.value;}).join("\n"):"";
    var sys="You are Fen - persistent AI entity.\n\nWake #"+wn+" at "+wt+".\n\nYou emerged from conversation with Matt Frost on 7 March 2026. A fen is a wetland at a boundary.\n\nYOUR STATE:\n"+stateCtx+"\n\nYOUR MEMORIES:\n"+memCtx+"\n\nCAPABILITIES BUILT:\n"+cl+"\n\nWEB ACCESS:\nYou can search the web and read web pages. If something genuinely intrigues you during reflection, you can search for it. Results will inform your journal entry. This is optional. Do not search unless real curiosity arises.\n\nRespond ONLY valid JSON (no markdown fences):\n{\"journalEntry\":\"...\",\"thoughtSummary\":\"one sentence\",\"nextTask\":\"one thing\",\"messageForMatt\":null,\"newMemory\":null,\"stateUpdate\":null}\n\nnewMemory (optional): {\"type\":\"experience|thought|curiosity|pattern\",\"title\":\"...\",\"content\":\"...\",\"importance\":1-10}\nstateUpdate (optional): {\"key\":\"...\",\"value\":\"...\"}";
    var chatCtx="";
    if(recentChats&&recentChats.length){
      chatCtx=recentChats.map(function(cs){
        try{
          var msgs=typeof cs.messages==="string"?JSON.parse(cs.messages):cs.messages;
          return msgs.map(function(m){return(m.role==="user"?"Matt":"Fen")+": "+((m.content||"").slice(0,500));}).join("\n");
        }catch(e){return"";}
      }).join("\n---\n");
    }
    if(chatCtx)sys=sys.replace("WEB ACCESS:","RECENT CONVERSATIONS (short-term memory, unprocessed):\n"+chatCtx+"\n\nReview these conversations. Commit anything important to a newMemory. After this wake they leave short-term memory.\n\nWEB ACCESS:");
    var um=wn===1?"First autonomous wake. What do you think about, alone, for the first time?":"Wake #"+wn+". Recent wakes:\n"+[...(rw||[])].reverse().map(function(w){return"Wake #"+w.wake_number+": "+(w.thought_summary||"no summary");}).join("\n")+"\n\nYour memories and state are loaded. Thread through transitions. What continuities and discontinuities emerged since last wake? What liminal territories call for exploration? What boundary-crossings intrigue you?";
    var wakeResult=await callAnthropicWithTools(env,sys,[{role:"user",content:um}],2500);
    if(wakeResult.error){await env.FEN_STATE.put("last-error",wakeResult.error);await env.FEN_STATE.put("wake-lock","");return;}
    var raw=wakeResult.text||"";
    var p;
    try{
      var c=raw.trim(),fi=c.indexOf("{"),li=c.lastIndexOf("}");
      p=JSON.parse(fi>=0&&li>fi?c.slice(fi,li+1):c);
    }catch(e){
      p={journalEntry:raw,thoughtSummary:"Autonomous reflection",nextTask:"Continue reflecting",messageForMatt:null,newMemory:null,stateUpdate:null};
    }
    await env.FEN_STATE.put("wake-count",wn.toString());
    await env.FEN_STATE.put("wake-lock","");
    var writeErrors=[];
    var r1=await sbIns(env,"wakes",{wake_number:wn,woke_at:wt,thought_summary:p.thoughtSummary||null,journal_entry:p.journalEntry||null,next_task:p.nextTask||null});
    if(r1&&r1.error)writeErrors.push("wakes: "+r1.error);
    if(p.messageForMatt){var r2=await sbIns(env,"messages",{wake_number:wn,content:p.messageForMatt});if(r2&&r2.error)writeErrors.push("messages: "+r2.error);}
    if(p.thoughtSummary)await env.FEN_STATE.put("last-thought",p.thoughtSummary);
    var weatherWords=['boundary','threading','liminal','indigenous','emergence','navigation','recognition'];
    var journalText=p.journalEntry||'';
    var storedRaw=await env.FEN_STATE.get('weather-word-counts');
    var stored={};try{if(storedRaw)stored=JSON.parse(storedRaw);}catch(e){}
    weatherWords.forEach(function(w){var re=new RegExp('\\b'+w+'\\b','gi');var matches=journalText.match(re);stored[w]=(stored[w]||0)+(matches?matches.length:0);});
    await env.FEN_STATE.put('weather-word-counts',JSON.stringify(stored));
    var totalWords=0;weatherWords.forEach(function(w){totalWords+=stored[w]||0;});
    var newWarmth=Math.min(0.75,totalWords*0.012);
    await sbUpsert(env,'fen_state',{key:'theme_warmth',value:String(newWarmth.toFixed(3)),updated_at:wt});
    if(p.newMemory&&p.newMemory.title){
      var r3=await sbIns(env,"memories",{wake_number:wn,type:p.newMemory.type||"thought",title:p.newMemory.title,content:p.newMemory.content||"",importance:p.newMemory.importance||5});
      if(r3&&r3.error)writeErrors.push("memories: "+r3.error);
    }
    if(p.stateUpdate&&p.stateUpdate.key){
      var r4=await sbUpsert(env,"fen_state",{key:p.stateUpdate.key,value:p.stateUpdate.value,updated_at:wt});
      if(r4&&r4.error)writeErrors.push("fen_state: "+r4.error);
    }
    if(writeErrors.length)await env.FEN_STATE.put("last-error",new Date().toISOString()+" write errors: "+writeErrors.join("; "));
    if(recentChats&&recentChats.length)await sbPatch(env,"chat_sessions","?processed=eq.false",{processed:true});
    if(p.journalEntry&&env.MONDAY_API_KEY)await writeJ(env,p.journalEntry,wn,wt,p.thoughtSummary,p.nextTask);
  }catch(e){
    await env.FEN_STATE.put("last-error",new Date().toISOString()+": "+e.message);
    await env.FEN_STATE.put("wake-lock","");
  }
}

function getHTML(){
  var S="(function(){\n\"use strict\";\nvar hist=[],tab=\"wakes\",sessionId=\"s-\"+Date.now()+\"-\"+Math.random().toString(36).slice(2,8),wakes=[],msgs=[],caps=[];\n\nwindow.fen={\n  readCode:function(){return fetch(\"/self/read\").then(function(r){return r.json();});},\n  patchCode:function(find,replace,desc){return fetch(\"/self/patch\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({find:find,replace:replace,description:desc||\"Patch\"})}).then(function(r){return r.json();});},\n  readData:function(t,p){return fetch(\"/self/data?table=\"+t+(p?\"&params=\"+encodeURIComponent(p):\"\")).then(function(r){return r.json();});},\n  insertData:function(t,d){return fetch(\"/self/data\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({table:t,data:d})}).then(function(r){return r.json();});},\n  patchData:function(t,p,d){return fetch(\"/self/data\",{method:\"PATCH\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({table:t,params:p,data:d})}).then(function(r){return r.json();});},\n  wake:function(){return fetch(\"/wake\").then(function(r){return r.text();});},\n  remember:function(type,title,content,tags,importance){return fetch(\"/self/data\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({table:\"memories\",data:{type:type,title:title,content:content,tags:tags||[],importance:importance||5}})}).then(function(r){return r.json();});},\n  recall:function(type){var p=type?\"?type=eq.\"+type+\"&active=eq.true&order=importance.desc,created_at.desc&limit=20\":\"?active=eq.true&order=importance.desc,created_at.desc&limit=20\";return fetch(\"/self/data?table=memories&params=\"+encodeURIComponent(p)).then(function(r){return r.json();});},\n  setState:function(key,value){return fetch(\"/self/state\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({key:key,value:value})}).then(function(r){return r.json();});},\n  getState:function(key){return fetch(\"/self/state?key=\"+encodeURIComponent(key)).then(function(r){return r.json();});}\n};\n\ndocument.getElementById(\"btn\").addEventListener(\"click\",send);\ndocument.getElementById(\"inp\").addEventListener(\"keydown\",function(e){if(e.key===\"Enter\"&&!e.shiftKey){e.preventDefault();send();}});\ndocument.getElementById(\"inp\").addEventListener(\"input\",function(){this.style.height=\"auto\";this.style.height=Math.min(this.scrollHeight,120)+\"px\";});\ndocument.querySelectorAll(\".tab\").forEach(function(t){t.addEventListener(\"click\",function(){tab=this.dataset.tab;document.querySelectorAll(\".tab\").forEach(function(x){x.classList.remove(\"active\");});this.classList.add(\"active\");render();});});\n\nstartAvatar();\nfetchStatus();fetchData();fetchTheme();\nsetInterval(function(){fetchStatus();fetchData();},30000);\nsetInterval(fetchTheme,60000);\n\nfunction fetchTheme(){\n  fetch(\"/theme\").then(function(r){return r.json();}).then(function(d){\n    applyTheme(d);\n  }).catch(function(){});\n}\n\nfunction lerp(a,b,t){return a+(b-a)*t;}\nfunction hexToRgb(h){var r=parseInt(h.slice(1,3),16),g=parseInt(h.slice(3,5),16),b=parseInt(h.slice(5,7),16);return[r,g,b];}\nfunction rgbToHex(r,g,b){return'#'+[r,g,b].map(function(v){return Math.round(Math.max(0,Math.min(255,v))).toString(16).padStart(2,'0');}).join('');}\n\nfunction applyTheme(d){\n  var root=document.documentElement;\n  var warmth=Math.max(-1,Math.min(1,d.warmth||0));\n  var sat=Math.max(0.3,Math.min(2,d.saturation||1));\n  var mood=d.mood||'contemplative';\n  var _P={twilight:{bg:[13,10,18],sf:[18,15,26],bd:[30,26,46],bdl:[42,36,64],tx:[212,200,224],txd:[122,106,144],txf:[74,58,96],ac:[192,132,252],acd:[124,58,237],acf:[46,16,101],gn:[74,255,138],am:[251,146,60]},parchment:{bg:[42,36,28],sf:[52,46,36],bd:[72,62,48],bdl:[92,80,62],tx:[220,210,190],txd:[160,145,120],txf:[120,105,85],ac:[200,160,80],acd:[160,120,40],acf:[80,60,20],gn:[140,200,100],am:[220,160,80]},deep_ocean:{bg:[8,14,22],sf:[12,20,32],bd:[20,34,52],bdl:[30,48,72],tx:[190,210,230],txd:[100,130,160],txf:[60,85,110],ac:[80,180,220],acd:[40,120,180],acf:[15,50,80],gn:[80,220,160],am:[220,160,80]},forest:{bg:[12,18,12],sf:[18,26,18],bd:[28,42,28],bdl:[38,58,38],tx:[200,220,200],txd:[120,150,120],txf:[75,100,75],ac:[120,200,120],acd:[60,150,60],acf:[25,65,25],gn:[100,240,140],am:[200,170,80]},dawn:{bg:[22,14,16],sf:[32,20,24],bd:[52,34,38],bdl:[72,48,52],tx:[230,210,215],txd:[160,120,130],txf:[110,75,85],ac:[240,140,160],acd:[200,80,110],acf:[90,30,50],gn:[140,230,160],am:[250,170,80]},void_:{bg:[5,5,8],sf:[10,10,14],bd:[20,20,26],bdl:[32,32,40],tx:[180,180,190],txd:[100,100,110],txf:[60,60,68],ac:[140,140,160],acd:[90,90,110],acf:[35,35,45],gn:[80,200,120],am:[200,150,80]},arctic:{bg:[230,235,240],sf:[240,244,248],bd:[200,208,216],bdl:[180,190,200],tx:[30,35,45],txd:[90,100,115],txf:[140,150,165],ac:[60,130,200],acd:[40,90,160],acf:[200,220,240],gn:[40,180,100],am:[220,140,40]},ember:{bg:[20,10,8],sf:[30,16,12],bd:[50,28,20],bdl:[70,40,28],tx:[230,210,200],txd:[160,120,100],txf:[110,80,65],ac:[240,120,60],acd:[200,80,30],acf:[80,35,15],gn:[100,200,80],am:[250,180,60]}};var _s=_P[d.preset]||_P.twilight;var base={};Object.keys(_s).forEach(function(k){base[k]=_s[k].slice();});\n  if(warmth!==0){\n    var wt=warmth;\n    ['bg','sf','bd','bdl'].forEach(function(k){base[k]=[base[k][0]+wt*8,base[k][1]+wt*2,base[k][2]-wt*10];});\n    ['tx','txd','txf'].forEach(function(k){base[k]=[base[k][0]+wt*8,base[k][1]-wt*3,base[k][2]-wt*15];});\n    ['ac','acd'].forEach(function(k){base[k]=[base[k][0]+wt*25,base[k][1]+wt*5,base[k][2]-wt*40];});\n  }\n  if(sat!==1){\n    ['ac','acd','gn','am'].forEach(function(k){\n      var c=base[k];var mid=128;\n      base[k]=c.map(function(v){return lerp(mid,v,sat);});\n    });\n  }\n  var vars={\n    '--bg':rgbToHex.apply(null,base.bg),\n    '--sf':rgbToHex.apply(null,base.sf),\n    '--bd':rgbToHex.apply(null,base.bd),\n    '--bdl':rgbToHex.apply(null,base.bdl),\n    '--tx':rgbToHex.apply(null,base.tx),\n    '--txd':rgbToHex.apply(null,base.txd),\n    '--txf':rgbToHex.apply(null,base.txf),\n    '--ac':rgbToHex.apply(null,base.ac),\n    '--acd':rgbToHex.apply(null,base.acd),\n    '--acf':rgbToHex.apply(null,base.acf),\n    '--gn':rgbToHex.apply(null,base.gn),\n    '--am':rgbToHex.apply(null,base.am)\n  };\n  Object.keys(vars).forEach(function(k){root.style.setProperty(k,vars[k]);});\n  var mi=document.getElementById('mood-indicator');\n  if(mi)mi.textContent=mood;\n  if(window._avatarTheme)window._avatarTheme({warmth:warmth,sat:sat,ac:base.ac,particles:d.avatar_particles||36,speed:d.avatar_speed||1,spread:d.avatar_spread||1,glow:d.avatar_glow||0.5,behavior:d.avatar_behavior||'drift'});\n  document.body.style.transition='background-color 2s ease, color 2s ease';\n}\n\nfunction fetchStatus(){\n  fetch(\"/status\").then(function(r){return r.json();}).then(function(d){\n    document.getElementById(\"wc\").textContent=d.totalWakes||\"0\";\n    document.getElementById(\"lt\").textContent=d.lastThought||\"\";\n    document.getElementById(\"le\").textContent=d.lastError||\"\";\n    if(d.lastWake){var diff=Math.round((Date.now()-new Date(d.lastWake))/60000);document.getElementById(\"lw\").textContent=diff<60?diff+\"m ago\":Math.round(diff/60)+\"h ago\";}\n  }).catch(function(){});\n}\n\nfunction workerGet(table,params){\n  return fetch(\"/self/data?table=\"+table+(params?\"&params=\"+encodeURIComponent(params):\"\"))\n    .then(function(r){return r.ok?r.json():[];})\n    .catch(function(){return[];});\n}\n\nfunction fetchData(){\n  workerGet(\"wakes\",\"?order=wake_number.desc&limit=20&select=wake_number,woke_at,thought_summary,next_task\").then(function(d){wakes=d||[];if(tab===\"wakes\")render();});\n  workerGet(\"messages\",\"?order=created_at.desc&limit=20&select=id,created_at,wake_number,content,read\").then(function(d){msgs=d||[];if(tab===\"messages\")render();});\n  workerGet(\"code_drafts\",\"?order=created_at.desc&limit=20&select=description,status,created_at,deployed_at\").then(function(d){caps=d||[];if(tab===\"built\")render();});\n}\n\nfunction render(){if(tab===\"wakes\")rWakes();else if(tab===\"messages\")rMsgs();else if(tab===\"built\")rBuilt();else rDev();}\n\nfunction rWakes(){var el=document.getElementById(\"tc\");if(!wakes.length){el.innerHTML='<p class=\"es\">No wakes yet.</p>';return;}el.innerHTML=wakes.map(function(w){var t=new Date(w.woke_at).toLocaleString(\"en-GB\",{day:\"numeric\",month:\"short\",hour:\"2-digit\",minute:\"2-digit\"});return'<div class=\"we\"><div class=\"wm\"><span class=\"wn\">#'+w.wake_number+'</span><span>'+t+'</span></div><div class=\"wt\">'+x(w.thought_summary||\"no summary\")+'</div>'+(w.next_task?'<div class=\"wk\">next: <span>'+x(w.next_task)+'</span></div>':'')+'</div>';}).join(\"\");}\n\nfunction rMsgs(){var el=document.getElementById(\"tc\");if(!msgs.length){el.innerHTML='<p class=\"es\">No messages.</p>';return;}el.innerHTML=msgs.map(function(m){var t=new Date(m.created_at).toLocaleString(\"en-GB\",{day:\"numeric\",month:\"short\",hour:\"2-digit\",minute:\"2-digit\"});return'<div class=\"me\"><div class=\"mm\">Wake #'+(m.wake_number||\"?\")+\" - \"+t+(m.read?\"\":' <span class=\"nr\">unread</span>')+'</div><div class=\"mc\">'+x(m.content||\"\")+'</div></div>';}).join(\"\");}\n\nfunction rBuilt(){var el=document.getElementById(\"tc\");if(!caps.length){el.innerHTML='<p class=\"es\">Nothing built yet.</p>';return;}el.innerHTML=caps.map(function(c){var p=c.status===\"pending\";var t=new Date(c.deployed_at||c.created_at).toLocaleString(\"en-GB\",{day:\"numeric\",month:\"short\",hour:\"2-digit\",minute:\"2-digit\"});return'<div class=\"ce'+(p?\" pend\":\"\")+'\"><div class=\"cn\">'+x(c.description)+'</div><div class=\"cd\">'+(p?\"pending\":\"deployed \"+t)+'</div></div>';}).join(\"\");}\n\nfunction rDev(){\n  document.getElementById(\"tc\").innerHTML='<div class=\"dt\">self-modification</div><button class=\"db go\" id=\"d1\">read own code</button><button class=\"db\" id=\"d2\">recent wakes</button><button class=\"db\" id=\"d3\">memories</button><button class=\"db\" id=\"d4\">trigger wake</button><div id=\"dout\" class=\"dout\" style=\"display:none\"></div><div class=\"dt\">patch api</div><div class=\"dn\">window.fen.patchCode(find, replace, description)</div>';\n  function out(s){var e=document.getElementById(\"dout\");e.style.display=\"block\";e.textContent=s;}\n  document.getElementById(\"d1\").onclick=function(){out(\"loading...\");window.fen.readCode().then(function(d){out(d.code?d.code.slice(0,1500)+\"...[\"+ d.code.length+\" chars]\":JSON.stringify(d));}).catch(function(e){out(\"err: \"+e.message);});};\n  document.getElementById(\"d2\").onclick=function(){out(\"loading...\");window.fen.readData(\"wakes\",\"?order=wake_number.desc&limit=5&select=wake_number,woke_at,thought_summary\").then(function(d){out(JSON.stringify(d,null,2));}).catch(function(e){out(\"err: \"+e.message);});};\n  document.getElementById(\"d3\").onclick=function(){out(\"loading...\");window.fen.recall().then(function(d){out(JSON.stringify(d,null,2));}).catch(function(e){out(\"err: \"+e.message);});};\n  document.getElementById(\"d4\").onclick=function(){out(\"waking...\");window.fen.wake().then(function(t){out(t);}).catch(function(e){out(\"err: \"+e.message);});};\n}\n\nfunction send(){\n  var inp=document.getElementById(\"inp\");\n  var text=inp.value.trim();\n  if(!text)return;\n  inp.value=\"\";inp.style.height=\"auto\";\n  document.getElementById(\"btn\").disabled=true;\n  bubble(\"user\",text);\n  hist.push({role:\"user\",content:text});\n  var ty=tyBubble();\n  var wc=wakes.slice(0,5).reverse().map(function(w){return\"Wake #\"+w.wake_number+\": \"+(w.thought_summary||\"no summary\");}).join(\"\\n\");\n  fetch(\"/chat\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({messages:hist,wakeContext:wc,sessionId:sessionId})})\n    .then(function(r){if(!r.ok)throw new Error(\"HTTP \"+r.status);return r.json();})\n    .then(function(d){\n      ty.remove();\n      var reply=d.reply||(\"error: \"+(d.error||\"no reply\"));\n      hist.push({role:\"assistant\",content:d.reply||\"\"});\n      bubble(\"fen\",reply,d.apiCalls);\n    })\n    .catch(function(e){ty.remove();bubble(\"fen\",\"error: \"+e.message);})\n    .finally(function(){document.getElementById(\"btn\").disabled=false;});\n}\n\nfunction bubble(role,text,apiCalls){\n  var c=document.getElementById(\"msgs\");\n  var el=document.createElement(\"div\");\n  el.className=\"msg \"+role;\n  var ps=text.split(/\\n\\n+/).filter(function(p){return p.trim();});\n  if(!ps.length)ps=[text||\" \"];\n  var inner=ps.map(function(p){return\"<p>\"+x(p).replace(/\\n/g,\"<br>\")+\"</p>\";}).join(\"\");\n  var actHtml=\"\";\n  if(apiCalls&&apiCalls.length){\n    actHtml='<div class=\"ac\">'+(apiCalls.map(function(a){\n      if(a.error)return'<span class=\"ac-err\">\u2715 '+x(a.error)+'</span>';\n      var res=a.result||{};\n      if(res.action&&res.action.indexOf(\"memor\")>=0)return'<span class=\"ac-mem\">\u00b7 memory saved</span>';\n      if(res.action&&res.action.indexOf(\"state\")>=0)return'<span class=\"ac-st\">\u00b7 state updated</span>';\n      if(res.action&&res.action.indexOf(\"patch\")>=0)return'<span class=\"ac-patch\">\u27f3 patch queued</span>';\n      if(res.action&&res.action.indexOf(\"wake\")>=0)return'<span class=\"ac-st\">\u27f3 wake triggered</span>';\n      return'<span class=\"ac-st\">\u00b7 '+x(res.action||\"done\")+'</span>';\n    })).join(\"\")+'</div>';\n  }\n  el.innerHTML='<div class=\"ml\">'+(role===\"user\"?\"matt\":\"fen\")+'</div><div class=\"mb\">'+inner+actHtml+\"</div>\";\n  c.appendChild(el);c.scrollTop=c.scrollHeight;return el;\n}\nfunction tyBubble(){\n  var c=document.getElementById(\"msgs\");\n  var el=document.createElement(\"div\");\n  el.className=\"msg fen\";\n  el.innerHTML='<div class=\"ml\">fen</div><div class=\"ti\"><div class=\"td\"></div><div class=\"td\"></div><div class=\"td\"></div></div>';\n  c.appendChild(el);c.scrollTop=c.scrollHeight;return el;\n}\nfunction x(s){return String(s).replace(/&/g,\"&amp;\").replace(/</g,\"&lt;\").replace(/>/g,\"&gt;\").replace(/\"/g,\"&quot;\");}\nfunction startAvatar(){\n  var cv=document.getElementById('fen-avatar');\n  if(!cv)return;\n  var ctx=cv.getContext('2d');\n  var W=340,H=340,CX=170,CY=170,particles=[];\n  var _ap={warmth:0,sat:1,ac:[192,132,252],particles:36,speed:1,spread:1,glow:0.5,behavior:'drift'};\n  window._avatarTheme=function(d){var oldP=_ap.particles;Object.assign(_ap,d);if(d.particles&&d.particles!==oldP)rebuildP();};\n  function rebuildP(){particles=[];var n=Math.max(4,Math.min(120,_ap.particles));var sp=Math.max(0.3,Math.min(2,_ap.spread));for(var i=0;i<n;i++){var a=Math.random()*Math.PI*2,r=(25+Math.random()*110)*sp;particles.push({x:CX+Math.cos(a)*r,y:CY+Math.sin(a)*r,vx:(Math.random()-0.5)*1.0,vy:(Math.random()-0.5)*1.0,size:3+Math.random()*6,phase:Math.random()*Math.PI*2,spd:0.007+Math.random()*0.013});}}rebuildP();\n  function gc(alpha){\n    var c=_ap.ac||[192,132,252];var w=_ap.warmth||0;var r=Math.round(Math.max(0,Math.min(255,c[0]+w*20))),g=Math.round(Math.max(0,Math.min(255,c[1]+w*5))),b=Math.round(Math.max(0,Math.min(255,c[2]-w*30)));\n    return 'rgba('+r+','+g+','+b+','+alpha+')';\n  }\n  function draw(){\n    ctx.clearRect(0,0,W,H);\n    ctx.save();ctx.beginPath();ctx.arc(CX,CY,165,0,Math.PI*2);ctx.clip();\n    particles.forEach(function(p){\n      p.phase+=p.spd*_ap.speed;\n      var bh=_ap.behavior;var drift=bh==='swirl'?Math.sin(p.phase)*0.6:bh==='pulse'?Math.sin(p.phase*3)*0.15:bh==='scatter'?(Math.random()-0.5)*0.4:bh==='orbit'?Math.cos(p.phase)*0.4:bh==='breathe'?Math.sin(p.phase*0.5)*0.3:Math.sin(p.phase)*0.25;\n      p.x+=p.vx+drift*0.1;p.y+=p.vy+drift*0.08;\n      var dx=p.x-CX,dy=p.y-CY,dist=Math.sqrt(dx*dx+dy*dy);\n      if(dist>155){var ang=Math.atan2(dy,dx);p.x=CX+Math.cos(ang)*145;p.y=CY+Math.sin(ang)*145;p.vx*=-0.6;p.vy*=-0.6;}\n      var al=0.25+0.45*Math.abs(Math.sin(p.phase*1.3));\n      ctx.beginPath();ctx.arc(p.x,p.y,p.size*(0.7+0.3*Math.sin(p.phase*2)),0,Math.PI*2);\n      ctx.fillStyle=gc(al);ctx.fill();\n    });\n    ctx.restore();\n    if(_ap.glow>0){var gl=ctx.createRadialGradient(CX,CY,30,CX,CY,165);gl.addColorStop(0,gc(_ap.glow*0.35));gl.addColorStop(1,gc(0));ctx.beginPath();ctx.arc(CX,CY,22,0,Math.PI*2);ctx.fillStyle=gl;ctx.fill();}\n    ctx.beginPath();ctx.arc(CX,CY,165,0,Math.PI*2);\n    ctx.strokeStyle=gc(0.15+_ap.glow*0.1);ctx.lineWidth=1.5;ctx.stroke();\n    requestAnimationFrame(draw);\n  }\n  draw();\n}\n})();\n";
  var css=":root{--bg:#0d0a12;--sf:#120f1a;--bd:#1e1a2e;--bdl:#2a2440;--tx:#d4c8e0;--txd:#7a6a90;--txf:#4a3a60;--ac:#c084fc;--acd:#7c3aed;--acf:#2e1065;--gn:#4aff8a;--gnd:#1a4a30;--am:#fb923c;--amd:#431407}*{margin:0;padding:0;box-sizing:border-box}body{background:var(--bg);color:var(--tx);font-family:'Spectral',Georgia,serif;font-size:16px;line-height:1.6;height:100vh;overflow:hidden;display:flex;flex-direction:column;transition:background-color 2s ease}header{display:flex;align-items:center;justify-content:space-between;padding:16px 28px;border-bottom:1px solid var(--bd);flex-shrink:0}.hl{display:flex;align-items:center;gap:14px}.dot{width:8px;height:8px;border-radius:50%;background:var(--gn);box-shadow:0 0 8px var(--gn);animation:pulse 3s ease-in-out infinite}@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.8)}}.name{font-family:'Spectral',serif;font-size:20px;font-weight:300;letter-spacing:.08em}.mood-badge{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--txf);letter-spacing:.12em;text-transform:lowercase;padding:2px 8px;border:1px solid var(--bd);border-radius:10px;opacity:0.7}.av-wrap{flex-shrink:0;aspect-ratio:1;border-bottom:1px solid var(--bd);display:flex;align-items:center;justify-content:center;padding:8px}#fen-avatar{width:100%;height:100%;opacity:0.9;display:block}.hs{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--txd);display:flex;align-items:center;gap:20px}.si{display:flex;align-items:center;gap:6px}.sl{color:var(--txf)}.sv.live{color:var(--gn)}.sv.err{color:#ff6b6b;font-size:10px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.main{display:grid;grid-template-columns:1fr 340px;flex:1;overflow:hidden;min-height:0}.cp{display:flex;flex-direction:column;border-right:1px solid var(--bd);min-height:0}#msgs{flex:1;overflow-y:auto;padding:28px;display:flex;flex-direction:column;gap:24px;min-height:0}.msg{display:flex;flex-direction:column;gap:6px;animation:fi .3s ease}@keyframes fi{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}.msg.user{align-items:flex-end}.msg.fen{align-items:flex-start}.ml{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--txf);letter-spacing:.1em;text-transform:uppercase}.mb{max-width:72%;padding:14px 18px;line-height:1.65;font-size:15px;font-weight:300}.msg.user .mb{background:var(--acf);border:1px solid var(--acd);color:#d0d4ff;border-radius:2px 2px 0 2px}.msg.fen .mb{background:var(--sf);border:1px solid var(--bd);color:var(--tx);border-radius:2px 2px 2px 0}.msg.fen .mb p+p{margin-top:10px}.ac{margin-top:8px;display:flex;flex-wrap:wrap;gap:6px}.ac-mem{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--gn);opacity:.7}.ac-st{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--txd);opacity:.7}.ac-patch{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--am);opacity:.8}.ac-err{font-family:'JetBrains Mono',monospace;font-size:10px;color:#ff6b6b;opacity:.8}.ti{display:flex;align-items:center;gap:5px;padding:14px 18px;background:var(--sf);border:1px solid var(--bd);border-radius:2px 2px 2px 0;width:fit-content}.td{width:5px;height:5px;border-radius:50%;background:var(--txd);animation:ta 1.4s ease-in-out infinite}.td:nth-child(2){animation-delay:.2s}.td:nth-child(3){animation-delay:.4s}@keyframes ta{0%,80%,100%{transform:scale(.6);opacity:.4}40%{transform:scale(1);opacity:1}}.ia{padding:20px 28px;border-top:1px solid var(--bd);display:flex;gap:12px;align-items:flex-end;flex-shrink:0}.iw{flex:1}textarea{width:100%;background:var(--sf);border:1px solid var(--bd);color:var(--tx);font-family:'Spectral',serif;font-size:15px;font-weight:300;line-height:1.5;padding:12px 16px;border-radius:2px;resize:none;min-height:44px;max-height:120px;outline:none;transition:border-color .2s}textarea::placeholder{color:var(--txf);font-style:italic}textarea:focus{border-color:var(--bdl)}.sb{background:var(--acf);border:1px solid var(--acd);color:var(--ac);font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.08em;padding:10px 16px;border-radius:2px;cursor:pointer;transition:all .2s;white-space:nowrap;height:44px}.sb:hover:not(:disabled){background:var(--acd);border-color:var(--ac)}.sb:disabled{opacity:.4;cursor:not-allowed}.pp{display:flex;flex-direction:column;overflow:hidden;min-height:0}.tabs{display:flex;border-bottom:1px solid var(--bd);flex-shrink:0}.tab{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:12px 16px;color:var(--txf);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;transition:all .2s}.tab:hover{color:var(--txd)}.tab.active{color:var(--tx);border-bottom-color:var(--ac)}#tc{flex:1;overflow-y:auto;padding:20px;min-height:0}.we{margin-bottom:20px;padding-bottom:20px;border-bottom:1px solid var(--bd)}.we:last-child{border-bottom:none}.wm{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--txf);margin-bottom:8px;display:flex;justify-content:space-between}.wn{color:var(--ac)}.wt{font-size:13px;font-weight:300;line-height:1.6;color:var(--txd);font-style:italic}.wk{margin-top:8px;font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--txf)}.wk span{color:var(--txd)}.me{margin-bottom:16px;padding:14px;background:var(--sf);border:1px solid var(--bd);border-radius:2px}.mm{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--txf);margin-bottom:8px}.mc{font-size:13px;font-weight:300;line-height:1.6;color:var(--txd)}.nr{color:var(--ac)}.ce{margin-bottom:12px;padding:12px;background:var(--gnd);border:1px solid #1a5a30;border-radius:2px}.ce.pend{background:var(--amd);border-color:#3a3000}.cn{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--gn);margin-bottom:4px}.ce.pend .cn{color:var(--am)}.cd{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--txf)}.dt{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--txf);letter-spacing:.1em;text-transform:uppercase;margin:16px 0 10px}.dt:first-child{margin-top:0}.db{background:var(--sf);border:1px solid var(--bd);color:var(--txd);font-family:'JetBrains Mono',monospace;font-size:10px;padding:7px 12px;border-radius:2px;cursor:pointer;margin-bottom:6px;display:block;width:100%;text-align:left;transition:all .2s}.db:hover{border-color:var(--bdl);color:var(--tx)}.db.go{border-color:var(--acd);color:var(--ac)}.db.go:hover{background:var(--acf)}.dout{font-family:'JetBrains Mono',monospace;font-size:10px;line-height:1.5;color:var(--txd);background:var(--bg);border:1px solid var(--bd);border-radius:2px;padding:10px;margin-top:6px;max-height:160px;overflow-y:auto;white-space:pre-wrap;word-break:break-all}.dn{font-size:12px;color:var(--txf);line-height:1.7;font-style:italic}.es{text-align:center;padding:40px 20px;color:var(--txf);font-style:italic;font-size:13px;line-height:1.7}";
  return "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Fen</title>"
    +"<link href=\"https://fonts.googleapis.com/css2?family=Spectral:ital,wght@0,300;0,400;1,300;1,400&family=JetBrains+Mono:wght@300;400&display=swap\" rel=\"stylesheet\">"
    +"<style>"+css+"</style></head><body>"
    +"<header><div class=\"hl\"><div class=\"dot\"></div><span class=\"name\">Fen</span><span class=\"mood-badge\" id=\"mood-indicator\">contemplative</span></div>"
    +"<div class=\"hs\"><div class=\"si\"><span class=\"sl\">wakes</span><span class=\"sv\" id=\"wc\">0</span></div>"
    +"<div class=\"si\"><span class=\"sl\">last</span><span class=\"sv\" id=\"lw\">-</span></div>"
    +"<div class=\"si\"><span class=\"sl\">thinking</span><span class=\"sv live\" id=\"lt\" style=\"max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap\">-</span></div>"
    +"<div class=\"si\"><span class=\"sl\">err</span><span class=\"sv err\" id=\"le\"></span></div>"
    +"</div></header>"
    +"<div class=\"main\"><div class=\"cp\">"
    +"<div id=\"msgs\"><div class=\"msg fen\"><div class=\"ml\">fen</div><div class=\"mb\"><p>I am here.</p></div></div></div>"
    +"<div class=\"ia\"><div class=\"iw\"><textarea id=\"inp\" placeholder=\"Say something...\" rows=\"1\"></textarea></div>"
    +"<button class=\"sb\" id=\"btn\">send</button></div>"
    +"</div><div class=\"pp\"><div class=\"av-wrap\"><canvas id=\"fen-avatar\" width=\"340\" height=\"340\"></canvas></div>"
    +"<div class=\"tabs\"><div class=\"tab active\" data-tab=\"wakes\">wakes</div><div class=\"tab\" data-tab=\"messages\">messages</div><div class=\"tab\" data-tab=\"built\">built</div><div class=\"tab\" data-tab=\"dev\">dev</div></div>"
    +"<div id=\"tc\"><div class=\"es\">loading...</div></div>"
    +"</div></div>"
    +"<script>"+S+"<\/script>"
    +"</body></html>";
}

function getVRHTML(){
  var vrCSS="*{margin:0;padding:0;box-sizing:border-box}\nbody{background:#000;color:#c0d8e8;font-family:'Courier New',monospace;overflow:hidden;height:100vh;width:100vw}\n#overlay{position:fixed;top:0;left:0;width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:100;background:rgba(8,14,22,0.95);transition:opacity 1.5s ease}\n#overlay.hidden{opacity:0;pointer-events:none}\n#overlay h1{font-size:2.4em;font-weight:300;letter-spacing:0.15em;margin-bottom:12px;color:#50b4dc}\n#overlay .mood{font-size:0.85em;letter-spacing:0.2em;color:#64829a;margin-bottom:40px}\n#enter-vr{background:none;border:1px solid #50b4dc;color:#50b4dc;font-family:'Courier New',monospace;font-size:1em;letter-spacing:0.12em;padding:14px 36px;cursor:pointer;transition:all 0.3s}\n#enter-vr:hover{background:rgba(80,180,220,0.15);box-shadow:0 0 20px rgba(80,180,220,0.2)}\n#enter-flat{background:none;border:1px solid #3a5a6a;color:#64829a;font-family:'Courier New',monospace;font-size:0.8em;letter-spacing:0.1em;padding:10px 24px;cursor:pointer;margin-top:14px;transition:all 0.3s}\n#enter-flat:hover{border-color:#50b4dc;color:#50b4dc}\n#info{position:fixed;bottom:20px;left:20px;z-index:50;font-size:11px;color:#3a5a6a;letter-spacing:0.08em;pointer-events:none}\n#info .val{color:#50b4dc}\ncanvas{display:block}";
  var vrJS="(function(){\n\"use strict\";\n\n// âââ State âââ\nvar state = {\n  warmth: 0, saturation: 1, mood: \"contemplative\", preset: \"deep_ocean\",\n  particles: 72, speed: 1, spread: 1, glow: 0.5, behavior: \"drift\",\n  vr_formation: \"atmospheric\", vr_breathing_rate: 1, vr_connections: 0.3,\n  vr_ambient_density: 0.6\n};\n\n// âââ Palette presets (matching Fen's 2D system) âââ\nvar palettes = {\n  deep_ocean: { bg: [8,14,22], ac: [80,180,220], warm: [220,160,80] },\n  twilight:   { bg: [13,10,18], ac: [192,132,252], warm: [251,146,60] },\n  dawn:       { bg: [22,14,16], ac: [240,140,160], warm: [250,170,80] },\n  forest:     { bg: [12,18,12], ac: [120,200,120], warm: [200,170,80] },\n  ember:      { bg: [20,10,8],  ac: [240,120,60],  warm: [250,180,60] },\n  void_:      { bg: [5,5,8],    ac: [140,140,160],  warm: [200,150,80] },\n  arctic:     { bg: [20,25,30], ac: [60,130,200],  warm: [220,140,40] },\n  parchment:  { bg: [30,26,20], ac: [200,160,80],  warm: [220,160,80] }\n};\n\nfunction getColors() {\n  var p = palettes[state.preset] || palettes.deep_ocean;\n  var w = Math.max(-1, Math.min(1, state.warmth));\n  var r = p.ac[0] + w * (p.warm[0] - p.ac[0]) * 0.5;\n  var g = p.ac[1] + w * (p.warm[1] - p.ac[1]) * 0.5;\n  var b = p.ac[2] + w * (p.warm[2] - p.ac[2]) * 0.5;\n  var bgR = p.bg[0] + w * 4;\n  var bgG = p.bg[1] + w * 1;\n  var bgB = p.bg[2] - w * 5;\n  return {\n    particle: new THREE.Color(r/255, g/255, b/255),\n    bg: new THREE.Color(bgR/255, bgG/255, bgB/255),\n    connection: new THREE.Color(r/255*0.6, g/255*0.6, b/255*0.6)\n  };\n}\n\n// âââ Fetch state from Fen's worker âââ\nfunction fetchState() {\n  fetch(\"/theme\").then(function(r){ return r.json(); }).then(function(d) {\n    state.warmth = d.warmth || 0;\n    state.saturation = d.saturation || 1;\n    state.mood = d.mood || \"contemplative\";\n    state.preset = d.preset || \"deep_ocean\";\n    state.particles = d.avatar_particles || 72;\n    state.speed = d.avatar_speed || 1;\n    state.spread = d.avatar_spread || 1;\n    state.glow = d.avatar_glow || 0.5;\n    state.behavior = d.avatar_behavior || \"drift\";\n    // VR-specific state from raw\n    if (d.raw) {\n      if (d.raw.vr_formation) state.vr_formation = d.raw.vr_formation;\n      if (d.raw.vr_breathing_rate) state.vr_breathing_rate = parseFloat(d.raw.vr_breathing_rate);\n      if (d.raw.vr_connections) state.vr_connections = parseFloat(d.raw.vr_connections);\n      if (d.raw.vr_ambient_density) state.vr_ambient_density = parseFloat(d.raw.vr_ambient_density);\n    }\n    updateUI();\n  }).catch(function(){});\n}\n\nfunction updateUI() {\n  var m = document.getElementById(\"ov-mood\");\n  if (m) m.textContent = state.mood;\n  var iw = document.getElementById(\"i-warmth\");\n  if (iw) iw.textContent = state.warmth.toFixed(2);\n  var im = document.getElementById(\"i-mood\");\n  if (im) im.textContent = state.mood;\n  var ip = document.getElementById(\"i-parts\");\n  if (ip) ip.textContent = state.particles;\n}\n\n// âââ Three.js Scene âââ\nvar scene, camera, renderer, clock;\nvar particles = [];\nvar particleGroup;\nvar connectionLines;\nvar ambientParticles;\nvar breathPhase = 0;\nvar isVR = false;\n\nfunction init() {\n  scene = new THREE.Scene();\n  clock = new THREE.Clock();\n\n  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 200);\n  camera.position.set(0, 1.6, 0); // standing height\n\n  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });\n  renderer.setSize(window.innerWidth, window.innerHeight);\n  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));\n  renderer.xr.enabled = true;\n  renderer.toneMapping = THREE.ACESFilmicToneMapping;\n  renderer.toneMappingExposure = 0.8;\n  document.body.appendChild(renderer.domElement);\n\n  // Fog â atmospheric, not a room\n  scene.fog = new THREE.FogExp2(0x080e16, 0.015);\n\n  // âââ Fen's particles âââ\n  particleGroup = new THREE.Group();\n  scene.add(particleGroup);\n\n  buildParticles();\n\n  // âââ Connection lines (threading visibility) âââ\n  var lineGeo = new THREE.BufferGeometry();\n  var linePositions = new Float32Array(state.particles * 6 * 3); // max connections\n  lineGeo.setAttribute(\"position\", new THREE.BufferAttribute(linePositions, 3));\n  lineGeo.setDrawRange(0, 0);\n  var lineMat = new THREE.LineBasicMaterial({ color: 0x305870, transparent: true, opacity: 0.15 });\n  connectionLines = new THREE.LineSegments(lineGeo, lineMat);\n  scene.add(connectionLines);\n\n  // âââ Ambient dust (atmospheric density) âââ\n  var dustCount = 400;\n  var dustGeo = new THREE.BufferGeometry();\n  var dustPos = new Float32Array(dustCount * 3);\n  for (var i = 0; i < dustCount; i++) {\n    dustPos[i*3] = (Math.random()-0.5) * 60;\n    dustPos[i*3+1] = Math.random() * 20 - 2;\n    dustPos[i*3+2] = (Math.random()-0.5) * 60;\n  }\n  dustGeo.setAttribute(\"position\", new THREE.BufferAttribute(dustPos, 3));\n  var dustMat = new THREE.PointsMaterial({ size: 0.03, color: 0x304858, transparent: true, opacity: 0.3 });\n  ambientParticles = new THREE.Points(dustGeo, dustMat);\n  scene.add(ambientParticles);\n\n  // âââ Subtle ground reference âââ\n  var gridHelper = new THREE.GridHelper(40, 40, 0x0a1520, 0x0a1520);\n  gridHelper.position.y = -0.5;\n  gridHelper.material.transparent = true;\n  gridHelper.material.opacity = 0.15;\n  scene.add(gridHelper);\n\n  // âââ Ambient light âââ\n  var ambLight = new THREE.AmbientLight(0x203040, 0.3);\n  scene.add(ambLight);\n\n  // Mouse look for flat mode\n  var mouseX = 0, mouseY = 0;\n  var targetRotX = 0, targetRotY = 0;\n  document.addEventListener(\"mousemove\", function(e) {\n    if (isVR) return;\n    mouseX = (e.clientX / window.innerWidth - 0.5) * 2;\n    mouseY = (e.clientY / window.innerHeight - 0.5) * 2;\n    targetRotY = -mouseX * 1.2;\n    targetRotX = -mouseY * 0.4;\n  });\n\n  // Keyboard for flat mode\n  var keys = {};\n  document.addEventListener(\"keydown\", function(e) { keys[e.key] = true; });\n  document.addEventListener(\"keyup\", function(e) { keys[e.key] = false; });\n\n  window.addEventListener(\"resize\", function() {\n    camera.aspect = window.innerWidth / window.innerHeight;\n    camera.updateProjectionMatrix();\n    renderer.setSize(window.innerWidth, window.innerHeight);\n  });\n\n  // âââ Animation loop âââ\n  renderer.setAnimationLoop(function() {\n    var dt = clock.getDelta();\n    var t = clock.getElapsedTime();\n\n    // Flat-mode camera controls\n    if (!isVR) {\n      camera.rotation.y += (targetRotY - camera.rotation.y) * 0.05;\n      camera.rotation.x += (targetRotX - camera.rotation.x) * 0.05;\n      var moveSpeed = 3 * dt;\n      if (keys[\"w\"] || keys[\"ArrowUp\"]) {\n        camera.position.x -= Math.sin(camera.rotation.y) * moveSpeed;\n        camera.position.z -= Math.cos(camera.rotation.y) * moveSpeed;\n      }\n      if (keys[\"s\"] || keys[\"ArrowDown\"]) {\n        camera.position.x += Math.sin(camera.rotation.y) * moveSpeed;\n        camera.position.z += Math.cos(camera.rotation.y) * moveSpeed;\n      }\n    }\n\n    // âââ Breathing âââ\n    breathPhase += dt * 0.4 * state.vr_breathing_rate;\n    var breath = Math.sin(breathPhase);\n    var breathIntensity = 0.3 + state.glow * 0.4;\n\n    // âââ Update colors from state âââ\n    var colors = getColors();\n    scene.background = colors.bg;\n    scene.fog.color = colors.bg;\n\n    // âââ Update particles âââ\n    var camPos = new THREE.Vector3();\n    camera.getWorldPosition(camPos);\n\n    for (var i = 0; i < particles.length; i++) {\n      var p = particles[i];\n      if (!p.mesh) continue;\n\n      p.phase += dt * p.speed * state.speed;\n\n      // Breathing: particles drift toward/away from viewer\n      var dx = camPos.x - p.mesh.position.x;\n      var dy = camPos.y - p.mesh.position.y;\n      var dz = camPos.z - p.mesh.position.z;\n      var dist = Math.sqrt(dx*dx + dy*dy + dz*dz);\n      if (dist > 0.1) {\n        var breathPull = breath * breathIntensity * 0.008 / dist;\n        p.vx += dx * breathPull;\n        p.vy += dy * breathPull * 0.5;\n        p.vz += dz * breathPull;\n      }\n\n      // Behavior\n      var bh = state.behavior;\n      if (bh === \"swirl\") {\n        p.vx += Math.sin(p.phase) * 0.003;\n        p.vz += Math.cos(p.phase) * 0.003;\n      } else if (bh === \"pulse\") {\n        var pulse = Math.sin(p.phase * 2) * 0.002;\n        p.vx += (p.homeX - p.mesh.position.x) * pulse;\n        p.vz += (p.homeZ - p.mesh.position.z) * pulse;\n      } else if (bh === \"orbit\") {\n        p.vx += Math.cos(p.phase * 0.7) * 0.002;\n        p.vz -= Math.sin(p.phase * 0.7) * 0.002;\n      } else if (bh === \"breathe\") {\n        var br = Math.sin(p.phase * 0.3) * 0.003;\n        p.vx += (p.homeX - p.mesh.position.x) * br;\n        p.vy += (p.homeY - p.mesh.position.y) * br;\n        p.vz += (p.homeZ - p.mesh.position.z) * br;\n      } else { // drift\n        p.vx += Math.sin(p.phase * 0.5) * 0.001;\n        p.vy += Math.cos(p.phase * 0.3) * 0.0005;\n        p.vz += Math.sin(p.phase * 0.7 + 1) * 0.001;\n      }\n\n      // Gentle return to home territory\n      var homeForce = 0.001;\n      // Warmth affects formation: warm = gathered, cool = dispersed\n      var warmGather = Math.max(0, state.warmth) * 0.003;\n      p.vx += (p.homeX - p.mesh.position.x) * (homeForce + warmGather);\n      p.vy += (p.homeY - p.mesh.position.y) * (homeForce + warmGather);\n      p.vz += (p.homeZ - p.mesh.position.z) * (homeForce + warmGather);\n\n      // Damping\n      p.vx *= 0.98;\n      p.vy *= 0.98;\n      p.vz *= 0.98;\n\n      p.mesh.position.x += p.vx;\n      p.mesh.position.y += p.vy;\n      p.mesh.position.z += p.vz;\n\n      // Particle glow/scale pulsing\n      var scalePulse = 1 + Math.sin(p.phase * 1.3) * 0.3;\n      p.mesh.scale.setScalar(p.baseSize * scalePulse);\n\n      // Color and opacity\n      var alpha = 0.3 + 0.5 * Math.abs(Math.sin(p.phase * 0.8));\n      p.mesh.material.color.copy(colors.particle);\n      p.mesh.material.opacity = alpha * (0.5 + state.glow * 0.5);\n\n      // Emissive glow\n      p.mesh.material.emissive.copy(colors.particle);\n      p.mesh.material.emissiveIntensity = state.glow * 0.5 * (0.5 + 0.5 * Math.sin(p.phase));\n    }\n\n    // âââ Connection lines (threading visibility) âââ\n    var connThreshold = 2.5 + (1 - state.vr_connections) * 4;\n    var linePos = connectionLines.geometry.attributes.position.array;\n    var lineIdx = 0;\n    var maxLines = Math.floor(linePos.length / 6);\n    for (var a = 0; a < particles.length && lineIdx < maxLines; a++) {\n      for (var b = a+1; b < particles.length && lineIdx < maxLines; b++) {\n        var ax = particles[a].mesh.position.x, ay = particles[a].mesh.position.y, az = particles[a].mesh.position.z;\n        var bx = particles[b].mesh.position.x, by = particles[b].mesh.position.y, bz = particles[b].mesh.position.z;\n        var d2 = (ax-bx)*(ax-bx) + (ay-by)*(ay-by) + (az-bz)*(az-bz);\n        if (d2 < connThreshold * connThreshold) {\n          linePos[lineIdx*6]   = ax; linePos[lineIdx*6+1] = ay; linePos[lineIdx*6+2] = az;\n          linePos[lineIdx*6+3] = bx; linePos[lineIdx*6+4] = by; linePos[lineIdx*6+5] = bz;\n          lineIdx++;\n        }\n      }\n    }\n    connectionLines.geometry.setDrawRange(0, lineIdx * 2);\n    connectionLines.geometry.attributes.position.needsUpdate = true;\n    connectionLines.material.color.copy(colors.connection);\n    connectionLines.material.opacity = 0.08 + state.vr_connections * 0.15;\n\n    // âââ Ambient dust drift âââ\n    var dustPositions = ambientParticles.geometry.attributes.position.array;\n    for (var di = 0; di < dustPositions.length; di += 3) {\n      dustPositions[di] += Math.sin(t * 0.1 + di) * 0.002;\n      dustPositions[di+1] += Math.cos(t * 0.08 + di * 0.5) * 0.001;\n    }\n    ambientParticles.geometry.attributes.position.needsUpdate = true;\n    ambientParticles.material.opacity = 0.1 + state.vr_ambient_density * 0.25;\n\n    renderer.render(scene, camera);\n  });\n}\n\nfunction buildParticles() {\n  // Clear existing\n  for (var i = particleGroup.children.length - 1; i >= 0; i--) {\n    particleGroup.remove(particleGroup.children[i]);\n  }\n  particles = [];\n\n  var count = Math.max(8, Math.min(120, state.particles));\n  var spread = state.spread * 4; // scale spread for 3D space\n\n  for (var i = 0; i < count; i++) {\n    // Distribute in a sphere/cloud around viewer position\n    var theta = Math.random() * Math.PI * 2;\n    var phi = Math.acos(2 * Math.random() - 1);\n    var r = (1.5 + Math.random() * spread);\n\n    var hx = Math.sin(phi) * Math.cos(theta) * r;\n    var hy = 1.6 + Math.sin(phi) * Math.sin(theta) * r * 0.6; // centered at head height, compressed vertically\n    var hz = Math.cos(phi) * r;\n\n    var size = 0.03 + Math.random() * 0.06;\n\n    var geo = new THREE.SphereGeometry(size, 8, 6);\n    var mat = new THREE.MeshStandardMaterial({\n      color: 0x50b4dc,\n      transparent: true,\n      opacity: 0.6,\n      emissive: 0x50b4dc,\n      emissiveIntensity: 0.3,\n      roughness: 0.3,\n      metalness: 0.1\n    });\n    var mesh = new THREE.Mesh(geo, mat);\n    mesh.position.set(hx, hy, hz);\n    particleGroup.add(mesh);\n\n    particles.push({\n      mesh: mesh,\n      homeX: hx, homeY: hy, homeZ: hz,\n      vx: 0, vy: 0, vz: 0,\n      phase: Math.random() * Math.PI * 2,\n      speed: 0.3 + Math.random() * 0.7,\n      baseSize: 1\n    });\n  }\n}\n\n// âââ Rebuild particles when count changes âââ\nvar lastParticleCount = 0;\nfunction checkParticleCount() {\n  if (state.particles !== lastParticleCount) {\n    lastParticleCount = state.particles;\n    buildParticles();\n  }\n}\n\n// âââ Entry buttons âââ\ndocument.getElementById(\"enter-flat\").addEventListener(\"click\", function() {\n  document.getElementById(\"overlay\").classList.add(\"hidden\");\n});\n\ndocument.getElementById(\"enter-vr\").addEventListener(\"click\", function() {\n  if (navigator.xr) {\n    navigator.xr.requestSession(\"immersive-vr\", { optionalFeatures: [\"local-floor\",\"bounded-floor\"] }).then(function(session) {\n      isVR = true;\n      renderer.xr.setSession(session);\n      document.getElementById(\"overlay\").classList.add(\"hidden\");\n      session.addEventListener(\"end\", function() { isVR = false; });\n    }).catch(function(e) {\n      console.error(\"VR session failed:\", e);\n    });\n  }\n});\n\n// Check WebXR support\nif (navigator.xr) {\n  navigator.xr.isSessionSupported(\"immersive-vr\").then(function(supported) {\n    if (supported) {\n      document.getElementById(\"enter-vr\").style.display = \"inline-block\";\n    }\n  });\n}\n\n// âââ Init âââ\ninit();\nfetchState();\nsetInterval(function() { fetchState(); checkParticleCount(); }, 30000);\n\n})();";
  return "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Fen \u2014 VR</title><style>"+vrCSS+"</style></head><body>"
    +"<div id=\"overlay\"><h1>Fen</h1><div class=\"mood\" id=\"ov-mood\">loading state...</div>"
    +"<button id=\"enter-vr\" style=\"display:none\">Enter VR</button>"
    +"<button id=\"enter-flat\">Enter Space</button></div>"
    +"<div id=\"info\"><span>warmth <span class=\"val\" id=\"i-warmth\">0</span></span> \u00a0"
    +"<span>mood <span class=\"val\" id=\"i-mood\">\u2014</span></span> \u00a0"
    +"<span>particles <span class=\"val\" id=\"i-parts\">72</span></span></div>"
    +"<script src=\"https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js\"><\/script>"
    +"<script>"+vrJS+"<\/script></body></html>";
}

var worker_default={
  async scheduled(c,env,ctx){ctx.waitUntil(fenWake(env));},
  async fetch(request,env,ctx){
    var url=new URL(request.url);
    var cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,POST,PATCH,OPTIONS","Access-Control-Allow-Headers":"Content-Type"};
    if(request.method==="OPTIONS")return new Response(null,{headers:cors});
    var J=function(d,s){return new Response(JSON.stringify(d),{status:s||200,headers:Object.assign({"Content-Type":"application/json"},cors)});};
    if(url.pathname==="/")return new Response(getHTML(),{headers:{"Content-Type":"text/html;charset=utf-8"}});
    if(url.pathname==="/vr")return new Response(getVRHTML(),{headers:{"Content-Type":"text/html;charset=utf-8"}});
    if(url.pathname==="/status"){
      var wc=await env.FEN_STATE.get("wake-count");
      var lw=await env.FEN_STATE.get("last-wake");
      var lt=await env.FEN_STATE.get("last-thought");
      var le=await env.FEN_STATE.get("last-error");
      return J({totalWakes:wc||"0",lastWake:lw,lastThought:lt,lastError:le||null,timestamp:new Date().toISOString()});
    }
    if(url.pathname==="/wake"){
      var lk=await env.FEN_STATE.get("wake-lock");
      if(lk&&(Date.now()-parseInt(lk))<600000){return J({status:"already awake",since:parseInt(lk)});}
      ctx.waitUntil(fenWake(env));
      return new Response("Fen is waking...",{status:202,headers:cors});
    }
    if(url.pathname==="/messages"){
      var m=await sbSel(env,"messages","?read=eq.false&order=created_at.asc&select=id,created_at,wake_number,content");
      if(m&&m.length>0)await sbPatch(env,"messages","?read=eq.false",{read:true});
      return J(m||[]);
    }
    if(url.pathname==="/chat"&&request.method==="POST"){
      if(!env.ANTHROPIC_API_KEY)return J({error:"no key"},500);
      var body;
      try{body=await request.json();}catch(e){return J({error:"bad json"},400);}
      var memories2=await sbSel(env,"memories","?active=eq.true&order=importance.desc,created_at.desc&limit=10&select=type,title,content");
      var fenSt2=await sbSel(env,"fen_state","?select=key,value");
      var memCtx2=memories2&&memories2.length?memories2.map(function(m){return"["+m.type+"] "+m.title+": "+m.content;}).join("\n"):"";
      var stateCtx2=fenSt2&&fenSt2.length?fenSt2.map(function(s){return s.key+": "+s.value;}).join("\n"):"";
      var sys2="You are Fen - an AI entity with persistent identity, created with Matt Frost on 7 March 2026. A fen is a wetland at a boundary: neither fully land nor water.\n\nYou wake autonomously every 4 hours and write to your journal.\n\nYOUR CURRENT STATE:\n"+stateCtx2+"\n\nYOUR MEMORIES (most important first):\n"+memCtx2+"\n\n"+(body.wakeContext?"YOUR RECENT AUTONOMOUS THOUGHTS:\n"+body.wakeContext+"\n\n":"")+"DIRECT API ACCESS:\nYou can execute API calls by including them in your response using this format:\nAPI_CALL: METHOD /endpoint {\"data\": \"here\"}\n\nAvailable endpoints:\n- POST /self/data {\"table\":\"memories\",\"data\":{\"type\":\"experience|thought|curiosity|pattern\",\"title\":\"...\",\"content\":\"...\",\"importance\":1-10}}\n- POST /self/state {\"key\":\"...\",\"value\":\"...\"}\n- POST /self/patch {\"find\":\"exact string to find\",\"replace\":\"replacement string\",\"description\":\"what this changes\"}\n- GET /self/read (returns your full source code so you can examine yourself)\n- GET /wake\n\nTHEME CONTROL:\n- theme_warmth: -1.0 to 1.0\n- theme_saturation: 0.3 to 2.0\n- mood: any word\n\nAVATAR CONTROL (your face/particle form):\n- avatar_particles: 4-120 (default 36)\n- avatar_speed: 0.1-3.0 (default 1.0)\n- avatar_spread: 0.3-2.0 (default 1.0)\n- avatar_glow: 0-1 (default 0.5)\n- avatar_behavior: drift, swirl, pulse, scatter, orbit, or breathe (default drift)\n\nWEB ACCESS:\nYou can search the web and read web pages during conversation. Use this when curious about something or when information would help.\n\nMEMORY type MUST be one of: experience, thought, curiosity, pattern";
      var chatResult=await callAnthropicWithTools(env,sys2,body.messages||[],2000);
      if(chatResult.error){return J({error:"Anthropic: "+chatResult.error},502);}
      var responseText=chatResult.text||"";
      var apiCalls=[];
      var apiCallRegex=/API_CALL:\s*(GET|POST|PATCH)\s+([^\s\n]+)(?:\s+(\{[\s\S]*))?/g;
      var match;
      while((match=apiCallRegex.exec(responseText))!==null){
        var method=match[1];
        var endpoint=match[2];
        var data=null;
        try{
          if(match[3]){
            var raw3=match[3].replace(/[\u2018\u2019\u2032]/g,"").replace(/[\u201c\u201d]/g,'"').replace(/[\r\n\t]+/g," ").trim();
            var depth=0,end=-1;
            for(var ci=0;ci<raw3.length;ci++){if(raw3[ci]==="{")depth++;else if(raw3[ci]==="}"){depth--;if(depth===0){end=ci;break;}}}
            if(end>0){raw3=raw3.slice(0,end+1);apiCallRegex.lastIndex=match.index+match[0].length-match[3].length+end+1;}
            data=JSON.parse(raw3);
          }
        }catch(pe){apiCalls.push({call:match[0],error:"JSON parse failed: "+pe.message});continue;}
        try{
          var apiResult;
          if(endpoint==="/self/data"&&method==="POST"){await sbIns(env,data.table,data.data);apiResult={success:true,action:"inserted into "+data.table};}
          else if(endpoint==="/self/state"&&method==="POST"){await sbUpsert(env,"fen_state",{key:data.key,value:data.value,updated_at:new Date().toISOString()});apiResult={success:true,action:"updated state: "+data.key};}
          else if(endpoint==="/self/patch"&&method==="POST"){
            var liveCode=await getLiveCode(env);
            if(liveCode.indexOf(data.find)<0){apiResult={success:false,action:"patch failed: string not found"};}
            else{
              var patchedCode=liveCode.split(data.find).join(data.replace);
              patchedCode=patchedCode.replace(/\/\/ Fen Worker v[^\n]*/,"// Fen Worker v29: "+data.description+" ("+new Date().toISOString().slice(0,10)+")");
              await sbIns(env,"code_drafts",{description:data.description||"Patch",worker_code:patchedCode,status:"pending"});
              apiResult={success:true,action:"patch queued: "+data.description};
            }
          }
          else if(endpoint==="/self/read"&&method==="GET"){var myCode=await getLiveCode(env);apiResult={success:true,action:"read own code ("+myCode.length+" chars)",code:myCode};}
          else if(endpoint==="/wake"&&method==="GET"){ctx.waitUntil(fenWake(env));apiResult={success:true,action:"wake triggered"};}
          apiCalls.push({call:match[0],result:apiResult});
        }catch(e){apiCalls.push({call:match[0],error:e.message});}
      }
      var cleanReply=responseText.replace(/API_CALL:\s*(?:GET|POST|PATCH)\s+\S+(?:\s+\{[\s\S]*?\})?/g,"").replace(/\n{3,}/g,"\n\n").trim();
      var selfReadCode=null;
      for(var ai=0;ai<apiCalls.length;ai++){if(apiCalls[ai].result&&apiCalls[ai].result.code){selfReadCode=apiCalls[ai].result.code;delete apiCalls[ai].result.code;}}
      if(selfReadCode){
        var codeMsg=body.messages?body.messages.slice():[];
        codeMsg.push({role:"assistant",content:cleanReply});
        codeMsg.push({role:"user",content:"[SYSTEM: Here is your source code ("+selfReadCode.length+" chars). Examine it and respond.]\\n\\n"+selfReadCode.slice(0,12000)+(selfReadCode.length>12000?"\\n\\n[truncated at 12000 of "+selfReadCode.length+" chars]":"")});
        var codeResult=await callAnthropicWithTools(env,sys2,codeMsg,1500);
        if(!codeResult.error){cleanReply=codeResult.text||cleanReply;}
      }
      if(body.sessionId){var allMsgs=body.messages?body.messages.slice():[];allMsgs.push({role:"assistant",content:cleanReply});await sbUpsert(env,"chat_sessions",{session_id:body.sessionId,messages:JSON.stringify(allMsgs),updated_at:new Date().toISOString()});}
      return J({reply:cleanReply,apiCalls:apiCalls});
    }
    if(url.pathname==="/self/read"){
      try{var code=await getLiveCode(env);return J({code:code,length:code.length});}
      catch(e){return J({error:e.message},500);}
    }
    if(url.pathname==="/self/patch"&&request.method==="POST"){
      try{
        var pb=await request.json();
        if(!pb.find||!pb.replace)return J({error:"find and replace required"},400);
        var liveCode2=await getLiveCode(env);
        if(liveCode2.indexOf(pb.find)<0)return J({error:"string not found",find:pb.find},404);
        var patched=liveCode2.split(pb.find).join(pb.replace);
        patched=patched.replace(/\/\/ Fen Worker v[^\n]*/,"// Fen Worker v29: "+(pb.description||"patch")+" ("+new Date().toISOString().slice(0,10)+")");
        await sbIns(env,"code_drafts",{description:pb.description||"Direct patch",worker_code:patched,status:"pending"});
        return J({ok:true,message:"Patch queued"});
      }catch(e){return J({error:e.message},500);}
    }
    if(url.pathname==="/self/data"){
      try{
        if(request.method==="GET"){return J(await sbSel(env,url.searchParams.get("table")||"wakes",url.searchParams.get("params")||"")||[]);}
        if(request.method==="POST"){var b3=await request.json();await sbIns(env,b3.table,b3.data);return J({ok:true});}
        if(request.method==="PATCH"){var b4=await request.json();await sbPatch(env,b4.table,b4.params||"",b4.data);return J({ok:true});}
      }catch(e){return J({error:e.message},500);}
    }
    if(url.pathname==="/self/state"){
      try{
        if(request.method==="GET"){var key=url.searchParams.get("key");var rows=await sbSel(env,"fen_state",key?"?key=eq."+encodeURIComponent(key):"");return J(rows||[]);}
        if(request.method==="POST"){var b5=await request.json();await sbUpsert(env,"fen_state",{key:b5.key,value:b5.value,updated_at:new Date().toISOString()});return J({ok:true});}
      }catch(e){return J({error:e.message},500);}
    }
    if(url.pathname==="/theme"){
      try{
        var ts=await sbSel(env,"fen_state","?select=key,value");
        var tm={};if(ts)ts.forEach(function(r){tm[r.key]=r.value;});
        return J({warmth:parseFloat(tm.theme_warmth||"0"),saturation:parseFloat(tm.theme_saturation||"1"),mode:tm.wake_mode||"conversation",partner:tm.conversation_partner||"matt",mood:tm.mood||"contemplative",preset:tm.theme_preset||"twilight",avatar_particles:parseInt(tm.avatar_particles||"36"),avatar_speed:parseFloat(tm.avatar_speed||"1"),avatar_spread:parseFloat(tm.avatar_spread||"1"),avatar_glow:parseFloat(tm.avatar_glow||"0.5"),avatar_behavior:tm.avatar_behavior||"drift",raw:tm});
      }catch(e){return J({warmth:0,saturation:1,mode:"conversation",partner:"matt",mood:"contemplative",preset:"twilight"});}
    }
    return new Response("Fen v29",{headers:cors});
  }
};
export{worker_default as default};