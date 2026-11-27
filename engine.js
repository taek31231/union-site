/* 유니온 환산 엔진
 * 규칙 파일(data/rules/*.json)의 scoring 객체를 해석해 환산점수를 계산한다.
 * 브라우저에서는 window.UnionEngine, Node에서는 require()로 쓴다.
 *
 * 학생 성적(student) 형식:
 *   korean:  {choice:'화작'|'언매', std, pct, grade}
 *   math:    {choice:'확통'|'미적'|'기하', std, pct, grade}
 *   english: {grade}
 *   history: {grade}
 *   inquiry: [{subject:'물리학Ⅰ', area:'과탐'|'사탐', std, pct, grade}, ...]  (최대 2과목)
 *
 * 반환: {score, total, eligible, reasons[], flags[]}
 *   flags: 계산 중 쓴 가정(임시 최고점, 변표 대신 표준점수, 해석이 불확실한 산식 등)
 */
(function (root) {
  "use strict";

  const AREAS = ["korean", "math", "english", "inquiry"];
  const NAME = { korean: "국어", math: "수학", english: "영어", inquiry: "탐구", history: "한국사" };
  // 해석이 불확실해 근사로 계산하는 방식
  const APPROX_METHODS = new Set(["sumScaled", "grade"]);

  const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);

  /* ---------- 지원 자격 ---------- */

  function checkRequirement(req, st) {
    // 반환: null(충족) 또는 사유 문자열
    if (!req) return null;
    const mc = st.math && st.math.choice;
    if (Array.isArray(req.math) && req.math.length && mc && !req.math.includes(mc)) {
      return `수학 ${req.math.join("·")} 응시 필요`;
    }
    const kc = st.korean && st.korean.choice;
    if (Array.isArray(req.korean) && req.korean.length && kc && !req.korean.includes(kc)) {
      return `국어 ${req.korean.join("·")} 응시 필요`;
    }
    const iq = req.inquiry;
    const subs = (st.inquiry || []).filter((s) => s && s.subject);
    if (iq && subs.length) {
      const areas = iq.areas || [];
      const count = iq.count || 0;
      const ok = subs.filter((s) => !areas.length || areas.includes(s.area));
      if (ok.length < count) {
        return `탐구 ${areas.join("·") || ""} ${count}과목 필요`;
      }
      if (Array.isArray(iq.mustInclude) && iq.mustInclude.length) {
        const hit = ok.some((s) => /^통합/.test(s.subject) || iq.mustInclude.some((m) => s.subject === m || s.subject.replace(/[ⅠⅡ]$/, "") === m.replace(/[ⅠⅡ]$/, "") && (!/[ⅠⅡ]$/.test(m) || s.subject.endsWith(m.slice(-1)))));
        if (!hit) return `탐구에 ${iq.mustInclude.join("·")} 중 포함 필요`;
      }
    }
    return null;
  }

  function eligibility(unit, univ, st) {
    const keys = unit.rq || [];
    if (!keys.length) return { eligible: true, reasons: [] };
    const reasons = [];
    for (const k of keys) {
      const r = checkRequirement(univ.requirements[k], st);
      if (r === null) return { eligible: true, reasons: [] };
      reasons.push(r);
    }
    return { eligible: false, reasons: [...new Set(reasons)] };
  }

  /* ---------- 가산점 해석 ---------- */

  function rate(v) {
    if (typeof v === "number") return v >= 1 ? v / 100 : v;
    if (typeof v === "string") {
      const m = v.match(/(\d+(?:\.\d+)?)\s*%/);
      if (m) return parseFloat(m[1]) / 100;
    }
    return null;
  }

  // scoring.bonus, inquiry.bonus(PerSubject), unit.bonus 를 모아 {math, subjects:{과목:비율}, area:{과탐:비율}}로
  function collectBonus(sc, unit, flags) {
    const out = { math: 0, area: {}, subjects: {} };
    const sources = [sc.bonus, sc.inquiry && sc.inquiry.bonus, sc.inquiry && sc.inquiry.bonusPerSubject, unit && unit.b];
    for (const src of sources) {
      if (!src || typeof src !== "object") continue;
      if (src.subjects && typeof src.subjects === "object") {
        for (const [s, v] of Object.entries(src.subjects)) out.subjects[s] = rate(v) || 0;
        continue;
      }
      for (const [k, v] of Object.entries(src)) {
        const r = rate(v);
        if (r === null) { flags.add("가산점 일부 미반영"); continue; }
        if (/수학|미적|기하/.test(k)) out.math = Math.max(out.math, r);
        else if (/과탐|과학/.test(k) && /Ⅱ/.test(k)) out.subjects["Ⅱ"] = r;
        else if (/과탐|과학/.test(k)) out.area["과탐"] = r;
        else if (/사탐|사회/.test(k)) out.area["사탐"] = r;
        else if (/[ⅠⅡ]$/.test(k)) out.subjects[k] = r;
      }
    }
    return out;
  }

  function subjectBonus(sub, bonus) {
    let r = bonus.area[sub.area] || 0;
    if (bonus.subjects[sub.subject]) r = Math.max(r, bonus.subjects[sub.subject]);
    if (bonus.subjects["Ⅱ"] && sub.area === "과탐" && /Ⅱ$/.test(sub.subject)) r = Math.max(r, bonus.subjects["Ⅱ"]);
    return r;
  }

  /* ---------- 영역 점수 ---------- */

  function basisOf(sc, area) {
    const b = (sc[area] && sc[area].basis) || sc.basis || "";
    if (/최고/.test(b) && /표점|표준/.test(b)) return "stdnorm";
    if (/백분위/.test(b) && !/변환/.test(b)) return "pct";
    if (/백분위변환|변환표준|변표/.test(b)) return "conv";
    if (/표준/.test(b)) return "std";
    if (sc.method === "percentile" || sc.method === "percentileWeighted" || sc.method === "rankWeighted" || sc.method === "bestN") return "pct";
    return "std";
  }

  // 빠진 성적을 "국어 표준점수"처럼 알려 준다
  function need(sc, area) {
    if (area === "english" || area === "history") return `${NAME[area]} 등급`;
    const b = basisOf(sc, area);
    return `${NAME[area] || area} ${b === "pct" ? "백분위" : "표준점수"}`;
  }

  function lerpTable(t, x) {
    if (x <= t[0][0]) return t[0][1];
    for (let i = 1; i < t.length; i++) if (x <= t[i][0]) { const [x0, y0] = t[i - 1], [x1, y1] = t[i]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0); }
    return t[t.length - 1][1];
  }

  function maxStd(exam, area, subject) {
    const m = exam.maxStd || {};
    if (area === "inquiry") return (m.inquiry && m.inquiry[subject]) || m.inquiryDefault || 70;
    return m[area] || 140;
  }

  // {raw, max} 또는 null(성적 없음)
  function areaScore(st, sc, area, exam, flags, bonus, denom) {
    const basis = basisOf(sc, area);
    if (area === "korean" || area === "math") {
      const s = st[area] || {};
      let raw, max;
      if (basis === "pct") { raw = num(s.pct); max = 100; }
      else { raw = num(s.std); max = denom || maxStd(exam, area); if (exam.provisional && !denom) flags.add("표준점수 최고점 임시값"); }
      if (basis === "stdnorm" && raw !== null) { raw = raw / maxStd(exam, area) * 100; max = 100; }
      if (raw === null) return null;
      if (area === "math" && bonus.math && (s.choice === "미적" || s.choice === "기하")) raw *= 1 + bonus.math;
      return { raw, max };
    }
    if (area === "inquiry") return inquiryScore(st, sc, exam, flags, bonus, denom);
    return null;
  }

  function inquiryScore(st, sc, exam, flags, bonus, denom) {
    const cfg = sc.inquiry || {};
    const count = cfg.count === 0 ? 0 : cfg.count || 2;
    if (count === 0) return null;
    const basis = basisOf(sc, "inquiry");
    const subs = (st.inquiry || []).filter((s) => s && s.subject);
    const vals = [];
    for (const s of subs) {
      let raw, max;
      if (basis === "pct") { raw = num(s.pct); max = 100; }
      else if (basis === "conv" && exam.convTable && num(s.pct) !== null) {
        // 변환표준점수는 백분위로 정해지므로 백분위→표준점수 대응표로 추정(과목 간 표준점수 차이 제거)
        raw = lerpTable(exam.convTable, s.pct); max = maxStd(exam, "inquiry", s.subject);
        flags.add("탐구 변환표준점수는 백분위로 추정");
      } else {
        raw = num(s.std); max = maxStd(exam, "inquiry", s.subject);
        if (basis === "conv") flags.add("탐구 변환표준점수 대신 표준점수 사용");
        if (exam.provisional) flags.add("표준점수 최고점 임시값");
      }
      if (raw === null) continue;
      if (basis === "stdnorm") { raw = raw / max * 100; max = 100; }
      const r = subjectBonus(s, bonus);
      vals.push({ raw: raw * (1 + r), max });
    }
    if (!vals.length) return null;
    vals.sort((a, b) => b.raw / b.max - a.raw / a.max);
    const take = vals.slice(0, count);
    if (take.length < count) flags.add("탐구 과목 수 부족");
    const raw = take.reduce((a, v) => a + v.raw, 0);
    const max = denom ? denom * (count === 1 ? 1 : count / 2) : take.reduce((a, v) => a + v.max, 0) * (count / take.length);
    const avg = /평균/.test(cfg.agg || "");
    return { raw: avg ? raw / take.length : raw, max: avg ? max / count : max };
  }

  function englishTable(sc) {
    const e = sc.english || {};
    return Array.isArray(e.byGrade) ? e.byGrade : null;
  }

  // 가중치에 들어가는 영어 점수 {raw, max}
  function englishWeighted(st, sc, flags) {
    const g = num(st.english && st.english.grade);
    if (g === null) return null;
    let t = englishTable(sc);
    if (!t) { t = [100, 95, 90, 85, 80, 75, 70, 65, 60]; flags.add("영어 환산표 미입력(기본표 사용)"); }
    const max = Math.max(...t);
    return { raw: t[g - 1], max: max > 0 ? max : 100 };
  }

  // 총점에 바로 더하거나 빼는 값 (영어 가산·감점, 한국사)
  function additive(table, type, grade) {
    if (!Array.isArray(table) || grade === null) return 0;
    const v = table[grade - 1];
    if (typeof v !== "number") return 0;
    if (table.some((x) => x < 0)) return v;
    if (/감점|차감/.test(type || "")) {
      return table[0] === 0 ? -v : v - Math.max(...table);
    }
    return v;
  }

  function historyPoints(st, sc) {
    const h = sc.history || {};
    return additive(h.byGrade, h.type, num(st.history && st.history.grade));
  }

  /* ---------- 가중치 결정 ---------- */

  // 고정 가중치 + bestOf/rankWeighted/bestN/chooseOne 를 학생 점수에 맞게 펼친다
  function resolveWeights(sc, norms) {
    const w = {};
    const base = sc.weights || sc.weightsMult || sc.fixed || sc.points || {};
    for (const [a, v] of Object.entries(base)) if (typeof v === "number") w[a] = v;

    const ranked = (areas) => areas.filter((a) => norms[a] !== undefined).sort((a, b) => norms[b] - norms[a]);
    const bestOfs = Array.isArray(sc.bestOf) ? sc.bestOf : sc.bestOf ? [sc.bestOf] : [];
    for (const bo of bestOfs) {
      const ws = bo.weights || [];
      ranked(bo.areas || []).forEach((a, i) => { w[a] = (w[a] || 0) + (ws[i] || 0); });
      (bo.areas || []).forEach((a) => { if (w[a] === undefined) w[a] = 0; });
    }
    if (sc.rankWeights && sc.areas) ranked(sc.areas).forEach((a, i) => { w[a] = sc.rankWeights[i] || 0; });
    if (sc.bestN && typeof sc.bestN === "object" && sc.bestN.areas) {
      const bn = sc.bestN, pts = bn.points || [];
      ranked(bn.areas).forEach((a, i) => { w[a] = (w[a] || 0) + (i < bn.n ? pts[i] || 100 : 0); });
    }
    if (sc.method === "bestN" && sc.areas) {
      ranked(sc.areas).forEach((a, i) => { w[a] = i < sc.n ? (sc.mult || 1) * 100 : 0; });
      if (sc.english && sc.english.mult) w.english = sc.english.mult * 100;
    }
    if (sc.chooseOne && sc.chooseOne.from) {
      const from = sc.chooseOne.from;
      const best = ranked(Object.keys(from))[0];
      if (best) w[best] = (w[best] || 0) + from[best];
    }
    return w;
  }

  /* ---------- 방식별 계산 ---------- */

  function normalizedScore(st, sc, unit, exam, flags, opt = {}) {
    const bonus = collectBonus(sc, unit, flags);
    const denom = opt.denom || num(sc.denominator) || (sc.method === "pointsOver200" ? 200 : sc.method === "fixedMax" ? num(sc.maxStd) : null);
    const parts = {};
    for (const a of ["korean", "math", "inquiry"]) {
      const v = areaScore(st, sc, a, exam, flags, bonus, denom);
      if (v) parts[a] = v;
    }
    const e = englishWeighted(st, sc, flags);
    const norms = {};
    for (const [a, v] of Object.entries(parts)) norms[a] = Math.min(v.raw / v.max, sc.method === "fixedMax" ? 1 : Infinity);
    if (e) norms.english = e.raw / e.max;
    const ht = sc.history && sc.history.byGrade, hg = num(st.history && st.history.grade);
    if (Array.isArray(ht) && hg !== null) norms.history = ht[hg - 1] / Math.max(...ht);

    const w = resolveWeights(sc, norms);
    const wsum = Object.values(w).reduce((a, b) => a + b, 0);
    if (!wsum) return null;
    const missing = Object.keys(w).filter((a) => w[a] > 0 && norms[a] === undefined).map((a) => need(sc, a));
    if (missing.length) return { missing };

    const total = num(sc.total) || (sc.points ? wsum : 1000);
    let score = 0;
    if (sc.method === "baseplusMax") {
      const base = num(sc.base) || 0, eff = num(sc.effective) || total - base;
      for (const [a, wt] of Object.entries(w)) score += (base + eff * (norms[a] ?? 0)) * wt / wsum;
    } else {
      for (const [a, wt] of Object.entries(w)) score += total * (wt / wsum) * (norms[a] ?? 0);
    }
    // 영어가 가중치에 없으면 가산·감점으로 처리
    if (!w.english && st.english) score += additive(englishTable(sc), (sc.english || {}).type, num(st.english.grade));
    if (!w.history) score += historyPoints(st, sc);
    // "평균 × a + b" 꼴 (예: 상위 3개 영역 평균 × 8.5 + 150)
    const lin = sc.bestN && /평균/.test(sc.bestN.agg || "") && (sc.formula || "").match(/×\s*([\d.]+)\s*\+\s*(\d+)/);
    if (lin) score = (score / total) * 100 * +lin[1] + +lin[2];
    if (num(sc.finalMult)) score *= sc.finalMult;
    return { score, total };
  }

  // 영역 점수를 그대로 곱하거나 더하는 방식 (weighted·sumRaw·sumScaled)
  function rawSumScore(st, sc, unit, exam, flags) {
    const bonus = collectBonus(sc, unit, flags);
    const hasWeights = sc.weights && Object.keys(sc.weights).length;
    if (hasWeights && !["korean", "math", "inquiry"].some((a) => sc[a] && sc[a].mult)) {
      return normalizedScore(st, sc, unit, exam, flags);
    }
    let score = 0, max = 0;
    for (const a of ["korean", "math", "inquiry"]) {
      if (!sc[a] && sc.method !== "sumRaw") continue;
      if (sc.parts && !sc.parts.includes(a)) continue;
      if (sc.inquiry && sc.inquiry.count === 0 && a === "inquiry") continue;
      const v = areaScore(st, sc, a, exam, flags, bonus, null);
      if (!v) return { missing: [need(sc, a)] };
      const mult = (sc[a] && num(sc[a].mult)) || 1;
      const cap = sc[a] && num(sc[a].cap);
      let s = v.raw * mult;
      if (cap !== null && cap !== undefined) s = Math.min(s, cap);
      score += s; max += cap || v.max * mult;
    }
    const g = num(st.english && st.english.grade);
    const t = englishTable(sc);
    let engAdd = 0; // 가산·감점형 영어는 한국사처럼 최종 척도에서 더하거나 뺀다(고려대: 1000점 환산 후 감점)
    if (t && g !== null) {
      const ev = t[g - 1];
      const mult = num((sc.english || {}).mult) || 1;
      if (/가산|감점|차감/.test((sc.english || {}).type || "")) engAdd = additive(t, sc.english.type, g);
      else { score += ev * mult; max += Math.max(...t) * mult; }
    }
    let total = num(sc.total) || num(sc.rawTotal) || Math.round(max);
    if (num(sc.rawTotal) && num(sc.total)) score = score * sc.total / sc.rawTotal;
    score += historyPoints(st, sc) + engAdd;
    if (sc.method === "sumScaled") {
      const m = (sc.formula || "").match(/\/\s*(\d+)\s*×\s*(\d+)/);
      if (m) { score = score / +m[1] * +m[2]; total = +m[2]; }
      flags.add("산식 근사");
    }
    if (num(sc.finalMult)) score *= sc.finalMult;
    return { score, total };
  }

  function gradeScore(st, sc, unit, exam, flags) {
    const gp = sc.gradePoints || [];
    const norms = {};
    for (const a of ["korean", "math"]) { const g = num(st[a] && st[a].grade); if (g) norms[a] = (gp[g - 1] || 0) / gp[0]; }
    const subs = (st.inquiry || []).filter((s) => num(s.grade));
    if (subs.length) norms.inquiry = Math.max(...subs.map((s) => (gp[s.grade - 1] || 0) / gp[0]));
    const e = englishWeighted(st, sc, flags); if (e) norms.english = e.raw / e.max;
    const w = resolveWeights(sc, norms);
    const wsum = Object.values(w).reduce((a, b) => a + b, 0) || 1;
    const total = num(sc.total) || 1000;
    let score = 0;
    for (const [a, wt] of Object.entries(w)) score += total * wt / wsum * (norms[a] ?? 0);
    flags.add("등급 기반 산식 근사");
    return { score: score + historyPoints(st, sc), total };
  }

  function scoreWith(st, univ, key, unit, exam, flags, depth = 0) {
    const sc = univ.scoring[key];
    if (!sc) return { error: "환산식 없음" };
    if (APPROX_METHODS.has(sc.method)) flags.add("산식 근사");
    switch (sc.method) {
      case "max": {
        if (depth > 2) return { error: "환산식 순환" };
        let best = null;
        for (const v of sc.variants || []) {
          let r;
          if (typeof v === "object") {
            const merged = Object.assign({ method: "weighted" }, { english: sc.english, history: sc.history, total: sc.total }, v);
            r = scoreWith(st, { scoring: { _v: merged } }, "_v", unit, exam, flags, depth + 1);
          } else r = scoreWith(st, univ, v, unit, exam, flags, depth + 1);
          if (r && r.score !== undefined && (!best || r.score / r.total > best.score / best.total)) best = r;
        }
        return best || { error: "계산 불가" };
      }
      case "grade": return gradeScore(st, sc, unit, exam, flags);
      case "weighted":
      case "sumRaw":
      case "sumScaled":
        return rawSumScore(st, sc, unit, exam, flags);
      default:
        return normalizedScore(st, sc, unit, exam, flags);
    }
  }

  function compute(unit, univ, student, exam) {
    const flags = new Set();
    const el = eligibility(unit, univ, student);
    if (!unit.sc) return { eligible: el.eligible, reasons: el.reasons, error: unit.p ? "실기 위주" : "환산식 없음", flags: [] };
    let r;
    try { r = scoreWith(student, univ, unit.sc, unit, exam, flags); } catch (e) { r = { error: "계산 오류" }; }
    if (!r) r = { error: "계산 불가" };
    if (r.missing) r = { error: `${[...new Set(r.missing)].join(", ")} 필요` };
    if (unit.p) flags.add("실기 반영(수능 점수만 계산)");
    return {
      score: r.score !== undefined ? Math.round(r.score * 100) / 100 : null,
      total: r.total ?? null,
      error: r.error || null,
      eligible: el.eligible,
      reasons: el.reasons,
      flags: [...flags],
    };
  }

  // 모든 영역 최고점을 받은 학생의 점수 = 화면에 보여 줄 "만점(추정)"
  function perfectStudents(exam) {
    const m = exam.maxStd || {}, iq = m.inquiryDefault || 70;
    const base = { korean: { choice: "언매", std: m.korean || 140, pct: 100, grade: 1 },
      math: { choice: "미적", std: m.math || 140, pct: 100, grade: 1 }, english: { grade: 1 }, history: { grade: 1 } };
    return [
      Object.assign({}, base, { inquiry: [{ subject: "물리학Ⅱ", area: "과탐", std: iq, pct: 100, grade: 1 }, { subject: "화학Ⅱ", area: "과탐", std: iq, pct: 100, grade: 1 }] }),
      Object.assign({}, base, { math: { choice: "확통", std: m.math || 140, pct: 100, grade: 1 }, inquiry: [{ subject: "생활과 윤리", area: "사탐", std: iq, pct: 100, grade: 1 }, { subject: "사회·문화", area: "사탐", std: iq, pct: 100, grade: 1 }] }),
    ];
  }

  function perfectScore(unit, univ, exam) {
    let best = null;
    for (const st of perfectStudents(exam)) {
      const r = compute(unit, univ, st, exam);
      if (r.score !== null && (best === null || r.score > best)) best = r.score;
    }
    return best;
  }

  /* ---------- 합격 판정 ----------
   * cuts: 배치표·지원참고표에서 연결한 기준선 [{year, kind, std, pct, m(이름 일치도), gd(군 변경)}]
   * 학생의 국+수+탐2 표준점수 합·백분위 합과 비교해 합격 가능성(대략)과 7단계를 낸다.
   */
  const TIERS = [
    { min: 0.75, name: "안정" }, { min: 0.60, name: "적정" }, { min: 0.50, name: "소신" },
    { min: 0.40, name: "위험" }, { min: 0.25, name: "무모" }, { min: 0, name: "불가" },
  ];
  const YEAR_W = { 2026: 1, 2025: 0.7, 2024: 0.45, 2023: 0.3 };

  function sums(st) {
    const k = st.korean || {}, m = st.math || {};
    const inq = (st.inquiry || []).filter((x) => x && x.subject);
    const two = (key) => {
      const v = inq.map((x) => num(x[key])).filter((x) => x !== null).sort((a, b) => b - a);
      return v.length >= 2 ? v[0] + v[1] : null;
    };
    // 배치표 기준: 표준점수는 국+수+탐 2과목 합(600 척도), 백분위는 국+수+탐 2과목 평균(300 척도)
    const tp = two("pct");
    const s = [num(k.std), num(m.std), two("std")], p = [num(k.pct), num(m.pct), tp === null ? null : tp / 2];
    return { std: s.includes(null) ? null : s[0] + s[1] + s[2], pct: p.includes(null) ? null : p[0] + p[1] + p[2] };
  }

  /* 대학별 계산 방식으로 판정한다.
   * 배치표 합격선(국·수·탐 백분위합 또는 표준합)을 "그 선에 걸친 학생"의 성적으로 바꾼 뒤,
   * 그 학생과 우리 학생을 같은 대학 환산식(백분위/표준점수, 탐구 1·2과목, 영어·한국사 표, 가산점 등)으로 계산해 비교한다.
   *  - 합격선 학생: 국·수·탐 모두 같은 백분위 p (= 백분위합/3). 표준점수는 백분위→표준점수 대응표(ctx.tables)로.
   *  - 영어·한국사: 그 백분위 수준 학생의 흔한 등급.
   *  - 자연계 학과(unit.nat)의 합격선 학생은 미적·과탐 응시자, 인문계는 확통·사탐 응시자로 둔다.
   *    1·2학년(ctx.mode === "mock")은 선택과목이 없으므로 둘 다 공통·통합으로 둔다.
   *  - 차이를 "표준합 6점이 늘 때 그 대학 환산점수가 늘어나는 폭"으로 나눠, 이전과 같은 단위로 판정 단계를 낸다.
   */
  function lerp(t, x) {
    if (x <= t[0][0]) return t[0][1];
    for (let i = 1; i < t.length; i++) if (x <= t[i][0]) { const [x0, y0] = t[i - 1], [x1, y1] = t[i]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0); }
    return t[t.length - 1][1];
  }
  const GRADE_CUT = [96, 89, 77, 60, 40, 23, 11, 4];
  const gradeOfPct = (p) => { for (let i = 0; i < GRADE_CUT.length; i++) if (p >= GRADE_CUT[i]) return i + 1; return 9; };

  function repStudent(p, nat, ctx, off = { k: 0, m: 0 }) {
    const T = ctx.tables, mock = ctx.mode === "mock";
    const g = gradeOfPct(p);
    const eng = p >= 94.5 ? 1 : p >= 78 ? 2 : p >= 55 ? 3 : p >= 35 ? 4 : 5; // 영어 절대평가 등급 비율(평가원 2023~2026 평균) 기준
    const hist = p >= 75 ? 1 : p >= 50 ? 2 : 3;
    const subj = mock ? [["통합사회", "통합"], ["통합과학", "통합"]]
      : nat ? [["생명과학Ⅰ", "과탐"], ["지구과학Ⅰ", "과탐"]] : [["사회·문화", "사탐"], ["생활과 윤리", "사탐"]];
    const istd = lerp(T.inquiry, p);
    return {
      korean: { choice: mock ? "공통" : nat ? "언매" : "화작", std: lerp(T.korean, p) + off.k, pct: p, grade: g },
      math: { choice: mock ? "공통" : nat ? "미적" : "확통", std: lerp(T.math, p) + off.m, pct: p, grade: g },
      english: { grade: eng }, history: { grade: hist },
      inquiry: subj.map(([subject, area]) => ({ subject, area, choice: mock ? "통합" : undefined, std: istd, pct: p, grade: g })),
    };
  }
  const repStdSum = (p, T) => lerp(T.korean, p) + lerp(T.math, p) + 2 * lerp(T.inquiry, p);

  // 표준합 S가 되는 평균 백분위 p (백분위합이 없는 합격선용)
  function pctForStdSum(S, T) {
    let lo = 0, hi = 100;
    for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (repStdSum(m, T) < S) lo = m; else hi = m; }
    return (lo + hi) / 2;
  }

  const STEP = 4;
  // 영어 등급 누적 비율(상위 %, 평가원 2023~2026 평균)과 영어·국수탐 종합 위치의 상관(가정)
  const ENG_CUM = [5.5, 22.3, 45.7, 66.8, 80.3, 88.9, 94.6, 98.6];
  const ENG_RHO = 0.75, AREA_K = 0.954;
  // 국·수·탐 평균 백분위 p인 학생의 영어 등급 확률 [1등급, 2등급, ...]
  function engProbs(p) {
    const zc = ninv(Math.min(Math.max(p, 0.01), 99.99) / 100) / AREA_K;
    const mu = ENG_RHO * zc, sd = Math.sqrt(1 - ENG_RHO * ENG_RHO);
    const cuts = ENG_CUM.map((c) => ninv(1 - c / 100)); // 각 등급 아래 경계(z)
    const pr = [];
    let upper = 1;
    for (let g = 0; g < 9; g++) {
      const below = g < 8 ? ncdf((cuts[g] - mu) / sd) : 0;
      pr.push(Math.max(0, upper - below)); upper = below;
    }
    return pr;
  }
  const repCache = new Map();
  // 합격선 학생의 환산점수: 영어 등급을 하나로 정하지 않고 등급 확률로 가중 평균
  function expScore(unit, univ, p, nat, ctx, off) {
    const pr = engProbs(p);
    let sum = 0, w = 0;
    for (let g = 0; g < pr.length; g++) {
      if (pr[g] < 0.005) continue;
      const st = repStudent(p, nat, ctx, off);
      st.english = { grade: g + 1 };
      const r = compute(unit, univ, st, ctx.exam);
      if (r.score === null) return null;
      sum += pr[g] * r.score; w += pr[g];
    }
    return w ? sum / w : null;
  }

  function repScore(unit, univ, p, ctx, off) {
    const nat = !!unit.nat;
    const key = `${unit.u}|${unit.i}|${ctx.mode}|${p.toFixed(2)}|${off.k.toFixed(1)}|${off.m.toFixed(1)}`;
    if (repCache.has(key)) return repCache.get(key);
    const T = ctx.tables;
    const r0 = expScore(unit, univ, p, nat, ctx, off);
    // 판정 한 칸(로짓 1)의 폭 = 표준합 STEP점에 해당하는 그 대학 환산점수 차이
    const target = repStdSum(p, T) + STEP;
    let p2 = p;
    if (repStdSum(100, T) > target) { let lo = p, hi = 100; for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (repStdSum(m, T) < target) lo = m; else hi = m; } p2 = (lo + hi) / 2; }
    else p2 = Math.min(100, p + 3);
    const r1 = expScore(unit, univ, p2, nat, ctx, off);
    const out = r0 === null || r1 === null ? null : { R: r0, scale: Math.max(r1 - r0, 1e-6) };
    repCache.set(key, out);
    return out;
  }

  // 표준정규분포
  function ncdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2);
    const q = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - q : q;
  }
  function ninv(p) { let lo = -8, hi = 8; for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (ncdf(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; }

  /* 누백 지원선(적정 80% · 예상 50% · 소신 20%)이 있는 학과(의대 등):
   * 각 지원선의 누백 → 합격선 학생의 영역 백분위(영역 z = k × 종합 z) → 그 대학 환산점수 R80·R50·R20.
   * 내 환산점수를 이 세 점 사이에서 로짓(합격률) 기준으로 보간해 합격 가능성을 낸다. */
  function verdictNubaek(student, unit, univ, ctx, M, off) {
    const nb = unit.nb, k = nb.k || 0.954;
    const pts = [[nb.c80, 0.8], [nb.c50, 0.5], [nb.c20, 0.2]].map(([cum, pr]) => {
      const p = ncdf(k * ninv(1 - cum / 100)) * 100;
      const rep = repScore(unit, univ, Math.round(p * 1000) / 1000, ctx, off);
      return rep ? { R: rep.R, L: Math.log(pr / (1 - pr)), cum } : null;
    });
    if (pts.some((x) => !x)) return null;
    // R가 큰 순(적정 → 예상 → 소신)
    const [a, b, c] = pts;
    const seg = (x, y) => (x.R - y.R) > 1e-6 ? (x.L - y.L) / (x.R - y.R) : 0;
    let L;
    if (M >= b.R) L = b.L + seg(a, b) * (M - b.R);
    else L = b.L + seg(b, c) * (M - b.R);
    const prob = 1 / (1 + Math.exp(-L));
    const tier = TIERS.find((t) => prob >= t.min).name;
    return { prob, tier, M, detail: [{ year: nb.year, R: b.R, M, d: M - b.R, label: "예상선" }] };
  }

  /* 대학 공개 입결(어디가): 최종등록자 70% 컷 학생의 과목별 백분위·영어/한국사 등급이 있으면
   * 그 성적으로 합격선 학생을 그대로 만든다(대학마다 다른 합격자 성적 구성을 반영).
   * 백분위가 없고 대학 환산점수 컷만 있으면 그 점수를 합격선으로 쓴다. */
  function profileStudent(pr, nat, ctx, off) {
    const T = ctx.tables, mock = ctx.mode === "mock";
    const subj = mock ? [["통합사회", "통합"], ["통합과학", "통합"]]
      : nat ? [["생명과학Ⅰ", "과탐"], ["지구과학Ⅰ", "과탐"]] : [["사회·문화", "사탐"], ["생활과 윤리", "사탐"]];
    return {
      korean: { choice: mock ? "공통" : nat ? "언매" : "화작", std: lerp(T.korean, pr.k) + off.k, pct: pr.k, grade: gradeOfPct(pr.k) },
      math: { choice: mock ? "공통" : nat ? "미적" : "확통", std: lerp(T.math, pr.m) + off.m, pct: pr.m, grade: gradeOfPct(pr.m) },
      english: { grade: pr.e || 1 }, history: { grade: pr.h || 1 },
      inquiry: [pr.t1, pr.t2].map((t, i) => ({ subject: subj[i][0], area: subj[i][1], choice: mock ? "통합" : undefined, std: lerp(T.inquiry, t), pct: t, grade: gradeOfPct(t) })),
    };
  }

  function ipLine(row, unit, univ, ctx, off) {
    let pr = row.p70;
    // 탐구 1과목만 반영하는 모집단위는 탐2가 비어 있으므로 탐1과 같게 둔다
    if (pr && num(pr.t2) === null && num(pr.t1) !== null) pr = Object.assign({}, pr, { t2: pr.t1 });
    if (pr && [pr.k, pr.m, pr.t1, pr.t2].every((x) => num(x) !== null)) {
      const pAvg = (pr.k + pr.m + (pr.t1 + pr.t2) / 2) / 3;
      let r;
      if (num(pr.e) === null) {
        // 영어 등급이 공개되지 않은 경우(고려대 등): 그 수준 학생의 영어 등급 확률로 기댓값
        const probs = engProbs(pAvg); let sum = 0, w = 0, bad = false;
        probs.forEach((q, g) => { if (q < 0.005 || bad) return; const x = compute(unit, univ, profileStudent(Object.assign({}, pr, { e: g + 1 }), !!unit.nat, ctx, off), ctx.exam); if (x.score === null) bad = true; else { sum += q * x.score; w += q; } });
        r = { score: bad || !w ? null : sum / w };
      } else r = compute(unit, univ, profileStudent(pr, !!unit.nat, ctx, off), ctx.exam);
      const sc = repScore(unit, univ, Math.round(pAvg * 10) / 10, ctx, off);
      if (r.score === null || !sc) return null;
      return { R: r.score, scale: sc.scale };
    }
    if (num(row.conv70) !== null && row.sameScale) {
      // 환산점수 컷만 있는 경우: 그 점수와 같은 환산점수를 내는 평균 백분위를 찾아 판정 폭을 구한다
      let lo = 50, hi = 100;
      for (let i = 0; i < 25; i++) { const m = (lo + hi) / 2; const x = repScore(unit, univ, Math.round(m * 10) / 10, ctx, off); if (x && x.R < row.conv70) lo = m; else hi = m; }
      const sc = repScore(unit, univ, Math.round(((lo + hi) / 2) * 10) / 10, ctx, off);
      return sc ? { R: row.conv70, scale: sc.scale } : null;
    }
    return null;
  }

  function verdict(student, unit, univ, ctx) {
    const cuts = unit && unit.ct;
    if (unit && unit.nb && ctx && ctx.tables) {
      const mine = compute(unit, univ, student, ctx.exam);
      if (mine.score === null || mine.error) return null;
      const T = ctx.tables, k = student.korean || {}, mm = student.math || {};
      const off = {
        k: num(k.std) !== null && num(k.pct) !== null ? k.std - lerp(T.korean, k.pct) : 0,
        m: num(mm.std) !== null && num(mm.pct) !== null ? mm.std - lerp(T.math, mm.pct) : 0,
      };
      return verdictNubaek(student, unit, univ, ctx, mine.score, off);
    }
    if ((!cuts || !cuts.length) && !(unit && unit.ip && unit.ip.length)) return null;
    if (!ctx || !ctx.tables) return null;
    const mine = compute(unit, univ, student, ctx.exam);
    if (mine.score === null || mine.error) return null;
    const M = mine.score;
    // 학생 성적표의 백분위↔표준점수 관계가 대응표와 얼마나 어긋나는지(시험 난이도에 따른 척도 차이)를
    // 합격선 학생에게도 똑같이 적용해 같은 척도에서 비교한다.
    const T = ctx.tables, k = student.korean || {}, mm = student.math || {};
    const off = {
      k: num(k.std) !== null && num(k.pct) !== null ? k.std - lerp(T.korean, k.pct) : 0,
      m: num(mm.std) !== null && num(mm.pct) !== null ? mm.std - lerp(T.math, mm.pct) : 0,
    };
    const byYear = new Map();
    const detail = [];
    // 학과의 합격선 중 다른 해·다른 자료와 동떨어진 값(평균 백분위 중앙값에서 6 이상)은 잘못 연결된 것으로 보고 뺀다
    const pOf = (c) => (num(c.pct) ? Math.min(100, c.pct / 3) : num(c.std) ? pctForStdSum(c.std, ctx.tables) : null);
    const ps = cuts.map(pOf).filter((x) => x !== null).sort((a, b) => a - b);
    const med = ps.length ? ps[Math.floor(ps.length / 2)] : null;
    for (const c of cuts || []) {
      let p = null;
      if (med !== null && pOf(c) !== null && Math.abs(pOf(c) - med) > 6) continue;
      if (num(c.pct)) p = Math.min(100, c.pct / 3);
      else if (num(c.std)) p = pctForStdSum(c.std, ctx.tables);
      if (p === null) continue;
      const rep = repScore(unit, univ, Math.round(p * 10) / 10, ctx, off);
      if (!rep) continue;
      const u = (M - rep.R) / rep.scale;
      let w = (c.m || 1) * (c.gd ? 0.7 : 1);
      if (c.kind === "가채점") w *= 0.5;
      const y = byYear.get(c.year) || { w: 0, u: 0 };
      y.w += w; y.u += w * u; byYear.set(c.year, y);
      detail.push({ year: c.year, R: rep.R, M, d: M - rep.R });
    }
    for (const row of unit.ip || []) {
      const L = ipLine(row, unit, univ, ctx, off);
      if (!L) continue;
      const y = byYear.get(row.year);
      if (!y || !y.ip) { byYear.set(row.year, { w: 0, u: 0, ip: true }); detail.splice(0, detail.length, ...detail.filter((d) => d.year !== row.year)); }
      const yy = byYear.get(row.year);
      yy.w += 1; yy.u += (M - L.R) / L.scale;
      detail.push({ year: row.year, R: L.R, M, d: M - L.R, label: "70%컷" });
    }
    let wsum = 0, usum = 0;
    for (const [year, y] of byYear) {
      const yw = (YEAR_W[year] || 0.2) * Math.min(1, y.w);
      wsum += yw; usum += yw * (y.u / y.w);
    }
    if (!wsum) return null;
    const U = usum / wsum;
    // 합격선 학생과 환산점수가 같으면 적정(약 65%)
    const prob = 1 / (1 + Math.exp(-(U + 0.62)));
    const tier = TIERS.find((t) => prob >= t.min).name;
    return { prob, tier, M, detail };
  }

  const api = { compute, eligibility, perfectScore, verdict, sums, TIERS, AREAS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.UnionEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
