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

  // 상위 top 비율 안의 N수생 비율
  function nShareTop(a, d, top) {
    let lo = -8, hi = 10, x = 0;
    for (let i = 0; i < 80; i++) {
      x = (lo + hi) / 2;
      const f = a * (1 - cdf(x)) + (1 - a) * (1 - cdf(x - d));
      if (f > top) lo = x; else hi = x;
    }
    return (1 - a) * (1 - cdf(x - d)) / top;
  }

  const deltaCache = new Map();
  function delta(a, target) {
    const k = `${a}|${target}`;
    if (deltaCache.has(k)) return deltaCache.get(k);
    let lo = 0, hi = 5;
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (nShareTop(a, m, 0.04) < target) lo = m; else hi = m; }
    deltaCache.set(k, (lo + hi) / 2);
    return (lo + hi) / 2;
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

  // 학평 백분위 하나 → {pct, std, grade, drop}
  function projectPct(pct, kind, choice, C) {
    if (pct === null || pct === undefined || pct === "") return null;
    const a = C.schoolShare;
    const target = C.top1Share[choice] ?? C.top1Share.default;
    const d = delta(a, target);
    const p = Math.min(Math.max(Number(pct), 0.25), 99.75) / 100; // 백분위 0·100은 구간 중앙값으로
    const z = inv(p);
    const q = (a * cdf(z) + (1 - a) * cdf(z - d)) * 100;
    const out = Math.round(q * 10) / 10;
    return { pct: out, std: Math.round(interp(C.pctToStd[kind], q)), grade: gradeOf(q, C.gradeCut), drop: Math.round((Number(pct) - out) * 10) / 10 };
  }

  // 학평 성적 → 엔진이 쓰는 수능 성적 형식
  function project(mock, C) {
    const k = mock.korean || {}, m = mock.math || {};
    const kp = projectPct(k.pct, "korean", k.choice, C);
    const mp = projectPct(m.pct, "math", m.choice, C);
    const inq = (mock.inquiry || []).map((s) => {
      const r = projectPct(s.pct, "inquiry", s.choice || s.area, C);
      return r ? { subject: s.subject, area: s.area, std: r.std, pct: r.pct, grade: r.grade, from: s.pct, drop: r.drop } : null;
    }).filter(Boolean);
    return {
      korean: kp ? { choice: k.choice, std: kp.std, pct: kp.pct, grade: kp.grade, from: k.pct, drop: kp.drop } : { choice: k.choice },
      math: mp ? { choice: m.choice, std: mp.std, pct: mp.pct, grade: mp.grade, from: m.pct, drop: mp.drop } : { choice: m.choice },
      english: { grade: mock.english && mock.english.grade },
      history: { grade: mock.history && mock.history.grade },
      inquiry: inq,
    };
  }

  const api = { project, projectPct, nShareTop, delta };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.UnionCorrection = api;
})(typeof window !== "undefined" ? window : globalThis);
