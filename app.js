/* 유니온 화면: 성적 입력, 검색·필터, 환산점수 목록 */
(function () {
  "use strict";
  const D = window.UNION_DATA;
  const E = window.UnionEngine;
  const $ = (s) => document.querySelector(s);
  const PAGE = 100;
  const MED_CATS = new Set(["med", "dent", "kmed", "pharm", "vet"]);

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 저장 불가 환경 */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* 무시 */ } },
  };

  const catName = Object.fromEntries(D.categories.map((c) => [c.code, c.name]));
  const catGroup = Object.fromEntries(D.categories.map((c) => [c.code, c.group]));
  const subjArea = {};
  for (const [area, list] of Object.entries(D.exam.inquiry)) for (const s of list) subjArea[s] = area;

  /* ---------- 성적 입력 ---------- */

  function fillSubjects() {
    for (const sel of document.querySelectorAll("select.subj")) {
      let html = '<option value="">-</option>';
      for (const [area, list] of Object.entries(D.exam.inquiry)) {
        html += `<optgroup label="${area}">` + list.map((s) => `<option>${s}</option>`).join("") + "</optgroup>";
      }
      sel.innerHTML = html;
    }
  }

  function readForm() {
    const f = new FormData($("#scoreForm"));
    const v = (k) => { const x = f.get(k); return x === null || x === "" ? null : x; };
    const n = (k) => { const x = v(k); return x === null ? null : Number(x); };
    const st = {
      korean: { choice: v("korean.choice"), std: n("korean.std"), pct: n("korean.pct"), grade: n("korean.grade") },
      math: { choice: v("math.choice"), std: n("math.std"), pct: n("math.pct"), grade: n("math.grade") },
      english: { grade: n("english.grade") },
      history: { grade: n("history.grade") },
      inquiry: [0, 1].map((i) => {
        const subject = v(`inq${i}.subject`);
        return subject ? { subject, area: subjArea[subject], std: n(`inq${i}.std`), pct: n(`inq${i}.pct`), grade: n(`inq${i}.grade`) } : null;
      }).filter(Boolean),
    };
    return st;
  }

  function writeForm(st) {
    if (!st) return;
    const set = (k, val) => { const el = $(`[name="${k}"]`); if (el && val !== null && val !== undefined) el.value = val; };
    for (const a of ["korean", "math"]) for (const k of ["choice", "std", "pct", "grade"]) set(`${a}.${k}`, st[a] && st[a][k]);
    set("english.grade", st.english && st.english.grade);
    set("history.grade", st.history && st.history.grade);
    (st.inquiry || []).forEach((s, i) => { for (const k of ["subject", "std", "pct", "grade"]) set(`inq${i}.${k}`, s[k]); });
  }

  function hasScores(st) {
    return !!(st && (st.korean.std || st.korean.pct || st.math.std || st.math.pct || st.inquiry.length));
  }

  /* ---------- 필터 ---------- */

  const state = Object.assign(
    { q: "", guns: [], group: "", catGroup: "", cat: "", sort: "univ", eligible: true, special: false, tiers: [] },
    store.get("union.filters") || {}
  );
  let student = store.get("union.scores");
  let shown = PAGE;

  function initFilters() {
    const groups = [...new Set(D.groups.map((g) => g.group))];
    $("#fGroup").innerHTML += groups.map((g) => `<option>${g}</option>`).join("");
    $("#fCatGroup").innerHTML += D.catGroups.map((g) => `<option>${g}</option>`).join("");
    fillCats();
    $("#q").value = state.q;
    $("#fGroup").value = state.group;
    $("#fCatGroup").value = state.catGroup;
    fillCats();
    $("#fCat").value = state.cat;
    $("#fSort").value = state.sort;
    $("#fEligible").checked = state.eligible;
    $("#fSpecial").checked = state.special;
    for (const b of document.querySelectorAll(".chip")) b.setAttribute("aria-pressed", state.guns.includes(b.dataset.gun));
  }

  function fillCats() {
    const g = $("#fCatGroup").value;
    const list = D.categories.filter((c) => !g || c.group === g);
    $("#fCat").innerHTML = '<option value="">전체 학과</option>' + list.map((c) => `<option value="${c.code}">${c.name}</option>`).join("");
  }

  const groupIds = {};
  for (const g of D.groups) (groupIds[g.group] ||= new Set());
  for (const g of D.groups) for (const id of g.ids) groupIds[g.group].add(id);

  /* ---------- 결과 계산 ---------- */

  const perfectCache = new Map();
  function perfect(u) {
    const k = `${u.u}|${u.i}`;
    if (!perfectCache.has(k)) perfectCache.set(k, E.perfectScore(u, D.univs[u.u], D.exam));
    return perfectCache.get(k);
  }

  function rows() {
    const q = state.q.trim().replace(/\s+/g, "");
    const out = [];
    for (const u of D.units) {
      const univ = D.univs[u.u];
      if (state.group === "메디컬") { if (!MED_CATS.has(u.cat)) continue; }
      else if (state.group && !(groupIds[state.group] && groupIds[state.group].has(u.u))) continue;
      if (state.cat && u.cat !== state.cat) continue;
      if (!state.cat && state.catGroup && catGroup[u.cat] !== state.catGroup) continue;
      if (q) {
        const hay = (univ.name + u.c + u.n + (catName[u.cat] || "")).replace(/\s+/g, "");
        if (!hay.includes(q)) continue;
      }
      // 군별로 한 줄씩
      const byGun = new Map();
      for (const t of u.q) {
        if (!state.special && t.s) continue;
        const g = t.g || "?";
        if (state.guns.length && !state.guns.includes(g)) continue;
        if (!byGun.has(g)) byGun.set(g, { n: 0, tracks: [] });
        const x = byGun.get(g); x.n += t.n; x.tracks.push(t.t + (t.s ? "(특별)" : ""));
      }
      if (!byGun.size) continue;
      let r = null;
      if (hasScores(student)) {
        r = E.compute(u, univ, student, D.exam);
        if (state.eligible && !r.eligible) continue;
      }
      const v = r && r.eligible ? E.verdict(student, u.ct) : null;
      if (state.tiers.length && !(v && state.tiers.includes(v.tier))) continue;
      for (const [g, x] of byGun) out.push({ u, univ, gun: g, quota: x.n, tracks: x.tracks, r, v });
    }
    if (state.sort === "verdict") {
      const pr = (row) => (row.v ? row.v.prob : -1);
      out.sort((a, b) => pr(b) - pr(a));
    } else if (state.sort === "ratio") {
      const ratio = (row) => (row.r && row.r.score !== null ? row.r.score / (perfect(row.u) || 1) : -1);
      out.sort((a, b) => ratio(b) - ratio(a));
    } else if (state.sort === "quota") out.sort((a, b) => b.quota - a.quota);
    else out.sort((a, b) => a.univ.order - b.univ.order || a.univ.name.localeCompare(b.univ.name, "ko") || a.u.i - b.u.i);
    return out;
  }

  /* ---------- 그리기 ---------- */

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = (x) => (Math.round(x * 10) / 10).toLocaleString("ko-KR", { maximumFractionDigits: 1 });

  function scoreCell(row) {
    const r = row.r;
    if (!r) return '<span class="of">성적 입력 필요</span>';
    if (r.error) return `<span class="of">${esc(r.error)}</span>`;
    const pf = perfect(row.u);
    const ratio = pf ? Math.max(0, Math.min(1, r.score / pf)) : 0;
    const tags = r.flags.length ? `<span class="tag warn" title="${esc(r.flags.join(" · "))}">추정</span>` : "";
    return `<b>${fmt(r.score)}</b> <span class="of">/ ${pf ? fmt(pf) : "-"}</span> ${tags}
      <div class="bar" aria-hidden="true"><i style="width:${(ratio * 100).toFixed(1)}%"></i></div>`;
  }

  const TIER_CLASS = { "안정": "t1", "적정": "t2", "소신": "t3", "위험": "t4", "무모": "t5", "불가": "t6" };

  function verdictCell(row) {
    if (row.r && !row.r.eligible) return `<span class="tier t7">지원불가</span><div class="of">${esc(row.r.reasons.join(", "))}</div>`;
    if (!row.r) return "";
    if (!row.u.ct || !row.u.ct.length) return '<span class="of">합격선 자료 없음</span>';
    const v = row.v;
    if (!v) return '<span class="of">국·수·탐 2과목 점수 필요</span>';
    return `<span class="tier ${TIER_CLASS[v.tier]}">${v.tier}</span>${cutLine(v)}`;
  }

  // 가장 최근 학년도 합격선(여러 자료면 평균)과 내 점수 차이를 표에 적는다
  function cutLine(v) {
    const latest = Math.max(...v.detail.map((d) => d.year));
    const ds = v.detail.filter((d) => d.year === latest);
    const avg = (k) => { const x = ds.map((d) => d[k]).filter((n) => typeof n === "number"); return x.length ? x.reduce((a, b) => a + b, 0) / x.length : null; };
    const sign = (n) => (n >= 0 ? "+" : "") + fmt(n);
    const parts = [];
    const std = avg("std"), pct = avg("pct");
    if (std !== null && v.me.std !== null) parts.push(`표준합 ${fmt(std)} <b>(${sign(v.me.std - std)})</b>`);
    else if (pct !== null) parts.push(`백분위합 ${fmt(pct)}${v.me.pct !== null ? ` <b>(${sign(v.me.pct - pct)})</b>` : ""}`);
    return parts.length ? `<div class="cut"><span>${String(latest).slice(2)}학년도 합격선</span>${parts.map((x) => `<span>${x}</span>`).join("")}</div>` : "";
  }

  /* ---------- 모의지원 (가·나·다군 하나씩, 이 브라우저에만 저장) ---------- */

  const GUNS = ["가", "나", "다"];
  const unitByKey = new Map(D.units.map((u) => [`${u.u}|${u.i}`, u]));
  let picks = store.get("union.picks") || {};

  function pickButton(row) {
    if (!GUNS.includes(row.gun)) return "";
    const key = `${row.u.u}|${row.u.i}`;
    const on = picks[row.gun] === key;
    return `<button type="button" class="pick${on ? " on" : ""}" data-gun="${row.gun}" data-key="${key}" aria-pressed="${on}">${on ? "담김" : row.gun + "군 담기"}</button>`;
  }

  function renderPicks() {
    const el = $("#picks");
    el.innerHTML = GUNS.map((g) => {
      const u = unitByKey.get(picks[g]);
      if (!u) return `<div class="slot empty"><div class="slot-gun">${g}군</div><div class="of">검색 결과에서 "${g}군 담기"를 누르세요</div></div>`;
      const univ = D.univs[u.u];
      let score = "", tier = "";
      if (hasScores(student)) {
        const r = E.compute(u, univ, student, D.exam);
        if (!r.eligible) tier = '<span class="tier t7">지원불가</span>';
        else {
          const v = E.verdict(student, u.ct);
          if (v) tier = `<span class="tier ${TIER_CLASS[v.tier]}">${v.tier}</span>`;
          if (r.score !== null) score = `<span class="of">환산 ${fmt(r.score)}</span>`;
        }
      }
      return `<div class="slot"><div class="slot-gun">${g}군</div>
        <div class="u-name">${esc(univ.name)}</div><div class="u-unit">${esc(u.n)}</div>
        <div class="slot-foot">${tier} ${score}<button type="button" class="unpick" data-gun="${g}">빼기</button></div></div>`;
    }).join("");
  }

  function setPick(gun, key) {
    if (picks[gun] === key) delete picks[gun]; else picks[gun] = key;
    store.set("union.picks", picks);
    renderPicks(); render();
  }

  function render() {
    const list = rows();
    const el = $("#results");
    $("#count").textContent = `${list.length.toLocaleString("ko-KR")}개 모집단위`;
    if (!list.length) {
      el.innerHTML = '<li class="empty">조건에 맞는 모집단위가 없습니다.</li>';
      $("#more").hidden = true;
      return;
    }
    const head = '<li class="row head"><span>대학 · 모집단위</span><span class="gun">군</span><span class="quota">인원</span><span>환산점수</span><span class="verdict">판정</span></li>';
    el.innerHTML = head + list.slice(0, shown).map((row) => {
      const u = row.u;
      const meta = `${row.gun === "군외" ? "군외" : row.gun + "군"} · ${row.quota}명`;
      return `<li class="row">
        <div class="who"><div class="u-name">${esc(row.univ.name)}</div>
          <div class="u-unit">${esc(u.n)}${u.p ? ' <span class="tag">실기</span>' : ""}</div>
          <div class="u-col">${esc([u.c, catName[u.cat]].filter(Boolean).join(" · "))}${state.special ? " · " + esc(row.tracks.join(", ")) : ""}</div></div>
        <span class="meta">${meta}</span>
        <span class="gun">${esc(row.gun)}</span>
        <span class="quota">${row.quota}</span>
        <div class="score">${scoreCell(row)}</div>
        <div class="verdict">${verdictCell(row)}${pickButton(row)}</div>
      </li>`;
    }).join("");
    $("#more").hidden = list.length <= shown;
  }

  function saveFilters() { store.set("union.filters", state); }
  function update() { shown = PAGE; saveFilters(); render(); }

  /* ---------- 이벤트 ---------- */

  function bind() {
    $("#scoreForm").addEventListener("submit", (e) => {
      e.preventDefault();
      student = readForm();
      store.set("union.scores", student);
      update(); renderPicks();
      $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    $("#clearScores").addEventListener("click", () => {
      $("#scoreForm").reset(); student = null; store.del("union.scores"); update();
    });
    $("#toggleScores").addEventListener("click", () => {
      const p = $("#scorePanel"); p.hidden = !p.hidden;
      $("#toggleScores").setAttribute("aria-expanded", String(!p.hidden));
    });
    let t;
    $("#q").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value; update(); }, 150); });
    $("#fGroup").addEventListener("change", (e) => { state.group = e.target.value; update(); });
    $("#fCatGroup").addEventListener("change", (e) => { state.catGroup = e.target.value; state.cat = ""; fillCats(); update(); });
    $("#fCat").addEventListener("change", (e) => { state.cat = e.target.value; update(); });
    $("#fSort").addEventListener("change", (e) => { state.sort = e.target.value; update(); });
    $("#fEligible").addEventListener("change", (e) => { state.eligible = e.target.checked; update(); });
    $("#fSpecial").addEventListener("change", (e) => { state.special = e.target.checked; update(); });
    for (const b of document.querySelectorAll(".chip")) {
      b.addEventListener("click", () => {
        const g = b.dataset.gun;
        state.guns = state.guns.includes(g) ? state.guns.filter((x) => x !== g) : [...state.guns, g];
        b.setAttribute("aria-pressed", state.guns.includes(g));
        update();
      });
    }
    $("#more").addEventListener("click", () => { shown += PAGE; render(); });
    $("#results").addEventListener("click", (e) => {
      const b = e.target.closest("button.pick");
      if (b) setPick(b.dataset.gun, b.dataset.key);
    });
    $("#picks").addEventListener("click", (e) => {
      const b = e.target.closest("button.unpick");
      if (b) { delete picks[b.dataset.gun]; store.set("union.picks", picks); renderPicks(); render(); }
    });
    for (const b of document.querySelectorAll(".tchip")) {
      b.setAttribute("aria-pressed", state.tiers.includes(b.dataset.tier));
      b.addEventListener("click", () => {
        const t = b.dataset.tier;
        state.tiers = state.tiers.includes(t) ? state.tiers.filter((x) => x !== t) : [...state.tiers, t];
        b.setAttribute("aria-pressed", state.tiers.includes(t));
        update();
      });
    }
  }

  fillSubjects();
  writeForm(student);
  initFilters();
  bind();
  if (D.exam.provisional) {
    $("#notice").textContent = "수능 성적 발표 전이라 표준점수 최고점과 탐구 변환표준점수는 임시값을 씁니다. 판정은 지난 입시 배치표의 국·수·탐 표준점수 합 합격선과 비교한 참고용입니다.";
  }
  if (hasScores(student)) $("#scorePanel").hidden = false;
  renderPicks();
  render();
})();
