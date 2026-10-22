// The battle behind every page (Petr 2026-10-22, specs/pozadi-bitva): blue (us), red and green push each other over
// one control zone, the Hot Zone moves, twists turn the fight and the camera cuts between places. Decoration only:
// at most 30 frames a second, DPR up to 1.5, fewer units on a phone, paused in a hidden tab, one still frame for
// reduced motion.
(() => {
  const cv = document.getElementById("battle");
  if (!cv) return;
  const W = 1600, H = 1000, FPS = 30;
  const TEAMS = [
    { id: "blue", col: "65,214,238", home: [170, 560] },
    { id: "red", col: "239,107,91", home: [1420, 150] },
    { id: "green", col: "111,220,140", home: [1400, 880] },
  ];
  const ZONES = [[1010, 430], [820, 500], [700, 330], [930, 700], [1130, 620], [880, 260]];
  const ZR = 130;
  const RANGE = { inf: 170, arm: 230, heli: 210 }, SPEED = { inf: 30, arm: 21, heli: 120 }, HP = { inf: 1, arm: 4, heli: 3 };
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const per = innerWidth < 720 ? 9 : 16;
  const ctx = cv.getContext("2d");
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = a => a[Math.floor(Math.random() * a.length)];

  const st = { frames: 0, fps: 0, zoneMoves: 0, kills: 0, respawns: 0, twists: 0, cuts: 0, owners: [] };
  let t = 0, zi = 0, zone = ZONES[0], control = 0, owner = -1, held = 0;
  let nextZone = rnd(40, 55), nextTwist = rnd(12, 20), nextCut = rnd(7, 11);
  let units = [], tracers = [], blasts = [], shells = [], banner = null;
  let cam = { x: W / 2, y: H / 2, z: 1, dz: 0, label: "CAM 1" }, flash = 0;

  const spawn = (u, tm) => {
    const [hx, hy] = TEAMS[tm].home;
    Object.assign(u, { x: hx + rnd(-60, 60), y: hy + rnd(-60, 60), hp: HP[u.k], cd: rnd(0, 1), dead: 0 });
    return u;
  };
  const aim = u => { u.ox = rnd(-ZR * 0.8, ZR * 0.8); u.oy = rnd(-ZR * 0.8, ZR * 0.8); };
  const add = (tm, k, extra = false) => { const u = spawn({ t: tm, k, extra, boost: 1 }, tm); aim(u); units.push(u); return u; };
  TEAMS.forEach((_, tm) => { for (let i = 0; i < per; i++) add(tm, i < 2 ? "arm" : "inf"); });

  const sector = (x, y) => "ABCDEFGH"[Math.max(0, Math.min(7, Math.floor(x / 200)))] + (Math.max(0, Math.min(4, Math.floor(y / 200))) + 1);
  const clock = () => `T+${String(Math.floor(t / 60)).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  const say = text => { banner = { text, life: 4 }; st.twists++; };
  const moveZone = () => {
    zi = (zi + 1 + Math.floor(Math.random() * (ZONES.length - 1))) % ZONES.length;
    zone = ZONES[zi]; control = 0; held = 0; st.zoneMoves++;
    units.forEach(aim);
    nextZone = t + rnd(40, 55);
  };
  // the side that held the zone too long draws the other two on itself (the push and pull Petr asked for)
  const TWISTS = [
    ["POSILY S VRTULNÍKEM", tm => { for (let i = 0; i < 4; i++) add(tm, "inf", true); const h = add(tm, "heli", true); h.ttl = 16; }],
    ["DĚLOSTŘELECTVO", tm => { for (let i = 0; i < 6; i++) shells.push({ tm, x: zone[0] + rnd(-ZR, ZR), y: zone[1] + rnd(-ZR, ZR), eta: 1 + i * 0.45 }); }],
    ["TANKOVÝ PRŮRAZ", tm => { units.forEach(u => { if (u.t === tm && u.k === "arm") { u.boost = 1.7; u.hp = HP.arm; } }); add(tm, "arm", true); }],
    ["HOT ZONE SE PŘESOUVÁ", () => moveZone()],
  ];
  const twist = () => {
    const alive = TEAMS.map((_, tm) => units.filter(u => u.t === tm && !u.dead).length);
    const weak = owner >= 0 && held > 20 ? pick([0, 1, 2].filter(tm => tm !== owner)) : alive.indexOf(Math.min(...alive));
    const [name, run] = pick(TWISTS);
    run(weak);
    say(`ZVRAT · ${name}${name.startsWith("HOT") ? "" : ` · ${["MODŘÍ", "ČERVENÍ", "ZELENÍ"][weak]}`}`);
    nextTwist = t + rnd(18, 28);
  };
  // camera: a wide shot, the zone, a fresh blast or a team's way in; each shot drifts in a little
  const cut = () => {
    const spots = [[W / 2, H / 2, 1], [zone[0], zone[1], rnd(1.3, 1.6)], ...TEAMS.map(tm => [(tm.home[0] + zone[0]) / 2, (tm.home[1] + zone[1]) / 2, rnd(1.15, 1.4)])];
    if (blasts.length) { const b = blasts[blasts.length - 1]; spots.push([b.x, b.y, rnd(1.4, 1.7)]); }
    const [x, y, z] = pick(spots);
    st.cuts++;
    cam = { x, y, z, dz: rnd(0.004, 0.012), label: `CAM ${1 + (st.cuts % 6)} · SEKTOR ${sector(x, y)}` };
    flash = 0.18;
    nextCut = t + rnd(8, 13);
  };

  const step = dt => {
    t += dt;
    if (t >= nextZone) moveZone();
    if (t >= nextTwist) twist();
    if (t >= nextCut) cut();
    cam.z = Math.min(1.8, cam.z + cam.dz * dt);
    flash = Math.max(0, flash - dt);
    if (banner && (banner.life -= dt) <= 0) banner = null;
    const live = units.filter(u => !u.dead);
    for (const u of units) {
      if (u.dead) {
        if ((u.dead -= dt) <= 0) { spawn(u, u.t); aim(u); st.respawns++; }
        continue;
      }
      if (u.ttl !== undefined && (u.ttl -= dt) <= 0) { u.gone = true; continue; }
      let foe = null, best = RANGE[u.k] ** 2;
      for (const v of live) {
        if (v.t === u.t || v.dead) continue;
        const d = (v.x - u.x) ** 2 + (v.y - u.y) ** 2;
        if (d < best) { best = d; foe = v; }
      }
      const tx = zone[0] + u.ox, ty = zone[1] + u.oy, dx = tx - u.x, dy = ty - u.y, dist = Math.hypot(dx, dy);
      const sp = SPEED[u.k] * u.boost * (foe && u.k !== "heli" ? 0.25 : 1);
      if (dist > 4) { u.x += dx / dist * Math.min(dist, sp * dt); u.y += dy / dist * Math.min(dist, sp * dt); }
      if (foe && (u.cd -= dt) <= 0) {
        u.cd = rnd(0.6, 1.4) / u.boost;
        tracers.push({ x1: u.x, y1: u.y, x2: foe.x + rnd(-8, 8), y2: foe.y + rnd(-8, 8), col: TEAMS[u.t].col, life: 0.14 });
        if (Math.random() < (u.k === "inf" ? 0.3 : 0.55) && (foe.hp -= 1) <= 0) down(foe);
      }
    }
    for (const s of shells) {
      if ((s.eta -= dt) > 0) continue;
      blasts.push({ x: s.x, y: s.y, r: 0, max: 70, life: 0.9 });
      units.forEach(u => { if (!u.dead && u.t !== s.tm && u.k !== "heli" && Math.hypot(u.x - s.x, u.y - s.y) < 48) down(u); });
    }
    shells = shells.filter(s => s.eta > 0);
    units = units.filter(u => !u.gone);
    tracers = tracers.filter(r => (r.life -= dt) > 0);
    blasts = blasts.filter(b => { b.r += (b.max - b.r) * Math.min(1, dt * 6); return (b.life -= dt) > 0; });
    // the zone: the side with the most units inside fills its ring; a full ring is held
    const inside = TEAMS.map((_, tm) => units.filter(u => u.t === tm && !u.dead && Math.hypot(u.x - zone[0], u.y - zone[1]) < ZR).length);
    const top = Math.max(...inside), lead = inside.indexOf(top), sole = top > 0 && inside.filter(n => n === top).length === 1;
    if (sole && lead !== owner) { control -= dt * 0.25; if (control <= 0) { owner = lead; control = 0; held = 0; if (!st.owners.includes(TEAMS[lead].id)) st.owners.push(TEAMS[lead].id); } }
    else if (sole) control = Math.min(1, control + dt * 0.2);
    if (owner >= 0 && control >= 1) held += dt;
  };
  const down = u => {
    blasts.push({ x: u.x, y: u.y, r: 0, max: u.k === "inf" ? 22 : 40, life: 0.6 });
    st.kills++;
    if (u.extra) u.gone = true; else u.dead = rnd(4, 7);
  };

  // drawing: world 1600 x 1000 covers the screen like the old map, the camera on top; a phone held upright gets the
  // world turned a quarter so the long side runs down the screen (symbols and labels stay upright)
  let dpr = 1, cw = 0, ch = 0, rot = false;
  const upright = () => { if (rot) ctx.rotate(-Math.PI / 2); };
  const label = (text, x, y) => { ctx.save(); ctx.translate(x, y); upright(); ctx.fillText(text, 0, 0); ctx.restore(); };
  const size = () => {
    dpr = Math.min(devicePixelRatio || 1, 1.5);
    cw = cv.width = Math.round(innerWidth * dpr); ch = cv.height = Math.round(innerHeight * dpr);
  };
  const sym = (u, c) => {
    ctx.strokeStyle = `rgba(${c},.8)`; ctx.fillStyle = `rgba(${c},.12)`; ctx.lineWidth = 2;
    ctx.save(); ctx.translate(u.x, u.y); upright();
    if (u.t === 0) { ctx.fillRect(-16, -11, 32, 22); ctx.strokeRect(-16, -11, 32, 22); }
    else { ctx.beginPath(); ctx.moveTo(0, -15); ctx.lineTo(15, 0); ctx.lineTo(0, 15); ctx.lineTo(-15, 0); ctx.closePath(); ctx.fill(); ctx.stroke(); }
    ctx.beginPath();
    if (u.k === "arm") ctx.ellipse(0, 0, 9, 5, 0, 0, Math.PI * 2);
    else if (u.k === "heli") { ctx.moveTo(-9, -5); ctx.lineTo(9, 5); ctx.lineTo(9, -5); ctx.lineTo(-9, 5); ctx.closePath(); }
    else if (u.t === 0) { ctx.moveTo(-16, -11); ctx.lineTo(16, 11); ctx.moveTo(16, -11); ctx.lineTo(-16, 11); }
    ctx.stroke(); ctx.restore();
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
    // the Hot Zone: dashed edge, a pulse, the holder's ring
    const pulse = (t % 3) / 3;
    ctx.setLineDash([18, 12]); ctx.strokeStyle = "rgba(65,214,238,.45)"; ctx.lineWidth = 2; ctx.fillStyle = "rgba(65,214,238,.04)";
    ctx.beginPath(); ctx.arc(zone[0], zone[1], ZR, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = `rgba(65,214,238,${0.6 * (1 - pulse)})`; ctx.beginPath(); ctx.arc(zone[0], zone[1], ZR * (0.85 + pulse * 0.45), 0, Math.PI * 2); ctx.stroke();
    if (owner >= 0) { ctx.strokeStyle = `rgba(${TEAMS[owner].col},.85)`; ctx.lineWidth = 6; ctx.beginPath(); ctx.arc(zone[0], zone[1], ZR + 10, -Math.PI / 2, -Math.PI / 2 + control * Math.PI * 2); ctx.stroke(); }
    ctx.fillStyle = "rgba(65,214,238,.6)"; ctx.font = "700 20px Oxanium, sans-serif"; label("HOT ZONE", zone[0] - (rot ? ZR + 22 : 0), zone[1] - (rot ? 0 : ZR + 22));  // above the ring on the screen
    for (const sh of shells) { ctx.strokeStyle = "rgba(239,107,91,.7)"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(sh.x, sh.y, 10 + sh.eta * 30, 0, Math.PI * 2); ctx.stroke(); }
    for (const r of tracers) { ctx.strokeStyle = `rgba(${r.col},${r.life * 6})`; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(r.x1, r.y1); ctx.lineTo(r.x2, r.y2); ctx.stroke(); }
    for (const b of blasts) { ctx.strokeStyle = `rgba(255,190,120,${Math.min(1, b.life)})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.stroke(); }
    for (const u of units) if (!u.dead) sym(u, TEAMS[u.t].col);
    // the camera's label and a twist's banner, on the screen
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = "left"; ctx.font = "600 13px Oxanium, sans-serif"; ctx.fillStyle = "rgba(65,214,238,.75)";
    ctx.fillText(`● ${cam.label} · ${clock()}`, 18, innerHeight - 18);
    if (banner) { ctx.fillStyle = `rgba(239,190,90,${Math.min(1, banner.life)})`; ctx.font = "700 15px Oxanium, sans-serif"; ctx.fillText(banner.text, 18, innerHeight - 40); }
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
    step(dt); draw(); count++;
    if (now - tick >= 1000) { st.fps = count * 1000 / (now - tick); tick = now; count = 0; }
  };
  const start = () => { if (!raf && !still && !document.hidden) { last = 0; tick = performance.now(); count = 0; raf = requestAnimationFrame(loop); } };
  size();
  addEventListener("resize", () => { dirty = true; if (still) { size(); draw(); } });
  document.addEventListener("visibilitychange", () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else start(); });
  const advance = sec => { for (let i = 0; i < sec * 15; i++) step(1 / 15); };
  if (still) { advance(25); draw(); } else start();
  window.__battle = {
    advance,
    stats: () => ({ ...st, owners: [...st.owners], static: still, teams: Object.fromEntries(TEAMS.map((tm, i) => [tm.id, units.filter(u => u.t === i).length])) }),
  };
})();
