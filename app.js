// 雅思听力单词听写 —— 前端逻辑（纯静态页面，数据存于 localStorage）

const STORAGE_KEY = "ielts_dictation_records_v1";

// 每个主题卡片的图标 + 主色调（渐变色由 hue 生成，保证 20 个主题颜色依次过渡、不重复）
const THEME_ICONS = {
  accommodation: "🏠",
  travel: "✈️",
  leisure: "🎭",
  work: "💼",
  bank: "🏦",
  medical: "🩺",
  library: "📚",
  campus: "🎓",
  subjects: "📖",
  assignment: "📝",
  biology: "🧬",
  environment: "🌍",
  technology: "💻",
  history: "🏛️",
  architecture: "🏗️",
  economy: "💰",
  languageArt: "🎨",
  psychology: "🧠",
  lawGovernment: "⚖️",
  countryRegion: "🌐",
};

function themeGradient(index, total) {
  const hue = Math.round((350 - (360 / total) * index + 360) % 360);
  return `linear-gradient(135deg, hsl(${hue}, 70%, 68%), hsl(${hue}, 65%, 52%))`;
}

let mode = "home"; // home | wrongbook | history | dictation | summary
let homeState = { themeKey: null, subset: "all", selectedCategories: new Set() };
let session = null;

const SESSION_KEY = "ielts_dictation_active_session_v1";

function saveSessionState() {
  if (!session) {
    localStorage.removeItem(SESSION_KEY);
    return;
  }
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      themeName: session.themeName,
      subsetName: session.subsetName,
      words: session.words,
      idx: session.idx,
      results: session.results,
    })
  );
}

function loadSessionState() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved || !Array.isArray(saved.words) || saved.idx >= saved.words.length) return null;
    return saved;
  } catch (e) {
    return null;
  }
}

function clearSavedSession() {
  localStorage.removeItem(SESSION_KEY);
}

/* ---------------- 本地存储 ---------------- */

function loadRecords() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch (e) {
    return [];
  }
}
function saveRecords(records) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}
function addRecord(rec) {
  const all = loadRecords();
  all.push(rec);
  saveRecords(all);
}

function pad(n) {
  return n < 10 ? "0" + n : "" + n;
}
function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

/* ---------------- 语音朗读（英式发音） ---------------- */

let voices = [];
function loadVoices() {
  voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
}
if ("speechSynthesis" in window) {
  loadVoices();
  window.speechSynthesis.onvoiceschanged = loadVoices;
}
function pickBritishVoice() {
  if (!voices.length) return null;
  return (
    voices.find((v) => v.lang === "en-GB" && /female|female/i.test(v.name)) ||
    voices.find((v) => v.lang === "en-GB") ||
    voices.find((v) => /en[-_]gb/i.test(v.lang)) ||
    voices.find((v) => /UK|British/i.test(v.name)) ||
    voices.find((v) => v.lang && v.lang.startsWith("en")) ||
    null
  );
}
function speak(word) {
  if (!("speechSynthesis" in window) || !word) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(word);
  u.lang = "en-GB";
  const v = pickBritishVoice();
  if (v) u.voice = v;
  u.rate = 0.85;
  u.pitch = 1;
  window.speechSynthesis.speak(u);
}

/* ---------------- 音效（用 Web Audio 合成，不依赖音频文件） ---------------- */

let audioCtx = null;
function getAudioCtx() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) audioCtx = new Ctx();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function playTone(ctx, freq, startTime, duration, opts = {}) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = opts.type || "sine";
  osc.frequency.setValueAtTime(freq, startTime);
  if (opts.freqTo) {
    osc.frequency.exponentialRampToValueAtTime(opts.freqTo, startTime + duration);
  }
  const peak = opts.volume != null ? opts.volume : 0.15;
  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.exponentialRampToValueAtTime(peak, startTime + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration + 0.03);
}

// 打字音效：每次敲键盘一个短促清脆的"嗒"声，音高做一点随机浮动听着不单调
function playTypeSound() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  playTone(ctx, 1500 + Math.random() * 300, ctx.currentTime, 0.045, {
    type: "sine",
    volume: 0.05,
  });
}

// 答对音效：上扬的两个音，清脆愉快的"叮咚"
function playCorrectSound() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const now = ctx.currentTime;
  playTone(ctx, 880, now, 0.12, { type: "sine", volume: 0.2 });
  playTone(ctx, 1318.5, now + 0.09, 0.22, { type: "sine", volume: 0.2 });
}

// 答错音效：短促下沉的"哔——"，但不刺耳
function playWrongSound() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const now = ctx.currentTime;
  playTone(ctx, 320, now, 0.22, { type: "sine", freqTo: 160, volume: 0.18 });
}

/* ---------------- 词库工具函数 ---------------- */

// 单词的听写顺序需要和 PDF 原文顺序保持一致，这里按 WORD_BANK 的声明顺序
// （主题 -> 分类 -> 单词，与 PDF 章节顺序一致）建立一个全局序号表，供错题本
// 重听时按原书顺序重新排序使用。
let _wordOrderIndex = null;
function getWordOrderIndex() {
  if (_wordOrderIndex) return _wordOrderIndex;
  const map = new Map();
  let i = 0;
  Object.keys(WORD_BANK).forEach((themeKey) => {
    WORD_BANK[themeKey].categories.forEach((cat) => {
      cat.words.forEach((w) => {
        if (!map.has(w.en)) map.set(w.en, i);
        i++;
      });
    });
  });
  _wordOrderIndex = map;
  return map;
}
function sortByPdfOrder(words) {
  const order = getWordOrderIndex();
  return words
    .map((w, i) => ({ w, key: order.has(w.en) ? order.get(w.en) : Number.MAX_SAFE_INTEGER, i }))
    .sort((a, b) => a.key - b.key || a.i - b.i)
    .map((x) => x.w);
}

function getThemeWords(themeKey, subset, categoryKeys) {
  const theme = WORD_BANK[themeKey];
  const words = [];
  theme.categories.forEach((cat) => {
    if (categoryKeys && !categoryKeys.has(cat.key)) return;
    cat.words.forEach((w) => {
      if (subset === "bold" && !w.bold) return;
      words.push({ en: w.en, zh: w.zh, alt: w.alt || null, categoryKey: cat.key, categoryName: cat.name });
    });
  });
  return words;
}

function normalizeAnswer(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/* ---------------- 导出 CSV ---------------- */

function csvEscape(v) {
  v = String(v == null ? "" : v);
  if (/[",\n]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
  return v;
}
function exportRecordsCSV(records, filename) {
  if (!records.length) {
    alert("没有可导出的记录");
    return;
  }
  const header = ["日期", "主题", "分类", "单词", "中文释义", "作答内容", "是否正确"];
  const rows = records.map((r) => [
    r.date,
    r.themeName || "",
    r.categoryName || "",
    r.en,
    r.zh,
    r.userAnswer,
    r.correct ? "正确" : "错误",
  ]);
  const csv =
    "﻿" + [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ---------------- 错题本 / 历史统计 ---------------- */

function getWrongDates() {
  const records = loadRecords().filter((r) => !r.correct);
  const map = {};
  records.forEach((r) => {
    if (!map[r.date]) map[r.date] = {};
    map[r.date][r.en] = r; // 按单词去重，保留最新一次错误记录
  });
  return Object.keys(map)
    .sort()
    .reverse()
    .map((date) => ({ date, words: Object.values(map[date]) }));
}

function getDates() {
  const records = loadRecords();
  const map = {};
  records.forEach((r) => {
    if (!map[r.date]) map[r.date] = { total: 0, correct: 0 };
    map[r.date].total++;
    if (r.correct) map[r.date].correct++;
  });
  return Object.keys(map)
    .sort()
    .reverse()
    .map((date) => ({ date, ...map[date] }));
}

// 删掉某一天的错题记录（只删答错的那些，答对的记录和统计不受影响）
function deleteWrongRecordsForDate(date) {
  const all = loadRecords();
  const kept = all.filter((r) => !(r.date === date && !r.correct));
  saveRecords(kept);
}

// 删掉某一天的全部听写记录（不管对错），用于历史记录页彻底清空某天
function deleteAllRecordsForDate(date) {
  const all = loadRecords();
  const kept = all.filter((r) => r.date !== date);
  saveRecords(kept);
}

/* ---------------- 听写会话 ---------------- */

function startSession() {
  const words = getThemeWords(homeState.themeKey, homeState.subset, homeState.selectedCategories);
  if (!words.length) return;
  session = {
    themeName: WORD_BANK[homeState.themeKey].name,
    subsetName: homeState.subset === "bold" ? "黑体词" : "全部单词",
    words: words.slice(),
    idx: 0,
    results: [],
    answered: false,
    lastSpokenIdx: -1,
    lastUserAnswer: "",
  };
  mode = "dictation";
  saveSessionState();
  render();
}

function startWrongSession(date) {
  const days = getWrongDates();
  const day = days.find((d) => d.date === date);
  if (!day || !day.words.length) return;
  const words = day.words.map((r) => ({
    en: r.en,
    zh: r.zh,
    alt: r.alt || null,
    themeName: r.themeName,
    categoryName: r.categoryName,
  }));
  session = {
    themeName: "错题重听",
    subsetName: date,
    words: sortByPdfOrder(words),
    idx: 0,
    results: [],
    answered: false,
    lastSpokenIdx: -1,
    lastUserAnswer: "",
  };
  mode = "dictation";
  saveSessionState();
  render();
}

function submitAnswer() {
  const input = document.getElementById("answerInput");
  const userAnswer = input ? input.value : "";
  const word = session.words[session.idx];
  const answerNorm = normalizeAnswer(userAnswer);
  // 发音统一用英式，但英式/美式两种拼法（如 colour/color）都算对
  const correct =
    answerNorm === normalizeAnswer(word.en) || (word.alt && answerNorm === normalizeAnswer(word.alt));
  const rec = {
    id: "r" + Date.now() + "_" + Math.floor(Math.random() * 100000),
    date: todayStr(),
    ts: Date.now(),
    themeName: word.themeName || session.themeName,
    categoryName: word.categoryName || null,
    en: word.en,
    zh: word.zh,
    alt: word.alt || null,
    userAnswer,
    correct,
  };
  addRecord(rec);
  session.results.push(rec);
  session.answered = true;
  session.lastUserAnswer = userAnswer;
  saveSessionState();
  if (correct) playCorrectSound();
  else playWrongSound();
  render();
}

function nextWord() {
  session.idx++;
  session.answered = false;
  session.lastUserAnswer = "";
  if (session.idx >= session.words.length) {
    mode = "summary";
    clearSavedSession(); // 已经听写完了，不用再当作"未完成"保留
  } else {
    saveSessionState();
  }
  render();
}

function exitSession() {
  if (!confirm("要退出本次听写吗？已经完成的部分会保留在错题本和历史记录里，剩余的单词可以下次继续听写。")) {
    return;
  }
  session = null;
  mode = "home";
  render();
}

/* ---------------- 视图渲染 ---------------- */

function render() {
  document.querySelectorAll("#mainTabs button").forEach((b) => {
    const active =
      b.dataset.tab === mode ||
      ((mode === "dictation" || mode === "summary") && b.dataset.tab === "home");
    b.classList.toggle("active", active);
  });

  const view = document.getElementById("view");
  if (mode === "home") {
    view.innerHTML = renderHome();
    bindHome();
  } else if (mode === "wrongbook") {
    view.innerHTML = renderWrongbook();
    bindWrongbook();
  } else if (mode === "history") {
    view.innerHTML = renderHistory();
    bindHistory();
  } else if (mode === "dictation") {
    view.innerHTML = renderDictation();
    bindDictation();
  } else if (mode === "summary") {
    view.innerHTML = renderSummary();
    bindSummary();
  }
}

/* ---- 首页：选主题 / 范围 / 分类 ---- */

function renderHome() {
  let html = "";
  if (!session) {
    const resumable = loadSessionState();
    if (resumable) {
      const done = resumable.idx;
      const total = resumable.words.length;
      html += `<div class="card resume-banner">
        <h2>继续上次的听写？</h2>
        <div class="section-label">${escapeHtml(resumable.themeName)} · ${escapeHtml(
        resumable.subsetName
      )} · 已完成 ${done} / ${total} 个</div>
        <div class="btn-row" style="margin-top:12px;">
          <button class="btn ghost" id="discardResumeBtn">放弃</button>
          <button class="btn" id="resumeBtn">继续听写</button>
        </div>
      </div>`;
    }
  }
  html += '<div class="card"><h2>1. 选择主题</h2><div class="theme-grid">';
  const themeKeys = Object.keys(WORD_BANK);
  themeKeys.forEach((key, index) => {
    const t = WORD_BANK[key];
    const sel = homeState.themeKey === key ? "selected" : "";
    const count = t.categories.reduce((s, c) => s + c.words.length, 0);
    const icon = THEME_ICONS[key] || "📘";
    const numLabel = String(index + 1).padStart(2, "0");
    const chips = t.categories
      .map((c) => `<span>${escapeHtml(c.name)}</span>`)
      .join("");
    html += `<div class="theme-card ${sel}" data-theme="${key}">
      <div class="theme-banner" style="background:${themeGradient(index, themeKeys.length)}">
        <div class="theme-icon">${icon}</div>
        <div class="theme-index">${numLabel}</div>
      </div>
      <div class="theme-body">
        <div class="theme-title"><span class="dot" style="background:${themeGradient(
          index,
          themeKeys.length
        )}"></span>${escapeHtml(t.name)}<span class="theme-count">${count} 词</span></div>
        <div class="theme-chips">${chips}</div>
      </div>
    </div>`;
  });
  html += "</div></div>";

  if (homeState.themeKey) {
    const theme = WORD_BANK[homeState.themeKey];
    const allCount = theme.categories.reduce((s, c) => s + c.words.length, 0);
    const boldCount = theme.categories.reduce(
      (s, c) => s + c.words.filter((w) => w.bold).length,
      0
    );

    html += '<div class="card"><h2>2. 选择听写范围</h2><div class="subset-grid">';
    html += `<div class="subset-card ${
      homeState.subset === "all" ? "selected" : ""
    }" data-subset="all">
      <div class="title">全部单词</div><div class="desc">共 ${allCount} 个</div>
    </div>`;
    html += `<div class="subset-card ${
      homeState.subset === "bold" ? "selected" : ""
    }" data-subset="bold">
      <div class="title">黑体词（核心词）</div><div class="desc">共 ${boldCount} 个</div>
    </div>`;
    html += "</div>";

    html += "<h3>按分类选择（可多选）</h3><div class=\"cat-list\">";
    theme.categories.forEach((cat) => {
      const cnt =
        homeState.subset === "bold"
          ? cat.words.filter((w) => w.bold).length
          : cat.words.length;
      const sel = homeState.selectedCategories.has(cat.key) ? "selected" : "";
      html += `<div class="cat-chip ${sel}" data-cat="${cat.key}">${cat.name} (${cnt})</div>`;
    });
    html += "</div>";
    html +=
      '<div class="btn-row"><button class="btn ghost small" id="selAllCat">全选分类</button><button class="btn ghost small" id="selNoneCat">全不选</button></div>';

    const words = getThemeWords(homeState.themeKey, homeState.subset, homeState.selectedCategories);
    html += `<div class="section-label">当前已选中 ${words.length} 个单词</div>`;
    html += `<button class="btn" id="startBtn" ${words.length === 0 ? "disabled" : ""}>开始听写</button>`;
    html += "</div>";
  }
  return html;
}

function bindHome() {
  const resumeBtn = document.getElementById("resumeBtn");
  if (resumeBtn) {
    resumeBtn.onclick = () => {
      const saved = loadSessionState();
      if (!saved) {
        render();
        return;
      }
      session = {
        themeName: saved.themeName,
        subsetName: saved.subsetName,
        words: saved.words,
        idx: saved.idx,
        results: saved.results,
        answered: false,
        lastSpokenIdx: -1,
        lastUserAnswer: "",
      };
      mode = "dictation";
      render();
    };
  }
  const discardResumeBtn = document.getElementById("discardResumeBtn");
  if (discardResumeBtn) {
    discardResumeBtn.onclick = () => {
      clearSavedSession();
      render();
    };
  }
  document.querySelectorAll(".theme-card").forEach((el) => {
    el.addEventListener("click", () => {
      homeState.themeKey = el.dataset.theme;
      homeState.subset = "all";
      homeState.selectedCategories = new Set(
        WORD_BANK[homeState.themeKey].categories.map((c) => c.key)
      );
      render();
    });
  });
  document.querySelectorAll(".subset-card").forEach((el) => {
    el.addEventListener("click", () => {
      homeState.subset = el.dataset.subset;
      render();
    });
  });
  document.querySelectorAll(".cat-chip").forEach((el) => {
    el.addEventListener("click", () => {
      const key = el.dataset.cat;
      if (homeState.selectedCategories.has(key)) homeState.selectedCategories.delete(key);
      else homeState.selectedCategories.add(key);
      render();
    });
  });
  const selAll = document.getElementById("selAllCat");
  if (selAll)
    selAll.onclick = () => {
      homeState.selectedCategories = new Set(
        WORD_BANK[homeState.themeKey].categories.map((c) => c.key)
      );
      render();
    };
  const selNone = document.getElementById("selNoneCat");
  if (selNone)
    selNone.onclick = () => {
      homeState.selectedCategories = new Set();
      render();
    };
  const startBtn = document.getElementById("startBtn");
  if (startBtn) startBtn.onclick = startSession;
}

/* ---- 听写页 ---- */

function renderDictation() {
  const total = session.words.length;
  const word = session.words[session.idx];
  const progressPct = Math.round((session.idx / total) * 100);

  let html = '<div class="card">';
  html += `<div class="dictation-topbar">
    <button class="exit-btn" id="exitSessionBtn" title="退出本次听写">‹ 退出</button>
  </div>`;
  html += `<div class="progress-bar"><div style="width:${progressPct}%"></div></div>`;
  html += `<div class="section-label">${session.themeName} · ${session.subsetName} · 第 ${
    session.idx + 1
  } / ${total} 个</div>`;
  html += '<div class="dictation-stage">';
  html += `<input type="text" class="answer-input ${
    session.answered ? (session.results[session.results.length - 1].correct ? "correct" : "wrong") : ""
  }" id="answerInput" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="输入你听到的单词" ${
    session.answered ? "disabled" : ""
  } value="${session.answered ? escapeHtml(session.lastUserAnswer) : ""}" />`;
  html += '<button class="speak-btn" id="speakBtn" title="点击听发音">🔊</button>';
  html += '<div class="hint-line">点击喇叭听英式发音（可反复点击），然后拼写出该单词</div>';
  html += "</div>";

  if (!session.answered) {
    html += '<button class="btn" id="submitBtn">提交</button>';
  } else {
    const r = session.results[session.results.length - 1];
    html += `<div class="feedback ${r.correct ? "correct" : "wrong"}">`;
    html += r.correct ? "✅ 回答正确！" : "❌ 回答错误，正确答案是：";
    html += `<div class="answer-word">${escapeHtml(r.en)}${
      r.alt ? ` <span class="alt-spelling">/ ${escapeHtml(r.alt)}</span>` : ""
    }</div>`;
    html += `<div class="meaning">${escapeHtml(r.zh)}</div>`;
    html += "</div>";
    html += `<button class="btn" id="nextBtn">${
      session.idx + 1 >= total ? "查看结果" : "下一个"
    }</button>`;
  }
  html += "</div>";
  return html;
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function bindDictation() {
  const exitBtn = document.getElementById("exitSessionBtn");
  if (exitBtn) exitBtn.onclick = exitSession;

  const speakBtn = document.getElementById("speakBtn");
  if (speakBtn) {
    speakBtn.onclick = () => {
      speak(session.words[session.idx].en);
      speakBtn.classList.remove("playing");
      void speakBtn.offsetWidth; // 强制重排，让动画能重新触发
      speakBtn.classList.add("playing");
    };
  }

  const input = document.getElementById("answerInput");
  if (input && !session.answered) input.focus();
  if (input) {
    input.addEventListener("keydown", (e) => {
      // 只有真正会改变输入内容的键才发出打字音效（字母数字符号、退格、删除）
      if (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete") {
        playTypeSound();
      }
    });
  }

  if (!session.answered) {
    const submitBtn = document.getElementById("submitBtn");
    if (submitBtn) submitBtn.onclick = submitAnswer;
  } else {
    const nextBtn = document.getElementById("nextBtn");
    if (nextBtn) nextBtn.onclick = nextWord;
  }

  if (!session.answered && session.lastSpokenIdx !== session.idx) {
    session.lastSpokenIdx = session.idx;
    speak(session.words[session.idx].en);
    if (speakBtn) speakBtn.classList.add("playing");
  }
}

/* ---- 结果页 ---- */

function renderSummary() {
  const total = session.results.length;
  const correctCount = session.results.filter((r) => r.correct).length;
  const wrongList = session.results.filter((r) => !r.correct);

  let html = '<div class="card"><h2>本次听写结果</h2>';
  html += `<div class="summary-score"><div class="num">${correctCount}/${total}</div><div class="sub">正确率 ${
    total ? Math.round((correctCount / total) * 100) : 0
  }%</div></div>`;

  if (wrongList.length) {
    html += `<h3>错误单词（${wrongList.length}）</h3><div class="wrong-word-list">`;
    wrongList.forEach((r) => {
      html += `<div class="item"><span class="w">${escapeHtml(r.en)}</span><span class="m">${escapeHtml(
        r.zh
      )}</span></div>`;
    });
    html += "</div>";
  } else {
    html += '<div class="empty-tip">🎉 全部正确，太棒了！</div>';
  }

  html += `<div class="btn-row" style="margin-top:16px;">
    <button class="btn secondary" id="exportSessionBtn">导出本次记录</button>
    <button class="btn" id="backHomeBtn">返回首页</button>
  </div></div>`;
  return html;
}

function bindSummary() {
  document.getElementById("exportSessionBtn").onclick = () => {
    exportRecordsCSV(session.results, `雅思单词听写_${todayStr()}_${session.themeName}.csv`);
  };
  document.getElementById("backHomeBtn").onclick = () => {
    session = null;
    mode = "home";
    render();
  };
}

/* ---- 错题本 ---- */

function renderWrongbook() {
  let html = '<div class="card"><h2>错题本</h2>';
  const days = getWrongDates();
  if (!days.length) {
    html += '<div class="empty-tip">还没有错题记录，去听写几个单词吧～</div>';
  } else {
    days.forEach((d) => {
      html += `<div class="day-item">
        <div class="info"><div class="date">${d.date}</div><div class="stats">${d.words.length} 个错题</div></div>
        <div class="actions">
          <button class="btn small" data-relisten="${d.date}">听写这天错题</button>
          <button class="btn small ghost danger" data-delete-wrong="${d.date}">删除</button>
        </div>
      </div>`;
    });
  }
  html += "</div>";
  return html;
}

function bindWrongbook() {
  document.querySelectorAll("[data-relisten]").forEach((el) => {
    el.onclick = () => startWrongSession(el.dataset.relisten);
  });
  document.querySelectorAll("[data-delete-wrong]").forEach((el) => {
    el.onclick = () => {
      const date = el.dataset.deleteWrong;
      if (!confirm(`确定要删除 ${date} 这天的错题记录吗？`)) return;
      deleteWrongRecordsForDate(date);
      render();
    };
  });
}

/* ---- 历史记录 / 导出 ---- */

function renderHistory() {
  let html = '<div class="card"><h2>历史记录</h2>';
  const dates = getDates();
  if (!dates.length) {
    html += '<div class="empty-tip">还没有听写记录</div>';
  } else {
    html +=
      '<div class="btn-row" style="margin-bottom:14px;"><button class="btn secondary" id="exportAllBtn">导出全部记录</button></div>';
    dates.forEach((d) => {
      const wrongCount = d.total - d.correct;
      html += `<div class="day-item">
        <div class="info"><div class="date">${d.date}</div><div class="stats">共 ${d.total} 词，正确 ${d.correct}，错误 ${wrongCount}</div></div>
        <div class="actions">
          <button class="btn small secondary" data-export="${d.date}">导出</button>
          ${
            wrongCount > 0
              ? `<button class="btn small ghost danger" data-delete-wrong="${d.date}">删除错题</button>`
              : ""
          }
          <button class="btn small ghost danger" data-delete-day="${d.date}">删除本天记录</button>
        </div>
      </div>`;
    });
  }
  html += "</div>";
  return html;
}

function bindHistory() {
  const exportAllBtn = document.getElementById("exportAllBtn");
  if (exportAllBtn)
    exportAllBtn.onclick = () => exportRecordsCSV(loadRecords(), "雅思单词听写_全部记录.csv");
  document.querySelectorAll("[data-export]").forEach((el) => {
    el.onclick = () => {
      const date = el.dataset.export;
      exportRecordsCSV(
        loadRecords().filter((r) => r.date === date),
        `雅思单词听写_${date}.csv`
      );
    };
  });
  document.querySelectorAll("[data-delete-wrong]").forEach((el) => {
    el.onclick = () => {
      const date = el.dataset.deleteWrong;
      if (!confirm(`确定要删除 ${date} 这天的错题记录吗？（正确的记录不受影响）`)) return;
      deleteWrongRecordsForDate(date);
      render();
    };
  });
  document.querySelectorAll("[data-delete-day]").forEach((el) => {
    el.onclick = () => {
      const date = el.dataset.deleteDay;
      if (!confirm(`确定要删除 ${date} 这天的全部听写记录吗？此操作无法撤销。`)) return;
      deleteAllRecordsForDate(date);
      render();
    };
  });
}

/* ---------------- 初始化 ---------------- */

document.getElementById("mainTabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tab]");
  if (!btn) return;
  const tab = btn.dataset.tab;
  if (tab === "home") {
    // 正在听写时点"开始听写"标签页要回到听写进度，而不是清空回选择页
    mode = session ? (session.idx >= session.words.length ? "summary" : "dictation") : "home";
  } else {
    // 切到错题本/历史记录时不清空 session，听写进度留着，回来还能继续
    mode = tab;
  }
  render();
});

// 全局监听回车键：听写页里，输入答案后回车=提交，看到反馈后再回车=下一个。
// 提交后输入框会被禁用（无法获得焦点/键盘事件），所以这里用 document 级别监听，
// 而不是挂在输入框上，这样禁用状态下回车依然能触发"下一个"。
document.addEventListener("keydown", (e) => {
  if (mode !== "dictation" || !session || e.key !== "Enter") return;
  e.preventDefault();
  if (!session.answered) submitAnswer();
  else nextWord();
});

render();
