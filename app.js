/* Confluence Radar 대시보드 — 암호화된 데이터를 브라우저에서 풀어 보여준다 (서버 없음).
   2026-11-21 전면 개편: 종목마다 답은 하나(build.py decide → call). 목록·상세·차트가 같은 답을 보여 준다.
   탭 4개 — 이번 주(할 일) · 종목(전부, 답 하나씩) · 시장(흐름) · 도움말(따라 하는 법·용어·기록). */
(() => {
  "use strict";
  const app = document.getElementById("app");
  const PW_KEY = "cr.pw";
  const TAB_KEY = "cr.tab2";
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* 사생활 보호 모드 등 */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* 무시 */ } },
  };
  let key = null;          // CryptoKey
  let index = null;        // 목록 데이터
  const cache = new Map(); // 종목 상세

  // ── DOM 도우미 (문자열은 항상 textContent 로) ──
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(3)) {
      if (kid === null || kid === undefined || kid === false || kid === "") continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  // ── 복호화 ──
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  async function deriveKey(pw, sealed) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: b64(sealed.salt), iterations: sealed.iter, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  }
  async function openSealed(sealed, withKey) {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(sealed.iv) }, withKey || key, b64(sealed.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  }
  async function fetchSealed(path) {
    const r = await fetch(path + "?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error("데이터를 불러오지 못했습니다 (" + r.status + ")");
    return r.json();
  }
  async function unlock(pw) {
    // 공유 비밀번호 → 발굴·지수만 / 본인 비밀번호 → owner.json 으로 보유까지
    const sealed = await fetchSealed("data/index.json");
    try {
      key = await deriveKey(pw, sealed);
      index = await openSealed(sealed);
      return;
    } catch (e) { /* 공유 비밀번호가 아니면 본인 비밀번호인지 확인 */ }
    let ownerSealed;
    try { ownerSealed = await fetchSealed("data/owner.json"); } catch (e) { throw new DOMException("x", "OperationError"); }
    const owner = await openSealed(ownerSealed, await deriveKey(pw, ownerSealed));  // 틀리면 OperationError
    key = await deriveKey(owner.shared_pw, sealed);
    index = await openSealed(sealed);
    index.groups = Object.assign({}, index.groups, owner.groups);
    index.owner = true;
  }

  // ── 숫자 표기 (차트 축) ──
  const trim = (v, d) => v.toLocaleString("ko-KR", { minimumFractionDigits: 0, maximumFractionDigits: d });
  function fmtPrice(v, pf) {
    if (pf === "man") return v >= 10000 ? trim(v / 10000, 2) + "만" : trim(v, 0);
    if (pf === "jpy100") return trim(v * 100, 2);
    if (pf === "usd") return trim(v, 2);
    return v >= 100 ? trim(v, 2) : trim(v, 4);
  }
  const pctR = (v) => (v == null ? "-" : Math.round(v * 100) + "%");
  const sgn1 = (v) => (v == null ? "" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v) + "%");

  // ── 로그인 ──
  function renderLogin(msg) {
    const input = h("input", { type: "password", placeholder: "비밀번호", autocomplete: "current-password", "aria-label": "비밀번호" });
    const remember = h("input", { type: "checkbox", checked: true });
    const err = h("div", { class: "error", role: "alert" }, msg || "");
    const form = h("form", {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "확인 중…";
        try {
          await unlock(input.value);
          if (remember.checked) store.set(PW_KEY, input.value); else store.del(PW_KEY);
          route();
        } catch (ex) {
          err.textContent = ex.name === "OperationError" ? "비밀번호가 맞지 않습니다." : ex.message;
        }
      },
    }, input, h("label", {}, remember, "이 기기에서 기억"), h("button", { class: "btn primary", type: "submit" }, "열기"), err);
    app.replaceChildren(h("div", { class: "login" },
      h("h1", {}, "Confluence Radar"), h("p", {}, "주봉·월봉 장기 차트 분석 — 이번 주 무엇을 할지 한 화면에"), form));
    input.focus();
  }

  // ── 공통 조각 ──
  function explain(...kids) {
    return h("details", { class: "explain" }, h("summary", {}, "설명 보기"), h("div", { class: "note" }, ...kids));
  }
  function fold(title, body, open) {
    if (!body || (Array.isArray(body) && !body.flat(3).filter(Boolean).length)) return "";
    return h("details", { class: "fold", open: open ? "" : null }, h("summary", {}, title), ...[body].flat());
  }
  function section(title, sub, ...body) {
    return h("section", { class: "sec" }, h("div", { class: "sech" }, h("h2", {}, title), sub ? h("span", { class: "secsub" }, sub) : ""), ...body);
  }
  const brk = (v) => String(v).replace(/~/g, "~\u200b");   // 가격 범위는 '~' 뒤에서만 줄을 바꾼다 (숫자 중간에서 끊기지 않게)
  const cell = (k, v, s, cls) => h("div", { class: cls || "" }, h("span", { class: "k" }, k), h("b", {}, v == null || v === "" ? "-" : brk(v)), s ? h("span", { class: "s" }, s) : "");
  function scoreBox() { return ""; }   // 계획 점수는 보여 주지 않는다 — 거의 모든 종목이 비슷한 숫자라 판단에 도움이 안 됨 (사용자 2026-11-20)
  const FAMILY = { fib: "피보나치", structure: "고저점", abcd: "AB=CD", ma: "이평·밴드", harmonic: "하모닉", wave: "파동" };
  const MK = { kr: "한국", us: "미국", index: "지수", fx: "환율" };

  // 답의 종류: 매수 주문(초록) · 사지 않음(회색) · 팔 자리(빨강) · 보유 유지(파랑) · 흐름(지수·환율)
  const KIND = { buy: ["buy", "매수 주문"], sell: ["sell", "팔 자리"], hold: ["hold", "보유 유지"], no: ["no", "사지 않음"], flow: ["flow", "흐름"], coin: ["no", "판단 안 함"] };
  const kindOf = (c) => KIND[(c || {}).kind] || KIND.no;
  function callChip(c) { return h("span", { class: "kchip " + kindOf(c)[0] }, c && c.kind === "flow" ? c.title : kindOf(c)[1]); }
  const KIND_ORDER = { sell: 0, buy: 1, hold: 2, flow: 3, no: 4, coin: 5 };

  // ── 매수 점수 (analysis/buyscore.py): 근거가 많이 겹칠수록 · 손익비가 좋을수록 · 손절이 짧을수록 · 사는 자리가 가까울수록 높다 ──
  const cands = () => ((index.discovery || {}).candidates || []).filter((x) => x.call && x.call.kind === "buy");
  const watchList = () => (index.groups.stocks || []).filter((x) => x.call);
  const holdList = () => (index.owner ? index.groups.holdings || [] : []).filter((x) => x.call);
  const scoreCls = (s) => (s >= 50 ? "hi" : s >= 35 ? "mid" : "lo");
  const pcs = (v) => (v == null ? "" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v) + "%");
  const buyWhere = (c) => (c.order === "다음 주 시가" ? "다음 주 시가" : c.dist <= 0 ? "지금 가격대" : `지금보다 −${c.dist}%`);
  function scoreBadge(c) {
    return h("div", { class: "sbadge2 " + scoreCls(c.score) }, h("b", {}, String(c.score)), h("span", {}, "점"));
  }
  // 후보 카드: 점수 · 매수 / 매도 / 손절 (모두 % 함께) · 근거
  const zoneWhere = (z) => (z.inside ? "지금 구간 안" : z.dist <= 0 ? "지금 가격 위" : `지금보다 −${z.dist}%`);
  function scoreCard(x) {
    const c = x.call;
    const z1 = (c.zones || [])[0], s1 = (c.sells || [])[0];
    return h("a", { class: "ocard s-" + scoreCls(c.score), href: "#/s/" + x.safe },
      h("div", { class: "ohead" }, scoreBadge(c),
        h("div", { class: "otitle" }, h("div", {}, h("span", { class: "oname" }, x.name), h("span", { class: "omk" }, " " + (MK[x.category] || ""))),
          h("div", { class: "oband" }, `${c.band} · ${c.method}`)),
        h("span", { class: "oprice" }, x.price)),
      h("div", { class: "ogrid" },
        cell(z1 ? z1.name : "매수", z1 ? z1.range : c.buy, z1 ? zoneWhere(z1) : buyWhere(c), "buy"),
        cell(s1 ? s1.name : "매도", s1 ? s1.range : c.sell, s1 ? `매수1 위끝에서 ${pcs(s1.pct)}` : "", "tgt"),
        cell("손절", z1 ? z1.stop : c.stop, `매수1 위끝에서 −${z1 ? z1.stop_pct : c.stop_pct}%`, "stop")),
      (c.zones || []).length > 1 ? h("div", { class: "ofoot" }, c.zones.slice(1).map((z) => `${z.name} ${z.range} (${zoneWhere(z)})`).join(" · ")
        + (c.zones.some((z) => z.after_stop) ? " · 다음 = 매수1 손절 뒤 자리" : "")) : "",
      h("div", { class: "ofoot" }, `겹친 근거 ${c.families.length}종류 ${c.n_levels}개 (${c.families.join("·")}) · 손익비 ${c.rr.toFixed(1)}`
        + (c.acc != null ? ` · 과거 성공률 ${pctR(c.acc)}` : "")));
  }
  // 종목 한 줄: 이름 · 점수(또는 상태) · 현재가 / 매수→매도·손절 (%) 또는 이유
  function stockRow(x) {
    const c = x.call;
    const chip = c.kind === "buy" ? h("span", { class: "kchip buy " + scoreCls(c.score) }, `${c.score}점`) : callChip(c);
    return h("a", { class: "srow k-" + kindOf(c)[0], href: "#/s/" + x.safe },
      h("div", { class: "sr1" }, h("span", { class: "sname" }, x.name), chip, h("span", { class: "sprice" }, x.price)),
      h("div", { class: "sr2" }, c.kind === "buy" && (c.zones || []).length
        ? `매수1 ${c.zones[0].range} (${zoneWhere(c.zones[0])}) → 매도1 ${(c.sells || [{}])[0].range || "-"} (${pcs((c.sells || [{}])[0].pct)}) · 손절 ${c.zones[0].stop} (−${c.zones[0].stop_pct}%)`
        : c.why));
  }
  // 지수·환율: 추세 · 아래 지지 · 위 저항 (매매 점수 없음)
  function flowCard(x) {
    const m = x.macro, c = x.call || {};
    const s = (m.supports || [])[0], r = (m.resists || [])[0];
    return h("a", { class: "fcard", href: "#/s/" + x.safe },
      h("div", { class: "sr1" }, h("span", { class: "sname" }, x.name), h("span", { class: "sprice" }, x.price)),
      h("div", { class: "ftrend " + (m.above ? "up" : "down") }, m.trend),
      h("div", { class: "fline" }, c.why || ""),
      h("div", { class: "fgrid" },
        cell("아래 지지", s ? s.range : "없음", s ? `지금보다 ${s.dist}%` : "", "sup"),
        cell("위 저항", r ? r.range : "없음", r ? `지금보다 +${r.dist}%` : "", "res")));
  }
  // 시장 추세: 한 단어 + 근거 한 줄 + 할 일 한 줄
  function trendBox(big) {
    const T = index.trend || [];
    const rows = big ? T : T.filter((t) => ["코스피", "S&P500"].includes(t.name));
    if (!rows.length) return "";
    return h("div", { class: "trend" }, ...rows.map((t) => h("a", { class: "tcard2 " + t.color, href: `#/s/${t.safe}` },
      h("div", { class: "trow2" }, h("span", { class: "tmk" }, t.market), h("span", { class: "tword " + t.color }, t.word)),
      h("div", { class: "tline" }, t.line), h("div", { class: "tact" }, "→ " + t.action))));
  }
  function howSteps() {
    return h("ol", { class: "steps" },
      h("li", {}, h("b", {}, "매수"), " 가격에 지정가 매수 주문을 걸어 둡니다. 가격이 내려와 닿을 때만 체결됩니다."),
      h("li", {}, "체결되면 바로 ", h("b", {}, "손절"), " 가격에 예약매도(스탑 주문)를 겁니다. 틀렸을 때 잃는 폭이 정해집니다."),
      h("li", {}, "같이 ", h("b", {}, "매도"), " 가격에 지정가 매도 주문을 걸어 둡니다. 손절과 매도 중 먼저 닿는 쪽에서 끝납니다."));
  }
  function auditText() {
    const a = index.audit;
    if (!a) return "";
    return (a.violations ? `자동 점검 위반 ${a.violations}건` : `자동 점검 ${a.checks}개 항목 통과`) + ` (${a.symbols}종목) · `;
  }
  const footer = () => h("div", { class: "foot" }, auditText(),
    `기준일 ${(index.discovery || {}).asof || index.generated} · 규칙 버전 ${index.rules_version || "-"} · 계산 결과에 기반한 참고 자료이며 매매 권유가 아닙니다. 판단과 책임은 본인에게 있습니다.`);
  const TOP_N = 5;
  function poolText() {
    const p = (index.discovery || {}).pool || {};
    return `한국 시가총액 ${p.kr || "-"}위 · 미국 거래대금 ${p.us || "-"}위 안 종목만`;
  }

  // ── 탭 1: 이번 주 ──
  function homeTab() {
    const C = cands();
    const top = C.slice(0, TOP_N);
    const W = watchList(), H = holdList();
    return [
      section("시장 추세", "", trendBox(false)),
      section("매수 점수 높은 종목", `상위 ${top.length}개 / 후보 ${C.length}개`,
        top.length ? h("div", { class: "grid" }, ...top.map(scoreCard)) : h("div", { class: "empty" }, "이번 주는 매수 자리가 있는 종목이 없습니다."),
        C.length > TOP_N ? h("button", { class: "more", onclick: () => goTab("stocks") }, `나머지 ${C.length - TOP_N}개 보기 →`) : "",
        h("div", { class: "lead", style: "margin-top:8px" }, "매수 점수가 높을수록 지금 사기 좋은 자리입니다 — 근거가 많이 겹치고, 손익비가 좋고, 손절이 짧고, 매수 가격이 지금 가격에 가까울수록 높습니다. ",
          h("a", { href: "#", onclick: (e) => { e.preventDefault(); goTab("help"); } }, "점수 계산법"))),
      H.length ? section("보유 종목", `${H.length}종목`, h("div", { class: "rows" }, ...H.sort((a, b) => KIND_ORDER[a.call.kind] - KIND_ORDER[b.call.kind]).map(stockRow))) : "",
      W.length ? section("관심 종목", `${W.length}종목`, h("div", { class: "rows" },
        ...W.slice().sort((a, b) => ((b.call.score ?? -1) - (a.call.score ?? -1))).map(stockRow))) : "",
      section("주문하는 법", "3단계", howSteps()),
      footer(),
    ];
  }

  // ── 탭 2: 종목 (매수 후보 전부 · 점수순, 검색) ──
  let stockFilter = "all", stockQuery = "";
  function stocksTab() {
    const C = cands();
    const known = new Set([...C, ...watchList()].map((x) => x.symbol));
    const FIL = [["all", "전체 후보", C], ["kr", "한국", C.filter((x) => x.category === "kr")], ["us", "미국", C.filter((x) => x.category === "us")],
      ["watch", "관심 종목", watchList()]];
    const list = h("div", { class: "rows" });
    const seg = h("div", { class: "seg" });
    const render = () => {
      const q = stockQuery.trim().toLowerCase();
      const hit = (x) => !q || x.name.toLowerCase().includes(q) || x.symbol.toLowerCase().includes(q);
      seg.replaceChildren(...FIL.map(([id, label, rows]) => h("button", { "aria-pressed": String(id === stockFilter),
        onclick: () => { stockFilter = id; render(); } }, label, h("span", { class: "c" }, String(rows.filter(hit).length)))));
      const rows = ((FIL.find((r) => r[0] === stockFilter) || FIL[0])[2]).filter(hit);
      const extra = q ? (index.catalog || []).filter((c) => !known.has(c.symbol) && hit(c)).slice(0, 20) : [];
      list.replaceChildren(...rows.map(stockRow),
        ...extra.map((c) => h("a", { class: "srow", href: `#/s/${c.safe}` }, h("div", { class: "sr1" }, h("span", { class: "sname" }, c.name),
          h("span", { class: "sprice" }, c.symbol)), h("div", { class: "sr2" }, "이번 주 후보 밖 종목 — 누르면 지금 기준 분석이 열립니다"))),
        !rows.length && !extra.length ? h("div", { class: "empty" }, q ? "찾는 종목이 없습니다. 최근 분석한 종목만 검색됩니다." : "해당하는 종목이 없습니다.") : "");
    };
    const input = h("input", { class: "search", type: "search", placeholder: "종목 이름이나 코드 (예: 삼성, 005930, NVDA)", value: stockQuery,
      oninput: (e) => { stockQuery = e.target.value; render(); } });
    render();
    return [
      h("div", { class: "lead" }, `이번 주 매수 자리가 있는 종목을 매수 점수 높은 순으로 보여 줍니다 (${poolText()}).`),
      h("div", { class: "toolrow" }, input, seg), list, footer(),
    ];
  }

  // ── 탭 3: 시장 ──
  function marketTab() {
    const d = index.discovery || {};
    const macro = (index.groups.macro || []).filter((x) => x.macro);
    return [
      section("시장 추세", "40주 평균선 기준", trendBox(true),
        explain("상승장 = 지수가 40주(약 10개월) 평균선 위이고 평균선도 오르는 중. 힘 빠지는 중 = 위지만 평균선이 꺾임. ",
          "조정 중 = 평균선 아래지만 평균선은 아직 오르고 10% 안쪽. 하락장 = 평균선 아래이고 평균선도 내리거나 10% 넘게 아래.")),
      macro.length ? section("지수·환율 흐름", "누르면 차트", h("div", { class: "grid" }, ...macro.map(flowCard)),
        explain("지지·저항 = 피보나치·이전 고점·저점·이동평균·AB=CD 같은 근거가 여러 개 겹친 가격대('이 근처'). 가까운 것 하나씩만 보여 주고, 누르면 더 있습니다.")) : "",
      section("더 보기", "",
        fold("지수 단계판 — 바닥에서 어디쯤 왔나", stagePanel(d)),
        fold("지수 추세판 (평균선 점수)", marketPanel(d)),
        fold("대표 종목판", majorsPanel(d)),
        fold("약세장에서 버티는 종목 (실험)", bearPanel(d)),
        fold("한국 주도주 (참고)", leaderPanel(d.leaders)),
        fold("미국 주도주 (참고)", usLeaderPanel(d.us_leaders)),
        fold("코인 (베타)", coinPanel())),
      footer(),
    ];
  }

  // ── 탭 4: 도움말 ──
  function helpTab() {
    const G = [
      ["매수1 · 매수2 · 매수3", "근거가 겹친 매수 구간을 지금 가격에서 가까운 순서로 번호를 붙인 것. 옆의 %는 지금 가격에서 그 구간 위끝까지 얼마나 아래인지. 구간이 아니라 한 가격이면 그 방법(예: 4파 되돌림 비율)이 한 점을 가리키는 경우."],
      ["매도1 · 매도2", "매수1 기준의 목표 구간(이익 실현). 옆의 %는 매수1 위끝에서 얼마나 위인지. '도달' = 지금 가격이 이미 그 위."],
      ["다음1 · 다음2", "매수1 의 손절보다 아래에 있는 구간. 매수1 이 손절된 뒤에 따로 다시 볼 자리이고 자기 손절이 따로 있습니다."],
      ["지남", "이미 지나간 구간 — 닿은 뒤 목표까지 갔거나 이미 반등해서 지금은 새로 살 자리가 아닌 곳. 차트와 표에 회색으로."],
      ["손절", "이 가격에 닿으면 자동으로 파는 예약매도(스탑 주문). 옆의 %는 매수 가격에서 얼마나 아래인지. 15%보다 먼 자리와 손익비가 1보다 작은 자리(버는 폭 < 잃는 폭)는 후보에서 뺍니다."],
      ["손익비", "(매도 − 매수) ÷ (매수 − 손절). 1이면 버는 폭과 잃는 폭이 같고, 2면 버는 폭이 두 배."],
      ["과거 성공률", "과거에 같은 방법으로 샀다면 손절보다 매도 가격에 먼저 닿은 비율. 방법 전체의 숫자라 점수에는 조금만 들어갑니다."],
      ["4파 눌림", "엘리엇 파동으로 '큰 상승(3파)이 끝나고 쉬어 가는 중(4파)'일 때, 오른 폭의 23.6%·38.2% 되돌림에서 사는 방법."],
      ["3파 진행", "가장 힘센 상승(3파)이 막 시작된 것으로 보일 때 다음 주 시가에 사는 방법."],
      ["하모닉", "가격 꼭짓점(X·A·B·C)의 비율로 반등 자리(D)를 찾는 패턴. PRZ 위끝에서 사고 TP1(AD의 38.2% 되돌림)에서 팝니다."],
      ["근거 겹친 가격대", "피보나치·이전 저점·이평·파동 끝 후보 같은 근거가 여러 개 겹친 가격대의 위끝에서 사는 방법."],
      ["신고가 추세 + 3파", "1년 신고가 근처에서 오르는 종목을 파동으로 3파 상승 중이라고 볼 때 사는 방법."],
      ["40주 평균선", "최근 40주(약 10개월) 종가 평균. 지수가 이 선 위면 상승 추세, 아래면 하락 추세로 봅니다."],
    ];
    return [
      section("매수 점수", "100점 만점", h("div", { class: "prose" },
        h("p", {}, "종목마다 매수 자리(4파 눌림 · 3파 진행 · 하모닉 · 근거 겹친 가격대 · 신고가 추세)를 모두 찾고, 그중 점수가 가장 높은 자리를 보여 줍니다."),
        h("p", {}, h("b", {}, "근거 점수"), " = 근거 겹침 50 + 손익비 20 + 손절 폭 15 + 과거 성공률 15"),
        h("ul", {},
          h("li", {}, "근거 겹침: 매수 가격 ±2% 안에 서로 다른 근거(엘리엇 파동·하모닉·피보나치·이전 고점·저점·이평·볼린저·AB=CD·상승 다이버전스)가 몇 종류, 몇 개 있는지."),
          h("li", {}, "손익비: 3 이상이면 만점. 손절 폭: 8% 이하 만점, 12% 이하, 15% 이하 순."),
          h("li", {}, "과거 성공률: 45% 이하 0점, 75% 이상 만점.")),
        h("p", {}, h("b", {}, "매수 점수"), " = 근거 점수 × 거리 계수. 매수 가격이 지금 가격대 안이면 ×1.0, 5% 아래 ×0.8, 10% 아래 ×0.55, 15% 아래 ×0.35, 20% 넘게 아래 ×0.2 — 멀면 근거가 좋아도 점수가 낮습니다."),
        h("p", {}, "50점 이상 '지금 매수', 35점 이상 '가격 오면 매수', 20점 이상 '지켜보기', 그 아래 '약함'."))),
      section("주문하는 법", "3단계", howSteps(),
        h("div", { class: "note", style: "margin-top:10px" }, "예) 매수 10,000 · 매도 11,200 (+12%) · 손절 8,800 (−12%) → 10,000원에 지정가 매수. 체결되면 8,800원 예약매도와 11,200원 지정가 매도를 함께 걸어 둡니다.")),
      section("용어", "", h("dl", { class: "gl" }, ...G.map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v))))),
      section("기록", "", fold("지난 주 기록·보낸 신호", archivePanel())),
      h("div", { class: "foot" }, auditText(), `규칙 버전 ${index.rules_version || "-"} · 계산 결과에 기반한 참고 자료이며 매매 권유가 아닙니다. `,
        h("a", { href: "#", onclick: (e) => { e.preventDefault(); store.del(PW_KEY); key = null; index = null; renderLogin(); } }, "로그아웃")),
    ];
  }

  // ── 목록 화면 (아래 탭) ──
  const TABS = [["home", "이번 주"], ["stocks", "종목"], ["market", "시장"], ["help", "도움말"]];
  function goTab(id) { store.set(TAB_KEY, id); renderHome(); window.scrollTo(0, 0); }
  function renderHome() {
    const saved = store.get(TAB_KEY);
    const tab = TABS.some(([id]) => id === saved) ? saved : "home";
    const nBuy = cands().filter((x) => x.call.score >= 50).length;   // '지금 매수' 점수대 종목 수
    const body = tab === "stocks" ? stocksTab() : tab === "market" ? marketTab() : tab === "help" ? helpTab() : homeTab();
    app.replaceChildren(
      h("div", { class: "top" }, h("h1", {}, (TABS.find((r) => r[0] === tab) || TABS[0])[1]),
        h("span", { class: "muted" }, ((index.discovery || {}).asof || index.generated) + " 기준")),
      ...[body].flat(),
      h("nav", { class: "nav", "aria-label": "화면" }, h("div", { class: "in", role: "tablist" }, ...TABS.map(([id, label]) =>
        h("button", { role: "tab", "aria-selected": String(id === tab), onclick: () => goTab(id) }, label,
          id === "home" && nBuy ? h("span", { class: "ncount" }, String(nBuy)) : "")))));
  }

  // ── 차트 표시 항목 (기기에 기억) — 처음 보는 사람에게는 파동·주문 선·하모닉만 ──
  const LAYERS = [["zone", "주문 선·가격대"], ["wave", "엘리엇 파동"], ["harm", "하모닉"], ["fib", "피보나치"], ["div", "다이버전스"], ["pivot", "고저점"]];
  const LAYER_OFF = new Set(["fib", "div", "pivot"]);
  function layers() {
    let v = {};
    try { v = JSON.parse(localStorage.getItem("radar.layers2") || "{}"); } catch (e) { v = {}; }
    const out = Object.fromEntries(LAYERS.map(([k]) => [k, k in v ? v[k] !== false : !LAYER_OFF.has(k)]));
    out.harmOff = new Set(v.harmOff || []);
    return out;
  }
  function saveLayers(v) {
    try { localStorage.setItem("radar.layers2", JSON.stringify({ ...v, harmOff: [...v.harmOff] })); } catch (e) { /* 이번 화면만 */ }
  }
  const harmKey = (hm) => hm.name + (hm.bullish ? "(강세)" : "(약세)");
  function availLayers(d, tf) {
    const lc = (d.long_term && d.long_term.chart) || {};
    const lt = d.long_term || {};
    const mHarm = (lc.harmonics || []).filter((x) => x.near);
    if (tf === "MID") return { wave: (lc.sub || []).length > 1, harm: mHarm.length > 0, zone: (lt.supports || []).length > 0 };
    if (tf === "L") return { wave: (lc.waves || []).length > 1 || (lc.sub || []).length > 1, harm: (lc.harmonics || []).length > 0,
      zone: (lt.supports || []).length + (lt.resist || []).length > 0 };
    return {
      wave: (d.waves || []).length > 1 || (d.proj || []).length > 1,
      harm: (d.harmonics || []).length > 0 || (tf === "M" && mHarm.length > 0),
      zone: (d.entries || []).length + (d.targets || []).length > 0 || !!d.stop || !!d.macro || (d.wave_rules || []).length > 0,
      fib: (d.fibs || []).length > 0,
      div: (d.divs || []).some((x) => x.tf === tf),
      pivot: (d.pivots || []).some((p) => p.tf === tf),
    };
  }
  function layerChips(onChange, harms, avail) {
    const cur = layers();
    const names = [...new Set((harms || []).map(harmKey))];
    return h("div", { class: "layerchips" }, h("span", { class: "muted" }, "차트에 보기:"),
      ...LAYERS.filter(([k]) => !avail || avail[k]).map(([k, name]) => h("button", { class: "lchip" + (cur[k] ? " on" : ""), onclick: () => {
        const v = layers(); v[k] = !v[k]; saveLayers(v); onChange();
      } }, (cur[k] ? "✔ " : "") + name)),
      ...(cur.harm && names.length > 1 ? [h("span", { class: "muted" }, " · 하모닉:"),
        ...names.map((nm) => h("button", { class: "lchip" + (cur.harmOff.has(nm) ? "" : " on"), onclick: () => {
          const v = layers(); v.harmOff.has(nm) ? v.harmOff.delete(nm) : v.harmOff.add(nm); saveLayers(v); onChange();
        } }, (cur.harmOff.has(nm) ? "" : "✔ ") + nm))] : []));
  }

  // ════ 아래: '더 보기'의 시장 판들 · 계획 원본 상자 · 차트 그리기 (이전 화면에서 그대로 옮김) ════
  // ── 시장 신호등·지수 추세판 (평균선·폭으로 판정, 파동·하모닉은 해석용) ──
  const DOT = { green: "🟢", yellow: "🟡", red: "🔴", unknown: "⚪" };
  const LIGHT = {
    kr: { green: "강세 구간 — 코스피가 40주 평균선 위, 오르는 종목도 충분함",
          yellow: "강세 구간이지만 폭 경고 — 지수는 버티지만 오르는 종목이 줄고 있음",
          red: "약세 구간 — 매수 알림은 그대로 나가되 손절을 꼭 지키고 비중을 작게", unknown: "판단 보류" },
    us: { green: "S&P 500 이 40주 평균선 ±3% 기준 위",
          red: "낙폭 위험 구간 (매도 신호 아님 — 2010년 이후에는 이탈 뒤 평균적으로 올랐음)", unknown: "판단 보류" },
  };
  const md = (d) => (d ? `${+d.slice(5, 7)}/${+d.slice(8, 10)}` : "?");
  const n0 = (v) => Math.round(v).toLocaleString("ko-KR");
  const sgn = (v) => (v >= 0 ? "+" : "") + v.toFixed(1) + "%";
  function marketPanel(d) {
    const L = d.regime || {}, B = d.board || [];
    if (!Object.keys(L).length && !B.length) return "";
    const lightRow = (m, name) => {
      const x = L[m];
      if (!x) return "";
      const b = x.breadth;
      return h("div", { class: "light " + (x.color || "unknown") },
        h("span", { class: "ldot" }, DOT[x.color] || "⚪"),
        h("div", {}, h("b", {}, `${name} 시장: `), (LIGHT[m] || {})[x.color] || "",
          h("div", { class: "muted" }, `${md(x.color_since)}부터`,
            b ? ` · 폭 ${Math.round(b.ratio * 100)}% (${b.above}/${b.n}종목이 40주선 위) · 최근 8주 ${b.recent.map((r) => Math.round(r * 100)).join("→")}%` : "")));
    };
    const row = (r) => h("a", { class: "brow", href: `#/s/${r.safe}` },
      h("div", { class: "bhead" }, h("b", {}, r.name), h("span", { class: "muted" }, " " + n0(r.close)),
        h("span", { class: "chip " + (r.on ? "ok" : "no") }, `${r.rule} ${r.on ? "위" : "아래"} ${r.weeks}주째`),
        r.low_confidence ? h("span", { class: "chip no" }, "신뢰 낮음") : ""),
      h("div", { class: "bline" }, `${md(r.since)} ${r.on ? "진입" : "이탈"}(${n0(r.since_value)}) · 추세 점수 `,
        h("b", {}, `${r.score}/6`), ` · 52주 고점 대비 ${sgn(r.from_high52)} · 26주 ${sgn(r.r26)} · 52주 ${sgn(r.r52)}`),
      h("div", { class: "bline muted" }, `평균선과의 거리 10주 ${sgn(r.dist[10])} · 20주 ${sgn(r.dist[20])} · 40주 ${sgn(r.dist[40])} · 50주 ${sgn(r.dist[50])}`),
      h("div", { class: "bline" }, ...r.score_items.map(([n, on]) => h("span", { class: "chip " + (on ? "ok" : "no") }, (on ? "✔ " : "✘ ") + n))),
      r.aux.length ? h("div", { class: "bline muted" }, "보조: " + r.aux.map(([n, x]) => `${n} ${x.on ? "켜짐" : "꺼짐"}(${md(x.since)})`).join(" · ")) : "",
      h("div", { class: "bline" }, "파동(해석용): " + r.wave + (r.watch ? ` / 주목 가격대 ${n0(r.watch[0])}~${n0(r.watch[1])}` : "")),
      h("div", { class: "bline muted" }, "⚠ " + r.caution + ". " + r.lag));
    return h("section", { class: "market" },
      lightRow("kr", "한국"), lightRow("us", "미국"),
      B.length ? [h("h3", {}, "지수 추세판 (평균선 기준)"),
        explain("강세·약세 판정은 평균선·폭으로만 합니다. 파동·하모닉은 '어디쯤인지, 어느 가격대를 볼지'를 보여 주는 해석 도구이며 신호등 색을 바꾸지 않습니다. ",
          "지수 4개는 표본이 너무 적어 파동의 과거 적중률을 검증하지 못했습니다. 지수를 누르면 파동·하모닉 차트가 열립니다."),
        h("div", { class: "board" }, ...B.map(row))] : "");
  }

  // ── 지수 단계판 · 대표 종목판 · 약세장에서 버티는 종목 (표시만 — 알림 없음) ──
  const STAGES = ["하락 진행", "바닥 후보", "첫 상승 확인", "눌림 매수 구간", "상승 확정", "과열·목표", "이탈"];
  const pctS = (v) => (v == null ? "-" : (v >= 0 ? "+" : "") + v + "%");
  function stageStrip(cur) {
    return h("div", { class: "sstrip" }, ...STAGES.map((nm, k) =>
      h("span", { class: "sstep" + (k === cur ? " cur s" + k : "") }, `${k} ${nm}`)));
  }
  function planLine(p) {
    if (!p) return "";
    if (!p.zone) return h("div", { class: "bline muted" }, `계획: ${p.story}` + (p.label ? ` · ${p.label}` : ""));
    return h("div", { class: "bline" }, `계획: ${p.story} · 관심 가격대 `, h("b", {}, p.zone), p.dist != null && p.dist < 0 ? ` (${p.dist}%)` : "",
      p.stop ? ` · 손절 ${p.stop}` : "", p.target ? ` · 목표 ${p.target}` : "", p.rr != null ? ` · 손익비 ${p.rr.toFixed(1)}` : "",
      p.label ? h("span", { class: "tag" }, p.label) : "");
  }
  function stagePanel(d) {
    const rows = d.stages || [];
    if (!rows.length) return "";
    const statLine = (s) => {
      const a = s.stage2, b = s.stage3, l = s.light;
      if (!a || !a.n) return "";
      return h("div", { class: "bline muted" },
        `과거(2000년~) 2단계 ${a.n}번: 52주 뒤 평균 ${pctS(a.r52)}·오른 비율 ${a.win52}%·헛신호 ${a.false}번·신호등보다 평균 ${a.lead_weeks ?? "-"}주 먼저`,
        b && b.n ? ` / 3단계 ${b.n}번: 52주 뒤 평균 ${pctS(b.r52)}·헛신호 ${b.false}번` : "",
        l && l.n ? ` / 신호등 켜짐 ${l.n}번: 52주 뒤 평균 ${pctS(l.r52)}` : "");
    };
    const t = (d.stage_note || {}).total || {};
    return h("section", { class: "market" },
      explain("신호등(40주선)은 확실하지만 늦습니다. 단계판은 그 앞 단계를 주봉 차트에서 찾습니다: ",
        h("b", {}, "2단계"), "(하락 구조가 깨짐) → ", h("b", {}, "3단계"), "(첫 눌림 = 불장 초입의 매수 자리) → 4단계(신호등 켜짐). ",
        t.stage2 && t.stage2.n ? `과거 4개 지수 합계: 2단계 ${t.stage2.n}번 중 ${t.stage2.false}번, 3단계 ${t.stage3.n}번 중 ${t.stage3.false}번은 저점이 다시 깨진 헛신호였습니다. ` : "",
        h("b", {}, "헛신호가 많아 알림은 보내지 않고 화면에만 표시합니다."), " 3단계에서 산다면 손절(직전 저점, 주봉 종가)을 꼭 지키세요."),
      h("div", { class: "board" }, ...rows.map((r) => h("a", { class: "brow", href: `#/s/${r.safe}` },
        h("div", { class: "bhead" }, h("b", {}, r.name), h("span", { class: "muted" }, " " + r.close),
          h("span", { class: "chip sbadge s" + r.stage }, `${r.stage}단계 · ${r.stage_name}`),
          h("span", { class: "muted" }, `${md(r.since)}부터 ${r.weeks}주째`),
          r.switched ? h("span", { class: "chip ok" }, "이번 주 바뀜") : "",
          r.low_confidence ? h("span", { class: "chip no" }, "신뢰 낮음") : ""),
        stageStrip(r.stage),
        h("div", { class: "bline" }, r.hint + (r.desc ? " · " + r.desc : "")),
        ...(r.extra || []).map((x) => h("div", { class: "bline" }, "＋ " + x)),
        planLine(r.plan), statLine(r.stats || {})))));
  }
  function majorsPanel(d) {
    const m = d.majors;
    if (!m || !(m.rows || []).length) return "";
    const G = { kr: "한국 시가총액 상위 30", us: "미국 대표 20", watch: "관심 종목" };
    const share = (g) => (m.share && m.share[g] ? ` — 2단계 이상 ${m.share[g].up}/${m.share[g].n} (${m.share[g].pct}%)` : "");
    const table = (rows) => h("div", { class: "tablewrap" }, h("table", { class: "leaders majors" },
      h("thead", {}, h("tr", {}, ...["종목", "단계", "이야기", "관심 가격대", "손절", "목표", "판정", "이탈선(40주선)"].map((x) => h("th", {}, x)))),
      h("tbody", {}, ...rows.map((r) => h("tr", {},
        h("td", {}, h("a", { href: `#/s/${r.safe}` }, r.name), h("div", { class: "muted" }, r.price)),
        h("td", {}, r.stage == null ? "-" : h("span", { class: "chip sbadge s" + r.stage }, `${r.stage} ${r.stage_name}`)),
        h("td", {}, r.story + (r.grade ? ` (${r.grade})` : "")),
        h("td", {}, r.zone ? [r.zone, r.dist != null && r.dist < 0 ? h("div", { class: "muted" }, `${r.dist}%`) : ""] : "-"),
        h("td", { class: "stopc" }, r.stop || "-"), h("td", {}, r.target || "-"), h("td", {}, r.label || "-"),
        h("td", {}, r.exit_line ? [r.exit_line, h("div", { class: "muted" }, r.above_exit ? "위" : "아래")] : "-"))))));
    return h("section", { class: "market" },
      explain("큰 종목들이 몇 단계에 있는지와 각자의 계획(관심 가격대·손절·목표)을 한 줄씩 보여 줍니다. ",
        h("b", {}, "2단계 이상인 종목이 늘어나면"), " 시장이 바닥을 벗어나는 중이라는 뜻입니다. 매도 기준은 목표 가격과 이탈선(주봉 종가가 40주선 아래) 두 가지입니다. ", m.note),
      ...["kr", "us", "watch"].map((g) => {
        const rows = m.rows.filter((r) => r.group === g);
        return rows.length ? h("details", { class: "refbox" }, h("summary", {}, `${G[g]} (${rows.length})${share(g)}`), table(rows)) : "";
      }));
  }
  function bearPanel(d) {
    const b = d.bear;
    if (!b || !Object.keys(b.markets || {}).length) return "";
    const sc = b.scorecard || { n: 0, horizons: {} };
    const scText = Object.keys(sc.horizons || {}).length
      ? Object.entries(sc.horizons).map(([hz, x]) => `${hz}주 뒤 지수 대비 ${pctS(x.avg_vs_index)} (${x.n}건, 지수를 이긴 비율 ${x.beat}%)`).join(" · ")
      : `성적표는 쌓이는 중입니다 (기록 ${sc.n}건 — 4주가 지나야 첫 성적이 나옵니다).`;
    return h("section", { class: "market" },
      h("div", { class: "light red" }, h("span", { class: "ldot" }, "🔴"), h("div", {}, h("b", {}, b.word), " — 시장이 약세일 때 '차트가 좋아 버티는 종목'을 찾는 실험 목록입니다. 과거 검증이 아직 없으니 참고만 하세요.")),
      explain("조건(모두 충족): ① 파동 이야기 신뢰 등급 B 이상 + 목표1 손익비 1 이상인 계획 ② 자기 조정이 끝남(구간 안 반등 확인 또는 종목 2~3단계) ",
        "③ 지수보다 강함 ④ 경고 2개 이상·변동성 큰 소형주·52주 최고가 근처는 제외. 최대 ", String(b.max), "개. 조건에 못 미치면 기준을 낮추지 않고 비워 둡니다. ", scText),
      ...Object.entries(b.markets).map(([mk, x]) => {
        const dr = x.dropped || {};
        return [h("h3", {}, (mk === "kr" ? "한국" : "미국") + ` (${x.rows.length})`),
          x.rows.length ? h("div", { class: "list" }, ...x.rows.map((r, k) => h("a", { class: "tcard wait", href: `#/s/${r.safe}` },
            h("div", { class: "trow" }, h("span", { class: "rank" }, (k + 1) + "."), h("span", { class: "tname" }, r.name),
              r.label ? h("span", { class: "tag" }, r.label) : "", h("span", { class: "tprice" }, r.price)),
            h("div", { class: "tgrid" },
              h("div", {}, h("span", {}, "관심 가격대"), h("b", {}, r.zone || "-")),
              h("div", {}, h("span", {}, "손절 (주봉 종가)"), h("b", { class: "stopc" }, r.stop || "-")),
              h("div", {}, h("span", {}, "목표1"), h("b", {}, r.target || "-")),
              h("div", {}, h("span", {}, "손익비 · 점수"), h("b", {}, (r.rr != null ? r.rr.toFixed(1) : "-") + (r.score != null ? ` · ${Math.round(r.score)}점` : "")))),
            h("div", { class: "twhy" }, `${r.story}` + (r.stage_name ? ` · 종목 단계: ${r.stage} ${r.stage_name}` : "") + " · 지수보다 강한 점: " + r.strong.join(", ")),
            ...(r.warns || []).map((w) => h("div", { class: "twhy warnline" }, "⚠ " + w)))))
            : h("div", { class: "empty" }, `지금은 조건을 모두 갖춘 종목이 없습니다 (후보 ${x.pool}종목 — 계획 품질 미달 ${dr["이야기·계획"] || 0}, 조정이 안 끝남 ${dr["조정이 안 끝남"] || 0}, 지수보다 약함 ${dr["지수보다 약함"] || 0}, 피해야 할 조건 ${dr["피해야 할 조건"] || 0}). 기다리는 것도 전략입니다.`)];
      }).flat());
  }

  const LEAD_EXPLAIN = () => [
    h("b", {}, "주도주 기준: "), "① 52주 최고가의 90% 이상 ② 주봉 종가가 40주 평균선 위 ③ 40주 평균선이 13주 전보다 높음 (한국은 시총 1~350위).",
    h("br"), h("b", {}, "왜 이미 오른 종목이 많나요? "),
    "이 방식은 '떨어진 종목을 싸게'가 아니라 '오르는 종목을 따라가는' 방식이라, 최고가 근처 종목이 뽑히는 게 정상입니다. ",
    "과거 한국 검증에서 효과가 확인된 유일한 방식이었고, 대신 주봉 종가가 이탈선(20주선) 아래로 마감하면 바로 뺍니다. ",
    "이탈선이 현재가에서 멀수록(예: −25% 넘게) 빠질 때 손실이 커지니, 그런 종목은 작게 보거나 10주선 근처까지 기다리는 게 안전합니다.",
  ];
  function leaderPanel(ld) {
    if (!ld) return "";
    const won = (v) => (v == null ? "-" : Math.round(v).toLocaleString("ko-KR"));
    const pct = (v) => (v == null ? "-" : (v >= 0 ? "+" : "") + v.toFixed(1) + "%");
    const rows = ld.on ? ld.held : ld.resting;
    // 카드로 (휴대폰에서도 이탈선까지 거리가 바로 보이게)
    const table = rows.length ? h("div", { class: "list" }, ...rows.map((r, k) => {
      const gap = r.exit_line && r.price ? r.exit_line / r.price - 1 : null;
      const far = gap != null && gap < -0.25;
      return h("a", { class: "tcard " + (ld.on ? "buy" : "wait"), href: `#/s/${r.safe}` },
        h("div", { class: "trow" }, h("span", { class: "rank" }, (k + 1) + "."), h("span", { class: "tname" }, r.name),
          r.rank && r.rank <= 100 ? h("span", { class: "tag" }, "시총 1~100위") : "", h("span", { class: "tprice" }, won(r.price) + " 원")),
        h("div", { class: "tgrid" },
          h("div", {}, h("span", {}, ld.on ? "사는 가격" : "신호등 켜지면"), h("b", {}, ld.on && r.weeks != null && r.weeks > 1 ? `편입 ${r.weeks}주째 · ${pct(r.ret_pct)}` : "다음 주 시가")),
          h("div", {}, h("span", {}, `팔 기준 (이탈선 ${ld.exit_weeks || 20}주선)`), h("b", { class: "stopc" }, won(r.exit_line) + " 원")),
          h("div", {}, h("span", {}, "이탈선까지"), h("b", { class: far ? "warnline" : "" }, gap != null ? pct(gap * 100) + (far ? " · 멀어 위험 큼" : "") : "-")),
          h("div", {}, h("span", {}, "놓쳤을 때 대안"), h("b", {}, r.ma10 ? `10주선 ${won(r.ma10)} 원` : "-"))),
        h("div", { class: "twhy" }, `52주 최고가의 ${Math.round((r.prox52 || 0) * 100)}% · 40주선보다 ${pct(r.ma40_gap_pct)} 위`));
    }))
      : h("div", { class: "empty" }, ld.on ? "지금 조건을 만족하는 주도주가 없습니다." : "조건을 만족하는 종목이 없습니다.");
    return h("section", { class: "leadersec" },
      h("h2", { class: "big" }, "최고가 근처에서 오르는 종목 (참고)",
        h("span", { class: "muted", style: "font-size:13px" }, ` ${md(ld.asof)} 주봉 기준`)),

      ld.color === "yellow" ? h("div", { class: "light yellow" }, h("span", { class: "ldot" }, "🟡"), h("div", {}, "폭 경고 중 — 새로 편입된 종목도 조심해서 보세요.")) : "",
      h("div", { class: "note" }, h("b", {}, "정렬: 40주선 기울기 큰 순"), " — 일부만 고른다면 위에서부터 최대 20개. ",
        "이탈선까지 −25%보다 멀면 빠질 때 손실이 커서 '멀어 위험 큼'으로 표시합니다."),
      h("details", { class: "refbox" }, h("summary", {}, "주도주 기준과 주의점 자세히"), h("div", { class: "note" }, ...LEAD_EXPLAIN(), h("br"),
        h("b", {}, "정렬: 40주선 기울기 큰 순. "), "일부만 고른다면 위에서부터 최대 20개(과거: 20개 연 +12.9%·낙폭 −28%, 전부 고르게 +11.3%·−26%). 10개 이하로 줄이면 효과가 크게 줄었습니다.", h("br"),
        h("b", {}, "매수: 편입된 주의 다음 주 시가 기준"), "(과거 기대값이 가장 컸음). 놓쳤다면 10주선 부근이 대안. ",
        h("b", {}, `매도: 주봉 종가가 이탈선(${ld.exit_weeks || 20}주선) 아래로 마감하거나 시장이 쉬는 구간으로 바뀌면.`),
        ld.sideways ? [h("br"), "※ " + ld.notes.sideways] : "", h("br"), "※ " + ld.notes.top100,
        (ld.new || []).length ? [h("br"), h("b", {}, "이번 주 새로 편입: "), ld.new.map((r) => r.name).join(", ")] : "",
        (ld.exited || []).length ? [h("br"), h("b", {}, "이번 주 이탈: "), ld.exited.map((r) => `${r.name}(${r.reason})`).join(", ")] : "")),
      table,
      h("details", {}, h("summary", {}, "과거 성과와 한계 (꼭 읽어 주세요)"), h("div", { class: "note" }, ld.notes.perf)));
  }

  function usLeaderPanel(rows) {
    const usd = (v) => (v == null ? "-" : "$" + (+v).toLocaleString("en-US", { maximumFractionDigits: 2 }));
    const pct = (v) => (v == null ? "-" : (v >= 0 ? "+" : "") + v.toFixed(1) + "%");
    rows = rows || [];
    return h("section", { class: "leadersec" },
      h("h2", {}, `미국 주도주 조건 충족 (${rows.length}) — 참고`),
      h("div", { class: "light yellow" }, h("span", { class: "ldot" }, "ℹ"),
        h("div", {}, "미국 대형주는 과거 검증에서 주도주 방식의 효과가 확인되지 않았습니다(강세장에서도 나머지 종목과 차이 없음). ",
          "그래서 알림 없이 같은 기준의 목록만 보여 드립니다. 미국도 한국과 같은 '매수 후보 조건'(지수 40주선 아래 + 하모닉 자리·상승 다이버전스)으로 판단합니다.")),
      h("div", { class: "note" }, ...LEAD_EXPLAIN()),
      rows.length ? h("div", { class: "tablewrap" }, h("table", { class: "leaders" },
        h("thead", {}, h("tr", {}, ...["종목", "현재가", "52주 고가 대비", "40주선 대비", "이탈선(20주선)", "이탈선까지"].map((t) => h("th", {}, t)))),
        h("tbody", {}, ...rows.map((r) => h("tr", {},
          h("td", {}, h("a", { href: `#/s/${r.safe}` }, r.name)), h("td", {}, usd(r.close)),
          h("td", {}, Math.round((r.prox52 || 0) * 100) + "%"), h("td", {}, pct(r.ma40_gap_pct)), h("td", {}, h("b", {}, usd(r.exit_line))),
          h("td", {}, r.exit_line && r.close ? pct((r.exit_line / r.close - 1) * 100) : "-")))))) : h("div", { class: "empty" }, "조건을 만족하는 종목이 없습니다."));
  }

  // ── 지난 기록·검색: 몇 주 전에 본 종목도 지금 기준(현재가·손절·목표·추세 이탈선)으로 다시 열어 볼 수 있게 ──
  let searchText = "";
  function archivePanel() {
    const ar = index.archive || { weeks: [], signals: [] };
    const cat = index.catalog || [];
    const num = (v) => (v == null ? "-" : v >= 1000 ? Math.round(v).toLocaleString("ko-KR") : (+v).toLocaleString("ko-KR", { maximumFractionDigits: 2 }));
    const link = (x, text) => (x.safe ? h("a", { href: `#/s/${x.safe}` }, text) : h("span", {}, text));
    const results = h("div", { class: "list" });
    const runSearch = () => {
      const q = searchText.trim().toLowerCase();
      const hits = q ? cat.filter((x) => x.name.toLowerCase().includes(q) || x.symbol.toLowerCase().includes(q)).slice(0, 30) : [];
      results.replaceChildren(...(q && !hits.length ? [h("div", { class: "empty" }, "찾는 종목이 없습니다. 최근 분석한 종목만 검색됩니다.")] :
        hits.map((x) => h("a", { class: "card", href: `#/s/${x.safe}` },
          h("div", { class: "row" }, h("span", { class: "name" }, x.name), h("span", { class: "code" }, x.symbol))))));
    };
    const input = h("input", { class: "search", type: "search", placeholder: "종목 이름이나 코드 (예: 삼성, 005930, NVDA)",
      value: searchText, oninput: (e) => { searchText = e.target.value; runSearch(); } });
    runSearch();
    const week = (wk, i) => h("details", { open: i === 0 },
      h("summary", {}, `${wk.asof} 주`, h("span", { class: "muted" }, ` · 관심 가격대 ${wk.picks.length} · 주도주 편입 ${wk.leaders_new.length} · 이탈 ${wk.leaders_out.length}`)),
      wk.leaders_new.length ? h("div", { class: "line" }, h("b", {}, "👑 주도주 편입: "), ...wk.leaders_new.flatMap((x, k) => [k ? ", " : "", link(x, x.name)])) : "",
      wk.leaders_out.length ? h("div", { class: "line" }, h("b", {}, "주도주 이탈: "), ...wk.leaders_out.flatMap((x, k) => [k ? ", " : "", link(x, `${x.name}(${x.reason})`)])) : "",
      wk.picks.length ? h("div", { class: "tablewrap" }, h("table", { class: "leaders" },
        h("thead", {}, h("tr", {}, ...["종목", "그때 가격", "관심 가격대", "손절", "목표"].map((t) => h("th", {}, t)))),
        h("tbody", {}, ...wk.picks.map((x) => h("tr", {},
          h("td", {}, link(x, x.name), x.leader ? " 👑" : ""), h("td", {}, num(x.price)),
          h("td", {}, `${x.label} ${num(x.lo)}~${num(x.hi)}`), h("td", {}, num(x.stop)), h("td", {}, num(x.target))))))) : "");
    return [
      h("div", { class: "note" }, "예전에 본 종목을 다시 볼 때: 이름을 누르면 ", h("b", {}, "지금 기준"),
        "의 차트·손절·목표가 열립니다. 실제로 산 종목은 config/watchlist.yaml 의 holdings 에 적어 두면 매도 기준(고정 손절·추세 이탈선)을 계속 알려 드립니다."),
      input, results,
      h("h2", { style: "font-size:16px;margin:18px 0 6px" }, "주별 기록"),
      ar.weeks.length ? h("div", { class: "archive" }, ...ar.weeks.map(week)) : h("div", { class: "empty" }, "아직 기록이 없습니다."),
      ar.signals.length ? [h("h2", { style: "font-size:16px;margin:18px 0 6px" }, "보낸 신호 (최근 6개월)"),
        h("div", { class: "tablewrap" }, h("table", { class: "leaders" },
          h("thead", {}, h("tr", {}, ...["날짜", "종목", "신호", "그때 가격"].map((t) => h("th", {}, t)))),
          h("tbody", {}, ...ar.signals.map((x) => h("tr", {}, h("td", {}, x.asof), h("td", {}, link(x, x.name)),
            h("td", {}, x.label), h("td", {}, num(x.price)))))))] : "",
    ];
  }

  function coinPanel() {
    const c = index.coins;
    if (!c) return h("div", { class: "empty" }, "코인 데이터가 아직 없습니다 (주간 실행 때 만들어집니다).");
    const b = c.btc;
    const pct = (v) => (v == null ? "-" : (v >= 0 ? "+" : "") + v.toFixed(1) + "%");
    const val = c.validation || {};
    const leaders = c.rows.filter((r) => r.leader);
    const near = c.rows.filter((r) => r.dist != null && r.dist <= 20).sort((x, y) => x.dist - y.dist);
    const row = (r) => h("tr", {},
      h("td", {}, h("a", { href: `#/s/${r.safe}` }, r.name), h("span", { class: "muted" }, " " + r.code), r.leader ? " 👑" : ""),
      h("td", {}, r.price), h("td", {}, r.zone ? `${r.zone} (${r.dist}% 아래)` : "-"), h("td", {}, r.stop || "-"),
      h("td", {}, r.target || "-"), h("td", {}, r.rr != null ? r.rr.toFixed(1) : "-"),
      h("td", { class: "muted" }, (r.verdict && r.verdict.label) || ""), h("td", { class: "muted" }, (r.warnings || []).join(", ")));
    const table = (rows) => h("div", { class: "tablewrap" }, h("table", { class: "leaders" },
      h("thead", {}, h("tr", {}, ...["코인", "현재가", "관심 가격대", "손절(주봉 종가)", "1차 목표", "손익비", "판정", "경고"].map((t) => h("th", {}, t)))),
      h("tbody", {}, ...rows.map(row))));
    return [
      h("div", { class: "light yellow" }, h("span", { class: "ldot" }, "β"),
        h("div", {}, h("b", {}, "베타 버전 — "), "주식용 분석을 업비트 원화 마켓 코인에 그대로 적용한 결과입니다. ",
          "업비트 공개 시세 조회만 사용하며(주문 기능 없음), 텔레그램 알림은 보내지 않습니다. ",
          "상장폐지된 코인 자료가 없어 과거 검증 결과는 실제보다 좋게 나왔을 수 있습니다.")),
      val.lines ? h("details", { open: true }, h("summary", {}, "과거 검증 요약 (" + (val.period || "") + ")"),
        h("ul", {}, ...val.lines.map((t) => h("li", {}, t)))) : "",
      b ? h("div", { class: "light " + (b.on20 ? "green" : "red") }, h("span", { class: "ldot" }, b.on20 ? "🟢" : "🔴"),
        h("div", {}, h("b", {}, "비트코인 추세 (과거 검증에서 가장 쓸 만했던 기준): "),
          `20주선 ${b.on20 ? "위" : "아래"} ${b.weeks20}주째(${b.since20}부터) · 40주선 ${b.on ? "위" : "아래"} ${b.weeks}주째(${b.since}부터) · 52주 고점 대비 ${pct(b.from_high52)}`,
          h("div", { class: "muted" }, b.on20 ? "보유 구간 — 주봉 종가가 20주선 아래로 마감하면 이탈" : "쉬는 구간 — 주봉 종가가 20주선 위로 마감하면 다시 보유 구간",
            " (과거: 수익은 그냥 보유와 비슷, 2022년 이후 최대 낙폭 −63% → −26%)"))) : "",
      h("h2", { style: "font-size:16px;margin:16px 0 6px" }, `알트코인 주도주 조건 충족 (${leaders.length}) — 참고`),
      h("div", { class: "note" }, "과거 검증: 비트코인 40주선 조건이 있을 때만 의미가 있었고, 그래도 비트코인을 그냥 들고 있는 것보다 못했습니다."),
      leaders.length ? table(leaders) : h("div", { class: "empty" }, "52주 고점 근처이면서 40주선 위·상승인 코인이 없습니다."),
      h("h2", { style: "font-size:16px;margin:16px 0 6px" }, "목표1 손익비 1 이상 관심 가격대가 가까운 코인 — 참고"),
      h("div", { class: "note" }, "⚠ 과거 검증에서 코인의 관심 가격대 매매는 같은 날 아무 코인을 산 것보다 나빴습니다(2022년 이후 −0.42R). 매수 근거로 쓰지 마세요."),
      near.length ? table(near) : h("div", { class: "empty" }, "현재가 아래 20% 안에 기준을 채운 관심 가격대가 있는 코인이 없습니다."),
      h("div", { class: "note" }, `${c.asof || "-"} 기준 · 상장 2년 이상, 하루 평균 거래대금 10억 원 이상 ${c.rows.length}개 분석`),
    ];
  }


  function planBox(p, v) {
    if (!p) return "";
    const act = (p.entries || []).find((e) => !e.next) || null;
    const nexts = (p.entries || []).filter((e) => e.next);
    const head = [p.phase, p.grade ? `파동 신뢰 등급 ${p.grade}` : "", p.score != null && act ? `계획 점수 ${Math.round(p.score)}점` : ""].filter(Boolean).join(" · ");
    const row = (k, val, sub, cls) => h("div", { class: "prow " + (cls || "") }, h("span", { class: "pk" }, k),
      h("div", { class: "pv" }, h("b", {}, val), sub ? h("div", { class: "psub" }, sub) : ""));
    const entryRows = (e) => [
      row(e.name + (e.state_ko ? ` · ${e.state_ko}` : ""), e.range + (e.dist > 0 ? ` (현재가에서 ${e.dist}% 아래)` : ""),
        [e.parts.length ? `나눠 사는 자리: 위 ${e.parts[0]} / 아래 ${e.parts[1]}` : "", e.meaning ? `뜻: ${e.meaning}` : ""].filter(Boolean).join(" · "), "buy"),
      ...(e.cautions || []).length ? [h("div", { class: "pwarn" }, "⚠ 같은 가격대의 저항 근거(주의): " + e.cautions.join(", "))] : [],
      e.stop ? row("손절 (주봉 종가)", e.stop + (e.stop_pct != null ? ` · 매수가 대비 −${Math.round(e.stop_pct)}%` : ""), e.stop_text, "stop") : "",
      e.too_far ? h("div", { class: "pwarn" }, "⚠ 손절이 너무 멉니다(25% 초과) — 이 구간으로는 매수 판정을 내리지 않습니다") : "",
      ...e.targets.map((t, i) => row(`목표${i + 1}`, t.price + (t.rr != null ? ` · 손익비 ${t.rr.toFixed(1)}` : ""), t.text, "tgt")),
      e.rr != null ? row("계획 손익비", e.rr.toFixed(1), "목표1·목표2 손익비의 평균 (매수가 = 구간 위끝)"
        + (!e.buyable && !e.too_far ? " · ⚠ 매수 판정 기준(목표1 손익비 1 이상) 미달" : "")) : "",
      e.targets.length ? row("파는 법", "목표1에서 절반 매도 → 손절을 산 가격으로 올림" + (e.targets.length > 1 ? " → 나머지는 목표2" : ""),
        "과거 검증에서 목표1 전량 매도보다 대체로 나았던 방법 · 손절은 주봉 종가(금요일 마감) 기준") : "",
    ];
    return h("section", { class: "planbox" + (p.weak ? " weak" : "") + (!act ? " none" : "") },
      h("div", { class: "phead" }, h("span", { class: "ptitle" }, "매수 계획"), h("b", {}, p.label), head ? h("span", { class: "muted" }, " · " + head) : "",
        v && v.label ? h("span", { class: "status v" + v.code }, v.label) : ""),
      p.edge && act ? h("div", { class: p.edge.ok && p.candidate ? "pok" : "pwarn" },
        (p.edge.ok ? (p.candidate ? "✔ 매수 후보 — " : "△ 조건은 맞지만 손익비·손절 기준 미달 — ") : "✘ 매수 후보 아님(가격은 참고용) — ") + p.edge.why,
        p.edge.ok ? h("div", { class: "psub" }, "매수 주문은 지수가 40주 평균선 아래에 있는 동안만 유효합니다(위로 올라서면 주문을 거둡니다).") : "") : "",
      p.scale ? h("div", { class: p.scale.status === "conflict" ? "pwarn" : "psub" }, p.scale.text,
        ...(act ? p.scale.extra : []).map((t) => h("div", { class: "psub" }, "참고: " + t + " (과거 검증에서 이 겹침이 성과를 높이지는 않았습니다)"))) : "",
      p.weak ? h("div", { class: "pwarn" }, "조정 첫 하락(A파) 중의 중간 반등만 노리는 약한 계획입니다 — 목표에서 팔고 오래 들고 가지 않습니다. 알림도 보내지 않습니다.") : "",
      p.wave_note ? h("div", { class: "psub" }, p.wave_note) : "",
      p.fixed ? h("div", { class: "pfixed" }, `📌 ${p.fixed.date} 에 고정한 계획 — 끝날 때(손절·목표1 도달·26주 경과)까지 구간·손절·목표를 바꾸지 않습니다.`
        + (p.fixed.note ? ` ${p.fixed.note}.` : "")) : "",
      (p.changes || []).length ? h("div", { class: "pchg" }, h("b", {}, "지난주와 달라진 점"),
        ...p.changes.map((c) => h("div", { class: "psub" }, "· " + c))) : "",
      !act ? h("div", { class: "pnone" }, p.reason || "근거가 겹치는 관심 가격대가 현재가 아래에 없습니다",
        h("div", { class: "psub" }, "계획이 없을 때는 구간·손절·목표 숫자를 내지 않습니다.")) : "",
      ...(act ? entryRows(act) : []),
      act && p.invalidation ? row("계획 무효", p.invalidation, p.invalidation_text, "inv") : "",
      (p.sell || []).length ? row("매도 후보", p.sell.join(" → "), "위쪽 목표·저항 (들고 있는 사람용)") : "",
      ...nexts.map((e) => h("details", { class: "pnext" },
        h("summary", {}, `1차가 주봉 종가로 깨지면: ${e.rank}차 ${e.range}`), ...entryRows(e))),
      ...(p.past || []).map((z) => h("div", { class: "psub" }, `계획에서 뺀 구간: ${z.range} — 주봉 종가가 손절 ${z.stop} 아래로 내려가 이미 실패`)),
      p.alt ? h("div", { class: "psub" }, "다른 해석: " + p.alt) : "",
      act && p.score != null ? scoreBox(p.score, p.score_parts) : "");
  }


  // ── 차트 ──
  class ZoneBox {  // 가로 띠 (매수·목표 구간)
    constructor(lo, hi, color) { this.lo = lo; this.hi = hi; this.color = color; }
    attached({ series }) { this.series = series; }
    paneViews() {
      return [{
        zOrder: () => "bottom",
        renderer: () => ({
          draw: (target) => target.useBitmapCoordinateSpace((scope) => {
            const y1 = this.series.priceToCoordinate(this.hi);
            const y2 = this.series.priceToCoordinate(this.lo);
            if (y1 === null || y2 === null) return;
            const top = Math.min(y1, y2) * scope.verticalPixelRatio;
            const ht = Math.max(Math.abs(y2 - y1) * scope.verticalPixelRatio, 2);
            scope.context.fillStyle = this.color;
            scope.context.fillRect(0, top, scope.bitmapSize.width, ht);
          }),
        }),
      }];
    }
  }


  // ── 분석 리포트: 글 그대로가 아니라 항목 카드 + 강조 ──
  const HL = [
    [/(손절[^\s,·)]*|무효화|이탈)/g, "hl-stop"],
    [/(\d차 관심 가격대|관심 가격대|\d차 매수 구간|매수 구간|매수 검토|반등)/g, "hl-buy"],
    [/(목표\s?\d?|익절)/g, "hl-tgt"],
    [/(⚠[^·\n]*)/g, "hl-warn"],
    [/([\$]?\d[\d,]*(?:\.\d+)?(?:만|pt|원|%|R)?(?:~[\$]?\d[\d,]*(?:\.\d+)?(?:만)?)?(?: 원)?)/g, "hl-num"],
  ];
  function highlight(text) {
    // 정규식으로 찾은 부분을 색 있는 span 으로 (textContent 만 사용 — 안전)
    let parts = [{ t: text, c: null }];
    for (const [re, cls] of HL) {
      const next = [];
      for (const part of parts) {
        if (part.c) { next.push(part); continue; }
        let last = 0;
        part.t.replace(re, (m, _g, idx) => {
          if (idx > last) next.push({ t: part.t.slice(last, idx), c: null });
          next.push({ t: m, c: cls });
          last = idx + m.length;
          return m;
        });
        if (last < part.t.length) next.push({ t: part.t.slice(last), c: null });
      }
      parts = next;
    }
    return parts.map((x) => (x.c ? h("span", { class: x.c }, x.t) : x.t));
  }
  function renderReport(text) {
    const sections = [];
    let cur = null;
    for (const raw of text.split("\n")) {
      const line = raw.replace(/\s+$/, "");
      if (!line.trim()) continue;
      if (line.startsWith("■")) {
        cur = { title: line.slice(1).trim(), items: [] };
        sections.push(cur);
      } else if (cur) {
        const t = line.trim();
        const sub = /^(-|확인:|전환:)/.test(t) || raw.startsWith("   ");
        cur.items.push({ t: t.replace(/^[·-]\s*/, ""), sub });
      }
    }
    const tone = (title) => (/매수|관심 가격대/.test(title) ? "buy" : /목표/.test(title) ? "tgt" : /손절/.test(title) ? "stop"
      : /엘리엇|하모닉|시나리오|다이버전스/.test(title) ? "pat" : "");
    return h("div", { class: "rgrid" }, ...sections.map((sec) => h("div", { class: "rcard " + tone(sec.title) },
      h("div", { class: "rtitle" }, ...highlight(sec.title)),
      h("ul", {}, ...sec.items.map((it) => h("li", { class: it.sub ? "sub" : "" }, ...highlight(it.t)))))));
  }
  let chart = null;
  let minis = [];
  function drawProjection(line, uniqTimes, pts, color) {
    // 예상 경로: 점선 + 지점 라벨 (방향성용 — 가격·시간은 대략)
    if (!pts || pts.length < 2) return;
    const ser = line(color, 2, 2);
    ser.setData(uniqTimes(pts.map((p) => ({ time: p.t, value: p.price }))));
    ser.setMarkers(pts.slice(1).map((p) => ({ time: p.t, position: "inBar", color, shape: "circle", text: p.label, size: 0.7 })));
  }
  function drawHarmonic(candles, line, uniqTimes, hm, quiet) {   // quiet: 매수1·매수2 구간이 있으면 PRZ 가격 이름은 생략 (구간 표에 이미 들어감)
    // 하모닉: X-A-B-C 실선 → C-D-TP1-TP2 점선 (예상)
    const color = hm.bullish ? cssVar("--entry") : cssVar("--stop");
    line(color, 0, 2).setData(uniqTimes(hm.points.slice(0, 4).map((p) => ({ time: p.t, value: p.price }))));
    const tail = [hm.points[3]].concat(hm.proj && hm.proj.length ? hm.proj : hm.points.slice(4));
    const ser = line(color, 2, 2);
    ser.setData(uniqTimes(tail.map((p) => ({ time: p.t, value: p.price }))));
    ser.setMarkers(tail.slice(1).map((p) => ({ time: p.t, position: "inBar", color, shape: "square", text: p.label, size: 0.6 })));
    candles.attachPrimitive(new ZoneBox(hm.prz[0], hm.prz[1], hm.bullish ? cssVar("--entry-bg") : "rgba(179,38,30,0.12)"));
    if (!quiet) candles.createPriceLine({ price: (hm.prz[0] + hm.prz[1]) / 2, color, lineVisible: false, axisLabelVisible: true, title: hm.name + " PRZ" });
  }
  function drawIndicators(el, d, tf) {
    // 보조지표 작은 차트들 (메인 차트와 가로 스크롤 연동)
    for (const m of minis) m.remove();
    minis = [];
    el.replaceChildren();
    const ind = d.ind && d.ind[tf === "L" || tf === "MID" ? "M" : tf];
    if (!ind || !chart) return;
    const ink = cssVar("--ink"), ink3 = cssVar("--ink3"), orange = "#eb6834";
    const up = cssVar("--up"), down = cssVar("--down");
    const mk = (title) => {
      const area = h("div", { class: "miniarea" });
      el.append(h("div", { class: "minichart" }, h("div", { class: "minititle" }, title), area));
      const c = LightweightCharts.createChart(area, {
        autoSize: true, layout: { background: { type: "solid", color: cssVar("--card") }, textColor: cssVar("--ink2"), fontSize: 10 },
        grid: { vertLines: { visible: false }, horzLines: { color: cssVar("--line") } },
        rightPriceScale: { borderVisible: false, minimumWidth: 70 },
        timeScale: { visible: false, borderVisible: false, rightOffset: 4 },
        crosshair: { mode: 0 }, handleScroll: false, handleScale: false,
      });
      minis.push(c);
      return c;
    };
    const ser = (c, key, color, w) => {
      const sl = c.addLineSeries({ color, lineWidth: w || 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
      sl.setData(ind.t.map((t, i) => (ind[key][i] === null ? { time: t } : { time: t, value: ind[key][i] })));
      return sl;
    };
    const guide = (sl, v) => sl.createPriceLine({ price: v, color: ink3, lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
    let c = mk("MACD 12·26·9 — 막대: 히스토그램 · 선: MACD · 주황: 시그널");
    const hist = c.addHistogramSeries({ lastValueVisible: false, priceLineVisible: false });
    hist.setData(ind.t.map((t, i) => (ind.hist[i] === null ? { time: t } : { time: t, value: ind.hist[i], color: ind.hist[i] >= 0 ? up : down })));
    ser(c, "macd", ink);
    ser(c, "signal", orange);
    if (ind.stk) {
      c = mk((ind.st_name || "스토캐스틱") + " — 선: K · 주황: D · 20/80");
      const k = ser(c, "stk", ink, 1.5);
      ser(c, "std", orange); guide(k, 20); guide(k, 80);
    }
    if (ind.srk) {
      c = mk((ind.sr_name || "Stoch RSI") + " — 선: K · 주황: D");
      const k = ser(c, "srk", ink, 1.5);
      ser(c, "srd", orange); guide(k, 20); guide(k, 80);
    }
    c = mk("RSI 14 — 30 아래 과매도 · 70 위 과열");
    const r = ser(c, "rsi", ink, 1.5);
    guide(r, 30); guide(r, 70);
    c = mk("CCI 20 — ±100 기준선" + (ind.cci_ma ? " · 주황: 평균선" : ""));
    const cc = ser(c, "cci", ink, 1.5);
    if (ind.cci_ma) ser(c, "cci_ma", orange);
    guide(cc, 100); guide(cc, -100);
    const sync = (range) => { if (range) for (const m of minis) m.timeScale().setVisibleLogicalRange(range); };
    chart.timeScale().subscribeVisibleLogicalRangeChange(sync);
    sync(chart.timeScale().getVisibleLogicalRange());
  }


  function addFutureSpace(chart, lastTime, pointLists, monthly) {
    // 예상 경로가 실제 시간 간격대로 펼쳐지도록 미래 구간에 빈 칸(주 또는 월)을 채운다. 반환: 늘어난 칸 수
    const times = pointLists.flat().filter(Boolean).map((p) => p.t).filter((t) => t > lastTime);
    if (!times.length) return 0;
    const maxT = times.sort().pop();
    const out = [];
    const d = new Date(lastTime + "T00:00:00Z");
    for (let i = 0; i < 400; i++) {
      if (monthly) d.setUTCMonth(d.getUTCMonth() + 1); else d.setUTCDate(d.getUTCDate() + 7);
      const t = d.toISOString().slice(0, 10);
      out.push({ time: t });
      if (t >= maxT) break;
    }
    const ws = chart.addLineSeries({ lastValueVisible: false, priceLineVisible: false, visible: false });
    ws.setData(out);
    return out.length;
  }
  function toMonths(pts) {
    const out = [];
    for (const p of pts) {
      const q = { ...p, t: p.t.slice(0, 8) + "01" };
      if (out.length && out[out.length - 1].t === q.t) out[out.length - 1] = q; else out.push(q);
    }
    return out;
  }
  function drawChart(el, d, tf, logScale) {
    if (chart) { chart.remove(); chart = null; }
    const pf = d.price_format;
    chart = LightweightCharts.createChart(el, {
      autoSize: true,
      layout: { background: { type: "solid", color: cssVar("--card") }, textColor: cssVar("--ink2"), fontSize: 11 },
      grid: { vertLines: { color: cssVar("--line") }, horzLines: { color: cssVar("--line") } },
      rightPriceScale: { borderVisible: false, mode: logScale ? 1 : 0, scaleMargins: { top: 0.08, bottom: 0.18 } },
      timeScale: { borderVisible: false, rightOffset: 4 },
      crosshair: { mode: 0 },
      localization: { priceFormatter: (v) => fmtPrice(v, pf), locale: "ko-KR" },
    });
    const up = cssVar("--up"), down = cssVar("--down");
    const candles = chart.addCandlestickSeries({
      upColor: up, downColor: down, borderVisible: false, wickUpColor: up, wickDownColor: down,
      priceFormat: { type: "custom", formatter: (v) => fmtPrice(v, pf), minMove: 0.0001 },
    });
    const bars = d[tf === "L" || tf === "MID" ? "M" : tf];
    candles.setData(bars.map((b) => ({ time: b[0], open: b[1], high: b[2], low: b[3], close: b[4] })));
    if (bars.some((b) => b[5] > 0)) {
      const vol = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
      vol.setData(bars.map((b) => ({ time: b[0], value: b[5], color: b[4] >= b[1] ? "rgba(214,75,74,0.35)" : "rgba(47,111,191,0.35)" })));
    }
    const line = (color, style, width) => chart.addLineSeries({ color, lineWidth: width || 1, lineStyle: style || 0,
      lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
    const uniqTimes = (pts) => pts.filter((p, i, arr) => i === 0 || p.time > arr[i - 1].time);
    const show = layers();
    if (tf === "MID") {  // 중기(월봉, 최근 큰 상승 파동 시작부터): 중간 등급 파동 + 주봉 파동 + 월봉 하모닉
      const lt = d.long_term || {};
      const lc = lt.chart || { waves: [], harmonics: [], sub: [] };
      const ink = cssVar("--target"), small = cssVar("--ink2");
      const sw = lc.sub || [];
      const mk = [];
      if (show.wave && sw.length > 1) {
        line(ink, 0, 2).setData(uniqTimes(sw.map((w) => ({ time: w.t, value: w.price }))));
        for (const w of sw.filter((x) => x.label)) mk.push({ time: w.t, position: w.kind === "H" ? "aboveBar" : "belowBar", color: ink, shape: "circle", text: w.label, size: 1.1 });
        const ww = (d.waves || []).map((w) => ({ t: w.M, kind: w.kind, label: w.label, price: w.price }));
        if (ww.length > 1) {
          line(small, 2, 1).setData(uniqTimes(ww.map((w) => ({ time: w.t, value: w.price }))));
          for (const w of ww) mk.push({ time: w.t, position: w.kind === "H" ? "aboveBar" : "belowBar", color: small, shape: "circle", text: w.label, size: 0.4 });
        }
      }
      candles.setMarkers(mk.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0)));
      if (show.zone) for (const z of lt.supports || []) {
        candles.attachPrimitive(new ZoneBox(z.lo, z.hi, "rgba(42,120,214,0.14)"));
        candles.createPriceLine({ price: (z.lo + z.hi) / 2, color: cssVar("--accent"), lineVisible: false, axisLabelVisible: true, title: "장기 지지" });
      }
      if (show.harm) for (const hm of (lc.harmonics || []).filter((x) => x.near)) (show.harmOff.has(harmKey(hm)) ? null : drawHarmonic(candles, line, uniqTimes, hm));
      if (show.wave) drawProjection(line, uniqTimes, toMonths(lc.sub_proj || []), ink);   // 중기 파동 앞으로 예상 경로
      const start = sw.length ? bars.findIndex((b) => b[0] >= sw[0].t) : bars.length - 120;
      const extraM = addFutureSpace(chart, bars[bars.length - 1][0], [toMonths(lc.sub_proj || []), ...(lc.harmonics || []).filter((x) => x.near).map((x) => x.proj || [])], true);
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, start - 6), to: bars.length + extraM + 3 });
      return;
    }
    if (tf === "L") {  // 장기(월봉): 장기 엘리엇 카운트 · 장기 하모닉 · 장기 지지/저항
      const lt = d.long_term || {};
      const lc = lt.chart || { waves: [], harmonics: [] };
      if (show.zone) for (const z of lt.supports || []) {
        candles.attachPrimitive(new ZoneBox(z.lo, z.hi, "rgba(42,120,214,0.14)"));
        candles.createPriceLine({ price: (z.lo + z.hi) / 2, color: cssVar("--accent"), lineVisible: false, axisLabelVisible: true, title: "장기 지지" });
      }
      if (show.zone) for (const z of lt.resist || []) {
        candles.attachPrimitive(new ZoneBox(z.lo, z.hi, cssVar("--target-bg")));
        candles.createPriceLine({ price: (z.lo + z.hi) / 2, color: cssVar("--target"), lineVisible: false, axisLabelVisible: true, title: "장기 저항" });
      }
      // 큰 등급(Ⅰ~Ⅴ·(A)(B)(C)) = 굵은 선·큰 글자, 주봉 카운트(①~⑤·A B C) = 가는 선 — 두 등급의 위치 관계를 함께 본다
      const ink = cssVar("--target"), small = cssVar("--ink2");
      if (show.wave && lc.waves.length > 1) line(ink, 0, 3).setData(uniqTimes(lc.waves.map((w) => ({ time: w.t, value: w.price }))));
      // 작은 파동: 큰 파동의 마지막 점에서 다시 센 세부 파동(있으면) — 없으면 주봉 카운트
      const sw = (lc.sub && lc.sub.length > 1) ? lc.sub
        : (d.waves || []).map((w) => ({ t: w.M, kind: w.kind, label: w.label, price: w.price }));
      if (show.wave && sw.length > 1) line(small, 0, 1).setData(uniqTimes(sw.map((w) => ({ time: w.t, value: w.price }))));
      const mk = (show.wave ? lc.waves : []).map((w) => ({ time: w.t, position: w.kind === "H" ? "aboveBar" : "belowBar", color: ink,
        shape: "circle", text: w.label, size: 1.4 }))
        .concat((show.wave ? sw : []).filter((w) => w.label).map((w) => ({ time: w.t, position: w.kind === "H" ? "aboveBar" : "belowBar", color: small,
          shape: "circle", text: w.label, size: 0.5 })));
      candles.setMarkers(mk.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0)));
      const extraL = addFutureSpace(chart, bars[bars.length - 1][0], [lc.proj || [], toMonths(lc.sub_proj || []), ...lc.harmonics.map((x) => x.proj || [])], true);
      if (show.harm) for (const hm of lc.harmonics) (show.harmOff.has(harmKey(hm)) ? null : drawHarmonic(candles, line, uniqTimes, hm));
      if (show.wave) drawProjection(line, uniqTimes, lc.proj, ink);
      if (show.wave && (lc.sub_proj || []).length > 1) drawProjection(line, uniqTimes, toMonths(lc.sub_proj), small);   // 세부(중기) 파동의 예상 경로
      chart.timeScale().setVisibleLogicalRange({ from: 0, to: bars.length + extraL + 3 });
      return;
    }
    const CALL = d.call || {};   // 차트도 답과 같게: 매수 주문일 때만 주문 선, 아니면 계획 구간은 회색 '참고'
    const WRc = (CALL.zones || []).length ? [CALL] : [];   // 구간 표시: 매수1·매수2… · 매도1·매도2 · 지난 구간(회색) · 매수1 손절
    if (show.zone && WRc.length) {
      const band = (z, bg, color, title) => {
        if (z.hi_v / z.lo_v - 1 > 0.002) candles.attachPrimitive(new ZoneBox(z.lo_v, z.hi_v, bg));
        candles.createPriceLine({ price: z.hi_v, color, lineWidth: z.hi_v / z.lo_v - 1 > 0.002 ? 1 : 2, lineStyle: 0, axisLabelVisible: true, title });
      };
      for (const z of CALL.past || []) band(z, "rgba(140,140,140,0.18)", cssVar("--ink3"), "지남");
      for (const z of CALL.zones) band(z, z.after_stop ? "rgba(27,175,122,0.07)" : cssVar("--entry-bg"), z.after_stop ? cssVar("--ink3") : cssVar("--entry"),
        `${z.name} ${z.inside ? "지금" : z.dist > 0 ? "−" + z.dist + "%" : ""}`);
      for (const s of CALL.sells || []) band(s, cssVar("--target-bg"), cssVar("--target"), `${s.name} ${s.reached ? "도달" : pcs(s.pct)}`);
      const z1 = CALL.zones[0];
      if (z1 && z1.stop_v) candles.createPriceLine({ price: z1.stop_v, color: cssVar("--stop"), lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: `손절 −${z1.stop_pct}%` });
    }
    if (show.zone && d.macro && !WRc.length) {   // 지수·환율: 아래 지지 / 위 저항 구간
      (d.macro.supports || []).forEach((z, i) => {
        candles.attachPrimitive(new ZoneBox(z.lo, z.hi, cssVar("--entry-bg")));
        candles.createPriceLine({ price: (z.lo + z.hi) / 2, color: cssVar("--entry"), lineVisible: false, axisLabelVisible: true, title: `지지 ${i + 1}` });
      });
      (d.macro.resists || []).forEach((z, i) => {
        candles.attachPrimitive(new ZoneBox(z.lo, z.hi, cssVar("--target-bg")));
        candles.createPriceLine({ price: (z.lo + z.hi) / 2, color: cssVar("--target"), lineVisible: false, axisLabelVisible: true, title: `저항 ${i + 1}` });
      });
    }
    const oldZones = show.zone && !WRc.length && !d.macro;
    const isBuy = CALL.kind === "buy";
    if (oldZones) for (const z of isBuy ? d.entries : d.entries.slice(0, 2)) {   // 지나간 구간·매수 신호가 아닌 구간은 회색
      const grey = z.past || !isBuy;
      candles.attachPrimitive(new ZoneBox(z.lo, z.hi, grey ? "rgba(140,140,140,0.16)" : cssVar("--entry-bg")));
      candles.createPriceLine({ price: (z.lo + z.hi) / 2, color: grey ? cssVar("--ink3") : cssVar("--entry"), lineVisible: false, axisLabelVisible: true,
        title: (z.short || z.label.split(" ")[0]) + (z.past ? "(지남)" : !isBuy ? "(참고)" : z.retest ? "(재시험)" : "") });
    }
    if (oldZones && isBuy) for (const z of d.targets) {
      candles.attachPrimitive(new ZoneBox(z.lo, z.hi, z.past ? "rgba(140,140,140,0.16)" : cssVar("--target-bg")));
      candles.createPriceLine({ price: (z.lo + z.hi) / 2, color: z.past ? cssVar("--ink3") : cssVar("--target"), lineVisible: false, axisLabelVisible: true, title: z.short || z.label.split(" ")[0] });
    }
    if (show.fib) for (const f of d.fibs) {
      candles.createPriceLine({ price: f.price, color: cssVar("--ink3"), lineWidth: 1, lineStyle: 1, axisLabelVisible: false, title: f.label });
    }
    if (d.stop && oldZones && isBuy) candles.createPriceLine({ price: d.stop.price, color: cssVar("--stop"), lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: "손절" });
    const tl = d.verdict && d.verdict.levels && d.verdict.levels.trend_line;  // 보유 종목: 추세 이탈선(설정 주 수, 기본 20주선)
    if (tl) candles.createPriceLine({ price: tl, color: "#8e5bd6", lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: "추세 이탈선" });
    if (tf === "M" && d.long_term) {  // 월봉: 장기 지지 구간
      for (const z of d.long_term.supports || []) {
        candles.attachPrimitive(new ZoneBox(z.lo, z.hi, "rgba(42,120,214,0.12)"));
        candles.createPriceLine({ price: (z.lo + z.hi) / 2, color: cssVar("--accent"), lineVisible: false, axisLabelVisible: true, title: "장기 지지" });
      }
    }
    const waveInk = cssVar("--target");
    const waveAt = new Map((d.waves || []).map((w) => [w[tf], w]));
    const markers = d.pivots.filter((p) => show.pivot && p.tf === tf && !waveAt.has(p.t)).map((p) => ({
      time: p.t, position: p.kind === "H" ? "aboveBar" : "belowBar", color: cssVar("--ink2"),
      shape: p.kind === "H" ? "arrowDown" : "arrowUp", text: p.label, size: 0.6,
    }));
    for (const w of show.wave ? d.subwaves || [] : []) {  // 지금 진행 중인 파동 안의 작은 파동 (i ii iii iv / a b c)
      markers.push({ time: w[tf], position: w.kind === "H" ? "aboveBar" : "belowBar", color: cssVar("--ink2"), shape: "circle", text: w.label, size: 0.4 });
    }
    for (const w of show.wave ? d.waves || [] : []) {  // 엘리엇 파동 라벨
      markers.push({ time: w[tf], position: w.kind === "H" ? "aboveBar" : "belowBar", color: waveInk,
        shape: "circle", text: w.label, size: 0.8 });
    }
    markers.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    candles.setMarkers(markers);
    if (show.wave && (d.waves || []).length > 1) {  // 파동 연결선
      line(waveInk, 0, 1).setData(uniqTimes(d.waves.map((w) => ({ time: w[tf], value: w.price }))));
    }
    // 엘리엇 예상 경로: 주봉 결과를 그대로, 월봉에서는 같은 날짜를 그 달 1일로 옮겨 그린다(같은 달이면 뒤의 점만)
    const proj = tf === "M" ? toMonths(d.proj || []) : (d.proj || []);
    const mHarm = ((d.long_term && d.long_term.chart && d.long_term.chart.harmonics) || []).filter((x) => x.near);   // 월봉 극점으로 찾은 하모닉(현재가 ±35% 안)
    if (show.harm) for (const hm of tf === "W" ? d.harmonics || [] : mHarm) (show.harmOff.has(harmKey(hm)) ? null : drawHarmonic(candles, line, uniqTimes, hm, WRc.length > 0));  // 하모닉 X-A-B-C → D → TP
    if (show.harm && tf === "M") for (const hm of d.harmonics || []) {   // 주봉 하모닉: 월봉에선 꼭짓점이 몇 개 봉에 뭉치므로 PRZ와 D→TP 경로만
      if (show.harmOff.has(harmKey(hm))) continue;
      const color = hm.bullish ? cssVar("--entry") : cssVar("--stop");
      candles.attachPrimitive(new ZoneBox(hm.prz[0], hm.prz[1], hm.bullish ? cssVar("--entry-bg") : "rgba(179,38,30,0.12)"));
      candles.createPriceLine({ price: (hm.prz[0] + hm.prz[1]) / 2, color, lineVisible: false, axisLabelVisible: true, title: hm.name + " PRZ(주봉)" });
      const tail = toMonths([{ t: bars[bars.length - 1][0], price: bars[bars.length - 1][4], label: "" }].concat(hm.proj || []));
      const ser = line(color, 2, 2);
      ser.setData(uniqTimes(tail.map((q) => ({ time: q.t, value: q.price }))));
      ser.setMarkers(tail.slice(1).map((q) => ({ time: q.t, position: "inBar", color, shape: "square", text: q.label, size: 0.6 })));
    }
    if (show.wave) drawProjection(line, uniqTimes, proj, waveInk);
    for (const dv of (d.divs || []).filter((x) => show.div && x.tf === tf)) {  // 다이버전스
      const color = dv.kind === "bearish" ? cssVar("--up") : cssVar("--entry");
      line(color, 0, 2).setData(uniqTimes([{ time: dv.a.t, value: dv.a.price }, { time: dv.b.t, value: dv.b.price }]));
    }
    const n = bars.length;
    const extra = addFutureSpace(chart, bars[n - 1][0], [proj, ...(tf === "W" ? d.harmonics || [] : mHarm).map((x) => x.proj || []),
      ...(tf === "M" ? (d.harmonics || []).map((x) => toMonths(x.proj || [])) : [])], tf === "M");
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - (tf === "W" ? 130 : 72)), to: n + Math.min(extra, tf === "W" ? 40 : 24) + 4 });   // 먼 예상 경로는 옆으로 밀어서 보기
  }


  // ── 종목 상세: ① 답(사도 되나?) ② 왜 ③ 차트 ④ 더 보기 ──
  // 구간 표: 매수1·매수2… (가까운 순) · 매도1·매도2 · 지난 구간 — 어떻게 살지는 사용자가 정한다
  function zoneTable(c) {
    const row = (cls, name, range, sub, extra) => h("tr", { class: cls }, h("td", {}, h("b", {}, name)), h("td", {}, h("b", {}, range)),
      h("td", {}, sub), h("td", { class: "muted" }, extra || ""));
    return h("div", { class: "tablewrap" }, h("table", { class: "zt" },
      h("tbody", {},
        ...(c.sells || []).slice().reverse().map((s) => row("tgt" + (s.reached ? " passed" : ""), s.name, s.range,
          s.reached ? "도달" : pcs(s.pct))),
        ...(c.zones || []).filter((z) => !z.after_stop).map((z) => row("buy", z.name, z.range, z.inside ? "구간 안" : z.dist > 0 ? `−${z.dist}%` : "위",
          [z.score != null ? `${z.score}점` : "", (z.methods || []).join(" · "), z.stop_v ? `손절 ${z.stop} (−${z.stop_pct}%)` : ""].filter(Boolean).join(" · "))),
        ...(c.zones || []).filter((z) => z.after_stop).map((z, i) => [
          i === 0 ? h("tr", { class: "sep" }, h("td", { colspan: "4" }, `매수1 손절(${c.zones[0].stop})까지 내려가면 그 다음에 볼 자리 — 따로 다시 판단`)) : "",
          row("next", z.name, z.range, `−${z.dist}%`,
            [z.score != null ? `${z.score}점` : "", (z.methods || []).join(" · "), z.stop_v ? `손절 ${z.stop} (−${z.stop_pct}%)` : ""].filter(Boolean).join(" · "))]),
        ...(c.past || []).map((z) => row("passed", "지남", z.range, "", z.why || "이미 지나간 구간")))),
      h("div", { class: "muted", style: "font-size:12px" }, "매수 % = 지금 가격에서 얼마나 아래 · 매도 % = 매수1 위끝에서 얼마나 위"));
  }
  function answerBox(d, c) {
    const isFlow = c.kind === "flow";
    const q = isFlow ? "지금 흐름은?" : "이 종목, 지금 사도 되나요?";
    let head, body = [];
    if (c.kind === "buy") {
      head = h("span", {}, h("span", { class: "ascore " + scoreCls(c.score) }, `매수 점수 ${c.score}점`), ` ${c.band}`);
      const P = c.parts || {};
      body = [
        zoneTable(c),
        h("div", { class: "arule" }, `방법: ${c.method}` + (c.note ? ` (${c.note})` : "") + ` · 손익비 ${c.rr.toFixed(1)}`
          + (c.acc != null ? ` · 과거 성공률 ${pctR(c.acc)}` : " · 과거 성공률 측정 안 됨")),
        h("div", { class: "ah" }, "점수 계산"),
        h("div", { class: "pts" },
          ...[["근거 겹침", P["근거 겹침"], 50], ["손익비", P["손익비"], 20], ["손절 폭", P["손절 폭"], 15], ["과거 성공률", P["과거 성공률"], 15]]
            .map(([k, v, mx]) => h("div", {}, h("span", {}, k), h("b", {}, `${v ?? 0}/${mx}`))),
          h("div", { class: "ptsum" }, `근거 점수 ${c.base} × 거리 계수 ${c.factor} (${buyWhere(c)}) = ${c.score}점`)),
      ];
    } else if (isFlow) {
      const m = d.macro || {};
      head = c.title;
      body = [h("div", { class: "awhy" }, c.why),
        h("div", { class: "big3 two" },
          cell("아래 지지", c.support ? c.support.range : "없음", c.support ? `${c.support.dist}% · 근거 ${c.support.n}개` : "", "buy"),
          cell("위 저항", c.resist ? c.resist.range : "없음", c.resist ? `+${c.resist.dist}% · 근거 ${c.resist.n}개` : "", "tgt")),
        h("div", { class: "arule" }, `52주 고점 ${m.hi52} · 저점 ${m.lo52} (저점에서 +${m.from_lo52}%)`)];
    } else if (c.kind === "sell") {
      head = c.title;
      body = [h("div", { class: "awhy" }, c.why),
        (c.nums || []).length ? h("div", { class: "big3" }, ...c.nums.slice(0, 3).map(([k, v]) => cell(k, v))) : ""];
    } else {
      head = c.kind === "hold" ? "계속 보유" : c.kind === "coin" ? c.title : "매수 점수 없음";
      body = [h("div", { class: "awhy" }, c.why), (c.zones || []).length ? zoneTable(c) : ""];
    }
    return h("section", { class: "ans k-" + kindOf(c)[0] }, h("div", { class: "aq" }, q), h("div", { class: "aa" }, head), ...body);
  }
  // 왜 이렇게 판단했나 — 사람이 읽는 문장으로 (숫자는 계산값 그대로)
  function whyBox(d, c) {
    const items = [];
    const p = d.plan || {};
    if (c.kind === "buy") {
      items.push(`매수 가격 ±2% 안에 겹친 근거 ${c.n_levels}개 (${c.families.join(" · ")})`);
      for (const t of c.evidence || []) items.push(t);
      if (d.wave_now) items.push("파동 해석: " + d.wave_now);
    } else if (c.kind === "flow") {
      const m = d.macro || {};
      items.push(`40주 평균(${m.ma40})과의 거리 ${m.gap > 0 ? "+" : ""}${m.gap}% — ${m.above ? "평균 위" : "평균 아래"} ${m.weeks}주째`);
      if ((m.pivots || []).length) items.push("큰 고점·저점 순서: " + m.pivots.map((x) => `${x.date} ${x.kind === "H" ? "고점" : "저점"} ${x.price}`).join(" → "));
      if (m.reading) items.push("파동 해석: " + m.reading);
    } else {
      if (d.wave_now) items.push("파동 해석: " + d.wave_now);
      if (p.label && p.label !== "계획 없음") items.push("계획의 이야기: " + p.label + (p.phase ? ` (${p.phase})` : ""));
    }
    if (d.long_term && d.long_term.count && d.long_term.current) items.push("월봉(장기): " + d.long_term.current);
    if (!items.length && !d.narrative) return "";
    return section("왜 이렇게 판단했나요?", "", h("div", { class: "whybox" },
      items.length ? h("ul", {}, ...items.map((t) => h("li", {}, t))) : "",
      d.narrative ? h("div", { class: "ai" }, h("span", { class: "ailabel" }, "AI 해석"), d.narrative) : ""));
  }
  function chartLegend(d, c) {
    const L = (color, text, box) => h("span", {}, h("i", { class: box ? "box" : "", style: `background:${color}` }), text);
    const parts = [];
    if ((c.zones || []).length) parts.push(L("var(--entry-bg)", "매수1·매수2 구간(가까운 순)", true), L("var(--target-bg)", "매도1·매도2 구간", true),
      L("var(--stop)", "손절(점선, 매수1 기준)"), L("rgba(140,140,140,0.35)", "지남 = 이미 지나간 구간", true));
    else if (c.kind === "flow") parts.push(L("var(--entry-bg)", "아래 지지", true), L("var(--target-bg)", "위 저항", true));
    else parts.push(L("rgba(140,140,140,0.35)", "참고 가격대(매수 신호 아님)", true));
    parts.push(L("var(--target)", "동그라미 숫자 = 파동 번호"), (d.subwaves || []).length ? L("var(--ink2)", "작은 i·ii·iii / a·b·c = 지금 진행 중인 파동 안의 작은 파동") : "",
      h("span", {}, "점선 + ? = 예상 경로(방향만 참고)"));
    return h("div", { class: "legend" }, ...parts);
  }

  async function renderDetail(safe) {
    app.replaceChildren(h("div", { class: "empty" }, "불러오는 중…"));
    let d = cache.get(safe);
    if (!d) {
      try { d = await openSealed(await fetchSealed(`data/s/${safe}.json`)); cache.set(safe, d); }
      catch (e) { app.replaceChildren(h("a", { class: "back", href: "#/" }, "← 목록"), h("div", { class: "empty" }, "상세 데이터를 불러오지 못했습니다.")); return; }
    }
    const c = d.call || { kind: "no", title: "사지 않음", why: (d.verdict || {}).headline || "" };
    const v = d.verdict || {};
    let tf = "W", logScale = d.log_default;
    const chartEl = h("div", { id: "chart", role: "img", "aria-label": `${d.name} 차트` });
    const indEl = h("div", { class: "minis" });
    const btn = (label, pressed, onclick) => h("button", { class: "btn", "aria-pressed": String(pressed), onclick }, label);
    const toolbar = h("div", { class: "toolbar" });
    const layerBar = h("div");
    const redraw = () => {
      const lcx = (d.long_term && d.long_term.chart) || {};
      layerBar.replaceChildren(layerChips(redraw, tf === "W" ? d.harmonics : (lcx.harmonics || []).filter((x) => tf === "L" || x.near).concat(tf === "M" ? d.harmonics || [] : []), availLayers(d, tf)));
      toolbar.replaceChildren(
        btn("주봉", tf === "W", () => { tf = "W"; redraw(); }),
        btn("월봉", tf === "M", () => { tf = "M"; redraw(); }),
        d.long_term && d.long_term.chart && (d.long_term.chart.sub || []).length > 1 ? btn("중기 파동", tf === "MID", () => { tf = "MID"; redraw(); }) : "",
        d.long_term ? btn("장기 파동", tf === "L", () => { tf = "L"; logScale = true; redraw(); }) : "",
        btn("로그 눈금", logScale, () => { logScale = !logScale; redraw(); }),
        h("a", { class: "btn", href: d.tv_url, target: "_blank", rel: "noopener" }, "트레이딩뷰 ↗"));
      drawChart(chartEl, d, tf, logScale);
      drawIndicators(indEl, d, tf);   // 보조지표: 차트 바로 아래 (MACD → 스토캐스틱 → 스토캐스틱 RSI → RSI → CCI)
    };
    const zoneList = (zs, kind) => zs.map((z) => h("details", {},
      h("summary", { style: `color: var(${kind === "entry" ? "--entry-ink" : "--target-ink"})` }, z.label, ` · 근거 ${z.evidence.length}개`),
      h("ul", {}, ...z.evidence.map((e) => h("li", {}, e)))));
    const cols = d.cols || [];
    const checkTable = (d.checklist || []).length ? [h("div", { class: "tablewrap" }, h("table", { class: "checks" },
      h("thead", {}, h("tr", {}, h("th", {}, "구간"), ...cols.map((x) => h("th", {}, x)))),
      h("tbody", {}, ...d.checklist.map((r) => h("tr", { class: r.kind === "매수" ? "buy" : "tgt" },
        h("td", {}, h("b", {}, r.label), h("br"), h("span", { class: "muted" }, r.range),
          r.kind === "매수" && !r.pattern ? [h("br"), h("span", { class: "warnmini" }, "패턴 근거 없음")] : ""),
        ...cols.map((x) => h("td", { class: r.cols[x] ? "on" : "off" }, r.cols[x] ? ["✔", h("br"), h("span", { class: "mini" }, r.cols[x])] : "—"))))))),
      h("div", { class: "confirms" }, h("span", { class: "muted" }, "반등 확인(보조지표): "),
        ...(d.confirms || []).map((x) => h("span", { class: "chip " + (x.on ? "ok" : "no"), title: x.text }, (x.on ? "✔ " : "✘ ") + x.name)))] : "";
    const scen = (d.scenarios || []).length ? h("div", { class: "scen" }, ...d.scenarios.map((s) => h("div", { class: "scard" },
      h("div", { class: "srank" }, s.rank), h("div", { class: "sname" }, s.name),
      s.zone ? h("div", {}, "구간 ", h("b", {}, s.zone)) : "", s.target ? h("div", {}, "목표 ", h("b", {}, s.target + "~")) : "",
      ...s.confirm.map((x) => h("div", { class: "sok" }, "✔ " + x)), ...s.invalid.map((x) => h("div", { class: "sno" }, "↪ " + x))))) : "";
    const lt = d.long_term;
    const longCard = lt ? h("div", { class: "prose", style: "font-size:14px" },
      h("p", {}, h("b", {}, lt.current)),
      lt.current_small ? h("p", {}, lt.current_small) : "",
      lt.count ? h("p", { class: "muted" }, lt.count) : "",
      lt.alt ? h("p", { class: "muted" }, lt.alt) : "",
      (lt.targets || []).length ? h("p", {}, "장기 목표: ", h("b", {}, lt.targets.join(" / "))) : "",
      lt.invalidation ? h("p", {}, "장기 해석이 틀리는 가격: ", h("b", {}, lt.invalidation)) : "",
      (lt.supports || []).length ? h("p", {}, "장기 지지 구간: ", h("b", {}, lt.supports.map((z) => z.label).join(" / "))) : "",
      (lt.resist || []).length ? h("p", {}, "장기 저항 구간: ", h("b", {}, lt.resist.map((z) => z.label).join(" / "))) : "",
      h("p", { class: "muted" }, "'장기 파동' 버튼: 굵은 선 Ⅰ~Ⅴ·(A)(B)(C) = 한 등급 큰 파동, 가는 선 = 그 안의 세부 파동. 자동으로 센 후보이며 정답이 아닙니다.")) : "";
    const wr = (d.wave_rules || []);
    const wrTable = wr.length ? h("div", { class: "tablewrap" }, h("table", { class: "leaders" },
      h("thead", {}, h("tr", {}, ...["자리", "사는 가격", "손절", "팔 가격", "더 버틸 때", "과거 성공률"].map((x) => h("th", {}, x)))),
      h("tbody", {}, ...wr.map((x) => h("tr", {}, h("td", {}, x.grade + (x.ref_only ? " (참고)" : "")), h("td", {}, h("b", { class: "buyc" }, x.entry)),
        h("td", { class: "stopc" }, `${x.wstop} (−${x.stop_pct}%)`), h("td", { class: "tgtc" }, x.t1), h("td", { class: "tgtc" }, x.t2 || "-"),
        h("td", {}, x.acc != null ? pctR(x.acc) : "-")))))) : "";
    app.replaceChildren(
      h("a", { class: "back", href: "#/" }, "← 목록"),
      h("div", { class: "dtitle" }, h("h1", {}, d.name), h("span", { class: "muted" }, d.symbol), d.price ? h("span", { class: "dprice" }, d.price) : ""),
      answerBox(d, c),
      whyBox(d, c),
      section("차트", "", toolbar, layerBar, chartEl, indEl, chartLegend(d, c),
        (d.proj_notes || []).length ? h("div", { class: "muted" }, "예상 경로: " + d.proj_notes.join(" · ")) : ""),
      section("더 자세히", "필요할 때만",
        fold(c.kind === "flow" ? "계획 원본 (참고 — 지수·환율은 흐름을 봅니다)" : "파동 해석과 계획 원본", planBox(d.plan, v)),
        fold("근거 표 — 가격대마다 어떤 근거가 겹쳤나", checkTable),
        fold("시나리오", scen),
        fold("장기 추세 (월봉)", longCard),
        fold("가격대별 계산값", [...zoneList(d.entries || [], "entry"), ...zoneList(d.targets || [], "target"),
          d.stop ? h("div", { class: "stopc", style: "font-size:14px" }, d.stop.label) : ""]),
        d.report ? fold("분석 글 전체", renderReport(d.report)) : ""),
      h("div", { class: "foot" }, `${d.asof} 종가 기준 · 규칙 버전 ${(d.plan || {}).rules_version || "-"} · 계산 결과에 기반한 참고 자료이며 매매 권유가 아닙니다.`));
    redraw();
    window.scrollTo(0, 0);
  }

  // ── 라우팅 ──
  function route() {
    if (!index) return renderLogin();
    const m = location.hash.match(/^#\/s\/(.+)$/);
    if (m) renderDetail(decodeURIComponent(m[1]));
    else { for (const x of minis) x.remove(); minis = []; if (chart) { chart.remove(); chart = null; } renderHome(); }
  }
  window.addEventListener("hashchange", route);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => index && route());

  (async () => {
    const saved = store.get(PW_KEY);
    if (saved) {
      try { await unlock(saved); return route(); } catch { store.del(PW_KEY); }
    }
    renderLogin();
  })();
})();
