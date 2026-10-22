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
let state = { me: null, error: urlQs.has("error") ? "Přihlášení přes Discord selhalo." : null, event: null, claims: [], rsvps: [], trainings: [], flash: null, checking: !!sb && (hadSession || FRESH) };
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
  const { data, error } = await sb.from("members").select("user_id, discord_id, name, avatar_url, is_commander, is_officer")
    .eq("user_id", session.user.id).maybeSingle();
  if (error) throw error;
  if (!data) { state.error = "Nejsi ověřený člen KIN. Přihlas se znovu."; await sb.auth.signOut(); return; }
  state.me = data; state.error = null;
  // unlocks need the seasons from the content, so they load after it (both at once = haveSet never set, Viktor UAT)
  if (!was) loadContent()
    .then(() => Promise.all([loadUnlocks().catch(e => { console.error(e); haveSet = null; }), loadTracker().catch(e => console.error(e))]))
    // history pages and loadout cards wait for the login to know what to load / which boxes to tick
    .then(() => { if (onHistRoute() || onCardRoute()) { const y = scrollY; render(); scrollTo(0, y); } autoSyncTracker(); },
      () => { state.error = "Obsah se nenačetl. Zkus stránku načíst znovu."; state.checking = false; renderWho(); render(); });
  renderWho(); loadEvent(); subscribe();
}
const onCardRoute = () => /^#\/(squad\/|s\/[^/]+\/role\/|doktrina\/swarm|vybava)/.test(location.hash);  // canvas: "mám" boxes (Viktor #004), Výbava: Tracker button
const onHistRoute = () => HIST.includes(location.hash.replace(/^#\/?/, "").split(/[/?]/)[0]);

function renderWho() {
  document.getElementById("who").innerHTML = !sb ? '<span class="err">Přihlášení se nenačetlo</span>' : state.me
    ? `<a class="mlink" href="#/hrac/${encodeURIComponent(state.me.discord_id)}" title="Můj profil"><img src="${esc(state.me.avatar_url)}" alt=""><span class="nm">${esc(state.me.name)}</span></a><button type="button" class="act" data-logout>Odhlásit</button>`
    : `${state.error && D.strategies ? `<span class="err">${esc(state.error)}</span>` : ""}<button type="button" class="act" data-login>Přihlásit<span class="long"> přes Discord</span></button>`;
  navToCurrent();
}

// specs/zamek: the hub content lives in public.content, readable only by verified members
async function loadContent() {
  const { data, error } = await sb.from("content").select("data").eq("id", "hub").single();
  if (error) throw error;
  Object.assign(D, data.data);
  state.checking = false;
  const y = scrollY; render(); scrollTo(0, y);
}

// the year only when it is not this year (an old or mistyped event must not read as current, Viktor UAT #013)
const fmtWhen = iso => { const d = new Date(iso), y = d.getFullYear() !== new Date().getFullYear();
  return d.toLocaleString("cs-CZ", { weekday: "short", day: "numeric", month: "numeric", ...(y && { year: "numeric" }), hour: "2-digit", minute: "2-digit" }); };
let chan = null;

let loadSeq = 0;
const LOAD_ERR = "Sestavu se nepodařilo načíst, zkus to znovu.";
async function loadEvent() {
  if (!state.me) { state.event = null; state.claims = []; state.rsvps = []; state.trainings = []; renderRoster(); return; }
  const seq = ++loadSeq;
  try {
    // specs/typy-akci T1: the roster, closing and history work with the open operation only; trainings and courses open
    // beside it are a list of their own and never state.event
    const [op, tr] = await Promise.all([
      sb.from("events").select("id, strategy_id, doctrine, variant, squad_swarm, squad_support, starts_at, leader:members!events_created_by_fkey(name)").eq("status", "open").eq("kind", "operace").maybeSingle(),
      sb.from("events").select("id, kind, topic, title, description, capacity, starts_at, created_by, leader:members!events_created_by_fkey(name), rsvps(user_id, status, members(name, avatar_url, discord_id))")
        .eq("status", "open").neq("kind", "operace").order("starts_at"),
    ]);
    if (op.error) throw op.error;
    if (tr.error) throw tr.error;
    const ev = op.data;
    let claims = [], rsvps = [];
    if (ev) {
      const [cl, rs] = await Promise.all([
        sb.from("claims").select("slot_key, slot_label, user_id, lead, members(name, avatar_url, discord_id)").eq("event_id", ev.id),
        sb.from("rsvps").select("user_id, status, members(name, avatar_url, discord_id)").eq("event_id", ev.id),
      ]);
      if (cl.error) throw cl.error;
      if (rs.error) throw rs.error;
      claims = cl.data; rsvps = rs.data;
    }
    // swap the whole state at once, and only for the newest load (a slower old response must not win)
    if (seq !== loadSeq) return;
    state.event = ev; state.claims = claims; state.rsvps = rsvps; state.trainings = tr.data; state.evErr = false;
    if (state.flash === LOAD_ERR) state.flash = null;  // connection is back: drop only our own outage message
  } catch (e) {
    // keep the last known roster: an empty "no event open" would lie and offer a second event (Viktor UAT #003)
    if (seq !== loadSeq) return;
    console.error(e);
    state.evErr = true; state.flash = LOAD_ERR;
  }
  syncMyRole();  // outside try: a bug here must not show up as a connection outage (OWASP 2026-10-20 L2)
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

// sq = the SWARM squad of the row ({ led }), else undefined: only squads have the SL badge (specs/swarm-squady)
function slotRow(x, c, sq) {
  const mine = c && c.user_id === state.me.user_id;
  const who = c ? `<img src="${esc(c.members.avatar_url)}" alt="" loading="lazy"><span class="nm">${esc(c.members.name)}</span>${sq && c.lead ? '<span class="slb" title="Squad leader">SL</span>' : ""}` : '<span class="free">volné</span>';
  const act = mine ? `data-unclaim="${esc(c.user_id)}" title="Odhlásit se"` : c ? "disabled" : `data-claim="${esc(x.key)}"`;
  const kick = c && !mine && state.me.is_commander
    ? `<button type="button" class="kick" data-unclaim="${esc(c.user_id)}" aria-label="Odhlásit ${esc(c.members.name)}">${cross()}</button>` : "";
  // the badge is taken and handed over on one's own row only, one per squad (decision 4: not even the Commander assigns it)
  const lead = !sq || !mine ? "" : c.lead ? '<button type="button" class="act lead" data-lead="0">Předat SL</button>'
    : sq.led ? "" : '<button type="button" class="act lead" data-lead="1">Povedu squad</button>';
  return `<li data-key="${esc(x.key)}"${mine ? ' class="is-me"' : ""}><button type="button" class="rslot" ${act}><span class="lbl">${x.role ? `<span class="rid">${esc(x.role)}</span>` : ""}${esc(x.label)}</span>${who}</button>${lead}${kick}</li>`;
}

function rosterGroup(g, by) {
  const n = g.slots.filter(x => by[x.key]).length;
  return `<div class="rg"><div class="pg-head">${sym(g.symbol, "sm")}<div><b>${esc(g.name)}</b><small>${esc(g.squad)}</small></div><span class="num">${n}/${g.max}</span></div>
    <ul>${g.slots.map(x => slotRow(x, by[x.key])).join("")}</ul></div>`;
}

// the squad part of a slot key (SW-Q2-SW3 -> Q2), as the unique index claims_one_lead counts it (011): a badge on a
// place the page does not show (dropped by "-", forged key) still leads its squad (OWASP 2026-10-21 L1)
const squadOf = k => k.split("-")[1];
const leadOf = g => state.claims.find(c => c.lead && squadOf(c.slot_key) === g.id);

// SWARM squad (specs/swarm-squady): a fixed core + a Swarm body the Commander grows and shrinks; SL is a badge on one
// of the people, named in the head
function squadCard(g, by) {
  const sw = D.doktrina.swarm.sestava.swarm, core = g.slots.slice(0, -g.swarmN), body = g.slots.slice(-g.swarmN);
  const n = g.slots.filter(x => by[x.key]).length, lead = leadOf(g);
  // "-" drops the last Swarm place, so only while it is free
  const less = g.swarmN <= sw.min ? `aspoň ${sw.min} ${sw.label}` : by[body[body.length - 1].key] ? `poslední ${sw.label} je obsazený` : "";
  const more = g.swarmN >= sw.max ? `nejvýš ${sw.max} ${sw.label}` : "";
  const why = [less, more].filter(Boolean).join(", ");
  const ctl = state.me.is_commander ? `<span class="swctl">
      <button type="button" class="act" data-swarm="${g.idx}:-1" aria-label="${esc(g.name)}: ubrat ${esc(sw.label)}"${less ? ` disabled aria-describedby="why-${g.id}"` : ""}>\u2212 ${esc(sw.label)}</button>
      <button type="button" class="act" data-swarm="${g.idx}:1" aria-label="${esc(g.name)}: přidat ${esc(sw.label)}"${more ? ` disabled aria-describedby="why-${g.id}"` : ""}>+ ${esc(sw.label)}</button></span>` : "";
  const veli = lead ? `Velí: <span class="who">${esc(lead.members.name)}</span>` : "Velí: nikdo, kdokoli ze squadu si vezme SL";
  const sq = { led: !!lead };
  return `<div class="rg sqc"><div class="pg-head">${sym(g.symbol, "sm")}<div><b>${esc(g.name)}</b><small class="veli${!lead && n ? " none" : ""}">${veli}</small></div><span class="num">${n}/${g.max}</span></div>
    <p class="sqp">Jádro</p><ul class="core">${core.map(x => slotRow(x, by[x.key], sq)).join("")}</ul>
    <div class="sqp">${esc(sw.label)} <b>${esc(g.swarmN)}</b>${ctl}</div>${ctl && why ? `<p class="why" id="why-${g.id}">${esc(why)}</p>` : ""}
    <ul class="body">${body.map(x => slotRow(x, by[x.key], sq)).join("")}</ul></div>`;
}

// SWARM Podpora (specs/swarm-squady P2-P3): a vehicle = its crew, framed like a unit; the Commander adds and removes
// vehicles per type, "-" only the last one and only while its whole crew is free (as "- Swarm")
function podporaCard(g, by) {
  const n = g.slots.filter(x => by[x.key]).length;
  const types = g.vehicles.map(t => {
    const last = t.cars[t.cars.length - 1], wid = `why-POD-${t.kit}`;
    const less = !last ? `žádný ${t.name}` : last.slots.some(x => by[x.key]) ? `${last.name} má posádku` : "";
    const more = t.n >= t.max ? `${t.name}: nejvýš ${t.max}` : "";
    const why = [less, more].filter(Boolean).join(", ");
    const ctl = state.me.is_commander ? `<div class="sqp">${esc(t.name)} <b>${esc(t.n)}</b><span class="swctl">
      <button type="button" class="act" data-support="${t.ti}:-1" aria-label="Podpora: ubrat ${esc(t.name)}"${less ? ` disabled aria-describedby="${esc(wid)}"` : ""}>\u2212 ${esc(t.name)}</button>
      <button type="button" class="act" data-support="${t.ti}:1" aria-label="Podpora: přidat ${esc(t.name)}"${more ? ` disabled aria-describedby="${esc(wid)}"` : ""}>+ ${esc(t.name)}</button></span></div>${why ? `<p class="why" id="${esc(wid)}">${esc(why)}</p>` : ""}` : "";
    const cars = t.cars.map(c => `<div class="veh" data-veh="${esc(c.slots[0].key)}"><div class="vh">${sym(t.symbol, "sm")}<b class="vn">${esc(c.name)}</b><span class="num">${c.slots.filter(x => by[x.key]).length}/${c.slots.length}</span></div>
      <ul>${c.slots.map(x => slotRow(x, by[x.key])).join("")}</ul></div>`).join("");
    return ctl || cars ? `<div class="vtype">${ctl}${cars}</div>` : "";
  }).join("");
  return `<div class="rg podc"><div class="pg-head">${sym(g.symbol, "sm")}<div><b>${esc(g.name)}</b><small>${esc(g.squad)}</small></div><span class="num">${n}/${g.max}</span></div>
    <div class="vtypes">${types}</div></div>`;
}

function viewRoster(s) {
  const head = "<h2>Sestava</h2>";
  const msg = state.flash ? `<p class="err ros-msg" role="alert">${esc(state.flash)}</p>` : "";
  if (!sb) return `${head}<p class="note">Sestava se teď nenačetla (knihovna přihlášení není dostupná). Plány map a doktrína fungují dál.</p>`;
  if (!state.me) return `${head}<p class="note">Sestava je jen pro členy KIN. <button type="button" class="act" data-login>Přihlásit přes Discord</button></p>`;
  const ev = state.event;
  if (!ev) return state.evErr ? `${head}${msg}`
    : `${head}${state.me.is_commander ? newEventForm() : '<p class="note">Žádná akce není otevřená. Založí ji Commander.</p>'}${msg}`;
  const cancel = state.me.is_commander ? cancelEventForm() : "";
  // the map form too: picking a known map or "zatím nevím" keeps the sign-ups, cancelling drops them (threat model N1)
  if (!s) return `${head}<p class="note">Otevřená akce (${esc(fmtWhen(ev.starts_at))}) je pro mapu ${esc(ev.strategy_id)}, kterou Central Command nezná.</p>${msg}${state.me.is_commander ? mapTeamForm(ev) : ""}${cancel}`;
  const by = Object.fromEntries(state.claims.map(c => [c.slot_key, c]));
  const filled = state.claims.filter(c => s.roster.some(g => g.slots.some(x => x.key === c.slot_key))).length;
  const total = s.roster.reduce((n, g) => n + g.max, 0);
  // without builders and logistics there is no FOB and no supplies: show the plan's fill order still open
  const missing = (s.fill_order || []).filter(id => !by[id]).map(id => roleOf(s, id)).filter(Boolean);
  // first 6 only: glanceable at a briefing and fewer chips to hit by mistake on a phone (a tap moves your slot)
  // my slot's shopping list one tap away (denbler 2026-10-19 "at si kazdy hned najde svoje"): SWARM below in Akce,
  // Top defence on my role card of the map
  const myc = state.claims.find(c => c.user_id === state.me.user_id);
  const mys = myc && s.roster.flatMap(g => g.slots.map(x => ({ g, x }))).find(o => o.x.key === myc.slot_key);
  const myr = mys && !s.swarm && mys.x.role && roleOf(s, mys.x.role);
  const mine = !mys ? "" : s.swarm
    ? `<p class="mine-kit">Máš místo: <b>${esc(mys.x.car || mys.g.name)} · ${esc(mys.x.label)}</b> <button type="button" class="kitl" data-kit="${esc(mys.x.kit)}">Tvůj nákup</button></p>`
    : myr ? `<p class="mine-kit">Máš místo: <b>${esc(myr.id)} · ${esc(mys.g.name)}</b>${s.nomap ? "" : ` <a class="kitl" href="${roleHref(s, myr)}">Tvoje karta: nákup a kroky</a>`}</p>` : "";
  const miss = s.swarm ? slBar(filled)
    : missing.length
    ? `<p class="miss">Chybí: ${missing.slice(0, 6).map(r => `<button type="button" class="rid" data-claim="${esc(r.id)}" title="${esc(r.id)} – ${esc(r.name)}">${esc(r.id)}</button>`).join(" ")}${missing.length > 6 ? ` <span class="more">a dalších ${missing.length - 6}</span>` : ""}</p>`
    : '<p class="miss ok">Všechny role z plánu obsazené.</p>';
  // the operation console (Petr 2026-10-21 "prehlednejsi a vychytanejsi ... tlacitka, notifikace, sestava"): who and what
  // with a live T- clock and the fill gauge, then the alert strip, my place and answer, the Commander's commands last
  const pct = total ? Math.round(filled / total * 100) : 0;
  return `<div class="opcon"><div class="ros-head"><div class="op-id"><span class="op-lamp" aria-hidden="true"></span>${head}
      <span class="lead">${esc(docName(s.swarm ? "swarm" : "defence"))} · ${sideOf(ev.strategy_id, "mapa zatím nevybraná")}</span>${ev.leader ? `<span class="lead">Vede: <b>${esc(ev.leader.name)}</b></span>` : ""}</div>
    <div class="op-clock"><time datetime="${esc(ev.starts_at)}">${esc(fmtWhen(ev.starts_at))}</time><b class="tminus" data-t0="${esc(ev.starts_at)}">${tminus(ev.starts_at)}</b></div>
    <div class="op-fill"><span class="num">${filled} <small>/ ${total}</small></span><span class="gauge" style="--p:${pct}%" aria-hidden="true"></span><small>zapsaných</small></div></div>
    <div class="op-status">${miss}</div>
    <div class="op-me">${mine}${rsvpBar()}</div>
    ${state.me.is_commander ? `<div class="op-cmd" role="group" aria-label="Příkazy Commandera">${mapTeamForm(ev)}${closeEventForm(s)}<a class="act" href="#/briefing">Protokol briefingu</a>${cancel}</div>` : ""}</div>
    ${msg}
    <div class="ros${s.swarm ? " swarm" : ""}">${s.roster.map(g => g.swarmN ? squadCard(g, by) : g.vehicles ? podporaCard(g, by) : rosterGroup(g, by)).join("")}</div>`;
}

// "T-01:12:05" before the start, "+00:14" after it; one interval ticks every clock on the page
function tminus(iso) {
  const d = Math.round((new Date(iso) - Date.now()) / 1000), a = Math.abs(d), p = n => String(n).padStart(2, "0");
  const h = Math.floor(a / 3600), m = Math.floor(a % 3600 / 60);
  // a Sunday event founded on Thursday is 70+ hours away: days read faster than three-digit hours
  if (d > 0 && h >= 48) return `T−${Math.floor(h / 24)} d ${p(h % 24)}:${p(m)}`;
  return d > 0 ? `T−${p(h)}:${p(m)}:${p(a % 60)}` : `+${p(h)}:${p(m)}`;
}
setInterval(() => document.querySelectorAll(".tminus[data-t0]").forEach(e => { e.textContent = tminus(e.dataset.t0); }), 1000);

// Akce (Petr 2026-10-19, specs/akce-flow rozhodnuti 8): the open event's roster for both doctrines, where to read
// the plan, and for SWARM what I buy; maps and doctrine are for reading only
function akceBody() {
  const s = plan, ev = state.me && state.event;
  const tr = state.me ? trainingsSection() : "";  // specs/typy-akci T3: under the operation, also when none is open
  if (!ev || !s) return viewRoster(s) + tr;
  const read = s.swarm ? `Plán ke čtení: <a href="#/doktrina/swarm">${esc(docName("swarm"))} v Doktríně</a>`
    : s.nomap ? "Karta role a nákup se ukážou, až Commander vybere mapu a tým."
    : `Situace, větve a karty rolí: <a href="${planHref(s)}">${esc(sideLabel(s))} v Mapách</a>`;
  return `<p class="note planl">${read}</p>${viewRoster(s)}${s.swarm ? swarmMyKit() : s.nomap ? "" : buildOrder(s)}${tr}`;
}
// FORTRESS with map and team: the plan of the picked zone under the lobby (specs/mapy-v2 M5)
function buildOrder(s) {
  const v = curVariant && vById(s, curVariant);
  viewCanvas(s);  // fills planMatrix
  return `<section class="block" id="build-order"><h2>Build order · ${esc(sideLabel(s))}${v ? ` · ${esc(v.name)}` : ""}</h2>
    ${v ? "" : '<p class="note">Varianta zóny zatím není vybraná: plán ukazuje kroky všech variant.</p>'}${planMatrix}</section>`;
}

// the base and my slot's kit; every role's kit is in Doktrina (rozhodnuti 8: not the same list in two places)
function swarmMyKit() {
  const k = D.doktrina.swarm, myc = state.claims.find(c => c.user_id === state.me.user_id);
  const slot = myc && plan.roster.flatMap(g => g.slots).find(x => x.key === myc.slot_key);
  const r = slot && k.slots.find(r => r.id === slot.kit);
  const [cq, cc] = r && !r.own_kit ? classById(r.class) : [], skip = cc ? myKit(cc).names : new Set();
  return `<section class="block" id="swarm-kit"><h2>Tvůj nákup</h2>${cc ? loadoutCard(cq, cc, "h3") : ""}${r && r.own_kit ? "" : kitBase(k, skip)}
    ${r ? kitRole(slot.seat ? { ...r, ...r.seats[slot.seat] } : r, skip) : '<p class="note">Zapiš se do slotu a ukážu ti nákup tvé role. Nákup všech rolí je v <a href="#/doktrina/swarm">Doktríně</a>.</p>'}</section>`;
}

// realtime and tab-return re-render the block: keep what the Commander is typing into a form
// an open SWARM event: pages without the event card point to Akce (a saved role opens the Top defence card, Viktor #001)
function renderEvBar() {
  const ev = state.me && state.event, bar = document.getElementById("evbar");
  if (bar) bar.innerHTML = ev && ev.doctrine === "swarm" && !["sestava", "ev-card", "home-ev"].some(id => document.getElementById(id))
    ? `<a href="#/akce"><b>Akce ${esc(fmtWhen(ev.starts_at))}: ${esc(docName("swarm"))}.</b> Zápis a tvůj nákup jsou v Akci.</a>` : "";
}

// returns a function that puts back the roster's typed forms and open <details> after a rebuild
function keepForms() {
  const el = document.getElementById("sestava");
  if (!el) return () => {};
  const keep = [...el.querySelectorAll("form[data-form]")].map(f => [f.dataset.form,
    [...f.elements].filter(x => x.name).map(x => [x.name, x.type === "checkbox" ? x.checked : x.value])]);
  const opened = [...el.querySelectorAll("details[open]")].map(d => d.className);
  return () => {
    const el = document.getElementById("sestava");
    if (!el) return;
    for (const c of opened) { const d = el.querySelector(`details.${c}`); if (d) d.open = true; }
    for (const [name, fields] of keep) {
      const f = el.querySelector(`form[data-form="${name}"]`);
      if (!f) continue;
      for (const [k, v] of fields) { const x = f.elements[k]; if (!x) continue; if (x.type === "checkbox") x.checked = v; else x.value = v; }
    }
    el.querySelectorAll('form[data-form="new"], form[data-form="mapteam"]').forEach(newHint);
    el.querySelectorAll('form[data-form="training"]').forEach(capToggle);
  };
}

function renderRoster() {
  renderEvBar();
  const home = document.getElementById("home-ev");
  if (home) home.innerHTML = homeEvent();
  const card = document.getElementById("ev-card");
  if (card) card.innerHTML = evCard();
  const el = document.getElementById("sestava");
  if (!el) return;
  plan = planOf(state.event);  // a new, cancelled or switched event changes which roster Akce shows
  if (plan && !plan.swarm) curVariant = state.event.variant || pickVariant(plan, "");  // the zone picked at founding, else the last seen
  const restore = keepForms();
  keepFocus(() => { el.innerHTML = akceBody(); });
  restore();
  markChanges(el);
}

// war room (Petr 2026-10-21, specs/war-room W2-W3): every change on the roster shows on the row or vehicle and plays one
// cue, mine and the others' (realtime) alike; the first paint and a switched event stay quiet
let seen = null;
function markChanges(el) {
  const now = { ev: state.event && state.event.id, flash: state.flash,
    by: Object.fromEntries(state.claims.map(c => [c.slot_key, c.user_id])),
    leads: new Set(state.claims.filter(c => c.lead).map(c => c.slot_key)),
    keys: new Set([...el.querySelectorAll("li[data-key]")].map(li => li.dataset.key)),
    vehs: new Set([...el.querySelectorAll(".veh[data-veh]")].map(v => v.dataset.veh)) };
  const was = seen;
  seen = now;
  if (!was || was.ev !== now.ev) return;
  const fired = new Set(), mark = (node, cls, cue) => { if (node) { node.classList.add(cls); fired.add(cue); } };
  for (const li of el.querySelectorAll("li[data-key]")) {
    const k = li.dataset.key;
    if (!was.keys.has(k)) { mark(li, "fx-new", "add"); continue; }
    if (now.by[k] && now.by[k] !== was.by[k]) mark(li, "fx-claim", "claim");
    else if (!now.by[k] && was.by[k]) mark(li, "fx-free", "free");
    if (now.leads.has(k) && !was.leads.has(k)) mark(li.querySelector(".slb"), "fx-lead", "lead");
  }
  for (const v of el.querySelectorAll(".veh[data-veh]")) if (!was.vehs.has(v.dataset.veh)) mark(v, "fx-new", "vehicle");
  if ([...was.keys].some(k => !now.keys.has(k))) fired.add("remove");
  if (now.flash && now.flash !== was.flash) fired.add("error");
  const cue = ["error", "vehicle", "lead", "claim", "add", "free", "remove"].find(c => fired.has(c));
  if (cue) sound(cue);
}

// synthesized cues (Web Audio, no files): short, quiet, off with the speaker in the bar (remembered in localStorage)
let actx = null;
let soundPref = null;  // private window without localStorage: the toggle still works for this visit
const soundOn = () => { try { return (localStorage.getItem("kin-sound") || soundPref) !== "off"; } catch { return soundPref !== "off"; } };
const CUES = {  // [start Hz, end Hz, seconds, wave, delay s]
  claim: [[520, 880, .07, "square", 0], [1320, 1320, .08, "sine", .07]],
  free: [[660, 330, .16, "triangle", 0]],
  add: [[1800, 1800, .02, "square", 0], [990, 990, .09, "sine", .04]],
  remove: [[440, 220, .1, "square", 0]],
  vehicle: [[80, 150, .26, "sawtooth", 0], [740, 740, .12, "sine", .14]],
  lead: [[660, 660, .12, "sine", 0], [880, 880, .12, "sine", .07], [1320, 1320, .2, "sine", .14]],
  error: [[150, 120, .2, "square", 0]],
};
function sound(name) {
  if (!soundOn() || !CUES[name]) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === "suspended") actx.resume();  // allowed after the first click; before it the cue just stays silent
    const t0 = actx.currentTime;
    for (const [f0, f1, dur, type, at] of CUES[name]) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, t0 + at);
      o.frequency.exponentialRampToValueAtTime(f1, t0 + at + dur);
      g.gain.setValueAtTime(0.0001, t0 + at);
      g.gain.exponentialRampToValueAtTime(type === "sine" ? 0.09 : 0.035, t0 + at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
      o.connect(g).connect(actx.destination);
      o.start(t0 + at);
      o.stop(t0 + at + dur + 0.02);
    }
  } catch (e) { console.error(e); }  // no audio device: the page works on without cues
}
function renderSound() {
  const b = document.getElementById("snd");
  if (b) b.setAttribute("aria-pressed", String(soundOn()));
}
document.getElementById("snd")?.addEventListener("click", () => {
  soundPref = soundOn() ? "off" : "on";
  try { localStorage.setItem("kin-sound", soundPref); } catch { /* private window: soundPref holds it */ }
  renderSound();
  sound("claim");
});
renderSound();

async function claim(key) {
  const s = plan;  // the page may change while saving (render() resets plan off roster pages, Viktor #029)
  const g = s.roster.find(g => g.slots.some(x => x.key === key)), slot = g.slots.find(x => x.key === key);
  const { error } = await sb.from("claims").upsert(
    // SWARM: the role, not "Squad 2 · Raketomet" (stats count labels as roles, Viktor #005)
    { event_id: state.event.id, slot_key: key, slot_label: s.swarm ? slot.stat : `${g.name} · ${slot.label}`, user_id: state.me.user_id, lead: false },
    { onConflict: "event_id,user_id" });
  await loadEvent();
  if (error && error.code === "23505") {
    const c = state.claims.find(c => c.slot_key === key);
    state.flash = `Slot už obsadil ${c ? c.members.name : "někdo jiný"}.`;
  } else if (error) state.flash = error.code === "42501" ? "Akce už je uzavřená." : saveErr(error);
  else {
    if (!state.evErr) state.flash = null;  // saved, but the reload failed: keep the outage message
    if (slot.role && !s.nomap) { me.set(`${s.id}/${slot.role}`); renderNav(navActive); }  // "Moje role" needs a map's card
  }
  renderRoster();
  if (state.flash) document.querySelector(".ros-msg")?.scrollIntoView({ block: "nearest" });
}

// "Moje role" follows my slot on the open event's current map (review 2026-10-20 M1): the Commander picks or changes
// the map after sign-ups, and a card of the old map would have the member study the wrong plan on the briefing
// (map back to "zatim nevim": no card; a role picked by hand on another map stays)
function syncMyRole() {
  const s = planOf(state.event), c = s && state.claims.find(c => c.user_id === state.me.user_id);
  const slot = c && s.roster.flatMap(g => g.slots).find(x => x.key === c.slot_key);
  if (!slot?.role) return;
  const want = s.nomap ? null : `${s.id}/${slot.role}`, [, rid] = (me.get() || "/").split("/");
  if (me.get() !== want && (want || rid === slot.role)) { me.set(want); renderNav(navActive); }
}

async function unclaim(userId) {
  const { error } = await sb.from("claims").delete().eq("event_id", state.event.id).eq("user_id", userId);
  state.flash = !error ? null : error.code === "42501" ? "Akce už je uzavřená." : saveErr(error);
  await loadEvent();
}

document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") loadEvent(); });

// SWARM: every squad with people in it needs its SL, a badge one of them takes (Petr 2026-10-19, specs/swarm-squady S7)
function slBar(n) {
  const by = Object.fromEntries(state.claims.map(c => [c.slot_key, c]));  // roster keys, not a prefix (OWASP L1)
  const bez = plan.roster.filter(g => g.swarmN && g.slots.some(x => by[x.key]) && !leadOf(g)).map(g => g.name);
  return !n ? '<p class="miss">Zatím nikdo. Zapiš se do squadu, každý squad potřebuje svého SL.</p>'
    : bez.length ? `<p class="miss warn">Je vás ${n}. Squady bez SL: ${esc(bez.join(", "))}.</p>`
    : `<p class="miss ok">Je vás ${n}, každý obsazený squad má SL.</p>`;
}

// the Commander sizes a squad's Swarm (specs/swarm-squady S2); the event keeps every squad's size, null = the template's
// ponytail: a sign-up racing the "-" can land on the dropped place and stays unseen until its owner picks again; DB trigger if it bites
async function setSwarm(idx, delta) {
  const t = D.doktrina.swarm.sestava, ev = state.event;
  const sizes = Array.from({ length: t.squads }, (_, i) => (ev.squad_swarm && ev.squad_swarm[i]) || t.swarm.default);
  sizes[idx] += delta;
  const { data, error } = await sb.from("events").update({ squad_swarm: sizes }).eq("id", ev.id).select("id");
  state.flash = error ? saveErr(error) : !data.length ? "Velikost squadu se nepodařilo uložit: akce už není otevřená, nebo nemáš práva Commandera." : null;
  await loadEvent();
}

// the Commander adds or removes a vehicle (specs/swarm-squady P2); the event keeps every type's count, null = the template's
// ponytail: the same race as setSwarm (a sign-up into the vehicle just dropped stays unseen); DB trigger if it bites
async function setSupport(ti, delta) {
  const ev = state.event, counts = D.doktrina.swarm.sestava.podpora.map((t, i) => ev.squad_support?.[i] ?? t.default);
  counts[ti] += delta;
  const { data, error } = await sb.from("events").update({ squad_support: counts }).eq("id", ev.id).select("id");
  state.flash = error ? saveErr(error) : !data.length ? "Vozidla se nepodařilo uložit: akce už není otevřená, nebo nemáš práva Commandera." : null;
  await loadEvent();
}

// the SL badge on my own row (S4-S5); one per squad: the unique index claims_one_lead refuses a second (23505)
async function takeLead(on) {
  const uid = state.me.user_id;
  const { data, error } = await sb.from("claims").update({ lead: on }).eq("event_id", state.event.id).eq("user_id", uid).select("slot_key");
  await loadEvent();
  const mine = state.claims.find(c => c.user_id === uid);
  const other = mine && state.claims.find(c => c.lead && c.user_id !== uid && squadOf(c.slot_key) === squadOf(mine.slot_key));
  state.flash = error ? (error.code === "23505" ? `Squad už vede ${other ? other.members.name : "někdo jiný"}.` : saveErr(error))
    : !data.length ? "SL se nepodařilo uložit: akce už není otevřená." : state.evErr ? state.flash : null;
  renderRoster();
  if (state.flash) document.querySelector(".ros-msg")?.scrollIntoView({ block: "nearest" });
}

// map and team: two choices, "zatím nevím" first (specs/akce-mapa-tym); s = the plan picked so far
const pickFields = (s, ev) => `<label>Mapa <select name="map"><option value="">zatím nevím</option>${[...new Set(D.strategies.map(x => x.map))].map(m =>
    `<option value="${esc(m)}"${s && s.map === m ? " selected" : ""}>${esc(m)}</option>`).join("")}</select></label>
  <label>Tým <select name="team"><option value="">zatím nevím</option>${D.tymy.map(t =>
    `<option value="${esc(t.id)}"${s && s.team === t.id ? " selected" : ""}>${esc(t.name)}</option>`).join("")}</select></label>
  <label>Varianta zóny <select name="variant"><option value="">zatím nevím</option>${MAPS().map(m => `<optgroup label="${esc(m)}">${D.strategies.find(x => x.map === m).variants.map(v =>
    `<option value="${esc(mapSlug(m) + ":" + v.id)}"${ev && s && s.map === m && ev.variant === v.id ? " selected" : ""}>${esc(v.name)}</option>`).join("")}</optgroup>`).join("")}</select></label>`;

// one form in Akce for both doctrines (rozhodnuti 8); founding ahead, the map and team are not known yet (specs/akce-mapa-tym)
function newEventForm() {
  return `<form class="evf" data-form="new"><p class="note">Žádná akce není otevřená.</p>
    <label>Začátek <input type="datetime-local" name="starts" required min="${new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)}T00:00"></label>
    <label>Doktrína <select name="doctrine">${["defence", "swarm"].map(d => `<option value="${d}">${esc(docOf(d).title)}: ${esc(docOf(d).short)}</option>`).join("")}</select></label>
    ${pickFields(null)}
    <button type="submit" class="act">${esc(newLabel("defence", null))}</button></form>`;
}

// the Commander picks or changes them while the event is open (specs/akce-mapa-tym 3-4); sign-ups keep their slots
function mapTeamForm(ev) {
  const s = S(ev.strategy_id);
  return `<details class="evmap"><summary>Mapa, tým a varianta</summary><form class="evf" data-form="mapteam">${pickFields(s, ev)}
    <button type="submit" class="act">${esc(saveLabel(s))}</button></form></details>`;
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

// ---------- tréninky a kurzy (specs/typy-akci): officers found them beside the operation, members answer in one click ----------
const KINDS = { trenink: "Trénink", kurz: "Kurz" };
const TOPICS = { stavba: "Stavba", pechota: "Boj pěchoty", technika: "Technika a vozidla", vrtulniky: "Vrtulníky", jine: "Jiné" };
const label = (o, k) => Object.hasOwn(o, k) ? o[k] : k;  // a stored value we do not know is shown as stored
const WHO = [["yes", "Přijdou"], ["maybe", "Možná"], ["no", "Nemůžou"]];  // names of others, so not "Prijdu" as on the buttons
const goers = tr => tr.rsvps.filter(r => r.status === "yes").length;
const trCount = tr => tr.capacity ? `${goers(tr)} / ${esc(tr.capacity)}` : String(goers(tr));

function trainingsSection() {
  const list = state.trainings.length ? `<ul class="trl">${state.trainings.map(trainingRow).join("")}</ul>`
    : '<p class="note">Teď není vypsaný žádný trénink ani kurz. Vypisují je důstojníci.</p>';
  return `<section class="block" id="treninky"><h2>Tréninky a kurzy</h2>${state.me.is_commander || state.me.is_officer ? newTrainingForm() : ""}${list}</section>`;
}

function trainingRow(tr) {
  const by = { yes: [], maybe: [], no: [] }, id = esc(tr.id);
  for (const r of tr.rsvps) (by[r.status] || []).push(r.members);
  const mine = (tr.rsvps.find(r => r.user_id === state.me.user_id) || {}).status;
  // T4: no "Prijdu" on a full course unless I already have a place; the capacity trigger refuses it anyway
  const full = tr.capacity && by.yes.length >= tr.capacity && mine !== "yes";
  const ctl = state.me.is_commander || tr.created_by === state.me.user_id ? `<details class="t${id}"><summary>Uzavřít nebo zrušit</summary>
      <p class="note">Obojí ho z Akce odebere. Uzavři ten, který proběhl, zruš ten, který nebude.</p>
      <button type="button" class="act" data-tclose="${id}:closed">Proběhl, uzavřít</button> <button type="button" class="act" data-tclose="${id}:cancelled">Zrušit</button></details>` : "";
  return `<li class="tr"><p class="tr-k"><span class="ref">${esc(label(KINDS, tr.kind))}</span>${esc(label(TOPICS, tr.topic))}</p>
    <h3>${esc(tr.title)}</h3>
    <p class="tr-m"><time datetime="${esc(tr.starts_at)}">${esc(fmtWhen(tr.starts_at))}</time> · Vede <b>${esc(tr.leader ? tr.leader.name : "?")}</b> · Přijde <b>${trCount(tr)}</b></p>
    ${tr.description ? `<p class="tr-d">${esc(tr.description)}</p>` : ""}
    <div class="rsvp" role="group" aria-label="${esc(tr.title)}: přijdeš?">${RSVP.map(([k, l]) => `<button type="button" class="act" data-trsvp="${id}:${k}" aria-pressed="${mine === k}"${k === "yes" && full ? ` disabled aria-describedby="full-${id}"` : ""}>${l}</button>`).join("")}</div>
    ${full ? `<p class="tr-full" id="full-${id}">Kurz je plný.</p>` : ""}
    ${WHO.map(([k, l]) => by[k].length ? `<p class="tr-who"><b>${l}:</b> ${by[k].map(memberLink).join(" ")}</p>` : "").join("")}
    ${ctl}</li>`;
}

function newTrainingForm() {
  return `<details class="trnew"><summary>Vypsat trénink nebo kurz</summary><form class="evf" data-form="training">
    <label>Typ <select name="kind"><option value="trenink">Trénink: pro všechny</option><option value="kurz">Kurz: omezený počet míst</option></select></label>
    <label>Téma <select name="topic">${Object.entries(TOPICS).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></label>
    <label class="wide">Název <input name="title" required maxlength="80"></label>
    <label>Začátek <input type="datetime-local" name="starts" required min="${new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)}T00:00"></label>
    <label class="cap" hidden>Počet míst <input type="number" name="capacity" min="2" max="12" value="8" required disabled></label>
    <label class="wide">Krátký popis <textarea name="description" maxlength="500" rows="2"></textarea></label>
    <button type="submit" class="act">Vypsat</button></form></details>`;
}
// a course has places, a training does not: the field shows and is sent only for a course
const capToggle = f => { const off = f.elements.kind.value !== "kurz"; f.querySelector(".cap").hidden = off; f.elements.capacity.disabled = off; };

// T2: the Commander and officers; the database refuses anyone else, and an operation from an officer
async function createTraining(f) {
  const v = Object.fromEntries(new FormData(f)), kind = v.kind === "kurz" ? "kurz" : "trenink";
  const { error } = await sb.from("events").insert({ kind, topic: v.topic, title: v.title.trim(), starts_at: new Date(v.starts).toISOString(),
    description: v.description.trim() || null, capacity: kind === "kurz" ? Number(v.capacity) : null });
  state.flash = !error ? null : error.code === "42501" ? "Trénink nebo kurz vypíše jen důstojník (role Velitel) nebo Commander." : saveErr(error);
  if (!error) { f.reset(); capToggle(f); }  // the next one starts from an empty form
}

async function rsvpTraining(id, status) {
  const { error } = await sb.from("rsvps").upsert({ event_id: id, user_id: state.me.user_id, status, updated_at: new Date().toISOString() },
    { onConflict: "event_id,user_id" });
  // 23514 = the capacity trigger (012): someone took the last place a moment earlier
  state.flash = !error ? null : error.code === "23514" ? "Kurz je plný." : error.code === "42501" ? "Trénink už je uzavřený." : saveErr(error);
  await loadEvent();
}

// T5: the founder or the Commander (events_close, 012); no row back = not open any more, or not his
async function closeTraining(id, status) {
  const { data, error } = await sb.from("events").update({ status: status === "closed" ? "closed" : "cancelled" })
    .eq("id", id).neq("kind", "operace").select("id");
  state.flash = error ? saveErr(error) : !data.length ? "Nepodařilo se uložit: trénink už není otevřený, nebo ho nevypsal ty." : null;
  await loadEvent();
}

// Viktor #003: the button says what gets founded or saved; a map without a team is not a plan yet (decision 1)
const planName = s => `${s.map} · ${teamOf(s.team).name}`;
const newLabel = (doctrine, s) => `Založit akci: ${docName(doctrine)}${s ? " · " + planName(s) : ""}`;
const saveLabel = s => `Uložit: ${s ? planName(s) : "zatím bez mapy a týmu"}`;
function newHint(f) {
  const b = f && f.querySelector('button[type="submit"]'), s = b && compose(f.elements.map.value, f.elements.team.value);
  if (b) b.textContent = f.dataset.form === "new" ? newLabel(f.elements.doctrine.value, s) : saveLabel(s);
}
document.addEventListener("change", e => { if (["doctrine", "map", "team"].includes(e.target.name) && ["new", "mapteam"].includes(e.target.form?.dataset.form)) newHint(e.target.form); });
document.addEventListener("change", e => { if (e.target.name === "kind" && e.target.form?.dataset.form === "training") capToggle(e.target.form); });

document.addEventListener("submit", async e => {
  const f = e.target.closest("form[data-form]");
  if (!f) return;
  e.preventDefault();
  const btn = f.querySelector('button[type="submit"]');
  if (btn.disabled) return;  // double click: the first submit is still saving
  btn.disabled = true;
  if (f.dataset.form === "training") { await createTraining(f); btn.disabled = false; await loadEvent(); return; }
  const v = Object.fromEntries(new FormData(f)), eventId = state.event && state.event.id;
  // OWASP 2026-10-19 Low: map and team only pick one of our plans, a tampered <option> cannot send its own strategy_id
  const pick = f.elements.map && compose(f.elements.map.value, f.elements.team.value), sid = pick ? pick.id : null;
  // the zone belongs to the picked map: "ozeti:church" counts only with Ozeti picked (a tampered option saves nothing)
  const [vm, vid] = String(v.variant || "").split(":"), zone = f.dataset.form !== "close" && pick && pick.map && vm === mapSlug(pick.map)
    && D.strategies.find(x => x.map === pick.map).variants.some(x => x.id === vid) ? vid : null;
  // attendance = exactly what the Commander saw and ticked in this form (state.claims may be mid-reload);
  // written first: if closing fails the event stays open and this upsert can simply run again
  const att = [...f.querySelectorAll('input[name^="att_"]')].map(x => ({ event_id: eventId, user_id: x.name.slice(4), attended: x.checked }));
  if (f.dataset.form === "close" && att.length) {
    const { error: e1 } = await sb.from("attendance").upsert(att, { onConflict: "event_id,user_id" });
    if (e1) { state.flash = e1.code === "42501" ? "Docházku se nepodařilo uložit, zkus to znovu." : saveErr(e1); btn.disabled = false; renderRoster(); return; }
  }
  const { data, error } = f.dataset.form === "new"
    ? await sb.from("events").insert({ strategy_id: sid, variant: zone, doctrine: v.doctrine === "swarm" ? "swarm" : "defence", starts_at: new Date(v.starts).toISOString() })
    : f.dataset.form === "mapteam" ? await sb.from("events").update({ strategy_id: sid, variant: zone }).eq("id", eventId).select("id")  // count rows like cancelEvent (OWASP L1)
    : await sb.from("events").update({ status: "closed", placement: Number(v.placement), variant: v.variant || null,
        went_well: v.went_well || null, went_wrong: v.went_wrong || null, next_time: v.next_time || null }).eq("id", eventId);
  state.flash = error ? (error.code === "23505" ? "Už je otevřená jiná akce." : saveErr(error))
    : f.dataset.form === "mapteam" && !data.length ? "Mapu a tým se nepodařilo uložit: akce už není otevřená, nebo nemáš práva Commandera." : null;
  btn.disabled = false;
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
// the roster Akce signs people up to: the open event's map plan (Top defence) or the SWARM canvas (specs/akce-swarm);
// only Akce has one (Petr 2026-10-19, specs/akce-flow rozhodnuti 8)
let plan = null;
// squads from the template and the event's sizes (specs/swarm-squady); keys stay SW-Q{n}-AT, SW-Q{n}-RS, SW-Q{n}-SW (the
// first Swarm, same key as before), SW-Q{n}-SW2 ..; Podpora from its vehicles
function swarmRoster(k, sizes, support) {
  const t = k.sestava, sw = t.swarm;
  return [...Array.from({ length: t.squads }, (_, idx) => {
    const n = idx + 1, swarmN = (sizes && sizes[idx]) || sw.default;
    const slots = [...t.core.map(c => ({ key: `SW-Q${n}-${c.kit}`, label: c.label, role: null, kit: c.kit, stat: c.label })),
      ...Array.from({ length: swarmN }, (_, i) => ({ key: `SW-Q${n}-${sw.kit}${i ? i + 1 : ""}`, label: sw.label, role: null, kit: sw.kit, stat: sw.label }))];
    return { id: `Q${n}`, name: `Squad ${n}`, symbol: "infantry", max: slots.length, idx, swarmN, slots };
  }), podporaGroup(t.podpora, support)];
}
// Podpora = vehicles per type from the template and the event's counts (specs/swarm-squady P1); seat i of vehicle v
// is SW-<type><(v-1)*seats + i>, so Tank 1 keeps SW-TK1..3 and Tank 2 is SW-TK4..6. stat = the role kept in history
function podporaGroup(types, counts) {
  const vehicles = types.map((t, ti) => { const n = counts?.[ti] ?? t.default;
    return { ...t, ti, n, cars: Array.from({ length: n }, (_, v) => ({ name: `${t.name} ${v + 1}`, slots: t.seats.map((seat, i) =>
      ({ key: `SW-${t.kit}${v * t.seats.length + i + 1}`, label: seat, role: null, kit: t.kit, seat, car: `${t.name} ${v + 1}`, stat: `${t.name} · ${seat}` })) })) }; });
  const slots = vehicles.flatMap(t => t.cars.flatMap(c => c.slots));
  return { id: "POD", name: "Podpora", squad: "pod velitelem", symbol: "armor", max: slots.length, vehicles, slots };
}
const swarmPlan = ev => ({ id: "swarm", swarm: true, roster: swarmRoster(D.doktrina.swarm, ev.squad_swarm, ev.squad_support), fill_order: [], variants: [] });
// FORTRESS before the map (specs/akce-mapa-tym): all plans share the 45 slots (test_build), so sign-ups keep their slot
// when the map comes; role cards, zones and the map's plan wait for the map and team
const fortressPlan = () => { const s = D.strategies[0];
  return { id: "fortress", nomap: true, roster: s.roster, fill_order: s.fill_order, roles: s.roles, variants: [] }; };
const planOf = ev => !ev ? null : ev.doctrine === "swarm" ? swarmPlan(ev) : !ev.strategy_id ? fortressPlan() : S(ev.strategy_id) || null;
// doctrine names live in the content (Petr 2026-10-19: FORTRESS, SWARM); events store "defence" / "swarm"
const docOf = d => d === "swarm" ? D.doktrina.swarm : D.doktrina.defence;
const docName = d => docOf(d).title;

let planMatrix = "";  // the map's Top defence plan, kept to swap back when the SWARM event ends
let navActive = null;  // menu item of the current page, for re-rendering the nav after a claim
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

// APP-6 friendly unit symbols, squad echelon dot above the frame
function sym(kind, cls = "") {
  const icon = {
    infantry: '<path d="M6 6 L42 30 M42 6 L6 30"/>',
    engineer: '<path d="M15 14 H33 M15 14 V23 M24 14 V23 M33 14 V23"/>',
    supply: '<path d="M6 24 H42"/>',
    recon: '<path d="M6 30 L42 6"/>',
    armor: '<path d="M16 12 H32 A6 6 0 0 1 32 24 H16 A6 6 0 0 1 16 12 Z"/>',
    rotary: '<path d="M14 12 L34 24 V12 L14 24 Z"/>',
    motorized: '<path d="M24 6 V30"/>',
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
  const ev = state.event, tr = state.trainings[0];
  // specs/typy-akci T6: the nearest training or course as a second line, under the operation or without one
  const next = tr ? `<a class="trnext" href="#/akce"><span class="ref">${esc(label(KINDS, tr.kind))}</span><span>${esc(tr.title)} · ${esc(fmtWhen(tr.starts_at))} · přijde ${trCount(tr)}</span></a>` : "";
  if (!ev) return (state.evErr ? `<p class="err home-ev">${LOAD_ERR}</p>` : '<p class="note home-ev">Teď není otevřená žádná akce.</p>') + next;
  const mine = state.claims.find(c => c.user_id === state.me.user_id);
  const said = (state.rsvps || []).find(r => r.user_id === state.me.user_id);
  const status = mine ? `Máš místo: ${esc(mine.slot_label)}` : said ? `Tvoje odpověď: ${esc((RSVP.find(x => x[0] === said.status) || [, said.status])[1])}` : "Zatím bez odpovědi a bez místa: otevři sestavu";
  return `<a class="cont evc" href="#/akce"><span class="big">Operace</span><span>${esc(fmtWhen(ev.starts_at))} · ${sideOf(ev.strategy_id, "mapa zatím nevybraná")} · ${esc(docName(ev.doctrine))}<small>${status}</small></span></a>${next}`;
}

// reading pages (map, doctrine) show the open event as a card into Akce, nothing when none is open
const evCard = () => state.me && state.event ? homeEvent() : "";
// specs/mapy-v2 (Petr 2026-10-22): the 3 maps; a map's page picks doctrine, team and zone variant, then shows the
// plan of that choice. Read-only: no open event changes it, roles are claimed in Akce.
const MAPS = () => [...new Set(D.strategies.map(x => x.map))];
const teamKey = x => x.id.slice(x.id.indexOf("-") + 1);  // "ozeti-modri" -> "modri"
const mapSlug = m => D.strategies.find(x => x.map === m).id.split("-")[0];
const mapOf = slug => MAPS().find(m => mapSlug(m) === slug);
const mapHref = (m, o = {}) => { const q = new URLSearchParams(Object.entries(o).filter(([, v]) => v)).toString(); return `#/mapy/${mapSlug(m)}${q ? "?" + q : ""}`; };
const planHref = (x, tab) => mapHref(x.map, { d: "fortress", t: teamKey(x), v: curVariant, tab: tab === "platno" ? null : tab });
const mapsList = () => `<ul class="cls maps">${MAPS().map(m => { const xs = D.strategies.filter(x => x.map === m);
  return `<li><a href="${mapHref(m)}"><b>${esc(m)}</b><span>${xs.length} týmy · ${xs[0].variants.length} varianty zóny</span></a></li>`; }).join("")}</ul>`;
function viewMapDetail(m, qs) {
  const q = new URLSearchParams(qs), d = ["fortress", "swarm"].includes(q.get("d")) ? q.get("d") : null;
  const xs = D.strategies.filter(x => x.map === m), x = d && xs.find(y => teamKey(y) === q.get("t")) || null;
  const v = x && x.variants.some(y => y.id === q.get("v")) ? q.get("v") : null;
  const tab = ["situace", "vetve"].includes(q.get("tab")) ? q.get("tab") : "platno";
  const step = (label, cur, opts) => `<div class="vbar mapstep" role="group" aria-label="${label}"><span class="vlbl">${label}</span>${opts.map(([val, name, sub, href]) =>
    `<a href="${href}"${val === cur ? ' aria-current="true"' : ""}><b>${esc(name)}</b>${sub ? `<small>${esc(sub)}</small>` : ""}</a>`).join("")}</div>`;
  const steps = step("Doktrína", d, [["fortress", docName("defence"), docOf("defence").short], ["swarm", docName("swarm"), docOf("swarm").short]]
      .map(([val, n, sub]) => [val, n, sub, mapHref(m, { d: val, t: x && teamKey(x), v })]))
    + (d ? step("Tým", x && teamKey(x), xs.map(y => [teamKey(y), y.color, y.faction, mapHref(m, { d, t: teamKey(y), v: y.variants.some(z => z.id === q.get("v")) ? q.get("v") : null })])) : "")
    + (x ? step("Varianta zóny", v, x.variants.map(y => [y.id, y.name, `${y.towers.length} věže${y.status === "NÁVRH" ? " · návrh" : ""}`, mapHref(m, { d, t: teamKey(x), v: y.id, tab: tab === "platno" ? null : tab })])) : "");
  const head = `<p class="crumb"><a href="#/mapy">Mapy</a> / ${esc(m)}</p>
    <header class="unit-head"><div><h1>${esc(m)}</h1><p>Vyber doktrínu, tým a variantu kontaktní zóny. Plán se ukáže podle tvých voleb.</p></div></header>${steps}`;
  if (!v) return head + `<p class="note mapnext">Dál vyber ${!d ? "doktrínu" : !x ? "tým" : "variantu zóny"}.</p>`;
  if (d === "swarm") return head + `${variantPanel(x)}<section class="block"><h2>${esc(docName("swarm"))} na této mapě</h2><p>${esc(D.doktrina.swarm.tagline)}</p>${bullets(D.doktrina.swarm.points)}
    <p class="note">${esc(docName("swarm"))} nemá plán pro jednotlivé mapy: zóna nahoře, postupy, role a nákup v <a href="#/doktrina/swarm">Doktríně</a>.</p></section>`;
  const tabs = [["platno", "Plátno"], ["situace", "Situace"], ["vetve", "Větve a spouštěče"]];
  return head + `<nav class="tabs" aria-label="Plán">${tabs.map(([k, l]) => `<a href="${mapHref(m, { d, t: teamKey(x), v, tab: k === "platno" ? null : k })}"${k === tab ? ' aria-current="page"' : ""}>${l}</a>`).join("")}</nav>
    ${x.status === "DRAFT" ? '<p class="note"><span class="tag draft">Draft</span> Plán zatím není vyhlášený za platný.</p>' : ""}
    ${tab === "situace" ? viewSituace(x) : tab === "vetve" ? viewVetve(x) : viewCanvas(x)}`;
}

function viewMapy() {
  return `<header class="unit-head"><div><h1>Mapy</h1><p>Plán každé mapy podle doktríny, týmu a varianty zóny. Jen ke čtení, na akci se zapisuješ v <a href="#/akce">Akci</a>.</p></div></header>
    <section class="block">${mapsList()}</section>`;
}

function viewHome() {
  const mine = me.get();
  let cont = "";
  if (mine) {
    const [sid, rid] = mine.split("/"), s = S(sid), r = s && roleOf(s, rid);
    if (r) cont = `<a class="cont" href="${roleHref(s, r)}"><span class="big">${esc(r.id)}</span><span>Pokračovat na tvou kartu<small>${esc(r.name)} · ${esc(sideLabel(s))}</small></span></a>`;
  }
  return `
    <div class="home-head"><img class="crest" src="znacka/kin-emblem.svg" alt="Emblém Kinetic Solutions" width="150" height="150"><h1>Central Command</h1>
      <p class="lede">Strategie Kinetic Solutions. Vyber si svou roli a uvidíš, co máš dělat v každé fázi. Na briefingu jedeme podle plátna.</p>
    </div>
    ${cont}
    <div id="home-ev">${homeEvent()}</div>
    <details class="block start howto"${matchMedia("(max-width: 720px)").matches ? "" : " open"}><summary><h2 id="h-start">Jak to tu funguje${arrow()}</h2></summary><ol class="proc">
      <li><span><b>Přihlas se přes Discord</b> (vpravo nahoře). Pustí tě to dál od role Rekrut na serveru Kinetic Solutions.</span></li>
      <li><span><a href="#/akce">Akce</a>: před akcí dej <b>Přijdu</b> a zaber si místo v <b>Sestavě</b>, ať hrajeme cokoli. Hned pod tím je tvůj nákup a odehrané akce po sezónách.</span></li>
      <li><span><a href="#/mapy">Mapy</a>: plán každé mapy podle doktríny, týmu a varianty zóny, s kartou každé role (co koupit, čím jedeš, co děláš v každé fázi).</span></li>
      <li><span><a href="#/vybava">Výbava</a>: tvůj loadout pro každou sub-classu: co koupit a kolik kusů, podle toho, co máš odemčené (WARDOGS Tracker). Kolik nás co umí, je v <a href="#/pokryti">Pokrytí</a>.</span></li>
      <li><span><a href="#/doktrina">Doktrína</a>: jak klan hraje (${esc(docName("defence"))}, ${esc(docName("swarm"))}) a Výcvik.</span></li>
    </ol></details>
    <section class="block" aria-labelledby="h-str"><h2 id="h-str">Mapy</h2>${mapsList()}</section>`;
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
    <div id="plan-body">${planMatrix}</div>`;
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

function kitCell(price, qty) { return price == null ? '<span class="dash">-</span>' : qty === "?" ? `${usd(price)} <span class="unk">× ?</span>` : usd(price * qty); }

function itemIcon(src, cls = "") {
  return src ? `<img class="item ${cls}" src="${esc(src)}" alt="" loading="lazy">` : `<span class="item none ${cls}" aria-hidden="true"></span>`;
}
function priceLine(price, qty) {
  if (price == null) return "";
  if (qty === "?") return `${usd(price)} / ks, počet <span class="unk">?</span>`;
  return qty > 1 ? `${usd(price)} / ks · celkem ${usd(price * qty)}` : usd(price);
}
// a plan's or a SWARM role's own item (vybava-zebricky v2, no MIN / IDEAL): its upgrade once I unlocked it, else the
// base item with the upgrade as the goal; an upgrade-only item shows when unlocked or free, else as a goal
const owned = n => !!(haveSet && haveSet.has(n));
function pickGear(g) {
  const up = g.ideal && g.ideal !== g.item ? g.ideal : null;
  if (up && (g.ideal_unlock ? owned(up) : !g.item)) return { name: up, icon: g.ideal_icon, qty: g.ideal_qty ?? g.qty, price: g.ideal_price, cost: g.ideal_cost, unlock: g.ideal_unlock };
  if (!g.item) return { goal: up, icon: g.ideal_icon, price: g.ideal_price, unlock: g.ideal_unlock };
  return { name: g.item, icon: g.icon, qty: g.qty, qmax: !up && g.ideal_qty > g.qty ? g.ideal_qty : null, price: g.price, cost: g.cost,
    unlock: g.unlock, goal: up && g.ideal_unlock ? up : null };
}
const extrasCost = (r, skip) => r.gear.map(pickGear).filter(p => p.name && !(skip && skip.has(p.name))).reduce((a, p) => a + (p.cost || 0), 0);
function shopList(s, r, skip = null) {
  const picks = r.gear.map(g => [g, pickGear(g)]).filter(([, p]) => !(p.name && skip && skip.has(p.name)));
  if (!picks.length) return `<p class="note" style="margin-top:0">${r.class ? "Nic navíc." : "Nic předepsaného."}</p>`;
  const part = picks.some(([, p]) => p.name && p.qty === "?") ? ' <span class="unk">+ ?</span>' : "";
  const tiles = picks.map(([g, p]) => p.name ? `<li class="tile">${itemIcon(p.icon)}<div class="tx">
      <div class="nm"><span class="qty">${p.qty === "?" ? '<span class="unk">?</span>' : p.qmax ? `${p.qty}–${p.qmax}×` : p.qty + "×"}</span><span>${esc(p.name)}</span></div>
      <div class="pr">${priceLine(p.price, p.qty)}${p.unlock && !owned(p.name) ? ` · odemknout <b>${unlockText(p.unlock)}</b>` : ""}</div>
      ${g.note ? `<div class="nt">${esc(g.note)}</div>` : ""}${p.goal ? `<div class="alt">${itemIcon(g.ideal_icon, "sm")}<span>Až odemkneš: <b>${esc(p.goal)}</b> · ${unlockText(g.ideal_unlock)}</span></div>` : ""}</div></li>`
    : `<li class="tile opt">${itemIcon(p.icon)}<div class="tx"><div class="nm"><span>${esc(p.goal)}</span></div>
      <div class="pr">Volitelně, až odemkneš <b>${unlockText(p.unlock)}</b> · ${usd(p.price)}</div>${g.note ? `<div class="nt">${esc(g.note)}</div>` : ""}</div></li>`).join("");
  return `<div class="shop-sum"><span>${r.sum || (r.class ? "Navíc za život" : "Celkem za život")}</span><b>${usd(extrasCost(r, skip))}${part}</b></div>
    <ul class="shop">${tiles}</ul>`;
}

// my loadout of a sub-class (vybava-zebricky v2, Petr 2026-10-22): the best ladder step I unlocked in every slot; my
// primary brings its best unlocked magazine and the rounds of its calibre (AP once unlocked, if the clan's Munice ladder
// goes there); the card shows it like the game does, the ladders below show what I have vs what I should have
const MAGS = 3;  // ponytail: spare magazines per primary as the S1 screenshots had them; per class when Petr wants
const mineIdx = lad => lad.steps.map(st => !st.unlock || owned(st.item)).lastIndexOf(true);
const pieceCost = (x, qty) => x.price == null ? 0 : Math.round(x.price * qty / (x.per || 1));
// the Munice ladder of a class follows my primary: same counts and reasons, rounds of my weapon's calibre
function municeFor(lad, gun) {
  return gun && gun.ammo && gun.ammo.length ? { ...lad, steps: lad.steps.slice(0, gun.ammo.length).map((st, i) => ({ ...st, ...gun.ammo[i], qty: st.qty, cost: pieceCost(gun.ammo[i], st.qty) })) } : lad;
}
function myKit(c) {
  const lads = c.ladders || [], pick = lad => lad && lad.steps[mineIdx(lad)];
  const slots = Object.fromEntries(Object.keys(SLOT_LABEL).map(k => [k, pick(lads.find(l => l.slot === k))]));
  const gun = slots.slot1, store = [];
  const mag = gun && gun.mags && gun.mags[gun.mags.map(m => !m.unlock || owned(m.item)).lastIndexOf(true)];
  if (mag) store.push({ ...mag, qty: MAGS, cost: pieceCost(mag, MAGS) });
  for (const lad of lads.filter(l => l.slot === "storage")) {
    const st = pick(lad.group === "Munice" ? municeFor(lad, gun) : lad);
    if (st) store.push(st);
  }
  const all = [...Object.values(slots).filter(Boolean), ...store];
  return { slots, store, names: new Set(all.map(x => x.item)), cost: all.reduce((a, x) => a + (x.cost || 0), 0) };
}
const loadoutCost = c => myKit(c).cost;
function loadoutCard(q, c, h = "h2") {
  const k = myKit(c), cell = key => { const st = k.slots[key];
    return `<div class="slot${st ? "" : " empty"}"><span class="sl">${SLOT_LABEL[key]}</span>${st ? `${itemIcon(st.icon)}<span class="sn">${esc(st.item)}</span>${st.cost ? `<span class="pr">${usd(st.cost)}</span>` : ""}` : key === "slot2" ? '<span class="ph">Sidearm</span>' : ""}</div>`; };
  const quick = c.quick.filter(n => k.names.has(n));
  return `<article class="loadout" id="${esc(c.id)}">
    <header class="lo-head"><div><${h} class="lo-name"><a href="${classHref(q, c)}">${esc(c.name)}</a></${h}><p>${esc(c.job)}</p>
      <p class="src">${trk && trk.status === "ok" ? "Co koupit: nejlepší z toho, co máš odemčené a klan doporučuje." : "Startovní loadout. Propoj WARDOGS Tracker ve <a href=\"#/vybava\">Výbavě</a> a uvidíš svůj."}</p></div></header>
    <div class="lo-grid">
      <div><h3>Equipment</h3>${["slot1", "slot2", "slot3"].map(cell).join("")}
        <h3>Gear</h3><div class="lo-gear">${["helmet", "armor", "vest"].map(cell).join("")}</div></div>
      <div><h3>Storage</h3><div class="lo-gear">${["backpack", "traversal"].map(cell).join("")}</div>
        <h3>V batohu</h3>${k.store.length ? `<ul class="lo-store">${k.store.map(x => `<li>${itemIcon(x.icon, "sm")}<span class="q">${x.qty}${x.cost ? `<span class="pr">${usd(x.cost)}</span>` : ""}</span><span class="n">${esc(x.item)}</span></li>`).join("")}</ul>` : '<p class="note">Nic.</p>'}
        ${quick.length ? `<h3>Rychlé sloty</h3><ol class="lo-quick">${quick.map((n, i) => `<li><span class="kb">${(i + 4) % 10}</span>${esc(n)}</li>`).join("")}</ol>` : ""}</div>
    </div>
    <footer class="lo-sum"><span>Za život</span><b>${usd(k.cost)}</b></footer></article>`;
}

function roleBlock(s, r) {
  const part = r.gear.some(g => g.qty === "?") ? ' <span class="unk">+ ?</span>' : "", [, cc] = classById(r.class);
  const strip = r.gear.map(pickGear).map(p => `<li${p.name ? "" : ' class="opt"'}>${itemIcon(p.icon)}<span class="q">${p.name ? (p.qty === "?" ? "?" : p.qty + "×") : ""}</span><span class="n">${esc(p.name || p.goal)}${p.name ? "" : " (až odemkneš)"}</span></li>`).join("");
  return `<article class="rb"><header><a class="rid big" href="${roleHref(s, r)}">${esc(r.id)}</a>
    <div class="rb-t"><a class="rn" href="${roleHref(s, r)}">${esc(r.name)}</a><p>${esc(r.transport)}</p>${r.class ? (([cq, cc]) => `<p><a class="ref" href="${classHref(cq, cc)}">${esc(cc.name)}</a></p>`)(classById(r.class)) : ""}</div>
    <div class="rb-sum">${usd((cc ? loadoutCost(cc) : 0) + extrasCost(r))}${part}</div></header>
    ${strip ? `<ul class="strip">${strip}</ul>` : `<p class="note">${r.class ? "Jen sestava sub-classy." : "Nic předepsaného."}</p>`}</article>`;
}

function viewRole(s, r) {
  const g = groupOf(s, r.group);
  const sib = s.roles.filter(x => x.group === r.group), i = sib.indexOf(r);
  const prev = sib[i - 1], next = sib[i + 1];
  const builds = r.builds.length ? `<section class="block"><h2>Stavba báze (tvoje položky tučně)</h2>${budgetBlock(s, r.group, r.id)}</section>` : "";
  return `
    <div class="narrow"><p class="crumb"><a href="${planHref(s)}">${esc(sideLabel(s))}</a> / <a href="#/s/${s.id}/squad/${g.id}">${esc(g.name)}</a> / ${esc(r.id)}</p>
    <header class="role-head"><span class="code">${esc(r.id)}</span>
      <div class="grow"><h1>${esc(r.name)}</h1><p>${esc(r.squad)} · ${esc(g.name)}</p></div></header>
    ${variantBar(s)}
    <section class="block"><h2>Doprava</h2><p class="transport">${esc(r.transport)}</p></section>
    ${(() => { const [, cc] = classById(r.class), part = r.gear.some(g => g.qty === "?") ? ' <span class="unk">+ ?</span>' : "";
      return `<section class="block"><h2>Nákup na spawnu</h2>${cc ? `<div class="shop-sum"><span>Celkem za život</span><b>${usd(loadoutCost(cc) + extrasCost(r))}${part}</b></div>
        <p class="note" style="margin:0 0 4px">Tvůj loadout sub-classy (platí na všech mapách) + co role potřebuje na téhle mapě.</p>
        ${loadoutCard(...classById(cc.id))}<h2 class="block">Navíc pro tuto roli</h2>` : ""}${shopList(s, r)}<p class="gnote">${esc(s.gear_note)}</p></section>`; })()}
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
    <p class="crumb"><a href="${planHref(s)}">${esc(sideLabel(s))}</a> / ${esc(g.name)}</p>
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

// SWARM kits: the base once, each role only what it buys on top (Viktor #002); in Doktrina all, in Akce mine
const kitBase = (s, skip) => `<div class="sq" id="kit-base"><h3>Základ SWARM pro všechny</h3><p>Kupuje každý, ať hraje cokoliv. U role je jen to, co se kupuje navíc. Zbraň, brnění, munici a léčení bereš z loadoutu sub-classy své role (ve <a href="#/vybava">Výbavě</a>)${skip ? "; co už v loadoutu máš, tu znovu není" : ""}.</p>${shopList(null, { gear: s.base.gear, sum: "Základ za život" }, skip)}</div>`;
const kitRole = (r, skip) => `<div class="sq" id="kit-${esc(r.id)}"><h3>${esc(r.name)} <small>${esc(r.count)}</small></h3><p>${esc(r.goal)}</p>${r.class ? (([q, c]) => `<p class="note">Loadout: <a href="${classHref(q, c)}">${esc(c.name)}</a></p>`)(classById(r.class)) : ""}${shopList(null, { gear: r.extra, class: true }, skip)}</div>`;

// the SWARM tab (Petr 2026-10-18): how the swarm plays and what each role buys; signing up is in Akce since 2026-10-19
function viewSwarm(k) {
  const s = k.swarm;
  return `
    <section class="block" id="swarm-kit"><h2>Role a nákup</h2>${kitBase(s)}${s.slots.map(r => kitRole(r)).join("")}</section>
    <section class="block" id="swarm"><div class="t-row"><h2>Jádro</h2><span class="tag draft" title="Jádro je Commanderovo, podrobnosti navrhl štáb a potvrdí Commander">Návrh</span></div><p>${esc(s.tagline)}</p>${bullets(s.points)}</section>
    <section class="block"><h2>Principy</h2>${procList(s.principles)}</section>
    <section class="block"><h2>Velení a komunikace</h2>${bullets(s.command)}</section>
    <section class="block"><h2>Postupy</h2>${s.procedure.map(x => `<div class="sq"><h3>${esc(x.title)}</h3>${procList(x.steps)}</div>`).join("")}</section>
    <section class="block"><h2>Protokoly: když se stane, reaguj</h2>${docRx(s.protocol)}</section>
    <section class="block"><h2>Výbava podle odemčení (Season 2)</h2>${bullets(s.kit)}</section>
    <section class="block"><h2>Podle počtu lidí</h2><table class="data"><thead><tr>${s.sizes.cols.map(c => c ? `<th>${esc(c)}</th>` : "<td></td>").join("")}</tr></thead><tbody>
      ${s.sizes.rows.map(r => `<tr>${r.map((c, i) => i ? `<td>${esc(c)}</td>` : `<td><b>${esc(c)}</b></td>`).join("")}</tr>`).join("")}</tbody></table></section>`;
}

function viewDoktrina(tab) {
  const k = D.doktrina, cur = ["swarm", "vycvik"].includes(tab) ? tab : "";
  const tabs = [["", k.defence.title], ["swarm", k.swarm.title], ["vycvik", "Výcvik"]];
  const compare = `<section class="block"><h2>Dvě doktríny</h2><table class="data"><thead><tr><td></td><th>${esc(k.defence.title)}</th><th>${esc(k.swarm.title)}</th></tr></thead><tbody>
      ${k.compare.map(r => `<tr><td><b>${esc(r.aspect)}</b></td><td>${esc(r.defence)}</td><td>${esc(r.swarm)}</td></tr>`).join("")}</tbody></table></section>`;
  return `
    <div class="narrow">
    <header class="unit-head"><div><h1>Doktrína</h1><p>Platí pro všechny mapy a barvy. Kterou hrajeme, rozhodne Commander před zápasem.</p></div></header>
    <nav class="tabs" aria-label="Doktrína">${tabs.map(([path, label]) => `<a href="#/doktrina${path && "/" + path}"${path === cur ? ' aria-current="page"' : ""}>${esc(label)}</a>`).join("")}</nav>
    <div id="ev-card">${evCard()}</div>
    ${cur === "swarm" ? viewSwarm(k) + compare : cur === "vycvik" ? viewVycvik() : viewDefence(k) + compare}
    </div>`;
}

// ---------- squads + loadouts ----------
const SLOT_LABEL = { slot1: "[1]", slot2: "[2]", slot3: "[3]", helmet: "Helmet", armor: "Armor", vest: "Tac-Vest", backpack: "Backpack", traversal: "Traversal" };

// ---- "co mám odemčeno": per member and season; a wipe starts a new season with an empty list ----
const currentSeason = () => seasonOf(new Date().toISOString());
let haveSet = null;      // items I ticked in haveSeason; null = logged out / not loaded
let haveSeason = null;
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
  const a = document.activeElement, k = a && ["data-tracker", "data-rsvp", "data-trsvp", "data-swarm", "data-support"].find(x => a.hasAttribute(x));
  const sel = k && `[${k}="${CSS.escape(a.getAttribute(k))}"]`, i = sel ? [...document.querySelectorAll(sel)].indexOf(a) : -1;
  fn();
  if (sel) document.querySelectorAll(sel)[i]?.focus({ preventScroll: true });
}
const rerenderKeep = () => { const restore = keepForms(); keepFocus(() => { const y = scrollY; render(); scrollTo(0, y); }); restore(); };
// ---------- WARDOGS Tracker (hub/specs/vybava-zebricky v2, migration 015) ----------
// The database syncs every member from wardogstracker.gg every few minutes and keeps the last result (Petr 2026-10-22:
// no "mam" ticks). The page reads my row, asks for a fresh sync when it is older than 10 minutes (the database allows one
// a minute) and links my Tracker profile when the Tracker does not find me by Discord (that lookup is opt-in there).
const TRACKS = ["WARDOG", "Assault", "Medic", "Support", "Recon", "Driver", "Pilot"];
const TRK_LINK = '<a href="https://wardogstracker.gg" target="_blank" rel="noopener">WARDOGS Tracker</a>';
const TRK_SYNC = "https://wardogstracker.gg/api/wardogs/connect?redirect=/";
let trk = null, trkBusy = false, trkErr = null;  // trk = my row of public.tracker
async function loadTracker() {
  const uid = state.me && state.me.user_id;
  if (!sb || !uid) { trk = null; return; }
  const { data, error } = await sb.from("tracker").select("steam_id, levels, synced_at, fetched_at, status").eq("user_id", uid).maybeSingle();
  if (error) throw error;
  if (state.me && state.me.user_id === uid) trk = data;
}
async function syncTracker(profile) {
  if (trkBusy) return;
  trkBusy = true; trkErr = null; rerenderKeep();
  const { error } = profile ? await sb.rpc("tracker_link", { profile }) : await sb.rpc("tracker_sync_me");
  if (error) { console.error(error); trkErr = "Synchronizace se teď nepovedla, zkusíme to za pár minut sami."; }
  await Promise.all([loadTracker(), loadUnlocks()]).catch(e => console.error(e));
  trkBusy = false; rerenderKeep();
}
function autoSyncTracker() {
  if (!state.me || trkBusy || (trk && trk.status === "not_found")) return;  // not found by Discord: the cron retries daily
  if (!trk || !trk.fetched_at || Date.now() - new Date(trk.fetched_at) > 10 * 60e3) syncTracker().catch(e => console.error(e));
}
const ago = iso => { const m = Math.round((Date.now() - new Date(iso)) / 60e3); return m < 1 ? "právě teď" : m < 90 ? `před ${m} min` : fmtWhen(iso); };
function trackerSays(r) {
  const profile = r.steam_id ? `<a href="https://wardogstracker.gg/profile/${esc(r.steam_id)}" target="_blank" rel="noopener">svém profilu</a>` : "profilu";
  return {
    not_synced: `Na Trackeru ještě nemáš synchronizované statistiky. Na ${profile} klikni na Update my stats.`,
    old_season: `Data na Trackeru jsou z minulé sezóny. Na ${profile} klikni na Update my stats.`,
    hidden: "Tracker odemčené předměty neukázal. Nemáš je v nastavení profilu skryté?",
    limited: "Tracker teď nebere další dotazy, zkusíme to za pár minut sami.",
    error: "Tracker teď neodpovídá, zkusíme to za pár minut sami.",
  }[r.status] || "";
}
function trackerBox() {
  if (!state.me || !haveSet) return "";
  const r = trk || {}, lv = r.levels ? TRACKS.filter(n => n in r.levels).map(n => [n, Number(r.levels[n]) || 0]) : [];
  const says = trkErr ? esc(trkErr) : trackerSays(r);
  return `<div class="trk"><button type="button" class="act" data-tracker${trkBusy ? " disabled" : ""}>${trkBusy ? "Synchronizuji…" : "Synchronizovat teď"}</button>
    <p class="note">Co máš ve hře odemčené a levely rolí bere Central Command z ${TRK_LINK} (neoficiální web komunity) sám, každých pár minut.${r.fetched_at ? ` Naposledy ${esc(ago(r.fetched_at))}.` : ""} Když si něco odemkneš, klikni na Trackeru na Update my stats.</p>
    ${lv.length ? `<p class="trk-lv">${lv.map(([n, l]) => `<span>${n} <b>${l}</b></span>`).join("")}${r.synced_at ? `<span class="ref">na Trackeru ${esc(fmtWhen(r.synced_at))}</span>` : ""}</p>` : ""}
    ${says ? `<p class="need err">${says}</p>` : ""}
    ${r.steam_id ? "" : `<div class="trk-help"><p><b>Propoj svůj profil na Trackeru</b> (stačí jednou)${r.status === "not_found" ? ", podle Discordu tě Tracker nenašel" : ""}:</p><ol>
      <li><a href="${TRK_SYNC}" target="_blank" rel="noopener">Přihlas se na Trackeru přes Steam a synchronizuj statistiky</a> (asi 10 s).</li>
      <li>Otevři na Trackeru svůj profil a zkopíruj adresu stránky (tvar wardogstracker.gg/profile/7656…).</li>
      <li>Vlož ji sem a potvrď:</li></ol>
      <form class="trk-form" data-trkform><input name="profile" inputmode="url" autocomplete="off" placeholder="https://wardogstracker.gg/profile/7656…" aria-label="Odkaz na tvůj profil na WARDOGS Trackeru"><button type="submit" class="act">Propojit</button></form>
      <p class="note">Pak už se všechno synchronizuje samo.</p></div>`}</div>`;
}
document.addEventListener("submit", e => {
  const f = e.target.closest("form[data-trkform]");
  if (!f) return;
  e.preventDefault();
  const profile = f.elements.profile.value.trim();
  if (!/7656\d{13}/.test(profile)) { trkErr = "Tohle není odkaz na profil na Trackeru (v adrese je 17místné číslo začínající 7656)."; rerenderKeep(); return; }
  syncTracker(profile).catch(err => console.error(err));
});

function viewSquads() {
  return `<header class="unit-head"><div><h1>Výbava</h1><p>Tvůj loadout pro každou sub-class, podle toho, co máš odemčené</p></div></header>
    <p class="note">Každá sub-class ukazuje tvůj loadout podle toho, co máš ve hře odemčené. Kolik nás co má: <a class="act" href="#/pokryti">Pokrytí rolí</a></p>
    ${trackerBox()}
    ${D.squads.map(q => `<section class="block"><h2><a href="#/squad/${q.id}">${esc(q.name)}</a></h2><p class="goal">${esc(q.goal)}</p>
      <ul class="cls">${q.classes.map(c => `<li><a href="${classHref(q, c)}"><b>${esc(c.name)}</b></a></li>`).join("")}</ul></section>`).join("")}`;
}
function viewSquadPage(q) {
  return `<p class="crumb"><a href="#/vybava">Výbava</a> / ${esc(q.name)}</p>
    <header class="unit-head">${sym(q.symbol, "lg")}<div><h1>${esc(q.name)}</h1><p>${q.classes.length} sub-class · platí pro všechny mapy</p></div></header>
    <p class="goal">${esc(q.goal)}</p><ul class="bullets block" style="margin-top:16px">${q.points.map(x => `<li>${esc(x)}</li>`).join("")}</ul>
    ${q.classes.map(c => loadoutCard(q, c)).join("")}`;
}
// ---------- ladders (hub/specs/vybava-zebricky): best step per level range, mine and the next one ----------
const SRC = { A: "A", B: "B", C: "C", ODVOZENO: "odvozeno" };
// mine = the best step I really unlocked (or that needs no unlock); "Odemkni" = my level is there, the purchase is not;
// "Další" = the first step my level does not reach yet
function ladderBlock(lad, lv) {
  const have = lad.steps.map(st => !st.unlock || !!(haveSet && haveSet.has(st.item)));
  const reach = lad.steps.map(st => !st.unlock || !!(lv && (lv[st.unlock.track] || 0) >= st.unlock.level));
  const mine = have.lastIndexOf(true), next = reach.indexOf(false, mine + 1);
  const nu = next >= 0 && lad.steps[next].unlock;
  return `<div class="lad"><div class="lad-h"><span class="sl">${lad.group ? esc(lad.group) : SLOT_LABEL[lad.slot]}</span>${nu ? `<span class="lad-next">Další: od ${esc(nu.track)} ${nu.level}</span>` : ""}</div>
    <ol class="lad-steps">${lad.steps.map((st, i) => { const can = i > mine && reach[i] && !have[i];
      return `<li class="st${i === mine ? " mine" : ""}${can ? " can" : ""}${i === next ? " next" : ""}${i > mine && !reach[i] ? " locked" : ""}">
      ${itemIcon(st.icon)}<span class="st-n">${esc(st.item)}</span><span class="st-u">${st.unlock ? `${esc(st.unlock.track)} ${st.unlock.level} · ${usd(st.unlock.cash)}` : "hned"}</span>
      <span class="st-src" title="Síla zdroje · počet zdrojů">${SRC[st.source]} · ${st.n}</span>${i === mine ? '<span class="st-tag">Tvůj</span>' : can ? `<span class="st-tag can" title="Máš level, chybí odemknout za ${usd(st.unlock.cash)}">Odemkni</span>` : ""}</li>`; }).join("")}</ol>
    <details class="lad-why"><summary>Proč</summary><dl>${lad.steps.map(st => `<dt>${esc(st.item)}</dt><dd>${esc(st.why)}</dd>`).join("")}</dl>${lad.note ? `<p class="note">${esc(lad.note)}</p>` : ""}</details></div>`;
}
function ladderSection(c) {
  if (!c.ladders || !c.ladders.length) return "";
  const lv = trk && trk.levels || null;
  return `<section class="block lads-sec"><h2>Co máš a co máš mít</h2>
    <p class="note">Co klan doporučuje, od startu po cíl (meta Season 2, rešerše 22. 10.). <b>Tvůj</b> = nejlepší, co máš odemčené. <b>Odemkni</b> = level máš, chybí koupit. <b>Další</b> = kam míříš.${lv ? "" : ` Propoj WARDOGS Tracker ve <a href="#/vybava">Výbavě</a> a uvidíš, co máš.`} Zdroj: A data nebo oficiální, B víc hráčů, C jeden zdroj; číslo = kolik zdrojů.</p>
    <div class="lads">${c.ladders.map(lad => ladderBlock(lad.group === "Munice" ? municeFor(lad, myKit(c).slots.slot1) : lad, lv)).join("")}</div></section>`;
}

function viewClass(q, c) {
  const uses = D.strategies.map(s => [s, s.roles.filter(r => r.class === c.id)]).filter(([, rs]) => rs.length);
  return `<p class="crumb"><a href="#/vybava">Výbava</a> / <a href="#/squad/${q.id}">${esc(q.name)}</a> / ${esc(c.name)}</p>
    ${loadoutCard(q, c, "h1")}${ladderSection(c)}
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
  return `<p class="lede">Pěchotní taktika pro všechny mapy.</p>
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
// specs/akce-mapa-tym: the team as in the game, official name and colour; no logo (EULA 5.2(j), knowledge/tymy-s2.md)
const teamOf = id => D.tymy.find(t => t.id === id);
const teamBadge = id => { const t = teamOf(id); return t ? `<span class="team" style="--tc:${esc(t.hex)}">${esc(t.name)}</span>` : ""; };
// an event's map and team as HTML; null = not picked yet, an id we do not know is shown as stored
const sideOf = (id, none = "mapa neuvedena") => { if (!id) return none; const s = S(id); return s ? `${esc(s.map)} ${teamBadge(s.team)}` : esc(id); };
// map and team -> their plan; null while either is "zatím nevím" (one strategy_id field, decision 1)
const compose = (map, team) => D.strategies.find(s => s.map === map && s.team === team) || null;
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
        .eq("status", "closed").eq("kind", "operace").order("starts_at", { ascending: false });  // a closed training is no played event
      if (error) throw error;
      html = viewHistory(data);
    } else if (p[0] === "akce") {
      const id = Number(p[1]);  // #/akce/abc: not an id, so "Akce neexistuje" instead of a database error (Viktor UAT #011)
      const { data: ev, error } = Number.isSafeInteger(id) && id > 0
        ? await sb.from("events").select("id, strategy_id, doctrine, starts_at, status, variant, placement, note, went_well, went_wrong, next_time").eq("id", id).eq("kind", "operace").neq("status", "cancelled").maybeSingle()
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

// coverage: who has which unlock this season, and how many of us reached each sub-class's goal
// the ladder that tells a sub-class apart: its weapon, or slot [3] when the weapon ladder is just the start rifle
const keyLadder = c => { const w = c.ladders.find(l => l.slot === "slot1"); return w && w.steps.length > 1 ? w : c.ladders.find(l => l.slot === "slot3") || w || c.ladders[0]; };
function viewCoverage(season, members) {
  const head = `<p class="crumb"><a href="#/vybava">Výbava</a> / Pokrytí</p>
    <header class="unit-head"><div><h1>Pokrytí rolí</h1><p>${esc(season ? season.name : "Žádná sezóna")} · podle WARDOGS Trackeru</p></div></header>`;
  // item names come from members' rows: a null-prototype map, so "constructor" or "__proto__" cannot break it
  const byItem = Object.create(null), users = [];
  for (const m of members) {
    const have = new Set(m.unlocks.map(u => u.item));
    users.push(have);
    for (const n of have) (byItem[n] = byItem[n] || []).push(m);
  }
  const items = [];
  for (const q of D.squads) for (const c of q.classes) for (const lad of c.ladders) for (const st of lad.steps) if (st.unlock && !items.includes(st.item)) items.push(st.item);
  // vehicles and other extras the plans add to roles (MH-6, Lakota, Ural, Verba) need unlocks too
  for (const s of D.strategies) for (const r of s.roles) for (const g of r.gear) {
    if (g.item && g.unlock && !items.includes(g.item)) items.push(g.item);
    if (g.ideal && g.ideal_unlock && !items.includes(g.ideal)) items.push(g.ideal);
  }
  return `${head}
    <p class="note">Členů s daty: <b>${users.length}</b>. Kdo nemá propojený ${TRK_LINK}, v počtech chybí (propojení je ve <a href="#/vybava">Výbavě</a>).</p>
    <section class="block"><h2>Sub-classy</h2><p class="note">Cíl hlavního žebříčku sub-classy (zbraň, u rolí s jedinou zbraní slot [3]) a kolik z nás ho má.</p><table class="data cov"><thead><tr><th>Sub-class</th><th>Cíl</th><th class="num">Mají</th></tr></thead><tbody>
    ${D.squads.map(q => q.classes.map(c => { const top = keyLadder(c).steps.at(-1);
      return `<tr><td><a href="${classHref(q, c)}">${esc(q.name)} · ${esc(c.name)}</a></td><td>${esc(top.item)}</td><td class="num"><b>${top.unlock ? users.filter(h => h.has(top.item)).length : users.length}</b></td></tr>`; }).join("")).join("")}
    </tbody></table></section>
    <section class="block"><h2>Kdo má odemčeno</h2><p class="note">Předměty, které se musí ve hře odemknout, a kdo z nás je už má (podle WARDOGS Trackeru).</p><table class="data cov"><thead><tr><th>Předmět</th><th class="num">Mají</th><th>Kdo</th></tr></thead><tbody>
    ${items.map(n => { const ms = byItem[n] || []; return `<tr><td>${esc(n)}</td><td class="num"><b>${ms.length}</b></td><td>${ms.map(memberLink).join(" ")}</td></tr>`; }).join("")}
    </tbody></table></section>`;
}

function viewHistory(evs) {
  // part of Akce since 2026-10-19 (rozhodnuti 8): the open event above, played ones below by season
  const head = `<h2 class="hist-h">Odehrané akce</h2>`;
  if (!evs.length) return `${head}<p class="note">Zatím žádná uzavřená akce. Commander ji uzavře nahoře v Sestavě po zápase.</p>`;
  return head + bySeason(evs, e => e.starts_at).map(({ s, rows }) => `<section class="block"><h2>${esc(seasonName(s))}</h2>
    <table class="data hist"><thead><tr><th>Datum</th><th>Mapa</th><th>Zóna</th><th class="num">Umístění</th><th class="num">Zapsáno</th></tr></thead><tbody>
    ${rows.map(e => `<tr><td><a href="#/akce/${e.id}">${esc(fmtWhen(e.starts_at))}</a></td><td>${sideOf(e.strategy_id)} · ${esc(docName(e.doctrine))}</td><td>${esc(variantName(e.strategy_id, e.variant))}</td><td class="num"><b>${place(e.placement)}</b></td><td class="num">${e.claims[0] ? e.claims[0].count : 0}</td></tr>`).join("")}
    </tbody></table></section>`).join("");
}

function viewEvent(ev, claims, absent = new Set()) {
  // slot_label was stored at sign-up ("Skupina · Role"), so renamed roles keep their old name here
  const groups = {};
  for (const c of claims) { const [g, ...rest] = c.slot_label.split(" · "); (groups[g] = groups[g] || []).push({ role: rest.join(" · ") || g, m: c.members, away: absent.has(c.user_id) }); }
  const played = claims.length - claims.filter(c => absent.has(c.user_id)).length;
  const debrief = [["Co fungovalo", ev.went_well], ["Co ne", ev.went_wrong], ["Co příště jinak", ev.next_time]].filter(([, t]) => t);
  return `<p class="crumb"><a href="#/akce">Akce</a> / ${esc(fmtWhen(ev.starts_at))}</p>
    <header class="unit-head"><div><h1>${sideOf(ev.strategy_id)} · ${esc(docName(ev.doctrine))}</h1><p>${esc(fmtWhen(ev.starts_at))} · ${esc(seasonName(seasonOf(ev.starts_at)))}${ev.status === "open" ? " · probíhá" : ""}</p></div></header>
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
  if (!have.size) return `<section class="block"><h2>Odemčeno · ${esc(season.name)}</h2><p class="note">Zatím žádná data z WARDOGS Trackeru.${own ? ' Propoj ho ve <a href="#/vybava">Výbavě</a>.' : ""}</p></section>`;
  // the best step of each sub-class's key ladder this player unlocked (vybava-zebricky v2: everyone can play every class)
  const rows = D.squads.flatMap(q => q.classes.map(c => { const lad = keyLadder(c), i = lad.steps.map(st => !st.unlock || have.has(st.item)).lastIndexOf(true);
    return { q, c, st: lad.steps[i], top: i === lad.steps.length - 1 }; })).filter(x => x.st);
  return `<section class="block"><h2>Odemčeno · ${esc(season.name)}</h2>
    <p class="lede">Odemčeno <b>${have.size}</b> předmětů z klanového seznamu · u ${rows.filter(x => x.top).length} z ${D.squads.reduce((a, q) => a + q.classes.length, 0)} sub-class má cíl hlavního žebříčku</p>
    <ul class="cls">${rows.map(x => `<li><a href="${classHref(x.q, x.c)}"><b>${esc(x.c.name)}</b><span>${esc(x.st.item)}${x.top ? " · cíl" : ""}</span></a></li>`).join("")}</ul></section>`;
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
  return `<p class="crumb"><a href="#/akce">Akce</a> / ${esc(m.name)}</p>
    <header class="unit-head"><img class="pavatar" src="${esc(m.avatar_url)}" alt=""><div><h1>${esc(m.name)}</h1><p>Člen KIN</p></div></header>
    <section class="block"><h2>Celkem</h2>${stats(rows)}</section>
    ${unlockSection(m, season, have)}
    ${bySeason(sorted, r => r.events.starts_at).map(({ s, rows: xs }) => `<section class="block"><h2>${esc(seasonName(s))}</h2>${stats(xs)}
      <p class="note">${xs.map(r => `<a href="#/akce/${r.events.id}">${esc(fmtWhen(r.events.starts_at))}</a>`).join(" · ")}</p></section>`).join("")}`;
}

// ---------- shell ----------
// one item per question a member asks (Petr 2026-10-19, specs/akce-flow rozhodnuti 8)
const NAV = [["akce", "Akce"], ["mapy", "Mapy"], ["vybava", "Výbava"], ["doktrina", "Doktrína"]];
function renderNav(active) {
  navActive = active;
  const mine = me.get(), [msid, mrid] = (mine || "/").split("/"), ms = S(msid), mr = ms && roleOf(ms, mrid);
  // "Moje role" first and current on my own card: a phone shows ~136 px of the sideways nav (Viktor UAT #005)
  const onMine = mr && location.hash === roleHref(ms, mr);
  document.getElementById("nav").innerHTML =
    (mr ? `<a class="mine" href="${roleHref(ms, mr)}"${onMine ? ' aria-current="page"' : ""}>Moje role<b>${esc(mr.id)}</b></a>` : "") +
    NAV.map(([k, l]) => `<a href="#/${k}"${!onMine && active === k ? ' aria-current="page"' : ""}>${l}</a>`).join("");
  navToCurrent();
}

function viewAkce() {
  return `<header class="unit-head"><div><h1>Akce</h1><p>Tady se na akci zapisuješ a vidíš svůj nákup. Mapy a Doktrína jsou ke čtení.</p></div></header>
    <section class="sestava" id="sestava">${akceBody()}</section>
    ${histShell(sb && state.me ? '<p class="note">Načítám odehrané akce…</p>' : "")}`;
}
// the Commander's briefing protocol (Petr 2026-10-21 "uvidim to jenom ja"): the row 'velitel' is readable by the
// Commander only (014), so a member gets no data, not just no link; the HTML is built from klan/briefing-protokol.md
async function loadBriefing() {
  const { data, error } = await sb.from("content").select("data").eq("id", "velitel").maybeSingle();
  if (location.hash !== "#/briefing") return;
  $app.innerHTML = `<p class="crumb"><a href="#/akce">Akce</a> / Briefing</p>` + (error ? (console.error(error), '<p class="err">Protokol se nenačetl, obnov stránku (F5).</p>')
    : data && data.data && data.data.briefing ? `<article class="proto">${data.data.briefing}</article>`
    : '<p class="note">Protokol briefingu je jen pro Commandera.</p>');
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
  if (p[0] === "historie") { location.replace("#/akce"); return; }  // links in Discord debrief threads
  let html, active = null, title = "KIN Central Command";
  cur = null; trace = null; plan = null;
  if (p[0] === "s" && S(p[1])) {
    const s = S(p[1]); cur = s; active = "mapy"; curVariant = pickVariant(s, qs);
    const r = p[2] === "role" && roleOf(s, p[3]), g = p[2] === "squad" && groupOf(s, p[3]);
    if (r) { html = viewRole(s, r); title = `${r.id} ${r.name} · KIN`; }
    else if (g) { html = viewSquad(s, g); title = `${g.name} · KIN`; }
    else { location.replace(planHref(s, ["situace", "vetve"].includes(p[2]) ? p[2] : "platno")); return; }  // M6: Discord and briefing links
  } else if (p[0] === "mapy" && mapOf(p[1])) {
    const m = mapOf(p[1]), q = new URLSearchParams(qs), x = D.strategies.find(y => y.map === m && teamKey(y) === q.get("t"));
    cur = x || null; curVariant = x && x.variants.some(y => y.id === q.get("v")) ? q.get("v") : null;
    html = viewMapDetail(m, qs); active = "mapy"; title = `${m} · KIN`;
  } else if (p[0] === "mapy") { html = viewMapy(); active = "mapy"; title = "Mapy · KIN"; }
  else if (p[0] === "squady" || p[0] === "vybava") { html = viewSquads(); active = "vybava"; title = "Výbava · KIN"; }
  else if (p[0] === "squad" && SQ(p[1])) {
    const q = SQ(p[1]), c = classOf(q, p[2]); active = "vybava";
    if (c) { html = viewClass(q, c); title = `${c.name} · KIN`; } else { html = viewSquadPage(q); title = `${q.name} · KIN`; }
  } else if (p[0] === "doktrina" || p[0] === "vycvik") {
    const tab = p[0] === "vycvik" ? "vycvik" : p[1];
    html = viewDoktrina(tab); active = "doktrina"; title = (tab === "swarm" ? "SWARM" : tab === "vycvik" ? "Výcvik" : "Doktrína") + " · KIN";
  } else if (p[0] === "akce" && !p[1]) {
    plan = planOf(state.event); if (plan && !plan.swarm) curVariant = state.event.variant || pickVariant(plan, qs);
    cur = plan && !plan.swarm && !plan.nomap ? plan : null;  // the build order's role chips trace on this plan
    html = viewAkce(); active = "akce"; title = "Akce · KIN";
    if (sb && state.me) setTimeout(() => loadHist(["historie"]));
  } else if (p[0] === "briefing") {
    active = "akce"; title = "Briefing · KIN";
    html = sb && state.me && state.me.is_commander ? '<p class="note">Načítám…</p>' : '<p class="note">Protokol briefingu je jen pro Commandera.</p>';
    if (sb && state.me && state.me.is_commander) setTimeout(loadBriefing);
  } else if (HIST.includes(p[0])) {
    active = p[0] === "pokryti" ? "vybava" : "akce"; title = p[0] === "pokryti" ? "Pokrytí · KIN" : "Akce · KIN";
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
  const t = e.target.closest("[data-trace],[data-untrace],[data-variant],[data-claim],[data-unclaim],[data-rsvp],[data-cancel],[data-kit],[data-swarm],[data-support],[data-lead],[data-trsvp],[data-tclose],[data-tracker]");
  if (!t) return;
  if (t.dataset.trsvp) { const [id, st] = t.dataset.trsvp.split(":"); rsvpTraining(Number(id), st); return; }
  if (t.dataset.tclose) { t.disabled = true; const [id, st] = t.dataset.tclose.split(":"); closeTraining(Number(id), st); return; }
  if (t.dataset.swarm) { const [i, d] = t.dataset.swarm.split(":").map(Number); setSwarm(i, d); return; }
  if (t.dataset.support) { const [i, d] = t.dataset.support.split(":").map(Number); setSupport(i, d); return; }
  if (t.dataset.lead) {  // the button flips between "Povedu squad" and "Předat SL": keep focus on my row
    takeLead(t.dataset.lead === "1").then(() => document.querySelector(".ros li.is-me [data-lead], .ros li.is-me .rslot")?.focus({ preventScroll: true }));
    return;
  }
  if (t.dataset.kit) { document.getElementById("kit-" + t.dataset.kit)?.scrollIntoView(); return; }
  if (t.dataset.rsvp) { setRsvp(t.dataset.rsvp); return; }
  if (t.dataset.cancel !== undefined) { cancelEvent(t); return; }
  if (t.dataset.tracker !== undefined) { syncTracker().catch(e => console.error(e)); return; }
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

});
// Back/Forward return to where the reader was: the scroll position lives in the history entry (Viktor #023)
let saveY;
addEventListener("scroll", () => { clearTimeout(saveY); saveY = setTimeout(() => history.replaceState({ y: scrollY }, ""), 150); }, { passive: true });
addEventListener("hashchange", () => {
  render();
  const y = history.state && history.state.y;
  if (y) window.scrollTo(0, y);
});
render();
