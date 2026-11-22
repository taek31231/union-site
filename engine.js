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
        const hit = ok.some((s) => iq.mustInclude.some((m) => s.subject === m || s.subject.replace(/[ⅠⅡ]$/, "") === m.replace(/[ⅠⅡ]$/, "") && (!/[ⅠⅡ]$/.test(m) || s.subject.endsWith(m.slice(-1)))));
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
      else {
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
    if (t && g !== null) {
      const ev = t[g - 1];
      const mult = num((sc.english || {}).mult) || 1;
      if (/가산|감점|차감/.test((sc.english || {}).type || "")) score += additive(t, sc.english.type, g);
      else { score += ev * mult; max += Math.max(...t) * mult; }
    }
    score += historyPoints(st, sc);
    let total = num(sc.total) || num(sc.rawTotal) || Math.round(max);
    if (num(sc.rawTotal) && num(sc.total)) {
      const h = historyPoints(st, sc);
      score = (score - h) * sc.total / sc.rawTotal + h;
    }
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

  function verdict(student, cuts) {
    if (!cuts || !cuts.length) return null;
    const me = sums(student);
    if (me.std === null && me.pct === null) return null;
    let wsum = 0, usum = 0;
    const detail = [];
    for (const c of cuts) {
      // 표준점수 합 기준. 표준합이 없을 때만 백분위 합으로 대신한다.
      const parts = [];
      if (me.std !== null && num(c.std)) parts.push((me.std - c.std) / 6);
      else if (me.pct !== null && num(c.pct)) parts.push((me.pct - c.pct) / 4);
      if (!parts.length) continue;
      const u = parts.reduce((a, b) => a + b, 0) / parts.length;
      let w = (YEAR_W[c.year] || 0.2) * (c.m || 1) * (c.gd ? 0.7 : 1);
      if (c.kind === "가채점") w *= 0.5;
      wsum += w; usum += w * u;
      detail.push({ year: c.year, source: c.source, std: c.std, pct: c.pct, dStd: me.std !== null && num(c.std) ? me.std - c.std : null, dPct: me.pct !== null && num(c.pct) ? me.pct - c.pct : null });
    }
    if (!wsum) return null;
    const U = usum / wsum;
    // 배치표 합격선과 같은 점수 = 적정(약 65%)
    const prob = 1 / (1 + Math.exp(-(U + 0.62)));
    const tier = TIERS.find((t) => prob >= t.min).name;
    return { prob, tier, me, detail };
  }

  const api = { compute, eligibility, perfectScore, verdict, sums, TIERS, AREAS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.UnionEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
