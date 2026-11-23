/* uniON 1·2학년 모의지원 보정: 학평 백분위 → 예상 수능 백분위·표준점수·등급
 * 학평은 재학생만 보는 시험이라, 실제 수능에서는 N수생이 위쪽에 많이 들어와 같은 실력이라도 백분위가 내려간다.
 * 위쪽일수록 N수생 비율이 높지만 백분위 간격이 좁아, 백분위 하락 폭은 1등급 안에서도 다르다(100보다 96이 더 많이 내려감).
 */
(function (root) {
  "use strict";

  // 표준정규분포 누적함수와 역함수
  function cdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp(-x * x / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
  }
  function inv(p) {
    let lo = -8, hi = 8;
    for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (cdf(m) < p) lo = m; else hi = m; }
    return (lo + hi) / 2;
  }

  // N수생 분포: 강한 무리(비율 s)는 δ만큼 위, 나머지는 재학생과 비슷
  const nCdf = (x, d, s) => s * cdf(x - d) + (1 - s) * cdf(x);

  // 상위 top 비율 안의 N수생 비율
  function nShareTop(a, d, top, s = 1) {
    let lo = -8, hi = 10, x = 0;
    for (let i = 0; i < 80; i++) {
      x = (lo + hi) / 2;
      const f = a * (1 - cdf(x)) + (1 - a) * (1 - nCdf(x, d, s));
      if (f > top) lo = x; else hi = x;
    }
    return (1 - a) * (1 - nCdf(x, d, s)) / top;
  }

  const deltaCache = new Map();
  function delta(a, target, s = 1) {
    const k = `${a}|${target}|${s}`;
    if (deltaCache.has(k)) return deltaCache.get(k);
    let lo = 0, hi = 8;
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (nShareTop(a, m, 0.04, s) < target) lo = m; else hi = m; }
    deltaCache.set(k, (lo + hi) / 2);
    return (lo + hi) / 2;
  }

  // 재학생 기준 z → 수능 전체에서의 누적 비율(평가원 분포에 맞춘 혼합 모델)
  function toCsat(z, C) {
    const M = C.model;
    if (!M) { // 예전 형식
      const a = C.schoolShare, d = delta(a, C.top1Share.default ?? 0.6, C.strongShare ?? 1);
      return a * cdf(z) + (1 - a) * nCdf(z, d, C.strongShare ?? 1);
    }
    const n = (1 - M.eliteShare) * cdf((z - M.mu) / M.sd) + M.eliteShare * cdf((z - M.eliteMu) / M.eliteSd);
    return M.schoolShare * cdf(z) + (1 - M.schoolShare) * n;
  }

  function interp(table, x) {
    if (x <= table[0][0]) return table[0][1];
    for (let i = 1; i < table.length; i++) {
      const [x1, y1] = table[i], [x0, y0] = table[i - 1];
      if (x <= x1) return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
    return table[table.length - 1][1];
  }

  function gradeOf(pct, cuts) {
    for (let i = 0; i < cuts.length; i++) if (pct >= cuts[i]) return i + 1;
    return 9;
  }

  const isNum = (v) => v !== null && v !== undefined && v !== "" && isFinite(Number(v));

  // 학평 성적 하나 → {pct, std, grade, drop}
  // 학평 표준점수가 있으면 표준점수로, 없으면 백분위로 학평 안에서의 위치(재학생 기준)를 구한다.
  function projectScore(s, kind, choice, C) {
    if (!s) return null;
    let z, fromPct;
    if (isNum(s.std)) {
      // 실제 점수 분포는 위쪽이 막혀 있어 정규분포 공식((표점−100)/20)은 상위권을 낮게 잡는다.
      // 그래서 표준점수→백분위 대응표를 거꾸로 써서 학평 안에서의 백분위를 구한다.
      const p = interp(C.pctToStd[kind].map(([x, y]) => [y, x]), Number(s.std));
      fromPct = isNum(s.pct) ? Number(s.pct) : Math.round(p * 10) / 10;
      z = inv(Math.min(Math.max(p, 0.25), 99.75) / 100);
    } else if (isNum(s.pct)) {
      fromPct = Number(s.pct);
      z = inv(Math.min(Math.max(fromPct, 0.25), 99.75) / 100); // 백분위 0·100은 구간 중앙값으로
    } else return null;
    const q = toCsat(z, C) * 100;
    const out = Math.round(q * 10) / 10;
    return { pct: out, std: Math.round(interp(C.pctToStd[kind], q)), grade: gradeOf(q, C.gradeCut),
      drop: Math.round((fromPct - out) * 10) / 10, fromStd: isNum(s.std) ? Number(s.std) : null, fromPct: isNum(s.pct) ? Number(s.pct) : null };
  }

  function projectPct(pct, kind, choice, C) { return projectScore({ pct }, kind, choice, C); }

  // 학평 성적 → 엔진이 쓰는 수능 성적 형식
  function project(mock, C) {
    const k = mock.korean || {}, m = mock.math || {};
    const wrap = (src, r) => (r ? { choice: src.choice, std: r.std, pct: r.pct, grade: r.grade, fromStd: r.fromStd, fromPct: r.fromPct, drop: r.drop } : { choice: src.choice });
    const inq = (mock.inquiry || []).map((s) => {
      const r = projectScore(s, "inquiry", s.choice || s.area, C);
      return r ? Object.assign(wrap(s, r), { subject: s.subject, area: s.area }) : null;
    }).filter(Boolean);
    return {
      korean: wrap(k, projectScore(k, "korean", k.choice, C)),
      math: wrap(m, projectScore(m, "math", m.choice, C)),
      english: { grade: mock.english && mock.english.grade },
      history: { grade: mock.history && mock.history.grade },
      inquiry: inq,
    };
  }

  const api = { project, projectPct, projectScore, toCsat, nShareTop, delta };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.UnionCorrection = api;
})(typeof window !== "undefined" ? window : globalThis);
