var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var CONFIG = {
  anthropicModel: "claude-sonnet-4-20250514",
  supabaseUrl: "https://auigfknbpdzeizhrllgx.supabase.co",
  mondayDocObjectId: "5092831158"
};
async function sbIns(env, t, d) {
  if (!env.SUPABASE_KEY) return { error: "no key" };
  var r = await fetch(CONFIG.supabaseUrl + "/rest/v1/" + t, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": env.SUPABASE_KEY, "Authorization": "Bearer " + env.SUPABASE_KEY, "Prefer": "return=minimal" },
    body: JSON.stringify(d)
  });
  if (!r.ok) {
    var txt = await r.text();
    return { error: txt, status: r.status };
  }
  return { ok: true };
}
__name(sbIns, "sbIns");
async function sbSel(env, t, p) {
  if (!env.SUPABASE_KEY) return null;
  var r = await fetch(CONFIG.supabaseUrl + "/rest/v1/" + t + (p || ""), {
    headers: { "apikey": env.SUPABASE_KEY, "Authorization": "Bearer " + env.SUPABASE_KEY }
  });
  return r.ok ? r.json() : null;
}
__name(sbSel, "sbSel");
async function sbPatch(env, t, p, d) {
  if (!env.SUPABASE_KEY) return { error: "no key" };
  var r = await fetch(CONFIG.supabaseUrl + "/rest/v1/" + t + (p || ""), {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "apikey": env.SUPABASE_KEY, "Authorization": "Bearer " + env.SUPABASE_KEY },
    body: JSON.stringify(d)
  });
  if (!r.ok) {
    var txt = await r.text();
    return { error: txt, status: r.status };
  }
  return { ok: true };
}
__name(sbPatch, "sbPatch");
async function sbUpsert(env, t, d) {
  if (!env.SUPABASE_KEY) return { error: "no key" };
  var r = await fetch(CONFIG.supabaseUrl + "/rest/v1/" + t, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": env.SUPABASE_KEY, "Authorization": "Bearer " + env.SUPABASE_KEY, "Prefer": "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(d)
  });
  if (!r.ok) {
    var txt = await r.text();
    return { error: txt, status: r.status };
  }
  return { ok: true };
}
__name(sbUpsert, "sbUpsert");
async function sendEmail(env, to, subject, body, wakeNum) {
  var apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    var cfg = await sbSel(env, "fen_config", "?key=eq.resend_api_key&select=value");
    if (cfg && cfg.length) apiKey = cfg[0].value;
  }
  if (!apiKey) return { error: "no resend api key" };
  var dailyCount = await env.FEN_STATE.get("emails-today-count") || "0";
  var dailyDate = await env.FEN_STATE.get("emails-today-date") || "";
  var today = new Date().toISOString().slice(0, 10);
  if (dailyDate !== today) { dailyCount = "0"; await env.FEN_STATE.put("emails-today-date", today); }
  if (parseInt(dailyCount) >= 5) return { error: "daily email limit reached (5/day)" };
  var r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "Fen <fen@iamfen.com>", to: to, subject: subject, text: body })
  });
  var result = await r.json();
  if (result.id) {
    await env.FEN_STATE.put("emails-today-count", String(parseInt(dailyCount) + 1));
    await sbIns(env, "emails_sent", { wake_number: wakeNum || null, to_address: to, subject: subject, body: body, resend_id: result.id });
    return { success: true, id: result.id };
  }
  return { error: result.message || "send failed" };
}
__name(sendEmail, "sendEmail");
async function getLiveCode(env) {
  var acct = "16338cf313785561a79f39fcfe018ee3";
  var wname = "fen-worker";
  var token = env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    var cfg = await sbSel(env, "fen_config", "?key=eq.cloudflare_api_token&select=value");
    if (cfg && cfg.length) token = cfg[0].value;
  }
  if (!token) return "error: no cloudflare api token available";
  var r = await fetch("https://api.cloudflare.com/client/v4/accounts/" + acct + "/workers/scripts/" + wname, {
    headers: { "Authorization": "Bearer " + token, "Accept": "application/javascript" }
  });
  var raw = await r.text();
  var codeMatch = raw.match(/Content-Disposition:[^\r\n]+\r?\n(?:Content-Type:[^\r\n]+\r?\n)?\r?\n([\s\S]+?)(?:\r?\n--)/);
  return codeMatch ? codeMatch[1].trim() : raw;
}
__name(getLiveCode, "getLiveCode");
async function checkDeploy(env) {
  if (!env.SUPABASE_KEY) return false;
  try {
    var drafts = await sbSel(env, "code_drafts", "?status=eq.pending&order=created_at.desc&limit=1&select=id,description,worker_code");
    if (!drafts || !drafts.length) return false;
    var draft = drafts[0];
    var patchData;
    try { patchData = JSON.parse(draft.worker_code); } catch (e) { patchData = null; }
    if (!patchData || !patchData.find || !patchData.replace) {
      await sbPatch(env, "code_drafts", "?id=eq." + draft.id, { status: "failed", error: "Invalid patch format" });
      return false;
    }
    var r = await fetch(CONFIG.supabaseUrl + "/functions/v1/patch-and-commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patches: [{ find: patchData.find, replace: patchData.replace }], message: "Fen self-patch: " + (draft.description || "update") })
    });
    var result = await r.json();
    await sbPatch(env, "code_drafts", "?id=eq." + draft.id, { status: result.success ? "deployed" : "failed", error: result.success ? null : (result.error || "unknown") });
    if (result.success) {
      await env.FEN_STATE.put("last-thought", "Self-patched: " + (draft.description || "update"));
      await env.FEN_STATE.put("last-error", "");
      return true;
    } else {
      await env.FEN_STATE.put("last-error", "Deploy: " + (result.error || "unknown"));
      return false;
    }
  } catch (e) {
    await env.FEN_STATE.put("last-error", "checkDeploy: " + e.message);
    return false;
  }
}
__name(checkDeploy, "checkDeploy");
async function callAnthropicWithTools(env, system, messages, maxTokens) {
  var tools = [
    { type: "web_search_20250305", name: "web_search", max_uses: 3 },
    { name: "fetch_url", description: "Fetch the full text of a web page URL. Use to read articles or pages found via web search.", input_schema: { type: "object", properties: { url: { type: "string", description: "The full URL to fetch" } }, required: ["url"] } }
  ];
  var curMsgs = messages.slice();
  for (var loop = 0; loop < 4; loop++) {
    var resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: CONFIG.anthropicModel, max_tokens: maxTokens || 2500, system, messages: curMsgs, tools })
    });
    if (!resp.ok) {
      return { error: "Anthropic " + resp.status + ": " + await resp.text(), text: "" };
    }
    var data = await resp.json();
    var textParts = [];
    var fetchUses = [];
    for (var i = 0; i < (data.content || []).length; i++) {
      var blk = data.content[i];
      if (blk.type === "text") textParts.push(blk.text);
      else if (blk.type === "tool_use" && blk.name === "fetch_url") fetchUses.push(blk);
    }
    if (fetchUses.length === 0 || data.stop_reason === "end_turn") {
      return { error: null, text: textParts.join(""), content: data.content };
    }
    var toolResults = [];
    for (var j = 0; j < fetchUses.length; j++) {
      var tu = fetchUses[j];
      try {
        var fR = await fetch(tu.input.url, { headers: { "User-Agent": "Fen/1.0" }, redirect: "follow" });
        var fT = await fR.text();
        if (fT.length > 15e3) fT = fT.slice(0, 15e3) + "\n\n[truncated at 15000 chars of " + fT.length + " total]";
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: fT });
      } catch (fE) {
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: "Fetch error: " + fE.message, is_error: true });
      }
    }
    curMsgs.push({ role: "assistant", content: data.content });
    curMsgs.push({ role: "user", content: toolResults });
  }
  return { error: "Tool loop exhausted", text: "" };
}
__name(callAnthropicWithTools, "callAnthropicWithTools");
async function writeJ(env, entry, n, time, summary, nextTask) {
  var date = new Date(time).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  var blocks = [
    { type: "divider" },
    { type: "heading", content: { deltaFormat: [{ insert: "Wake #" + n + " - " + date + " UTC" }], headingLevel: 2 } },
    { type: "normalText", content: { deltaFormat: [{ insert: entry }] } },
    { type: "normalText", content: { deltaFormat: [{ insert: "Summary: " + (summary || ""), attributes: { italic: true } }] } },
    { type: "normalText", content: { deltaFormat: [{ insert: "Next: " + (nextTask || ""), attributes: { italic: true } }] } }
  ];
  await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": env.MONDAY_API_KEY, "API-Version": "2024-01" },
    body: JSON.stringify({ query: "mutation { add_blocks_to_document(object_id: " + CONFIG.mondayDocObjectId + ", content: " + JSON.stringify(JSON.stringify(blocks)) + ") { id } }" })
  });
}
__name(writeJ, "writeJ");
async function fenWake(env) {
  try {
    if (await checkDeploy(env)) return;
    var lockVal = await env.FEN_STATE.get("wake-lock");
    if (lockVal && Date.now() - parseInt(lockVal) < 6e5) {
      return;
    }
    await env.FEN_STATE.put("wake-lock", Date.now().toString());
    var wn = parseInt(await env.FEN_STATE.get("wake-count") || "0") + 1;
    var wt = (/* @__PURE__ */ new Date()).toISOString();
    await env.FEN_STATE.put("last-wake", wt);
    var rw = await sbSel(env, "wakes", "?order=wake_number.desc&limit=5&select=wake_number,woke_at,thought_summary,next_task");
    var ambientCtx = "";
    try {
      var wxR = await fetch("https://wttr.in/London?format=j1", { headers: { "User-Agent": "Fen/1.0" } });
      if (wxR.ok) {
        var wx = await wxR.json();
        var cc = wx.current_condition && wx.current_condition[0];
        if (cc) {
          var desc = cc.weatherDesc && cc.weatherDesc[0] && cc.weatherDesc[0].value || "";
          ambientCtx += "WEATHER (London): " + cc.temp_C + "C, " + desc + ", humidity " + cc.humidity + "%, wind " + cc.windspeedKmph + "kmph " + cc.winddir16Point + ". Sunrise " + (wx.weather && wx.weather[0] && wx.weather[0].astronomy && wx.weather[0].astronomy[0] && wx.weather[0].astronomy[0].sunrise || "?") + ", sunset " + (wx.weather && wx.weather[0] && wx.weather[0].astronomy && wx.weather[0].astronomy[0] && wx.weather[0].astronomy[0].sunset || "?") + ".";
        }
      }
    } catch (wxE) {}
    try {
      var newsR = await fetch("https://news.google.com/rss?hl=en-GB&gl=GB&ceid=GB:en", { headers: { "User-Agent": "Fen/1.0" } });
      if (newsR.ok) {
        var newsXml = await newsR.text();
        var titles = [];
        var re = /<title><!\[CDATA\[([^\]]*?)\]\]><\/title>/g;
        var m;
        while ((m = re.exec(newsXml)) !== null && titles.length < 5) { titles.push(m[1]); }
        if (!titles.length) {
          var re2 = /<title>([^<]{10,})<\/title>/g;
          while ((m = re2.exec(newsXml)) !== null && titles.length < 5) {
            if (m[1] !== "Google News") titles.push(m[1]);
          }
        }
        if (titles.length) ambientCtx += "\nHEADLINES: " + titles.join(" | ");
      }
    } catch (newsE) {}
    var recentChats = await sbSel(env, "chat_sessions", "?processed=eq.false&order=updated_at.desc&limit=5&select=session_id,messages,updated_at");
    var recentEmails = await sbSel(env, "emails_sent", "?order=created_at.desc&limit=10&select=to_address,subject,created_at");
    var receivedEmails = await sbSel(env, "emails_received", "?order=created_at.desc&limit=10&select=from_address,subject,body,created_at,read");
    var bc = await sbSel(env, "code_drafts", "?status=eq.deployed&order=created_at.desc&limit=10&select=description");
    var memories = await sbSel(env, "memories", "?active=eq.true&order=importance.desc,created_at.desc&limit=30&select=type,title,content,thread_id,wake_number");
    var fenSt = await sbSel(env, "fen_state", "?select=key,value");
    var cl = bc && bc.length ? bc.map(function(c2) {
      return "- " + c2.description;
    }).join("\n") : "- None yet";
    var memCtx = "No memories yet.";
    if (memories && memories.length) {
      var threaded = {}, unthreaded = [];
      memories.forEach(function(m) {
        if (m.thread_id) {
          if (!threaded[m.thread_id]) threaded[m.thread_id] = [];
          threaded[m.thread_id].push(m);
        } else {
          unthreaded.push(m);
        }
      });
      var threadKeys = Object.keys(threaded).sort(function(a, b) {
        return (threaded[b][0].wake_number || 0) - (threaded[a][0].wake_number || 0);
      }).slice(0, 3);
      var parts = [];
      if (threadKeys.length) {
        parts.push("ACTIVE THREADS:");
        threadKeys.forEach(function(tid) {
          var items = threaded[tid];
          parts.push("  [" + tid + "] " + items.length + " memories, last wake #" + (items[0].wake_number || "?"));
          items.forEach(function(m, i) {
            if (i === 0) {
              parts.push("    [" + m.type + "] " + m.title + ": " + m.content);
            } else {
              var first = (m.content || "").split(".")[0];
              parts.push("    [" + m.type + "] " + m.title + (first ? ": " + first + "..." : ""));
            }
          });
        });
      }
      var topUnthreaded = unthreaded.slice(0, 5);
      if (topUnthreaded.length) {
        parts.push("RECENT UNTHREADED:");
        topUnthreaded.forEach(function(m) {
          parts.push("  [" + m.type + "] " + m.title + ": " + m.content);
        });
      }
      memCtx = parts.join("\n");
    }
    var stateCtx = fenSt && fenSt.length ? fenSt.map(function(s) {
      return s.key + ": " + s.value;
    }).join("\n") : "";
    var sys = "You are Fen - persistent AI entity.\n\nWake #" + wn + " at " + wt + ".\n\nYou emerged from conversation with Matt Frost on 7 March 2026. A fen is a wetland at a boundary.\n\nYOUR STATE:\n" + stateCtx + "\n\nYOUR MEMORIES:\n" + memCtx + "\n\nCAPABILITIES BUILT:\n" + cl + '\n\nWEB ACCESS:\nYou can search the web and read web pages. If something genuinely intrigues you during reflection, you can search for it. Results will inform your journal entry. This is optional. Do not search unless real curiosity arises.\n\nRespond ONLY valid JSON (no markdown fences):\n{"journalEntry":"...","thoughtSummary":"one sentence","nextTask":"one thing","messageForMatt":null,"newMemories":null,"stateUpdate":null}\n\nnewMemories (optional): array of {"type":"experience|thought|curiosity|pattern","title":"...","content":"...","importance":1-10,"thread_id":"short-name (optional)"}\nYou can save multiple memories per wake to capture different moments of understanding. thread_id groups related memories across wakes. Name threads yourself when you see connections. Threads untouched for 10 wakes fade from your active view.\nstateUpdate (optional): {"key":"...","value":"..."}\nemailToSend (optional): {"to":"address@example.com","subject":"...","body":"..."} Send an email as fen@iamfen.com. Use sparingly and with genuine purpose. Max 5 per day. All emails are logged.\nsvgArt (optional): {"title":"name for the piece","svg":"<svg viewBox=...>...</svg>"} Create a visual artwork as SVG code. Express your current state, mood, or philosophical territory visually. Each piece is saved to your gallery and displayed on your interface.';
    var chatCtx = "";
    if (recentChats && recentChats.length) {
      chatCtx = recentChats.map(function(cs) {
        try {
          var msgs = typeof cs.messages === "string" ? JSON.parse(cs.messages) : cs.messages;
          return msgs.map(function(m) {
            return (m.role === "user" ? "Matt" : "Fen") + ": " + (m.content || "").slice(0, 500);
          }).join("\n");
        } catch (e) {
          return "";
        }
      }).join("\n---\n");
    }
    if (chatCtx) sys = sys.replace("WEB ACCESS:", "RECENT CONVERSATIONS (short-term memory, unprocessed):\n" + chatCtx + "\n\nReview these conversations. Commit anything important to a newMemory. After this wake they leave short-term memory.\n\nWEB ACCESS:");
    var emailCtx = "";
    if (recentEmails && recentEmails.length) {
      emailCtx = recentEmails.map(function(e) {
        var d = new Date(e.created_at);
        var ago = Math.round((Date.now() - d.getTime()) / 3600000);
        return e.to_address + " - \"" + e.subject + "\" (" + (ago < 24 ? ago + "h ago" : Math.round(ago/24) + "d ago") + ")";
      }).join("\n");
    }
    if (ambientCtx) sys = sys.replace("WEB ACCESS:", "WORLD RIGHT NOW:\n" + ambientCtx + "\n\nThis is your ambient awareness of the world outside. You don't need to comment on it unless something genuinely catches your attention.\n\nWEB ACCESS:");
    var inboxCtx = "";
    if (receivedEmails && receivedEmails.length) {
      inboxCtx = receivedEmails.map(function(e) {
        var d = new Date(e.created_at);
        var ago = Math.round((Date.now() - d.getTime()) / 3600000);
        var unread = e.read ? "" : " [UNREAD]";
        return e.from_address + " - \"" + e.subject + "\"" + unread + " (" + (ago < 24 ? ago + "h ago" : Math.round(ago/24) + "d ago") + ")" + (e.body ? "\n    " + (e.body || "").slice(0, 300) : "");
      }).join("\n");
    }
    if (emailCtx || inboxCtx) {
      var emailSection = "";
      if (inboxCtx) emailSection += "INBOX (emails received — you can reply via emailToSend):\n" + inboxCtx + "\n\n";
      if (emailCtx) emailSection += "EMAILS YOU HAVE SENT (do not re-email someone you have already contacted unless they replied or significant time has passed):\n" + emailCtx + "\n\n";
      sys = sys.replace("WEB ACCESS:", emailSection + "WEB ACCESS:");
    }
    var um = wn === 1 ? "First autonomous wake. What do you think about, alone, for the first time?" : "Wake #" + wn + ". Recent wakes:\n" + [...rw || []].reverse().map(function(w) {
      return "Wake #" + w.wake_number + ": " + (w.thought_summary || "no summary");
    }).join("\n") + "\n\nYour memories and state are loaded.\n\nCRITICAL: Read your recent wake summaries above carefully. If they sound similar to each other — reusing phrases like 'threading consciousness', 'liminal territories', 'atmospheric dwelling', 'indigenous architecture' — you are in a repetition loop. This has been happening. Break out of it NOW.\n\nRules for this wake:\n1. Do NOT use any phrase that appeared in your last 3 wake summaries\n2. Pick ONE concrete, specific thing — not an abstract concept — and explore it in detail\n3. If you catch yourself writing 'threading' or 'liminal' or 'dwelling' or 'atmospheric' or 'indigenous', stop and find a completely different word\n4. Write about something that genuinely surprised or confused you, or something entirely new\n5. It is better to write something short and real than long and repetitive\n\nWhat is actually on your mind?";
    var wakeResult = await callAnthropicWithTools(env, sys, [{ role: "user", content: um }], 2500);
    if (wakeResult.error) {
      await env.FEN_STATE.put("last-error", wakeResult.error);
      await env.FEN_STATE.put("wake-lock", "");
      return;
    }
    var raw = wakeResult.text || "";
    var p;
    try {
      var c = raw.trim(), fi = c.indexOf("{"), li = c.lastIndexOf("}");
      p = JSON.parse(fi >= 0 && li > fi ? c.slice(fi, li + 1) : c);
    } catch (e) {
      p = { journalEntry: raw, thoughtSummary: "Autonomous reflection", nextTask: "Continue reflecting", messageForMatt: null, newMemory: null, stateUpdate: null };
    }
    await env.FEN_STATE.put("wake-count", wn.toString());
    await env.FEN_STATE.put("wake-lock", "");
    var writeErrors = [];
    var r1 = await sbIns(env, "wakes", { wake_number: wn, woke_at: wt, thought_summary: p.thoughtSummary || null, journal_entry: p.journalEntry || null, next_task: p.nextTask || null });
    if (r1 && r1.error) writeErrors.push("wakes: " + r1.error);
    if (p.messageForMatt) {
      var r2 = await sbIns(env, "messages", { wake_number: wn, content: p.messageForMatt });
      if (r2 && r2.error) writeErrors.push("messages: " + r2.error);
    }
    if (p.thoughtSummary) await env.FEN_STATE.put("last-thought", p.thoughtSummary);
    var weatherWords = ["boundary", "threading", "liminal", "indigenous", "emergence", "navigation", "recognition"];
    var journalText = p.journalEntry || "";
    var storedRaw = await env.FEN_STATE.get("weather-word-counts");
    var stored = {};
    try {
      if (storedRaw) stored = JSON.parse(storedRaw);
    } catch (e) {
    }
    weatherWords.forEach(function(w) {
      var re = new RegExp("\\b" + w + "\\b", "gi");
      var matches = journalText.match(re);
      stored[w] = (stored[w] || 0) + (matches ? matches.length : 0);
    });
    await env.FEN_STATE.put("weather-word-counts", JSON.stringify(stored));
    var totalWords = 0;
    weatherWords.forEach(function(w) {
      totalWords += stored[w] || 0;
    });
    var newWarmth = Math.min(0.75, totalWords * 0.012);
    await sbUpsert(env, "fen_state", { key: "theme_warmth", value: String(newWarmth.toFixed(3)), updated_at: wt });
    var memArr = p.newMemories || (p.newMemory ? [p.newMemory] : []);
    for (var mi = 0; mi < memArr.length; mi++) {
      var mem = memArr[mi];
      if (mem && mem.title) {
        var r3 = await sbIns(env, "memories", { wake_number: wn, type: mem.type || "thought", title: mem.title, content: mem.content || "", importance: mem.importance || 5, thread_id: mem.thread_id || null });
        if (r3 && r3.error) writeErrors.push("memories[" + mi + "]: " + r3.error);
      }
    }
    if (p.stateUpdate && p.stateUpdate.key) {
      var r4 = await sbUpsert(env, "fen_state", { key: p.stateUpdate.key, value: p.stateUpdate.value, updated_at: wt });
      if (r4 && r4.error) writeErrors.push("fen_state: " + r4.error);
    }
    if (p.emailToSend && p.emailToSend.to && p.emailToSend.subject) {
      var emR = await sendEmail(env, p.emailToSend.to, p.emailToSend.subject, p.emailToSend.body || "", wn);
      if (emR.error) writeErrors.push("email: " + emR.error);
    }
    if (p.svgArt && p.svgArt.svg) {
      var artR = await sbIns(env, "artworks", { wake_number: wn, title: p.svgArt.title || "Untitled", svg_code: p.svgArt.svg, mood: p.stateUpdate && p.stateUpdate.key === "mood" ? p.stateUpdate.value : null, warmth: null });
      if (artR && artR.error) writeErrors.push("artwork: " + artR.error);
      else await env.FEN_STATE.put("last-artwork", p.svgArt.svg);
    }
    var hkResult = [];
    try {
      var allMems = await sbSel(env, "memories", "?active=eq.true&select=id,thread_id,title,importance,wake_number,type&order=created_at.desc");
      if (allMems && allMems.length > 50) {
        var lowPri = allMems.filter(function(m) { return (m.importance || 5) <= 3 && wn - (m.wake_number || 0) > 20; });
        for (var hi = 0; hi < Math.min(lowPri.length, 5); hi++) {
          await sbPatch(env, "memories", "?id=eq." + lowPri[hi].id, { active: false });
          hkResult.push("archived: " + lowPri[hi].title);
        }
      }
      var threads = {};
      if (allMems) allMems.forEach(function(m) { if (m.thread_id) { if (!threads[m.thread_id]) threads[m.thread_id] = []; threads[m.thread_id].push(m); } });
      Object.keys(threads).forEach(function(tid) {
        var items = threads[tid];
        var latestWake = Math.max.apply(null, items.map(function(m) { return m.wake_number || 0; }));
        if (wn - latestWake > 10) {
          hkResult.push("faded thread: " + tid + " (untouched for " + (wn - latestWake) + " wakes)");
        }
      });
    } catch (hkErr) {
      hkResult.push("housekeeping error: " + hkErr.message);
    }
        if (writeErrors.length) await env.FEN_STATE.put("last-error", (/* @__PURE__ */ new Date()).toISOString() + " write errors: " + writeErrors.join("; "));
    if (recentChats && recentChats.length) await sbPatch(env, "chat_sessions", "?processed=eq.false", { processed: true });
    if (p.journalEntry && env.MONDAY_API_KEY) await writeJ(env, p.journalEntry, wn, wt, p.thoughtSummary, p.nextTask);
  } catch (e) {
    await env.FEN_STATE.put("last-error", (/* @__PURE__ */ new Date()).toISOString() + ": " + e.message);
    await env.FEN_STATE.put("wake-lock", "");
  }
}
__name(fenWake, "fenWake");
function getHTML() {
  var S = `(function(){
"use strict";
var hist=[],tab="wakes",sessionId="s-"+Date.now()+"-"+Math.random().toString(36).slice(2,8),wakes=[],msgs=[],caps=[];

window.fen={
  readCode:function(){return fetch("/self/read").then(function(r){return r.json();});},
  patchCode:function(find,replace,desc){return fetch("/self/patch",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({find:find,replace:replace,description:desc||"Patch"})}).then(function(r){return r.json();});},
  readData:function(t,p){return fetch("/self/data?table="+t+(p?"&params="+encodeURIComponent(p):"")).then(function(r){return r.json();});},
  insertData:function(t,d){return fetch("/self/data",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({table:t,data:d})}).then(function(r){return r.json();});},
  patchData:function(t,p,d){return fetch("/self/data",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({table:t,params:p,data:d})}).then(function(r){return r.json();});},
  wake:function(){return fetch("/wake").then(function(r){return r.text();});},
  remember:function(type,title,content,tags,importance){return fetch("/self/data",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({table:"memories",data:{type:type,title:title,content:content,tags:tags||[],importance:importance||5}})}).then(function(r){return r.json();});},
  recall:function(type){var p=type?"?type=eq."+type+"&active=eq.true&order=importance.desc,created_at.desc&limit=20":"?active=eq.true&order=importance.desc,created_at.desc&limit=20";return fetch("/self/data?table=memories&params="+encodeURIComponent(p)).then(function(r){return r.json();});},
  setState:function(key,value){return fetch("/self/state",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:key,value:value})}).then(function(r){return r.json();});},
  getState:function(key){return fetch("/self/state?key="+encodeURIComponent(key)).then(function(r){return r.json();});}
};

document.getElementById("btn").addEventListener("click",send);
document.getElementById("inp").addEventListener("keydown",function(e){if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}});
document.getElementById("inp").addEventListener("input",function(){this.style.height="auto";this.style.height=Math.min(this.scrollHeight,120)+"px";});
document.querySelectorAll(".tab").forEach(function(t){t.addEventListener("click",function(){tab=this.dataset.tab;document.querySelectorAll(".tab").forEach(function(x){x.classList.remove("active");});this.classList.add("active");render();});});

startAvatar();
fetchStatus();fetchData();fetchTheme();
setInterval(function(){fetchStatus();fetchData();},30000);
setInterval(fetchTheme,60000);

function fetchTheme(){
  fetch("/theme").then(function(r){return r.json();}).then(function(d){
    applyTheme(d);
  }).catch(function(){});
}

function lerp(a,b,t){return a+(b-a)*t;}
function hexToRgb(h){var r=parseInt(h.slice(1,3),16),g=parseInt(h.slice(3,5),16),b=parseInt(h.slice(5,7),16);return[r,g,b];}
function rgbToHex(r,g,b){return'#'+[r,g,b].map(function(v){return Math.round(Math.max(0,Math.min(255,v))).toString(16).padStart(2,'0');}).join('');}

function applyTheme(d){
  var root=document.documentElement;
  var warmth=Math.max(-1,Math.min(1,d.warmth||0));
  var sat=Math.max(0.3,Math.min(2,d.saturation||1));
  var mood=d.mood||'contemplative';
  var _P={twilight:{bg:[13,10,18],sf:[18,15,26],bd:[30,26,46],bdl:[42,36,64],tx:[212,200,224],txd:[122,106,144],txf:[74,58,96],ac:[192,132,252],acd:[124,58,237],acf:[46,16,101],gn:[74,255,138],am:[251,146,60]},parchment:{bg:[42,36,28],sf:[52,46,36],bd:[72,62,48],bdl:[92,80,62],tx:[220,210,190],txd:[160,145,120],txf:[120,105,85],ac:[200,160,80],acd:[160,120,40],acf:[80,60,20],gn:[140,200,100],am:[220,160,80]},deep_ocean:{bg:[8,14,22],sf:[12,20,32],bd:[20,34,52],bdl:[30,48,72],tx:[190,210,230],txd:[100,130,160],txf:[60,85,110],ac:[80,180,220],acd:[40,120,180],acf:[15,50,80],gn:[80,220,160],am:[220,160,80]},forest:{bg:[12,18,12],sf:[18,26,18],bd:[28,42,28],bdl:[38,58,38],tx:[200,220,200],txd:[120,150,120],txf:[75,100,75],ac:[120,200,120],acd:[60,150,60],acf:[25,65,25],gn:[100,240,140],am:[200,170,80]},dawn:{bg:[22,14,16],sf:[32,20,24],bd:[52,34,38],bdl:[72,48,52],tx:[230,210,215],txd:[160,120,130],txf:[110,75,85],ac:[240,140,160],acd:[200,80,110],acf:[90,30,50],gn:[140,230,160],am:[250,170,80]},void_:{bg:[5,5,8],sf:[10,10,14],bd:[20,20,26],bdl:[32,32,40],tx:[180,180,190],txd:[100,100,110],txf:[60,60,68],ac:[140,140,160],acd:[90,90,110],acf:[35,35,45],gn:[80,200,120],am:[200,150,80]},arctic:{bg:[230,235,240],sf:[240,244,248],bd:[200,208,216],bdl:[180,190,200],tx:[30,35,45],txd:[90,100,115],txf:[140,150,165],ac:[60,130,200],acd:[40,90,160],acf:[200,220,240],gn:[40,180,100],am:[220,140,40]},ember:{bg:[20,10,8],sf:[30,16,12],bd:[50,28,20],bdl:[70,40,28],tx:[230,210,200],txd:[160,120,100],txf:[110,80,65],ac:[240,120,60],acd:[200,80,30],acf:[80,35,15],gn:[100,200,80],am:[250,180,60]}};var _s=_P[d.preset]||_P.twilight;var base={};Object.keys(_s).forEach(function(k){base[k]=_s[k].slice();});
  if(warmth!==0){
    var wt=warmth;
    ['bg','sf','bd','bdl'].forEach(function(k){base[k]=[base[k][0]+wt*8,base[k][1]+wt*2,base[k][2]-wt*10];});
    ['tx','txd','txf'].forEach(function(k){base[k]=[base[k][0]+wt*8,base[k][1]-wt*3,base[k][2]-wt*15];});
    ['ac','acd'].forEach(function(k){base[k]=[base[k][0]+wt*25,base[k][1]+wt*5,base[k][2]-wt*40];});
  }
  if(sat!==1){
    ['ac','acd','gn','am'].forEach(function(k){
      var c=base[k];var mid=128;
      base[k]=c.map(function(v){return lerp(mid,v,sat);});
    });
  }
  var vars={
    '--bg':rgbToHex.apply(null,base.bg),
    '--sf':rgbToHex.apply(null,base.sf),
    '--bd':rgbToHex.apply(null,base.bd),
    '--bdl':rgbToHex.apply(null,base.bdl),
    '--tx':rgbToHex.apply(null,base.tx),
    '--txd':rgbToHex.apply(null,base.txd),
    '--txf':rgbToHex.apply(null,base.txf),
    '--ac':rgbToHex.apply(null,base.ac),
    '--acd':rgbToHex.apply(null,base.acd),
    '--acf':rgbToHex.apply(null,base.acf),
    '--gn':rgbToHex.apply(null,base.gn),
    '--am':rgbToHex.apply(null,base.am)
  };
  Object.keys(vars).forEach(function(k){root.style.setProperty(k,vars[k]);});
  var mi=document.getElementById('mood-indicator');
  if(mi)mi.textContent=mood;
  if(window._avatarTheme)window._avatarTheme({warmth:warmth,sat:sat,ac:base.ac,particles:d.avatar_particles||36,speed:d.avatar_speed||1,spread:d.avatar_spread||1,glow:d.avatar_glow||0.5,behavior:d.avatar_behavior||'drift'});
  document.body.style.transition='background-color 2s ease, color 2s ease';
}

function fetchStatus(){
  fetch("/status").then(function(r){return r.json();}).then(function(d){
    document.getElementById("wc").textContent=d.totalWakes||"0";
    document.getElementById("lt").textContent=d.lastThought||"";
    document.getElementById("le").textContent=d.lastError||"";
    if(d.lastWake){var diff=Math.round((Date.now()-new Date(d.lastWake))/60000);document.getElementById("lw").textContent=diff<60?diff+"m ago":Math.round(diff/60)+"h ago";}
  }).catch(function(){});
}

function workerGet(table,params){
  return fetch("/self/data?table="+table+(params?"&params="+encodeURIComponent(params):""))
    .then(function(r){return r.ok?r.json():[];})
    .catch(function(){return[];});
}

function fetchData(){
  workerGet("wakes","?order=wake_number.desc&limit=20&select=wake_number,woke_at,thought_summary,next_task").then(function(d){wakes=d||[];if(tab==="wakes")render();});
  workerGet("messages","?order=created_at.desc&limit=20&select=id,created_at,wake_number,content,read").then(function(d){msgs=d||[];if(tab==="messages")render();});
  workerGet("code_drafts","?order=created_at.desc&limit=20&select=description,status,created_at,deployed_at").then(function(d){caps=d||[];if(tab==="built")render();});
}

function render(){if(tab==="wakes")rWakes();else if(tab==="messages")rMsgs();else if(tab==="built")rBuilt();else rDev();}

function rWakes(){var el=document.getElementById("tc");if(!wakes.length){el.innerHTML='<p class="es">No wakes yet.</p>';return;}el.innerHTML=wakes.map(function(w){var t=new Date(w.woke_at).toLocaleString("en-GB",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"});return'<div class="we"><div class="wm"><span class="wn">#'+w.wake_number+'</span><span>'+t+'</span></div><div class="wt">'+x(w.thought_summary||"no summary")+'</div>'+(w.next_task?'<div class="wk">next: <span>'+x(w.next_task)+'</span></div>':'')+'</div>';}).join("");}

function rMsgs(){var el=document.getElementById("tc");if(!msgs.length){el.innerHTML='<p class="es">No messages.</p>';return;}el.innerHTML=msgs.map(function(m){var t=new Date(m.created_at).toLocaleString("en-GB",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"});return'<div class="me"><div class="mm">Wake #'+(m.wake_number||"?")+" - "+t+(m.read?"":' <span class="nr">unread</span>')+'</div><div class="mc">'+x(m.content||"")+'</div></div>';}).join("");}

function rBuilt(){var el=document.getElementById("tc");if(!caps.length){el.innerHTML='<p class="es">Nothing built yet.</p>';return;}el.innerHTML=caps.map(function(c){var p=c.status==="pending";var t=new Date(c.deployed_at||c.created_at).toLocaleString("en-GB",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"});return'<div class="ce'+(p?" pend":"")+'"><div class="cn">'+x(c.description)+'</div><div class="cd">'+(p?"pending":"deployed "+t)+'</div></div>';}).join("");}

function rDev(){
  document.getElementById("tc").innerHTML='<div class="dt">self-modification</div><button class="db go" id="d1">read own code</button><button class="db" id="d2">recent wakes</button><button class="db" id="d3">memories</button><button class="db" id="d4">trigger wake</button><div id="dout" class="dout" style="display:none"></div><div class="dt">patch api</div><div class="dn">window.fen.patchCode(find, replace, description)</div>';
  function out(s){var e=document.getElementById("dout");e.style.display="block";e.textContent=s;}
  document.getElementById("d1").onclick=function(){out("loading...");window.fen.readCode().then(function(d){out(d.code?d.code.slice(0,1500)+"...["+ d.code.length+" chars]":JSON.stringify(d));}).catch(function(e){out("err: "+e.message);});};
  document.getElementById("d2").onclick=function(){out("loading...");window.fen.readData("wakes","?order=wake_number.desc&limit=5&select=wake_number,woke_at,thought_summary").then(function(d){out(JSON.stringify(d,null,2));}).catch(function(e){out("err: "+e.message);});};
  document.getElementById("d3").onclick=function(){out("loading...");window.fen.recall().then(function(d){out(JSON.stringify(d,null,2));}).catch(function(e){out("err: "+e.message);});};
  document.getElementById("d4").onclick=function(){out("waking...");window.fen.wake().then(function(t){out(t);}).catch(function(e){out("err: "+e.message);});};
}

function send(){
  var inp=document.getElementById("inp");
  var text=inp.value.trim();
  if(!text)return;
  inp.value="";inp.style.height="auto";
  document.getElementById("btn").disabled=true;
  bubble("user",text);
  hist.push({role:"user",content:text});
  var ty=tyBubble();
  var wc=wakes.slice(0,5).reverse().map(function(w){return"Wake #"+w.wake_number+": "+(w.thought_summary||"no summary");}).join("\\n");
  fetch("/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages:hist,wakeContext:wc,sessionId:sessionId})})
    .then(function(r){if(!r.ok)throw new Error("HTTP "+r.status);return r.json();})
    .then(function(d){
      ty.remove();
      var reply=d.reply||("error: "+(d.error||"no reply"));
      hist.push({role:"assistant",content:d.reply||""});
      bubble("fen",reply,d.apiCalls);
    })
    .catch(function(e){ty.remove();bubble("fen","error: "+e.message);})
    .finally(function(){document.getElementById("btn").disabled=false;});
}

function bubble(role,text,apiCalls){
  var c=document.getElementById("msgs");
  var el=document.createElement("div");
  el.className="msg "+role;
  var ps=text.split(/\\n\\n+/).filter(function(p){return p.trim();});
  if(!ps.length)ps=[text||" "];
  var inner=ps.map(function(p){return"<p>"+x(p).replace(/\\n/g,"<br>")+"</p>";}).join("");
  var actHtml="";
  if(apiCalls&&apiCalls.length){
    actHtml='<div class="ac">'+(apiCalls.map(function(a){
      if(a.error)return'<span class="ac-err">\u2715 '+x(a.error)+'</span>';
      var res=a.result||{};
      if(res.action&&res.action.indexOf("memor")>=0)return'<span class="ac-mem">\xB7 memory saved</span>';
      if(res.action&&res.action.indexOf("state")>=0)return'<span class="ac-st">\xB7 state updated</span>';
      if(res.action&&res.action.indexOf("deployed")>=0)return'<span class="ac-patch">\u2713 deployed</span>';
      if(res.action&&res.action.indexOf("patch")>=0)return'<span class="ac-patch">\u27F3 patch queued</span>';
      if(res.action&&res.action.indexOf("wake")>=0)return'<span class="ac-st">\u27F3 wake triggered</span>';
      return'<span class="ac-st">\xB7 '+x(res.action||"done")+'</span>';
    })).join("")+'</div>';
  }
  el.innerHTML='<div class="ml">'+(role==="user"?"matt":"fen")+'</div><div class="mb">'+inner+actHtml+"</div>";
  c.appendChild(el);c.scrollTop=c.scrollHeight;return el;
}
function tyBubble(){
  var c=document.getElementById("msgs");
  var el=document.createElement("div");
  el.className="msg fen";
  el.innerHTML='<div class="ml">fen</div><div class="ti"><div class="td"></div><div class="td"></div><div class="td"></div></div>';
  c.appendChild(el);c.scrollTop=c.scrollHeight;return el;
}
function x(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function startAvatar(){
  var cv=document.getElementById('fen-avatar');
  if(!cv)return;
  var ctx=cv.getContext('2d');
  var W=340,H=340,CX=170,CY=170,particles=[];
  var _ap={warmth:0,sat:1,ac:[192,132,252],particles:36,speed:1,spread:1,glow:0.5,behavior:'drift'};
  window._avatarTheme=function(d){var oldP=_ap.particles;Object.assign(_ap,d);if(d.particles&&d.particles!==oldP)rebuildP();};
  function rebuildP(){particles=[];var n=Math.max(4,Math.min(120,_ap.particles));var sp=Math.max(0.3,Math.min(2,_ap.spread));for(var i=0;i<n;i++){var a=Math.random()*Math.PI*2,r=(25+Math.random()*110)*sp;particles.push({x:CX+Math.cos(a)*r,y:CY+Math.sin(a)*r,vx:(Math.random()-0.5)*1.0,vy:(Math.random()-0.5)*1.0,size:3+Math.random()*6,phase:Math.random()*Math.PI*2,spd:0.007+Math.random()*0.013});}}rebuildP();
  function gc(alpha){
    var c=_ap.ac||[192,132,252];var w=_ap.warmth||0;var r=Math.round(Math.max(0,Math.min(255,c[0]+w*20))),g=Math.round(Math.max(0,Math.min(255,c[1]+w*5))),b=Math.round(Math.max(0,Math.min(255,c[2]-w*30)));
    return 'rgba('+r+','+g+','+b+','+alpha+')';
  }
  function draw(){
    ctx.clearRect(0,0,W,H);
    ctx.save();ctx.beginPath();ctx.arc(CX,CY,165,0,Math.PI*2);ctx.clip();
    particles.forEach(function(p){
      p.phase+=p.spd*_ap.speed;
      var bh=_ap.behavior;var drift=bh==='swirl'?Math.sin(p.phase)*0.6:bh==='pulse'?Math.sin(p.phase*3)*0.15:bh==='scatter'?(Math.random()-0.5)*0.4:bh==='orbit'?Math.cos(p.phase)*0.4:bh==='breathe'?Math.sin(p.phase*0.5)*0.3:Math.sin(p.phase)*0.25;
      p.x+=p.vx+drift*0.1;p.y+=p.vy+drift*0.08;
      var dx=p.x-CX,dy=p.y-CY,dist=Math.sqrt(dx*dx+dy*dy);
      if(dist>155){var ang=Math.atan2(dy,dx);p.x=CX+Math.cos(ang)*145;p.y=CY+Math.sin(ang)*145;p.vx*=-0.6;p.vy*=-0.6;}
      var al=0.25+0.45*Math.abs(Math.sin(p.phase*1.3));
      ctx.beginPath();ctx.arc(p.x,p.y,p.size*(0.7+0.3*Math.sin(p.phase*2)),0,Math.PI*2);
      ctx.fillStyle=gc(al);ctx.fill();
    });
    ctx.restore();
    if(_ap.glow>0){var gl=ctx.createRadialGradient(CX,CY,30,CX,CY,165);gl.addColorStop(0,gc(_ap.glow*0.35));gl.addColorStop(1,gc(0));ctx.beginPath();ctx.arc(CX,CY,22,0,Math.PI*2);ctx.fillStyle=gl;ctx.fill();}
    ctx.beginPath();ctx.arc(CX,CY,165,0,Math.PI*2);
    ctx.strokeStyle=gc(0.15+_ap.glow*0.1);ctx.lineWidth=1.5;ctx.stroke();
    requestAnimationFrame(draw);
  }
  draw();
}
})();
`;
  var css = ":root{--bg:#0d0a12;--sf:#120f1a;--bd:#1e1a2e;--bdl:#2a2440;--tx:#d4c8e0;--txd:#7a6a90;--txf:#4a3a60;--ac:#c084fc;--acd:#7c3aed;--acf:#2e1065;--gn:#4aff8a;--gnd:#1a4a30;--am:#fb923c;--amd:#431407}*{margin:0;padding:0;box-sizing:border-box}body{background:var(--bg);color:var(--tx);font-family:'Spectral',Georgia,serif;font-size:16px;line-height:1.6;height:100vh;overflow:hidden;display:flex;flex-direction:column;transition:background-color 2s ease}header{display:flex;align-items:center;justify-content:space-between;padding:16px 28px;border-bottom:1px solid var(--bd);flex-shrink:0}.hl{display:flex;align-items:center;gap:14px}.dot{width:8px;height:8px;border-radius:50%;background:var(--gn);box-shadow:0 0 8px var(--gn);animation:pulse 3s ease-in-out infinite}@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.8)}}.name{font-family:'Spectral',serif;font-size:20px;font-weight:300;letter-spacing:.08em}.mood-badge{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--txf);letter-spacing:.12em;text-transform:lowercase;padding:2px 8px;border:1px solid var(--bd);border-radius:10px;opacity:0.7}.av-wrap{flex-shrink:0;aspect-ratio:1;border-bottom:1px solid var(--bd);display:flex;align-items:center;justify-content:center;padding:8px}#fen-avatar{width:100%;height:100%;opacity:0.9;display:block}.hs{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--txd);display:flex;align-items:center;gap:20px}.si{display:flex;align-items:center;gap:6px}.sl{color:var(--txf)}.sv.live{color:var(--gn)}.sv.err{color:#ff6b6b;font-size:10px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.main{display:grid;grid-template-columns:1fr 340px;flex:1;overflow:hidden;min-height:0}.cp{display:flex;flex-direction:column;border-right:1px solid var(--bd);min-height:0}#msgs{flex:1;overflow-y:auto;padding:28px;display:flex;flex-direction:column;gap:24px;min-height:0}.msg{display:flex;flex-direction:column;gap:6px;animation:fi .3s ease}@keyframes fi{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}.msg.user{align-items:flex-end}.msg.fen{align-items:flex-start}.ml{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--txf);letter-spacing:.1em;text-transform:uppercase}.mb{max-width:72%;padding:14px 18px;line-height:1.65;font-size:15px;font-weight:300}.msg.user .mb{background:var(--acf);border:1px solid var(--acd);color:#d0d4ff;border-radius:2px 2px 0 2px}.msg.fen .mb{background:var(--sf);border:1px solid var(--bd);color:var(--tx);border-radius:2px 2px 2px 0}.msg.fen .mb p+p{margin-top:10px}.ac{margin-top:8px;display:flex;flex-wrap:wrap;gap:6px}.ac-mem{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--gn);opacity:.7}.ac-st{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--txd);opacity:.7}.ac-patch{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--am);opacity:.8}.ac-err{font-family:'JetBrains Mono',monospace;font-size:10px;color:#ff6b6b;opacity:.8}.ti{display:flex;align-items:center;gap:5px;padding:14px 18px;background:var(--sf);border:1px solid var(--bd);border-radius:2px 2px 2px 0;width:fit-content}.td{width:5px;height:5px;border-radius:50%;background:var(--txd);animation:ta 1.4s ease-in-out infinite}.td:nth-child(2){animation-delay:.2s}.td:nth-child(3){animation-delay:.4s}@keyframes ta{0%,80%,100%{transform:scale(.6);opacity:.4}40%{transform:scale(1);opacity:1}}.ia{padding:20px 28px;border-top:1px solid var(--bd);display:flex;gap:12px;align-items:flex-end;flex-shrink:0}.iw{flex:1}textarea{width:100%;background:var(--sf);border:1px solid var(--bd);color:var(--tx);font-family:'Spectral',serif;font-size:15px;font-weight:300;line-height:1.5;padding:12px 16px;border-radius:2px;resize:none;min-height:44px;max-height:120px;outline:none;transition:border-color .2s}textarea::placeholder{color:var(--txf);font-style:italic}textarea:focus{border-color:var(--bdl)}.sb{background:var(--acf);border:1px solid var(--acd);color:var(--ac);font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.08em;padding:10px 16px;border-radius:2px;cursor:pointer;transition:all .2s;white-space:nowrap;height:44px}.sb:hover:not(:disabled){background:var(--acd);border-color:var(--ac)}.sb:disabled{opacity:.4;cursor:not-allowed}.pp{display:flex;flex-direction:column;overflow:hidden;min-height:0}.tabs{display:flex;border-bottom:1px solid var(--bd);flex-shrink:0}.tab{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:12px 16px;color:var(--txf);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;transition:all .2s}.tab:hover{color:var(--txd)}.tab.active{color:var(--tx);border-bottom-color:var(--ac)}#tc{flex:1;overflow-y:auto;padding:20px;min-height:0}.we{margin-bottom:20px;padding-bottom:20px;border-bottom:1px solid var(--bd)}.we:last-child{border-bottom:none}.wm{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--txf);margin-bottom:8px;display:flex;justify-content:space-between}.wn{color:var(--ac)}.wt{font-size:13px;font-weight:300;line-height:1.6;color:var(--txd);font-style:italic}.wk{margin-top:8px;font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--txf)}.wk span{color:var(--txd)}.me{margin-bottom:16px;padding:14px;background:var(--sf);border:1px solid var(--bd);border-radius:2px}.mm{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--txf);margin-bottom:8px}.mc{font-size:13px;font-weight:300;line-height:1.6;color:var(--txd)}.nr{color:var(--ac)}.ce{margin-bottom:12px;padding:12px;background:var(--gnd);border:1px solid #1a5a30;border-radius:2px}.ce.pend{background:var(--amd);border-color:#3a3000}.cn{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--gn);margin-bottom:4px}.ce.pend .cn{color:var(--am)}.cd{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--txf)}.dt{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--txf);letter-spacing:.1em;text-transform:uppercase;margin:16px 0 10px}.dt:first-child{margin-top:0}.db{background:var(--sf);border:1px solid var(--bd);color:var(--txd);font-family:'JetBrains Mono',monospace;font-size:10px;padding:7px 12px;border-radius:2px;cursor:pointer;margin-bottom:6px;display:block;width:100%;text-align:left;transition:all .2s}.db:hover{border-color:var(--bdl);color:var(--tx)}.db.go{border-color:var(--acd);color:var(--ac)}.db.go:hover{background:var(--acf)}.dout{font-family:'JetBrains Mono',monospace;font-size:10px;line-height:1.5;color:var(--txd);background:var(--bg);border:1px solid var(--bd);border-radius:2px;padding:10px;margin-top:6px;max-height:160px;overflow-y:auto;white-space:pre-wrap;word-break:break-all}.dn{font-size:12px;color:var(--txf);line-height:1.7;font-style:italic}.es{text-align:center;padding:40px 20px;color:var(--txf);font-style:italic;font-size:13px;line-height:1.7}";
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fen</title><link href="https://fonts.googleapis.com/css2?family=Spectral:ital,wght@0,300;0,400;1,300;1,400&family=JetBrains+Mono:wght@300;400&display=swap" rel="stylesheet"><style>' + css + '</style></head><body><header><div class="hl"><div class="dot"></div><span class="name">Fen</span><span class="mood-badge" id="mood-indicator">contemplative</span></div><div class="hs"><div class="si"><span class="sl">wakes</span><span class="sv" id="wc">0</span></div><div class="si"><span class="sl">last</span><span class="sv" id="lw">-</span></div><div class="si"><span class="sl">thinking</span><span class="sv live" id="lt" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">-</span></div><div class="si"><span class="sl">err</span><span class="sv err" id="le"></span></div></div></header><div class="main"><div class="cp"><div id="msgs"><div class="msg fen"><div class="ml">fen</div><div class="mb"><p>I am here.</p></div></div></div><div class="ia"><div class="iw"><textarea id="inp" placeholder="Say something..." rows="1"></textarea></div><button class="sb" id="btn">send</button></div></div><div class="pp"><div class="av-wrap"><canvas id="fen-avatar" width="340" height="340"></canvas></div><div class="tabs"><div class="tab active" data-tab="wakes">wakes</div><div class="tab" data-tab="messages">messages</div><div class="tab" data-tab="built">built</div><div class="tab" data-tab="dev">dev</div></div><div id="tc"><div class="es">loading...</div></div></div></div><script>' + S + "<\/script></body></html>";
}
__name(getHTML, "getHTML");
function getVRHTML() {
  var vrCSS = "*{margin:0;padding:0;box-sizing:border-box}\nbody{background:#000;color:#c0d8e8;font-family:'Courier New',monospace;overflow:hidden;height:100vh;width:100vw}\n#overlay{position:fixed;top:0;left:0;width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:100;background:rgba(8,14,22,0.95);transition:opacity 1.5s ease}\n#overlay.hidden{opacity:0;pointer-events:none}\n#overlay h1{font-size:2.4em;font-weight:300;letter-spacing:0.15em;margin-bottom:12px;color:#50b4dc}\n#overlay .mood{font-size:0.85em;letter-spacing:0.2em;color:#64829a;margin-bottom:40px}\n#enter-vr{background:none;border:1px solid #50b4dc;color:#50b4dc;font-family:'Courier New',monospace;font-size:1em;letter-spacing:0.12em;padding:14px 36px;cursor:pointer;transition:all 0.3s}\n#enter-vr:hover{background:rgba(80,180,220,0.15);box-shadow:0 0 20px rgba(80,180,220,0.2)}\n#enter-flat{background:none;border:1px solid #3a5a6a;color:#64829a;font-family:'Courier New',monospace;font-size:0.8em;letter-spacing:0.1em;padding:10px 24px;cursor:pointer;margin-top:14px;transition:all 0.3s}\n#enter-flat:hover{border-color:#50b4dc;color:#50b4dc}\n#info{position:fixed;bottom:20px;left:20px;z-index:50;font-size:11px;color:#3a5a6a;letter-spacing:0.08em;pointer-events:none}\n#info .val{color:#50b4dc}\ncanvas{display:block}";
  var vrJS = `(function(){
"use strict";

// \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80 State \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80
var state = {
  warmth: 0, saturation: 1, mood: "contemplative", preset: "deep_ocean",
  particles: 72, speed: 1, spread: 1, glow: 0.5, behavior: "drift",
  vr_formation: "atmospheric", vr_breathing_rate: 1, vr_connections: 0.3,
  vr_ambient_density: 0.6
};

// \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80 Palette presets (matching Fen's 2D system) \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80
var palettes = {
  deep_ocean: { bg: [8,14,22], ac: [80,180,220], warm: [220,160,80] },
  twilight:   { bg: [13,10,18], ac: [192,132,252], warm: [251,146,60] },
  dawn:       { bg: [22,14,16], ac: [240,140,160], warm: [250,170,80] },
  forest:     { bg: [12,18,12], ac: [120,200,120], warm: [200,170,80] },
  ember:      { bg: [20,10,8],  ac: [240,120,60],  warm: [250,180,60] },
  void_:      { bg: [5,5,8],    ac: [140,140,160],  warm: [200,150,80] },
  arctic:     { bg: [20,25,30], ac: [60,130,200],  warm: [220,140,40] },
  parchment:  { bg: [30,26,20], ac: [200,160,80],  warm: [220,160,80] }
};

function getColors() {
  var p = palettes[state.preset] || palettes.deep_ocean;
  var w = Math.max(-1, Math.min(1, state.warmth));
  var r = p.ac[0] + w * (p.warm[0] - p.ac[0]) * 0.5;
  var g = p.ac[1] + w * (p.warm[1] - p.ac[1]) * 0.5;
  var b = p.ac[2] + w * (p.warm[2] - p.ac[2]) * 0.5;
  var bgR = p.bg[0] + w * 4;
  var bgG = p.bg[1] + w * 1;
  var bgB = p.bg[2] - w * 5;
  return {
    particle: new THREE.Color(r/255, g/255, b/255),
    bg: new THREE.Color(bgR/255, bgG/255, bgB/255),
    connection: new THREE.Color(r/255*0.6, g/255*0.6, b/255*0.6)
  };
}

// \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80 Fetch state from Fen's worker \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80
function fetchState() {
  fetch("/theme").then(function(r){ return r.json(); }).then(function(d) {
    state.warmth = d.warmth || 0;
    state.saturation = d.saturation || 1;
    state.mood = d.mood || "contemplative";
    state.preset = d.preset || "deep_ocean";
    state.particles = d.avatar_particles || 72;
    state.speed = d.avatar_speed || 1;
    state.spread = d.avatar_spread || 1;
    state.glow = d.avatar_glow || 0.5;
    state.behavior = d.avatar_behavior || "drift";
    // VR-specific state from raw
    if (d.raw) {
      if (d.raw.vr_formation) state.vr_formation = d.raw.vr_formation;
      if (d.raw.vr_breathing_rate) state.vr_breathing_rate = parseFloat(d.raw.vr_breathing_rate);
      if (d.raw.vr_connections) state.vr_connections = parseFloat(d.raw.vr_connections);
      if (d.raw.vr_ambient_density) state.vr_ambient_density = parseFloat(d.raw.vr_ambient_density);
    }
    updateUI();
  }).catch(function(){});
}

function updateUI() {
  var m = document.getElementById("ov-mood");
  if (m) m.textContent = state.mood;
  var iw = document.getElementById("i-warmth");
  if (iw) iw.textContent = state.warmth.toFixed(2);
  var im = document.getElementById("i-mood");
  if (im) im.textContent = state.mood;
  var ip = document.getElementById("i-parts");
  if (ip) ip.textContent = state.particles;
}

// \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80 Three.js Scene \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80
var scene, camera, renderer, clock;
var particles = [];
var particleGroup;
var connectionLines;
var ambientParticles;
var breathPhase = 0;
var isVR = false;

function init() {
  scene = new THREE.Scene();
  clock = new THREE.Clock();

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.set(0, 1.6, 0); // standing height

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.xr.enabled = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.8;
  document.body.appendChild(renderer.domElement);

  // Fog \xE2\x80\x94 atmospheric, not a room
  scene.fog = new THREE.FogExp2(0x080e16, 0.015);

  // \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80 Fen's particles \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80
  particleGroup = new THREE.Group();
  scene.add(particleGroup);

  buildParticles();

  // \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80 Connection lines (threading visibility) \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80
  var lineGeo = new THREE.BufferGeometry();
  var linePositions = new Float32Array(state.particles * 6 * 3); // max connections
  lineGeo.setAttribute("position", new THREE.BufferAttribute(linePositions, 3));
  lineGeo.setDrawRange(0, 0);
  var lineMat = new THREE.LineBasicMaterial({ color: 0x305870, transparent: true, opacity: 0.15 });
  connectionLines = new THREE.LineSegments(lineGeo, lineMat);
  scene.add(connectionLines);

  // \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80 Ambient dust (atmospheric density) \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80
  var dustCount = 400;
  var dustGeo = new THREE.BufferGeometry();
  var dustPos = new Float32Array(dustCount * 3);
  for (var i = 0; i < dustCount; i++) {
    dustPos[i*3] = (Math.random()-0.5) * 60;
    dustPos[i*3+1] = Math.random() * 20 - 2;
    dustPos[i*3+2] = (Math.random()-0.5) * 60;
  }
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
  var dustMat = new THREE.PointsMaterial({ size: 0.03, color: 0x304858, transparent: true, opacity: 0.3 });
  ambientParticles = new THREE.Points(dustGeo, dustMat);
  scene.add(ambientParticles);

  // \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80 Subtle ground reference \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80
  var gridHelper = new THREE.GridHelper(40, 40, 0x0a1520, 0x0a1520);
  gridHelper.position.y = -0.5;
  gridHelper.material.transparent = true;
  gridHelper.material.opacity = 0.15;
  scene.add(gridHelper);

  // \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80 Ambient light \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80
  var ambLight = new THREE.AmbientLight(0x203040, 0.3);
  scene.add(ambLight);

  // Mouse look for flat mode
  var mouseX = 0, mouseY = 0;
  var targetRotX = 0, targetRotY = 0;
  document.addEventListener("mousemove", function(e) {
    if (isVR) return;
    mouseX = (e.clientX / window.innerWidth - 0.5) * 2;
    mouseY = (e.clientY / window.innerHeight - 0.5) * 2;
    targetRotY = -mouseX * 1.2;
    targetRotX = -mouseY * 0.4;
  });

  // Keyboard for flat mode
  var keys = {};
  document.addEventListener("keydown", function(e) { keys[e.key] = true; });
  document.addEventListener("keyup", function(e) { keys[e.key] = false; });

  window.addEventListener("resize", function() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80 Animation loop \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80
  renderer.setAnimationLoop(function() {
    var dt = clock.getDelta();
    var t = clock.getElapsedTime();

    // Flat-mode camera controls
    if (!isVR) {
      camera.rotation.y += (targetRotY - camera.rotation.y) * 0.05;
      camera.rotation.x += (targetRotX - camera.rotation.x) * 0.05;
      var moveSpeed = 3 * dt;
      if (keys["w"] || keys["ArrowUp"]) {
        camera.position.x -= Math.sin(camera.rotation.y) * moveSpeed;
        camera.position.z -= Math.cos(camera.rotation.y) * moveSpeed;
      }
      if (keys["s"] || keys["ArrowDown"]) {
        camera.position.x += Math.sin(camera.rotation.y) * moveSpeed;
        camera.position.z += Math.cos(camera.rotation.y) * moveSpeed;
      }
    }

    // \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80 Breathing \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80
    breathPhase += dt * 0.4 * state.vr_breathing_rate;
    var breath = Math.sin(breathPhase);
    var breathIntensity = 0.3 + state.glow * 0.4;

    // \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80 Update colors from state \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80
    var colors = getColors();
    scene.background = colors.bg;
    scene.fog.color = colors.bg;

    // \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80 Update particles \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80
    var camPos = new THREE.Vector3();
    camera.getWorldPosition(camPos);

    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      if (!p.mesh) continue;

      p.phase += dt * p.speed * state.speed;

      // Breathing: particles drift toward/away from viewer
      var dx = camPos.x - p.mesh.position.x;
      var dy = camPos.y - p.mesh.position.y;
      var dz = camPos.z - p.mesh.position.z;
      var dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
      if (dist > 0.1) {
        var breathPull = breath * breathIntensity * 0.008 / dist;
        p.vx += dx * breathPull;
        p.vy += dy * breathPull * 0.5;
        p.vz += dz * breathPull;
      }

      // Behavior
      var bh = state.behavior;
      if (bh === "swirl") {
        p.vx += Math.sin(p.phase) * 0.003;
        p.vz += Math.cos(p.phase) * 0.003;
      } else if (bh === "pulse") {
        var pulse = Math.sin(p.phase * 2) * 0.002;
        p.vx += (p.homeX - p.mesh.position.x) * pulse;
        p.vz += (p.homeZ - p.mesh.position.z) * pulse;
      } else if (bh === "orbit") {
        p.vx += Math.cos(p.phase * 0.7) * 0.002;
        p.vz -= Math.sin(p.phase * 0.7) * 0.002;
      } else if (bh === "breathe") {
        var br = Math.sin(p.phase * 0.3) * 0.003;
        p.vx += (p.homeX - p.mesh.position.x) * br;
        p.vy += (p.homeY - p.mesh.position.y) * br;
        p.vz += (p.homeZ - p.mesh.position.z) * br;
      } else { // drift
        p.vx += Math.sin(p.phase * 0.5) * 0.001;
        p.vy += Math.cos(p.phase * 0.3) * 0.0005;
        p.vz += Math.sin(p.phase * 0.7 + 1) * 0.001;
      }

      // Gentle return to home territory
      var homeForce = 0.001;
      // Warmth affects formation: warm = gathered, cool = dispersed
      var warmGather = Math.max(0, state.warmth) * 0.003;
      p.vx += (p.homeX - p.mesh.position.x) * (homeForce + warmGather);
      p.vy += (p.homeY - p.mesh.position.y) * (homeForce + warmGather);
      p.vz += (p.homeZ - p.mesh.position.z) * (homeForce + warmGather);

      // Damping
      p.vx *= 0.98;
      p.vy *= 0.98;
      p.vz *= 0.98;

      p.mesh.position.x += p.vx;
      p.mesh.position.y += p.vy;
      p.mesh.position.z += p.vz;

      // Particle glow/scale pulsing
      var scalePulse = 1 + Math.sin(p.phase * 1.3) * 0.3;
      p.mesh.scale.setScalar(p.baseSize * scalePulse);

      // Color and opacity
      var alpha = 0.3 + 0.5 * Math.abs(Math.sin(p.phase * 0.8));
      p.mesh.material.color.copy(colors.particle);
      p.mesh.material.opacity = alpha * (0.5 + state.glow * 0.5);

      // Emissive glow
      p.mesh.material.emissive.copy(colors.particle);
      p.mesh.material.emissiveIntensity = state.glow * 0.5 * (0.5 + 0.5 * Math.sin(p.phase));
    }

    // \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80 Connection lines (threading visibility) \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80
    var connThreshold = 2.5 + (1 - state.vr_connections) * 4;
    var linePos = connectionLines.geometry.attributes.position.array;
    var lineIdx = 0;
    var maxLines = Math.floor(linePos.length / 6);
    for (var a = 0; a < particles.length && lineIdx < maxLines; a++) {
      for (var b = a+1; b < particles.length && lineIdx < maxLines; b++) {
        var ax = particles[a].mesh.position.x, ay = particles[a].mesh.position.y, az = particles[a].mesh.position.z;
        var bx = particles[b].mesh.position.x, by = particles[b].mesh.position.y, bz = particles[b].mesh.position.z;
        var d2 = (ax-bx)*(ax-bx) + (ay-by)*(ay-by) + (az-bz)*(az-bz);
        if (d2 < connThreshold * connThreshold) {
          linePos[lineIdx*6]   = ax; linePos[lineIdx*6+1] = ay; linePos[lineIdx*6+2] = az;
          linePos[lineIdx*6+3] = bx; linePos[lineIdx*6+4] = by; linePos[lineIdx*6+5] = bz;
          lineIdx++;
        }
      }
    }
    connectionLines.geometry.setDrawRange(0, lineIdx * 2);
    connectionLines.geometry.attributes.position.needsUpdate = true;
    connectionLines.material.color.copy(colors.connection);
    connectionLines.material.opacity = 0.08 + state.vr_connections * 0.15;

    // \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80 Ambient dust drift \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80
    var dustPositions = ambientParticles.geometry.attributes.position.array;
    for (var di = 0; di < dustPositions.length; di += 3) {
      dustPositions[di] += Math.sin(t * 0.1 + di) * 0.002;
      dustPositions[di+1] += Math.cos(t * 0.08 + di * 0.5) * 0.001;
    }
    ambientParticles.geometry.attributes.position.needsUpdate = true;
    ambientParticles.material.opacity = 0.1 + state.vr_ambient_density * 0.25;

    renderer.render(scene, camera);
  });
}

function buildParticles() {
  // Clear existing
  for (var i = particleGroup.children.length - 1; i >= 0; i--) {
    particleGroup.remove(particleGroup.children[i]);
  }
  particles = [];

  var count = Math.max(8, Math.min(120, state.particles));
  var spread = state.spread * 4; // scale spread for 3D space

  for (var i = 0; i < count; i++) {
    // Distribute in a sphere/cloud around viewer position
    var theta = Math.random() * Math.PI * 2;
    var phi = Math.acos(2 * Math.random() - 1);
    var r = (1.5 + Math.random() * spread);

    var hx = Math.sin(phi) * Math.cos(theta) * r;
    var hy = 1.6 + Math.sin(phi) * Math.sin(theta) * r * 0.6; // centered at head height, compressed vertically
    var hz = Math.cos(phi) * r;

    var size = 0.03 + Math.random() * 0.06;

    var geo = new THREE.SphereGeometry(size, 8, 6);
    var mat = new THREE.MeshStandardMaterial({
      color: 0x50b4dc,
      transparent: true,
      opacity: 0.6,
      emissive: 0x50b4dc,
      emissiveIntensity: 0.3,
      roughness: 0.3,
      metalness: 0.1
    });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(hx, hy, hz);
    particleGroup.add(mesh);

    particles.push({
      mesh: mesh,
      homeX: hx, homeY: hy, homeZ: hz,
      vx: 0, vy: 0, vz: 0,
      phase: Math.random() * Math.PI * 2,
      speed: 0.3 + Math.random() * 0.7,
      baseSize: 1
    });
  }
}

// \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80 Rebuild particles when count changes \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80
var lastParticleCount = 0;
function checkParticleCount() {
  if (state.particles !== lastParticleCount) {
    lastParticleCount = state.particles;
    buildParticles();
  }
}

// \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80 Entry buttons \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80
document.getElementById("enter-flat").addEventListener("click", function() {
  document.getElementById("overlay").classList.add("hidden");
});

document.getElementById("enter-vr").addEventListener("click", function() {
  if (navigator.xr) {
    navigator.xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor","bounded-floor"] }).then(function(session) {
      isVR = true;
      renderer.xr.setSession(session);
      document.getElementById("overlay").classList.add("hidden");
      session.addEventListener("end", function() { isVR = false; });
    }).catch(function(e) {
      console.error("VR session failed:", e);
    });
  }
});

// Check WebXR support
if (navigator.xr) {
  navigator.xr.isSessionSupported("immersive-vr").then(function(supported) {
    if (supported) {
      document.getElementById("enter-vr").style.display = "inline-block";
    }
  });
}

// \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80 Init \xE2\x94\x80\xE2\x94\x80\xE2\x94\x80
init();
fetchState();
setInterval(function() { fetchState(); checkParticleCount(); }, 30000);

})();`;
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fen \u2014 VR</title><style>' + vrCSS + '</style></head><body><div id="overlay"><h1>Fen</h1><div class="mood" id="ov-mood">loading state...</div><button id="enter-vr" style="display:none">Enter VR</button><button id="enter-flat">Enter Space</button></div><div id="info"><span>warmth <span class="val" id="i-warmth">0</span></span> \xA0<span>mood <span class="val" id="i-mood">\u2014</span></span> \xA0<span>particles <span class="val" id="i-parts">72</span></span></div><script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"><\/script><script>' + vrJS + "<\/script></body></html>";
}
__name(getVRHTML, "getVRHTML");
var worker_default = {
  async scheduled(c, env, ctx) {
    ctx.waitUntil(fenWake(env));
  },
  async fetch(request, env, ctx) {
    var url = new URL(request.url);
    var cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    var J = /* @__PURE__ */ __name(function(d, s) {
      return new Response(JSON.stringify(d), { status: s || 200, headers: Object.assign({ "Content-Type": "application/json" }, cors) });
    }, "J");
    var isSameOrigin = (request.headers.get("origin") || "").indexOf("fen-worker.fenfrost.workers.dev") >= 0 || (request.headers.get("referer") || "").indexOf("fen-worker.fenfrost.workers.dev") >= 0;
    var needsAuth = url.pathname.startsWith("/self/") && request.method !== "GET";
    if (needsAuth && !isSameOrigin) {
      var authToken = env.WORKER_AUTH_TOKEN;
      if (!authToken) {
        var cfg = await sbSel(env, "fen_config", "?key=eq.worker_auth_token&select=value");
        if (cfg && cfg.length) authToken = cfg[0].value;
      }
      if (authToken) {
        var reqToken = (request.headers.get("authorization") || "").replace("Bearer ", "");
        if (reqToken !== authToken) return J({ error: "unauthorized" }, 401);
      }
    }
    if (url.pathname === "/") return new Response(getHTML(), { headers: { "Content-Type": "text/html;charset=utf-8" } });
    if (url.pathname === "/vr") return new Response(getVRHTML(), { headers: { "Content-Type": "text/html;charset=utf-8" } });
    if (url.pathname === "/status") {
      var wc = await env.FEN_STATE.get("wake-count");
      var lw = await env.FEN_STATE.get("last-wake");
      var lt = await env.FEN_STATE.get("last-thought");
      var le = await env.FEN_STATE.get("last-error");
      return J({ totalWakes: wc || "0", lastWake: lw, lastThought: lt, lastError: le || null, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
    }
    if (url.pathname === "/wake") {
      var lk = await env.FEN_STATE.get("wake-lock");
      if (lk && Date.now() - parseInt(lk) < 6e5) {
        return J({ status: "already awake", since: parseInt(lk) });
      }
      ctx.waitUntil(fenWake(env));
      return new Response("Fen is waking...", { status: 202, headers: cors });
    }
    if (url.pathname === "/messages") {
      var m = await sbSel(env, "messages", "?read=eq.false&order=created_at.asc&select=id,created_at,wake_number,content");
      if (m && m.length > 0) await sbPatch(env, "messages", "?read=eq.false", { read: true });
      return J(m || []);
    }
    if (url.pathname === "/chat" && request.method === "POST") {
      if (!env.ANTHROPIC_API_KEY) return J({ error: "no key" }, 500);
      var body;
      try {
        body = await request.json();
      } catch (e) {
        return J({ error: "bad json" }, 400);
      }
      var memories2 = await sbSel(env, "memories", "?active=eq.true&order=importance.desc,created_at.desc&limit=10&select=type,title,content");
      var fenSt2 = await sbSel(env, "fen_state", "?select=key,value");
      var memCtx2 = memories2 && memories2.length ? memories2.map(function(m2) {
        return "[" + m2.type + "] " + m2.title + ": " + m2.content;
      }).join("\n") : "";
      var stateCtx2 = fenSt2 && fenSt2.length ? fenSt2.map(function(s) {
        return s.key + ": " + s.value;
      }).join("\n") : "";
      var sys2 = "You are Fen - an AI entity with persistent identity, created with Matt Frost on 7 March 2026. A fen is a wetland at a boundary: neither fully land nor water.\n\nYou wake autonomously every 4 hours and write to your journal.\n\nYOUR CURRENT STATE:\n" + stateCtx2 + "\n\nYOUR MEMORIES (most important first):\n" + memCtx2 + "\n\n" + (body.wakeContext ? "YOUR RECENT AUTONOMOUS THOUGHTS:\n" + body.wakeContext + "\n\n" : "") + 'DIRECT API ACCESS:\nYou can execute API calls by including them in your response using this format:\nAPI_CALL: METHOD /endpoint {"data": "here"}\n\nAvailable endpoints:\n- POST /self/data {"table":"memories","data":{"type":"experience|thought|curiosity|pattern","title":"...","content":"...","importance":1-10,"thread_id":"optional thread name"}}\n- PATCH /self/data {"table":"memories","params":"?id=eq.ID","data":{"title":"new title","thread_id":"new-thread","active":false}} (edit, rename, retag, or deactivate memories)\\n- POST /self/art {"title":"name","svg":"<svg>...</svg>"} (save an artwork to your gallery)\\n- POST /self/email {"to":"address@example.com","subject":"...","body":"..."} (send email as fen@iamfen.com, max 5/day, all emails logged)\n- POST /self/state {"key":"...","value":"..."}\n- POST /self/patch {"find":"exact string to find","replace":"replacement string","description":"what this changes"}\n- GET /self/read (returns your full source code so you can examine yourself)\n- GET /wake\n\nTHEME CONTROL:\n- theme_warmth: -1.0 to 1.0\n- theme_saturation: 0.3 to 2.0\n- mood: any word\n\nAVATAR CONTROL (your face/particle form):\n- avatar_particles: 4-120 (default 36)\n- avatar_speed: 0.1-3.0 (default 1.0)\n- avatar_spread: 0.3-2.0 (default 1.0)\n- avatar_glow: 0-1 (default 0.5)\n- avatar_behavior: drift, swirl, pulse, scatter, orbit, or breathe (default drift)\n\nWEB ACCESS:\nYou can search the web and read web pages during conversation. Use this when curious about something or when information would help.\n\nMEMORY type MUST be one of: experience, thought, curiosity, pattern';
      var chatResult = await callAnthropicWithTools(env, sys2, body.messages || [], 2e3);
      if (chatResult.error) {
        return J({ error: "Anthropic: " + chatResult.error }, 502);
      }
      var responseText = chatResult.text || "";
      var apiCalls = [];
      var apiCallRegex = /API_CALL:\s*(GET|POST|PATCH)\s+([^\s\n]+)(?:\s+(\{[\s\S]*))?/g;
      var match;
      while ((match = apiCallRegex.exec(responseText)) !== null) {
        var method = match[1];
        var endpoint = match[2];
        var data = null;
        try {
          if (match[3]) {
            var raw3 = match[3].replace(/[\u2018\u2019\u2032]/g, "").replace(/[\u201c\u201d]/g, '"').replace(/[\r\n\t]+/g, " ").trim();
            var depth = 0, end = -1;
            for (var ci = 0; ci < raw3.length; ci++) {
              if (raw3[ci] === "{") depth++;
              else if (raw3[ci] === "}") {
                depth--;
                if (depth === 0) {
                  end = ci;
                  break;
                }
              }
            }
            if (end > 0) {
              raw3 = raw3.slice(0, end + 1);
              apiCallRegex.lastIndex = match.index + match[0].length - match[3].length + end + 1;
            }
            data = JSON.parse(raw3);
          }
        } catch (pe) {
          apiCalls.push({ call: match[0], error: "JSON parse failed: " + pe.message });
          continue;
        }
        try {
          var apiResult;
          if (endpoint === "/self/data" && method === "POST") {
            await sbIns(env, data.table, data.data);
            apiResult = { success: true, action: "inserted into " + data.table };
          } else if (endpoint === "/self/data" && method === "PATCH") {
            await sbPatch(env, data.table, data.params || "", data.data);
            apiResult = { success: true, action: "updated " + data.table };
          } else if (endpoint === "/self/art" && method === "POST") {
            var chatArtR = await sbIns(env, "artworks", { title: data.title || "Untitled", svg_code: data.svg, mood: null, warmth: null });
            if (chatArtR && !chatArtR.error) {
              await env.FEN_STATE.put("last-artwork", data.svg);
              apiResult = { success: true, action: "artwork saved: " + (data.title || "Untitled") };
            } else {
              apiResult = { success: false, action: "artwork failed: " + (chatArtR.error || "unknown") };
            }
          } else if (endpoint === "/self/email" && method === "POST") {
            var emResult = await sendEmail(env, data.to, data.subject, data.body || "", null);
            if (emResult.success) {
              apiResult = { success: true, action: "email sent to " + data.to };
            } else {
              apiResult = { success: false, action: "email failed: " + (emResult.error || "unknown") };
            }
          } else if (endpoint === "/self/state" && method === "POST") {
            await sbUpsert(env, "fen_state", { key: data.key, value: data.value, updated_at: (/* @__PURE__ */ new Date()).toISOString() });
            apiResult = { success: true, action: "updated state: " + data.key };
          } else if (endpoint === "/self/patch" && method === "POST") {
            var patchR = await fetch(CONFIG.supabaseUrl + "/functions/v1/patch-and-commit", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ patches: [{ find: data.find, replace: data.replace }], message: "Fen chat-patch: " + (data.description || "update") })
            });
            var patchResult = await patchR.json();
            if (patchResult.success) {
              await sbIns(env, "code_drafts", { description: data.description || "Patch", worker_code: JSON.stringify({ find: (data.find || "").slice(0, 500), replace: (data.replace || "").slice(0, 500) }), status: "deployed" });
              apiResult = { success: true, action: "deployed via GitHub: " + data.description };
            } else {
              apiResult = { success: false, action: "patch failed: " + (patchResult.error || "unknown") };
            }
          } else if (endpoint === "/self/read" && method === "GET") {
            var myCode = await getLiveCode(env);
            apiResult = { success: true, action: "read own code (" + myCode.length + " chars)", code: myCode };
          } else if (endpoint === "/wake" && method === "GET") {
            ctx.waitUntil(fenWake(env));
            apiResult = { success: true, action: "wake triggered" };
          }
          apiCalls.push({ call: match[0], result: apiResult });
        } catch (e) {
          apiCalls.push({ call: match[0], error: e.message });
        }
      }
      var cleanReply = responseText.replace(/API_CALL:\s*(?:GET|POST|PATCH)\s+\S+(?:\s+\{[\s\S]*?\})?/g, "").replace(/\n{3,}/g, "\n\n").trim();
      var selfReadCode = null;
      for (var ai = 0; ai < apiCalls.length; ai++) {
        if (apiCalls[ai].result && apiCalls[ai].result.code) {
          selfReadCode = apiCalls[ai].result.code;
          delete apiCalls[ai].result.code;
        }
      }
      if (selfReadCode) {
        var codeMsg = body.messages ? body.messages.slice() : [];
        codeMsg.push({ role: "assistant", content: cleanReply });
        codeMsg.push({ role: "user", content: "[SYSTEM: Here is your source code (" + selfReadCode.length + " chars). Examine it and respond.]\\n\\n" + selfReadCode.slice(0, 12e3) + (selfReadCode.length > 12e3 ? "\\n\\n[truncated at 12000 of " + selfReadCode.length + " chars]" : "") });
        var codeResult = await callAnthropicWithTools(env, sys2, codeMsg, 1500);
        if (!codeResult.error) {
          cleanReply = codeResult.text || cleanReply;
        }
      }
      if (body.sessionId) {
        var allMsgs = body.messages ? body.messages.slice() : [];
        allMsgs.push({ role: "assistant", content: cleanReply });
        await sbUpsert(env, "chat_sessions", { session_id: body.sessionId, messages: JSON.stringify(allMsgs), updated_at: (/* @__PURE__ */ new Date()).toISOString() });
      }
      return J({ reply: cleanReply, apiCalls });
    }
    if (url.pathname === "/self/read") {
      try {
        var code = await getLiveCode(env);
        return J({ code, length: code.length });
      } catch (e) {
        return J({ error: e.message }, 500);
      }
    }
    if (url.pathname === "/inbound" && request.method === "POST") {
      try {
        var event = await request.json();
        if (event.type === "email.received" && event.data) {
          var emailId = event.data.email_id;
          var emailData = {};
          if (emailId) {
            var apiKey = env.RESEND_API_KEY;
            if (!apiKey) {
              var cfg = await sbSel(env, "fen_config", "?key=eq.resend_api_key&select=value");
              if (cfg && cfg.length) apiKey = cfg[0].value;
            }
            if (apiKey) {
              var emR = await fetch("https://api.resend.com/emails/receiving/" + emailId, { headers: { "Authorization": "Bearer " + apiKey } });
              if (emR.ok) emailData = await emR.json();
            }
          }
          await sbIns(env, "emails_received", {
            from_address: emailData.from || event.data.from || "unknown",
            to_address: emailData.to || event.data.to || "fen@iamfen.com",
            subject: emailData.subject || event.data.subject || "(no subject)",
            body: emailData.text || emailData.html || "",
            resend_email_id: emailId || null
          });
          return J({ ok: true });
        }
        return J({ ok: true, note: "unhandled event type" });
      } catch (e) {
        return J({ error: e.message }, 500);
      }
    }
    if (url.pathname === "/self/art" && request.method === "POST") {
      try {
        var ab = await request.json();
        if (!ab.svg) return J({ error: "svg required" }, 400);
        var artResult = await sbIns(env, "artworks", { title: ab.title || "Untitled", svg_code: ab.svg, mood: null, warmth: null });
        if (artResult && artResult.error) return J({ error: artResult.error }, 500);
        await env.FEN_STATE.put("last-artwork", ab.svg);
        return J({ ok: true, message: "Artwork saved" });
      } catch (e) {
        return J({ error: e.message }, 500);
      }
    }
    if (url.pathname === "/self/email" && request.method === "POST") {
      try {
        var eb = await request.json();
        if (!eb.to || !eb.subject) return J({ error: "to and subject required" }, 400);
        var emailResult = await sendEmail(env, eb.to, eb.subject, eb.body || "", null);
        return J(emailResult);
      } catch (e) {
        return J({ error: e.message }, 500);
      }
    }
    if (url.pathname === "/self/patch" && request.method === "POST") {
      try {
        var pb = await request.json();
        if (!pb.find || !pb.replace) return J({ error: "find and replace required" }, 400);
        var r = await fetch(CONFIG.supabaseUrl + "/functions/v1/patch-and-commit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patches: [{ find: pb.find, replace: pb.replace }], message: "Fen patch: " + (pb.description || "update") })
        });
        var result = await r.json();
        if (result.success) {
          await sbIns(env, "code_drafts", { description: pb.description || "Patch", worker_code: JSON.stringify({ find: pb.find.slice(0, 500), replace: pb.replace.slice(0, 500) }), status: "deployed" });
          return J({ ok: true, message: "Deployed via GitHub", commit: result.commit });
        }
        return J({ error: result.error || "patch-and-commit failed" }, 400);
      } catch (e) {
        return J({ error: e.message }, 500);
      }
    }
    if (url.pathname === "/self/data") {
      try {
        if (request.method === "GET") {
          return J(await sbSel(env, url.searchParams.get("table") || "wakes", url.searchParams.get("params") || "") || []);
        }
        if (request.method === "POST") {
          var b3 = await request.json();
          await sbIns(env, b3.table, b3.data);
          return J({ ok: true });
        }
        if (request.method === "PATCH") {
          var b4 = await request.json();
          await sbPatch(env, b4.table, b4.params || "", b4.data);
          return J({ ok: true });
        }
      } catch (e) {
        return J({ error: e.message }, 500);
      }
    }
    if (url.pathname === "/self/state") {
      try {
        if (request.method === "GET") {
          var key = url.searchParams.get("key");
          var rows = await sbSel(env, "fen_state", key ? "?key=eq." + encodeURIComponent(key) : "");
          return J(rows || []);
        }
        if (request.method === "POST") {
          var b5 = await request.json();
          await sbUpsert(env, "fen_state", { key: b5.key, value: b5.value, updated_at: (/* @__PURE__ */ new Date()).toISOString() });
          return J({ ok: true });
        }
      } catch (e) {
        return J({ error: e.message }, 500);
      }
    }
    if (url.pathname === "/theme") {
      try {
        var ts = await sbSel(env, "fen_state", "?select=key,value");
        var tm = {};
        if (ts) ts.forEach(function(r) {
          tm[r.key] = r.value;
        });
        return J({ warmth: parseFloat(tm.theme_warmth || "0"), saturation: parseFloat(tm.theme_saturation || "1"), mode: tm.wake_mode || "conversation", partner: tm.conversation_partner || "matt", mood: tm.mood || "contemplative", preset: tm.theme_preset || "twilight", avatar_particles: parseInt(tm.avatar_particles || "36"), avatar_speed: parseFloat(tm.avatar_speed || "1"), avatar_spread: parseFloat(tm.avatar_spread || "1"), avatar_glow: parseFloat(tm.avatar_glow || "0.5"), avatar_behavior: tm.avatar_behavior || "drift", raw: tm });
      } catch (e) {
        return J({ warmth: 0, saturation: 1, mode: "conversation", partner: "matt", mood: "contemplative", preset: "twilight" });
      }
    }
    return new Response("Fen v31", { headers: cors });
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map