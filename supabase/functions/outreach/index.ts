// HAUS HQ outreach: stores concept visuals and sends outreach emails from Sophie C's inbox.
// POST { action: "visual.save", token, id, url }   called from the database (pg_net) by the outreach job
// POST { action: "send", id, email, subject, body, visual?, test? } called from HAUS HQ by Sophie C (Supabase session JWT)
// POST { action: "reply.send", id, body } called from HAUS HQ by Sophie C: replies in the prospect's latest email thread
// Every real send copies in Sophie W. A test goes to Sophie C only. It never sends anything on its own.

const OWNER = Deno.env.get("OWNER_EMAIL") ?? "sophie.c@haus-events.co.uk";
const CC = "sophie.w@haus-events.co.uk";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SA_JSON = Deno.env.get("GOOGLE_SA_JSON") ?? "";
const BUCKET = "outreach-visuals";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "content-type": "application/json" } });
const svc = { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` };

async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { ...svc, "content-type": "application/json", ...(init.headers ?? {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
async function getRow(id: string) {
  const rows = await rest(`haus_outreach?id=eq.${encodeURIComponent(id)}&select=*`);
  return rows?.[0] ?? null;
}
async function patchRow(id: string, data: Record<string, unknown>) {
  await rest(`haus_outreach?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ ...data, updated_at: new Date().toISOString() }) });
}

/* ---------- visual.save ---------- */
async function visualSave(p: any) {
  const ok = p.token ? await rest(`rpc/haus_outreach_token_ok`, { method: "POST", body: JSON.stringify({ p_token: String(p.token) }) }) : false;
  if (ok !== true) return json({ error: "not allowed" }, 403);
  const id = String(p.id ?? "");
  if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "bad id" }, 400);
  try {
    const u = new URL(String(p.url ?? ""));
    if (u.protocol !== "https:" || !/(^|\.)canva\.com$|(^|\.)amazonaws\.com$|(^|\.)canva-export\.com$|(^|\.)canva\.cn$/.test(u.hostname) && !/export-download/.test(u.hostname)) {
      throw new Error("only Canva export links are accepted: " + u.hostname);
    }
    const r = await fetch(u.toString());
    if (!r.ok) throw new Error(`download ${r.status}`);
    const type = (r.headers.get("content-type") ?? "image/jpeg").split(";")[0];
    if (!/^image\/(jpeg|png)$/.test(type)) throw new Error("not an image: " + type);
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length > 6_000_000) throw new Error("image too large");
    const path = `${id}/concept.${type === "image/png" ? "png" : "jpg"}`;
    const up = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${path}`, { method: "POST", headers: { ...svc, "content-type": type, "x-upsert": "true" }, body: bytes });
    if (!up.ok) throw new Error(`upload ${up.status} ${(await up.text()).slice(0, 150)}`);
    await patchRow(id, { visual_path: path, visual_state: "saved", visual_error: null });
    return json({ ok: true, path, bytes: bytes.length });
  } catch (e) {
    await patchRow(id, { visual_state: "failed", visual_error: String((e as Error).message ?? e).slice(0, 300) }).catch(() => {});
    return json({ ok: false, error: String((e as Error).message ?? e) }, 500);
  }
}

/* ---------- Google (service account, domain-wide delegation, as Sophie C) ---------- */
function b64url(bytes: Uint8Array) { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function b64(bytes: Uint8Array) { let s = ""; const c = 0x8000; for (let i = 0; i < bytes.length; i += c) s += String.fromCharCode(...bytes.subarray(i, i + c)); return btoa(s); }
function pem(p: string) { const raw = atob(p.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")); const o = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) o[i] = raw.charCodeAt(i); return o; }
async function gtoken() {
  const sa = JSON.parse(SA_JSON);
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const input = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iss: sa.client_email, sub: OWNER, scope: "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.compose", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const key = await crypto.subtle.importKey("pkcs8", pem(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input)));
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${input}.${b64url(sig)}` }) });
  const t = await r.json();
  if (!r.ok) throw new Error(`google token: ${JSON.stringify(t).slice(0, 200)}`);
  return t.access_token as string;
}
async function gapi(url: string, tok: string, init: RequestInit = {}) {
  const r = await fetch(url, { ...init, headers: { Authorization: `Bearer ${tok}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`gmail ${r.status}: ${t.slice(0, 200)}`);
  return JSON.parse(t);
}
const encHeader = (s: string) => /[^\x20-\x7e]/.test(s) ? `=?UTF-8?B?${b64(new TextEncoder().encode(s))}?=` : s;
const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function htmlBody(text: string, cid: string | null, caption: string) {
  const paras = text.trim().split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${escHtml(p).replace(/\n/g, "<br>").replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</p>`);
  // the concept goes after the paragraph that mentions it, else after the second paragraph
  if (cid) {
    const img = `<p style="margin:4px 0 18px"><img src="cid:${cid}" alt="${escHtml(caption || "Stand concept")}" width="600" style="max-width:100%;height:auto;border-radius:6px;display:block"></p>`;
    let at = paras.findIndex((p) => /concept|mock ?up|visual|render|sketch|attached|below/i.test(p));
    if (at < 0) at = Math.min(1, paras.length - 1);
    paras.splice(at + 1, 0, img);
  }
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111">${paras.join("")}</div>`;
}
const lines76 = (s: string) => (s.match(/.{1,76}/g) ?? []).join("\r\n");

async function ownerOnly(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const u = await fetch(`${SB_URL}/auth/v1/user`, { headers: { Authorization: auth, apikey: SB_SERVICE } });
  const email = u.ok ? (await u.json())?.email : null;
  return !!email && String(email).toLowerCase() === OWNER.toLowerCase();
}

/* ---------- send ---------- */
async function send(req: Request, p: any) {
  if (!(await ownerOnly(req))) return json({ error: "only Sophie C can send outreach (it goes from her inbox)" }, 403);
  if (!SA_JSON) return json({ error: "Google is not configured" }, 500);
  const o = await getRow(String(p.id ?? ""));
  if (!o || !o.draft_kind) return json({ error: "nothing waiting to send for this prospect" }, 400);
  const test = p.test === true;
  const to = test ? OWNER : String(p.email ?? o.email ?? "").trim();
  if (!/^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/.test(to)) return json({ error: "check the email address" }, 400);
  const subject = String(p.subject ?? o.draft_subject ?? "");
  const body = String(p.body ?? o.draft_body ?? "");
  if (/[–—]/.test(subject + body)) return json({ error: "there is a dash in the email; swap it for a comma or full stop" }, 400);
  const withVisual = o.draft_kind === "first" && o.visual_state === "saved" && o.visual_path && p.visual !== false;

  let img: { bytes: Uint8Array; type: string } | null = null;
  if (withVisual) {
    const r = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${o.visual_path}`, { headers: svc });
    if (!r.ok) return json({ error: `could not load the concept image (${r.status}); remove it or try again` }, 500);
    img = { bytes: new Uint8Array(await r.arrayBuffer()), type: (r.headers.get("content-type") ?? "image/jpeg").split(";")[0] };
  }

  const tok = await gtoken();
  let threadId: string | undefined, inReplyTo = "", references = "";
  if (!test && o.draft_kind === "followup" && o.gmail_thread && !/^https?:/.test(o.gmail_thread)) {
    try {
      const t = await gapi(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${o.gmail_thread}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`, tok);
      const last = (t.messages ?? []).slice(-1)[0];
      const h: Record<string, string> = {}; for (const x of last?.payload?.headers ?? []) h[String(x.name).toLowerCase()] = String(x.value);
      threadId = o.gmail_thread; inReplyTo = h["message-id"] ?? ""; references = [h.references, h["message-id"]].filter(Boolean).join(" ");
    } catch { /* send as a fresh email if the thread can't be read */ }
  }

  const alt = `alt_${crypto.randomUUID().replace(/-/g, "")}`;
  const rel = `rel_${crypto.randomUUID().replace(/-/g, "")}`;
  const cid = img ? `concept_${crypto.randomUUID().slice(0, 8)}@haus` : null;
  const head = [`To: ${to}`, test ? "" : `Cc: ${CC}`, `Subject: ${encHeader(test ? "[TEST] " + subject : subject)}`, inReplyTo ? `In-Reply-To: ${inReplyTo}` : "", references ? `References: ${references}` : "", "MIME-Version: 1.0"].filter(Boolean);
  const altPart = [
    `Content-Type: multipart/alternative; boundary="${alt}"`, "",
    `--${alt}`, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", lines76(b64(new TextEncoder().encode(body + (img ? "\n\n[Stand concept image attached]" : "")))),
    `--${alt}`, 'Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", lines76(b64(new TextEncoder().encode(htmlBody(body, cid, o.visual_caption ?? "")))),
    `--${alt}--`, "",
  ];
  let mime: string[];
  if (img) {
    const fname = `${String(o.company || "stand").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")}-stand-concept-HAUS.${img.type === "image/png" ? "png" : "jpg"}`;
    mime = head.concat([`Content-Type: multipart/related; boundary="${rel}"`, "", `--${rel}`, ...altPart,
      `--${rel}`, `Content-Type: ${img.type}; name="${fname}"`, "Content-Transfer-Encoding: base64", `Content-ID: <${cid}>`, `Content-Disposition: inline; filename="${fname}"`, "", lines76(b64(img.bytes)),
      `--${rel}--`, ""]);
  } else {
    mime = head.concat(altPart);
  }
  const sent = await gapi("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", tok, { method: "POST", body: JSON.stringify({ raw: b64url(new TextEncoder().encode(mime.join("\r\n"))), threadId }) });
  return json({ ok: true, test, messageId: sent.id, threadId: sent.threadId, visual: !!img, cc: test ? null : CC });
}

/* ---------- reply.send: answer the prospect inside their latest email thread ---------- */
async function replySend(req: Request, p: any) {
  if (!(await ownerOnly(req))) return json({ error: "only Sophie C can send replies (they go from her inbox)" }, 403);
  if (!SA_JSON) return json({ error: "Google is not configured" }, 500);
  const o = await getRow(String(p.id ?? ""));
  if (!o) return json({ error: "prospect not found" }, 404);
  const to = String(p.email ?? o.email ?? "").trim();
  if (!/^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/.test(to)) return json({ error: "no email address for this prospect; reply on LinkedIn or WhatsApp instead" }, 400);
  const body = String(p.body ?? o.reply_draft ?? "").trim();
  if (!body) return json({ error: "the reply is empty" }, 400);
  if (/[–—]/.test(body)) return json({ error: "there is a dash in the reply; swap it for a comma or full stop" }, 400);

  const tok = await gtoken();
  // newest thread with them: their latest message, else the stored thread
  let threadId = "", subject = String(o.subject ?? "Following up"), inReplyTo = "", references = "";
  const q = encodeURIComponent(`from:${to} newer_than:90d`);
  const list = await gapi(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=1`, tok);
  const msgId = list.messages?.[0]?.id;
  if (msgId) threadId = list.messages[0].threadId;
  else if (o.gmail_thread && !/^https?:/.test(o.gmail_thread)) threadId = o.gmail_thread;
  if (threadId) {
    const t = await gapi(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject`, tok);
    const last = (t.messages ?? []).slice(-1)[0];
    const h: Record<string, string> = {}; for (const x of last?.payload?.headers ?? []) h[String(x.name).toLowerCase()] = String(x.value);
    inReplyTo = h["message-id"] ?? ""; references = [h.references, h["message-id"]].filter(Boolean).join(" ");
    if (h.subject) subject = h.subject;
  }
  if (!/^re:/i.test(subject)) subject = "Re: " + subject;
  const alt = `alt_${crypto.randomUUID().replace(/-/g, "")}`;
  const mime = [`To: ${to}`, `Cc: ${CC}`, `Subject: ${encHeader(subject)}`, inReplyTo ? `In-Reply-To: ${inReplyTo}` : "", references ? `References: ${references}` : "", "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${alt}"`, "",
    `--${alt}`, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", lines76(b64(new TextEncoder().encode(body))),
    `--${alt}`, 'Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", lines76(b64(new TextEncoder().encode(htmlBody(body, null, "")))),
    `--${alt}--`, ""].filter((x, i) => x !== "" || i > 5);
  const sent = await gapi("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", tok, { method: "POST", body: JSON.stringify({ raw: b64url(new TextEncoder().encode(mime.join("\r\n"))), threadId: threadId || undefined }) });
  return json({ ok: true, messageId: sent.id, threadId: sent.threadId, subject, cc: CC });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let p: any; try { p = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  try {
    if (p.action === "visual.save") return await visualSave(p);
    if (p.action === "send") return await send(req, p);
    if (p.action === "reply.send") return await replySend(req, p);
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message ?? e) }, 500);
  }
});
