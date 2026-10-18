"use strict";
// specs/zamek: the content (strategies, squads, doctrine, training list) comes from the database after the
// Discord login (loadContent); until then the page shows only the login gate
const D = {};
// ---------- sestava: login přes Discord (Supabase) ----------
const BACK = "wrd.back";  // hash to return to after the Discord round trip
const urlQs = new URLSearchParams(location.search);
let FRESH = urlQs.has("code");  // only a fresh Discord login carries provider_token worth sending
// CDN down or blocked -> no login and no content; the gate says so
const sb = window.supabase ? supabase.createClient(window.KIN_BACKEND.url, window.KIN_BACKEND.key, { auth: { flowType: "pkce" } }) : null;
// a stored Supabase session means the login check is on its way: the gate shows "checking", not the button
const hadSession = (() => { try { return Object.keys(localStorage).some(k => /^sb-.*-auth-token$/.test(k)); } catch { return false; } })();
// never echo the provider's error text from the URL (content spoofing); drop it so a reload is clean
let state = { me: null, error: urlQs.has("error") ? "Přihlášení přes Discord selhalo." : null, event: null, claims: [], rsvps: [], flash: null, checking: !!sb && (hadSession || FRESH) };
if (urlQs.has("error")) history.replaceState(null, "", location.pathname + location.hash);

const LOGIN_ERR = "Přihlášení se nepovedlo. Zkus to znovu.";

async function login() {
  if (!sb) return;
  try { sessionStorage.setItem(BACK, location.hash); } catch { /* storage blocked: lands on home */ }
  try {  // auth-js throws on failure rather than returning an error
    const { error } = await sb.auth.signInWithOAuth({
      provider: "discord",
      options: { scopes: "identify guilds.members.read", redirectTo: location.origin + location.pathname },
    });
    if (error) throw error;
  } catch (e) { console.error(e); state.error = LOGIN_ERR; renderWho(); render(); }
}

// refusal text from our own `member` function; anything else (network, relay, runtime) = the plain sentence
async function errText(e) {
  console.error(e);
  try { const m = (await e.context.json()).error; if (typeof m === "string" && m) return m; } catch { /* not our JSON */ }
  return LOGIN_ERR;
}
// a failed write shows one plain sentence; the raw database error goes to the console only
const saveErr = e => { console.error(e); return "Nepodařilo se uložit, zkus to znovu."; };

async function onAuth(session) {
  // a queued event can carry a session that an earlier onAuth already signed out (Host refused): treat it as
  // logged out, else it reads members as anon and "permission denied" replaces the refusal (test_login_gate.py)
  if (session && !(await sb.auth.getSession()).data.session) session = null;
  // auth-js re-sends SIGNED_IN on every return to the tab: re-render history only when login state flips
  const was = !!state.me;
  if (!session) {
    // logged out with the content in memory: reload drops it from the page
    if (D.strategies) { location.reload(); return; }
    state.me = null; state.checking = false; renderWho(); render();
    if (chan) { sb.removeChannel(chan); chan = null; }
    loadEvent();
    haveSet = null;
    if (was && (onHistRoute() || onCardRoute())) render();
    return;
  }
  if (FRESH && session.provider_token) {
    FRESH = false;
    const { error } = await sb.functions.invoke("member", { body: { provider_token: session.provider_token } });
    if (error) { state.error = await errText(error); await sb.auth.signOut(); return; }
    let back = null;
    try { back = sessionStorage.getItem(BACK); sessionStorage.removeItem(BACK); } catch { /* storage blocked */ }
    if (back && back !== location.hash) location.hash = back;
  }
  const { data, error } = await sb.from("members").select("user_id, discord_id, name, avatar_url, is_commander")
    .eq("user_id", session.user.id).maybeSingle();
  if (error) throw error;
  if (!data) { state.error = "Nejsi ověřený člen KIN. Přihlas se znovu."; await sb.auth.signOut(); return; }
  state.me = data; state.error = null;
  // unlocks need the seasons from the content, so they load after it (both at once = haveSet never set, Viktor UAT)
  if (!was) loadContent()
    .then(() => loadUnlocks().catch(e => { console.error(e); haveSet = null; }))
    // history pages and loadout cards wait for the login to know what to load / which boxes to tick
    .then(() => { if (onHistRoute() || onCardRoute()) { const y = scrollY; render(); scrollTo(0, y); } },
      () => { state.error = "Obsah se nenačetl. Zkus stránku načíst znovu."; state.checking = false; renderWho(); render(); });
  renderWho(); loadEvent(); subscribe();
}
const onCardRoute = () => /^#\/(squad\/|s\/[^/]+\/role\/)/.test(location.hash);
const onHistRoute = () => HIST.includes(location.hash.replace(/^#\/?/, "").split(/[/?]/)[0]);

function renderWho() {
  document.getElementById("who").innerHTML = !sb ? '<span class="err">Přihlášení se nenačetlo</span>' : state.me
    ? `<a class="mlink" href="#/hrac/${encodeURIComponent(state.me.discord_id)}" title="Můj profil"><img src="${esc(state.me.avatar_url)}" alt=""><span class="nm">${esc(state.me.name)}</span></a><button type="button" class="act" data-logout>Odhlásit</button>`
    : `${state.error && D.strategies ? `<span class="err">${esc(state.error)}</span>` : ""}<button type="button" class="act" data-login>Přihlásit<span class="long"> přes Discord</span></button>`;
  navToCurrent();
}

// specs/zamek: the hub content lives in public.content, readable only by verified members
async function loadContent() {
  const { data, error } = await sb.from("content").select("data, updated_at").eq("id", "hub").single();
  if (error) throw error;
  Object.assign(D, data.data);
  D.contentAt = data.updated_at;
  state.checking = false;
  renderFoot();
  const y = scrollY; render(); scrollTo(0, y);
}

// the year only when it is not this year (an old or mistyped event must not read as current, Viktor UAT #013)
const fmtWhen = iso => { const d = new Date(iso), y = d.getFullYear() !== new Date().getFullYear();
  return d.toLocaleString("cs-CZ", { weekday: "short", day: "numeric", month: "numeric", ...(y && { year: "numeric" }), hour: "2-digit", minute: "2-digit" }); };
let chan = null;

let loadSeq = 0;
const LOAD_ERR = "Sestavu se nepodařilo načíst, zkus to znovu.";
async function loadEvent() {
  if (!state.me) { state.event = null; state.claims = []; state.rsvps = []; renderRoster(); return; }
  const seq = ++loadSeq;
  try {
    const { data: ev, error } = await sb.from("events").select("id, strategy_id, doctrine, starts_at, leader:members!events_created_by_fkey(name)").eq("status", "open").maybeSingle();
    if (error) throw error;
    let claims = [], rsvps = [];
    if (ev) {
      const [cl, rs] = await Promise.all([
        sb.from("claims").select("slot_key, slot_label, user_id, members(name, avatar_url, discord_id)").eq("event_id", ev.id),
        sb.from("rsvps").select("user_id, status, members(name, avatar_url, discord_id)").eq("event_id", ev.id),
      ]);
      if (cl.error) throw cl.error;
      if (rs.error) throw rs.error;
      claims = cl.data; rsvps = rs.data;
    }
    // swap the whole state at once, and only for the newest load (a slower old response must not win)
    if (seq !== loadSeq) return;
    state.event = ev; state.claims = claims; state.rsvps = rsvps; state.evErr = false;
    if (state.flash === LOAD_ERR) state.flash = null;  // connection is back: drop only our own outage message
  } catch (e) {
    // keep the last known roster: an empty "no event open" would lie and offer a second event (Viktor UAT #003)
    if (seq !== loadSeq) return;
    console.error(e);
    state.evErr = true; state.flash = LOAD_ERR;
  }
  renderRoster();
}

async function setRsvp(status) {
  const { error } = await sb.from("rsvps").upsert(
    { event_id: state.event.id, user_id: state.me.user_id, status, updated_at: new Date().toISOString() },
    { onConflict: "event_id,user_id" });
  state.flash = !error ? null : error.code === "42501" ? "Akce už je uzavřená." : saveErr(error);
  await loadEvent();
}

const RSVP = [["yes", "Přijdu"], ["maybe", "Možná"], ["no", "Nemůžu"]];
function rsvpBar() {
  const meId = state.me.user_id, claimed = new Set(state.claims.map(c => c.user_id));
  const member = {}, said = {};
  for (const r of state.rsvps) { member[r.user_id] = r.members; said[r.user_id] = r.status; }
  for (const c of state.claims) member[c.user_id] = c.members;
  // a slot counts as "yes"; saying "no" while holding a slot shows a hint to free it
  const group = { yes: [], maybe: [], no: [] };
  // an explicit "no" wins over a forgotten slot, so the Commander's head count is not inflated
  for (const u of Object.keys(member)) (group[said[u] === "no" ? "no" : claimed.has(u) ? "yes" : said[u]] || []).push(member[u]);
  const mine = said[meId] || (claimed.has(meId) ? "yes" : null);
  const hint = said[meId] === "no" && claimed.has(meId) ? "Máš místo v sestavě: uvolni ho, ať ho vezme někdo jiný."
    : said[meId] === "yes" && !claimed.has(meId) ? "Vyber si místo v sestavě níže." : "";
  return `<div class="rsvp" role="group" aria-label="Přijdeš?"><span class="rl" aria-hidden="true">Přijdeš?</span>${RSVP.map(([k, l]) => `<button type="button" class="act" data-rsvp="${k}" aria-pressed="${mine === k}">${l}</button>`).join("")}
    <span class="rc">přijde <b>${group.yes.length}</b> · možná <b>${group.maybe.length}</b> · nemůže <b>${group.no.length}</b></span></div>
    ${hint ? `<p class="note rsvp-hint">${hint}</p>` : ""}
    ${Object.keys(member).length ? `<details class="rsvp-who"><summary>Kdo se ozval</summary>${RSVP.map(([k, l]) => group[k].length ? `<p><b>${l}:</b> ${group[k].map(memberLink).join(" ")}</p>` : "").join("")}</details>` : ""}`;
}

function subscribe() {
  if (chan) return;
  // ponytail: any change -> refetch the whole (≤ 45 rows) roster; diffing is not worth it
  chan = sb.channel("sestava")
    .on("postgres_changes", { event: "*", schema: "public", table: "claims" }, () => loadEvent())
    .on("postgres_changes", { event: "*", schema: "public", table: "events" }, () => loadEvent())
    .on("postgres_changes", { event: "*", schema: "public", table: "rsvps" }, () => loadEvent())
    .subscribe();
}

function slotRow(x, c) {
  const mine = c && c.user_id === state.me.user_id;
  const who = c ? `<img src="${esc(c.members.avatar_url)}" alt="" loading="lazy"><span class="nm">${esc(c.members.name)}</span>` : '<span class="free">volné</span>';
  const act = mine ? `data-unclaim="${esc(c.user_id)}" title="Odhlásit se"` : c ? "disabled" : `data-claim="${esc(x.key)}"`;
  const kick = c && !mine && state.me.is_commander
    ? `<button type="button" class="kick" data-unclaim="${esc(c.user_id)}" aria-label="Odhlásit ${esc(c.members.name)}">${cross()}</button>` : "";
  return `<li${mine ? ' class="is-me"' : ""}><button type="button" class="rslot" ${act}><span class="lbl">${x.role ? `<span class="rid">${esc(x.role)}</span>` : ""}${esc(x.label)}</span>${who}</button>${kick}</li>`;
}

function rosterGroup(g, by) {
  const n = g.slots.filter(x => by[x.key]).length;
  return `<div class="rg"><div class="pg-head">${sym(g.symbol, "sm")}<div><b>${esc(g.name)}</b><small>${esc(g.squad)}</small></div><span class="num">${n}/${g.max}</span></div>
    <ul>${g.slots.map(x => slotRow(x, by[x.key])).join("")}</ul></div>`;
}

function viewRoster(s) {
  const head = "<h2>Sestava</h2>";
  const msg = state.flash ? `<p class="err ros-msg" role="alert">${esc(state.flash)}</p>` : "";
  if (!sb) return `${head}<p class="note">Sestava se teď nenačetla (knihovna přihlášení není dostupná). Plán níže funguje dál.</p>`;
  if (!state.me) return `${head}<p class="note">Sestava je jen pro členy KIN. <button type="button" class="act" data-login>Přihlásit přes Discord</button></p>`;
  const ev = state.event;
  if (!ev) return state.evErr ? `${head}${msg}`
    : `${head}${state.me.is_commander ? newEventForm(s) : '<p class="note">Žádná akce není otevřená. Založí ji Commander.</p>'}${msg}`;
  const other = S(ev.strategy_id);
  const cancel = state.me.is_commander ? cancelEventForm() : "";
  if (!forPlan(ev, s)) return `${head}<p class="note">Otevřená akce (${esc(fmtWhen(ev.starts_at))}) ${ev.doctrine === "swarm"
    ? 'je Top attack: sestava je na <a href="#/doktrina/swarm">plátně SWARM</a>'
    : `je pro <a href="#/s/${esc(ev.strategy_id)}">${esc(other ? sideLabel(other) : ev.strategy_id)}</a>`}.</p>${msg}${cancel}`;
  const by = Object.fromEntries(state.claims.map(c => [c.slot_key, c]));
  const filled = state.claims.filter(c => s.roster.some(g => g.slots.some(x => x.key === c.slot_key))).length;
  const total = s.roster.reduce((n, g) => n + g.max, 0);
  // without builders and logistics there is no FOB and no supplies: show the plan's fill order still open
  const missing = (s.fill_order || []).filter(id => !by[id]).map(id => roleOf(s, id)).filter(Boolean);
  // first 6 only: glanceable at a briefing and fewer chips to hit by mistake on a phone (a tap moves your slot)
  const miss = s.swarm ? slBar(filled)
    : missing.length
    ? `<p class="miss">Chybí: ${missing.slice(0, 6).map(r => `<button type="button" class="rid" data-claim="${esc(r.id)}" title="${esc(r.id)} – ${esc(r.name)}">${esc(r.id)}</button>`).join(" ")}${missing.length > 6 ? ` <span class="more">a dalších ${missing.length - 6}</span>` : ""}</p>`
    : '<p class="miss ok">Všechny role z plánu obsazené.</p>';
  return `<div class="ros-head">${head}<span class="num">${filled} <small>/ ${total}</small></span><time datetime="${esc(ev.starts_at)}">${esc(fmtWhen(ev.starts_at))}</time>${s.swarm ? `<span class="lead">Top attack (SWARM) · ${esc(sideOf(ev.strategy_id))}</span>` : ""}${ev.leader ? `<span class="lead">Vede: <b>${esc(ev.leader.name)}</b></span>` : ""}</div>
    ${msg}
    ${state.me.is_commander ? closeEventForm(s) : ""}
    ${cancel}
    ${miss}
    ${rsvpBar()}
    <div class="ros">${s.roster.map(g => rosterGroup(g, by)).join("")}</div>`;
}

// realtime and tab-return re-render the block: keep what the Commander is typing into a form
// an open SWARM event: every other page points there (a saved role opens the Top defence card, Viktor #001)
function renderEvBar() {
  const ev = state.me && state.event, bar = document.getElementById("evbar");
  if (bar) bar.innerHTML = ev && ev.doctrine === "swarm" && !(plan && plan.swarm)
    ? `<a href="#/doktrina/swarm"><b>Akce ${esc(fmtWhen(ev.starts_at))}: Top attack (SWARM).</b> Sestava a co koupit jsou na plátně SWARM.</a>` : "";
}

function renderRoster() {
  renderEvBar();
  const home = document.getElementById("home-ev");
  if (home) home.innerHTML = homeEvent();
  const el = document.getElementById("sestava");
  if (!el || !plan) return;
  const keep = [...el.querySelectorAll("form[data-form]")].map(f => [f.dataset.form,
    [...f.elements].filter(x => x.name).map(x => [x.name, x.type === "checkbox" ? x.checked : x.value])]);
  const opened = [...el.querySelectorAll("details[open]")].map(d => d.className);
  keepFocus(() => { el.innerHTML = viewRoster(plan); });
  const pb = document.getElementById("plan-body");
  if (pb && pb.dataset.swarm !== String(+swarmEv())) {
    pb.dataset.swarm = String(+swarmEv());
    pb.innerHTML = swarmEv() ? SWARM_BOX : planMatrix;
    applyTrace();
  }
  for (const c of opened) { const d = el.querySelector(`details.${c}`); if (d) d.open = true; }
  for (const [name, fields] of keep) {
    const f = el.querySelector(`form[data-form="${name}"]`);
    if (!f) continue;
    for (const [k, v] of fields) { const x = f.elements[k]; if (!x) continue; if (x.type === "checkbox") x.checked = v; else x.value = v; }
  }
  el.querySelectorAll('select[name="doctrine"]').forEach(swarmHint);
}

async function claim(key) {
  const s = plan;  // the page may change while saving (render() resets plan off roster pages, Viktor #029)
  const g = s.roster.find(g => g.slots.some(x => x.key === key)), slot = g.slots.find(x => x.key === key);
  const { error } = await sb.from("claims").upsert(
    // SWARM: one role, not "Swarm · 14" (stats count labels as roles, Viktor #005)
    { event_id: state.event.id, slot_key: key, slot_label: s.swarm ? g.name : `${g.name} · ${slot.label}`, user_id: state.me.user_id },
    { onConflict: "event_id,user_id" });
  await loadEvent();
  if (error && error.code === "23505") {
    const c = state.claims.find(c => c.slot_key === key);
    state.flash = `Slot už obsadil ${c ? c.members.name : "někdo jiný"}.`;
  } else if (error) state.flash = error.code === "42501" ? "Akce už je uzavřená." : saveErr(error);
  else {
    if (!state.evErr) state.flash = null;  // saved, but the reload failed: keep the outage message
    if (slot.role) { me.set(`${s.id}/${slot.role}`); if (plan === s) renderNav(s.id); }
  }
  renderRoster();
}

async function unclaim(userId) {
  const { error } = await sb.from("claims").delete().eq("event_id", state.event.id).eq("user_id", userId);
  state.flash = !error ? null : error.code === "42501" ? "Akce už je uzavřená." : saveErr(error);
  await loadEvent();
}

document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") loadEvent(); });

// SWARM: Petr 2026-10-18 "1 squad leader na 5 lidi", every SL leads the whole swarm
function slBar(n) {
  const sl = new Set(plan.roster.find(g => g.id === "SL").slots.map(x => x.key));  // roster keys, not a prefix (OWASP L1)
  const need = Math.ceil(n / 5), have = state.claims.filter(c => sl.has(c.slot_key)).length;
  return n ? `<p class="miss${have >= need ? " ok" : ""}">Je vás ${n}: potřeba ${need} SL, máte ${have}.</p>`
    : '<p class="miss">Zatím nikdo. Na každých 5 lidí je potřeba 1 Squad leader.</p>';
}

function newEventForm(s) {
  // the SWARM canvas belongs to no map: ask which map and side the event is for (kept for history)
  const pick = s.swarm
    ? `<label>Mapa a strana <select name="strategy" required>${D.strategies.map(x => `<option value="${esc(x.id)}">${esc(sideLabel(x))}</option>`).join("")}</select></label>`
    : '<label>Doktrína <select name="doctrine"><option value="defence">Top defence (plán mapy)</option><option value="swarm">Top attack (SWARM)</option></select></label>'
      + '<p class="note wide swarm-hint" hidden>Top attack nemá plán pro jednotlivé mapy. Opening níže patří k Top defence, po založení tě to přepne na plátno SWARM.</p>';
  return `<form class="evf" data-form="new"><p class="note">Žádná akce není otevřená.</p>
    <label>Začátek <input type="datetime-local" name="starts" required min="${new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)}T00:00"></label>
    ${pick}
    <button type="submit" class="act">Založit akci: ${s.swarm ? "Top attack (SWARM)" : esc(sideLabel(s))}</button></form>`;
}

function closeEventForm(s) {
  return `<details class="evclose"><summary>Uzavřít akci a uložit do historie</summary><form class="evf" data-form="close">
    <label>Umístění <select name="placement" required><option value="">vyber</option><option value="1">1.</option><option value="2">2.</option><option value="3">3.</option></select></label>
    ${s.variants.length ? `<label>Kontaktní zóna <select name="variant" required>${s.variants.map(v => `<option value="${esc(v.id)}"${v.id === curVariant ? " selected" : ""}>${esc(v.name)}</option>`).join("")}</select></label>` : ""}
    ${state.claims.length ? `<fieldset class="atts"><legend>Kdo opravdu hrál (odškrtni, kdo nepřišel)</legend>${state.claims.map(c =>
      `<label class="att"><input type="checkbox" name="att_${esc(c.user_id)}" checked>${esc(c.members.name)}</label>`).join("")}</fieldset>` : ""}
    <p class="note wide">Debrief uvidí všichni členové v historii, docházku jen ty a dotyčný.</p>
    <label class="wide">Co fungovalo <textarea name="went_well" maxlength="2000" rows="2"></textarea></label>
    <label class="wide">Co ne <textarea name="went_wrong" maxlength="2000" rows="2"></textarea></label>
    <label class="wide">Co příště jinak <textarea name="next_time" maxlength="2000" rows="2"></textarea></label>
    <button type="submit" class="act">Uzavřít akci</button></form></details>`;
}

// a test or mistyped event: gone from the roster, never in history (008); <details> is the "are you sure" step
function cancelEventForm() {
  return `<details class="evcancel"><summary>Zrušit akci</summary><p class="note">Akce zmizí i se sestavou a do historie se neuloží. Pro odehranou akci použij „Uzavřít akci“.</p>
    <button type="button" class="act" data-cancel>Zrušit akci</button></details>`;
}

async function cancelEvent(btn) {
  btn.disabled = true;
  // RLS that matches no row (no longer open, Commander rights lapsed) is not an error: count the rows
  const { data, error } = await sb.from("events").update({ status: "cancelled" }).eq("id", state.event.id).select("id");
  state.flash = error ? saveErr(error) : !data.length ? "Akci se nepodařilo zrušit: už není otevřená, nebo nemáš práva Commandera." : null;
  await loadEvent();
}

function swarmHint(sel) { const h = sel.form && sel.form.querySelector(".swarm-hint"); if (h) h.hidden = sel.value !== "swarm"; }
document.addEventListener("change", e => { if (e.target.name === "doctrine") swarmHint(e.target); });

document.addEventListener("submit", async e => {
  const f = e.target.closest("form[data-form]");
  if (!f) return;
  e.preventDefault();
  const btn = f.querySelector('button[type="submit"]');
  if (btn.disabled) return;  // double click: the first submit is still saving
  btn.disabled = true;
  const s = plan;  // before any await: leaving the page mid-save resets plan (OWASP L2)
  const v = Object.fromEntries(new FormData(f)), eventId = state.event && state.event.id;
  // attendance = exactly what the Commander saw and ticked in this form (state.claims may be mid-reload);
  // written first: if closing fails the event stays open and this upsert can simply run again
  const att = [...f.querySelectorAll('input[name^="att_"]')].map(x => ({ event_id: eventId, user_id: x.name.slice(4), attended: x.checked }));
  if (f.dataset.form === "close" && att.length) {
    const { error: e1 } = await sb.from("attendance").upsert(att, { onConflict: "event_id,user_id" });
    if (e1) { state.flash = e1.code === "42501" ? "Docházku se nepodařilo uložit, zkus to znovu." : saveErr(e1); btn.disabled = false; renderRoster(); return; }
  }
  const doctrine = s.swarm ? "swarm" : v.doctrine || "defence";
  const { error } = f.dataset.form === "new"
    ? await sb.from("events").insert({ strategy_id: v.strategy || s.id, doctrine, starts_at: new Date(v.starts).toISOString() })
    : await sb.from("events").update({ status: "closed", placement: Number(v.placement), variant: v.variant || null,
        went_well: v.went_well || null, went_wrong: v.went_wrong || null, next_time: v.next_time || null }).eq("id", eventId);
  state.flash = !error ? null : error.code === "23505" ? "Už je otevřená jiná akce." : saveErr(error);
  btn.disabled = false;
  // a SWARM event founded on a map page: its roster lives on the SWARM canvas, go there
  if (!error && f.dataset.form === "new" && doctrine === "swarm" && !s.swarm) location.hash = "#/doktrina/swarm";
  await loadEvent();
});

// supabase-js fires 2-3 session events after the Discord round trip; run onAuth one at a time so the
// fresh call creates the members row before the next one looks it up (otherwise: "not a member" + logout)
let authQ = Promise.resolve();
function authEvent(ev, session) {
  if (!["INITIAL_SESSION", "SIGNED_IN", "SIGNED_OUT"].includes(ev)) return;
  // never await Supabase calls inside the auth callback (supabase-js deadlock), hand off instead
  // a raw database error means nothing to a player (OWASP A10): plain message on the page, detail in the console
  // already logged in: a failed re-check on tab return (sleepy phone network) must not re-render the page (Viktor #022)
  setTimeout(() => { authQ = authQ.then(() => onAuth(session)).catch(e => { console.error(e); if (state.me) return; state.error = LOGIN_ERR; state.checking = false; renderWho(); render(); }); });
}
if (sb) sb.auth.onAuthStateChange(authEvent);
else setTimeout(() => { renderWho(); renderRoster(); });
document.addEventListener("click", e => {
  if (e.target.closest("[data-login]")) login();
  else if (e.target.closest("[data-logout]")) sb.auth.signOut();
});
const $app = document.getElementById("app");
const KEY = "wrd.role";
let cur = null;    // current strategy
// the roster this page signs people up to: the map plan (Top defence) or the SWARM canvas (specs/akce-swarm)
let plan = null;
const swarmPlan = () => ({ id: "swarm", swarm: true, roster: D.doktrina.swarm.roster, fill_order: [], variants: [] });
// an open SWARM event: the map's Top defence opening does not apply (Petr 2026-10-18), the canvas does
const swarmEv = () => !!(state.me && state.event && state.event.doctrine === "swarm");
const SWARM_BOX = '<section class="block swarm-plan"><h2>Dnes Top attack (SWARM)</h2><p>Opening Top defence na této mapě dnes neplatí. Sestava, nákup a postupy jsou na <a href="#/doktrina/swarm">plátně SWARM</a>. Kontaktní zóny nahoře platí dál.</p></section>';
let planMatrix = "";  // the map's Top defence plan, kept to swap back when the SWARM event ends
const forPlan = (ev, s) => s.swarm ? ev.doctrine === "swarm" : ev.doctrine !== "swarm" && ev.strategy_id === s.id;
let trace = null;  // traced role id on the canvas
let curVariant = null;  // control-zone placement shown for the current strategy
const inV = x => !x.variants || x.variants.includes(curVariant);
function pickVariant(s, qs) {
  const ok = id => s.variants.some(v => v.id === id);
  const fromUrl = new URLSearchParams(qs).get("v");
  let stored = null;
  // keyed by map: the zone belongs to the map and match, not the side
  try { stored = localStorage.getItem("wrd.variant." + s.map); } catch { /* storage blocked */ }
  if (ok(fromUrl) && fromUrl !== stored) {  // a shared link with ?v= lasts past the first click (Viktor #025)
    try { localStorage.setItem("wrd.variant." + s.map, fromUrl); } catch { /* storage blocked: the tabs carry ?v= */ }
  }
  return [fromUrl, stored].find(ok) || (s.variants[0] && s.variants[0].id) || null;
}

const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
  .replace(/ -&gt; /g, " → ").replace(/ - /g, " – ");  // content stays ASCII, display gets real arrows and dashes
const usd = n => "$" + n.toLocaleString("cs-CZ");
const me = {
  get() { try { return localStorage.getItem(KEY); } catch { return null; } },
  set(v) { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch { /* storage blocked: page still works */ } },
};
const S = id => D.strategies.find(s => s.id === id);
const roleOf = (s, id) => s.roles.find(r => r.id === id);
const groupOf = (s, id) => s.groups.find(g => g.id === id);
const phaseOf = (s, id) => s.phases.find(p => p.id === id);
const squadDoc = name => D.squads.find(q => q.name === name) || D.doktrina.squads.find(q => q.name === name);
const roleHref = (s, r) => `#/s/${s.id}/role/${r.id}`;
const sideLabel = s => `${s.map} · ${s.color}`;
const SQ = id => D.squads.find(q => q.id === id);
const classOf = (q, id) => q.classes.find(c => c.id === id);
const classById = id => { for (const q of D.squads) { const c = classOf(q, id); if (c) return [q, c]; } return []; };
const classHref = (q, c) => `#/squad/${q.id}/${c.id}`;
let kmode = (() => { try { return localStorage.getItem("wrd.kitmode") === "ideal" ? "ideal" : "min"; } catch { return "min"; } })();

// APP-6 friendly unit symbols, squad echelon dot above the frame
function sym(kind, cls = "") {
  const icon = {
    infantry: '<path d="M6 6 L42 30 M42 6 L6 30"/>',
    engineer: '<path d="M15 14 H33 M15 14 V23 M24 14 V23 M33 14 V23"/>',
    supply: '<path d="M6 24 H42"/>',
    recon: '<path d="M6 30 L42 6"/>',
    armor: '<path d="M16 12 H32 A6 6 0 0 1 32 24 H16 A6 6 0 0 1 16 12 Z"/>',
    hq: '<path d="M6 30 V42"/>',
  }[kind] || "";
  return `<svg class="sym ${cls}" viewBox="0 -6 48 50" aria-hidden="true"><circle class="ech" cx="24" cy="0" r="2.4"/><rect x="6" y="6" width="36" height="24"/>${icon}</svg>`;
}
const arrow = () => '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M1 8 H14 M9 3 L14 8 L9 13"/></svg>';
const cross = () => '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3 L13 13 M13 3 L3 13"/></svg>';
const out = () => '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3 H13 V10 M13 3 L4 12"/></svg>';

function vById(s, id) { return s.variants.find(v => v.id === id); }
function vtag(s, x) { return x.variants && curVariant ? `<span class="vtag">jen ${esc(vById(s, curVariant).name)}</span>` : ""; }
function variantBar(s) {
  if (!s.variants.length) return "";
  return `<div class="vbar" role="group" aria-label="Varianta kontaktní zóny"><span class="vlbl">Kontaktní zóna</span>${s.variants.map(v =>
    `<button type="button" data-variant="${esc(v.id)}" aria-pressed="${v.id === curVariant}"><b>${esc(v.name)}</b><small>${v.towers.length} věže${v.status === "NÁVRH" ? " · návrh" : ""}</small></button>`).join("")}</div>`;
}

// Situation sketch drawn from map data: meters, +x east, +y south, origin = sketch_origin (Ozeti: church)
function sketchSvg(s, vid) {
  const k = s.sketch, W = 1250, H = 1000, sel = vById(s, vid);
  const pts = a => a.map(([x, y]) => `${x},${y}`).join(" ");
  const zones = k.zones.map(z => `<polygon class="z-${z.kind}" points="${pts(z.poly)}"/>`).join("");
  const circles = s.variants.map(v => `<circle class="cz${v.id === vid ? " on" : ""}" cx="${v.xy[0]}" cy="${v.xy[1]}" r="${v.r}"/>`).join("");
  const label = `<text class="czl" x="${sel.xy[0]}" y="${sel.xy[1] - sel.r - 26}" text-anchor="middle">${esc(sel.name)}</text>`;
  const towers = k.towers.map(t => {
    const on = sel.towers.includes(t.name), n = t.name.replace("Tower ", "");
    return `<g class="tw${on ? " on" : ""}"><rect x="${t.xy[0] - 34}" y="${t.xy[1] - 34}" width="68" height="68" transform="rotate(45 ${t.xy[0]} ${t.xy[1]})"/><text x="${t.xy[0]}" y="${t.xy[1] + 22}" text-anchor="middle">${n}</text></g>`;
  }).join("");
  const t2 = k.towers.find(t => t.name === k.base_tower);
  const base = t2 ? `<text class="lbl fr" x="${t2.xy[0] + 70}" y="${t2.xy[1] + 105}">hlavní báze</text>` : "";
  const [cx, cy] = k.landmark.xy;
  const mark = k.landmark.icon === "cross" ? `<path class="cross" d="M${cx} ${cy - 46} V${cy + 46} M${cx - 30} ${cy - 16} H${cx + 30}"/>` : `<circle class="cross" cx="${cx}" cy="${cy}" r="18"/>`;
  const church = `${mark}<text class="lbl" x="${cx + 48}" y="${cy - 22}">${esc(k.landmark.label)}</text>`;
  const arrows = s.approaches.map(a => {
    const b = a.bearing * Math.PI / 180, dx = Math.sin(b), dy = -Math.cos(b);
    const rx = Math.min(W / Math.abs(dx || 1e-9), H / Math.abs(dy || 1e-9)) - 120;
    const x1 = dx * rx, y1 = dy * rx, x2 = dx * (rx - 230), y2 = dy * (rx - 230);
    const hx = -dy, hy = dx, ax = x2 + dx * 60, ay = y2 + dy * 60;
    return `<g class="ap ${esc(a.side)}"><line x1="${x1}" y1="${y1}" x2="${x2 + dx * 40}" y2="${y2 + dy * 40}"/><path d="M${x2} ${y2} L${ax + hx * 45} ${ay + hy * 45} L${ax - hx * 45} ${ay - hy * 45} Z"/><text x="${x1}" y="${y1 + (dy > 0 ? 70 : -40)}" text-anchor="${dx > 0.3 ? "end" : dx < -0.3 ? "start" : "middle"}">${esc(a.label)}</text></g>`;
  }).join("");
  const scale = `<g class="scale"><line x1="${-W + 80}" y1="${H - 80}" x2="${-W + 580}" y2="${H - 80}"/><text x="${-W + 80}" y="${H - 110}">500 m</text></g>`;
  const north = `<g class="north"><path d="M${W - 110} ${-H + 190} L${W - 110} ${-H + 70} M${W - 140} ${-H + 110} L${W - 110} ${-H + 70} L${W - 80} ${-H + 110}"/><text x="${W - 110}" y="${-H + 240}" text-anchor="middle">S</text></g>`;
  return `<svg class="sketch" viewBox="${-W} ${-H} ${2 * W} ${2 * H}" role="img" aria-label="Náčrtek varianty ${esc(sel.name)}">
    <rect x="${-W}" y="${-H}" width="${2 * W}" height="${2 * H}" class="bg"/>${zones}
    ${k.river.length ? `<polyline class="river" points="${pts(k.river)}"/>` : ""}${circles}${label}${towers}${church}${base}${arrows}${scale}${north}</svg>`;
}

function variantPanel(s) {
  const v = curVariant && vById(s, curVariant);
  if (!v) return "";
  return `<section class="vpanel" aria-label="Varianta ${esc(v.name)}">${sketchSvg(s, v.id)}
    <div class="vtx"><div class="t-row"><h2 class="vh">Varianta ${esc(v.name)}</h2>${v.status === "NÁVRH" ? '<span class="tag draft" title="Návrh od Clauda, Commander ho zatím neschválil">Návrh</span>' : ""}</div>
      <p class="vsum">${esc(v.summary)}</p>
      <p class="vtw">Věže v zóně: ${v.towers.map(t => `<span class="ref">${esc(t.replace("Tower ", "T"))}</span>`).join(" ")}</p>
      ${v.changes.length ? `<h2>${v.id === s.variants[0].id ? "Na co myslet" : "Co je jinak než v Default"}</h2><ul class="bullets">${v.changes.map(c => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
      <p class="note">Náčrtek z dat metaforge${s.sketch.river.length ? ", řeka přibližně" : ""}. Kruhy ostatních variant čárkovaně.</p></div></section>`;
}

function chip(s, id, label = id) { return `<button type="button" class="rid" data-trace="${esc(id)}" aria-pressed="false" title="Zvýraznit ${esc(id)} ve všech fázích">${esc(label)}</button>`; }
// AS1-V AS1-M1 AS1-M2 -> AS1-V M1 M2: same squad prefix written once
function chips(s, ids) {
  const pre = ids.length > 1 && new Set(ids.map(id => id.split("-")[0])).size === 1 && ids.every(id => id.includes("-")) ? ids[0].split("-")[0] + "-" : "";
  return ids.map((id, i) => chip(s, id, i && pre ? id.slice(pre.length) : id)).join("");
}
function roleLink(s, r) { return `<a class="rid" href="${roleHref(s, r)}">${esc(r.id)}</a>`; }
function refChip(s, ref) {
  if (ref === "*") return '<span class="ref">všichni</span>';
  const r = roleOf(s, ref); if (r) return roleLink(s, r);
  const gs = s.groups.filter(g => g.id === ref || g.squad === ref);  // a squad name ("Assault") = all its groups
  if (gs.length) return gs.map(g => `<a class="ref" href="#/s/${s.id}/squad/${g.id}">${esc(g.name)}</a>`).join(" ");
  return `<span class="ref">${esc(ref)}</span>`;
}
function unlockText(u) { return `${esc(u.track)} ${u.level}`; }

// ---------- views ----------
// open event + my status on the home page (kept current by renderRoster after every roster load)
function homeEvent() {
  if (!sb || !state.me) return "";
  const ev = state.event;
  if (!ev) return state.evErr ? `<p class="err home-ev">${LOAD_ERR}</p>` : '<p class="note home-ev">Teď není otevřená žádná akce.</p>';
  const mine = state.claims.find(c => c.user_id === state.me.user_id);
  const said = (state.rsvps || []).find(r => r.user_id === state.me.user_id);
  const status = mine ? `Máš místo: ${esc(mine.slot_label)}` : said ? `Tvoje odpověď: ${esc((RSVP.find(x => x[0] === said.status) || [, said.status])[1])}` : "Zatím bez odpovědi a bez místa: otevři sestavu";
  const swarm = ev.doctrine === "swarm";
  return `<a class="cont evc" href="${swarm ? "#/doktrina/swarm" : `#/s/${esc(ev.strategy_id)}`}"><span class="big">Akce</span><span>${esc(fmtWhen(ev.starts_at))} · ${esc(sideOf(ev.strategy_id))}${swarm ? " · Top attack" : ""}<small>${status}</small></span></a>`;
}

function viewHome() {
  const mine = me.get();
  let cont = "";
  if (mine) {
    const [sid, rid] = mine.split("/"), s = S(sid), r = s && roleOf(s, rid);
    if (r) cont = `<a class="cont" href="${roleHref(s, r)}"><span class="big">${esc(r.id)}</span><span>Pokračovat na tvou kartu<small>${esc(r.name)} · ${esc(sideLabel(s))}</small></span></a>`;
  }
  const sheets = D.strategies.map(s => `<li><a href="#/s/${s.id}"><b>${esc(s.map)}</b><span class="meta">${esc(s.color)} · ${esc(s.faction)} · ${esc(s.stage)}</span>${s.status === "DRAFT" ? '<span class="tag draft">Draft</span>' : ""}<span class="meta">${arrow()}</span></a></li>`).join("");
  const pickers = D.strategies.map((s, i) => `
    <details class="block howto"${i ? "" : " open"} aria-labelledby="pick-${s.id}">
      <summary><h2 id="pick-${s.id}">Kdo jsi? ${esc(sideLabel(s))}${arrow()}</h2></summary>
      <div class="picker">${s.groups.map(g => `
        <div class="pg"><div class="pg-head">${sym(g.symbol, "sm")}<div><b>${esc(g.name)}</b><small>${esc(g.squad)}</small></div></div>
          <ul>${s.roles.filter(r => r.group === g.id).map(r => `<li><button type="button" data-pick="${s.id}/${esc(r.id)}" class="${mine === `${s.id}/${r.id}` ? "is-me" : ""}"><span class="rid">${esc(r.id)}</span><span>${esc(r.name)}</span></button></li>`).join("")}</ul>
        </div>`).join("")}
      </div>
    </details>`).join("");
  return `
    <div class="home-head"><img class="crest" src="znacka/kin-emblem.svg" alt="Emblém Kinetic Solutions" width="150" height="150"><h1>Central Command</h1>
      <p class="lede">Strategie Kinetic Solutions. Vyber si svou roli a uvidíš, co máš dělat v každé fázi. Na briefingu jedeme podle plátna.</p>
    </div>
    ${cont}
    <div id="home-ev">${homeEvent()}</div>
    <details class="block start howto"${matchMedia("(max-width: 720px)").matches ? "" : " open"}><summary><h2 id="h-start">Jak to tu funguje${arrow()}</h2></summary><ol class="proc">
      <li><span><b>Přihlas se přes Discord</b> (vpravo nahoře). Pustí tě to dál od role Rekrut na serveru Kinetic Solutions.</span></li>
      <li><span><b>Před akcí</b> otevři plán mapy, dej <b>Přijdu</b> a zaber si místo v <b>Sestavě</b>. Co v plánu chybí, vidíš hned nahoře.</span></li>
      <li><span><b>Karta tvé role</b>: co koupit, čím jedeš, co děláš v každé fázi. Nech si ji otevřenou na mobilu nebo druhém monitoru.</span></li>
      <li><span><a href="#/squady">Squady</a>: celá výbava tvé sub-classy, minimum po wipu i ideál. Zaškrtni, co máš odemčené. Kolik nás co umí, je v <a href="#/pokryti">Pokrytí</a>.</span></li>
      <li><span><a href="#/vycvik">Výcvik</a> a <a href="#/doktrina">Doktrína</a>: jak klan hraje na všech mapách.</span></li>
      <li><span><a href="#/historie">Historie</a>: odehrané akce, sestavy a debrief po sezónách.</span></li>
    </ol></details>
    <section class="block" aria-labelledby="h-str"><h2 id="h-str">Strategie</h2><ul class="sheets">${sheets}</ul>
      <a class="doklink" href="#/doktrina">Doktrína: platí pro všechny mapy ${arrow()}</a></section>
    ${pickers}`;
}

function stratHead(s, tab) {
  const tabs = [["platno", "Plátno"], ["situace", "Situace"], ["vetve", "Větve a spouštěče"]];
  return `
    <header class="strat-head"><div><div class="t-row"><h1>${esc(s.map)} <span>· ${esc(s.color)}</span></h1>${s.status === "DRAFT" ? '<span class="tag draft" title="Strategie zatím není vyhlášená za platnou">Draft</span>' : ""}</div><p>${esc(s.faction)} · ${esc(s.stage)}</p></div></header>
    ${variantBar(s)}
    <nav class="tabs" aria-label="Strana">${D.strategies.filter(x => x.map === s.map).map(x => `<a href="#/s/${x.id}${tab === "platno" ? "" : "/" + tab}${curVariant ? "?v=" + esc(curVariant) : ""}"${x.id === s.id ? ' aria-current="page"' : ""}>${esc(x.color)}</a>`).join("")}</nav>
    <nav class="tabs" aria-label="Strategie">${tabs.map(([k, l]) => `<a href="#/s/${s.id}${k === "platno" ? "" : "/" + k}${curVariant ? "?v=" + esc(curVariant) : ""}"${k === tab ? ' aria-current="page"' : ""}>${l}</a>`).join("")}</nav>`;
}

function cellEntries(s, gid, pid) {
  const list = [];
  for (const r of s.roles.filter(r => r.group === gid))
    for (const st of r.steps.filter(st => st.phase === pid && inV(st))) {
      const same = list.find(e => e.text === st.text);
      same ? same.roles.push(r.id) : list.push({ text: st.text, roles: [r.id], vs: !!st.variants });
    }
  return list;
}

function viewCanvas(s) {
  const head = `<tr><th scope="col">Fáze</th>${s.groups.map(g => `<th scope="col"><a href="#/s/${s.id}/squad/${g.id}">${sym(g.symbol)}<span><b>${esc(g.name)}</b><small>${esc(g.squad)}</small></span></a><ul class="roster">${s.roles.filter(r => r.group === g.id).map(r => `<li><b>${esc(r.id)}</b>${esc(r.short)}</li>`).join("")}</ul></th>`).join("")}</tr>`;
  const rows = s.phases.map(p => {
    const quiet = s.groups.every(g => !cellEntries(s, g.id, p.id).length);
    const cells = quiet ? `<td colspan="${s.groups.length}" class="quiet">${esc(p.text)}</td>` : s.groups.map(g => {
      const es = cellEntries(s, g.id, p.id);
      if (!es.length) return '<td class="empty"></td>';
      return `<td>${es.map(e => `<div class="entry" data-roles="${esc(e.roles.join(" "))}"><span class="chips">${chips(s, e.roles)}${vtag(s, { variants: e.vs })}</span>${esc(e.text)}</div>`).join("")}</td>`;
    }).join("");
    const sync = p.sync ? `<tr class="sync"><td colspan="${s.groups.length + 1}"><span class="synctag">SYNC</span>${esc(p.sync)}</td></tr>` : "";
    return `<tr class="phase"><th scope="row"><span class="pl">PL ${esc(p.id)}</span><b>${esc(p.name)}</b>${p.time ? `<time>${esc(p.time)}</time>` : ""}${p.text && !quiet ? `<p>${esc(p.text)}</p>` : ""}</th>${cells}</tr>${sync}`;
  }).join("");
  planMatrix = `<div class="tracebar" id="tracebar" aria-live="polite"></div>
    <div class="matrix-wrap"><table class="matrix" id="matrix"><colgroup><col class="ph">${s.groups.map(() => "<col>").join("")}</colgroup><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
  return `
    ${variantPanel(s)}
    <section class="intent"><h2>Záměr</h2><ul class="bullets">${s.intent.map(i => `<li>${esc(i)}</li>`).join("")}</ul></section>
    <section class="sestava" id="sestava">${viewRoster(s)}</section>
    <div id="plan-body" data-swarm="${+swarmEv()}">${swarmEv() ? SWARM_BOX : planMatrix}</div>`;
}

function budgetBlock(s, gid, own = null) {
  const b = s.budget[gid]; if (!b) return "";
  const left = b.available - b.used, g = groupOf(s, gid);
  return `<div class="budget"><div class="budget-top"><b>${esc(g.name)}</b><span class="num">${b.used.toLocaleString("cs-CZ")} <small>/ ${b.available.toLocaleString("cs-CZ")} supplies</small></span></div>
    <p class="left${left < 0 ? " over" : ""}">${left < 0 ? `chybí ${(-left).toLocaleString("cs-CZ")}` : `zbývá ${left.toLocaleString("cs-CZ")} na zdi`}</p>
    <ul>${b.items.map(i => `<li${i.role === own ? ' class="own"' : ""}><span>${i.qty}× ${esc(i.item)} <span class="rid">${esc(i.role)}</span></span><span>${i.supplies.toLocaleString("cs-CZ")}</span></li>`).join("")}</ul>
    ${(b.deliveries || []).length ? `<p class="note">Dodávky: ${b.deliveries.map(d => `${esc(d.phase)} ${esc(d.what)} <span class="rid">${esc(d.by)}</span> +${d.supplies.toLocaleString("cs-CZ")}`).join(", ")}</p>` : ""}</div>`;
}

function viewSituace(s) {
  return `
    ${variantPanel(s)}
    <div class="cols block">
      <section><h2>Kdo kde je</h2><table class="data"><thead><tr><th>Kdo</th><th>Kde</th><th>Poznámka</th></tr></thead><tbody>
        ${s.situation.map(x => `<tr><td><span class="side ${esc(x.side)}"></span><b>${esc(x.who)}</b></td><td>${esc(x.where)}</td><td>${esc(x.note)}</td></tr>`).join("")}</tbody></table></section>
      <section><h2>Místa</h2><dl class="places">${s.places.filter(inV).map(p => `<dt>${esc(p.name)}</dt><dd>${esc(p.text)}</dd>`).join("")}</dl></section>
    </div>
    <div class="cols block">
      <section><h2>Palebné sektory mortarů</h2>${s.sectors.filter(inV).map(x => `<div class="sector"><b>${esc(x.keyword)}</b><span>${esc(x.area)}</span><small>${esc(x.aim)}</small></div>`).join("")}
        <p class="note">Postup palby je v <a href="#/doktrina">doktríně</a>.</p></section>
      <section><h2>Rozpočet supplies</h2>${Object.keys(s.budget).map(gid => budgetBlock(s, gid)).join("")}
        <p class="note">FOB po položení obsahuje ${s.fob_default_supplies.toLocaleString("cs-CZ")} Build Supplies. Ceny staveb: ${esc(D.snapshot)}.</p></section>
    </div>
    <div class="cols block">
      <section><h2>Pořadí obsazování rolí</h2><p class="note" style="margin:0 0 12px">Když přijde méně lidí, poslední se škrtají první.</p>
        <ol class="order">${s.fill_order.map(id => `<li>${roleLink(s, roleOf(s, id))}</li>`).join("")}</ol></section>
      <section><h2>Interaktivní mapy</h2><p class="links">${s.links.map(l => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.name)} ${out()}</a>`).join("")}</p></section>
    </div>`;
}

function rxList(s, items, withWho = true) {
  return items.map(x => `<div class="rx"><div class="when">${esc(x.when)}</div><div class="arrow">${arrow()}</div><div class="then">${esc(x.then)}</div>${withWho && x.roles ? `<div class="who">${x.roles.map(ref => refChip(s, ref)).join("")}</div>` : ""}</div>`).join("");
}

function viewVetve(s) {
  return `
    <section class="block narrow"><h2>Spouštěče: stane se kdykoli, reaguj hned</h2>${rxList(s, s.triggers.filter(inV))}</section>
    <section class="block narrow"><h2>Větve: když se situace vyvine</h2>${rxList(s, s.branches.filter(inV))}</section>`;
}

function viewStrategy(s, tab) {
  const body = tab === "situace" ? viewSituace(s) : tab === "vetve" ? viewVetve(s) : viewCanvas(s);
  return stratHead(s, tab) + body;
}

function kitCell(price, qty) { return price == null ? '<span class="dash">-</span>' : qty === "?" ? `${usd(price)} <span class="unk">× ?</span>` : usd(price * qty); }

function itemIcon(src, cls = "") {
  return src ? `<img class="item ${cls}" src="${esc(src)}" alt="" loading="lazy">` : `<span class="item none ${cls}" aria-hidden="true"></span>`;
}
function priceLine(price, qty) {
  if (price == null) return "";
  if (qty === "?") return `${usd(price)} / ks, počet <span class="unk">?</span>`;
  return qty > 1 ? `${usd(price)} / ks · celkem ${usd(price * qty)}` : usd(price);
}
function shopList(s, r) {
  if (!r.gear.length) return `<p class="note" style="margin-top:0">${r.class ? "Nic navíc." : "Nic předepsaného."}</p>`;
  const k = r.extras_kit, part = k.partial ? ' <span class="unk">+ ?</span>' : "";
  const um = k.unlocks_min.map(u => `<span class="ref">${unlockText(u)}</span>`).join("");
  const ui = k.unlocks_ideal.map(u => `<span class="ref">${unlockText(u)}</span>`).join("");
  const tiles = r.gear.map(g => {
    const opt = !g.item, name = g.item || g.ideal, unlock = opt ? g.ideal_unlock : g.unlock;
    const std = g.std ? `<div class="alt">${itemIcon(g.std_icon, "sm")}<span>Mezistupeň: <b>${esc(g.std)}</b> · ${usd(g.std_price)}${g.std_unlock ? ` · odemknout ${unlockText(g.std_unlock)}` : ""}</span></div>` : "";
    const alt = std + (g.item && g.ideal && g.ideal !== g.item
      ? `<div class="alt">${itemIcon(g.ideal_icon, "sm")}<span>Ideál: <b>${esc(g.ideal)}</b> · ${usd(g.ideal_price)}${g.ideal_unlock ? ` · odemknout ${unlockText(g.ideal_unlock)}` : ""}</span></div>` : "");
    return `<li class="tile${opt ? " opt" : ""}">${itemIcon(opt ? g.ideal_icon : g.icon)}<div class="tx">
      <div class="nm"><span class="qty">${g.qty === "?" ? '<span class="unk">?</span>' : g.qty + "×"}</span><span>${esc(name)}</span>${haveBox({ name, unlock })}</div>
      <div class="pr">${opt ? "Volitelně, když máš odemčeno · " : ""}${priceLine(opt ? g.ideal_price : g.price, g.qty)}${unlock ? ` · odemknout <b>${unlockText(unlock)}</b>` : ""}</div>
      ${g.note ? `<div class="nt">${esc(g.note)}</div>` : ""}${alt}</div></li>`;
  }).join("");
  return `<div class="shop-sum"><span>${r.class ? "Navíc za život" : "Celkem za život"}</span><b>${usd(k.min)}${part}</b>${k.ideal !== k.min ? `<span>ideál</span><b>${usd(k.ideal)}${part}</b>` : ""}${um ? `<span>odemkni</span>${um}` : ""}</div>
    <ul class="shop">${tiles}</ul>${ui && ui !== um ? `<div class="unlocks">Pro ideál: ${ui}</div>` : ""}`;
}

function roleBlock(s, r) {
  const part = r.kit.partial ? ' <span class="unk">+ ?</span>' : "";
  const strip = r.gear.map(g => `<li${g.item ? "" : ' class="opt"'}>${itemIcon(g.item ? g.icon : g.ideal_icon)}<span class="q">${g.qty === "?" ? "?" : g.qty + "×"}</span><span class="n">${esc(g.item || g.ideal)}${g.item ? "" : " (ideál)"}</span></li>`).join("");
  return `<article class="rb"><header><a class="rid big" href="${roleHref(s, r)}">${esc(r.id)}</a>
    <div class="rb-t"><a class="rn" href="${roleHref(s, r)}">${esc(r.name)}</a><p>${esc(r.transport)}</p>${r.class ? (([cq, cc]) => `<p><a class="ref" href="${classHref(cq, cc)}">${esc(cc.name)}</a></p>`)(classById(r.class)) : ""}</div>
    <div class="rb-sum">${usd(r.kit.min)}${part}${r.kit.ideal !== r.kit.min ? `<small>ideál ${usd(r.kit.ideal)}</small>` : ""}</div></header>
    ${strip ? `<ul class="strip">${strip}</ul>` : `<p class="note">${r.class ? "Jen sestava sub-classy." : "Nic předepsaného."}</p>`}</article>`;
}

function viewRole(s, r) {
  const g = groupOf(s, r.group), mine = me.get() === `${s.id}/${r.id}`;
  const sib = s.roles.filter(x => x.group === r.group), i = sib.indexOf(r);
  const prev = sib[i - 1], next = sib[i + 1];
  const builds = r.builds.length ? `<section class="block"><h2>Stavba báze (tvoje položky tučně)</h2>${budgetBlock(s, r.group, r.id)}</section>` : "";
  return `
    <div class="narrow"><p class="crumb"><a href="#/s/${s.id}">${esc(sideLabel(s))}</a> / <a href="#/s/${s.id}/squad/${g.id}">${esc(g.name)}</a> / ${esc(r.id)}</p>
    <header class="role-head"><span class="code">${esc(r.id)}</span>
      <div class="grow"><h1>${esc(r.name)}</h1><p>${esc(r.squad)} · ${esc(g.name)}</p></div>
      <button type="button" class="me-btn" data-me="${s.id}/${esc(r.id)}" aria-pressed="${mine}">${mine ? "Tvoje role" : "To jsem já"}</button></header>
    ${variantBar(s)}
    <section class="block"><h2>Doprava</h2><p class="transport">${esc(r.transport)}</p></section>
    ${(() => { const [cq, cc] = classById(r.class), part = r.kit.partial ? ' <span class="unk">+ ?</span>' : "";
      return `<section class="block"><h2>Nákup na spawnu</h2>${cc ? `<div class="shop-sum"><span>Celkem za život</span><b>${usd(r.kit.min)}${part}</b><span>ideál</span><b>${usd(r.kit.ideal)}${part}</b></div>
        <p class="note" style="margin:0 0 4px">Sestava <a href="${classHref(cq, cc)}">${esc(cc.name)}</a> (platí na všech mapách) + co role potřebuje na téhle mapě.</p>
        ${modeBar()}${classCard(cq, cc, kmode)}<h2 class="block">Navíc pro tuto roli</h2>` : ""}${shopList(s, r)}<p class="gnote">${esc(s.gear_note)}</p></section>`; })()}
    <section class="block"><h2>Kroky</h2><ol class="steps">
      ${r.steps.filter(inV).map(st => { const p = phaseOf(s, st.phase); return `<li><div class="ph"><span class="pl">PL ${esc(p.id)}</span><b>${esc(p.name)}</b>${vtag(s, st)}</div><p>${esc(st.text)}</p></li>`; }).join("")}
      ${r.after ? `<li class="after"><div class="ph"><b>Trvale</b></div><p>${esc(r.after)}</p></li>` : ""}</ol></section>
    ${r.reactions.filter(inV).length ? `<section class="block"><h2>Když se stane</h2>${rxList(s, r.reactions.filter(inV), false)}</section>` : ""}
    ${r.dont.length ? `<section class="block"><h2>Nedělej</h2><ul class="dont">${r.dont.map(d => `<li>${cross()}<span>${esc(d)}</span></li>`).join("")}</ul></section>` : ""}
    ${builds}
    <section class="block"><h2>Platí pro všechny</h2><ul class="bullets">${s.rules_all.map(x => `<li>${esc(x)}</li>`).join("")}</ul></section>
    <nav class="pager" aria-label="Role ve skupině">${prev ? `<a href="${roleHref(s, prev)}">${esc(prev.id)} · ${esc(prev.name)}</a>` : "<span></span>"}${next ? `<a href="${roleHref(s, next)}">${esc(next.id)} · ${esc(next.name)}</a>` : "<span></span>"}</nav></div>`;
}

function viewSquad(s, g) {
  const doc = squadDoc(g.squad), roles = s.roles.filter(r => r.group === g.id);
  const phases = s.phases.map(p => ({ p, es: cellEntries(s, g.id, p.id) })).filter(x => x.es.length);
  return `
    <p class="crumb"><a href="#/s/${s.id}">${esc(sideLabel(s))}</a> / ${esc(g.name)}</p>
    <header class="unit-head">${sym(g.symbol, "lg")}<div><h1>${esc(g.name)}</h1><p>Squad ${esc(g.squad)}</p></div></header>
    ${variantBar(s)}
    ${doc ? `<p class="goal">${esc(doc.goal)}</p><ul class="bullets block" style="margin-top:16px">${doc.points.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    <section class="block"><h2>Role a nákup</h2>${roles.map(r => roleBlock(s, r)).join("")}</section>
    <section class="block"><h2>Opening</h2><ol class="steps">${phases.map(({ p, es }) => `<li><div class="ph"><span class="pl">PL ${esc(p.id)}</span><b>${esc(p.name)}</b></div><div>${es.map(e => `<p style="margin-bottom:6px"><span class="chips">${e.roles.map(id => roleLink(s, roleOf(s, id))).join(" ")}</span> ${esc(e.text)}</p>`).join("")}</div></li>`).join("")}</ol></section>
    ${s.budget[g.id] ? `<section class="block narrow"><h2>Rozpočet supplies</h2>${budgetBlock(s, g.id)}</section>` : ""}`;
}

// specs/doktrina: two tabs with the same skeleton (Jádro, Principy, Velení a komunikace, Squady a role, Postupy, Protokoly, Výbava)
const bullets = xs => `<ul class="bullets">${xs.map(x => `<li>${esc(x)}</li>`).join("")}</ul>`;
const procList = xs => `<ol class="proc">${xs.map(x => `<li><span>${esc(x)}</span></li>`).join("")}</ol>`;
const docRx = xs => xs.map(x => `<div class="rx"><div class="when">${esc(x.when)}</div><div class="arrow">${arrow()}</div><div class="then">${esc(x.then)}</div><div class="who"><span class="ref">${esc(x.who)}</span></div></div>`).join("");
const sqDoc = q => `<div class="sq"><h3>${sym(q.symbol, "sm")}${esc(q.name)}</h3><p>${esc(q.goal)}</p>${bullets(q.points)}</div>`;

function viewDefence(k) {
  return `
    <section class="block"><h2>Jádro</h2><p>${esc(k.defence.tagline)}</p></section>
    <section class="block"><h2>Principy</h2>${procList(k.principles)}</section>
    <section class="block"><h2>Velení a komunikace</h2>${bullets(k.commander)}<table class="data"><thead><tr><th>Kanál</th><th>Kdo</th><th>K čemu</th></tr></thead><tbody>
      ${k.comms.map(c => `<tr><td><b>${esc(c.channel)}</b></td><td>${esc(c.who)}</td><td>${esc(c.purpose)}</td></tr>`).join("")}</tbody></table></section>
    <section class="block"><h2>Squady a role</h2>${D.squads.map(q => `<div class="sq"><h3>${sym(q.symbol, "sm")}<a href="#/squad/${q.id}">${esc(q.name)}</a></h3><p>${esc(q.goal)}</p></div>`).join("")}${k.squads.map(sqDoc).join("")}</section>
    <section class="block"><h2>Postupy: palba mortarů na vyžádání</h2>${procList(k.mortar_procedure)}<p class="note">${esc(k.mortar_note)}</p></section>
    <section class="block"><h2>Protokoly: když se stane, reaguj</h2>${docRx(k.protocols)}</section>
    <section class="block"><h2>Výbava</h2><p>${esc(k.defence.kit)}</p></section>`;
}

// the SWARM canvas (Petr 2026-10-18): one big squad -- sign up, see who does what, read what to buy
function viewSwarm(k) {
  const s = k.swarm;
  return `
    <section class="sestava" id="sestava">${viewRoster(plan)}</section>
    <section class="block" id="swarm-kit"><h2>Role a nákup</h2>${s.slots.map(r => `<div class="sq"><h3>${esc(r.name)} <small>${esc(r.count)}</small></h3><p>${esc(r.goal)}</p>${shopList(null, { gear: r.gear, extras_kit: r.kit })}</div>`).join("")}</section>
    <section class="block" id="swarm"><div class="t-row"><h2>Jádro</h2><span class="tag draft" title="Jádro je Commanderovo, podrobnosti navrhl štáb a potvrdí Commander">Návrh</span></div><p>${esc(s.tagline)}</p>${bullets(s.points)}</section>
    <section class="block"><h2>Principy</h2>${procList(s.principles)}</section>
    <section class="block"><h2>Velení a komunikace</h2>${bullets(s.command)}</section>
    <section class="block"><h2>Postupy</h2>${s.procedure.map(x => `<div class="sq"><h3>${esc(x.title)}</h3>${procList(x.steps)}</div>`).join("")}</section>
    <section class="block"><h2>Protokoly: když se stane, reaguj</h2>${docRx(s.protocol)}</section>
    <section class="block"><h2>Výbava podle odemčení (Season 2)</h2>${bullets(s.kit)}</section>
    <section class="block"><h2>Podle počtu lidí</h2><table class="data"><thead><tr>${s.sizes.cols.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>
      ${s.sizes.rows.map(r => `<tr>${r.map((c, i) => i ? `<td>${esc(c)}</td>` : `<td><b>${esc(c)}</b></td>`).join("")}</tr>`).join("")}</tbody></table></section>`;
}

function viewDoktrina(tab) {
  const k = D.doktrina, swarm = tab === "swarm";
  const tabs = [["", k.defence.title], ["/swarm", k.swarm.title]];
  return `
    <div class="narrow">
    <header class="unit-head"><div><h1>Doktrína</h1><p>Platí pro všechny mapy a barvy. Kterou hrajeme, rozhodne Commander před zápasem.</p></div></header>
    <nav class="tabs" aria-label="Doktrína">${tabs.map(([path, label], i) => `<a href="#/doktrina${path}"${(i === 1) === swarm ? ' aria-current="page"' : ""}>${esc(label)}</a>`).join("")}</nav>
    ${swarm ? viewSwarm(k) : viewDefence(k)}
    <section class="block"><h2>Dvě doktríny</h2><table class="data"><thead><tr><th></th><th>${esc(k.defence.title)}</th><th>${esc(k.swarm.title)}</th></tr></thead><tbody>
      ${k.compare.map(r => `<tr><td><b>${esc(r.aspect)}</b></td><td>${esc(r.defence)}</td><td>${esc(r.swarm)}</td></tr>`).join("")}</tbody></table></section>
    </div>`;
}

// ---------- squads + loadouts ----------
const SLOT_LABEL = { slot1: "[1]", slot2: "[2]", slot3: "[3]", helmet: "Helmet", armor: "Armor", vest: "Tac-Vest", backpack: "Backpack", traversal: "Traversal" };

// gear entry as it looks in the given mode, or null when absent there
function inMode(g, mode) {
  if (mode === "min") return g.item ? { name: g.item, icon: g.icon, qty: g.qty, cost: g.cost, unlock: g.unlock } : null;
  const qty = g.ideal_qty ?? g.qty;
  return qty ? { name: g.ideal || g.item, icon: g.ideal_icon, qty, cost: g.ideal_cost, unlock: g.ideal_unlock } : null;
}
// ---- "co mám odemčeno": per member and season; a wipe starts a new season with an empty list ----
const currentSeason = () => seasonOf(new Date().toISOString());
let haveSet = null;      // items I ticked in haveSeason; null = logged out / not loaded
let haveSeason = null, haveErr = null;
async function loadUnlocks() {
  const s = currentSeason(), uid = state.me && state.me.user_id;
  if (!sb || !uid || !s) { haveSet = null; return; }
  const { data, error } = await sb.from("unlocks").select("item").eq("user_id", uid).eq("season", s.id);
  if (error) throw error;
  if (!state.me || state.me.user_id !== uid) return;  // logged out while loading
  haveSet = new Set(data.map(r => r.item)); haveSeason = s.id;
}
// a re-render replaces the focused control: put keyboard focus back on its twin
function keepFocus(fn) {
  const a = document.activeElement, k = a && ["data-unlock", "data-kitmode", "data-rsvp", "data-me"].find(x => a.hasAttribute(x));
  const sel = k && `[${k}="${CSS.escape(a.getAttribute(k))}"]`, i = sel ? [...document.querySelectorAll(sel)].indexOf(a) : -1;
  fn();
  if (sel) document.querySelectorAll(sel)[i]?.focus({ preventScroll: true });
}
const rerenderKeep = () => keepFocus(() => { const y = scrollY; render(); scrollTo(0, y); });
async function setUnlock(item, has) {
  if (currentSeason().id !== haveSeason) {  // the page stayed open over a season start (wipe)
    await loadUnlocks(); haveErr = "Začala nová sezóna, seznam je prázdný. Zaškrtni znovu, co už máš."; rerenderKeep(); return;
  }
  const { error } = has
    ? await sb.from("unlocks").insert({ user_id: state.me.user_id, season: haveSeason, item })
    : await sb.from("unlocks").delete().eq("user_id", state.me.user_id).eq("season", haveSeason).eq("item", item);
  if (error && error.code !== "23505") throw error;  // 23505 = already ticked in another tab
  if (has) haveSet.add(item); else haveSet.delete(item);
  haveErr = null;
  rerenderKeep();
}
const haveBox = e => e.unlock && haveSet
  ? `<label class="have" title="Mám odemčeno (${esc(currentSeason().name)})"><input type="checkbox" data-unlock="${esc(e.name)}"${haveSet.has(e.name) ? " checked" : ""}>mám</label>` : "";

function slotCell(c, key, mode) {
  const g = c.gear.find(x => x.slot === key), e = g && inMode(g, mode);
  return `<div class="slot${e ? "" : " empty"}"><span class="sl">${SLOT_LABEL[key]}</span>${e ? `${itemIcon(e.icon)}<span class="sn">${esc(e.name)}</span>${e.unlock ? `<span class="su">${unlockText(e.unlock)}</span>` : ""}${g.std ? `<span class="su">mezistupeň ${esc(g.std)}${g.std_unlock ? ` · ${unlockText(g.std_unlock)}` : ""}</span>` : ""}${haveBox(e)}${e.cost != null ? `<span class="pr">${usd(e.cost)}</span>` : ""}` : key === "slot2" ? '<span class="ph">Sidearm</span>' : ""}</div>`;
}
function modeBar() {
  return `<div class="vbar" role="group" aria-label="Varianta výbavy">${[["min", "Minimum", "hned po wipu"], ["ideal", "Ideál", "až máš odemčeno"]].map(([id, l, s]) =>
    `<button type="button" data-kitmode="${id}" aria-pressed="${kmode === id}"><b>${l}</b><small>${s}</small></button>`).join("")}</div>`;
}
function classCard(q, c, mode, h = "h2") {
  const k = c.kit, inm = c.gear.map(g => inMode(g, mode));
  const store = c.gear.map((g, i) => g.slot === "storage" && inm[i]).filter(Boolean);
  const names = new Set(inm.filter(Boolean).map(e => e.name));
  const quick = c.quick.filter(n => names.has(n));
  const unlocks = (mode === "min" ? k.unlocks_min : k.unlocks_ideal).map(u => `<span class="ref">${unlockText(u)}</span>`).join("");
  const target = mode === "min" ? ["MINIMA", "MINIMUM"] : ["IDEÁLU", "IDEÁL"];
  const need = haveSet && [...new Set(inm.filter(e => e && e.unlock).map(e => e.name))].filter(n => !haveSet.has(n));
  const needLine = (haveErr && haveSet ? `<p class="need err">${esc(haveErr)}</p>` : "") + (!need ? "" : need.length
    ? `<p class="need">Do ${target[0]} ti chybí: ${need.map(esc).join(", ")}</p>`
    : `<p class="need ok">Na ${target[1]} máš všechno odemčené.</p>`);
  return `<article class="loadout" id="${esc(c.id)}">
    <header class="lo-head"><div><${h} class="lo-name"><a href="${classHref(q, c)}">${esc(c.name)}</a></${h}><p>${esc(c.job)}</p><p class="src">${c.screenshot ? "Ideál podle screenshotu ze hry (Season 1, 1. 10.)" : esc("Bez screenshotu - návrh z herních dat")}</p>${needLine}</div>${c.status === "NAVRH" ? '<span class="tag draft" title="Návrh, Commander ho zatím nevyhlásil">Návrh</span>' : ""}</header>
    <div class="lo-grid">
      <div><h3>Equipment</h3>${["slot1", "slot2", "slot3"].map(s => slotCell(c, s, mode)).join("")}
        <h3>Gear</h3><div class="lo-gear">${["helmet", "armor", "vest"].map(s => slotCell(c, s, mode)).join("")}</div></div>
      <div><h3>Storage</h3><div class="lo-gear">${["backpack", "traversal"].map(s => slotCell(c, s, mode)).join("")}</div>
        <h3>V batohu</h3>${store.length ? `<ul class="lo-store">${store.map(e => `<li>${itemIcon(e.icon, "sm")}<span class="q">${e.qty}${e.cost != null ? `<span class="pr">${usd(e.cost)}</span>` : ""}</span><span class="n">${esc(e.name)}${haveBox(e)}</span></li>`).join("")}</ul>` : '<p class="note">Nic.</p>'}
        ${quick.length ? `<h3>Rychlé sloty</h3><ol class="lo-quick">${quick.map((n, i) => `<li><span class="kb">${(i + 4) % 10}</span>${esc(n)}</li>`).join("")}</ol>` : ""}</div>
    </div>
    <footer class="lo-sum"><span>Za život</span><b>${usd(mode === "min" ? k.min : k.ideal)}</b><span>váha bez munice a supplies</span><b>${(mode === "min" ? k.weight_min : k.weight_ideal).toLocaleString("cs-CZ")} kg</b>${unlocks ? `<span>odemkni</span>${unlocks}` : ""}</footer></article>`;
}
function viewSquads() {
  return `<header class="unit-head"><div><h1>Squady</h1><p>Sestavy platí pro všechny mapy</p></div></header>
    <p class="note">Přihlášený člen si u předmětů zaškrtne, co má odemčené. Kolik nás co má: <a class="act" href="#/pokryti">Pokrytí rolí</a></p>
    ${D.squads.map(q => `<section class="block"><h2><a href="#/squad/${q.id}">${esc(q.name)}</a></h2><p class="goal">${esc(q.goal)}</p>
      <ul class="cls">${q.classes.map(c => `<li><a href="${classHref(q, c)}"><b>${esc(c.name)}</b><span>${usd(c.kit.min)} · ideál ${usd(c.kit.ideal)}</span></a></li>`).join("")}</ul></section>`).join("")}`;
}
function viewSquadPage(q) {
  return `<p class="crumb"><a href="#/squady">Squady</a> / ${esc(q.name)}</p>
    <header class="unit-head">${sym(q.symbol, "lg")}<div><h1>${esc(q.name)}</h1><p>${q.classes.length} sub-class · platí pro všechny mapy</p></div></header>
    <p class="goal">${esc(q.goal)}</p><ul class="bullets block" style="margin-top:16px">${q.points.map(x => `<li>${esc(x)}</li>`).join("")}</ul>
    ${modeBar()}${q.classes.map(c => classCard(q, c, kmode)).join("")}`;
}
function viewClass(q, c) {
  const uses = D.strategies.map(s => [s, s.roles.filter(r => r.class === c.id)]).filter(([, rs]) => rs.length);
  return `<p class="crumb"><a href="#/squady">Squady</a> / <a href="#/squad/${q.id}">${esc(q.name)}</a> / ${esc(c.name)}</p>
    ${modeBar()}${classCard(q, c, kmode, "h1")}
    ${uses.length ? `<section class="block"><h2>Role v plánech</h2><ul class="uses">${uses.map(([s, rs]) => `<li>${esc(sideLabel(s))}: ${rs.map(r => roleLink(s, r)).join(" ")}</li>`).join("")}</ul></section>` : ""}`;
}

// ---------- canvas trace ----------
function applyTrace() {
  const m = document.getElementById("matrix"), bar = document.getElementById("tracebar");
  if (!m || !bar) return;
  m.classList.toggle("tracing", !!trace);
  m.querySelectorAll(".entry").forEach(e => e.classList.toggle("hit", !!trace && e.dataset.roles.split(" ").includes(trace)));
  m.querySelectorAll("button.rid").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.trace === trace)));
  const r = trace && roleOf(cur, trace);
  bar.innerHTML = r
    ? `<span>Sleduješ <b>${esc(r.id)}</b> · ${esc(r.name)}</span><a class="act" href="${roleHref(cur, r)}">Otevřít kartu</a><button type="button" class="act" data-untrace>Zrušit</button>`
    : "Klikni na kód role (třeba A1) a zvýrazní se její cesta všemi fázemi.";
}

// ---------- vycvik (karty kresli ../vycvik/build.py do docs/vycvik/) ----------
const wv = (png, w) => png.replace(/\.png$/, `-${w}.webp`);  // smaller copies for the page; the PNG is for Discord
function viewVycvik() {
  return `<header class="unit-head"><div><h1>Výcvik</h1><p>Pěchotní taktika pro všechny mapy</p></div></header>
    ${D.vycvik.map(l => `<section class="block"><h2>${esc(l.name)}</h2><p class="lede">${esc(l.intro)}</p>
      <ol class="drill">${l.cards.map(c => `<li><a class="pic" href="${esc(c.file)}" target="_blank" rel="noopener"><img src="${esc(wv(c.file, 1600))}" srcset="${esc(wv(c.file, 800))} 800w, ${esc(wv(c.file, 1600))} 1600w, ${esc(wv(c.file, 2400))} 2400w" sizes="(min-width: 1360px) 1280px, 100vw" width="2400" height="1500" loading="lazy" alt="${esc(c.title)}: ${esc(c.sub)}"></a>
        <div class="cap"><b>${esc(c.title)}</b><span>${esc(c.sub)}</span><a class="dl" href="${esc(c.file)}" download>PNG pro Discord</a></div></li>`).join("")}</ol></section>`).join("")}`;
}

// ---------- historie (uzavřené akce, hráči; jen pro přihlášené členy, data chrání RLS) ----------
const HIST = ["historie", "akce", "hrac", "pokryti"];
const plural = (n, one, few, many) => `${n} ${n === 1 ? one : n >= 2 && n <= 4 ? few : many}`;
// local calendar date (like fmtWhen), so a 00:30 event on the start day lands in the new season
const seasonOf = iso => { const d = new Date(iso).toLocaleDateString("sv-SE"); let s = null; for (const x of D.seasons) if (x.start <= d) s = x; return s; };
const seasonName = s => s ? s.name : "Před sezónami";
const place = n => n ? `${n}.` : "-";
const sideOf = id => { const s = S(id); return s ? sideLabel(s) : id; };
const variantName = (sid, vid) => { const s = S(sid), v = s && vById(s, vid); return v ? v.name : (vid || "-"); };
const memberLink = m => `<a class="mlink" href="#/hrac/${encodeURIComponent(m.discord_id)}"><img src="${esc(m.avatar_url)}" alt="" loading="lazy">${esc(m.name)}</a>`;

// newest season first, each with its rows in the order given
function bySeason(rows, iso) {
  const out = [];
  for (const r of rows) {
    const s = seasonOf(iso(r)), last = out[out.length - 1];
    if (last && last.s === s) last.rows.push(r); else out.push({ s, rows: [r] });
  }
  return out;
}

function histShell(inner) { return `<div id="hist">${inner}</div>`; }
function histGate() {
  if (!sb) return '<p class="note">Stránka se teď nenačetla (knihovna přihlášení není dostupná).</p>';
  return `<p class="note">Tahle stránka je jen pro členy KIN. <button type="button" class="act" data-login>Přihlásit přes Discord</button></p>`;
}

async function loadHist(p) {
  const want = location.hash, el = () => location.hash === want && document.getElementById("hist");
  try {
    let html;
    if (p[0] === "pokryti") {
      const s = currentSeason();
      // one row per active member with their items nested: removed members drop out and the
      // 1000-row response cap applies to members, not to the ~50 x members unlock rows
      const { data, error } = s ? await sb.from("members").select("user_id, name, avatar_url, discord_id, unlocks!inner(item)")
        .eq("active", true).eq("unlocks.season", s.id) : { data: [] };
      if (error) throw error;
      html = viewCoverage(s, data);
    } else if (p[0] === "historie") {
      const { data, error } = await sb.from("events").select("id, strategy_id, doctrine, starts_at, variant, placement, claims(count)")
        .eq("status", "closed").order("starts_at", { ascending: false });
      if (error) throw error;
      html = viewHistory(data);
    } else if (p[0] === "akce") {
      const id = Number(p[1]);  // #/akce/abc: not an id, so "Akce neexistuje" instead of a database error (Viktor UAT #011)
      const { data: ev, error } = Number.isSafeInteger(id) && id > 0
        ? await sb.from("events").select("id, strategy_id, doctrine, starts_at, status, variant, placement, note, went_well, went_wrong, next_time").eq("id", id).neq("status", "cancelled").maybeSingle()
        : { data: null, error: null };
      if (error) throw error;
      const [cl, at] = ev ? await Promise.all([
        sb.from("claims").select("slot_label, user_id, members(name, avatar_url, discord_id)").eq("event_id", ev.id),
        sb.from("attendance").select("user_id, attended").eq("event_id", ev.id),  // RLS: Commander all, member own row
      ]) : [{ data: [] }, { data: [] }];
      if (cl.error) throw cl.error;
      if (at.error) throw at.error;
      html = ev ? viewEvent(ev, cl.data, new Set(at.data.filter(a => !a.attended).map(a => a.user_id))) : '<p class="note">Akce neexistuje.</p>';
    } else {
      const { data: m, error } = await sb.from("members").select("user_id, discord_id, name, avatar_url, active").eq("discord_id", p[1]).maybeSingle();
      if (error) throw error;
      const season = currentSeason();
      const [cl, at, un] = m ? await Promise.all([
        sb.from("claims").select("slot_label, events!inner(id, strategy_id, starts_at, status)").eq("user_id", m.user_id).eq("events.status", "closed"),
        sb.from("attendance").select("event_id, attended").eq("user_id", m.user_id),  // visible to the Commander and the player only
        season ? sb.from("unlocks").select("item").eq("user_id", m.user_id).eq("season", season.id) : { data: [] },
      ]) : [{ data: [] }, { data: [] }, { data: [] }];
      if (cl.error) throw cl.error;
      if (at.error) throw at.error;
      if (un.error) throw un.error;
      // no attendance record = played (older events, or the viewer may not see it)
      const absent = new Set(at.data.filter(a => !a.attended).map(a => a.event_id));
      html = m ? viewPlayer(m, cl.data.filter(r => !absent.has(r.events.id)), season, new Set(un.data.map(u => u.item))) : '<p class="note">Hráč nenalezen.</p>';
    }
    const t = el(); if (t) t.innerHTML = html;
  } catch (e) {
    console.error(e);  // a raw database error means nothing to a player (OWASP A10, like the login gate)
    const t = el(); if (t) t.innerHTML = '<p class="err">Nepodařilo se načíst. Zkus stránku načíst znovu.</p>';
  }
}

// items a sub-class needs unlocked to be played in the given mode (MINIMUM / IDEAL)
const unlockNeeds = (c, mode) => [...new Set(c.gear.map(g => inMode(g, mode)).filter(e => e && e.unlock).map(e => e.name))];

// coverage: who has which unlock this season, and how many can play each sub-class at MINIMUM / IDEAL
function viewCoverage(season, members) {
  const head = `<p class="crumb"><a href="#/squady">Squady</a> / Pokrytí</p>
    <header class="unit-head"><div><h1>Pokrytí rolí</h1><p>${esc(season ? season.name : "Žádná sezóna")} · podle toho, co si členové zaškrtli u sestav</p></div></header>`;
  // item names come from members' rows: a null-prototype map, so "constructor" or "__proto__" cannot break it
  const byItem = Object.create(null), users = [];
  for (const m of members) {
    const have = new Set(m.unlocks.map(u => u.item));
    users.push(have);
    for (const n of have) (byItem[n] = byItem[n] || []).push(m);
  }
  const ready = list => users.filter(have => list.every(n => have.has(n))).length;
  const items = [];
  for (const q of D.squads) for (const c of q.classes) for (const mode of ["min", "ideal"]) for (const n of unlockNeeds(c, mode)) if (!items.includes(n)) items.push(n);
  // vehicles and other extras the plans add to roles (MH-6, Lakota, Ural, Verba) need unlocks too
  for (const s of D.strategies) for (const r of s.roles) for (const g of r.gear) {
    if (g.item && g.unlock && !items.includes(g.item)) items.push(g.item);
    if (g.ideal && g.ideal_unlock && !items.includes(g.ideal)) items.push(g.ideal);
  }
  return `${head}
    <p class="note">Členů, kteří něco zaškrtli: <b>${users.length}</b>. Kdo nic nezaškrtl, v počtech chybí.</p>
    <section class="block"><h2>Sub-classy</h2><table class="data cov"><thead><tr><th>Sub-class</th><th class="num">Mají MINIMUM</th><th class="num">Mají IDEÁL</th></tr></thead><tbody>
    ${D.squads.map(q => q.classes.map(c => `<tr><td><a href="${classHref(q, c)}">${esc(q.name)} · ${esc(c.name)}</a></td><td class="num"><b>${ready(unlockNeeds(c, "min"))}</b></td><td class="num">${ready(unlockNeeds(c, "ideal"))}</td></tr>`).join("")).join("")}
    </tbody></table></section>
    <section class="block"><h2>Kdo má odemčeno</h2><p class="note">Předměty, které se musí ve hře odemknout, a kdo z nás je už má (podle zaškrtnutí „mám“).</p><table class="data cov"><thead><tr><th>Předmět</th><th class="num">Mají</th><th>Kdo</th></tr></thead><tbody>
    ${items.map(n => { const ms = byItem[n] || []; return `<tr><td>${esc(n)}</td><td class="num"><b>${ms.length}</b></td><td>${ms.map(memberLink).join(" ")}</td></tr>`; }).join("")}
    </tbody></table></section>`;
}

function viewHistory(evs) {
  const head = `<header class="unit-head"><div><h1>Historie</h1><p>Uzavřené akce po sezónách</p></div></header>`;
  if (!evs.length) return `${head}<p class="note">Zatím žádná uzavřená akce. Commander ji uzavře v bloku Sestava po zápase.</p>`;
  return head + bySeason(evs, e => e.starts_at).map(({ s, rows }) => `<section class="block"><h2>${esc(seasonName(s))}</h2>
    <table class="data hist"><thead><tr><th>Datum</th><th>Mapa</th><th>Zóna</th><th class="num">Umístění</th><th class="num">Zapsáno</th></tr></thead><tbody>
    ${rows.map(e => `<tr><td><a href="#/akce/${e.id}">${esc(fmtWhen(e.starts_at))}</a></td><td>${esc(sideOf(e.strategy_id))}${e.doctrine === "swarm" ? " · Top attack" : ""}</td><td>${esc(variantName(e.strategy_id, e.variant))}</td><td class="num"><b>${place(e.placement)}</b></td><td class="num">${e.claims[0] ? e.claims[0].count : 0}</td></tr>`).join("")}
    </tbody></table></section>`).join("");
}

function viewEvent(ev, claims, absent = new Set()) {
  // slot_label was stored at sign-up ("Skupina · Role"), so renamed roles keep their old name here
  const groups = {};
  for (const c of claims) { const [g, ...rest] = c.slot_label.split(" · "); (groups[g] = groups[g] || []).push({ role: rest.join(" · ") || g, m: c.members, away: absent.has(c.user_id) }); }
  const played = claims.length - claims.filter(c => absent.has(c.user_id)).length;
  const debrief = [["Co fungovalo", ev.went_well], ["Co ne", ev.went_wrong], ["Co příště jinak", ev.next_time]].filter(([, t]) => t);
  return `<p class="crumb"><a href="#/historie">Historie</a> / ${esc(fmtWhen(ev.starts_at))}</p>
    <header class="unit-head"><div><h1>${esc(sideOf(ev.strategy_id))}${ev.doctrine === "swarm" ? " · Top attack" : ""}</h1><p>${esc(fmtWhen(ev.starts_at))} · ${esc(seasonName(seasonOf(ev.starts_at)))}${ev.status === "open" ? " · probíhá" : ""}</p></div></header>
    <p class="lede">Umístění <b>${place(ev.placement)}</b> · zóna ${esc(variantName(ev.strategy_id, ev.variant))} · ${played === claims.length ? plural(played, "člověk", "lidé", "lidí") : `hrálo ${played} z ${claims.length} zapsaných`}</p>
    ${debrief.length ? `<section class="block"><h2>Debrief</h2><dl class="debrief">${debrief.map(([h, t]) => `<dt>${h}</dt><dd class="evnote">${esc(t)}</dd>`).join("")}</dl></section>` : ""}
    ${ev.note ? `<section class="block"><h2>Poznámka Commandera</h2><p class="evnote">${esc(ev.note)}</p></section>` : ""}
    <section class="block"><h2>Sestava</h2>${claims.length ? `<div class="ros">${Object.entries(groups).map(([g, xs]) => `<div class="rg"><div class="pg-head"><div><b>${esc(g)}</b></div><span class="num">${xs.length}</span></div>
      <ul>${xs.map(x => `<li class="hrow${x.away ? " absent" : ""}"><span class="lbl">${esc(x.role)}</span>${memberLink(x.m)}${x.away ? '<span class="ref">neúčast</span>' : ""}</li>`).join("")}</ul></div>`).join("")}</div>` : '<p class="note">Nikdo se nezapsal.</p>'}</section>`;
}

// profile: which sub-classes the player can field this season (from what they ticked on loadout cards)
function unlockSection(m, season, have) {
  if (!season || !m.active) return "";
  const own = state.me && state.me.user_id === m.user_id;
  if (!have.size) return `<section class="block"><h2>Odemčeno · ${esc(season.name)}</h2><p class="note">Zatím nic nezaškrtnuto.${own ? ' Zaškrtni, co máš odemčené, na stránkách <a href="#/squady">Squadů</a>.' : ""}</p></section>`;
  const rows = D.squads.flatMap(q => q.classes.map(c => ({ q, c, min: unlockNeeds(c, "min").every(n => have.has(n)), ideal: unlockNeeds(c, "ideal").every(n => have.has(n)) })));
  // MINIMUM and IDEAL kits share no unlock items: either one means the player can field the sub-class
  const ready = rows.filter(x => x.min || x.ideal);
  return `<section class="block"><h2>Odemčeno · ${esc(season.name)}</h2>
    <p class="lede">Může hrát <b>${ready.length}</b> z ${rows.length} sub-class · MINIMUM ${rows.filter(x => x.min).length} · IDEÁL ${rows.filter(x => x.ideal).length}</p>
    ${ready.length ? `<ul class="cls">${ready.map(x => `<li><a href="${classHref(x.q, x.c)}"><b>${esc(x.c.name)}</b><span>${esc(x.q.name)} · ${x.ideal ? "IDEÁL" : "MINIMUM"}</span></a></li>`).join("")}</ul>` : ""}</section>`;
}

function viewPlayer(m, rows, season, have) {
  const stats = list => {
    const roles = {};
    for (const r of list) { const role = r.slot_label; roles[role] = (roles[role] || 0) + 1; }
    const top = Object.entries(roles).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const last = list.reduce((a, r) => !a || r.events.starts_at > a ? r.events.starts_at : a, null);
    return `<p class="lede"><b>${plural(list.length, "akce", "akce", "akcí")}</b>${last ? ` · naposledy ${esc(fmtWhen(last))}` : ""}</p>
      ${top.length ? `<ul class="bullets">${top.map(([role, n]) => `<li>${esc(role)} <span class="ref">${n}×</span></li>`).join("")}</ul>` : ""}`;
  };
  const sorted = [...rows].sort((a, b) => b.events.starts_at.localeCompare(a.events.starts_at));
  return `<p class="crumb"><a href="#/historie">Historie</a> / ${esc(m.name)}</p>
    <header class="unit-head"><img class="pavatar" src="${esc(m.avatar_url)}" alt=""><div><h1>${esc(m.name)}</h1><p>Člen KIN</p></div></header>
    <section class="block"><h2>Celkem</h2>${stats(rows)}</section>
    ${unlockSection(m, season, have)}
    ${bySeason(sorted, r => r.events.starts_at).map(({ s, rows: xs }) => `<section class="block"><h2>${esc(seasonName(s))}</h2>${stats(xs)}
      <p class="note">${xs.map(r => `<a href="#/akce/${r.events.id}">${esc(fmtWhen(r.events.starts_at))}</a>`).join(" · ")}</p></section>`).join("")}`;
}

// ---------- shell ----------
function renderNav(active) {
  const mine = me.get(), [msid, mrid] = (mine || "/").split("/"), ms = S(msid), mr = ms && roleOf(ms, mrid);
  // "Moje role" first and current on my own card: a phone shows ~136 px of the sideways nav (Viktor UAT #005)
  const onMine = mr && location.hash === roleHref(ms, mr);
  document.getElementById("nav").innerHTML =
    (mr ? `<a class="mine" href="${roleHref(ms, mr)}"${onMine ? ' aria-current="page"' : ""}>Moje role<b>${esc(mr.id)}</b></a>` : "") +
    [...new Set(D.strategies.map(s => s.map))].map(m => `<a href="#/s/${D.strategies.find(s => s.map === m).id}"${!onMine && S(active)?.map === m ? ' aria-current="page"' : ""}>${esc(m)}</a>`).join("") +
    `<a href="#/squady"${active === "squady" ? ' aria-current="page"' : ""}>Squady</a>` +
    `<a href="#/doktrina"${active === "doktrina" ? ' aria-current="page"' : ""}>Doktrína</a>` +
    `<a href="#/vycvik"${active === "vycvik" ? ' aria-current="page"' : ""}>Výcvik</a>` +
    `<a href="#/historie"${active === "historie" ? ' aria-current="page"' : ""}>Historie</a>`;
  navToCurrent();
}
// phones scroll the nav sideways: keep the current page's link in view (again after #who changes width)
// "Moje role" is first: keep it in view and scroll only when the current link is fully hidden (Viktor #024)
const navToCurrent = () => {
  const n = document.getElementById("nav"), a = n.querySelector("[aria-current]");
  if (n.querySelector("a.mine")) n.scrollLeft = 0;
  if (a && a.getBoundingClientRect().left >= n.getBoundingClientRect().right) a.scrollIntoView({ block: "nearest", inline: "nearest" });
};

function viewGate() {
  const wait = !sb ? "Přihlášení se nenačetlo. Vypni blokování skriptů pro tuhle stránku a načti ji znovu."
    : state.checking ? "Ověřuji přihlášení…" : null;
  return `<section class="gate">
    <img src="znacka/kin-emblem.svg" alt="Emblém Kinetic Solutions" width="200" height="200">
    <h1>Central Command</h1>
    <p class="lede">Plány, role a výcvik klanu Kinetic Solutions. Jen pro členy: přihlas se přes Discord, dovnitř tě to pustí od role Rekrut.</p>
    ${state.error ? `<p class="err">${esc(state.error)}</p>` : ""}
    ${wait ? `<p class="note">${esc(wait)}</p>` : '<button type="button" class="act big" data-login>Přihlásit přes Discord</button>'}
  </section>`;
}

function render() {
  if (!D.strategies) {
    $app.innerHTML = viewGate();
    document.title = "KIN Central Command";
    document.getElementById("nav").innerHTML = "";
    return;
  }
  const [h, qs = ""] = location.hash.replace(/^#/, "").split("?");
  if (!h) {
    const [sid, rid] = (me.get() || "/").split("/"), s = S(sid);
    if (s && roleOf(s, rid)) { location.replace(`#/s/${sid}/role/${rid}`); return; }
  }
  const p = h.split("/").filter(Boolean);
  let html, active = null, title = "KIN Central Command";
  cur = null; trace = null; plan = p[0] === "doktrina" && p[1] === "swarm" ? swarmPlan() : null;
  if (p[0] === "s" && S(p[1])) {
    const s = S(p[1]); cur = plan = s; active = s.id; curVariant = pickVariant(s, qs);
    const r = p[2] === "role" && roleOf(s, p[3]), g = p[2] === "squad" && groupOf(s, p[3]);
    if (r) { html = viewRole(s, r); title = `${r.id} ${r.name} · KIN`; }
    else if (g) { html = viewSquad(s, g); title = `${g.name} · KIN`; }
    else { html = viewStrategy(s, ["situace", "vetve"].includes(p[2]) ? p[2] : "platno"); title = `${sideLabel(s)} · KIN`; }
  } else if (p[0] === "squady") { html = viewSquads(); active = "squady"; title = "Squady · KIN"; }
  else if (p[0] === "squad" && SQ(p[1])) {
    const q = SQ(p[1]), c = classOf(q, p[2]); active = "squady";
    if (c) { html = viewClass(q, c); title = `${c.name} · KIN`; } else { html = viewSquadPage(q); title = `${q.name} · KIN`; }
  } else if (p[0] === "doktrina") { html = viewDoktrina(p[1]); active = "doktrina"; title = (p[1] === "swarm" ? "SWARM" : "Doktrína") + " · KIN"; }
  else if (p[0] === "vycvik") { html = viewVycvik(); active = "vycvik"; title = "Výcvik · KIN"; }
  else if (HIST.includes(p[0])) {
    active = p[0] === "pokryti" ? "squady" : "historie"; title = p[0] === "pokryti" ? "Pokrytí · KIN" : "Historie · KIN";
    html = histShell(sb && state.me ? '<p class="note">Načítám…</p>' : histGate());
    if (sb && state.me) setTimeout(() => loadHist(p));
  }
  else html = viewHome();
  $app.innerHTML = html;
  document.title = title;
  renderNav(active);
  renderEvBar();
  applyTrace();
  window.scrollTo(0, 0);
}

$app.addEventListener("click", e => {
  const t = e.target.closest("[data-trace],[data-untrace],[data-pick],[data-me],[data-variant],[data-kitmode],[data-claim],[data-unclaim],[data-rsvp],[data-unlock],[data-cancel]");
  if (!t) return;
  if (t.dataset.rsvp) { setRsvp(t.dataset.rsvp); return; }
  if (t.dataset.cancel !== undefined) { cancelEvent(t); return; }
  if (t.dataset.unlock !== undefined) {
    t.disabled = true;  // no second toggle while saving; render() builds a fresh box from haveSet
    const item = t.dataset.unlock;  // disabled box loses focus before keepFocus sees it: put it back (Viktor #027)
    setUnlock(item, t.checked).catch(err => { haveErr = saveErr(err); rerenderKeep(); })
      .finally(() => document.querySelector(`[data-unlock="${CSS.escape(item)}"]`)?.focus({ preventScroll: true }));
    return;
  }
  if (t.dataset.claim || t.dataset.unclaim) {
    // the roster re-renders: put focus back on my slot, else on the same row, not on <body> (Viktor UAT #006)
    const i = [...document.querySelectorAll(".ros li")].indexOf(t.closest("li"));
    (t.dataset.claim ? claim(t.dataset.claim) : unclaim(t.dataset.unclaim)).then(() =>
      (document.querySelector(".ros li.is-me .rslot") || document.querySelectorAll(".ros li .rslot")[i])?.focus({ preventScroll: true }));
    return;
  }
  if (t.dataset.variant) {
    try { localStorage.setItem("wrd.variant." + cur.map, t.dataset.variant); } catch { /* storage blocked: URL still carries it */ }
    // replace, not push: Back leaves the page instead of stepping through zones (Viktor #023)
    const y = window.scrollY;
    history.replaceState(history.state, "", location.hash.split("?")[0] + "?v=" + t.dataset.variant);
    render(); window.scrollTo(0, y);
    document.querySelector(`[data-variant="${CSS.escape(t.dataset.variant)}"]`)?.focus({ preventScroll: true });
  }
  else if (t.dataset.trace) { trace = trace === t.dataset.trace ? null : t.dataset.trace; applyTrace(); }
  else if ("untrace" in t.dataset) { trace = null; applyTrace(); }
  else if (t.dataset.pick) { me.set(t.dataset.pick); const [sid, rid] = t.dataset.pick.split("/"); location.hash = `#/s/${sid}/role/${rid}`; }
  else if (t.dataset.me) { me.set(me.get() === t.dataset.me ? null : t.dataset.me); rerenderKeep(); }
  else if (t.dataset.kitmode) {
    kmode = t.dataset.kitmode;
    try { localStorage.setItem("wrd.kitmode", kmode); } catch { /* storage blocked: mode lasts until reload */ }
    rerenderKeep();
  }
});
// Back/Forward return to where the reader was: the scroll position lives in the history entry (Viktor #023)
let saveY;
addEventListener("scroll", () => { clearTimeout(saveY); saveY = setTimeout(() => history.replaceState({ y: scrollY }, ""), 150); }, { passive: true });
addEventListener("hashchange", () => {
  haveErr = null;  // an unlock error belongs to the page it happened on (Viktor #026)
  render();
  const y = history.state && history.state.y;
  if (y) window.scrollTo(0, y);
});
function renderFoot() {
  document.getElementById("foot").textContent = D.snapshot
    ? `Ceny a unlocky: ${D.snapshot} · build ${D.built}${D.contentAt ? ` · obsah z databáze ${fmtWhen(D.contentAt)}` : ""} · Strategie označená Draft zatím není vyhlášená za platnou. · Ikony předmětů: WARDOGS © Bulkhead, přes metaforge.app`
    : "Kinetic Solutions · CZ/SK klan ve WARDOGS";
}
renderFoot();
render();
