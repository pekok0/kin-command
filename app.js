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
let state = { me: null, error: urlQs.has("error") ? "Přihlášení přes Discord selhalo." : null, event: null, claims: [], rsvps: [], trainings: [], ops: [], focusId: null, opsLoaded: false, flash: null, trFlash: null, novaFlash: null, checking: !!sb && (hadSession || FRESH) };
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
  const { data, error } = await sb.from("members").select("user_id, discord_id, name, avatar_url, is_commander, is_officer, is_sl, rank")
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
let draft = null, draftT = 0;  // the Commander's unsaved roster change (writeRoster)
const LOAD_ERR = "Sestavu se nepodařilo načíst, zkus to znovu.";
async function loadEvent() {
  if (!state.me) { state.ops = []; state.event = null; state.claims = []; state.rsvps = []; state.trainings = []; renderRoster(); return; }
  const seq = ++loadSeq;
  try {
    // specs/akce-v2 (Petr 2026-10-22): several operations open at once, each with its own roster; trainings and courses
    // are a list of their own and never state.event
    const [op, tr] = await Promise.all([
      sb.from("events").select("id, strategy_id, doctrine, variant, squad_swarm, squad_support, roster, starts_at, open_to_hosts, leader:members!events_created_by_fkey(name)").eq("status", "open").eq("kind", "operace").order("starts_at"),
      sb.from("events").select("id, kind, topic, title, description, capacity, invited, starts_at, created_by, leader:members!events_created_by_fkey(name), rsvps(user_id, status, members(name, avatar_url, discord_id))")
        .eq("status", "open").neq("kind", "operace").order("starts_at"),
    ]);
    if (op.error) throw op.error;
    if (tr.error) throw tr.error;
    // ponytail: two small queries per open operation (a handful at most); one `in` query when there are many
    const ops = await Promise.all((op.data || []).map(async ev => {
      const [cl, rs] = await Promise.all([
        sb.from("claims").select("slot_key, slot_label, user_id, lead, no_cash, members(name, avatar_url, discord_id)").eq("event_id", ev.id),
        sb.from("rsvps").select("user_id, status, members(name, avatar_url, discord_id)").eq("event_id", ev.id),
      ]);
      if (cl.error) throw cl.error;
      if (rs.error) throw rs.error;
      return { ...ev, claims: cl.data, rsvps: rs.data };
    }));
    // the shopping list's unlocks fail on their own: the roster stays usable (null = the block says it did not load)
    const have = await loadLobbyHave(ops).catch(e => (console.error(e), null));
    // swap the whole state at once, and only for the newest load (a slower old response must not win)
    if (seq !== loadSeq) return;
    state.ops = ops; state.opsLoaded = true; state.trainings = tr.data; state.evErr = false; state.lobbyHave = have;
    focusEvent();
    if (state.flash === LOAD_ERR) state.flash = null;  // connection is back: drop only our own outage message
  } catch (e) {
    // keep the last known roster: an empty "no event open" would lie and offer a second event (Viktor UAT #003)
    if (seq !== loadSeq) return;
    console.error(e);
    state.evErr = true; state.flash = LOAD_ERR;
  }
  syncMyRole();  // outside try: a bug here must not show up as a connection outage (OWASP 2026-10-20 L2)
  // the lobby I looked at was closed or cancelled meanwhile: its address shows the history (closed) or Akce
  if (state.focusId && !state.ops.some(e => e.id === state.focusId) && (state.opsLoaded || state.evErr)) { state.focusId = null; render(); return; }
  renderRoster();
}
// hub/specs/nakupni-seznam: what the members of the open operations unlocked this season; members nest their items so
// the row cap counts people, not unlocks (like Pokrytí); a member without rows has no Tracker data
async function loadLobbyHave(ops) {
  const s = currentSeason(), ids = [...new Set(ops.flatMap(ev => ev.claims.map(c => c.user_id)))];
  if (!s || !ids.length) return new Map();
  const { data, error } = await sb.from("members").select("user_id, unlocks!inner(item)").in("user_id", ids).eq("unlocks.season", s.id);
  if (error) throw error;
  return new Map(data.map(m => [m.user_id, new Set(m.unlocks.map(u => u.item))]));
}
// the operation in focus: the one the address names (#/akce/<id>), else the nearest; the roster code works on it
function focusEvent() {
  const ev = state.ops.find(e => e.id === state.focusId) || (state.focusId ? null : state.ops[0]) || null;
  if (ev && draft && draft.id === ev.id) ev.roster = draft.r;  // an unsaved roster change survives a reload (realtime, my own save)
  state.event = ev; state.claims = ev ? ev.claims : []; state.rsvps = ev ? ev.rsvps : [];
}

async function setRsvp(status) {
  const { error } = await sb.from("rsvps").upsert(
    { event_id: state.event.id, user_id: state.me.user_id, status, updated_at: new Date().toISOString() },
    { onConflict: "event_id,user_id" });
  state.flash = !error ? null : error.code === "42501" ? "Akce už je uzavřená." : saveErr(error);
  await loadEvent();
}

const RSVP = [["yes", "Přijdu"], ["maybe", "Možná"], ["no", "Nemůžu"]];
// a slot counts as "yes"; an explicit "no" wins over a forgotten slot, so the Commander's head count is not inflated
function rsvpGroups() {
  const claimed = new Set(state.claims.map(c => c.user_id)), member = {}, said = {}, group = { yes: [], maybe: [], no: [] };
  for (const r of state.rsvps) { member[r.user_id] = r.members; said[r.user_id] = r.status; }
  for (const c of state.claims) member[c.user_id] = c.members;
  for (const u of Object.keys(member)) (group[said[u] === "no" ? "no" : claimed.has(u) ? "yes" : said[u]] || []).push(member[u]);
  return { group, said, claimed };
}
function rsvpBar() {
  const meId = state.me.user_id, { said, claimed } = rsvpGroups();
  const mine = said[meId] || (claimed.has(meId) ? "yes" : null);
  // saying "no" while holding a slot shows a hint to free it
  const hint = said[meId] === "no" && claimed.has(meId) ? "Máš místo v sestavě: uvolni ho, ať ho vezme někdo jiný."
    : said[meId] === "yes" && !claimed.has(meId) ? "Vyber si místo v sestavě níže." : "";
  return `<div class="rsvp" role="group" aria-label="Přijdeš?"><span class="rl" aria-hidden="true">Přijdeš?</span>${RSVP.map(([k, l]) => `<button type="button" class="act" data-rsvp="${k}" aria-pressed="${mine === k}">${l}</button>`).join("")}</div>
    ${hint ? `<p class="note rsvp-hint">${hint}</p>` : ""}`;
}
// Petr 2026-10-28: "vysledky prijdu, mozna a neprijdu by mely byt jinde": the tally in the event's head opens the names
function rsvpTally() {
  const { group } = rsvpGroups();
  return `<button type="button" class="evh-rsvp" data-drawer="rsvp" aria-label="Kdo se ozval: přijde ${group.yes.length}, možná ${group.maybe.length}, nemůže ${group.no.length}">
    <span>přijde <b>${group.yes.length}</b></span><span>možná <b>${group.maybe.length}</b></span><span>nemůže <b>${group.no.length}</b></span></button>`;
}
const rsvpWho = () => { const { group } = rsvpGroups();
  return RSVP.map(([k, l]) => `<section class="bf"><h3>${l} <span class="num">${group[k].length}</span></h3>${group[k].length ? `<p class="who-list">${group[k].map(memberLink).join(" ")}</p>` : '<p class="note">Nikdo.</p>'}</section>`).join(""); };

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
// ranks (Petr 2026-10-22, specs/hodnosti, 019): the Discord role decides, the database enforces it
const RANKS = [["rekrut", "Rekrut", "zápis na akce"], ["operator", "Operátor", "tréninky a kurzy"],
  ["veteran", "Veterán", "zakládá a vede operace"], ["velitel", "Velitel", "vede klan s Commanderem"]];
const rankIdx = r => Math.max(0, RANKS.findIndex(x => x[0] === r));
const rankAt = (m, r) => !!m && rankIdx(m.rank) >= rankIdx(r);
// 038 (Petr 2026-10-28 "Wampalimu dej stejne moznosti kolem akci jako me"): a Velitel runs every event like the
// Commander; the Commander's own (his tasks, merits, the briefing protocol) stay his
const leadsOps = () => !!state.me && (state.me.is_commander || state.me.is_officer);
// what the next rank takes; Veteran also merits for the clan, which the Commander judges
const NEXT = { rekrut: [["Odehrané akce", "ops", 5]], operator: [["Odehrané akce", "ops", 10], ["Tréninky a kurzy", "trainings", 5]] };
function rankCard(m, prog, merits) {
  const i = rankIdx(m.rank), cur = RANKS[i], nxt = RANKS[i + 1], need = NEXT[m.rank] || [], p = prog || { ops: 0, trainings: 0 };
  const done = need.length && need.every(([, k, goal]) => p[k] >= goal);
  const bars = need.map(([l, k, goal]) => `<div class="rk-bar${p[k] >= goal ? " ok" : ""}"><span>${l}</span><b>${p[k]} / ${goal}</b><i><u style="width:${Math.round(100 * Math.min(p[k], goal) / goal)}%"></u></i></div>`).join("");
  const cmd = state.me.is_commander;
  return `<section class="block rank"><h2>Hodnost</h2>
    <div class="rk-head"><span class="rk-badge rk-${cur[0]}">${cur[1]}</span><span>${cur[2]}</span></div>
    ${need.length ? `<h3>Do hodnosti ${nxt[1]}</h3>${bars}${m.rank === "operator" ? `<div class="rk-bar${merits.length ? " ok" : ""}"><span>Zásluhy pro klan</span><b>${merits.length}</b><small>posoudí Commander</small></div>` : ""}
      <p class="rk-then">${nxt[1]}: ${nxt[2]}</p>${done ? `<p class="need ok">Splněno${cmd ? ": přiděl roli na Discordu" : ", Commander tě povýší"}.</p>` : ""}` : ""}
    ${merits.length || cmd ? `<h3>Zásluhy</h3>${merits.length ? `<ul class="merits">${merits.map(x => `<li><span>${esc(x.text)}</span><small>${esc(fmtWhen(x.created_at))}</small>${cmd ? `<button type="button" class="kick" data-merit-del="${esc(x.id)}" aria-label="Smazat zásluhu">${cross()}</button>` : ""}</li>`).join("")}</ul>` : ""}
      ${cmd ? `<form class="evf merit" data-form="merit" data-uid="${esc(m.user_id)}"><label class="wide">Nová zásluha <input name="text" maxlength="200" required></label><button type="submit" class="act">Zapsat</button></form>` : ""}` : ""}
    <details class="rk-all"><summary>Všechny hodnosti</summary><table class="data"><thead><tr><th>Hodnost</th><th>Podmínka</th><th>Smí</th></tr></thead><tbody>
      ${RANKS.map(([k, l, can]) => `<tr${k === cur[0] ? ' class="on"' : ""}><td><b>${l}</b></td><td>${{ rekrut: "povýšení z Hosta", operator: "5 akcí", veteran: "10 akcí, 5 tréninků, zásluhy", velitel: "rozhodne Commander" }[k]}</td><td>${can}</td></tr>`).join("")}</tbody></table></details></section>`;
}
// the member's tasks (specs/ukoly-clenu): Tracker and the first operation War Room sees itself, the rest the member
// ticks on their own profile
const taskDone = (x, done, trackerOk, prog) => x.check === "tracker" ? trackerOk : x.check === "ops" ? !!prog && prog.ops >= 1 : done.has(x.id);
function tasksCard(m, done, trackerOk, prog, owned) {
  // nobody ticks by hand: the database's verifier writes what the sources say (Petr 2026-10-22, specs/ukoly-clenu U8)
  const ok = D.ukoly.map(x => taskDone(x, done, trackerOk, prog));
  // panprstenu2 2026-10-22: clan and Steam group were right, but the Tracker did not tie the profile to his Discord (023)
  const note = owned ? "Odškrtne se samo, jakmile to uvidíme u zdroje."
    : trackerOk ? "Klan na Trackeru a Steam skupinu zatím nepočítáme: Tracker k tomuto profilu nemá propojený Discord. Na wardogstracker.gg: vpravo nahoře tvé jméno → Profile → Settings → Linked accounts → Discord → Link. Do hodiny to tu uvidíš u zdroje."
    : "Odškrtne se samo, jakmile to uvidíme u zdroje. Steam skupinu a klan na Trackeru poznáme, jen když máš na Trackeru propojený i Discord.";
  return `<section class="block ukoly" id="ukoly"><h2>Úkoly <small>${ok.filter(Boolean).length} z ${ok.length}</small></h2><ul class="tasks">
    ${D.ukoly.map((x, i) => `<li data-task="${esc(x.id)}"${ok[i] ? ' class="ok"' : ""}><span class="tk-mark" aria-hidden="true"></span>
      <a href="${esc(x.url || x.href)}"${x.url ? ' target="_blank" rel="noopener"' : ""}>${esc(x.name)}</a></li>`).join("")}</ul>
    <p class="note">${note} <a href="#/ukoly">Kdo co má hotové</a></p></section>`;
}
// everyone's tasks, the most missing first (specs/ukoly-clenu U5)
// U9: a task the source shows only through a Tracker tied to Discord is "?" without one, never "–" (denbler 2026-10-22)
const UNKNOWN = "Nevíme: bez Trackeru s propojeným Discordem to u zdroje neověříme.";
const taskCell = (x, ok, owned) => ok ? ["ok", "✓", ""] : x.needs === "owned" && !owned ? ["unk", "?", UNKNOWN] : ["", "–", ""];
function viewTasks(ms, done, trk, prog) {
  const rows = ms.map(m => { const d = new Set(done.filter(r => r.user_id === m.user_id).map(r => r.task)), t = trk.some(r => r.user_id === m.user_id && r.status === "ok");
    const owned = trk.some(r => r.user_id === m.user_id && r.status === "ok" && r.owned);
    return { m, ok: D.ukoly.map(x => taskDone(x, d, t, prog[m.user_id])), owned }; })
    .sort((a, b) => a.ok.filter(Boolean).length - b.ok.filter(Boolean).length || a.m.name.localeCompare(b.m.name));
  return `<p class="crumb"><a href="#/hrac/${encodeURIComponent(state.me.discord_id)}">Profil</a> / Úkoly</p>
    <header class="unit-head"><div><h1>Úkoly členů</h1></div></header>
    ${!rows.length ? '<p class="note">Zatím tu nikdo není.</p>' : `<div class="matrix-wrap"><table class="data tasks-all" id="ukoly-all"><thead><tr><th>Člen</th>${D.ukoly.map((x, i) => `<th data-task="${esc(x.id)}">${esc(x.name)} <span class="num">${rows.filter(r => r.ok[i]).length}/${rows.length}</span></th>`).join("")}</tr></thead>
    <tbody>${rows.map(r => `<tr><td>${memberLink(r.m)}</td>${r.ok.map((ok, i) => { const [cls, mark, why] = taskCell(D.ukoly[i], ok, r.owned);
      return `<td data-task="${esc(D.ukoly[i].id)}"${cls ? ` class="${cls}"` : ""}${why ? ` title="${esc(why)}"` : ""}>${mark}</td>`; }).join("")}</tr>`).join("")}</tbody></table></div>
    <p class="note tasks-legend">? = ${UNKNOWN}</p>`}`;
}
async function addMerit(f) {
  const { error } = await sb.from("merits").insert({ user_id: f.dataset.uid, text: f.elements.text.value.trim() });
  if (error) { console.error(error); f.insertAdjacentHTML("beforeend", '<p class="err">Zásluhu se nepodařilo zapsat.</p>'); return; }
  render();
}

// command slots of the FORTRESS plans by key, like slot_rank in the database (022, specs/velitelske-sloty)
// 039: the lobby's Velení places only for the command (Commander, Velitel)
// 042 (Petr 2026-10-29): a command place (Velení) beside one ordinary place; "my place" is the ordinary one when I hold both
const isCmd = k => /^SW-CMD[0-9]+$/.test(k);
const myPlace = (claims, uid = state.me.user_id) => claims.find(c => c.user_id === uid && !isCmd(c.slot_key)) || claims.find(c => c.user_id === uid);
const slotRank = k => k === "CMD" ? "veteran" : /^AS[0-9]+-V$/.test(k) ? "operator" : /^SW-CMD[1-4]$/.test(k) ? "velitel" : null;
const rankLock = n => n === "velitel" ? "jen velení" : n === "veteran" ? "od Veterána" : "od Operátora";
function slotRow(x, c, sq) {
  const mine = c && c.user_id === state.me.user_id;
  const need = slotRank(x.key), locked = !c && need && !leadsOps() && !rankAt(state.me, need);
  // V4: the Commander moves someone already in the operation onto a free command slot (it stands for "volné" there)
  const others = !c && need && need !== "velitel" && leadsOps() ? state.claims.filter(o => o.slot_key !== x.key) : [];  // Velení: carry, no select
  const moveto = others.length ? `<select class="moveto" data-moveto="${esc(x.key)}" aria-label="Dosadit na ${esc(x.label)}"><option value="">Dosadit</option>${others.map(o => `<option value="${esc(o.user_id)}">${esc(o.members.name)}</option>`).join("")}</select>` : "";
  const cmd = leadsOps();
  const who = c ? `<img src="${esc(c.members.avatar_url)}" alt="" loading="lazy"><span class="nm">${esc(c.members.name)}</span>${sq && c.lead ? '<span class="slb" title="Squad leader">SL</span>' : ""}`
    : moveto ? "" : `<span class="free">${locked ? rankLock(need) : "volné"}</span>`;
  // a Velitel moves people too (Petr 2026-10-25 D39, migration 031): a plain place only -- not an SL, not onto a command
  // slot. Petr 2026-10-28: no move button, the player himself is carried (drag, or click and click a free place: carry below)
  const sqd = (cmd || state.me.is_officer) && state.event && isSq(state.event), lift = sqd && c && (cmd || !c.lead);
  const act = lift ? `data-lift="${esc(c.user_id)}" aria-label="Přesunout ${esc(c.members.name)}" title="Přesunout: táhni na volné místo, nebo klikni a pak klikni na místo"`
    : mine ? `data-unclaim="${esc(x.key)}" title="Odhlásit se"` : c || locked ? "disabled" : `data-claim="${esc(x.key)}"`;
  // an x on my own place too (UAT C-03: on a phone "click your slot to leave" was invisible); the Commander's on anyone's
  const kick = c && (mine || leadsOps())
    ? `<button type="button" class="kick" data-unclaim="${esc(x.key)}" aria-label="${mine ? "Odhlásit se z místa" : `Odhlásit ${esc(c.members.name)}`}" title="${mine ? "Odhlásit se z místa" : ""}">${cross()}</button>` : "";
  const drag = lift ? ` data-drag="${esc(c.user_id)}"` : sqd && !c && !locked && (cmd || !need) ? " data-free" : "";
  return `<li data-key="${esc(x.key)}"${drag}${mine ? ' class="is-me"' : ""}><button type="button" class="rslot" ${act}><span class="lbl">${x.role ? `<span class="rid">${esc(x.role)}</span>` : ""}${esc(x.label)}</span>${who}</button>${moveto}${kick}</li>`;
}

function rosterGroup(g, by) {
  const n = g.slots.filter(x => by[x.key]).length;
  return `<div class="rg"><div class="pg-head">${sym(g.symbol, "sm")}<div><b>${esc(g.name)}</b><small>${esc(g.squad)}</small></div><span class="num">${n}/${g.max}</span></div>
    <ul>${g.slots.map(x => slotRow(x, by[x.key]).replace(/<\/li>$/, roleOffBtn(g, x, by) + "</li>")).join("")}</ul>${fortressTools(g, by)}</div>`;
}
// a free plan role: the Commander switches it off right on its row (the row says what it is, no extra words)
const roleOffBtn = (g, x, by) => leadsOps() && plan && plan.base && x.role && !by[x.key]
  ? `<button type="button" class="rx-off" data-fx="${g.id}:off:${esc(x.role)}" aria-label="Vypnout roli ${esc(x.role)}" title="Vypnout roli">×</button>` : "";
function fortressTools(g, by) {
  const base = plan && plan.base && plan.base.find(b => b.id === g.id);
  if (!leadsOps() || !base) return "";
  const free = g.slots.filter(x => !x.role), last = free[free.length - 1], label = (base.slots.find(x => !x.role) || {}).label || "člen";
  const off = base.slots.filter(x => x.role && !g.slots.some(y => y.key === x.key));
  return `<div class="sqtools">
    <span class="sqp">${esc(label)} <b>${free.length}</b><span class="swctl">
      <button type="button" class="act" data-fx="${g.id}:extra:-1" aria-label="${esc(g.name)}: ubrat ${esc(label)}"${!free.length || by[last.key] ? " disabled" : ""}>−</button>
      <button type="button" class="act" data-fx="${g.id}:extra:1" aria-label="${esc(g.name)}: přidat ${esc(label)}"${free.length >= 10 ? " disabled" : ""}>+</button></span></span>
    ${off.map(x => `<button type="button" class="act sqadd" data-fx="${g.id}:on:${esc(x.role)}">+ ${esc(x.role)}</button>`).join("")}
    <button type="button" class="act sqdrop" data-fx="${g.id}:hide:1"${groupFilled(g, by) ? ' disabled title="Ve skupině někdo je"' : ""}>Skrýt skupinu</button></div>`;
}
const groupFilled = (g, by) => g.slots.filter(x => by[x.key]).length;

// the squad part of a slot key (SW-Q2-SW3 -> Q2), as the unique index claims_one_lead counts it (011): a badge on a
// place the page does not show (dropped by "-", forged key) still leads its squad (OWASP 2026-10-21 L1)
const squadOf = k => k.split("-")[1];
const leadOf = g => state.claims.find(c => c.lead && squadOf(c.slot_key) === g.id);

// SWARM squad (specs/swarm-squady, akce-v2 A6): its roles with their places; SL is a badge on one of the people, named in
// the head. The Commander adds and removes a role's places ("-" only the last and only while free), the last squad
// when it is empty, and a new squad at the end
function squadCard(g, by) {
  const cmd = leadsOps(), n = g.slots.filter(x => by[x.key]).length, lead = leadOf(g), sq = { led: !!lead };
  const cw = state.event.doctrine === "cw";  // D33: the same editor for SWARM and Public Ops, only the roles on offer differ
  const roles = squadRoles(cw);
  const lines = roles.map(ro => {
    const xs = g.slots.filter(x => x.kit === ro.kit), c = xs.length, taken = c && by[xs[c - 1].key];
    if (!c) return "";
    const less = g.slots.length <= 1 ? "squad potřebuje aspoň 1 místo" : "";
    const more = c >= 12 ? "nejvýš 12" : g.slots.length >= 20 ? "squad má nejvýš 20 míst" : "";
    const ctl = cmd ? `<span class="swctl">
      <button type="button" class="ib" data-role="${g.idx}:${ro.kit}:-1" aria-label="${esc(g.name)}: ubrat ${esc(ro.label)}${taken ? ` (vyhodí ${esc(taken.members.name)})` : ""}"${less ? ` disabled title="${esc(less)}"` : ""}>${minus()}</button>
      <b>${c}</b><button type="button" class="ib" data-role="${g.idx}:${ro.kit}:1" aria-label="${esc(g.name)}: přidat ${esc(ro.label)}"${more ? ` disabled title="${esc(more)}"` : ""}>${plus()}</button></span>` : `<b>${c}</b>`;
    return `<div class="sqp ro-${esc(ro.kit)}">${roleMark(ro.kit)}<span class="rn">${esc(ro.label)}</span>${ctl}</div><ul class="ro-${esc(ro.kit)}">${xs.map(x => slotRow(x, by[x.key], sq)).join("")}</ul>`;
  }).join("");
  // Petr 2026-10-28: any squad goes by its x, not only the last; with people in it the first click asks (they get dropped)
  const live = plan.roster.filter(q => q.sq).length, armed = state.sqArm === g.idx;
  const drop = cmd && live > 1 ? `<button type="button" class="${armed ? "act sqx armed" : "ib sqx"}" data-sqdrop="${g.idx}" aria-label="Zrušit ${esc(g.name)}${n ? ` (vyhodí ${n})` : ""}" title="Zrušit squad">${armed ? `Zrušit? vyhodí ${n}` : cross()}</button>` : "";
  const title = cmd ? `<input class="sqname" data-sqname="${g.idx}" value="${esc(g.name)}" maxlength="24" aria-label="Název squadu ${g.idx + 1}">` : `<b>${esc(g.name)}</b>`;
  const free = roles.filter(ro => !g.slots.some(x => x.kit === ro.kit));
  const addRole = cmd && free.length && g.slots.length < 20 ? `<select class="addrole" data-addrole="${g.idx}" aria-label="${esc(g.name)}: přidat roli"><option value="">+ Přidat roli</option>${free.map(ro => `<option value="${esc(ro.kit)}" class="ro-${esc(ro.kit)}">${roleMark(ro.kit)}<span>${esc(ro.label)}</span></option>`).join("")}</select>` : "";
  return `<div class="rg sqc"><div class="pg-head">${sym(g.symbol, "sm")}<div>${title}</div><span class="num">${n}/${g.max}</span>${drop}</div>
    ${slPlate(g, by, lead, n)}${lines}${addRole}${buyDetails(g)}</div>`;
}
// the squad's command seat (Petr 2026-10-28: "Veli: nikdo ... by taky mohla vypadat jinak nez text, co zmizi"): a plate
// under the name, dashed while nobody leads (hostile red once people are in), solid with the SL when someone does; the
// badge stamps onto it. One per squad (011): a member of the squad with the Discord role Squad Leader takes it here (041,
// Petr 2026-10-29), the SL hands it over here, the Commander or a Velitel picks one of the squad or takes it off
function slPlate(g, by, lead, n) {
  const cmd = leadsOps(), me = state.me.user_id, people = g.slots.map(x => by[x.key]).filter(Boolean);
  const head = `<span class="slp-k" aria-hidden="true">SL</span>`;
  if (lead) return `<div class="slplate on" data-slq="${g.id}">${head}<img src="${esc(lead.members.avatar_url)}" alt="" loading="lazy"><b class="who" title="Squad leader">${esc(lead.members.name)}</b>
    ${lead.user_id === me ? '<button type="button" class="act lead" data-lead="0">Předat SL</button>'
      : cmd ? `<button type="button" class="ib" data-leadfor="${esc(lead.user_id)}:0" aria-label="Sundat SL: ${esc(lead.members.name)}" title="Sundat SL">${cross()}</button>` : ""}</div>`;
  const take = people.some(c => c.user_id === me) && (cmd || state.me.is_sl);
  return `<div class="slplate ${n ? "need" : "idle"}" data-slq="${g.id}">${head}<span class="who-none">${n ? "Squad nemá SL" : "SL squadu"}</span>
    ${take ? '<button type="button" class="act lead" data-lead="1">Povedu squad</button>'
      : cmd && people.length ? `<select class="slpick" data-slpick aria-label="${esc(g.name)}: vybrat SL"><option value="">Vybrat SL</option>${people.map(c => `<option value="${esc(c.user_id)}"><img src="${esc(c.members.avatar_url)}" alt=""><span>${esc(c.members.name)}</span></option>`).join("")}</select>` : ""}</div>`;
}
// Velení as a narrow strip over the squads (Petr 2026-10-28: "si urcite nezaslouzi celou vlastni kartu, dej nekam do uzkeho
// prouzku ... pekne barvy a symboliku generalstvi"): the general's two stars and gold lampas, the Commander places as
// chips, - n + for the command (a place taken drops its member, like a role's -); a member sees it only when someone is in
const STARS = '<svg class="cmd-stars" viewBox="0 0 40 16" aria-hidden="true"><path d="M10 1.5 L12 6.6 H17.4 L13 9.8 L14.7 15 L10 11.8 L5.3 15 L7 9.8 L2.6 6.6 H8 Z M30 1.5 L32 6.6 H37.4 L33 9.8 L34.7 15 L30 11.8 L25.3 15 L27 9.8 L22.6 6.6 H28 Z"/></svg>';
function cmdCard(g, by) {
  const n = g.slots.filter(x => by[x.key]).length, lead = leadsOps();
  if (!lead && !n) return "";
  const ctl = lead ? `<span class="swctl">
      <button type="button" class="ib" data-cmd="-1" aria-label="Velení: ubrat místo"${g.slots.length ? "" : " disabled"}>${minus()}</button>
      <b>${g.slots.length}</b><button type="button" class="ib" data-cmd="1" aria-label="Velení: přidat místo"${g.slots.length >= CMD_MAX ? ` disabled title="Nejvýš ${CMD_MAX}"` : ""}>${plus()}</button></span>` : "";
  return `<div class="cmdbar cmdc" role="group" aria-label="Velení"><span class="cmd-k">${STARS}Velení</span>
    <ul>${g.slots.map(x => slotRow(x, by[x.key])).join("")}</ul>${ctl}</div>`;
}
const setCmd = async d => {
  const last = d < 0 && plan.roster.find(g => g.cmdg).slots.at(-1);
  if (last && !await dropFrom([last.key])) return;
  return writeRoster(r => { r.cmd = Math.max(0, Math.min(CMD_MAX, cmdCount(r) + d)); });
};
// the Commander's add plate at the end of the lobby (Petr 2026-10-28): a squad into the first gap, and every vehicle type
// the operation has none of yet; a type with vehicles keeps its - / + on its own card
function addPlate() {
  if (!leadsOps()) return "";
  const r = rosterOf(state.event), gap = r.squads.some(q => !Object.keys(q).length) || r.squads.length < 12;
  const t = D.doktrina.swarm.sestava, none = t.podpora.map((p, ti) => [p, ti]).filter(([p]) => !(r.vehicles[p.kit] || []).length);
  return `<div class="rg sqnew"><p class="sqnew-k">Přidat do sestavy</p><div class="sqnew-b">
    <button type="button" class="act sqadd" data-squad="add"${gap ? "" : ' disabled title="Nejvýš 12 squadů"'}>${plus()} Squad</button>
    ${none.map(([p, ti]) => `<button type="button" class="act" data-support="${ti}:1" aria-label="Podpora: přidat ${esc(p.name)}">${plus()} ${esc(p.name)}</button>`).join("")}</div></div>`;
}

// SWARM Podpora (specs/swarm-squady P2-P3): a vehicle = its crew, framed like a unit; the Commander adds and removes
// vehicles per type, "-" only the last one and only while its whole crew is free (as "- Swarm")
// one vehicle with its crew; the optional seat (Petr 2026-10-22: Tank Gunner, a helicopter's second crew member) closes only free
function carBox(t, c, by) {
  // the optional seat is a small + / - by the vehicle's name (Petr 2026-10-28: "jenom nejakej malej symbol ... plusko")
  const seat = () => { if (!leadsOps() || t.min === t.seats.length) return "";
    const on = c.open > t.min, name = t.seats[t.min], busy = on && by[c.slots[c.slots.length - 1].key], what = `${esc(name)}: ${on ? "zavřít" : "otevřít"}`;
    return `<button type="button" class="ib seatt" data-seat="${t.kit}:${c.v}:${on ? -1 : 1}" aria-pressed="${on}" aria-label="${what}" title="${busy ? `${esc(name)} je obsazený` : what}"${busy ? " disabled" : ""}>${on ? minus() : plus()}</button>`; };
  return `<div class="veh" data-veh="${esc(c.slots[0].key)}"><div class="vh">${sym(t.symbol, "sm")}<b class="vn">${esc(c.name)}</b><span class="num">${c.slots.filter(x => by[x.key]).length}/${c.slots.length}</span>${seat()}</div>
    <ul>${c.slots.map(x => slotRow(x, by[x.key])).join("")}</ul></div>`;
}
function podporaCard(g, by) {
  if (!g.slots.length) return "";  // a vehicle type the operation has none of: the Commander adds it on the add plate
  const n = g.slots.filter(x => by[x.key]).length, t = g.vehicles[0];  // one vehicle type per card (D20)
  // the type's - n + sits in the card's head (Petr 2026-10-28: the space the row buttons gave back); tanks: on the last
  const more = t.n >= t.max ? `${t.name}: nejvýš ${t.max}` : "";
  const ctl = leadsOps() && g.ctl !== false ? `<span class="swctl">
      <button type="button" class="ib" data-support="${t.ti}:-1" aria-label="Podpora: ubrat ${esc(t.name)}" title="Ubrat ${esc(t.name)}">${minus()}</button>
      <b>${esc(t.n)}</b><button type="button" class="ib" data-support="${t.ti}:1" aria-label="Podpora: přidat ${esc(t.name)}"${more ? ` disabled title="${esc(more)}"` : ` title="Přidat ${esc(t.name)}"`}>${plus()}</button></span>` : "";
  return `<div class="rg podc"><div class="pg-head">${sym(g.symbol, "sm")}<div><b>${esc(g.name)}</b></div><span class="num">${n}/${g.max}</span>${ctl}</div>
    <div class="vtypes"><div class="vtype">${t.cars.map(c => carBox(t, c, by)).join("")}</div></div>${buyDetails(g)}</div>`;
}

function viewRoster(s) {
  const head = "<h2>Lobby</h2>";  // Petr 2026-10-26: one term for the page where squads are composed (the draft)
  const msg = state.flash ? `<p class="err ros-msg" role="alert">${esc(state.flash)}</p>` : "";
  if (!sb) return `${head}<p class="note">Lobby se teď nenačetlo (knihovna přihlášení není dostupná). Plány map a doktrína fungují dál.</p>`;
  if (!state.me) return `${head}<p class="note">Lobby je jen pro členy KIN. <button type="button" class="act" data-login>Přihlásit přes Discord</button></p>`;
  const ev = state.event;
  if (!ev) return state.evErr ? `${head}${msg}`
    : `${head}<p class="note">Žádná akce není otevřená.</p>${msg}`;
  const cancel = leadsOps() ? cancelEventForm() : "";
  // the map form too: picking a known map or "zatím nevím" keeps the sign-ups, cancelling drops them (threat model N1)
  if (!s) return `${head}<p class="note">Otevřená akce (${esc(fmtWhen(ev.starts_at))}) je pro mapu ${esc(ev.strategy_id)}, kterou War Room nezná.</p>${msg}${leadsOps() ? mapTeamForm(ev) : ""}${cancel}`;
  const by = Object.fromEntries(state.claims.map(c => [c.slot_key, c]));
  state.buy = s.swarm ? nakupGroups(s) : null;
  const filled = state.claims.filter(c => s.roster.some(g => g.slots.some(x => x.key === c.slot_key))).length;
  const total = s.roster.reduce((n, g) => n + g.max, 0);
  // without builders and logistics there is no FOB and no supplies: show the plan's fill order still open
  const missing = (s.fill_order || []).filter(id => !by[id] && s.roster.some(g => g.slots.some(x => x.key === id))).map(id => roleOf(s, id)).filter(Boolean);
  // first 6 only: glanceable at a briefing and fewer chips to hit by mistake on a phone (a tap moves your slot)
  // my slot's shopping list one tap away (denbler 2026-10-19 "at si kazdy hned najde svoje"): SWARM below in Akce,
  // Top defence on my role card of the map
  const myc = myPlace(state.claims);
  const mys = myc && s.roster.flatMap(g => g.slots.map(x => ({ g, x }))).find(o => o.x.key === myc.slot_key);
  const myr = mys && !s.swarm && mys.x.role && roleOf(s, mys.x.role);
  const mine = !mys ? "" : s.swarm
    ? `<p class="mine-kit">Máš místo: <b>${esc(mys.x.car || mys.g.name)} · ${esc(mys.x.label)}</b> ${KIT_BTN}</p>`
    : myr ? `<p class="mine-kit">Máš místo: <b>${esc(myr.id)} · ${esc(mys.g.name)}</b>${s.nomap ? "" : ` <a class="kitl" href="${roleHref(s, myr)}">Tvoje karta: nákup a kroky</a>`}</p>` : "";
  const miss = s.swarm ? ""  // Petr 2026-10-28: the red strip repeated what the SL plates show
    : missing.length
    ? `<p class="miss">Chybí: ${missing.slice(0, 6).map(r => (n => !n || leadsOps() || rankAt(state.me, n)  // a command slot above my rank: named, not offered (022)
      ? `<button type="button" class="rid" data-claim="${esc(r.id)}" title="${esc(r.id)} – ${esc(r.name)}">${esc(r.id)}</button>`
      : `<span class="rid" title="${esc(r.id)} – ${esc(r.name)}, ${n === "veteran" ? "od Veterána" : "od Operátora"}">${esc(r.id)}</span>`)(slotRank(r.id))).join(" ")}${missing.length > 6 ? ` <span class="more">a dalších ${missing.length - 6}</span>` : ""}</p>`
    : '<p class="miss ok">Všechny role z plánu obsazené.</p>';
  // the operation console (Petr 2026-10-21 "prehlednejsi a vychytanejsi ... tlacitka, notifikace, sestava"): who and what
  // with a live T- clock and the fill gauge, then the alert strip, my place and answer, the Commander's commands last
  const pct = total ? Math.round(filled / total * 100) : 0;
  return `<div class="opcon"><div class="ros-head"><div class="op-id"><span class="op-lamp" aria-hidden="true"></span>${head}</div>
    <div class="op-fill"><span class="num">${filled} <small>/ ${total}</small></span><span class="gauge" style="--p:${pct}%" aria-hidden="true"></span><small>zapsaných</small></div></div>
    ${miss ? `<div class="op-status">${miss}</div>` : ""}
    <div class="op-me">${mine || (s.swarm ? `<p class="mine-kit">${KIT_BTN}</p>` : "")}${rsvpBar()}</div>
    ${leadsOps() ? `<div class="op-cmd" role="group" aria-label="Příkazy velení">${mapTeamForm(ev)}${closeEventForm(s)}<button type="button" class="act" data-drawer="brief">Protokol briefingu</button>${cancel}</div>` : ""}</div>
    ${msg}
    <div class="ros${s.swarm ? " swarm" : ""}">${s.roster.map(g => g.cmdg ? cmdCard(g, by) : g.sq ? squadCard(g, by) : g.vehicles ? podporaCard(g, by) : rosterGroup(g, by)).join("")}${s.swarm ? addPlate() : ""}</div>
    ${s.base && leadsOps() && s.base.length > s.roster.length ? `<div class="sqtools hidden-g">Skryté: ${s.base.filter(b => !s.roster.some(g => g.id === b.id)).map(b =>
      `<button type="button" class="act sqadd" data-fx="${b.id}:hide:0">+ ${esc(b.name)}</button>`).join("")}</div>` : ""}
    ${nakupBlock(s)}`;
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
  if (!sb || !state.me) return viewRoster(s);
  const nova = newPanel();
  // the overview: founding on top, every open operation and training, the history under it (viewAkce)
  if (!state.focusId) return nova + opCards() + trainingsSection();
  if (!ev) return nova + (state.evErr ? `<section class="lobby">${viewRoster(s)}</section>` : "");
  return nova + eventHero(ev, s) + `<section class="lobby" id="lobby">${viewRoster(s)}${!s || s.swarm || s.nomap ? "" : buildOrder(s)}</section>`;
}
// the operation's head (Petr 2026-10-22: "prehlednejsi nadpis ... doktrina urcite jde znazornit a vizualizovat lepe"):
// what, when, how long to go, the doctrine as a plate, the map and team, who leads; x closes back to the overview
const DOC_ICON = {
  defence: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M7 41V19L24 7l17 12v22z"/><path d="M7 27h34M17 41V31h14v10M24 7v8"/></svg>',
  swarm: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M5 9l13 13M43 9L30 22M24 44V31M10 22l8 0 0-8M38 22h-8v-8M19 37l5-6 5 6"/><circle cx="24" cy="25" r="4"/></svg>',
  cw: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M8 40L40 8M8 8l32 32"/><path d="M6 14V6h8M42 14V6h-8M6 34v8h8M42 34v8h-8"/></svg>',
};
// the doctrine's emblem (Petr 2026-10-28: "v tom logu public ops neni potreba ten text na druhem radku ... radsi hezke a
// krasne to logo typu akce"): its mark in a hexagonal badge, big in the event's head, small on the operation cards
const docEmblem = (d, cls = "") => `<span class="docmark doc-${d}${cls ? " " + cls : ""}" aria-hidden="true"><svg viewBox="0 0 100 100">
  <path class="hx" d="M50 3 L91 26.5 V73.5 L50 97 L9 73.5 V26.5 Z"/><path class="hx2" d="M50 12 L83 31 V69 L50 88 L17 69 V31 Z"/>
  <svg class="dm" x="27" y="27" width="46" height="46" viewBox="0 0 48 48">${DOC_ICON[d].replace(/^<svg[^>]*>|<\/svg>$/g, "")}</svg></svg></span>`;
function eventHero(ev, s) {
  const sw = isSq(ev), d = sw ? ev.doctrine : "defence", v = !sw && s && ev.variant && vById(s, ev.variant);
  return `<header class="evhero"><a class="evx" href="#/akce" aria-label="Zavřít detail akce" title="Zavřít">${cross()}</a>
    <div class="evh-when"><p class="evh-k">Operace${ev.open_to_hosts ? ' <b class="hosts">Otevřená hostům</b>' : ""}</p><h1>${esc(fmtWhen(ev.starts_at))}</h1><b class="tminus" data-t0="${esc(ev.starts_at)}">${tminus(ev.starts_at)}</b></div>
    <a class="docplate doc-${d}" href="${sw ? `#/doktrina/${d}` : "#/doktrina"}" title="${esc(docOf(d).short)}">${docEmblem(d)}<b>${esc(docName(d))}</b></a>
    ${state.me ? rsvpTally() : ""}<p class="evh-m">${!ev.strategy_id ? NOPICK
      : !sw && s && !s.nomap ? `<a href="${planHref(s)}">${sideOf(ev.strategy_id)}</a>${v ? ` · zóna ${esc(v.name)}` : ""}` : sideOf(ev.strategy_id)}${ev.leader ? ` · vede <b>${esc(ev.leader.name)}</b>` : ""}</p></header>`;
}
// every open operation as a card (specs/akce-v2 A2): when, how long to go, doctrine, map, how full, my place; the card
// in focus is lit, a click shows its lobby below
function opCards() {
  // a failed load says so, never "none open" (Viktor UAT #003)
  if (!state.ops.length) return `<section class="block opl-sec"><h2>Operace</h2>${state.evErr ? `<p class="err">${LOAD_ERR}</p>` : '<p class="note">Teď není otevřená žádná operace.</p>'}</section>`;
  return `<section class="block opl-sec"><h2>Operace</h2><div class="opl">${state.ops.map(ev => {
    const s = planOf(ev), total = s ? s.roster.reduce((n, g) => n + g.max, 0) : 0, n = ev.claims.length;
    const mine = myPlace(ev.claims), said = (ev.rsvps.find(r => r.user_id === state.me.user_id) || {}).status;
    const on = state.focusId === ev.id;
    return `<a class="opc${on ? " on" : ""}" href="#/akce/${ev.id}"${on ? ' aria-current="true"' : ""}>
      <span class="opc-k">${esc(docName(ev.doctrine))}${ev.open_to_hosts ? " · otevřená hostům" : ""}</span>${docEmblem(isSq(ev) ? ev.doctrine : "defence", "sm")}
      <b class="opc-t">${esc(fmtWhen(ev.starts_at))}</b><span class="tminus" data-t0="${esc(ev.starts_at)}">${tminus(ev.starts_at)}</span>
      <span class="opc-m">${sideOf(ev.strategy_id, NOPICK)}</span>
      <span class="opc-g"><i style="width:${total ? Math.min(100, Math.round(100 * n / total)) : 0}%"></i></span><span class="opc-f"><b>${n}</b> / ${total} míst</span>
      <span class="opc-me">${mine ? `Máš místo: ${esc(mine.slot_label)}` : said ? `Odpověď: ${esc((RSVP.find(x => x[0] === said) || [, said])[1])}` : "Zatím bez odpovědi"}</span></a>`; }).join("")}</div></section>`;
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
  const k = D.doktrina.swarm, myc = myPlace(state.claims);
  const slot = myc && plan.roster.flatMap(g => g.slots).find(x => x.key === myc.slot_key);
  const r = slot && k.slots.find(r => r.id === slot.kit), cls = slot && slot.cls;
  const [cq, cc] = cls ? classById(cls) : r && !r.own_kit ? classById(r.class) : [], skip = cc ? myKit(cc).names : new Set();
  // CW buys by the Vybava role, the SWARM base is SWARM's (Petr 2026-10-25: "porad sleduje doktrinu swarm")
  const cw = state.event.doctrine === "cw";
  return `<section class="block" id="swarm-kit"><h2>Tvůj nákup</h2>${cc ? loadoutCard(cq, cc, "h3") : ""}${r && r.own_kit || cw ? "" : kitBase(k, skip)}
    ${r ? kitRole(slot.seat ? { ...r, ...r.seats[slot.seat] } : r, skip) : cls ? "" : `<p class="note">Zapiš se do slotu a ukážu ti nákup tvé role. ${cw ? 'Loadouty všech rolí jsou ve <a href="#/vybava">Výbavě</a>.' : 'Nákup všech rolí je v <a href="#/doktrina/swarm">Doktríně</a>.'}</p>`}</section>`;
}

// hub/specs/nakupni-seznam N2: the minimum of a place = its role's items and the shared ones its role carries in Vybava
// (Recon wears Ghillie, Rocketeer has no Medical Bag); a crew seat only the vehicle it buys (Petr: armor not for crews)
function slotNeeds(slot) {
  const n = D.nakup;
  if (slot.seat) return n.vozidla.filter(v => v.kit === slot.kit && v.seat === slot.seat).map(v => ({ ...v, qty: 1 }));
  const r = D.doktrina.swarm.slots.find(r => r.id === slot.kit), cls = slot.cls || (r && !r.own_kit && r.class);
  const c = cls && classById(cls)[1];
  if (!c) return [];
  // pieces per life as the role's ladder says (2 smokes, 6 frags), else one
  const qty = new Map(c.ladders.flatMap(l => l.steps.map(st => [st.item, typeof st.qty === "number" ? st.qty : 1])));
  return [...(n.role[cls] || []), ...n.z_vybavy.filter(e => qty.has(e.item))].map(e => ({ ...e, qty: qty.get(e.item) || 1 }));
}
// N1 + N3: per item how many pieces are missing, whose and who of the operation has it unlocked (may buy it); things unlocked
// from the start never show; a member without Tracker data is listed apart, not as missing everything. A member the
// Commander marked no cash (033) gets the whole minimum bought, kdo = null: unlocked from the start, anyone buys it
function nakupList(s) {
  const have = state.lobbyHave;
  if (!have) return null;
  const slots = new Map(s.roster.flatMap(g => g.slots.map(x => [x.key, x]))), name = c => (c.members && c.members.name) || "?";
  const rows = new Map(), bezDat = [];
  for (const c of state.claims) {
    const x = slots.get(c.slot_key), mine = have.get(c.user_id);
    if (!x) continue;
    if (!mine && !c.no_cash) { bezDat.push(name(c)); continue; }
    for (const e of slotNeeds(x)) {
      if (!c.no_cash && (!e.unlock || mine.has(e.item))) continue;
      if (!rows.has(e.item)) rows.set(e.item, { item: e.item, price: e.price, unlock: e.unlock, n: 0, komu: [], kdo: [] });
      const r = rows.get(e.item); r.n += e.qty; r.komu.push(name(c) + (c.no_cash ? " (bez peněz)" : ""));
    }
  }
  for (const r of rows.values()) r.kdo = !r.unlock ? null : state.claims.filter(c => !c.no_cash && have.get(c.user_id)?.has(r.item)).map(name);
  return { rows: [...rows.values()], bezDat };
}
// per squad (Petr 2026-10-28: "nakupni seznamy pro lidi bez penez nebo unlocku per squad ... budou se kupovat lidi mezi sebou
// ve squadu a odridi si to squad leader ... at SL rychle vi, co je potreba a kdo to z jeho muze koupit"): what each member of a
// group misses and who of that group has it unlocked; nobody there -> who of the operation could
function nakupGroups(s) {
  const have = state.lobbyHave;
  if (!have) return null;
  const name = c => (c.members && c.members.name) || "?";
  const can = (pool, item) => pool.filter(c => !c.no_cash && have.get(c.user_id)?.has(item)).map(name);
  return new Map(s.roster.map(g => {
    const keys = new Set(g.slots.map(x => x.key)), people = state.claims.filter(c => keys.has(c.slot_key)), rows = new Map(), bezDat = [];
    for (const c of people) {
      const mine = have.get(c.user_id);
      if (!mine && !c.no_cash) { bezDat.push(name(c)); continue; }
      for (const e of slotNeeds(g.slots.find(x => x.key === c.slot_key))) {
        if (!c.no_cash && (!e.unlock || mine.has(e.item))) continue;
        if (!rows.has(e.item)) rows.set(e.item, { item: e.item, price: e.price, unlock: e.unlock, n: 0, komu: [] });
        const r = rows.get(e.item); r.n += e.qty; r.komu.push(name(c) + (c.no_cash ? " (bez peněz)" : ""));
      }
    }
    for (const r of rows.values()) {
      r.kdo = !r.unlock ? null : can(people, r.item);
      r.jinde = r.kdo && !r.kdo.length ? can(state.claims.filter(c => !keys.has(c.slot_key)), r.item) : [];
    }
    return [g.id, { g, rows: [...rows.values()], bezDat }];
  }).filter(([, x]) => x.rows.length || x.bezDat.length));
}
const nameList = names => names.map(esc).join(", ");
const buyList = x => `<ul class="buy">${x.rows.map(r => `<li${r.kdo && !r.kdo.length ? ' class="nobody"' : ""}><span class="bi"><b>${esc(r.item)}</b> ×${r.n}${r.price == null ? "" : ` <span class="pr">${usd(r.price)}</span>`}</span>
    <span class="bk">chybí: ${nameList(r.komu)}</span><span class="bw">${!r.kdo ? "koupí si sám" : r.kdo.length ? `koupí: <b>${nameList(r.kdo)}</b>` : `<b class="nobuy">nikdo ve squadu</b>${r.jinde.length ? `, z akce: ${nameList(r.jinde)}` : ", nikdo z akce"}`}</span></li>`).join("")}</ul>
  ${x.bezDat.length ? `<p class="note">Bez dat z Trackeru: ${nameList(x.bezDat)}.</p>` : ""}`;
// the squad's own list in its card, for its SL; red when nobody of the squad can buy something
function buyDetails(g) {
  const x = state.buy && state.buy.get(g.id);
  if (!x) return "";
  const stuck = x.rows.some(r => r.kdo && !r.kdo.length);
  return `<details class="sq-buy${stuck ? " warn" : ""}"><summary>Nákup squadu <span class="num">${x.rows.length}</span>${stuck ? '<span class="nobuy">někdo musí koupit mimo squad</span>' : ""}</summary>${buyList(x)}</details>`;
}
function nakupBlock(s) {
  if (!s.swarm || !state.claims.length) return "";
  const l = nakupList(s), head = '<section class="block" id="nakup"><h2>Nákupní seznam</h2>';
  if (!l || !state.buy) return `${head}<p class="err">Nákupní seznam se nepodařilo načíst, zkus to znovu.</p></section>`;
  return `${head}<p class="note">Co zapsaným z nákupního minima chybí, po squadech. Kupuje se uvnitř squadu, řídí to SL: koupit může jen ten, kdo to má odemčené.</p>
    ${state.buy.size ? [...state.buy.values()].map(x => { const lead = x.g.sq && leadOf(x.g);
      return `<div class="buy-g"><h3>${esc(x.g.name)}${lead ? ` <small>SL ${esc(lead.members.name)}</small>` : ""}</h3>${buyList(x)}</div>`; }).join("")
      : '<p class="note">Zapsaným nic z minima nechybí.</p>'}
    ${leadsOps() ? `<p class="note nocash">Bez peněz (označuje jen velení, členům se koupí celé minimum): ${state.claims.map(c =>
      `<button type="button" class="act" data-nocash="${esc(c.user_id)}:${c.no_cash ? 0 : 1}" aria-pressed="${!!c.no_cash}">${esc((c.members && c.members.name) || "?")}</button>`).join(" ")}</p>` : ""}
    <p class="note">Kdo kupuje pro jiné, potřebuje bednu a vozidlo, kterým ji koupí: ${D.nakup.rezie.map(e => `${esc(e.item)} ${e.price == null ? "" : usd(e.price)}`).join(", ")}.</p></section>`;
}

// realtime and tab-return re-render the block: keep what the Commander is typing into a form
// every open operation, training and course as a tile under the nav, by time (Petr 2026-10-22: "tu notifikaci urcite
// chci mit na vsech strankach ... inteligentne a prehledne ... rychle se dostat na danou akci"); the nearest is lit, a tile
// without my answer asks for it. Akce shows big cards and the home page its own card, so the rail stays off there.
function renderEvBar() {
  const bar = document.getElementById("evbar");
  if (!bar) return;
  const here = ["sestava", "home-ev"].some(id => document.getElementById(id));
  const items = !state.me || here ? [] : [...state.ops.map(ev => ({ ev, op: true })), ...state.trainings.map(ev => ({ ev, op: false }))]
    .sort((a, b) => a.ev.starts_at.localeCompare(b.ev.starts_at));
  bar.innerHTML = !items.length ? "" : `<nav class="evrail" aria-label="Otevřené akce">${items.map(({ ev, op }, i) => {
    const mine = op && myPlace(ev.claims), said = (ev.rsvps.find(r => r.user_id === state.me.user_id) || {}).status;
    const st = mine ? `Máš místo: ${esc(mine.slot_label)}` : said ? esc((RSVP.find(x => x[0] === said) || [, said])[1]) : "Odpověz, jestli přijdeš";
    return `<a class="evt${i ? "" : " next"}${mine || said ? "" : " need"}" href="${op ? `#/akce/${ev.id}` : "#/akce"}">
      <span class="evt-k">${op ? `Operace · ${esc(docName(ev.doctrine))}${ev.open_to_hosts ? " · otevřená hostům" : ""}` : `${esc(label(KINDS, ev.kind))} · ${esc(ev.title)}`}</span>
      <span class="evt-w"><b>${esc(fmtWhen(ev.starts_at))}</b><span class="tminus" data-t0="${esc(ev.starts_at)}">${tminus(ev.starts_at)}</span></span>
      <span class="evt-s">${st}</span></a>`; }).join("")}</nav>`;
}

// returns a function that puts back the roster's typed forms and open <details> after a rebuild
function keepForms() {
  const el = document.getElementById("sestava");
  if (!el) return () => {};
  const keep = [...el.querySelectorAll("form[data-form]")].map(f => [f.dataset.form,
    [...f.elements].filter(x => x.name && x.type !== "hidden").map(x => [x.name, x.type === "checkbox" ? x.checked : x.value])]);
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
  const el = document.getElementById("sestava");
  if (!el) return;
  plan = planOf(state.event);  // a new, cancelled or switched event changes which roster Akce shows
  if (plan && !plan.swarm) curVariant = state.event.variant || pickVariant(plan, "");  // the zone picked at founding, else the last seen
  const restore = keepForms();
  keepView(el, () => keepFocus(() => { el.innerHTML = akceBody(); }));
  restore();
  markChanges(el);
  renderDrawers();
  carryMarks();  // a change pushed while a player is carried: the hole and the free places stay lit
  if (pinY && Date.now() < pinY.until) scrollTo(0, pinY.y);  // a drop never moves the page (Petr 2026-10-28)
}

// a rebuilt roster keeps the row I was looking at where it was on screen: innerHTML drops the browser's own scroll
// anchoring (Petr 2026-10-22: "Povedu squad" jumped the page when the squad's header lost a line); my row if it is in
// view, else the first row in view
function keepView(el, fn) {
  const rows = () => [...el.querySelectorAll(".ros li")], seen = r => { const b = r.getBoundingClientRect(); return b.bottom > 0 && b.top < innerHeight; };
  const mine = el.querySelector(".ros li.is-me"), a = mine && seen(mine) ? mine : rows().find(seen);
  const i = a ? rows().indexOf(a) : -1, top = a && a.getBoundingClientRect().top;
  fn();
  const b = !a ? null : a === mine ? el.querySelector(".ros li.is-me") : rows()[i];
  if (b) scrollBy(0, b.getBoundingClientRect().top - top);
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
    const plate = el.querySelector(`.slplate[data-slq="${squadOf(k)}"]`);
    if (now.leads.has(k) && !was.leads.has(k)) { mark(li.querySelector(".slb"), "fx-lead", "lead"); mark(plate, "fx-lead", "lead"); }
    else if (was.leads.has(k) && !now.leads.has(k) && now.by[k]) mark(plate, "fx-unlead", "unlead");
  }
  for (const v of el.querySelectorAll(".veh[data-veh]")) if (!was.vehs.has(v.dataset.veh)) mark(v, "fx-new", "vehicle");
  if ([...was.keys].some(k => !now.keys.has(k))) fired.add("remove");
  if (now.flash && now.flash !== was.flash) fired.add("error");
  const cue = ["error", "vehicle", "lead", "unlead", "claim", "add", "free", "remove"].find(c => fired.has(c));
  if (cue) sound(cue);
}

// synthesized cues (Web Audio, no files): short, quiet, off with the speaker in the bar (remembered in localStorage)
let actx = null;
let soundPref = null;  // private window without localStorage: the toggle still works for this visit
const soundOn = () => { try { return (localStorage.getItem("kin-sound") || soundPref) !== "off"; } catch { return soundPref !== "off"; } };
const CUES = {  // [start Hz, end Hz, seconds, wave, delay s, peak gain (default: sine .09, else .035)]
  claim: [[520, 880, .07, "square", 0], [1320, 1320, .08, "sine", .07]],
  free: [[660, 330, .16, "triangle", 0]],
  add: [[1800, 1800, .02, "square", 0], [990, 990, .09, "sine", .04]],
  remove: [[440, 220, .1, "square", 0]],
  vehicle: [[80, 150, .26, "sawtooth", 0], [740, 740, .12, "sine", .14]],
  // Petr 2026-10-28 ("sound pro oznaceni SL je lackluster"): the badge stamps down (a low thump and a click), then a
  // rising major call C-E-G-C with the octave ringing on; losing it falls back down
  lead: [[150, 50, .16, "sine", 0, .3], [2400, 300, .03, "square", 0, .05], [523, 523, .12, "triangle", .08, .12],
    [659, 659, .12, "triangle", .16, .12], [784, 784, .14, "triangle", .24, .12], [1047, 1047, .45, "triangle", .32, .14], [2094, 2094, .4, "sine", .32, .04]],
  unlead: [[784, 523, .18, "triangle", 0, .1], [392, 262, .25, "triangle", .1, .1]],
  // opening an operation (the unlock): a rising whoosh, a click per locked ring, the lock giving way
  open: [[180, 520, .26, "sawtooth", 0, .015], [90, 70, .2, "sine", 0, .12]],
  dial: [[1800, 900, .025, "square", 0, .03], [520, 520, .04, "triangle", .01, .07]],
  unlock: [[110, 40, .3, "sine", 0, .32], [260, 1400, .4, "sawtooth", .03, .02], [1047, 1047, .25, "triangle", .18, .08], [1568, 1568, .35, "sine", .24, .05]],
  lift: [[220, 560, .08, "triangle", 0, .08]],  // a player taken off his place; tick: over a free place; back: put back
  tick: [[2200, 2200, .015, "square", 0, .012]],
  back: [[560, 220, .09, "triangle", 0, .06]],
  error: [[150, 120, .2, "square", 0]],
};
function sound(name) {
  if (!soundOn() || !CUES[name]) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === "suspended") actx.resume();  // allowed after the first click; before it the cue just stays silent
    const t0 = actx.currentTime;
    for (const [f0, f1, dur, type, at, peak] of CUES[name]) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, t0 + at);
      o.frequency.exponentialRampToValueAtTime(f1, t0 + at + dur);
      g.gain.setValueAtTime(0.0001, t0 + at);
      g.gain.exponentialRampToValueAtTime(peak || (type === "sine" ? 0.09 : 0.035), t0 + at + 0.01);
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

// specs/pozadi-bitva B20 (Superuser 2026-10-22): the battle behind the page is hard on older eyes, the sun button dims it
let bgPref = null;
const bgDim = () => { try { return (localStorage.getItem("kin-bg") || bgPref) === "dim"; } catch { return bgPref === "dim"; } };
function renderBg() {
  document.documentElement.dataset.bg = bgDim() ? "dim" : "full";
  document.getElementById("bgd")?.setAttribute("aria-pressed", String(bgDim()));
}
document.getElementById("bgd")?.addEventListener("click", () => {
  bgPref = bgDim() ? "full" : "dim";
  try { localStorage.setItem("kin-bg", bgPref); } catch { /* private window: bgPref holds it */ }
  renderBg();
});
renderBg();

async function claim(key) {
  const s = plan;  // the page may change while saving (render() resets plan off roster pages, Viktor #029)
  const g = s.roster.find(g => g.slots.some(x => x.key === key)), slot = g.slots.find(x => x.key === key);
  // SWARM: the role, not "Squad 2 · Raketomet" (stats count labels as roles, Viktor #005)
  const uid = state.me.user_id, row = { slot_key: key, slot_label: s.swarm ? slot.stat : `${g.name} · ${slot.label}`, lead: false };
  // 042: a place of the same kind moves (ordinary to ordinary, Velení to Velení), the other kind is added beside it
  const had = state.claims.find(c => c.user_id === uid && isCmd(c.slot_key) === isCmd(key));
  const { error } = had ? await sb.from("claims").update(row).eq("event_id", state.event.id).eq("user_id", uid).eq("slot_key", had.slot_key)
    : await sb.from("claims").insert({ event_id: state.event.id, user_id: uid, ...row });
  await loadEvent();
  if (error && error.code === "23505") {
    const c = state.claims.find(c => c.slot_key === key);
    state.flash = `Slot už obsadil ${c ? c.members.name : "někdo jiný"}.`;
  } else if (error) state.flash = error.code !== "42501" ? saveErr(error)  // 022: a command slot above my rank (rank changed meanwhile)
    : slotRank(key) ? `${slot.label}: ${slotRank(key) === "velitel" ? "jen pro velení" : `až ${rankLock(slotRank(key))}`}.` : "Akce už je uzavřená.";
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
  const s = planOf(state.event), c = s && myPlace(state.claims);
  const slot = c && s.roster.flatMap(g => g.slots).find(x => x.key === c.slot_key);
  if (!slot?.role) return;
  const want = s.nomap ? null : `${s.id}/${slot.role}`, [, rid] = (me.get() || "/").split("/");
  if (me.get() !== want && (want || rid === slot.role)) { me.set(want); renderNav(navActive); }
}

async function unclaim(key) {  // one place (042: the command one and the ordinary one leave apart)
  const s = planOf(state.event), c = state.claims.find(c => c.slot_key === key);
  if (!c) return loadEvent();
  const slot = c.user_id === state.me.user_id && s && s.roster.flatMap(g => g.slots).find(x => x.key === c.slot_key);
  const { error } = await sb.from("claims").delete().eq("event_id", state.event.id).eq("slot_key", key).eq("user_id", c.user_id);
  state.flash = !error ? null : error.code === "42501" ? "Akce už je uzavřená." : saveErr(error);
  // leaving my place drops "Moje role" that came from it (UAT C-04); a role picked by hand elsewhere stays
  if (!error && slot?.role && me.get() === `${s.id}/${slot.role}`) { me.set(null); renderNav(navActive); }
  await loadEvent();
}

document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") loadEvent(); });

// side panels (Petr 2026-10-28: "protokol briefingu ... jako vyjizdeci panel ze strany, to same pro tvuj nakup, ten neni
// vubec na ocich"): they slide in from the right over the lobby, rendered with it so they stay current; Esc, x or the
// shade closes. The command's briefing protocol is a plain list of its steps (row 'velitel', 040: the command reads it)
const KIT_BTN = '<button type="button" class="kitl" data-drawer="kit"><svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4 V2 H10 V4 M3.5 6 Q3.5 4 5.5 4 H10.5 Q12.5 4 12.5 6 V14 H3.5 Z M6 9 H10"/></svg>Tvůj nákup</button>';
function drawers(s) {
  const d = state.drawer, one = (k, title, body) => `<aside class="dw${d === k ? " open" : ""}" id="dw-${k}" role="dialog" aria-labelledby="dw-${k}-h"${d === k ? "" : " inert"}>
    <header class="dw-h"><h2 id="dw-${k}-h">${title}</h2><button type="button" class="ib dw-x" data-dwclose aria-label="Zavřít panel">${cross()}</button></header><div class="dw-b">${body}</div></aside>`;
  return `<div class="dws"><div class="dw-shade${d ? " open" : ""}" data-dwclose></div>${s && s.swarm ? one("kit", "Tvůj nákup", swarmMyKit()) : ""}${one("rsvp", "Kdo se ozval", rsvpWho())}${leadsOps() ? one("brief", "Protokol briefingu", briefList()) : ""}</div>`;
}
// the panels sit outside #app (renderDrawers), so their x and shade need their own listener (Petr 2026-10-28: "nejde zavrit
// krizkem ani klikem mimo"); buttons inside a panel that act on the lobby go through the same handler as #app
document.addEventListener("click", e => {
  if (!e.target.closest?.("#drawers")) return;
  if (e.target.closest("[data-dwclose]")) { setDrawer(null); return; }
  if (e.target.closest("a[href^='#']")) setDrawer(null);  // a link in a panel leaves the page: the panel goes with it
});
function renderDrawers() {
  const box = document.getElementById("drawers");
  if (box) box.innerHTML = state.focusId && state.event && state.me && location.hash.startsWith("#/akce/") ? drawers(plan) : "";
}
function setDrawer(k) {
  state.drawer = state.drawer === k ? null : k;
  document.querySelectorAll(".dw").forEach(a => { const on = a.id === `dw-${state.drawer}`; a.classList.toggle("open", on); a.inert = !on; });
  document.querySelector(".dw-shade")?.classList.toggle("open", !!state.drawer);
  if (state.drawer) document.querySelector(`#dw-${state.drawer} .dw-x`)?.focus({ preventScroll: true });
  if (state.drawer === "brief" && state.brief === undefined) loadBrief();
}
async function loadBrief() {
  state.brief = null;
  const { data, error } = await sb.from("content").select("data").eq("id", "velitel").maybeSingle();
  if (error) console.error(error);
  state.brief = data && data.data && data.data.briefing ? briefOutline(data.data.briefing) : false;
  const b = document.querySelector("#dw-brief .dw-b");
  if (b) b.innerHTML = briefList();
}
const briefList = () => state.brief === undefined || state.brief === null ? '<p class="note">Načítám…</p>'
  : state.brief === false ? '<p class="err">Protokol se nenačetl, obnov stránku (F5).</p>' : state.brief;
// the protocol's sections as headings with their points, no prose (Petr: "jednodussi prostsi seznam"); the whole one stays on #/briefing
function briefOutline(html) {
  const doc = new DOMParser().parseFromString(html, "text/html"), out = [];
  let cur = null;
  for (const el of doc.body.querySelectorAll("h2, li")) {
    if (el.tagName === "H2") out.push(cur = { h: el.innerHTML, items: [] });
    else if (cur && !el.parentElement.closest("li")) cur.items.push(el.innerHTML);
  }
  return out.map(x => `<section class="bf"><h3>${x.h}</h3>${x.items.length ? `<ul>${x.items.map(i => `<li>${i}</li>`).join("")}</ul>` : ""}</section>`).join("")
    + '<p class="note"><a href="#/briefing">Celý protokol</a></p>';
}

// the Commander shapes the roster (specs/akce-v2 A6); the database refuses a shape outside the rules (017 roster_ok)
// ponytail: a sign-up racing a "-" can land on the dropped place and stays unseen until its owner picks again; DB trigger if it bites
// Petr 2026-10-25 ("hrozne dlouho trva ... kdyz toho klikam vice a rychleji"): a change shows at once and builds on the
// last click, not on the database; the save waits for a short pause and sends the last shape once
function writeRoster(change) {
  const ev = state.event, r = JSON.parse(JSON.stringify(isSq(ev) ? rosterOf(ev) : ev.roster || { groups: {} }));
  change(r);
  draft = { id: ev.id, r };
  ev.roster = r;
  renderRoster();
  clearTimeout(draftT);
  return new Promise(done => { draftT = setTimeout(() => saveDraft().then(done), 200); });
}
async function saveDraft() {
  const d = draft;
  const { data, error } = await sb.from("events").update({ roster: d.r }).eq("id", d.id).select("id");
  if (draft === d) draft = null;  // a click during the save keeps its own draft for the next save
  state.flash = error ? saveErr(error) : !data.length ? "Sestavu se nepodařilo uložit: akce už není otevřená, nebo nemáš práva Commandera." : null;
  if (error || !data.length) draft = null;  // back to what the database holds
  await loadEvent();
}
// CW (Petr 2026-10-25 C3): a removed place drops the member on it first (the Commander deletes claims, RLS 004)
// by member, not by place: who sat down there meanwhile stays (owasp-2026-10-25 M1); 0 rows = the page was stale
async function dropFrom(keys) {
  for (const c of state.claims.filter(c => keys.includes(c.slot_key))) {
    const { data, error } = await sb.from("claims").delete().eq("event_id", state.event.id).eq("slot_key", c.slot_key).eq("user_id", c.user_id).select("user_id");
    if (error || !data.length) { state.flash = error ? saveErr(error) : "Sestava se mezitím změnila, zkus to znovu."; await loadEvent(); renderRoster(); return false; }
  }
  return true;
}
const cwEv = () => state.event.doctrine === "cw";
const setRole = async (i, kit, d) => {
  const xs = d < 0 ? plan.roster.find(g => g.idx === i).slots.filter(x => x.kit === kit) : [];
  if (xs.length && !await dropFrom([xs[xs.length - 1].key])) return;
  return writeRoster(r => { r.squads[i][kit] = (r.squads[i][kit] || 0) + d; if (!r.squads[i][kit]) delete r.squads[i][kit]; });
};
// a dropped squad stays as {} (036): the ones after it keep their number, slot keys and Discord room; a new squad fills
// the first gap, trailing gaps go (Petr 2026-10-28)
const setSquad = async (op, i) => {
  const g = op === "drop" && plan.roster.find(q => q.sq && q.idx === i);
  if (g && !await dropFrom(g.slots.map(x => x.key))) return;
  state.sqArm = null;
  return writeRoster(r => { const t = D.doktrina.swarm.sestava, cw = cwEv();
    if (op === "add") {
      const gap = r.squads.findIndex(q => !Object.keys(q).length), k = gap < 0 ? r.squads.length : gap;
      r.squads[k] = cw ? { ...D.doktrina.cw.squad } : Object.fromEntries([...t.core.map(c => [c.kit, 1]), [t.swarm.kit, t.swarm.default]]);
      if (r.names) r.names[k] = `Squad ${k + 1}`;
    } else {
      r.squads[i] = {};
      if (r.names) r.names[i] = `Squad ${i + 1}`;
      while (r.squads.length > 1 && !Object.keys(r.squads.at(-1)).length) { r.squads.pop(); if (r.names) r.names.pop(); }
    }
  });
};
const setName = (i, v) => writeRoster(r => { r.names = r.names || r.squads.map((_, k) => `Squad ${k + 1}`); r.names[i] = v.trim().slice(0, 24) || `Squad ${i + 1}`; });
const setSupport = async (ti, d) => {
  const p = D.doktrina.swarm.sestava.podpora[ti], car = d < 0 && plan.roster.filter(x => x.vehicles && x.vehicles[0].kit === p.kit).flatMap(x => x.vehicles[0].cars).at(-1);
  if (car && !await dropFrom(car.slots.map(x => x.key))) return;
  return writeRoster(r => { const list = r.vehicles[p.kit] = r.vehicles[p.kit] || []; if (d > 0) list.push(p.open); else list.pop(); });
};
const setSeat = (kit, v, d) => writeRoster(r => { r.vehicles[kit][v] += d; });
function setFortress(gid, what, arg) {
  return writeRoster(r => { const c = r.groups[gid] = r.groups[gid] || {}, base = plan.base.find(b => b.id === gid);
    if (what === "extra") c.extra = (c.extra ?? base.slots.filter(x => !x.role).length) + Number(arg);
    else if (what === "hide") { if (arg === "1") c.hide = true; else delete c.hide; }
    else { const off = new Set(c.off || []); if (what === "off") off.add(arg); else off.delete(arg); c.off = [...off]; if (!c.off.length) delete c.off; }
    if (!Object.keys(c).length) delete r.groups[gid]; });
}

// the Commander puts the badge on someone else (019 claims_lead_commander; only the badge on another's row)
// the Commander moves a member's place onto a command slot (022: the database lets him change only that on another's row)
async function moveTo(uid, key, from = myPlace(state.claims, uid)?.slot_key) {
  const g = plan.roster.find(g => g.slots.some(x => x.key === key)), slot = g.slots.find(x => x.key === key);
  const { data, error } = await sb.from("claims").update({ slot_key: key, slot_label: `${g.name} · ${slot.label}`, lead: false })
    .eq("event_id", state.event.id).eq("user_id", uid).eq("slot_key", from).select("slot_key");
  state.flash = error ? (error.code === "23505" ? "Místo už někdo obsadil." : saveErr(error)) : !data.length ? "Přesun se nepodařilo uložit: akce už není otevřená." : null;
  await loadEvent();
  renderRoster();
}
async function giveLead(uid, on) {
  const { data, error } = await sb.from("claims").update({ lead: on }).eq("event_id", state.event.id).eq("user_id", uid)
    .eq("slot_key", myPlace(state.claims, uid)?.slot_key).select("slot_key");
  state.flash = error ? (error.code === "23505" ? "Squad už SL má." : saveErr(error)) : !data.length ? "SL se nepodařilo uložit: akce už není otevřená." : null;
  await loadEvent();
}
// the Commander marks a member without cash (033: only he may change no_cash); the shopping list buys him the minimum
async function setNoCash(uid, on) {
  const { data, error } = await sb.from("claims").update({ no_cash: on }).eq("event_id", state.event.id).eq("user_id", uid)
    .eq("slot_key", myPlace(state.claims, uid)?.slot_key).select("slot_key");
  state.flash = error ? saveErr(error) : !data.length ? "Značku se nepodařilo uložit: akce už není otevřená." : null;
  await loadEvent();
}
// the SL badge on my own row (S4-S5); one per squad: the unique index claims_one_lead refuses a second (23505)
async function takeLead(on) {
  const uid = state.me.user_id;
  const { data, error } = await sb.from("claims").update({ lead: on }).eq("event_id", state.event.id).eq("user_id", uid)
    .eq("slot_key", myPlace(state.claims)?.slot_key).select("slot_key");
  await loadEvent();
  const mine = myPlace(state.claims);
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
let novaKind = "operace";
function newPanel() {
  const cmd = leadsOps(), op = cmd || rankAt(state.me, "veteran"), tr = cmd || state.me.is_officer || rankAt(state.me, "operator");
  const kinds = [["operace", "Operace", "velká akce klanu"], ["trenink", "Trénink", "klan nebo pozvaní"], ["kurz", "Kurz", "omezený počet míst"]].filter(([k]) => k === "operace" ? op : tr);
  if (!kinds.length) return "";
  const k = kinds.some(x => x[0] === novaKind) ? novaKind : kinds[0][0];
  return `<details class="nova" id="nova"${state.novaFlash ? " open" : ""}><summary class="act">+ Nová akce</summary><div class="vbar seg" role="group" aria-label="Typ nové akce">${kinds.map(([id, l, sub]) =>
    `<button type="button" data-nova="${id}" aria-pressed="${id === k}"><b>${l}</b><small>${sub}</small></button>`).join("")}</div>
    ${state.novaFlash ? `<p class="err ros-msg" role="alert">${esc(state.novaFlash)}</p>` : ""}${k === "operace" ? newEventForm() : newTrainingForm(k)}</details>`;
}
function newEventForm() {
  return `<form class="evf" data-form="new">
    <label>Začátek <input type="datetime-local" name="starts" required min="${new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)}T00:00"></label>
    <label>Doktrína <select name="doctrine">${[["swarm", "Fun"], ["cw", "PO"]].map(([d, g]) => `<option value="${d}">${g}: ${esc(docOf(d).title)}</option>`).join("")}</select></label>
    ${pickFields(null)}
    <label class="att wide"><input type="checkbox" name="open_to_hosts"> Otevřená hostům (jedna akce týdně podle ankety)</label>
    <button type="submit" class="act">${esc(newLabel("swarm", null))}</button></form>`;
}

// the Commander picks or changes them while the event is open (specs/akce-mapa-tym 3-4); sign-ups keep their slots
function mapTeamForm(ev) {
  const s = S(ev.strategy_id);
  return `<details class="evmap"><summary>Mapa, tým a varianta</summary><form class="evf" data-form="mapteam">${pickFields(s, ev)}
    <label class="att wide"><input type="checkbox" name="open_to_hosts"${ev.open_to_hosts ? " checked" : ""}> Otevřená hostům</label>
    <button type="submit" class="act">${esc(saveLabel(s))}</button></form></details>`;
}

function closeEventForm(s) {
  return `<details class="evclose"><summary>Uzavřít akci a uložit do historie</summary><form class="evf" data-form="close">
    <label>Umístění <select name="placement" required><option value="">vyber</option><option value="1">1.</option><option value="2">2.</option><option value="3">3.</option></select></label>
    <label>Počasí <select name="weather"><option value="">neuvedeno</option>${D.bitvy.pocasi.map(w => `<option value="${esc(w.id)}">${esc(w.label)}</option>`).join("")}</select></label>
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
    : '<p class="note">Teď není vypsaný žádný trénink ani kurz.</p>';
  const msg = state.trFlash ? `<p class="err ros-msg" role="alert">${esc(state.trFlash)}</p>` : "";
  return `<section class="block" id="treninky"><h2>Tréninky a kurzy</h2>${msg}${list}</section>`;
}

function trainingRow(tr) {
  const by = { yes: [], maybe: [], no: [] }, id = esc(tr.id);
  for (const r of tr.rsvps) (by[r.status] || []).push(r.members);
  const mine = (tr.rsvps.find(r => r.user_id === state.me.user_id) || {}).status;
  // T4: no "Prijdu" on a full course unless I already have a place; the capacity trigger refuses it anyway
  const full = tr.capacity && by.yes.length >= tr.capacity && mine !== "yes";
  const ctl = leadsOps() || tr.created_by === state.me.user_id ? `<details class="t${id}"><summary>Uzavřít nebo zrušit</summary>
      ${by.yes.length ? `<fieldset class="atts"><legend>Kdo byl</legend>${tr.rsvps.filter(r => r.status === "yes").map(r =>
        `<label class="att"><input type="checkbox" name="tatt_${esc(r.user_id)}" checked>${esc(r.members.name)}</label>`).join("")}</fieldset>` : ""}
      <button type="button" class="act" data-tclose="${id}:closed">Proběhl, uzavřít</button> <button type="button" class="act" data-tclose="${id}:cancelled">Zrušit</button></details>` : "";
  return `<li class="tr"><p class="tr-k"><span class="ref">${esc(label(KINDS, tr.kind))}</span>${esc(label(TOPICS, tr.topic))}${tr.invited ? "<span>· Jen pro pozvané</span>" : ""}</p>
    <h3>${esc(tr.title)}</h3>
    <p class="tr-m"><time datetime="${esc(tr.starts_at)}">${esc(fmtWhen(tr.starts_at))}</time> · Vede <b>${esc(tr.leader ? tr.leader.name : "?")}</b> · Přijde <b>${trCount(tr)}</b></p>
    ${tr.description ? `<p class="tr-d">${esc(tr.description)}</p>` : ""}
    <div class="rsvp" role="group" aria-label="${esc(tr.title)}: přijdeš?">${RSVP.map(([k, l]) => `<button type="button" class="act" data-trsvp="${id}:${k}" aria-pressed="${mine === k}"${k === "yes" && full ? ` disabled aria-describedby="full-${id}"` : ""}>${l}</button>`).join("")}</div>
    ${full ? `<p class="tr-full" id="full-${id}">Kurz je plný.</p>` : ""}
    ${WHO.map(([k, l]) => by[k].length ? `<p class="tr-who"><b>${l}:</b> ${by[k].map(memberLink).join(" ")}</p>` : "").join("")}
    ${ctl}</li>`;
}

function newTrainingForm(kind) {
  return `<form class="evf" data-form="training"><input type="hidden" name="kind" value="${kind === "kurz" ? "kurz" : "trenink"}">
    <label>Téma <select name="topic">${Object.entries(TOPICS).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></label>
    <label class="wide">Název <input name="title" required maxlength="80"></label>
    <label>Začátek <input type="datetime-local" name="starts" required min="${new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)}T00:00"></label>
    <label class="cap"${kind === "kurz" ? "" : " hidden"}>Počet míst <input type="number" name="capacity" min="2" max="12" value="8" required${kind === "kurz" ? "" : " disabled"}></label>
    <label class="wide">Krátký popis <textarea name="description" maxlength="500" rows="2"></textarea></label>
    <label class="att wide"><input type="checkbox" name="private"> Jen pro pozvané (ostatní ho neuvidí)</label>
    <fieldset class="atts invl" hidden><legend>Koho zveš</legend>${state.clan ? state.clan.filter(m => m.user_id !== state.me.user_id).map(m =>
      `<label class="att"><input type="checkbox" name="inv_${esc(m.user_id)}">${esc(m.name)}</label>`).join("") : '<p class="note">Načítám členy…</p>'}</fieldset>
    <button type="submit" class="act">Vypsat</button></form>`;
}
// a course has places, a training does not: the field shows and is sent only for a course; a private one (043) lists
// the clan to invite from, loaded the first time it is ticked
const capToggle = f => { const off = f.elements.kind.value !== "kurz"; f.querySelector(".cap").hidden = off; f.elements.capacity.disabled = off;
  f.querySelector(".invl").hidden = !f.elements.private.checked; if (f.elements.private.checked && state.clan === undefined) loadClan(); };
// a failed load leaves the list empty until a reload (a retry from the next render would loop)
async function loadClan() {
  state.clan = null;
  const { data, error } = await sb.from("members").select("user_id, name").eq("active", true).order("name");
  state.clan = error ? [] : data;
  if (error) state.novaFlash = "Seznam členů se nepodařilo načíst, obnov stránku.";
  renderRoster();
}

// T2: the Commander and officers; the database refuses anyone else, and an operation from an officer
async function createTraining(f) {
  const v = Object.fromEntries(new FormData(f)), kind = v.kind === "kurz" ? "kurz" : "trenink";
  const invited = f.elements.private.checked ? [...f.querySelectorAll('input[name^="inv_"]:checked')].map(x => x.name.slice(4)) : null;
  if (invited && !invited.length) { state.novaFlash = "Vyber, koho zveš."; return; }
  const { error } = await sb.from("events").insert({ kind, topic: v.topic, title: v.title.trim(), starts_at: new Date(v.starts).toISOString(),
    description: v.description.trim() || null, capacity: kind === "kurz" ? Number(v.capacity) : null, invited });
  state.novaFlash = !error ? null : error.code === "42501" ? "Trénink nebo kurz vypíše člen od hodnosti Operátor." : saveErr(error);
  if (!error) { f.reset(); capToggle(f); }  // the next one starts from an empty form
}

async function rsvpTraining(id, status) {
  const { error } = await sb.from("rsvps").upsert({ event_id: id, user_id: state.me.user_id, status, updated_at: new Date().toISOString() },
    { onConflict: "event_id,user_id" });
  // 23514 = the capacity trigger (012): someone took the last place a moment earlier
  state.trFlash = !error ? null : error.code === "23514" ? "Kurz je plný." : error.code === "42501" ? "Trénink už je uzavřený." : saveErr(error);
  await loadEvent();
}

// T5: the founder or the Commander (events_close, 012); no row back = not open any more, or not his
async function closeTraining(id, status) {
  // attendance first (019 runs_event: the founder or the Commander while open); counts for ranks (specs/hodnosti)
  const att = status === "closed" ? [...document.querySelectorAll(`.t${id} input[name^="tatt_"]`)].map(x => ({ event_id: id, user_id: x.name.slice(5), attended: x.checked })) : [];
  if (att.length) {
    const { error: e1 } = await sb.from("attendance").upsert(att, { onConflict: "event_id,user_id" });
    if (e1) { state.trFlash = saveErr(e1); await loadEvent(); return; }
  }
  const { data, error } = await sb.from("events").update({ status: status === "closed" ? "closed" : "cancelled" })
    .eq("id", id).neq("kind", "operace").select("id");
  state.trFlash = error ? saveErr(error) : !data.length ? "Nepodařilo se uložit: trénink už není otevřený, nebo ho nevypsal ty." : null;
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
document.addEventListener("change", e => { if (["kind", "private"].includes(e.target.name) && e.target.form?.dataset.form === "training") capToggle(e.target.form); });
document.addEventListener("change", e => { if (e.target.dataset.moveto && e.target.value) moveTo(e.target.value, e.target.dataset.moveto); });
document.addEventListener("change", e => { if (e.target.dataset.sqname !== undefined) setName(Number(e.target.dataset.sqname), e.target.value); });
document.addEventListener("change", e => { if (e.target.dataset.addrole !== undefined && e.target.value) setRole(Number(e.target.dataset.addrole), e.target.value, 1); });
document.addEventListener("change", e => { if (e.target.dataset.slpick !== undefined && e.target.value) giveLead(e.target.value, true); });
// the Commander drags a member onto a free place (Petr 2026-10-25 C5); "Přesunout" / "Sem" does the same without a mouse
// carrying a player (Petr 2026-10-28: "zvednuti hrace ze slotu, pohyb s hracem mysi, pri najeti mysi na slot, pri
// pusteni hrace na slot"): a mouse press and drag lifts him, a click or a tap (or Enter) lifts him until the next click;
// he rides on a card under the pointer, the place he left stays a dashed hole, free places light up and the one under
// him glows; a free place takes him, anything else (or Esc) puts him back. A phone scrolls as before: there a tap lifts
let carry = null, pressed = null, swallow = false, pinY = null;
const FREE = ".ros li[data-free]";
function carryMarks() {
  if (!carry) return;
  document.querySelector(`.ros li[data-key="${CSS.escape(carry.from)}"]`)?.classList.add("lifted");
  document.querySelectorAll(FREE).forEach(li => li.classList.add("drop-ok"));
}
function lift(li, x, y, sticky) {
  const r = li.getBoundingClientRect(), ghost = document.createElement("div"), w = Math.min(r.width, 300);
  ghost.className = "carry-ghost";
  ghost.innerHTML = li.querySelector(".rslot").innerHTML;
  ghost.querySelector(".lbl")?.remove();  // the player, not his place
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.width = `${w}px`;
  document.body.append(ghost);
  carry = { uid: li.dataset.drag, from: li.dataset.key, ghost, sticky, dx: Math.min(x - r.left, w - 16), dy: y - r.top, hot: null };
  document.body.classList.add("carrying");
  carryMarks();
  follow(x, y);
  requestAnimationFrame(() => ghost.classList.add("up"));
  sound("lift");
}
function follow(x, y) {
  carry.ghost.style.transform = `translate(${x - carry.dx}px, ${y - carry.dy}px)`;
  const hot = document.elementFromPoint(x, y)?.closest(FREE) || null;
  if (hot === carry.hot) return;
  carry.hot?.classList.remove("drop-hot");
  hot?.classList.add("drop-hot");
  carry.hot = hot;
  if (hot) sound("tick");
}
function putDown(target) {
  const c = carry, back = document.querySelector(`.ros li[data-key="${CSS.escape(c.from)}"]`), to = (target || back)?.getBoundingClientRect();
  carry = null;
  document.body.classList.remove("carrying");
  document.querySelectorAll(".ros .lifted, .ros .drop-ok, .ros .drop-hot").forEach(li => li.classList.remove("lifted", "drop-ok", "drop-hot"));
  c.ghost.classList.add("landing");
  if (to) { c.ghost.style.transform = `translate(${to.left}px, ${to.top}px)`; c.ghost.style.width = `${to.width}px`; }
  setTimeout(() => c.ghost.remove(), 220);
  if (target) { pinY = { y: scrollY, until: Date.now() + 2500 }; moveTo(c.uid, target.dataset.key, c.from); } else sound("back");
}
document.addEventListener("pointerdown", e => {
  if (carry || e.button !== 0 || e.pointerType === "touch") return;
  const li = e.target.closest?.(".ros li[data-drag]");
  pressed = li && e.target.closest(".rslot") ? { li, x: e.clientX, y: e.clientY } : null;
});
document.addEventListener("pointermove", e => {
  if (pressed && !carry && Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) > 6) {
    lift(pressed.li, pressed.x, pressed.y, false);
    document.getSelection()?.removeAllRanges();
  }
  if (carry) follow(e.clientX, e.clientY);
});
document.addEventListener("pointerup", e => {
  pressed = null;
  if (!carry || carry.sticky) return;
  swallow = true;  // the click this release makes is the drop, not a sign-up; none comes when it ends off the row
  setTimeout(() => { swallow = false; });
  putDown(document.elementFromPoint(e.clientX, e.clientY)?.closest(FREE) || null);
});
document.addEventListener("keydown", e => { if (e.key !== "Escape") return; if (carry) putDown(null); else if (state.drawer) setDrawer(null); });
// capture: while a player is carried, the click is the drop; a click on a player lifts him
document.addEventListener("click", e => {
  if (swallow) { swallow = false; e.preventDefault(); e.stopPropagation(); return; }
  if (carry) { e.preventDefault(); e.stopPropagation(); putDown(e.target.closest?.(FREE) || null); return; }
  const b = e.target.closest?.(".ros [data-lift]");
  if (!b) return;
  e.stopPropagation();
  const li = b.closest("li"), r = li.getBoundingClientRect();
  lift(li, e.clientX || r.left + 24, e.clientY || r.top + r.height / 2, true);
}, true);

document.addEventListener("submit", async e => {
  const f = e.target.closest("form[data-form]");
  if (!f) return;
  e.preventDefault();
  const btn = f.querySelector('button[type="submit"]');
  if (btn.disabled) return;  // double click: the first submit is still saving
  btn.disabled = true;
  if (f.dataset.form === "training") { await createTraining(f); btn.disabled = false; await loadEvent(); return; }
  if (f.dataset.form === "merit") { await addMerit(f); btn.disabled = false; return; }
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
    ? await sb.from("events").insert({ strategy_id: sid, variant: zone, doctrine: ["swarm", "cw"].includes(v.doctrine) ? v.doctrine : "defence", starts_at: new Date(v.starts).toISOString(), open_to_hosts: !!v.open_to_hosts })
    : f.dataset.form === "mapteam" ? await sb.from("events").update({ strategy_id: sid, variant: zone, open_to_hosts: !!v.open_to_hosts }).eq("id", eventId).select("id")  // count rows like cancelEvent (OWASP L1)
    : await sb.from("events").update({ status: "closed", placement: Number(v.placement), variant: v.variant || null, weather: v.weather || null,
        went_well: v.went_well || null, went_wrong: v.went_wrong || null, next_time: v.next_time || null }).eq("id", eventId);
  const msg = error ? (error.code === "23505" ? "Už je otevřená jiná akce." : saveErr(error))
    : f.dataset.form === "mapteam" && !data.length ? "Mapu a tým se nepodařilo uložit: akce už není otevřená, nebo nemáš práva Commandera." : null;
  if (f.dataset.form === "new") state.novaFlash = msg; else state.flash = msg;
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
// the event's SWARM roster (Petr 2026-10-22, specs/akce-v2 A6): {squads: [{kit: count}], vehicles: {kit: [open seats of
// each vehicle]}}; an event from before 017 keeps its Swarm sizes and vehicle counts with every seat open
function rosterOf(ev) {
  if (ev.roster) return ev.roster;
  // the default draft (Petr 2026-10-25 D33, 2026-10-28): Public Ops [cw] squady, SWARM core + Swarm; the Commander reworks it
  const t = D.doktrina.swarm.sestava;
  return { squads: ev.doctrine === "cw" ? D.doktrina.cw.squady.map(q => ({ ...q })) : Array.from({ length: t.squads }, (_, i) =>
      ({ [t.core[0].kit]: 1, [t.core[1].kit]: 1, [t.swarm.kit]: (ev.squad_swarm && ev.squad_swarm[i]) || t.swarm.default })),
    vehicles: Object.fromEntries(t.podpora.map((p, i) => [p.kit, Array(ev.squad_support?.[i] ?? p.default).fill(p.seats.length)])) };
}
// Velení (Petr 2026-10-28: "misto Commandera v lobby ... bud jeden, nebo druhy, nebo oba, v budoucnu ... i Juro"): the
// command's places first in the lobby, 2 unless the roster says otherwise (039: 0-4)
const CMD_DEFAULT = 2, CMD_MAX = 4;
const cmdCount = r => r.cmd ?? CMD_DEFAULT;
// keys stay as before 017, so sign-ups survive the switch: SW-Q<squad>-<KIT><n> (the first without n), and seat i of
// vehicle v is SW-<KIT><(v-1)*all seats + i> (a closed optional seat is just a key not offered)
// the roles a squad may hold: SWARM's kits; CW the Vybava roles only (Petr 2026-10-25, migration 028; 2026-10-28 no Swarm
// "ani teoreticky", the database refuses it: 035)
const squadRoles = cw => cw ? D.doktrina.cw.roles : D.doktrina.swarm.sestava.roles;
function swarmRoster(k, r, cw = false) {
  const t = k.sestava;
  const cmd = { id: "CMD", name: "Velení", symbol: "hq", cmdg: true, max: cmdCount(r),
    slots: Array.from({ length: cmdCount(r) }, (_, i) => ({ key: `SW-CMD${i + 1}`, label: "Commander", role: null, kit: "CM", stat: "Commander" })) };
  return [cmd, ...r.squads.map((sq, idx) => { const n = idx + 1;
    const slots = squadRoles(cw).flatMap(ro => Array.from({ length: sq[ro.kit] || 0 }, (_, i) => ({ key: `SW-Q${n}-${ro.kit}${i ? i + 1 : ""}`, label: ro.label, role: null, kit: ro.kit, stat: ro.label,
      cls: ro.class, sqd: ro.squad })));
    const recon = slots.length && slots.every(x => x.kit === "RC" || x.kit === "RS");
    return { id: `Q${n}`, name: (r.names && r.names[idx]) || `Squad ${n}`, symbol: recon ? "recon" : "infantry", max: slots.length, idx, sq, slots };
  }).filter(g => g.slots.length), ...t.podpora.flatMap((p, ti) => { const g = podporaGroup([p], r.vehicles, ti), cars = g.vehicles[0].cars;
    // every tank its own squad (Petr 2026-10-25: "co tank to squad"); + / - for tanks on the last one
    return p.kit !== "TK" || !cars.length ? [g] : cars.map((c, i) => ({ ...g, id: `POD-TK-${c.v + 1}`, name: c.name, max: c.slots.length, slots: c.slots,
      vehicles: [{ ...g.vehicles[0], cars: [c] }], ctl: i === cars.length - 1, all: cars })); })];
}
function podporaGroup(types, vehicles, base = 0) {
  const vs = types.map((t, i) => { const list = (vehicles && vehicles[t.kit]) || [];
    return { ...t, ti: base + i, n: list.length, cars: list.map((open, v) => ({ name: `${t.name} ${v + 1}`, v, open, slots: t.seats.slice(0, open).map((seat, i) =>
      ({ key: `SW-${t.kit}${v * t.seats.length + i + 1}`, label: seat, role: null, kit: t.kit, seat, car: `${t.name} ${v + 1}`, stat: `${t.name} · ${seat}` })) })) }; });
  const slots = vs.flatMap(t => t.cars.flatMap(c => c.slots));
  // each vehicle type is its own squad (Petr 2026-10-25 D20: tank, logi heli, combat heli, artillery)
  return { id: `POD-${vs[0].kit}`, name: vs[0].name, symbol: vs[0].symbol, max: slots.length, vehicles: vs, slots };
}
const swarmPlan = ev => ({ id: ev.doctrine, swarm: true, cw: ev.doctrine === "cw", roster: swarmRoster(D.doktrina.swarm, rosterOf(ev), ev.doctrine === "cw"), fill_order: [], variants: [] });
// FORTRESS before the map (specs/akce-mapa-tym): all plans share the 45 slots (test_build), so sign-ups keep their slot
// when the map comes; role cards, zones and the map's plan wait for the map and team
const fortressPlan = () => { const s = D.strategies[0];
  return { id: "fortress", nomap: true, roster: s.roster, fill_order: s.fill_order, roles: s.roles, variants: [] }; };
// FORTRESS (Petr 2026-10-22, specs/akce-v2 A8): a hidden group is gone, a role switched off is gone, the free places
// ("člen", "stavitel") as many as set; the plan object stays untouched (Mapy read it)
function shapedRoster(roster, r) {
  const gs = r && r.groups;
  if (!gs) return roster;
  return roster.map(g => { const c = gs[g.id] || {};
    if (c.hide) return null;
    const free = g.slots.filter(x => !x.role), label = free.length ? free[0].label : "člen", n = c.extra ?? free.length;
    const slots = [...g.slots.filter(x => x.role && !(c.off || []).includes(x.role)), ...Array.from({ length: n }, (_, i) => ({ key: `${g.id}+${i + 1}`, label, role: null }))];
    return { ...g, max: slots.length, slots };
  }).filter(Boolean);
}
const fortressOf = (s, ev) => s && { ...s, roster: shapedRoster(s.roster, ev.roster), base: s.roster };
const planOf = ev => !ev ? null : isSq(ev) ? swarmPlan(ev) : fortressOf(!ev.strategy_id ? fortressPlan() : S(ev.strategy_id), ev);
// doctrine names live in the content (Petr 2026-10-19: FORTRESS, SWARM); events store "defence" / "swarm"
const docOf = d => d === "swarm" ? D.doktrina.swarm : d === "cw" ? D.doktrina.cw : D.doktrina.defence;
// squads and vehicles: SWARM (Fun) and CW (Clan War) share the roster shape (Petr 2026-10-25, hub/specs/doktriny-fun-cw)
const isSq = ev => ev.doctrine === "swarm" || ev.doctrine === "cw";
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
const OLD_ROLE = { sniper: "recon", spotter: "recon", marksman: "recon", "logistics-ground": "logistics", "logistics-air": "air-logistics" };  // Vybava v3 (D24), Marksman gone (D35)
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
    artillery: '<circle cx="24" cy="18" r="5"/>',
  }[kind] || "";
  return `<svg class="sym ${cls}" viewBox="0 -6 48 50" aria-hidden="true"><circle class="ech" cx="24" cy="0" r="2.4"/><rect x="6" y="6" width="36" height="24"/>${icon}</svg>`;
}
// a role in the lobby (Petr 2026-10-28 "kazda role jinou barvu ... ikonky symbolicky v designu War Roomu"): the APP-6
// friendly frame with the role's branch mark, stroked in the role's hue (--rc from .ro-<kit>, DESIGN.md Role Hue exception)
const ROLE_MARK = {
  RF: "M2 2 L22 14 M22 2 L2 14", MK: "M12 4 V6.5 M12 9.5 V12 M7 8 H9.5 M14.5 8 H17 M15 8 A3 3 0 1 1 9 8 A3 3 0 1 1 15 8",
  RK: "M3 14 L12 3 L21 14", GR: "M12 6.5 V4 H15 M14.5 10 A2.5 2.5 0 1 1 9.5 10 A2.5 2.5 0 1 1 14.5 10", MD: "M12 3.5 V12.5 M7.5 8 H16.5",
  HM: "M12 13 V3.5 M9 6.5 L12 3.5 L15 6.5 M8 10 H16", BD: "M6 5 H18 M6 5 V11 M12 5 V11 M18 5 V11", RC: "M2 14 L22 2", LG: "M2 11 H22",
  SW: "M7 8 H7.1 M12 8 H12.1 M17 8 H17.1", AA: "M6 13 A6 6 0 0 1 18 13",
  CM: "M12 2.8 L13.6 6.4 H17.4 L14.3 8.7 L15.5 12.4 L12 10.1 L8.5 12.4 L9.7 8.7 L6.6 6.4 H10.4 Z",  // the command's star
};
ROLE_MARK.AT = ROLE_MARK.RK; ROLE_MARK.RS = ROLE_MARK.RC; ROLE_MARK.MG = ROLE_MARK.HM;
const roleMark = kit => `<svg class="rmark" viewBox="0 0 24 16" aria-hidden="true"><rect x="1" y="1" width="22" height="14"/><path d="${ROLE_MARK[kit] || ""}"/></svg>`;
const plus = () => '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2 V14 M2 8 H14"/></svg>';
const minus = () => '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8 H14"/></svg>';
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
  const circles = s.variants.filter(v => v.xy).map(v => `<circle class="cz${v.id === vid ? " on" : ""}" cx="${v.xy[0]}" cy="${v.xy[1]}" r="${v.r}"/>`).join("");
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
  const more = state.ops.filter(x => x.id !== ev.id).map(x => `<a class="trnext" href="#/akce/${x.id}"><span class="ref">Operace</span><span>${esc(docName(x.doctrine))} · ${esc(fmtWhen(x.starts_at))}</span></a>`).join("");
  const mine = myPlace(state.claims);
  const said = (state.rsvps || []).find(r => r.user_id === state.me.user_id);
  const status = mine ? `Máš místo: ${esc(mine.slot_label)}` : said ? `Tvoje odpověď: ${esc((RSVP.find(x => x[0] === said.status) || [, said.status])[1])}` : "Zatím bez odpovědi a bez místa: otevři sestavu";
  return `<a class="cont evc" href="#/akce/${ev.id}"><span class="big">Operace</span><span>${esc(fmtWhen(ev.starts_at))} · ${sideOf(ev.strategy_id, NOPICK)} · ${esc(docName(ev.doctrine))}<small>${status}</small></span></a>${more}${next}`;
}

// specs/mapy-v3 (Petr 2026-10-25 D34): the 3 maps; a map's page picks team and zone, then shows the battle plan of that
// combination (no doctrine, no Fortress plan). Read-only: no open event changes it, roles are claimed in Akce.
const MAPS = () => [...new Set(D.strategies.map(x => x.map))];
const teamKey = x => x.id.slice(x.id.indexOf("-") + 1);  // "ozeti-modri" -> "modri"
const mapSlug = m => D.strategies.find(x => x.map === m).id.split("-")[0];
const mapOf = slug => MAPS().find(m => mapSlug(m) === slug);
const mapHref = (m, o = {}) => { const q = new URLSearchParams(Object.entries(o).filter(([, v]) => v)).toString(); return `#/mapy/${mapSlug(m)}${q ? "?" + q : ""}`; };
const planHref = x => mapHref(x.map, { t: teamKey(x), v: curVariant });
const mapsList = () => `<ul class="cls maps">${MAPS().map(m => { const xs = D.strategies.filter(x => x.map === m);
  return `<li><a href="${mapHref(m)}"><b>${esc(m)}</b><span>${xs.length} týmy · ${xs[0].variants.length} zóny</span></a></li>`; }).join("")}</ul>`;
function viewMapDetail(m, qs) {
  const q = new URLSearchParams(qs), xs = D.strategies.filter(x => x.map === m), x = xs.find(y => teamKey(y) === q.get("t")) || null;
  const v = x && x.variants.find(y => y.id === q.get("v")) || null, w = v && D.bitvy.pocasi.some(y => y.id === q.get("w")) ? q.get("w") : "";
  const step = (label, cur, opts) => `<div class="vbar mapstep" role="group" aria-label="${label}"><span class="vlbl">${label}</span>${opts.map(([val, name, sub, href]) =>
    `<a href="${href}"${val === cur ? ' aria-current="true"' : ""}><b>${esc(name)}</b>${sub ? `<small>${esc(sub)}</small>` : ""}</a>`).join("")}</div>`;
  const steps = step("Tým", x && teamKey(x), xs.map(y => [teamKey(y), y.color, y.faction, mapHref(m, { t: teamKey(y), v: y.variants.some(z => z.id === q.get("v")) ? q.get("v") : null, w })]))
    + (x ? step("Zóna", v && v.id, x.variants.map(y => [y.id, y.name, y.xy ? `${y.towers.length} věže` : "střed doplníme", mapHref(m, { t: teamKey(x), v: y.id, w })])) : "")
    + (v ? step("Počasí", w, [["", "Každé počasí", ""], ...D.bitvy.pocasi.map(y => [y.id, y.label, y.id])].map(([val, n, sub]) => [val, n, sub, mapHref(m, { t: teamKey(x), v: v.id, w: val })])) : "");
  const head = `<p class="crumb"><a href="#/mapy">Mapy</a> / ${esc(m)}</p>
    <header class="unit-head"><div><h1>${esc(m)}</h1><p>Vyber tým a zónu. Plán je pro Clan War, Public Ops z něj vychází.</p></div></header>${steps}`;
  return head + (v ? viewBattle(x, v, w) : `<p class="note mapnext">Dál vyber ${x ? "zónu" : "tým"}.</p>`);
}

// the battle plan of one map x team x zone (hub/specs/mapy-v3 M3-M5): content/bitvy.toml; the zone's plan, its weather
// plan winning only where it has something, and the map+team plan (zone "") under every zone; the zone sketch when the
// zone has a centre; empty sections say they are still to be filled
function viewBattle(x, v, w) {
  const all = D.bitvy.plany.filter(p => p.strategy === x.id && (p.zone === v.id || !p.zone));
  const base = all.find(p => p.zone && !p.weather), wp = w && all.find(p => p.zone && p.weather === w), gen = all.find(p => !p.zone && !p.weather);
  const f = k => [wp, base, gen].map(p => p && p[k]).find(a => a && a.length) || null;
  const sec = (h, body) => `<section class="block"><h2>${h}</h2>${body || '<p class="note">Zatím prázdné, doplníme s Jurem.</p>'}</section>`;
  const cil = f("cil"), drzet = f("drzet"), squady = f("squady"), pozn = f("poznamky");
  const nz = [wp, base].find(p => p && p.navrh.length), ng = gen && gen.navrh.length ? gen : null;
  const part = (h, p) => `<h3>${h}</h3>${p.zdroj ? `<p class="note">Zdroj: ${esc(p.zdroj)}</p>` : ""}${bullets(p.navrh)}`;
  const zone = v.xy ? `<div class="vpanel" aria-label="Zóna ${esc(v.name)}">${sketchSvg(x, v.id)}<div class="vtx">
      <p class="vtw">Věže v zóně: ${v.towers.map(t => `<span class="ref">${esc(t.replace("Tower ", "T"))}</span>`).join(" ")}</p>
      <p class="note">Náčrtek z dat metaforge. Kruhy ostatních zón čárkovaně.</p></div></div>`
    : `<p class="note">Zóna ${esc(v.name)}: střed zóny zatím nemáme, plánek doplníme.</p>`;
  return `<div id="bplan">${zone}${w && !wp ? '<p class="note">Pro tohle počasí zatím nic zvláštního, platí obecný plán.</p>' : ""}
    ${sec("Hlavní cíl", cil && `<p>${esc(cil)}</p>`)}
    ${sec("Místa k držení", drzet && `<ul class="bullets">${drzet.map(d => `<li><b>${esc(d.misto)}</b>${d.squad ? ` · ${esc(d.squad)}` : ""}${d.jak ? `: ${esc(d.jak)}` : ""}</li>`).join("")}</ul>`)}
    ${sec("Squady a úkoly", squady && `<ul class="bullets">${squady.map(d => `<li><b>${esc(d.squad)}</b>: ${esc(d.ukol)}</li>`).join("")}</ul>`)}
    ${sec("Poznámky", pozn && bullets(pozn))}
    ${nz || ng ? `<section class="block navrh"><h2>Návrh k zařazení</h2><p class="note">Vytěženo z dřívějšího vědění. Co platí, zařadíme výš, zbytek smažeme.</p>
      ${nz ? part(`Zóna ${esc(v.name)}`, nz) : ""}${ng ? part(`Celá mapa za ${esc(x.color)}`, ng) : ""}</section>` : ""}</div>`;
}

function viewMapy() {
  return `<header class="unit-head"><div><h1>Mapy</h1><p>Battle plan každé mapy podle týmu a zóny, pro Clan War. Jen ke čtení, na akci se zapisuješ v <a href="#/akce">Akci</a>.</p></div></header>
    <section class="block">${mapsList()}</section>`;
}

// the home page (Petr 2026-10-22: "modularnejsi a prehlednejsi stranka s dulezitym infem a rozcestniky" + the Discord's
// useful links + a futuristic crest): the crest in a HUD, then modules: the next event, me, where to go, links, how-to
const HUD = `<svg class="hud" viewBox="0 0 200 200" aria-hidden="true"><circle class="h1" cx="100" cy="100" r="94"/><circle class="h2" cx="100" cy="100" r="84"/>
  <path class="h3" d="M100 6 A94 94 0 0 1 194 100"/><path class="h3 b" d="M100 194 A94 94 0 0 1 6 100"/>
  <g class="ticks">${Array.from({ length: 36 }, (_, i) => `<line x1="100" y1="${i % 3 ? 9 : 4}" x2="100" y2="14" transform="rotate(${i * 10} 100 100)"/>`).join("")}</g></svg>`;
const NAV_TILES = [["akce", "Akce", "Operace, tréninky, zápis a lobby"], ["mapy", "Mapy", "Battle plan podle týmu a zóny"],
  ["vybava", "Výbava", "Tvůj loadout a co odemknout"], ["doktrina", "Doktrína", "Jak klan hraje"], ["vycvik", "Výcvik", "Basic a Advanced Combat Training"], ["pokryti", "Pokrytí", "Kdo co má odemčené"]];
function homeMe() {
  if (!state.me) return "";
  const r = trk || {}, lv = r.levels ? TRACKS.filter(n => n in r.levels).map(n => `<span>${n} <b>${Number(r.levels[n]) || 0}</b></span>`).join("") : "";
  const mine = me.get(), [sid, rid] = (mine || "/").split("/"), ms = S(sid), mr = ms && roleOf(ms, rid);
  return `<section class="hp-mod hp-me"><h2>Ty</h2><a class="hp-who" href="#/hrac/${esc(state.me.discord_id)}"><img src="${esc(state.me.avatar_url)}" alt=""><b>${esc(state.me.name)}</b><span>Tvůj profil</span></a>
    ${trk === undefined ? "" : r.status === "ok" ? `<p class="trk-lv">${lv}</p><a class="act" href="#/vybava">Tvůj loadout ve Výbavě</a>`
      : '<p class="need">Nemáš propojený WARDOGS Tracker: bez něj ti Výbava neukáže, co máš.</p><a class="act" href="#/vybava">Propojit Tracker</a>'}
    ${mr ? `<a class="cont" href="${roleHref(ms, mr)}"><span class="big">${esc(mr.id)}</span><span>Tvoje role na akci<small>${esc(mr.name)} · ${esc(sideLabel(ms))}</small></span></a>` : ""}</section>`;
}
function viewHome() {
  const groups = [...new Set((D.odkazy || []).map(x => x.group))];
  return `
    <div class="home-head"><div class="crest-hud"><img class="crest" src="znacka/kin-emblem.svg" alt="Emblém Kinetic Solutions" width="150" height="150">${HUD}</div>
      <div><p class="hp-k">Kinetic Solutions · KIN</p><h1>War Room</h1>
      <p class="lede">Velitelské centrum klanu: akce, plány map, výbava a doktrína na jednom místě.</p></div></div>
    <div class="hp-grid">
      <section class="hp-mod hp-ev"><h2>Další akce</h2><div id="home-ev">${homeEvent()}</div></section>
      ${homeMe()}
      <section class="hp-mod hp-nav"><h2>Kam dál</h2><ul class="hp-tiles">${NAV_TILES.map(([k, l, sub]) => `<li><a href="#/${k}"><b>${l}</b><span>${sub}</span></a></li>`).join("")}</ul></section>
      ${groups.length ? `<section class="hp-mod hp-links"><h2>Užitečné odkazy</h2>${groups.map(g => `<h3>${esc(g)}</h3><ul>${D.odkazy.filter(x => x.group === g).map(x =>
        `<li><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.name)}${out()}</a>${x.note ? `<small>${esc(x.note)}</small>` : ""}</li>`).join("")}</ul>`).join("")}</section>` : ""}
      <details class="hp-mod howto"${matchMedia("(max-width: 720px)").matches ? "" : " open"}><summary><h2 id="h-start">Jak to tu funguje${arrow()}</h2></summary><ol class="proc">
      <li><span><a href="#/akce">Akce</a>: otevři operaci, dej <b>Přijdu</b> a zaber si místo v sestavě. Pod ní je tvůj nákup, odehrané akce jsou v přehledu.</span></li>
      <li><span><a href="#/mapy">Mapy</a>: battle plan každé mapy podle týmu a zóny (cíl, místa k držení, úkoly squadů), pro Clan War.</span></li>
      <li><span><a href="#/vybava">Výbava</a>: tvůj loadout pro každou sub-classu: co koupit a kolik kusů, podle toho, co máš odemčené (WARDOGS Tracker). Kolik nás co umí, je v <a href="#/pokryti">Pokrytí</a>.</span></li>
      <li><span><a href="#/doktrina">Doktrína</a>: jak klan hraje (${esc(docName("defence"))}, ${esc(docName("swarm"))}) a Výcvik.</span></li>
    </ol></details>
    </div>`;
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

function rxList(s, items, withWho = true) {
  return items.map(x => `<div class="rx"><div class="when">${esc(x.when)}</div><div class="arrow">${arrow()}</div><div class="then">${esc(x.then)}</div>${withWho && x.roles ? `<div class="who">${x.roles.map(ref => refChip(s, ref)).join("")}</div>` : ""}</div>`).join("");
}

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
// how far my step is from the clan's goal (Petr 2026-10-22: the page must frown when I lack the role's best gear):
// ok = the goal, mid = better than the start, low = the start or nothing; optional and free slots are not judged
const grade = (lad, i) => lad.free || lad.optional || !lad.steps.length ? null : i === lad.steps.length - 1 ? "ok" : i > 0 ? "mid" : "low";
const GRADE = { ok: "Cíl klanu", mid: "Lze lépe", low: "Slabé" };
// what fits in my backpack (hub/specs/vybava-batoh, Petr 2026-10-25 D35): mandatory things always go in (over = they do
// not fit); then the optional ones, those dropped last going in first (respirator 3, rounds 2, magazines 1), one stack at
// a time; then `fill` (rockets) while there is room. ponytail: greedy first fit per compartment with rotation, not
// optimal 2D packing -- a hand-packed bag may take one piece more
function packBag(bag, list) {
  const grids = bag.map(([w, h]) => Array.from({ length: h }, () => Array(w).fill(false)));
  const put = ([w, h]) => { for (const g of grids) for (const [a, b] of [[w, h], [h, w]]) for (let y = 0; y + b <= g.length; y++) for (let x = 0; x + a <= g[0].length; x++)
    if (g.slice(y, y + b).every(r => r.slice(x, x + a).every(v => !v))) { for (let i = y; i < y + b; i++) for (let j = x; j < x + a; j++) g[i][j] = true; return true; }
    return false; };
  const out = list.map(e => ({ ...e, want: e.qty, units: 0, over: false })), per = e => e.stack || 1;
  const add = (e, n) => { let k = 0; while (k < n && put(e.grid || [1, 1])) k++; e.units += k; return k === n; };
  const must = out.filter(e => !e.drop && !e.fill).sort((a, b) => (b.grid || [1, 1]).reduce((x, y) => x * y) - (a.grid || [1, 1]).reduce((x, y) => x * y));
  for (const e of must) e.over = !add(e, Math.ceil(e.want / per(e)));
  for (const e of out.filter(e => e.fill)) e.over = !add(e, e.min || 0);
  for (const e of out.filter(e => e.drop).sort((a, b) => b.drop - a.drop)) add(e, Math.ceil(e.want / per(e)));
  for (const e of out.filter(e => e.fill)) while (e.units < 40 && add(e, 1));
  return out.map(e => ({ ...e, qty: e.fill ? Math.max(e.units, e.min || 0) * per(e) : e.drop ? Math.min(e.want, e.units * per(e)) : e.want,
    cut: !!e.drop && e.units * per(e) < e.want }));
}
function myKit(c) {
  const lads = c.ladders || [], entry = lad => { const i = mineIdx(lad); return { lad, st: lad.steps[i] || null, i, g: grade(lad, i), top: lad.steps.at(-1) }; };
  const slots = Object.fromEntries(Object.keys(SLOT_LABEL).map(k => [k, (l => l && entry(l))(lads.find(l => l.slot === k))]));
  // a second primary hangs on the backpack's sling (Combat Sniper, D38; [2] is a pistol): only with a sling backpack, then
  // its magazines and rounds come along like the primary's
  const slingOk = !!(slots.backpack && slots.backpack.st && slots.backpack.st.slings);
  const gun = slots.slot1 && slots.slot1.st, gun2 = slingOk && slots.sling ? slots.sling.st : null, store = [], mq = c.mags || { qty: MAGS };
  for (const g of [gun, gun2]) {
    const mag = g && g.mags && g.mags[g.mags.map(m => !m.unlock || owned(m.item)).lastIndexOf(true)];
    if (mag && mq.qty) store.push({ st: { ...mag, qty: mq.qty, cost: pieceCost(mag, mq.qty) }, g: null, drop: mq.drop });
  }
  for (const lad of lads.filter(l => l.slot === "storage")) {
    // rockets follow my launcher (RPG-7 93mm, MAAWS 84mm), rounds my primary (or the sling's with of: "sling"), `stacks`
    // in stacks of its calibre
    const rk = lad.fill && slots.slot3 && slots.slot3.st && slots.slot3.st.rockets && slots.slot3.st.rockets[0];
    const e = lad.fill ? { lad, st: rk ? { ...rk, qty: lad.min } : null, g: null } : lad.of === "sling" && !gun2 ? { lad, st: null, g: null }
      : entry(lad.of === "sling" ? municeFor(lad, gun2) : lad.group === "Munice" ? municeFor(lad, gun) : lad);
    if (lad.stacks && e.st && e.st.stack) e.st = { ...e.st, qty: lad.stacks * e.st.stack };
    store.push({ ...e, drop: lad.drop, fill: lad.fill, min: lad.min });
  }
  // only roles with packing rules are packed (Rifleman, Rocketeer); a card without a bag in the data keeps its counts
  const bag = slots.backpack && slots.backpack.st && slots.backpack.st.bag;
  if (bag && bag.length && (c.mags || lads.some(l => l.drop || l.fill))) {
    const inBag = store.filter(e => e.st), packed = packBag(bag, inBag.map(e => ({ qty: e.st.qty, stack: e.st.stack, grid: e.st.grid, drop: e.drop, fill: e.fill, min: e.min })));
    inBag.forEach((e, i) => { const x = packed[i]; e.st = { ...e.st, qty: x.qty, cost: pieceCost(e.st, x.qty) }; e.cut = x.cut; e.over = x.over; });
  }
  const all = [...Object.values(slots).filter(Boolean), ...store];
  const have = all.filter(e => e.st);
  // a verdict only on real data: without the Tracker every slot would look red for nothing
  const judged = !!(trk && trk.status === "ok");
  return { slots, slingOk, store: store.filter(e => e.st), judged, graded: judged ? all.filter(e => e.g) : [],
    names: new Set(have.map(e => e.st.item)), cost: have.reduce((a, e) => a + (e.st.cost || 0), 0) };
}
const loadoutCost = c => myKit(c).cost;
function readiness(k) {
  const g = k.graded, ok = g.filter(e => e.g === "ok").length;
  if (!g.length) return "";
  // the nearest unlocks first: the next step of every slot below the goal, cheapest level first
  const next = g.filter(e => e.g !== "ok").map(e => e.lad.steps[e.i + 1]).filter(Boolean).sort((x, y) => x.unlock.level - y.unlock.level).slice(0, 3);
  const all = ok === g.length;
  return `<div class="ready ${all ? "g-ok" : ok * 2 >= g.length ? "g-mid" : "g-low"}"><div class="rd-top"><span class="rd-l">Připravenost role</span><b>${ok} / ${g.length}</b><span class="rd-s">slotů na cíli klanu</span></div>
    <span class="rd-bar" aria-hidden="true">${g.map(e => `<i class="g-${e.g}"></i>`).join("")}</span>
    <p>${all ? "Máš všechno, co klan pro tuhle roli chce." : `Pod cílem klanu: <b>${g.length - ok}</b>. Odemkni: ${next.map(st => `<b>${esc(st.item)}</b> (${unlockText(st.unlock)})`).join(", ")}`}</p></div>`;
}
function loadoutCard(q, c, h = "h2") {
  const k = myKit(c), judged = k.judged;
  const cell = key => { const e = k.slots[key], st = e && e.st, g = judged && e && e.g;
    if (key === "sling" && !k.slingOk) { const b = k.slots.backpack && k.slots.backpack.lad.steps.find(x => x.slings);  // D38: no sling yet
      return `<div class="slot empty"><span class="sl">${SLOT_LABEL.sling}</span><span class="sn miss">Až s batohem se slingem${b ? `<span class="goal"><b>${esc(b.item)}</b> · ${unlockText(b.unlock)}</span>` : ""}</span></div>`; }
    if (e && e.lad.free) return `<div class="slot free"><span class="sl">${SLOT_LABEL[key]}</span><span class="sn">Libovolná zbraň</span><span class="fr-n">Klan ji nepředepisuje: vezmi, co ti sedí.</span></div>`;
    return `<div class="slot${st ? "" : " empty"}${g ? " g-" + g : ""}"${g ? ` title="${GRADE[g]}"` : ""}><span class="sl">${SLOT_LABEL[key]}</span>${st
      ? `${itemIcon(st.icon)}<span class="sn">${esc(st.item)}${g && g !== "ok" ? `<span class="goal">Cíl: <b>${esc(e.top.item)}</b> · ${unlockText(e.top.unlock)}</span>` : ""}</span>${st.cost ? `<span class="pr">${usd(st.cost)}</span>` : ""}`
      : g ? `<span class="sn miss">Chybí<span class="goal">Cíl: <b>${esc(e.top.item)}</b> · ${unlockText(e.top.unlock)}</span></span>` : key === "slot2" ? '<span class="ph">Sidearm</span>' : ""}</div>`; };
  const quick = c.quick.filter(n => k.names.has(n));
  const att = key => { const st = k.slots[key] && k.slots[key].st, bs = st ? (D.doplnky || []).filter(b => b.weapons.includes(st.item)) : [];
    return !bs.length ? "" : `<ul class="lo-att" aria-label="Doplňky ${esc(st.item)}">${bs.flatMap(b => b.slots).map(s => {
      const i = s.items.findIndex(x => !x.unlock || !!(haveSet && haveSet.has(x.item))), x = s.items[Math.max(i, 0)];
      return `<li${i < 0 ? ' class="locked"' : ""}>${itemIcon(x.icon, "sm")}<span class="as">${esc(s.slot)}</span><span class="an">${esc(x.item)}</span>${i < 0 && x.unlock ? `<span class="au">${unlockText(x.unlock)}</span>` : ""}</li>`; }).join("")}</ul>`; };
  return `<article class="loadout" id="${esc(c.id)}">
    <header class="lo-head"><div><${h} class="lo-name"><a href="${classHref(q, c)}">${esc(c.name)}</a></${h}><p>${esc(c.job)}</p>
      <p class="src">${judged ? "Co koupit: nejlepší z toho, co máš odemčené a klan doporučuje." : "Startovní loadout. Propoj WARDOGS Tracker ve <a href=\"#/vybava\">Výbavě</a> a uvidíš svůj."}</p></div></header>
    ${readiness(k)}
    <div class="lo-grid">
      <div><h3>Equipment</h3>${["slot1", "slot2", "slot3", ...(k.slots.sling ? ["sling"] : [])].map(key => cell(key) + (key === "slot1" || key === "sling" ? att(key) : "")).join("")}
        <h3>Gear</h3><div class="lo-gear">${["helmet", "armor", "vest"].map(cell).join("")}</div></div>
      <div><h3>Storage</h3><div class="lo-gear">${["backpack", "traversal"].map(cell).join("")}</div>
        <h3>V batohu</h3>${k.store.length ? `<ul class="lo-store">${k.store.map(e => `<li${judged && e.g ? ` class="g-${e.g}" title="${GRADE[e.g]}"` : ""}>${itemIcon(e.st.icon, "sm")}<span class="q">${e.st.qty}${e.st.cost ? `<span class="pr">${usd(e.st.cost)}</span>` : ""}</span><span class="n">${esc(e.st.item)}${e.over ? '<span class="cut">Nevejde se: kup větší batoh</span>' : e.cut ? '<span class="cut">Víc se nevejde, větší batoh unese víc</span>' : ""}</span></li>`).join("")}</ul>` : '<p class="note">Nic.</p>'}
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

// Petr 2026-10-25 (D17): two doctrines, Fun (SWARM) and CW (Clan War); FORTRESS is gone from the menu
function viewDoktrina(tab, sub) {
  const k = D.doktrina, cur = ["cw", "vycvik"].includes(tab) ? tab : "swarm";
  const tabs = [["swarm", `Fun: ${k.swarm.title}`], ["cw", `PO: ${k.cw.title}`], ["vycvik", "Výcvik"]];
  return `
    <div class="narrow">
    <header class="unit-head"><div><h1>Doktrína</h1><p>Platí pro všechny mapy a barvy. Kterou hrajeme, rozhodne Commander před zápasem.</p></div></header>
    <nav class="tabs" aria-label="Doktrína">${tabs.map(([path, label]) => `<a href="#/doktrina${path && "/" + path}"${path === cur ? ' aria-current="page"' : ""}>${esc(label)}</a>`).join("")}</nav>
    ${cur === "cw" ? viewCw(k.cw) : cur === "vycvik" ? viewVycvik(sub) : viewSwarm(k)}
    </div>`;
}

function viewCw(c) {
  return `<section class="block"><h2>${esc(c.title)}</h2><p class="lede">${esc(c.tagline)}</p>${bullets(c.points)}
    <p class="note">Nákup bereš z loadoutu své role ve <a href="#/vybava">Výbavě</a>.</p></section>`;
}

// ---------- squads + loadouts ----------
const SLOT_LABEL = { slot1: "[1]", slot2: "[2]", slot3: "[3]", sling: "Sling", helmet: "Helmet", armor: "Armor", vest: "Tac-Vest", backpack: "Backpack", traversal: "Traversal" };

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
  const a = document.activeElement, k = a && ["data-tracker", "data-nova", "data-rsvp", "data-trsvp", "data-role", "data-squad", "data-sqdrop", "data-cmd", "data-seat", "data-fx", "data-support"].find(x => a.hasAttribute(x));
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
let trk, trkBusy = false, trkErr = null;  // trk = my row of public.tracker; undefined while it loads (UAT C-02), null = none
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
    <p class="note">Co máš ve hře odemčené a levely rolí bere War Room z <a href="https://wardogstracker.gg" target="_blank" rel="noopener">WARDOGS Trackeru</a> (neoficiální web komunity) sám, každých pár minut.${r.fetched_at ? ` Naposledy ${esc(ago(r.fetched_at))}.` : ""} Když si něco odemkneš, klikni na Trackeru na Update my stats.</p>
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
  // Petr 2026-10-25 (D24, hub/specs/vybava-role-v3): roles in one list, no Assault / Builders / Recon groups
  return `<header class="unit-head"><div><h1>Výbava</h1><p>Tvůj loadout pro každou roli, podle toho, co máš odemčené</p></div></header>
    <p class="note">Kolik nás co má: <a class="act" href="#/pokryti">Pokrytí rolí</a></p>
    ${trackerBox()}
    <section class="block"><h2>Role</h2><ul class="cls">${D.squads.flatMap(q => q.classes.map(c => `<li><a href="${classHref(q, c)}"><b>${esc(c.name)}</b></a></li>`)).join("")}</ul></section>`;
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
  if (lad.free) return `<div class="lad free"><div class="lad-h"><span class="sl">${SLOT_LABEL[lad.slot]}</span></div><p class="fr-n">Libovolná zbraň: klan ji pro tuhle roli nepředepisuje.</p>${lad.note ? `<p class="note">${esc(lad.note)}</p>` : ""}</div>`;
  const have = lad.steps.map(st => !st.unlock || !!(haveSet && haveSet.has(st.item)));
  const reach = lad.steps.map(st => !st.unlock || !!(lv && (lv[st.unlock.track] || 0) >= st.unlock.level));
  const mine = have.lastIndexOf(true), next = reach.indexOf(false, mine + 1);
  const nu = next >= 0 && lad.steps[next].unlock, g = trk && trk.status === "ok" && grade(lad, mine);
  return `<div class="lad${g ? " g-" + g : ""}"><div class="lad-h"><span class="sl">${lad.group ? esc(lad.group) : SLOT_LABEL[lad.slot]}</span>${nu ? `<span class="lad-next">Další: od ${esc(nu.track)} ${nu.level}</span>` : ""}</div>
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
    <div class="lads">${c.ladders.map(lad => ladderBlock(lad.group === "Munice" ? municeFor(lad, (myKit(c).slots.slot1 || {}).st) : lad, lv) + (lad.slot === "slot1" ? doplnkyBlocks(lad) : "")).join("")}</div></section>`;
}
// hub/specs/vybava-doplnky (Petr 2026-10-27): attachments of the weapons in the role's weapon ladder, main first, then
// substitutes; mine = the first of that order I have unlocked
function doplnkyBlocks(lad) {
  const guns = lad.steps.map(st => st.item);
  return (D.doplnky || []).filter(b => b.weapons.some(w => guns.includes(w))).map(b => b.slots.map((s, k) => {
    const mine = s.items.findIndex(x => !x.unlock || !!(haveSet && haveSet.has(x.item)));
    return `<div class="lad dop"><div class="lad-h"><span class="sl">${esc(s.slot)} · ${esc(b.weapons.join(", "))}</span></div>
      <ol class="lad-steps">${s.items.map((x, i) => `<li class="st${i === mine ? " mine" : ""}">${itemIcon(x.icon)}<span class="st-n">${esc(x.item)}</span><span class="st-u">${x.unlock ? `${esc(x.unlock.track)} ${x.unlock.level} · ${usd(x.unlock.cash)}` : "hned"}</span>
        <span class="st-src">${i ? `Náhrada ${i}` : "Hlavní"}</span>${i === mine ? '<span class="st-tag">Tvůj</span>' : ""}</li>`).join("")}</ol>
      ${s.note ? `<p class="note">${esc(s.note)}</p>` : ""}${k ? "" : `<p class="note">${b.note ? esc(b.note) + " " : ""}Zdroj: ${esc(b.source)}.</p>`}
      <details class="lad-why"><summary>Proč</summary><dl>${s.items.map(x => `<dt>${esc(x.item)}</dt><dd>${esc(x.why)}</dd>`).join("")}</dl></details></div>`;
  }).join("")).join("");
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
// Petr 2026-10-29: every member goes through the Basic Combat Training first, then the Advanced (a draft for now); the
// BCT is the shared record the trainer opens at the start and everyone comes back to, so it is in the row 'hub'
function viewVycvik(sub) {
  const v = D.vycvik, act = sub === "act";
  const cards = v.lessons.map(l => `<ol class="drill">${l.cards.map(c => `<li><a class="pic" href="${esc(c.file)}" target="_blank" rel="noopener"><img src="${esc(wv(c.file, 1600))}" srcset="${esc(wv(c.file, 800))} 800w, ${esc(wv(c.file, 1600))} 1600w, ${esc(wv(c.file, 2400))} 2400w" sizes="(min-width: 1360px) 1280px, 100vw" width="2400" height="1500" loading="lazy" alt="${esc(c.title)}: ${esc(c.sub)}"></a>
        <div class="cap"><b>${esc(c.title)}</b><span>${esc(c.sub)}</span><a class="dl" href="${esc(c.file)}" download>PNG pro Discord</a></div></li>`).join("")}</ol>`).join("");
  return `<nav class="tabs vy-tabs" aria-label="Výcvik"><a href="#/vycvik"${act ? "" : ' aria-current="page"'}>Basic Combat Training</a><a href="#/vycvik/act"${act ? ' aria-current="page"' : ""}>Advanced Combat Training</a></nav>
    ${act ? `<p><span class="draft">DRAFT</span> Rozpracované, finalizuje se po BCT.</p><article class="proto">${v.act}</article>`
      : `<article class="proto">${v.bct.replace("<p>[[formace]]</p>", cards)}</article>`}`;
}

// ---------- historie (uzavřené akce, hráči; jen pro přihlášené členy, data chrání RLS) ----------
const HIST = ["historie", "akce", "hrac", "pokryti", "ukoly"];
const plural = (n, one, few, many) => `${n} ${n === 1 ? one : n >= 2 && n <= 4 ? few : many}`;
// local calendar date (like fmtWhen), so a 00:30 event on the start day lands in the new season
const seasonOf = iso => { const d = new Date(iso).toLocaleDateString("sv-SE"); let s = null; for (const x of D.seasons) if (x.start <= d) s = x; return s; };
const seasonName = s => s ? s.name : "Před sezónami";
const place = n => n ? `${n}.` : "-";
// specs/akce-mapa-tym: the team as in the game, official name and colour; no logo (EULA 5.2(j), knowledge/tymy-s2.md)
const teamOf = id => D.tymy.find(t => t.id === id);
// the team's in-game emblem (icons/tym-<id>.webp, Petr 2026-10-25) as a mask, painted in the team's colour
const teamStyle = t => `--tc:${esc(t.hex)};--tl:url(icons/tym-${esc(t.id)}.webp)`;
const teamBadge = id => { const t = teamOf(id); return t ? `<span class="team" style="${teamStyle(t)}">${esc(t.name)}</span>` : ""; };
// the team as a mark in its colour (no name in the cell; the name for screen readers and on hover)
// history (Petr 2026-10-22): the map and its team's mark, the doctrine in its own column
const mapCell = id => { if (!id) return '<span class="dash">-</span>'; const x = S(id); return x ? `${esc(x.map)} ${teamMark(x.team)}` : esc(id); };
const teamMark = id => { const t = teamOf(id); return t ? `<span class="tmark" style="${teamStyle(t)}" title="${esc(t.name)}" role="img" aria-label="${esc(t.name)}"></span>` : ""; };
// an event's map and team as HTML; null = not picked yet, an id we do not know is shown as stored
// not picked yet: dashed ghost chips like the empty Sidearm slot (DESIGN: dashed = not fixed); a screen reader hears it said
const NOPICK = '<span class="ghost-pick" role="img" aria-label="Mapa a tým zatím nevybrané"><span>Mapa</span><span>Tým</span></span>';
const sideOf = (id, none = "mapa neuvedena") => { if (!id) return none; const s = S(id); return s ? `${esc(s.map)} ${teamBadge(s.team)}` : esc(id); };
// map and team -> their plan; null while either is "zatím nevím" (one strategy_id field, decision 1)
const compose = (map, team) => D.strategies.find(s => s.map === map && s.team === team) || null;
const variantName = (sid, vid) => { const s = S(sid), v = s && vById(s, vid); return v ? v.name : (vid || "-"); };
const memberLink = m => `<a class="mlink" href="#/hrac/${encodeURIComponent(m.discord_id)}" title="${esc(m.name)}"><img src="${esc(m.avatar_url)}" alt="" loading="lazy"><span>${esc(m.name)}</span></a>`;

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
    } else if (p[0] === "ukoly") {
      const [ms, td, tr] = await Promise.all([sb.from("members").select("user_id, discord_id, name, avatar_url").eq("active", true),
        sb.from("tasks_done").select("user_id, task"), sb.from("tracker").select("user_id, status, owned")]);
      for (const r of [ms, td, tr]) if (r.error) throw r.error;
      // ponytail: one progress call per member (~20); a counts view when the clan outgrows it
      const pr = await Promise.all(ms.data.map(m => sb.rpc("progress", { uid: m.user_id })));
      const bad = pr.find(r => r.error); if (bad) throw bad.error;
      html = viewTasks(ms.data, td.data, tr.data, Object.fromEntries(ms.data.map((m, i) => [m.user_id, Array.isArray(pr[i].data) ? pr[i].data[0] : null])));
    } else if (p[0] === "historie") {
      const { data, error } = await sb.from("events").select("id, strategy_id, doctrine, starts_at, variant, placement, weather, claims(count)")
        .eq("status", "closed").eq("kind", "operace").order("starts_at", { ascending: false });  // a closed training is no played event
      if (error) throw error;
      html = viewHistory(data);
    } else if (p[0] === "akce") {
      const id = Number(p[1]);  // #/akce/abc: not an id, so "Akce neexistuje" instead of a database error (Viktor UAT #011)
      const { data: ev, error } = Number.isSafeInteger(id) && id > 0
        ? await sb.from("events").select("id, strategy_id, doctrine, starts_at, status, variant, placement, weather, note, went_well, went_wrong, next_time").eq("id", id).eq("kind", "operace").neq("status", "cancelled").maybeSingle()
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
      const { data: m, error } = await sb.from("members").select("user_id, discord_id, name, avatar_url, active, rank").eq("discord_id", p[1]).maybeSingle();
      if (error) throw error;
      const season = currentSeason();
      const [cl, at, un, pr, me, td, tr] = m ? await Promise.all([
        sb.from("claims").select("slot_label, events!inner(id, strategy_id, starts_at, status)").eq("user_id", m.user_id).eq("events.status", "closed"),
        sb.from("attendance").select("event_id, attended").eq("user_id", m.user_id),  // visible to the Commander and the player only
        season ? sb.from("unlocks").select("item").eq("user_id", m.user_id).eq("season", season.id) : { data: [] },
        sb.rpc("progress", { uid: m.user_id }),  // counts only (019), others' attendance stays private
        sb.from("merits").select("id, text, created_at").eq("user_id", m.user_id).order("created_at"),
        sb.from("tasks_done").select("task").eq("user_id", m.user_id),
        sb.from("tracker").select("status, owned").eq("user_id", m.user_id).maybeSingle(),
      ]) : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: null }];
      if (cl.error) throw cl.error;
      if (at.error) throw at.error;
      if (un.error) throw un.error;
      if (pr.error) throw pr.error;
      if (me.error) throw me.error;
      if (td.error) throw td.error;
      if (tr.error) throw tr.error;
      // no attendance record = played (older events, or the viewer may not see it)
      const absent = new Set(at.data.filter(a => !a.attended).map(a => a.event_id));
      html = m ? viewPlayer(m, cl.data.filter(r => !absent.has(r.events.id)), season, new Set(un.data.map(u => u.item)), Array.isArray(pr.data) ? pr.data[0] : null, me.data || [], new Set(td.data.map(r => r.task)), !!tr.data && tr.data.status === "ok", !!tr.data && tr.data.owned) : '<p class="note">Hráč nenalezen.</p>';
    }
    const t = el(); if (t) t.innerHTML = html;
  } catch (e) {
    console.error(e);  // a raw database error means nothing to a player (OWASP A10, like the login gate)
    const t = el(); if (t) t.innerHTML = '<p class="err">Nepodařilo se načíst. Zkus stránku načíst znovu.</p>';
  }
}

// coverage: who has which unlock this season, and how many of us reached each sub-class's goal
// the ladder that tells a sub-class apart: its weapon, or slot [3] when the weapon ladder is just the start rifle
const keyLadder = c => { const w = c.ladders.find(l => l.slot === "slot1"); return w && w.steps.length > 1 ? w : c.ladders.find(l => l.slot === "slot3") || c.ladders.find(l => l.steps.length > 1) || c.ladders.find(l => l.steps.length); };
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
    <section class="block"><h2>Sub-classy</h2><table class="data cov"><thead><tr><th>Sub-class</th><th>Cíl</th><th class="num">Mají</th></tr></thead><tbody>
    ${D.squads.map(q => q.classes.map(c => { const top = keyLadder(c).steps.at(-1);
      return `<tr><td><a href="${classHref(q, c)}">${esc(q.name)} · ${esc(c.name)}</a></td><td>${esc(top.item)}</td><td class="num"><b>${top.unlock ? users.filter(h => h.has(top.item)).length : users.length}</b></td></tr>`; }).join("")).join("")}
    </tbody></table></section>
    <section class="block"><h2>Kdo má odemčeno</h2><table class="data cov"><thead><tr><th>Předmět</th><th class="num">Mají</th><th>Kdo</th></tr></thead><tbody>
    ${items.map(n => { const ms = byItem[n] || []; return `<tr><td>${esc(n)}</td><td class="num"><b>${ms.length}</b></td><td>${ms.map(memberLink).join(" ")}</td></tr>`; }).join("")}
    </tbody></table></section>`;
}

function viewHistory(evs) {
  // part of Akce since 2026-10-19 (rozhodnuti 8): the open event above, played ones below by season
  const head = `<h2 class="hist-h">Odehrané akce</h2>`;
  if (!evs.length) return `${head}<p class="note">Zatím žádná uzavřená akce.</p>`;
  return head + bySeason(evs, e => e.starts_at).map(({ s, rows }) => `<section class="block"><h2>${esc(seasonName(s))}</h2>
    <table class="data hist"><thead><tr><th>Datum</th><th>Mapa</th><th>Doktrína</th><th class="num">Umístění</th><th class="num">Zapsáno</th><th>Počasí</th></tr></thead><tbody>
    ${rows.map(e => `<tr><td><a href="#/akce/${e.id}">${esc(fmtWhen(e.starts_at))}</a></td><td>${mapCell(e.strategy_id)}</td><td>${esc(docName(e.doctrine))}</td><td class="num"><b>${place(e.placement)}</b></td><td class="num">${e.claims[0] ? e.claims[0].count : 0}</td><td>${esc(weatherName(e.weather))}</td></tr>`).join("")}
    </tbody></table></section>`).join("");
}

// the weather of a played operation (032, Petr 2026-10-26): the label from content/bitvy.toml, "-" when not given
const weatherName = id => !id ? "-" : (D.bitvy.pocasi.find(w => w.id === id) || { label: id }).label;

// one label column for every card of the roster, so the names line up across cards (Petr 2026-10-25)
const lblWidth = groups => `min(${Math.max(...Object.values(groups).flat().map(x => x.role.length)) + 1}ch, 9em)`;

function viewEvent(ev, claims, absent = new Set()) {
  // slot_label was stored at sign-up ("Skupina · Role"), so renamed roles keep their old name here
  const groups = {};
  for (const c of claims) { const [g, ...rest] = c.slot_label.split(" · "); (groups[g] = groups[g] || []).push({ role: rest.join(" · ") || g, m: c.members, away: absent.has(c.user_id) }); }
  const played = claims.length - claims.filter(c => absent.has(c.user_id)).length;
  const debrief = [["Co fungovalo", ev.went_well], ["Co ne", ev.went_wrong], ["Co příště jinak", ev.next_time]].filter(([, t]) => t);
  return `<p class="crumb"><a href="#/akce">Akce</a> / ${esc(fmtWhen(ev.starts_at))}</p>
    <header class="unit-head"><div><h1>${sideOf(ev.strategy_id)} · ${esc(docName(ev.doctrine))}</h1><p>${esc(fmtWhen(ev.starts_at))} · ${esc(seasonName(seasonOf(ev.starts_at)))}${ev.status === "open" ? " · probíhá" : ""}</p></div></header>
    <p class="lede">Umístění <b>${place(ev.placement)}</b> · zóna ${esc(variantName(ev.strategy_id, ev.variant))}${ev.weather ? ` · ${esc(weatherName(ev.weather))}` : ""} · ${played === claims.length ? plural(played, "člověk", "lidé", "lidí") : `hrálo ${played} z ${claims.length} zapsaných`}</p>
    ${debrief.length ? `<section class="block"><h2>Debrief</h2><dl class="debrief">${debrief.map(([h, t]) => `<dt>${h}</dt><dd class="evnote">${esc(t)}</dd>`).join("")}</dl></section>` : ""}
    ${ev.note ? `<section class="block"><h2>Poznámka Commandera</h2><p class="evnote">${esc(ev.note)}</p></section>` : ""}
    <section class="block"><h2>Sestava</h2>${claims.length ? `<div class="ros" style="--lbl: ${lblWidth(groups)}">${Object.entries(groups).map(([g, xs]) => `<div class="rg"><div class="pg-head"><div><b>${esc(g)}</b></div><span class="num">${xs.length}</span></div>
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
    <p class="lede">Odemčené předměty z klanového seznamu: <b>${have.size}</b> · u ${rows.filter(x => x.top).length} z ${D.squads.reduce((a, q) => a + q.classes.length, 0)} sub-class má cíl hlavního žebříčku</p>
    <ul class="cls">${rows.map(x => `<li><a href="${classHref(x.q, x.c)}"><b>${esc(x.c.name)}</b><span>${esc(x.st.item)}${x.top ? " · cíl" : ""}</span></a></li>`).join("")}</ul></section>`;
}

function viewPlayer(m, rows, season, have, prog, merits = [], done = new Set(), trackerOk = false, owned = false) {
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
    ${m.active ? rankCard(m, prog, merits) + tasksCard(m, done, trackerOk, prog, owned) : ""}
    <section class="block"><h2>Celkem</h2>${stats(rows)}</section>
    ${unlockSection(m, season, have)}
    ${bySeason(sorted, r => r.events.starts_at).map(({ s, rows: xs }) => `<section class="block"><h2>${esc(seasonName(s))}</h2>${stats(xs)}
      <p class="note">${xs.map(r => `<a href="#/akce/${r.events.id}">${esc(fmtWhen(r.events.starts_at))}</a>`).join(" · ")}</p></section>`).join("")}`;
}

// ---------- shell ----------
// one item per question a member asks (Petr 2026-10-19, specs/akce-flow rozhodnuti 8)
const NAV = [["akce", "Akce"], ["mapy", "Mapy"], ["vybava", "Výbava"], ["doktrina", "Doktrína"]];
// the Commander's own item after Doktrina (specs/ukoly-velitele U1), with the count of what waits for him
const navCmd = () => !state.me || !state.me.is_commander ? [] : [["moje-ukoly", "Úkoly", state.cmdTasks ? state.cmdTasks.filter(x => x.state === "open").length : 0]];
function renderNav(active) {
  navActive = active;
  const mine = me.get(), [msid, mrid] = (mine || "/").split("/"), ms = S(msid), mr = ms && roleOf(ms, mrid);
  // "Moje role" first and current on my own card: a phone shows ~136 px of the sideways nav (Viktor UAT #005)
  const onMine = mr && location.hash === roleHref(ms, mr);
  document.getElementById("nav").innerHTML =
    (mr ? `<a class="mine" href="${roleHref(ms, mr)}"${onMine ? ' aria-current="page"' : ""}>Moje role<b>${esc(mr.id)}</b></a>` : "") +
    [...NAV, ...navCmd()].map(([k, l, n]) => `<a href="#/${k}"${!onMine && active === k ? ' aria-current="page"' : ""}>${l}${n ? `<b class="nav-n">${n}</b>` : ""}</a>`).join("");
  navToCurrent();
}

function viewAkce() {
  if (state.focusId) return `<p class="crumb"><a href="#/akce">Akce</a> / Operace</p><section class="sestava" id="sestava">${akceBody()}</section>`;
  return `<header class="unit-head"><div><h1>Akce</h1></div></header>
    <section class="sestava" id="sestava">${akceBody()}</section>
    ${histShell(sb && state.me ? '<p class="note">Načítám odehrané akce…</p>' : "")}`;
}
// opening an operation unlocks it (Petr 2026-10-28: "jako herni menu ... nacitalo akci ... animace s vasim animovanym
// logem ... jako otevirajici se zamek, vic otacejicich se prvku ... cool, ale zaroven slick ... od kliku po nastup a
// odchod"): an iris opens from the clicked card, the crest's three rings spin and lock in one by one like a dial, the pins
// slide out, the shackle splits, the crest flashes and the view flies through the lock into the lobby. The route changes
// under the lock, so the lobby loads meanwhile; a click or a key skips; reduced motion goes straight in
const UL_RINGS = `<svg class="ul-rings" viewBox="0 0 400 400" aria-hidden="true">
  <path class="half l" d="M200 388 A188 188 0 0 1 200 12"/><path class="half r" d="M200 12 A188 188 0 0 1 200 388"/>
  <g class="ring r1">${Array.from({ length: 72 }, (_, i) => `<line${i % 6 ? "" : ' class="l"'} x1="200" y1="${i % 6 ? 26 : 20}" x2="200" y2="34" transform="rotate(${i * 5} 200 200)"/>`).join("")}</g>
  <g class="ring r2"><circle cx="200" cy="200" r="150"/><path class="mark" d="M200 42 l-7 -12 h14 z"/></g>
  <g class="ring r3"><circle cx="200" cy="200" r="122"/>${[0, 90, 180, 270].map(a => `<g transform="rotate(${a} 200 200)"><rect class="pin" x="196" y="84" width="8" height="18"/></g>`).join("")}</g>
</svg>`;
let unlocking = null;
const EASE = "cubic-bezier(.16, 1, .3, 1)";
function unlockInto(a, e) {
  const href = a.getAttribute("href"), ev = state.ops.find(x => `#/akce/${x.id}` === href);
  const r = a.getBoundingClientRect(), x = e.clientX || r.left + r.width / 2, y = e.clientY || r.top + r.height / 2;
  const el = document.createElement("div"), T = [], at = (ms, fn) => T.push(setTimeout(fn, ms));
  el.className = "unlock";
  el.innerHTML = `<div class="ul-core"><div class="ul-dial">${UL_RINGS}<img class="ul-crest" src="znacka/kin-emblem.svg" alt=""></div>
    <p class="ul-k">${ev ? esc(docName(ev.doctrine)) : "Operace"}</p><p class="ul-t">${ev ? esc(fmtWhen(ev.starts_at)) : ""}</p><p class="ul-s" role="status">Ověřuji přístup</p></div>`;
  document.body.append(el);
  const $ = s => el.querySelector(s), status = (t, ok) => { $(".ul-s").textContent = t; $(".ul-s").classList.toggle("ok", !!ok); };
  let routed = false, done = false;
  const route = () => { if (!routed) { routed = true; location.hash = href; } };
  const finish = (ms = 380) => {
    if (done) return;
    done = true; T.forEach(clearTimeout); route();
    $(".ul-core").animate([{ transform: "scale(1)", opacity: 1 }, { transform: "scale(2.6)", opacity: 0 }], { duration: ms, easing: "cubic-bezier(.5, 0, .75, 0)", fill: "forwards" });
    el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, delay: ms * .35, easing: "ease-in", fill: "forwards" }).finished.then(() => { el.remove(); unlocking = null; });
    [...$app.children].forEach((c, i) => c.animate([{ opacity: 0, transform: "translateY(18px) scale(.985)" }, { opacity: 1, transform: "none" }],
      { duration: 480, delay: ms * .45 + 60 * i, easing: EASE, fill: "backwards" }));
  };
  unlocking = finish;
  el.addEventListener("click", () => finish(200));
  // in: the iris from the card, the dial rises; the card flashes
  el.animate([{ clipPath: `circle(0px at ${x}px ${y}px)` }, { clipPath: `circle(150vmax at ${x}px ${y}px)` }], { duration: 340, easing: EASE });
  $(".ul-core").animate([{ transform: "scale(.72)", opacity: 0, filter: "blur(6px)" }, { transform: "scale(1)", opacity: 1, filter: "blur(0)" }], { duration: 420, delay: 70, easing: EASE, fill: "backwards" });
  a.animate([{ boxShadow: "0 0 0 2px var(--fr), 0 0 40px var(--fr-glow)" }, { boxShadow: "none" }], { duration: 500, easing: EASE });
  sound("open");
  at(200, route);
  // the dial: each ring spins in from its own side and locks with a click, overshooting a hair
  [["r1", -470, 520], ["r2", 560, 640], ["r3", -690, 760]].forEach(([k, from, ms]) => {
    const g = $(`.${k}`);
    g.animate([{ transform: `rotate(${from}deg)` }, { transform: `rotate(${from > 0 ? -5 : 5}deg)`, offset: .88 }, { transform: "rotate(0deg)" }], { duration: ms, delay: 100, easing: "cubic-bezier(.2, .7, .2, 1)", fill: "backwards" });
    at(100 + ms, () => { g.classList.add("locked"); sound("dial"); });
  });
  at(360, () => status("Načítám sestavu"));
  // unlocked: the pins slide out, the shackle splits, the crest flashes
  at(900, () => {
    status("Odemčeno", true);
    sound("unlock");
    el.querySelectorAll(".pin").forEach(p => p.animate([{ transform: "none", opacity: 1 }, { transform: "translateY(-26px)", opacity: 0 }], { duration: 260, easing: EASE, fill: "forwards" }));
    $(".half.l").animate([{ transform: "none" }, { transform: "translateX(-34px)", opacity: 0 }], { duration: 320, easing: EASE, fill: "forwards" });
    $(".half.r").animate([{ transform: "none" }, { transform: "translateX(34px)", opacity: 0 }], { duration: 320, easing: EASE, fill: "forwards" });
    $(".ul-crest").animate([{ transform: "scale(1)", filter: "brightness(1)" }, { transform: "scale(1.09)", filter: "brightness(1.9)", offset: .3 }, { transform: "scale(1)", filter: "brightness(1)" }], { duration: 420, easing: EASE });
  });
  at(1040, () => finish());
}
document.addEventListener("click", e => {
  const a = e.target.closest?.('a[href^="#/akce/"]');
  if (!a || unlocking || e.defaultPrevented || e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  if (!/^#\/akce\/\d+$/.test(a.getAttribute("href")) || a.getAttribute("href") === location.hash) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;  // straight in
  e.preventDefault();
  unlockInto(a, e);
});
document.addEventListener("keydown", () => { if (unlocking) unlocking(200); });

// the Commander's tasks from the KIN kernel (specs/ukoly-velitele, 037): what waits for him first, newest first; "Odbav ty"
// hands a task to the Claude session running in wardogs (ceo/ukoly.py --vezmi), "Hotovo" closes it. Loaded once after
// login, then on every change in the database (the session closing a task shows here at once)
const TASK_KIND = { plan: "Plán", llm: "Běh", bot: "Bot", strop: "Útrata", uvod: "Kernel" };
const taskKind = x => x.kind === "nalez" ? "Nález" : TASK_KIND[x.typ] || "Úkol";
async function loadCmdTasks(first) {
  const { data, error } = await sb.from("cmd_tasks").select("id, kind, typ, text, state, note, created_at, updated_at").order("created_at", { ascending: false });
  if (error) console.error(error);
  state.cmdTasks = error ? false : data.slice().sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (first) sb.channel("ukoly").on("postgres_changes", { event: "*", schema: "public", table: "cmd_tasks" }, () => loadCmdTasks()).subscribe();
  renderNav(navActive);
  if (location.hash === "#/moje-ukoly") $app.innerHTML = viewCmdTasks();  // in place: a click does not jump to the top
}
async function setTask(id, st) {
  const x = state.cmdTasks.find(y => y.id === id), was = x.state;
  x.state = st; x.updated_at = new Date().toISOString(); state.taskErr = null;
  $app.innerHTML = viewCmdTasks(); renderNav(navActive);
  const { data, error } = await sb.from("cmd_tasks").update({ state: st, updated_at: x.updated_at }).eq("id", id).select("id");
  if (error || !data.length) { x.state = was; state.taskErr = "Úkol se nepodařilo uložit, zkus to znovu."; $app.innerHTML = viewCmdTasks(); renderNav(navActive); }
}
function viewCmdTasks() {
  if (!state.me || !state.me.is_commander) return '<p class="note">Úkoly z kernelu jsou jen pro Commandera.</p>';
  const xs = state.cmdTasks, head = `<header class="unit-head"><div><h1>Úkoly</h1><p class="lede">Co ti posílá KIN kernel. Tlačítko „Odbav ty“ předá úkol Claudovi: vezme si ho session, která právě běží ve wardogs.</p></div></header>`;
  if (xs === undefined) return head + '<p class="note">Načítám…</p>';
  if (xs === false) return head + '<p class="err">Úkoly se nenačetly, obnov stránku (F5).</p>';
  const btn = (x, st, l, cls = "") => `<button type="button" class="act${cls}" data-ctask="${esc(x.id)}:${st}">${l}</button>`;
  const row = x => `<li class="tk" data-task-id="${esc(x.id)}"><div class="tk-meta"><span class="tk-kind">${esc(taskKind(x))}</span><time datetime="${esc(x.created_at)}">${esc(ago(x.created_at))}</time>
      ${x.state === "prace" ? '<span class="tk-st">Rozpracováno</span>' : x.state === "claude" ? '<span class="tk-st">Čeká na session</span>' : ""}</div>
    <div class="tk-body"><p class="tk-text">${esc(x.text)}</p>${x.note ? `<p class="tk-note"><b>Claude:</b> ${esc(x.note)}</p>` : ""}</div>
    <div class="tk-act">${x.state === "open" ? btn(x, "claude", "Odbav ty", " tk-cl") + btn(x, "done", "Hotovo")
      : x.state === "claude" ? btn(x, "open", "Vrátit") + btn(x, "done", "Hotovo") : x.state === "done" ? btn(x, "open", "Otevřít") : ""}</div></li>`;
  const sec = (k, h, list, empty) => `<section class="block tks-sec" data-tsec="${k}"><h2>${h} <span class="num">${list.length}</span></h2>${list.length ? `<ul class="tks">${list.map(row).join("")}</ul>` : `<p class="note">${empty}</p>`}</section>`;
  const done = xs.filter(x => x.state === "done");
  return head + (state.taskErr ? `<p class="err" role="alert">${esc(state.taskErr)}</p>` : "")
    + sec("open", "Čeká na tebe", xs.filter(x => x.state === "open"), "Nic nečeká.")
    + sec("claude", "U Clauda", xs.filter(x => x.state === "claude" || x.state === "prace"), "Claude teď nic nedělá.")
    + `<details class="block tks-sec tks-done" data-tsec="done"><summary><h2>Hotovo <span class="num">${done.length}</span>${arrow()}</h2></summary>${done.length ? `<ul class="tks">${done.map(row).join("")}</ul>` : ""}</details>`;
}
// the Commander's briefing protocol (Petr 2026-10-21 "uvidim to jenom ja"): the row 'velitel' is readable by the
// Commander only (014), so a member gets no data, not just no link; the HTML is built from klan/briefing-protokol.md
async function loadBriefing() {
  const { data, error } = await sb.from("content").select("data").eq("id", "velitel").maybeSingle();
  if (location.hash !== "#/briefing") return;
  $app.innerHTML = `<p class="crumb"><a href="#/akce">Akce</a> / Briefing</p>` + (error ? (console.error(error), '<p class="err">Protokol se nenačetl, obnov stránku (F5).</p>')
    : data && data.data && data.data.briefing ? `<article class="proto">${data.data.briefing}</article>`
    : '<p class="note">Protokol briefingu je jen pro velení.</p>');
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
    <h1>War Room</h1>
    <p class="lede">Plány, role a výcvik klanu Kinetic Solutions. Jen pro členy: přihlas se přes Discord, dovnitř tě to pustí od role Rekrut.</p>
    ${state.error ? `<p class="err">${esc(state.error)}</p>` : ""}
    ${wait ? `<p class="note">${esc(wait)}</p>` : '<button type="button" class="act big" data-login>Přihlásit přes Discord</button>'}
  </section>`;
}

function render() {
  if (!D.strategies) {
    $app.innerHTML = viewGate();
    document.title = "KIN War Room";
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
  let html, active = null, title = "KIN War Room";
  cur = null; trace = null; plan = null;
  if (p[0] !== "akce") { state.focusId = null; focusEvent(); }
  state.drawer = null;  // a panel belongs to the page it was opened on  // elsewhere the nearest operation (home card, bar, Moje role)
  if (p[0] === "s" && S(p[1])) {
    const s = S(p[1]); cur = s; active = "mapy"; curVariant = pickVariant(s, qs);
    const r = p[2] === "role" && roleOf(s, p[3]), g = p[2] === "squad" && groupOf(s, p[3]);
    if (r) { html = viewRole(s, r); title = `${r.id} ${r.name} · KIN`; }
    else if (g) { html = viewSquad(s, g); title = `${g.name} · KIN`; }
    else { location.replace(planHref(s)); return; }  // M6: Discord and briefing links
  } else if (p[0] === "mapy" && mapOf(p[1])) {
    const m = mapOf(p[1]), q = new URLSearchParams(qs), x = D.strategies.find(y => y.map === m && teamKey(y) === q.get("t"));
    cur = x || null; curVariant = x && x.variants.some(y => y.id === q.get("v")) ? q.get("v") : null;
    html = viewMapDetail(m, qs); active = "mapy"; title = `${m} · KIN`;
  } else if (p[0] === "mapy") { html = viewMapy(); active = "mapy"; title = "Mapy · KIN"; }
  else if (p[0] === "squady" || p[0] === "vybava") { html = viewSquads(); active = "vybava"; title = "Výbava · KIN"; }
  else if (p[0] === "squad" && !SQ(p[1]) && classById(Object.hasOwn(OLD_ROLE, p[2]) ? OLD_ROLE[p[2]] : p[2]).length) {  // a link from before Vybava v3 (D24)
    const [q, c] = classById(Object.hasOwn(OLD_ROLE, p[2]) ? OLD_ROLE[p[2]] : p[2]); html = viewClass(q, c); title = `${c.name} · KIN`; active = "vybava";
  } else if (p[0] === "squad" && SQ(p[1])) {
    const q = SQ(p[1]), c = classOf(q, Object.hasOwn(OLD_ROLE, p[2]) ? OLD_ROLE[p[2]] : p[2]); active = "vybava";
    if (c) { html = viewClass(q, c); title = `${c.name} · KIN`; } else { html = viewSquadPage(q); title = `${q.name} · KIN`; }
  } else if (p[0] === "doktrina" || p[0] === "vycvik") {
    const tab = p[0] === "vycvik" ? "vycvik" : p[1], sub = p[0] === "vycvik" ? p[1] : p[2];
    html = viewDoktrina(tab, sub); active = "doktrina"; title = (tab === "cw" ? "Public Ops" : tab === "vycvik" ? (sub === "act" ? "Advanced Combat Training" : "Basic Combat Training") : "SWARM") + " · KIN";
  } else if (p[0] === "akce" && (!p[1] || /^\d+$/.test(p[1]) && (!state.opsLoaded && !state.evErr || state.ops.some(e => e.id === +p[1])))) {
    state.focusId = p[1] ? +p[1] : null; focusEvent();
    plan = planOf(state.event); if (plan && !plan.swarm) curVariant = state.event.variant || pickVariant(plan, qs);
    cur = plan && !plan.swarm && !plan.nomap ? plan : null;  // the build order's role chips trace on this plan
    html = viewAkce(); active = "akce"; title = "Akce · KIN";
    if (sb && state.me && !p[1]) setTimeout(() => loadHist(["historie"]));
  } else if (p[0] === "moje-ukoly") {
    html = viewCmdTasks(); active = "moje-ukoly"; title = "Úkoly · KIN";
  } else if (p[0] === "briefing") {
    active = "akce"; title = "Briefing · KIN";
    html = sb && leadsOps() ? '<p class="note">Načítám…</p>' : '<p class="note">Protokol briefingu je jen pro velení.</p>';
    if (sb && leadsOps()) setTimeout(loadBriefing);
  } else if (HIST.includes(p[0])) {
    active = p[0] === "pokryti" ? "vybava" : p[0] === "ukoly" ? "" : "akce"; title = p[0] === "pokryti" ? "Pokrytí · KIN" : p[0] === "ukoly" ? "Úkoly · KIN" : p[0] === "hrac" ? "Profil · KIN" : "Akce · KIN";
    html = histShell(sb && state.me ? '<p class="note">Načítám…</p>' : histGate());
    if (sb && state.me) setTimeout(() => loadHist(p));
  }
  else html = viewHome();
  if (sb && state.me && state.me.is_commander && !state.cmdAsked) { state.cmdAsked = true; setTimeout(() => loadCmdTasks(true)); }
  $app.innerHTML = html;
  renderDrawers();
  document.title = title;
  renderNav(active);
  renderEvBar();
  applyTrace();
  window.scrollTo(0, 0);
}

$app.addEventListener("click", e => {
  const t = e.target.closest("[data-trace],[data-untrace],[data-variant],[data-claim],[data-unclaim],[data-rsvp],[data-cancel],[data-drawer],[data-role],[data-squad],[data-sqdrop],[data-cmd],[data-seat],[data-fx],[data-leadfor],[data-nocash],[data-merit-del],[data-support],[data-lead],[data-trsvp],[data-tclose],[data-tracker],[data-nova],[data-ctask]");
  if (state.sqArm != null && !(t && t.dataset.sqdrop)) { state.sqArm = null; renderRoster(); }  // a click elsewhere: no drop
  if (!t) return;
  if (t.dataset.ctask) { const [id, st] = t.dataset.ctask.split(":"); setTask(id, st); return; }
  if (t.dataset.trsvp) { const [id, st] = t.dataset.trsvp.split(":"); rsvpTraining(Number(id), st); return; }
  if (t.dataset.tclose) { t.disabled = true; const [id, st] = t.dataset.tclose.split(":"); closeTraining(Number(id), st); return; }
  if (t.dataset.role) { const [i, kit, d] = t.dataset.role.split(":"); setRole(Number(i), kit, Number(d)); return; }
  if (t.dataset.squad) { setSquad(t.dataset.squad); return; }
  if (t.dataset.cmd) { setCmd(Number(t.dataset.cmd)); return; }
  if (t.dataset.sqdrop) { const i = Number(t.dataset.sqdrop), g = plan.roster.find(q => q.sq && q.idx === i);
    // with people in it the first click only asks (the x turns into "Zrušit? vyhodí n"), the second drops
    if (g && g.slots.some(x => state.claims.some(c => c.slot_key === x.key)) && state.sqArm !== i) { state.sqArm = i; renderRoster(); return; }
    setSquad("drop", i); return; }
  if (t.dataset.leadfor) { const [uid, on] = t.dataset.leadfor.split(":"); giveLead(uid, on === "1"); return; }
  if (t.dataset.nocash) { const [uid, on] = t.dataset.nocash.split(":"); setNoCash(uid, on === "1"); return; }
  if (t.dataset.meritDel) { sb.from("merits").delete().eq("id", t.dataset.meritDel).then(({ error }) => { if (error) console.error(error); render(); }); return; }
  if (t.dataset.fx) { const [gid, what, arg] = t.dataset.fx.split(":"); setFortress(gid, what, arg); return; }
  if (t.dataset.seat) { const [kit, v, d] = t.dataset.seat.split(":"); setSeat(kit, Number(v), Number(d)); return; }
  if (t.dataset.support) { const [i, d] = t.dataset.support.split(":").map(Number); setSupport(i, d); return; }
  if (t.dataset.lead) {  // the button flips between "Povedu squad" and "Předat SL": keep focus on my row
    takeLead(t.dataset.lead === "1").then(() => document.querySelector(".ros .slplate [data-lead], .ros li.is-me .rslot")?.focus({ preventScroll: true }));
    return;
  }
  if (t.dataset.drawer) { setDrawer(t.dataset.drawer); return; }
  if (t.dataset.rsvp) { setRsvp(t.dataset.rsvp); return; }
  if (t.dataset.cancel !== undefined) { cancelEvent(t); return; }
  if (t.dataset.tracker !== undefined) { syncTracker().catch(e => console.error(e)); return; }
  if (t.dataset.nova) { novaKind = t.dataset.nova; rerenderKeep(); return; }
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
