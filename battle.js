// The battle behind every page, v2 "vic jako wardogs hra" (Petr 2026-10-22, specs/pozadi-bitva B9-B15): three HQs,
// a Contact Zone in the middle with a yellow Hot Zone always drifting inside it; trucks, cargo helicopters and APCs carry
// supplies and infantry from the HQs to the teams' FOBs, attack helicopters, Kodiaks, tanks, artillery, buggies and ATVs
// fight; a fuelled drill pulls the Hot Zone to its FOB; FOBs, convoys and units get attacked. v3 (Petr 2026-10-22
// odpoledne, B16-B19): the battle comes in waves (calm, artillery preparation, clash on the Hot Zone, retreat) and the
// camera stays on the whole map, cutting close only to a mass fight or a FOB just destroyed, in slow motion.
// Decoration only: at most 30 frames a second, DPR up to 1.5, fewer units on a phone, paused in a hidden tab,
// one still frame for reduced motion.
(() => {
  const cv = document.getElementById("battle");
  if (!cv) return;
  const W = 1600, H = 1000, FPS = 30, YEL = "242,200,75";
  const CZ = { x: 800, y: 540, r: 300 }, HZR = 72, FOB_HP = 40;
  const TEAMS = [
    { id: "blue", name: "MODŘÍ", col: "65,214,238", hq: [210, 880] },
    { id: "red", name: "ČERVENÍ", col: "239,107,91", hq: [1390, 880] },
    { id: "green", name: "ZELENÍ", col: "111,220,140", hq: [800, 95] },
  ];
  // per kind: speed, hp, range, cooldown, hit chance, damage; air flies straight, carry = logistics
  const K = {
    inf: { sp: 24, hp: 2, rg: 140, cd: 1.1, hit: 0.2, dmg: 1 },
    truck: { sp: 55, hp: 3, carry: true },
    cargoheli: { sp: 95, hp: 3, air: true, carry: true },
    apc: { sp: 40, hp: 5, rg: 170, cd: 1, hit: 0.3, dmg: 1, carry: true },
    heli: { sp: 110, hp: 4, air: true, rg: 220, cd: 0.7, hit: 0.35, dmg: 1 },
    kodiak: { sp: 50, hp: 4, rg: 190, cd: 0.8, hit: 0.3, dmg: 1 },
    tank: { sp: 28, hp: 9, rg: 230, cd: 1.6, hit: 0.5, dmg: 3 },
    arty: { sp: 30, hp: 3 },
    buggy: { sp: 75, hp: 2, rg: 160, cd: 0.7, hit: 0.25, dmg: 1 },
    atv: { sp: 85, hp: 1, rg: 130, cd: 0.8, hit: 0.2, dmg: 1 },
  };
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const phone = innerWidth < 720, CAP = phone ? 8 : 16, MASS = phone ? 5 : 8;
  // the battle's waves (B18): name, shortest and longest seconds
  const RHYTHM = [["klid", 16, 24], ["priprava", 9, 14], ["stret", 20, 30], ["ustup", 8, 12]];
  const ROSTER = [...(phone ? ["truck"] : ["truck", "truck"]), "cargoheli", "apc", "heli", "kodiak", "tank", "arty", "buggy", "atv"];
  const ctx = cv.getContext("2d");
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const P = (x, y) => ({ x, y });
  // where a team's road meets the Contact Zone, the middle of that road and the artillery's firing spot on it
  const toward = (tm, f) => { const [hx, hy] = tm.hq, d = Math.hypot(hx - CZ.x, hy - CZ.y); return P(CZ.x + (hx - CZ.x) / d * CZ.r * f, CZ.y + (hy - CZ.y) / d * CZ.r * f); };
  TEAMS.forEach(tm => { tm.home = P(...tm.hq); tm.entry = toward(tm, 1); tm.road = P((tm.home.x + tm.entry.x) / 2, (tm.home.y + tm.entry.y) / 2);
    tm.gun = P(tm.home.x + (tm.entry.x - tm.home.x) * 0.3, tm.home.y + (tm.entry.y - tm.home.y) * 0.3); });

  const st = { frames: 0, fps: 0, kills: 0, respawns: 0, twists: 0, cuts: 0, owners: [], deliveries: { supplies: 0, infantry: 0 },
    fobsBuilt: 0, drillPulls: 0, fobHits: 0, convoyHits: 0, hzTravel: 0, hzOut: 0,
    camWide: 0, camClose: 0, closeups: [], phases: ["klid"], shotsWin: [] };
  let t = 0, owner = -1, control = 0, phase = 0, phaseStart = 0, phaseEnd = rnd(10, 14), nextLook = 0, wideSince = 0, lastClose = -99;
  let ents = [], tracers = [], blasts = [], shells = [], banner = null, flash = 0;
  let cam = { x: W / 2, y: H / 2, z: 1, dz: 0.002, label: "CAM 1 · CELÁ MAPA", close: false, until: 0 };
  const PH = () => RHYTHM[phase][0];
  // who joins the waves; logistics, helicopters and raiding buggies keep going all the time (the map never stands still)
  const fighter = e => ["inf", "kodiak", "tank", "atv"].includes(e.k) || (e.k === "buggy" && e.mode !== "raid");
  const shot = () => { const w = Math.floor(t / 10); while (st.shotsWin.length <= w) st.shotsWin.push(0); st.shotsWin[w]++; };
  const hz = { x: CZ.x, y: CZ.y, tx: CZ.x, ty: CZ.y, until: 0, drill: null };

  // two FOB places per team on its side of the Contact Zone; built from supplies, a drill once standing
  const fobs = TEAMS.flatMap((tm, i) => [-0.5, 0.5].map(da => { const a = Math.atan2(tm.hq[1] - CZ.y, tm.hq[0] - CZ.x) + da;
    return { t: i, x: CZ.x + Math.cos(a) * CZ.r * 0.62, y: CZ.y + Math.sin(a) * CZ.r * 0.62, build: 0, hp: FOB_HP, fuel: 0, on: false, down: 0 }; }));
  const say = text => { banner = { text, life: 4 }; st.twists++; };

  const gate = tm => P(tm.home.x + (tm.entry.x - tm.home.x) * 0.12, tm.home.y + (tm.entry.y - tm.home.y) * 0.12);
  const spawn = (e, at) => Object.assign(e, { x: at.x + rnd(-18, 18), y: at.y + rnd(-18, 18), hp: K[e.k].hp, cd: rnd(0, 1), dead: 0, mode: "go", wp: [], cargo: null, wait: rnd(0, 3), ttl: 0, stage: null });
  const add = (ti, k, at) => { const e = spawn({ t: ti, k }, at || gate(TEAMS[ti])); ents.push(e); return e; };
  TEAMS.forEach((tm, i) => { ROSTER.forEach(k => add(i, k)); for (let n = 0; n < (phone ? 3 : 6); n++) add(i, "inf"); });

  const myFob = e => { const own = fobs.filter(f => f.t === e.t && !f.down); return own.sort((a, b) => (b.build < 1) - (a.build < 1) || a.fuel - b.fuel)[0] || fobs.find(f => f.t === e.t); };
  const road = (e, dest) => K[e.k].air ? [dest] : [TEAMS[e.t].entry, dest];
  const inCZ = p => dist(p, CZ) < CZ.r;
  // what each kind does when it has nowhere to be (a fresh plan after reaching the last waypoint)
  const plan = e => {
    const tm = TEAMS[e.t], k = e.k, hzp = () => P(hz.x + rnd(-HZR, HZR) * 0.7, hz.y + rnd(-HZR, HZR) * 0.7);
    const foe = () => TEAMS[pick([0, 1, 2].filter(i => i !== e.t))];
    if (K[k].carry) {
      if (e.mode === "out") return deliver(e);
      if (e.mode === "back" || e.mode === "go") {
        const g = gate(tm);
        if (dist(e, g) > 40) { e.mode = "back"; e.wp = K[k].air ? [g] : [tm.entry, g].filter(p => inCZ(e) || p === g); return; }
        const inf = ents.filter(x => x.t === e.t && x.k === "inf" && !x.dead).length;
        e.cargo = k === "apc" || (inf < CAP && Math.random() < 0.4) ? "inf" : "sup";
        e.fob = myFob(e); e.mode = "out"; e.wait = rnd(2, 4); e.wp = road(e, P(e.fob.x, e.fob.y));
      }
      return;
    }
    if (k === "arty") { e.wp = dist(e, tm.gun) > 10 ? [tm.gun] : []; return; }
    if (k === "heli") {  // a sortie over an enemy road (convoys) or the Hot Zone, circling until fuel runs low
      if (e.mode === "sortie" && e.ttl > 0) { e.wp = [P(e.x + rnd(-120, 120), e.y + rnd(-120, 120))]; return; }
      if (e.mode === "sortie") { e.mode = "back"; e.wp = [gate(tm)]; return; }
      if (e.mode === "back") { e.mode = "ready"; e.wait = 6; return; }
      e.mode = "sortie"; e.ttl = 25; e.wp = [Math.random() < 0.5 ? foe().road : hzp()]; return;
    }
    if (k === "buggy") {  // ambush on an enemy supply road, then the Hot Zone, then maybe another ambush
      if (e.mode === "raid" && e.ttl > 0) { e.wait = 1; return; }
      if (e.mode !== "raid" && Math.random() < 0.5) { e.mode = "raid"; e.ttl = 35; e.wp = [foe().road]; return; }
      e.mode = "hz";
    }
    if (PH() !== "stret" && fighter(e)) {  // B18: outside the clash the fighters gather at their own way into the Contact Zone
      e.stage = e.stage || P(toward(tm, 0.78).x + rnd(-45, 45), toward(tm, 0.78).y + rnd(-45, 45));
      if (dist(e, e.stage) > 25) e.wp = inCZ(e) ? [e.stage] : road(e, e.stage); else e.wait = rnd(1, 2);
      return;
    }
    if (k === "tank") { const f = fobs.filter(f => f.t !== e.t && !f.down && f.build > 0).sort((a, b) => dist(a, e) - dist(b, e))[0];
      e.wp = inCZ(e) ? [f ? P(f.x + rnd(-60, 60), f.y + rnd(-60, 60)) : hzp()] : road(e, f ? P(f.x, f.y) : hzp()); return; }
    e.wp = inCZ(e) ? [hzp()] : road(e, hzp());  // infantry, Kodiak, ATV: into the fight for the Hot Zone
  };
  const deliver = e => {
    const f = e.fob;
    if (e.cargo === "sup") { if (f.down) f.down = 0.01; if (f.build < 1) f.build = Math.min(1, f.build + 0.5); else f.fuel += 45; st.deliveries.supplies++; }
    else { const n = Math.min(e.k === "apc" ? 4 : 3, CAP - ents.filter(x => x.t === e.t && x.k === "inf" && !x.dead).length);
      for (let i = 0; i < n; i++) add(e.t, "inf", P(f.x, f.y)); if (n > 0) st.deliveries.infantry++; }
    e.cargo = null; e.mode = "back"; e.wait = rnd(1, 2); e.wp = road(e, gate(TEAMS[e.t]));
  };
  const kill = e => {
    blasts.push({ x: e.x, y: e.y, r: 0, max: e.k === "inf" ? 20 : 42, life: 0.7 });
    st.kills++;
    if (e.k === "inf") e.gone = true; else e.dead = rnd(8, 14);
  };
  const hurt = (e, d) => { if ((e.hp -= d) <= 0) kill(e); };
  const hitFob = (f, d) => {
    st.fobHits++; f.hp -= d;
    if (f.hp <= 0 && !f.down) { f.down = 20; f.build = 0; f.on = false; f.fuel = 0; f.hp = FOB_HP; blasts.push({ x: f.x, y: f.y, r: 0, max: 80, life: 1 });
      if (hz.drill === f) hz.drill = null; say(`FOB ZNIČENA · ${TEAMS[f.t].name}`);
      if (!cam.close && t - lastClose >= 15) closeUp({ x: f.x, y: f.y, n: 0, teams: 0 }, "fob"); }
  };

  const step = dt => {
    t += dt;
    if (t >= phaseEnd) nextPhase();
    if (cam.close) { st.camClose += dt; if (t >= cam.until) wide(); }
    else if ((st.camWide += dt) && t >= nextLook) {  // the clash builds up on the whole map first, then a close-up
      nextLook = t + 1;
      const m = PH() === "stret" && t - phaseStart >= 6 && t - wideSince >= 8 && t - lastClose >= 15 && massFight();
      if (m) closeUp(m, "stret");
    }
    cam.z = Math.min(2.6, cam.z + cam.dz * dt);
    flash = Math.max(0, flash - dt);
    if (banner && (banner.life -= dt) <= 0) banner = null;
    // FOBs: rebuild after a loss, grow while our people stand by, a fuelled drill switches on and pulls the Hot Zone
    for (const f of fobs) {
      if (f.down && (f.down -= dt) <= 0) f.down = 0;
      if (f.down) continue;
      if (f.build < 1 && ents.some(e => e.t === f.t && !e.dead && dist(e, f) < 70)) f.build = Math.min(1, f.build + dt * 0.03);
      if (f.build >= 1 && !f.built) { f.built = true; st.fobsBuilt++; }
      if (f.build < 1) { f.built = false; continue; }
      if (!f.on && f.fuel >= 20 && Math.random() < dt * 0.15) { f.on = true; hz.drill = f; st.drillPulls++; say(`DRILL ZAPNUTÝ · ${TEAMS[f.t].name}`); }
      if (f.on && (f.fuel -= dt * 1.5) <= 0) { f.on = false; f.fuel = 0; if (hz.drill === f) hz.drill = null; }
    }
    // the Hot Zone drifts slowly; a working drill calls it over; it never leaves the Contact Zone
    if (hz.drill) { const d = dist(hz.drill, CZ), lim = CZ.r - HZR - 6, k = d > lim ? lim / d : 1; hz.tx = CZ.x + (hz.drill.x - CZ.x) * k; hz.ty = CZ.y + (hz.drill.y - CZ.y) * k; }
    else if (t >= hz.until || Math.hypot(hz.tx - hz.x, hz.ty - hz.y) < 5) { const a = rnd(0, Math.PI * 2), r = rnd(0, CZ.r - HZR - 6); hz.tx = CZ.x + Math.cos(a) * r; hz.ty = CZ.y + Math.sin(a) * r; hz.until = t + rnd(25, 40); }
    const hd = Math.hypot(hz.tx - hz.x, hz.ty - hz.y), hm = Math.min(hd, (hz.drill ? 16 : 9) * dt);
    if (hd > 0.01) { hz.x += (hz.tx - hz.x) / hd * hm; hz.y += (hz.ty - hz.y) / hd * hm; st.hzTravel += hm; }
    if (dist(hz, CZ) + HZR > CZ.r + 0.5) st.hzOut++;

    const live = ents.filter(e => !e.dead && !e.gone);
    for (const e of ents) {
      if (e.gone) continue;
      if (e.dead) { if ((e.dead -= dt) <= 0) { spawn(e, gate(TEAMS[e.t])); st.respawns++; } continue; }
      const k = K[e.k];
      if (e.ttl && (e.ttl -= dt) <= 0) { e.ttl = 0; e.wp = []; }
      if (e.wait > 0) e.wait -= dt;
      else if (!e.wp.length) plan(e);
      else { const p = e.wp[0], d = dist(e, p), sp = k.sp * (e.k === "inf" || !foeNear(e, live) ? 1 : 0.6) * (PH() === "stret" && fighter(e) ? 1.25 : 1) * dt;
        if (d <= sp) { e.x = p.x; e.y = p.y; e.wp.shift(); } else { e.x += (p.x - e.x) / d * sp; e.y += (p.y - e.y) / d * sp; } }
      if (e.k === "arty" && !e.wp.length && dist(e, TEAMS[e.t].gun) < 12 && (e.cd -= dt) <= 0) { e.cd = PH() === "priprava" ? rnd(4, 6) : rnd(12, 16); barrage(e); continue; }
      if (!k.rg || (e.cd -= dt) > 0) continue;
      // fire at the nearest enemy in range, else at an enemy FOB
      let tg = null, best = k.rg ** 2;
      for (const v of live) { if (v.t === e.t || v.dead || v.gone) continue; const d = (v.x - e.x) ** 2 + (v.y - e.y) ** 2; if (d < best) { best = d; tg = v; } }
      const fob = !tg && fobs.find(f => f.t !== e.t && !f.down && f.build > 0 && dist(f, e) < k.rg);
      if (!tg && !fob) continue;
      const at = tg || fob;
      e.cd = k.cd * rnd(0.8, 1.3);
      tracers.push({ x1: e.x, y1: e.y, x2: at.x + rnd(-7, 7), y2: at.y + rnd(-7, 7), col: TEAMS[e.t].col, life: 0.14 }); shot();
      if (Math.random() > k.hit) continue;
      if (fob) { hitFob(fob, k.dmg); continue; }
      if (K[tg.k].carry && !inCZ(tg)) st.convoyHits++;
      hurt(tg, k.dmg);
    }
    for (const s of shells) {
      if ((s.eta -= dt) > 0) continue;
      blasts.push({ x: s.x, y: s.y, r: 0, max: 46, life: 0.9 });
      ents.forEach(e => { if (!e.dead && !e.gone && e.t !== s.t && !K[e.k].air && Math.hypot(e.x - s.x, e.y - s.y) < 45) hurt(e, 3); });
      fobs.forEach(f => { if (f.t !== s.t && !f.down && f.build > 0 && Math.hypot(f.x - s.x, f.y - s.y) < 50) hitFob(f, 1); });
    }
    shells = shells.filter(s => s.eta > 0);
    ents = ents.filter(e => !e.gone);
    tracers = tracers.filter(r => (r.life -= dt) > 0);
    blasts = blasts.filter(b => { b.r += (b.max - b.r) * Math.min(1, dt * 6); return (b.life -= dt) > 0; });
    // the Hot Zone: the side with the most fighters inside fills its ring
    const inside = TEAMS.map((_, i) => live.filter(e => e.t === i && !K[e.k].air && !K[e.k].carry && dist(e, hz) < HZR).length);
    const top = Math.max(...inside), lead = inside.indexOf(top), sole = top > 0 && inside.filter(n => n === top).length === 1;
    if (sole && lead !== owner) { control -= dt * 0.25; if (control <= 0) { owner = lead; control = 0; if (!st.owners.includes(TEAMS[lead].id)) st.owners.push(TEAMS[lead].id); } }
    else if (sole) control = Math.min(1, control + dt * 0.2);
  };
  const foeNear = (e, live) => live.some(v => v.t !== e.t && Math.abs(v.x - e.x) < 120 && Math.abs(v.y - e.y) < 120);
  // artillery: a salvo on an enemy FOB, else on the enemy crowd in the Hot Zone
  const barrage = e => {
    const fs = fobs.filter(f => f.t !== e.t && !f.down && f.build > 0), aim = fs.length ? pick(fs) : hz;
    for (let i = 0; i < 3; i++) shells.push({ t: e.t, x: aim.x + rnd(-40, 40), y: aim.y + rnd(-40, 40), eta: 1.6 + i * 0.4 });
    if (fs.length && Math.random() < 0.3) say(`DĚLOSTŘELECTVO NA FOB · ${TEAMS[aim.t].name}`);
  };
  // the waves (B18): the clash sends every fighter at the Hot Zone, the retreat calls them back to their gathering spot
  const nextPhase = () => {
    phase = (phase + 1) % RHYTHM.length;
    phaseStart = t; phaseEnd = t + rnd(RHYTHM[phase][1], RHYTHM[phase][2]);
    st.phases.push(PH());
    if (PH() === "stret") say("ÚTOK NA HOT ZONE");
    if (PH() === "stret" || PH() === "ustup") for (const e of ents) if (fighter(e) && !e.dead) { e.wp = []; e.wait = rnd(0, PH() === "stret" ? 3 : 1); }
  };
  // the biggest knot of fighting: fighters of two or three teams within 150 of each other (B17)
  const massFight = () => {
    const live = ents.filter(e => !e.dead && !e.gone && !K[e.k].carry);
    let best = null;
    for (const a of live) {
      const near = live.filter(b => dist(a, b) < 150), teams = new Set(near.map(b => b.t)).size;
      if (teams >= 2 && near.length >= MASS && (!best || near.length > best.n))
        best = { n: near.length, teams, x: near.reduce((s, b) => s + b.x, 0) / near.length, y: near.reduce((s, b) => s + b.y, 0) / near.length };
    }
    return best;
  };
  const sector = (x, y) => "ABCDEFGH"[Math.max(0, Math.min(7, Math.floor(x / 200)))] + (Math.max(0, Math.min(4, Math.floor(y / 200))) + 1);
  // camera (B16): the whole map, close only to a mass fight or a FOB just destroyed, then back
  const wide = () => {
    st.cuts++; wideSince = t; flash = 0.1;
    cam = { x: W / 2, y: H / 2, z: 1, dz: rnd(0, 0.003), label: `CAM ${1 + (st.cuts % 6)} · CELÁ MAPA`, close: false, until: 0 };
  };
  const closeUp = (m, why) => {
    const name = why === "fob" ? "FOB ZNIČENA" : `STŘET · ${sector(m.x, m.y)}`;
    st.cuts++; lastClose = t; flash = 0.18;
    st.closeups.push({ n: m.n, teams: m.teams, why, label: name });
    cam = { x: m.x, y: m.y, z: rnd(2, 2.4), dz: rnd(0.006, 0.012), label: `CAM ${1 + (st.cuts % 6)} · ${name}`, close: true, until: t + rnd(5, 8) };
  };

  // drawing: world 1600 x 1000 covers the screen, the camera on top; a phone held upright gets the world turned a
  // quarter so the long side runs down the screen (symbols and labels stay upright)
  let dpr = 1, cw = 0, ch = 0, rot = false;
  const upright = () => { if (rot) ctx.rotate(-Math.PI / 2); };
  const label = (text, x, y) => { ctx.save(); ctx.translate(x, y); upright(); ctx.fillText(text, 0, 0); ctx.restore(); };
  const size = () => {
    dpr = Math.min(devicePixelRatio || 1, 1.5);
    cw = cv.width = Math.round(innerWidth * dpr); ch = cv.height = Math.round(innerHeight * dpr);
  };
  const ring = (x, y, r, stroke, fill, dash) => { ctx.setLineDash(dash || []); ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); if (fill) { ctx.fillStyle = fill; ctx.fill(); } ctx.strokeStyle = stroke; ctx.stroke(); ctx.setLineDash([]); };
  // APP-6 like: blue = our rectangles, red and green = hostile diamonds; the glyph inside tells the kind
  const sym = e => {
    const c = TEAMS[e.t].col, s = e.k === "inf" ? 0.6 : e.k === "atv" ? 0.7 : 0.85;
    ctx.save(); ctx.translate(e.x, e.y); upright(); ctx.scale(s, s);
    ctx.strokeStyle = `rgba(${c},.85)`; ctx.fillStyle = `rgba(${c},.14)`; ctx.lineWidth = 2;
    ctx.beginPath();
    if (e.t === 0) ctx.rect(-16, -11, 32, 22); else { ctx.moveTo(0, -15); ctx.lineTo(15, 0); ctx.lineTo(0, 15); ctx.lineTo(-15, 0); ctx.closePath(); }
    ctx.fill(); ctx.stroke(); ctx.beginPath();
    switch (e.k) {
      case "inf": if (e.t === 0) { ctx.moveTo(-16, -11); ctx.lineTo(16, 11); ctx.moveTo(16, -11); ctx.lineTo(-16, 11); } else { ctx.moveTo(-6, -6); ctx.lineTo(6, 6); ctx.moveTo(6, -6); ctx.lineTo(-6, 6); } break;
      case "tank": ctx.ellipse(0, 0, 9, 5, 0, 0, Math.PI * 2); break;
      case "apc": ctx.ellipse(0, 0, 9, 5, 0, 0, Math.PI * 2); ctx.moveTo(-9, 0); ctx.lineTo(9, 0); break;
      case "heli": case "cargoheli": ctx.moveTo(-9, -5); ctx.lineTo(9, 5); ctx.lineTo(9, -5); ctx.lineTo(-9, 5); ctx.closePath(); if (e.k === "cargoheli") ctx.rect(-3, -9, 6, 4); break;
      case "truck": case "kodiak": ctx.moveTo(-8, -2); ctx.lineTo(8, -2); ctx.moveTo(-3, 5); ctx.arc(-5, 5, 2, 0, Math.PI * 2); ctx.moveTo(7, 5); ctx.arc(5, 5, 2, 0, Math.PI * 2); if (e.k === "kodiak") ctx.rect(-2, -7, 4, 3); break;
      case "arty": ctx.arc(0, 0, 3.5, 0, Math.PI * 2); ctx.fillStyle = `rgba(${c},.85)`; ctx.fill(); break;
      default: ctx.moveTo(-8, 6); ctx.lineTo(8, -6);  // buggy, ATV: recon slash
    }
    ctx.stroke();
    if (e.cargo) { ctx.beginPath(); ctx.arc(12, -12, 3.5, 0, Math.PI * 2); ctx.fillStyle = e.cargo === "sup" ? `rgba(${YEL},.95)` : "rgba(235,240,245,.9)"; ctx.fill(); }
    ctx.restore();
  };
  const draw = () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    rot = ch > cw;
    const sw = rot ? ch : cw, sh = rot ? cw : ch, s = Math.max(sw / W, sh / H) * cam.z, vw = sw / s, vh = sh / s;
    const cx = vw >= W ? W / 2 : Math.min(W - vw / 2, Math.max(vw / 2, cam.x)), cy = vh >= H ? H / 2 : Math.min(H - vh / 2, Math.max(vh / 2, cam.y));
    ctx.translate(cw / 2, ch / 2); if (rot) ctx.rotate(Math.PI / 2); ctx.scale(s, s); ctx.translate(-cx, -cy);
    ctx.strokeStyle = "rgba(65,214,238,.10)"; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 200; x < W; x += 200) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = 200; y < H; y += 200) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    ctx.fillStyle = "rgba(65,214,238,.5)"; ctx.font = "600 18px Oxanium, sans-serif"; ctx.textAlign = "center";
    for (let i = 0; i < 8; i++) label("ABCDEFGH"[i], 100 + i * 200, 30);
    for (let i = 0; i < 5; i++) label(String(i + 1), 16, 106 + i * 200);
    // supply roads, the Contact Zone, the HQs
    ctx.lineWidth = 3;
    TEAMS.forEach(tm => { ctx.setLineDash([14, 10]); ctx.strokeStyle = `rgba(${tm.col},.22)`; ctx.beginPath(); ctx.moveTo(tm.home.x, tm.home.y); ctx.lineTo(tm.entry.x, tm.entry.y); ctx.stroke(); });
    ctx.lineWidth = 2;
    ring(CZ.x, CZ.y, CZ.r, "rgba(65,214,238,.45)", "rgba(65,214,238,.035)", [18, 12]);
    ctx.fillStyle = "rgba(65,214,238,.55)"; ctx.font = "700 18px Oxanium, sans-serif";
    label("CONTACT ZONE", CZ.x - (rot ? CZ.r + 20 : 0), CZ.y - (rot ? 0 : CZ.r + 20));
    TEAMS.forEach(tm => { ctx.save(); ctx.translate(tm.home.x, tm.home.y); upright();
      ctx.fillStyle = `rgba(${tm.col},.18)`; ctx.strokeStyle = `rgba(${tm.col},.9)`; ctx.lineWidth = 3; ctx.fillRect(-34, -24, 68, 48); ctx.strokeRect(-34, -24, 68, 48);
      ctx.fillStyle = `rgba(${tm.col},.95)`; ctx.font = "700 20px Oxanium, sans-serif"; ctx.fillText("HQ", 0, 7); ctx.restore(); });
    // FOBs: a base with walls once built, a drill tower; a working drill glows and points at the Hot Zone
    for (const f of fobs) {
      if (f.down) { ctx.strokeStyle = "rgba(160,170,180,.35)"; ctx.setLineDash([4, 6]); ctx.strokeRect(f.x - 14, f.y - 14, 28, 28); ctx.setLineDash([]); continue; }
      if (f.build <= 0) continue;
      const c = TEAMS[f.t].col;
      ctx.lineWidth = 2; ctx.strokeStyle = `rgba(${c},.8)`; ctx.fillStyle = `rgba(${c},.12)`;
      if (f.build < 1) { ctx.setLineDash([5, 5]); ctx.strokeRect(f.x - 16, f.y - 16, 32, 32); ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(f.x, f.y, 22, -Math.PI / 2, -Math.PI / 2 + f.build * Math.PI * 2); ctx.stroke(); continue; }
      ctx.fillRect(f.x - 16, f.y - 16, 32, 32); ctx.strokeRect(f.x - 16, f.y - 16, 32, 32);
      ctx.strokeStyle = `rgba(${c},.45)`; ctx.lineWidth = 3;
      for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2 + 0.3; ctx.beginPath(); ctx.arc(f.x, f.y, 34, a, a + 0.6); ctx.stroke(); }
      ctx.save(); ctx.translate(f.x, f.y); upright();  // the drill tower stays upright on a turned phone
      ctx.lineWidth = 2; ctx.strokeStyle = f.on ? `rgba(${YEL},.95)` : `rgba(${c},.85)`;
      ctx.beginPath(); ctx.moveTo(22, 6); ctx.lineTo(28, -14); ctx.lineTo(34, 6); ctx.stroke();
      if (f.on) { const p = (t % 1.5) / 1.5; ring(28, -4, 10 + p * 26, `rgba(${YEL},${0.8 * (1 - p)})`); }
      ctx.restore();
      if (hz.drill === f) { ctx.strokeStyle = `rgba(${YEL},.45)`; ctx.setLineDash([6, 8]); ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(hz.x, hz.y); ctx.stroke(); ctx.setLineDash([]); }
    }
    // the Hot Zone: yellow, a pulse, the holder's ring
    const pulse = (t % 3) / 3;
    ctx.lineWidth = 2;
    ring(hz.x, hz.y, HZR, `rgba(${YEL},.85)`, `rgba(${YEL},.09)`);
    ring(hz.x, hz.y, HZR * (0.85 + pulse * 0.45), `rgba(${YEL},${0.55 * (1 - pulse)})`);
    if (owner >= 0) { ctx.strokeStyle = `rgba(${TEAMS[owner].col},.85)`; ctx.lineWidth = 6; ctx.beginPath(); ctx.arc(hz.x, hz.y, HZR + 9, -Math.PI / 2, -Math.PI / 2 + control * Math.PI * 2); ctx.stroke(); }
    ctx.fillStyle = `rgba(${YEL},.8)`; ctx.font = "700 16px Oxanium, sans-serif";
    label("HOT ZONE", hz.x - (rot ? HZR + 18 : 0), hz.y - (rot ? 0 : HZR + 18));
    ctx.lineWidth = 1.5;
    for (const sh of shells) ring(sh.x, sh.y, 10 + sh.eta * 30, "rgba(239,107,91,.7)");
    for (const r of tracers) { ctx.strokeStyle = `rgba(${r.col},${r.life * 6})`; ctx.beginPath(); ctx.moveTo(r.x1, r.y1); ctx.lineTo(r.x2, r.y2); ctx.stroke(); }
    ctx.lineWidth = 2;
    for (const b of blasts) ring(b.x, b.y, b.r, `rgba(255,190,120,${Math.min(1, b.life)})`);
    for (const e of ents) if (!e.dead && !K[e.k].air) sym(e);
    for (const e of ents) if (!e.dead && K[e.k].air) sym(e);  // helicopters above everything
    // the camera's label and the latest event, on the screen
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = "left"; ctx.font = "600 13px Oxanium, sans-serif"; ctx.fillStyle = "rgba(65,214,238,.75)";
    ctx.fillText(`● ${cam.label} · T+${String(Math.floor(t / 60)).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`, 18, innerHeight - 18);
    if (banner) { ctx.fillStyle = `rgba(${YEL},${Math.min(1, banner.life)})`; ctx.font = "700 15px Oxanium, sans-serif"; ctx.fillText(banner.text, 18, innerHeight - 40); }
    if (flash) { ctx.fillStyle = `rgba(200,240,255,${flash})`; ctx.fillRect(0, 0, innerWidth, innerHeight); }
    st.frames++;
  };

  let raf = 0, last = 0, tick = 0, count = 0, dirty = false;
  const loop = now => {
    raf = 0;
    if (document.hidden) return;
    raf = requestAnimationFrame(loop);
    if (now - last < 1000 / FPS - 1) return;
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    if (dirty) { size(); dirty = false; }
    step(dt * (cam.close ? 0.6 : 1)); draw(); count++;  // slow motion in a close-up (B17)
    if (now - tick >= 1000) { st.fps = count * 1000 / (now - tick); tick = now; count = 0; }
  };
  const start = () => { if (!raf && !still && !document.hidden) { last = 0; tick = performance.now(); count = 0; raf = requestAnimationFrame(loop); } };
  size();
  addEventListener("resize", () => { dirty = true; if (still) { size(); draw(); } });
  document.addEventListener("visibilitychange", () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else start(); });
  const advance = sec => { for (let i = 0; i < sec * 15; i++) step(1 / 15); };
  advance(still ? 45 : 20);  // open on a battle already going: FOBs rising, convoys on the roads
  if (still) draw(); else start();
  window.__battle = {
    advance,
    stats: () => ({ ...st, camLabel: cam.label, owners: [...st.owners], deliveries: { ...st.deliveries }, static: still, hqs: TEAMS.length, cz: { ...CZ }, hz: { x: hz.x, y: hz.y, r: HZR },
      kinds: [...new Set(ents.map(e => e.k))], teams: Object.fromEntries(TEAMS.map((tm, i) => [tm.id, ents.filter(e => e.t === i).length])) }),
  };
})();
