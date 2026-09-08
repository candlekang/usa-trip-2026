// 美國行 2026 — 前端主程式（Firebase v2）
//
// 架構：
//   身分   Firebase Auth（Google 登入）→ uid；白名單在 Firestore allow/{email}，由 Rules 核對
//   資料   Firestore，每個 collection 一個 onSnapshot 監聽；照片依「天」延遲監聽
//   離線   persistentLocalCache（IndexedDB）：沒訊號時寫入排隊，恢復後自動送出
//   寫入   一律分路徑寫「自己那一格 / 自己那一筆」，不整包覆蓋（Rules 也只允許這樣）
//   畫面   沿用原作者的 render 函式；有輸入框在焦點時暫存更新，失焦再套用
//
// 詳細資料模型與規則見 firestore.rules。

import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  onAuthStateChanged, signOut, connectAuthEmulator, signInWithCredential,
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager,
  connectFirestoreEmulator, doc, collection, onSnapshot, setDoc, updateDoc, deleteDoc,
  deleteField, getDoc, query, where,
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';
import { REGION_ART, dayArt } from './art.js';

/* ===================== FIREBASE INIT ===================== */
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const USE_EMU = new URLSearchParams(location.search).has('emu')
  || ['localhost', '127.0.0.1'].includes(location.hostname)
  || location.hostname.startsWith('mac-mini');
let db;
try {
  db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
} catch (e) {
  db = getFirestore(app);
}
if (USE_EMU) {
  connectAuthEmulator(auth, `http://${location.hostname}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, location.hostname, 8080);
  // 本機測試用：在 console 打 __emuLogin('alice@test.local','Alice') 直接以假帳號登入（只在 emulator 生效）
  window.__emuLogin = (email, name) => signInWithCredential(auth, GoogleAuthProvider.credential(
    JSON.stringify({ sub: 'emu-' + email, email, email_verified: true, name: name || email.split('@')[0] })));
  window.__dbg = () => ({ pending: [...pendingRenders].map(f => f.name), typing: isTypingActive(), build: BUILD });
}
const BUILD = 'v2-dev-5';

/* ===================== STATE ===================== */
let ME = null;            // { uid, email }
let CFG = null;           // config/itinerary
let DAYS = [], REGIONS = [], INFO_SECTIONS = [], CHECKLIST_DEFAULT = [], GUIDE_ITEMS = [];
let TRIP_START = null, TRIP_END = null;

let MEMBERS = {};         // uid -> {name, avatar, joinedAt}
let CHECKINS = {};        // itemId -> {checkedBy:{uid:true}}
let PRETRIP = {};         // idx -> {checkedBy:{uid:true}}
let COMMENTS = {};        // itemId -> [{id, by, text, ts}]
let JOURNAL = {};         // dayId -> [{id, by, text, ts}]
let PHOTOS = {};          // dayId -> [{id, by, data, ts}]
let EXPENSES = [];        // [{id, ...}]
let NOTES = {};           // key -> text
let PERSONAL = [];        // localStorage（個人，不同步）

let editingExpenseId = null;
let expenseParticipants = new Set();
let pendingReceipt = null;
let pendingAvatar = null;
let openDays = new Set();
let openRegions = new Set();
let openComments = new Set();
let editingComments = new Set();
let editingJournal = new Set();
const photoListeners = new Map();   // dayId -> unsubscribe
const unsubs = [];

/* ===================== UTIL ===================== */
const $ = (id) => document.getElementById(id);
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }
function itemId(dayId, idx) { return dayId + '-i' + idx; }
function newId(col) { return doc(collection(db, col)).id; }
function nameOf(uid) { const m = MEMBERS[uid]; return m ? m.name : '（已離開）'; }
function memberUids() { return Object.keys(MEMBERS).sort((a, b) => (MEMBERS[a].joinedAt || 0) - (MEMBERS[b].joinedAt || 0)); }
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}
function showScreen(id) {
  ['screen-login', 'screen-inapp', 'screen-denied', 'screen-nick', 'mainApp'].forEach(s => { $(s).style.display = s === id ? '' : 'none'; });
  $('landing').style.display = id === 'mainApp' ? 'none' : '';
  $('tabbar').style.display = id === 'mainApp' ? 'flex' : 'none';
}

/* ---- 寫入：不等伺服器回應（離線時也能操作），失敗只提示 ---- */
function fire(promise, failMsg) {
  promise.catch(err => {
    console.warn('write failed', err);
    toast(failMsg || (err.code === 'permission-denied' ? '沒有權限做這個操作' : '存檔失敗，再試一次看看？'));
  });
}

/* ---- 畫面更新：有人在打字就先暫存，失焦再套用 ---- */
const pendingRenders = new Set();
function isTypingActive() {
  const el = document.activeElement;
  return !!(el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && ['text', 'number', 'search'].includes(el.type))));
}
function requestRender(...fns) {
  fns.forEach(f => pendingRenders.add(f));
  if (isTypingActive()) return;
  flushRenders();
}
function flushRenders() {
  const fns = [...pendingRenders]; pendingRenders.clear();
  let saved = new Map();
  try { saved = snapshotInputs(); } catch (e) { console.error('snapshotInputs', e); }
  fns.forEach(f => { try { f(); } catch (e) { console.error('render', f.name, e); } });
  try { restoreInputs(saved); } catch (e) { console.error('restoreInputs', e); }
}
/* 重畫前記住打到一半的字，重畫後放回去（以 id 或第一個 data-* 當 key） */
function inputKey(el) {
  if (el.id) return '#' + el.id;
  const k = Object.keys(el.dataset)[0];
  return k ? k + '=' + el.dataset[k] : null;
}
function snapshotInputs() {
  const m = new Map();
  document.querySelectorAll('input[type=text],input[type=number],textarea').forEach(el => {
    const k = inputKey(el); if (k && el.value) m.set(k, el.value);
  });
  return m;
}
function restoreInputs(m) {
  if (!m.size) return;
  document.querySelectorAll('input[type=text],input[type=number],textarea').forEach(el => {
    const k = inputKey(el); if (k && m.has(k) && !el.value) el.value = m.get(k);
  });
}
function flushIfIdle() { if (pendingRenders.size && !isTypingActive()) flushRenders(); }
document.addEventListener('focusout', () => setTimeout(flushIfIdle, 50));
document.addEventListener('click', () => setTimeout(flushIfIdle, 50), true);
document.addEventListener('visibilitychange', flushIfIdle);
setInterval(flushIfIdle, 800);   // 兜底：focusout 在某些環境不會發

/* ===================== AUTH FLOW ===================== */
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });

async function login() {
  const btn = $('loginBtn'); btn.disabled = true;
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/cancelled-popup-request'].includes(e.code)) {
      try { await signInWithRedirect(auth, provider); return; } catch (e2) { console.warn(e2); }
    }
    if (e.code !== 'auth/popup-closed-by-user') toast('登入失敗：' + (e.code || e.message));
  } finally { btn.disabled = false; }
}
async function logout() { await signOut(auth); location.reload(); }

getRedirectResult(auth).catch(e => console.warn('redirect result', e));

/* ---- app 內建瀏覽器偵測：LINE / FB / IG 的 WebView 不能做 Google 登入 ---- */
function inAppBrowser() {
  const ua = navigator.userAgent || '';
  if (/\bLine\//i.test(ua)) return 'LINE';
  if (/FBAN|FBAV|FB_IAB/i.test(ua)) return 'Facebook';
  if (/Instagram/i.test(ua)) return 'Instagram';
  if (/MicroMessenger/i.test(ua)) return 'WeChat';
  return null;
}
function externalUrl() {
  const u = new URL(location.href);
  u.searchParams.set('openExternalBrowser', '1');   // LINE 官方參數：用外部瀏覽器開
  return u.toString();
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    ME = null;
    const iab = inAppBrowser();
    if (iab) {
      $('inappName').textContent = iab;
      $('openExternalBtn').href = externalUrl();
      showScreen('screen-inapp');
      return;
    }
    showScreen('screen-login'); return;
  }
  ME = { uid: user.uid, email: user.email || '' };
  // 白名單檢查：讀 config/itinerary，被拒 = 不在名單
  let cfgSnap;
  try {
    cfgSnap = await getDoc(doc(db, 'config', 'itinerary'));
  } catch (e) {
    if (e.code === 'permission-denied') {
      $('deniedEmail').textContent = ME.email;
      showScreen('screen-denied');
      return;
    }
    toast('連線失敗，請檢查網路後重新整理'); return;
  }
  if (!cfgSnap.exists()) { toast('行程資料尚未建立，請通知管理者'); return; }
  applyConfig(cfgSnap.data());

  // 監聽成員；沒有自己的成員文件 → 先取暱稱
  const meSnap = await getDoc(doc(db, 'members', ME.uid));
  if (!meSnap.exists()) {
    $('nickInput').value = (user.displayName || '').slice(0, 12);
    $('goBtn').disabled = !$('nickInput').value.trim();
    showScreen('screen-nick');
    return;
  }
  enterApp();
});

function applyConfig(cfg) {
  CFG = cfg;
  DAYS = cfg.days || []; REGIONS = cfg.regions || []; INFO_SECTIONS = cfg.info || [];
  CHECKLIST_DEFAULT = cfg.checklist || []; GUIDE_ITEMS = cfg.guide || [];
  TRIP_START = new Date(cfg.tripStart); TRIP_END = new Date(cfg.tripEnd);
}

/* ---- 暱稱畫面 ---- */
function initNickScreen() {
  $('nickInput').addEventListener('input', e => { $('goBtn').disabled = !e.target.value.trim(); });
  $('nickInput').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.value.trim()) $('goBtn').click(); });
  $('landingAvatarBtn').addEventListener('click', () => $('landingAvatarInput').click());
  $('landingAvatarInput').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      pendingAvatar = await compressImage(file, 300, 0.7);
      $('landingAvatarPreview').innerHTML = '<img src="' + esc(pendingAvatar) + '">';
    } catch (err) { toast('這張照片沒辦法用，換一張試試看？'); }
    e.target.value = '';
  });
  $('goBtn').addEventListener('click', async () => {
    const v = $('nickInput').value.trim().slice(0, 12);
    if (!v) return;
    $('goBtn').disabled = true;
    try {
      await setDoc(doc(db, 'members', ME.uid), { name: v, avatar: pendingAvatar || null, joinedAt: Date.now() });
      pendingAvatar = null;
      enterApp();
    } catch (err) {
      toast('建立失敗：' + (err.code || err.message)); $('goBtn').disabled = false;
    }
  });
  $('nickLogoutBtn').addEventListener('click', logout);
}

/* ===================== ENTER APP：掛監聽 ===================== */
let entered = false;
function enterApp() {
  if (entered) return; entered = true;
  showScreen('mainApp');
  $('view-guide').classList.add('active');
  PERSONAL = loadPersonal();

  unsubs.push(onSnapshot(doc(db, 'config', 'itinerary'), s => { if (s.exists()) { applyConfig(s.data()); requestRender(renderAll); } }));
  unsubs.push(onSnapshot(collection(db, 'members'), s => {
    const prev = JSON.stringify(Object.keys(MEMBERS).sort());
    MEMBERS = {}; s.forEach(d => { MEMBERS[d.id] = d.data(); });
    const changed = prev !== JSON.stringify(Object.keys(MEMBERS).sort());
    if (changed && !editingExpenseId) expenseParticipants = new Set(memberUids());
    requestRender(renderTopbar, renderDayList, renderMembers, renderExpenseList, renderSettlement, renderRecap);
    if (changed) requestRender(renderExpenseForm);
    if (ME && !MEMBERS[ME.uid] && s.metadata.fromCache === false) { /* 自己退出了 */ logout(); }
  }));
  unsubs.push(onSnapshot(collection(db, 'checkins'), s => {
    CHECKINS = {}; s.forEach(d => { CHECKINS[d.id] = d.data(); });
    requestRender(renderTopbar, renderDayList, renderMembers, renderRecap);
  }));
  unsubs.push(onSnapshot(collection(db, 'pretrip'), s => {
    PRETRIP = {}; s.forEach(d => { PRETRIP[d.id] = d.data(); });
    requestRender(renderChecklist);
  }));
  unsubs.push(onSnapshot(collection(db, 'comments'), s => {
    COMMENTS = {}; s.forEach(d => { const c = { id: d.id, ...d.data() }; (COMMENTS[c.itemId] ||= []).push(c); });
    Object.values(COMMENTS).forEach(l => l.sort((a, b) => a.ts - b.ts));
    requestRender(renderDayList);
  }));
  unsubs.push(onSnapshot(collection(db, 'journal'), s => {
    JOURNAL = {}; s.forEach(d => { const j = { id: d.id, ...d.data() }; (JOURNAL[j.dayId] ||= []).push(j); });
    Object.values(JOURNAL).forEach(l => l.sort((a, b) => a.ts - b.ts));
    requestRender(renderDayList, renderRecap);
  }));
  unsubs.push(onSnapshot(collection(db, 'expenses'), s => {
    EXPENSES = []; s.forEach(d => EXPENSES.push({ id: d.id, ...d.data() }));
    requestRender(renderExpenseList, renderSettlement, renderRecap);
  }));
  unsubs.push(onSnapshot(collection(db, 'notes'), s => {
    NOTES = {}; s.forEach(d => { NOTES[d.id] = d.data().text || ''; });
    requestRender(renderInfo);
  }));

  renderAll();
  initTabs(); initLightbox(); initSettleModal(); initOfflineBanner();
  $('personalAddBtn').addEventListener('click', addPersonalItem);
  $('personalInput').addEventListener('keydown', e => { if (e.key === 'Enter') addPersonalItem(); });
  $('logoutBtn1').addEventListener('click', logout);
  setInterval(renderTopbar, 60000);
}

function renderAll() {
  renderTopbar(); renderDayList(); renderRegions(); renderInfo(); renderChecklist();
  renderPersonal(); renderGuide(); renderMembers(); renderExpenseForm(); renderExpenseList();
  renderSettlement(); renderRecap();
}

/* 照片：展開某一天才開始監聽那一天 */
function ensurePhotoListener(dayId) {
  if (photoListeners.has(dayId)) return;
  const q = query(collection(db, 'photos'), where('dayId', '==', dayId));
  photoListeners.set(dayId, onSnapshot(q, s => {
    const list = []; s.forEach(d => list.push({ id: d.id, ...d.data() }));
    list.sort((a, b) => a.ts - b.ts);
    PHOTOS[dayId] = list;
    requestRender(renderDayList, renderRecap);
  }));
}

/* ===================== RENDER：TOPBAR ===================== */
function fmtCountdown() {
  const now = new Date();
  if (!TRIP_START) return '';
  if (now < TRIP_START) return '距離出發還有 ' + Math.ceil((TRIP_START - now) / 86400000) + ' 天';
  if (now <= TRIP_END) return '旅行中 · Day ' + (Math.floor((now - TRIP_START) / 86400000) + 1);
  return '旅程已結束 🎉';
}
function checkableItems() {
  const list = [];
  DAYS.forEach(d => d.items.forEach((it, idx) => { if (it.links && it.links.length) list.push(itemId(d.id, idx)); }));
  return list;
}
function checkedCount(rec) { return rec && rec.checkedBy ? Object.keys(rec.checkedBy).length : 0; }
function doneItemsCount(ids) { return ids.filter(id => checkedCount(CHECKINS[id]) > 0).length; }
function renderTopbar() {
  if (!ME) return;
  $('hiChip').textContent = 'Hi, ' + nameOf(ME.uid) + ' 👋';
  $('countdownChip').textContent = fmtCountdown();
  const ids = checkableItems(), total = ids.length, done = doneItemsCount(ids);
  const pct = total ? Math.round(done / total * 100) : 0;
  $('progressFill').style.width = pct + '%';
  $('progressText').textContent = '全團行程完成度 ' + pct + '%（' + done + '/' + total + '）';
}

/* ===================== RENDER：行程 ===================== */
function badgeHtml(badges) {
  if (!badges) return '';
  return badges.map(b => b === 'res' ? '<span class="badge res">✅ 已訂位</span>' : '<span class="badge fav">💘</span>').join(' ');
}
function safeUrl(u) { return /^https?:\/\//i.test(u || '') ? u : '#'; }
function linksHtml(links) {
  if (!links || !links.length) return '';
  return '<div class="map-links">' + links.map(lk => '<a class="map-link" target="_blank" rel="noopener" href="' + esc(safeUrl(lk.u)) + '">📍 ' + esc(lk.l) + '</a>').join('') + '</div>';
}
function noteHtml(note) {
  if (!note) return '';
  return (Array.isArray(note) ? note : [note]).map(n => '<div class="item-note">📝 備註：' + esc(n) + '</div>').join('');
}
function renderComments(list, id) {
  if (!list || !list.length) return '';
  return '<div class="comments">' + list.map(c => {
    if (editingComments.has(c.id)) {
      return `<div class="comment-edit-row">
        <input type="text" value="${esc(c.text)}" data-edit-comment-input="${esc(c.id)}" maxlength="60">
        <button data-save-comment="${esc(c.id)}">儲存</button>
        <button data-cancel-comment="${esc(c.id)}" class="ghost">取消</button>
      </div>`;
    }
    const mine = c.by === ME.uid;
    return '<div class="comment-bubble"><b>' + esc(nameOf(c.by)) + '：</b>' + esc(c.text)
      + (mine ? ' <button class="mini-btn" data-edit-comment="' + esc(c.id) + '">✏️</button><button class="mini-btn" data-del-comment="' + esc(c.id) + '">🗑</button>' : '')
      + '</div>';
  }).join('') + '</div>';
}
function pipsHtml(rec) {
  // 全團小圓點：誰打勾誰亮（預設關閉，見 SHOW_ALL_PIPS）
  if (!SHOW_ALL_PIPS) return '';
  const by = (rec && rec.checkedBy) || {};
  return '<span class="member-pips">' + memberUids().filter(u => u !== ME.uid).map(u =>
    `<span class="pip ${by[u] ? 'checked' : ''}" title="${esc(nameOf(u))}">${by[u] ? '✓' : ''}</span>`).join('') + '</span>';
}
const SHOW_ALL_PIPS = false;

function renderDayList() {
  const wrap = $('dayList');
  wrap.innerHTML = DAYS.map(d => {
    const linkedIdx = d.items.map((it, idx) => it.links && it.links.length ? idx : -1).filter(i => i >= 0);
    const done = linkedIdx.filter(idx => checkedCount(CHECKINS[itemId(d.id, idx)]) > 0).length;
    const total = linkedIdx.length;

    const itemsHtml = d.items.map((it, idx) => {
      const id = itemId(d.id, idx);
      const hasLinks = it.links && it.links.length;
      const rec = CHECKINS[id] || { checkedBy: {} };
      const isChecked = !!(rec.checkedBy && rec.checkedBy[ME.uid]);
      const comments = COMMENTS[id] || [];
      const isCommentOpen = openComments.has(id);
      let actionHtml = '';
      if (hasLinks) {
        actionHtml = `
        <div class="action-row">
          <label class="pip self ${isChecked ? 'checked' : ''}" title="${esc(nameOf(ME.uid))}">
            <input type="checkbox" data-day="${esc(d.id)}" data-idx="${idx}" ${isChecked ? 'checked' : ''}/>
            <span class="mark">${isChecked ? '✓' : ''}</span>
          </label>
          ${pipsHtml(rec)}
          <button class="comment-toggle ${comments.length ? 'hasnew' : ''}" data-toggle-comment="${esc(id)}">💬${comments.length ? ' (' + comments.length + ')' : ''}</button>
        </div>
        <div class="comment-panel ${isCommentOpen ? 'open' : ''}" id="panel-${esc(id)}">
          ${renderComments(comments, id)}
          <div class="comment-form">
            <input type="text" placeholder="留言一句話..." data-comment-input="${esc(id)}" maxlength="60">
            <button data-send-comment="${esc(id)}">送出</button>
          </div>
        </div>`;
      }
      return `
      <div class="item ${checkedCount(rec) ? 'done' : ''}">
        <div class="item-top">
          ${it.time ? '<span class="time-chip">' + esc(it.time) + '</span>' : ''}
          <span class="item-title">${esc(it.title)}</span>
          ${badgeHtml(it.badge)}
        </div>
        ${noteHtml(it.note)}
        ${linksHtml(it.links)}
        ${actionHtml}
      </div>`;
    }).join('');

    const journalHtml = (JOURNAL[d.id] || []).map((j, i) => {
      if (editingJournal.has(j.id)) {
        return `<div class="sticky-note c${i % 3} editing">
          <textarea data-edit-journal-input="${esc(j.id)}" maxlength="80">${esc(j.text)}</textarea>
          <div class="sticky-actions">
            <button data-save-journal="${esc(j.id)}">儲存</button>
            <button data-cancel-journal="${esc(j.id)}" class="ghost">取消</button>
          </div>
        </div>`;
      }
      const mine = j.by === ME.uid;
      return '<div class="sticky-note c' + (i % 3) + '"><b>' + esc(nameOf(j.by)) + '</b>：' + esc(j.text)
        + (mine ? ' <button class="mini-btn" data-edit-journal="' + esc(j.id) + '">✏️</button><button class="mini-btn" data-del-journal="' + esc(j.id) + '">🗑</button>' : '')
        + '</div>';
    }).join('');
    const isOpen = openDays.has(d.id);
    const photos = PHOTOS[d.id];

    return `
    <div class="exp-card ${isOpen ? 'open' : ''}" id="card-${esc(d.id)}">
      <div class="exp-head" data-toggle="${esc(d.id)}">
        <div class="stamp" style="background:${stampColor(d.emoji)}">${dayArt(d.id)}</div>
        <div class="exp-head-info">
          <div class="dline1">${esc(d.short)}（${esc(d.wd)}） <span class="city-tag">${esc(d.city)}</span></div>
          <div class="dline2">${esc(d.cond)} ${esc(d.hi)}°/${esc(d.lo)}°${d.wnote ? ' · ' + esc(d.wnote) : ''} <span class="mini-progress">· ${done}/${total} 完成</span></div>
        </div>
        <div class="chevron">▾</div>
      </div>
      <div class="exp-body">
        <div class="route-list">${itemsHtml}</div>
        <div class="journal-box">
          <h4>💌 今日心得</h4>
          ${journalHtml}
          <div class="journal-form" style="margin-top:8px;">
            <textarea placeholder="留一句今天的心得..." data-journal="${esc(d.id)}" maxlength="80"></textarea>
            <button data-journal-send="${esc(d.id)}">送出</button>
          </div>
        </div>
        <div class="photo-box">
          <h4>📷 旅行照片牆</h4>
          <div class="photo-strip">
            ${photos === undefined && isOpen ? '<span class="photo-loading">載入中…</span>' : ''}
            ${(photos || []).map(p => `
              <div class="photo-thumb" data-open-photo="${esc(p.id)}" data-photo-day="${esc(d.id)}">
                <img src="${esc(p.data)}" alt="">
                <span class="pby">${esc(nameOf(p.by))}</span>
                ${p.by === ME.uid ? '<button class="pdel" data-del-photo="' + esc(p.id) + '">✕</button>' : ''}
              </div>`).join('')}
            <button class="photo-add-btn" data-photo-add="${esc(d.id)}">＋</button>
            <input type="file" accept="image/*" style="display:none" data-photo-input="${esc(d.id)}">
          </div>
        </div>
      </div>
    </div>`;
  }).join('');
  attachDayListeners();
}

function stampColor(emoji) {
  const colors = ['#E3F6F3', '#FDF0D9', '#FFE7EC', '#FDE7E2', '#E9F3E7'];
  let h = 0; for (const c of (emoji || '')) h += c.codePointAt(0);
  return colors[h % colors.length];
}

function renderRegions() {
  const wrap = $('regionList');
  wrap.innerHTML = REGIONS.map((r, ridx) => {
    const rid = 'r' + ridx;
    const placesHtml = r.places.map(p => `
      <div class="place-row">
        <div class="item-top">
          <span class="place-day">${esc(p.day)}</span>
          <span class="item-title">${esc(p.title)}</span>
          ${badgeHtml(p.badge)}
        </div>
        ${linksHtml(p.links)}
      </div>`).join('');
    return `
    <div class="exp-card ${openRegions.has(rid) ? 'open' : ''}" id="rcard-${rid}">
      <div class="exp-head" data-toggle-region="${rid}">
        <div class="stamp" style="background:${stampColor(r.emoji)}">${REGION_ART[ridx] || ''}</div>
        <div class="exp-head-info">
          <div class="dline1">${esc(r.name)}</div>
          <div class="dline2">共 ${r.places.length} 個地方</div>
        </div>
        <div class="chevron">▾</div>
      </div>
      <div class="exp-body"><div class="route-list">${placesHtml}</div></div>
    </div>`;
  }).join('');
  document.querySelectorAll('[data-toggle-region]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.toggleRegion;
      openRegions.has(id) ? openRegions.delete(id) : openRegions.add(id);
      renderRegions();
    });
  });
}

/* ---- 行程頁事件：全部只寫自己那一格 / 自己那一筆 ---- */
function attachDayListeners() {
  const on = (sel, ev, fn) => document.querySelectorAll(sel).forEach(el => el.addEventListener(ev, e => fn(el, e)));

  on('[data-toggle]', 'click', (el) => {
    const id = el.dataset.toggle;
    if (openDays.has(id)) openDays.delete(id); else { openDays.add(id); ensurePhotoListener(id); }
    renderDayList();
  });
  on('[data-toggle-comment]', 'click', (el, e) => {
    e.stopPropagation();
    const id = el.dataset.toggleComment;
    openComments.has(id) ? openComments.delete(id) : openComments.add(id);
    renderDayList();
  });
  on('input[type=checkbox][data-day]', 'click', (el, e) => e.stopPropagation());
  on('input[type=checkbox][data-day]', 'change', (el) => {
    const id = itemId(el.dataset.day, el.dataset.idx);
    toggleCheck('checkins', id, el.checked);
  });
  on('[data-send-comment]', 'click', (el, e) => {
    e.stopPropagation();
    const id = el.dataset.sendComment;
    const input = document.querySelector('input[data-comment-input="' + CSS.escape(id) + '"]');
    const text = input.value.trim().slice(0, 60);
    if (!text) return;
    input.value = ''; input.blur();
    openComments.add(id);
    fire(setDoc(doc(db, 'comments', newId('comments')), { itemId: id, by: ME.uid, text, ts: Date.now() }));
  });
  on('[data-journal-send]', 'click', (el, e) => {
    e.stopPropagation();
    const d = el.dataset.journalSend;
    const ta = document.querySelector('textarea[data-journal="' + CSS.escape(d) + '"]');
    const text = ta.value.trim().slice(0, 80);
    if (!text) return;
    ta.value = ''; ta.blur();
    fire(setDoc(doc(db, 'journal', newId('journal')), { dayId: d, by: ME.uid, text, ts: Date.now() }));
  });
  on('[data-edit-comment]', 'click', (el, e) => { e.stopPropagation(); editingComments.add(el.dataset.editComment); renderDayList(); });
  on('[data-cancel-comment]', 'click', (el, e) => { e.stopPropagation(); editingComments.delete(el.dataset.cancelComment); renderDayList(); });
  on('[data-save-comment]', 'click', (el, e) => {
    e.stopPropagation();
    const cId = el.dataset.saveComment;
    const text = document.querySelector('input[data-edit-comment-input="' + CSS.escape(cId) + '"]').value.trim().slice(0, 60);
    if (!text) return;
    editingComments.delete(cId);
    fire(updateDoc(doc(db, 'comments', cId), { text }));
    renderDayList();
  });
  on('[data-del-comment]', 'click', (el, e) => { e.stopPropagation(); fire(deleteDoc(doc(db, 'comments', el.dataset.delComment))); });
  on('[data-edit-journal]', 'click', (el, e) => { e.stopPropagation(); editingJournal.add(el.dataset.editJournal); renderDayList(); });
  on('[data-cancel-journal]', 'click', (el, e) => { e.stopPropagation(); editingJournal.delete(el.dataset.cancelJournal); renderDayList(); });
  on('[data-save-journal]', 'click', (el, e) => {
    e.stopPropagation();
    const jId = el.dataset.saveJournal;
    const text = document.querySelector('textarea[data-edit-journal-input="' + CSS.escape(jId) + '"]').value.trim().slice(0, 80);
    if (!text) return;
    editingJournal.delete(jId);
    fire(updateDoc(doc(db, 'journal', jId), { text }));
    renderDayList();
  });
  on('[data-del-journal]', 'click', (el, e) => { e.stopPropagation(); fire(deleteDoc(doc(db, 'journal', el.dataset.delJournal))); });
  on('.journal-box, .comment-panel, .exp-body', 'click', (el, e) => e.stopPropagation());

  on('[data-photo-add]', 'click', (el, e) => { e.stopPropagation(); document.querySelector('input[data-photo-input="' + CSS.escape(el.dataset.photoAdd) + '"]').click(); });
  on('input[data-photo-input]', 'click', (el, e) => e.stopPropagation());
  on('input[data-photo-input]', 'change', async (inp) => {
    const d = inp.dataset.photoInput;
    const file = inp.files && inp.files[0]; if (!file) return;
    inp.value = '';
    try {
      const dataUrl = await compressImage(file, 800, 0.6, 380000);
      ensurePhotoListener(d);
      fire(setDoc(doc(db, 'photos', newId('photos')), { dayId: d, by: ME.uid, data: dataUrl, ts: Date.now() }), '照片儲存失敗，換一張再試試看？');
    } catch (err) { toast('這張照片沒辦法上傳，換一張試試看？'); }
  });
  on('[data-open-photo]', 'click', (el, e) => {
    if (e.target.closest('.pdel')) return;
    e.stopPropagation();
    const p = (PHOTOS[el.dataset.photoDay] || []).find(x => x.id === el.dataset.openPhoto);
    if (p) openLightbox(p.data, nameOf(p.by));
  });
  on('[data-del-photo]', 'click', (el, e) => {
    e.stopPropagation();
    if (confirm('刪除這張照片？')) fire(deleteDoc(doc(db, 'photos', el.dataset.delPhoto)));
  });
}

/* 打勾 / 行前清單：只寫 checkedBy.{我的uid} */
function toggleCheck(col, id, checked) {
  const ref = doc(db, col, id);
  if (checked) fire(setDoc(ref, { checkedBy: { [ME.uid]: true } }, { merge: true }));
  else fire(updateDoc(ref, { ['checkedBy.' + ME.uid]: deleteField() }));
}

/* ===================== 圖片壓縮 ===================== */
function compressImage(file, maxDim, quality, maxBytes) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read fail'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('img fail'));
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > h && w > maxDim) { h = Math.round(h * maxDim / w); w = maxDim; }
        else if (h > maxDim) { w = Math.round(w * maxDim / h); h = maxDim; }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        let q = quality, out = canvas.toDataURL('image/jpeg', q);
        // 超過上限就降品質，最多降到 0.3
        while (maxBytes && out.length > maxBytes && q > 0.3) { q -= 0.1; out = canvas.toDataURL('image/jpeg', q); }
        if (maxBytes && out.length > maxBytes) return reject(new Error('too large'));
        resolve(out);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
function openLightbox(src, by) {
  $('lbImg').src = src;
  $('lbCaption').textContent = by ? by + ' 拍的' : '';
  $('lightbox').classList.add('open');
}
function closeLightbox() { $('lightbox').classList.remove('open'); $('lbImg').src = ''; }

/* ===================== 重要資訊 ===================== */
function renderInfo() {
  const wrap = $('infoList');
  wrap.innerHTML = INFO_SECTIONS.map(s => `
    <div class="info-card">
      <h3>${esc(s.icon)} ${esc(s.title)}</h3>
      <p>${bodyHtml(s.body)}</p>
      ${s.map ? '<div class="map-links"><a class="map-link" target="_blank" rel="noopener" href="' + esc(safeUrl(s.map)) + '">📍 開啟地圖</a></div>' : ''}
      <textarea placeholder="補充備註（大家共用）..." data-info="${esc(s.key)}" maxlength="2000">${esc(NOTES[s.key] || '')}</textarea>
    </div>`).join('');
  document.querySelectorAll('[data-info]').forEach(ta => {
    let t;
    ta.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        fire(setDoc(doc(db, 'notes', ta.dataset.info), { text: ta.value.slice(0, 2000), updatedBy: ME.uid, ts: Date.now() }));
      }, 600);
    });
  });
}
// 資訊內文只允許 <br>，其他一律 escape
function bodyHtml(s) { return esc(s).replace(/&lt;br&gt;/g, '<br>'); }

/* ===================== 行前清單 / 個人清單 ===================== */
function renderChecklist() {
  const wrap = $('checklistList');
  wrap.innerHTML = CHECKLIST_DEFAULT.map((label, idx) => {
    const rec = PRETRIP[String(idx)] || { checkedBy: {} };
    const isChecked = !!(rec.checkedBy && rec.checkedBy[ME.uid]);
    return `
    <div class="checklist-item ${isChecked ? 'checked' : ''}">
      <label class="pip self ${isChecked ? 'checked' : ''}">
        <input type="checkbox" data-pretrip="${idx}" ${isChecked ? 'checked' : ''}/>
        <span class="mark">${isChecked ? '✓' : ''}</span>
      </label>
      <span class="ci-label">${esc(label)}</span>
    </div>`;
  }).join('');
  document.querySelectorAll('input[type=checkbox][data-pretrip]').forEach(el => {
    el.addEventListener('change', () => toggleCheck('pretrip', String(el.dataset.pretrip), el.checked));
  });
}
function personalKey() { return 'personal_extra:' + (ME ? ME.uid : 'anon'); }
function loadPersonal() { try { return JSON.parse(localStorage.getItem(personalKey()) || '[]'); } catch (e) { return []; } }
function savePersonal() { try { localStorage.setItem(personalKey(), JSON.stringify(PERSONAL)); } catch (e) { } }
function renderPersonal() {
  const wrap = $('personalList');
  if (!PERSONAL.length) { wrap.innerHTML = '<p style="color:var(--ink-soft);font-size:13px;margin:0 0 4px;">目前還沒有項目，在下面新增你自己要準備的東西吧！</p>'; return; }
  wrap.innerHTML = PERSONAL.map((it, idx) => `
    <div class="checklist-item ${it.checked ? 'checked' : ''}">
      <label class="pip self ${it.checked ? 'checked' : ''}">
        <input type="checkbox" data-personal="${idx}" ${it.checked ? 'checked' : ''}/>
        <span class="mark">${it.checked ? '✓' : ''}</span>
      </label>
      <span class="ci-label">${esc(it.text)}</span>
      <button class="del" data-personal-del="${idx}">✕</button>
    </div>`).join('');
  document.querySelectorAll('[data-personal]').forEach(el => el.addEventListener('change', () => { PERSONAL[el.dataset.personal].checked = el.checked; savePersonal(); renderPersonal(); }));
  document.querySelectorAll('[data-personal-del]').forEach(el => el.addEventListener('click', () => { PERSONAL.splice(el.dataset.personalDel, 1); savePersonal(); renderPersonal(); }));
}
function addPersonalItem() {
  const input = $('personalInput');
  const text = input.value.trim(); if (!text) return;
  PERSONAL.push({ text, checked: false }); savePersonal();
  input.value = ''; renderPersonal();
}

function renderGuide() {
  $('guideList').innerHTML = GUIDE_ITEMS.map(g => `
    <div class="guide-item">
      <div class="gi">${esc(g.icon)}</div>
      <div><h4>${esc(g.title)}</h4><p>${esc(g.text)}</p></div>
    </div>`).join('');
}

/* ===================== 團員 ===================== */
function renderMembers() {
  const uids = memberUids();
  $('memberBanner').textContent = '目前已經有 ' + uids.length + ' 位團員上車 🚗';
  const ids = checkableItems();
  $('memberList').innerHTML = uids.map(uid => {
    const m = MEMBERS[uid];
    const cnt = ids.filter(id => CHECKINS[id] && CHECKINS[id].checkedBy && CHECKINS[id].checkedBy[uid]).length;
    const isSelf = uid === ME.uid;
    return `
    <div class="member-row">
      <div class="member-avatar" ${m.avatar ? 'data-open-avatar="' + esc(uid) + '"' : ''}>${m.avatar ? '<img src="' + esc(m.avatar) + '" alt="">' : esc((m.name || '?')[0])}</div>
      <div class="member-name">${esc(m.name)}${isSelf ? ' (你)' : ''}</div>
      <div class="member-meta">已完成 ${cnt} 個景點</div>
      ${isSelf ? '<button class="avatar-edit-btn" id="selfAvatarBtn" title="換大頭貼">📷</button><input type="file" accept="image/*" style="display:none" id="selfAvatarInput"><button class="avatar-edit-btn" id="selfRenameBtn" title="改暱稱">✏️</button><button class="member-del-btn" id="selfLeaveBtn" title="退出">🚪</button>' : ''}
    </div>`;
  }).join('');

  document.querySelectorAll('[data-open-avatar]').forEach(el => el.addEventListener('click', () => {
    const m = MEMBERS[el.dataset.openAvatar]; if (m && m.avatar) openLightbox(m.avatar, m.name);
  }));
  const selfBtn = $('selfAvatarBtn');
  if (selfBtn) {
    selfBtn.addEventListener('click', () => $('selfAvatarInput').click());
    $('selfAvatarInput').addEventListener('change', async (e) => {
      const file = e.target.files[0]; if (!file) return; e.target.value = '';
      try { const dataUrl = await compressImage(file, 300, 0.7, 60000); fire(updateDoc(doc(db, 'members', ME.uid), { avatar: dataUrl })); }
      catch (err) { toast('這張照片沒辦法用，換一張試試看？'); }
    });
    $('selfRenameBtn').addEventListener('click', () => {
      const v = prompt('新的暱稱（最多 12 字）', nameOf(ME.uid));
      if (v && v.trim()) fire(updateDoc(doc(db, 'members', ME.uid), { name: v.trim().slice(0, 12) }));
    });
    $('selfLeaveBtn').addEventListener('click', () => {
      if (confirm('確定要退出團員名單嗎？你的留言、照片和帳目會保留，但名字會顯示為「已離開」。')) {
        fire(deleteDoc(doc(db, 'members', ME.uid)));
        setTimeout(logout, 500);
      }
    });
  }
}

/* ===================== 分帳 ===================== */
function ntdOf(exp) { return exp.currency === 'USD' ? Math.round(exp.amount * (exp.rate || 1)) : Math.round(exp.amount); }
function computeSettlement() {
  const net = {};
  memberUids().forEach(u => { net[u] = 0; });
  EXPENSES.forEach(exp => {
    const total = ntdOf(exp);
    const parts = exp.participants && exp.participants.length ? exp.participants : memberUids();
    if (!parts.length) return;
    const share = total / parts.length;
    net[exp.payer] = (net[exp.payer] || 0) + total;
    parts.forEach(p => { net[p] = (net[p] || 0) - share; });
  });
  return net;
}
function simplifyDebts(net) {
  const eps = 1;
  const creditors = Object.entries(net).filter(([, v]) => v > eps).map(([n, v]) => ({ n, v })).sort((a, b) => b.v - a.v);
  const debtors = Object.entries(net).filter(([, v]) => v < -eps).map(([n, v]) => ({ n, v: -v })).sort((a, b) => b.v - a.v);
  const txs = []; let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].v, creditors[j].v);
    if (pay > eps) txs.push({ from: debtors[i].n, to: creditors[j].n, amount: Math.round(pay) });
    debtors[i].v -= pay; creditors[j].v -= pay;
    if (debtors[i].v <= eps) i++;
    if (creditors[j].v <= eps) j++;
  }
  return txs;
}
function renderSettlement() {
  const net = computeSettlement(), txs = simplifyDebts(net);
  const wrap = $('settleModalContent');
  if (!EXPENSES.length) { wrap.innerHTML = '<h3>💵 目前結算（台幣）</h3><p class="settle-empty">還沒有花費紀錄，新增第一筆支出看看吧！</p>'; return; }
  const balHtml = Object.keys(net).map(u => {
    const v = Math.round(net[u] || 0);
    const cls = v > 0 ? 'settle-pos' : v < 0 ? 'settle-neg' : '';
    const label = v > 0 ? '應收回 NT$' + v : v < 0 ? '應付出 NT$' + Math.abs(v) : '已結清';
    return '<div class="settle-row"><span>' + esc(nameOf(u)) + '</span><b class="' + cls + '">' + label + '</b></div>';
  }).join('');
  const txHtml = txs.length
    ? txs.map(t => '<div class="settle-tx">💸 <b>' + esc(nameOf(t.from)) + '</b> 該付給 <b>' + esc(nameOf(t.to)) + '</b> <b>NT$ ' + t.amount + '</b></div>').join('')
    : '<p class="settle-empty">目前大家都平了，不用轉帳🎉</p>';
  wrap.innerHTML = '<h3>💵 目前結算（台幣）</h3>' + balHtml + '<div style="margin-top:10px;padding-top:10px;border-top:2px solid var(--line);"><b style="font-size:13px;">建議轉帳</b>' + txHtml + '</div>';
}
function renderExpenseList() {
  const wrap = $('expenseList');
  if (!EXPENSES.length) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = EXPENSES.slice().sort((a, b) => b.ts - a.ts).map(exp => {
    const ntd = ntdOf(exp);
    const amtLabel = exp.currency === 'USD' ? ('US$ ' + exp.amount + ' ≈ NT$ ' + ntd) : ('NT$ ' + exp.amount);
    const parts = exp.participants && exp.participants.length ? exp.participants : memberUids();
    const mine = exp.by === ME.uid;
    return `
    <div class="expense-row">
      <div class="etop"><span class="etitle">${esc(exp.desc)}</span><span class="eamt">${esc(amtLabel)}</span></div>
      <div class="emeta">${esc(nameOf(exp.payer))} 先付的 · 分攤：${parts.map(u => esc(nameOf(u))).join('、')}${exp.note ? ' · ' + esc(exp.note) : ''}</div>
      ${exp.receipt ? '<div class="ereceipt"><button data-view-receipt="' + esc(exp.id) + '">🧾 查看收據</button></div>' : ''}
      ${mine ? '<div class="eactions"><button data-edit-expense="' + esc(exp.id) + '">✏️ 編輯</button><button data-del-expense="' + esc(exp.id) + '">🗑 刪除</button></div>' : ''}
    </div>`;
  }).join('');
  document.querySelectorAll('[data-edit-expense]').forEach(btn => btn.addEventListener('click', () => {
    editingExpenseId = btn.dataset.editExpense;
    const exp = EXPENSES.find(x => x.id === editingExpenseId);
    expenseParticipants = new Set(exp && exp.participants && exp.participants.length ? exp.participants : memberUids());
    pendingReceipt = exp ? (exp.receipt || null) : null;
    renderExpenseForm();
    $('expDesc').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
  document.querySelectorAll('[data-del-expense]').forEach(btn => btn.addEventListener('click', () => {
    if (!confirm('刪除這筆支出？')) return;
    fire(deleteDoc(doc(db, 'expenses', btn.dataset.delExpense)));
    if (editingExpenseId === btn.dataset.delExpense) { editingExpenseId = null; renderExpenseForm(); }
  }));
  document.querySelectorAll('[data-view-receipt]').forEach(btn => btn.addEventListener('click', () => {
    const exp = EXPENSES.find(x => x.id === btn.dataset.viewReceipt);
    if (exp && exp.receipt) openLightbox(exp.receipt, exp.desc + ' 的收據');
  }));
}
/* 表單只在「成員變動 / 開始或取消編輯 / 送出後」重畫，不會被別人的寫入洗掉 */
function renderExpenseForm() {
  const editing = editingExpenseId ? EXPENSES.find(x => x.id === editingExpenseId) : null;
  const currency = editing ? editing.currency : 'USD';
  const wrap = $('expenseForm');
  const uids = memberUids();
  const memberChips = uids.map(u => '<button type="button" class="exp-chip ' + (expenseParticipants.has(u) ? 'on' : '') + '" data-exp-chip="' + esc(u) + '">' + esc(nameOf(u)) + '</button>').join('');
  const payerOptions = uids.map(u => {
    const sel = editing ? (editing.payer === u) : (u === ME.uid);
    return '<option value="' + esc(u) + '" ' + (sel ? 'selected' : '') + '>' + esc(nameOf(u)) + '</option>';
  }).join('');
  wrap.innerHTML = `
    <div class="exp-form-row"><input type="text" id="expDesc" placeholder="項目（例如：租車油錢）" maxlength="40" value="${editing ? esc(editing.desc) : ''}"></div>
    <div class="exp-form-row">
      <input type="number" id="expAmount" placeholder="金額" value="${editing ? esc(editing.amount) : ''}" min="0" step="0.01">
      <select id="expCurrency">
        <option value="USD" ${currency === 'USD' ? 'selected' : ''}>USD 美金</option>
        <option value="NTD" ${currency === 'NTD' ? 'selected' : ''}>NTD 台幣</option>
      </select>
    </div>
    <div class="exp-form-row" id="expRateRow" style="${currency === 'USD' ? '' : 'display:none;'}">
      <input type="number" id="expRate" placeholder="匯率（1 USD = ? NTD）" value="${editing && editing.rate ? esc(editing.rate) : (lastRate() || '')}" min="0" step="0.01">
    </div>
    <div class="exp-form-row">
      <select id="expPayer">${payerOptions}</select>
      <input type="text" id="expNote" placeholder="備註（可留空）" maxlength="60" value="${editing && editing.note ? esc(editing.note) : ''}">
    </div>
    <div class="exp-hint">👉 點選要分攤的人：</div>
    <div class="exp-participants">${memberChips}</div>
    <div class="receipt-row" id="expReceiptRow">
      <button type="button" class="receipt-btn" id="expReceiptBtn">${pendingReceipt ? '🧾 已附上收據（點擊更換）' : '🧾 上傳收據（選填）'}</button>
      <input type="file" accept="image/*" style="display:none" id="expReceiptInput">
      ${pendingReceipt ? '<button type="button" class="receipt-clear" id="expReceiptClear">移除</button>' : ''}
    </div>
    <div class="exp-submit-row">
      <button id="expSubmitBtn">${editing ? '儲存' : '新增'}</button>
      ${editing ? '<button type="button" class="cancel-edit" id="expCancelBtn">取消編輯</button>' : ''}
    </div>`;

  $('expCurrency').addEventListener('change', (e) => { $('expRateRow').style.display = e.target.value === 'USD' ? '' : 'none'; });
  document.querySelectorAll('[data-exp-chip]').forEach(chip => chip.addEventListener('click', () => {
    const u = chip.dataset.expChip;
    expenseParticipants.has(u) ? expenseParticipants.delete(u) : expenseParticipants.add(u);
    chip.classList.toggle('on');
  }));
  $('expReceiptBtn').addEventListener('click', () => $('expReceiptInput').click());
  $('expReceiptInput').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return; e.target.value = '';
    try { pendingReceipt = await compressImage(file, 900, 0.6, 380000); updateReceiptUI(); }
    catch (err) { toast('這張收據沒辦法上傳，換一張試試看？'); }
  });
  const clearBtn0 = $('expReceiptClear');
  if (clearBtn0) clearBtn0.addEventListener('click', () => { pendingReceipt = null; updateReceiptUI(); });
  $('expSubmitBtn').addEventListener('click', submitExpense);
  const cancelBtn = $('expCancelBtn');
  if (cancelBtn) cancelBtn.addEventListener('click', () => { editingExpenseId = null; pendingReceipt = null; expenseParticipants = new Set(memberUids()); renderExpenseForm(); });
}
function lastRate() { const e = EXPENSES.filter(x => x.currency === 'USD' && x.rate).sort((a, b) => b.ts - a.ts)[0]; return e ? e.rate : ''; }
function updateReceiptUI() {
  const btn = $('expReceiptBtn');
  if (btn) btn.textContent = pendingReceipt ? '🧾 已附上收據（點擊更換）' : '🧾 上傳收據（選填）';
  const row = $('expReceiptRow');
  let clearBtn = $('expReceiptClear');
  if (pendingReceipt && !clearBtn && row) {
    clearBtn = document.createElement('button');
    clearBtn.type = 'button'; clearBtn.id = 'expReceiptClear'; clearBtn.className = 'receipt-clear'; clearBtn.textContent = '移除';
    clearBtn.addEventListener('click', () => { pendingReceipt = null; updateReceiptUI(); });
    row.appendChild(clearBtn);
  } else if (!pendingReceipt && clearBtn) clearBtn.remove();
}
function submitExpense() {
  const desc = $('expDesc').value.trim().slice(0, 40);
  const amount = parseFloat($('expAmount').value);
  const currency = $('expCurrency').value;
  const rate = currency === 'USD' ? parseFloat($('expRate').value) : null;
  const payer = $('expPayer').value;
  const note = $('expNote').value.trim().slice(0, 60) || null;
  const participants = Array.from(expenseParticipants).filter(u => MEMBERS[u]);

  if (!desc || !amount || amount <= 0) { toast('請填寫項目跟金額'); return; }
  if (currency === 'USD' && (!rate || rate <= 0)) { toast('美金記得要填匯率喔'); return; }
  if (!participants.length) { toast('至少要有一個人分攤'); return; }
  if (!payer || !MEMBERS[payer]) { toast('請選擇付款人'); return; }

  const data = { desc, amount, currency, rate, payer, note, participants, receipt: pendingReceipt };
  const existing = editingExpenseId ? EXPENSES.find(x => x.id === editingExpenseId) : null;
  if (editingExpenseId && existing) {
    fire(updateDoc(doc(db, 'expenses', editingExpenseId), data));
  } else {
    if (editingExpenseId) toast('這筆支出剛好被刪除了，幫你改成新增一筆');
    fire(setDoc(doc(db, 'expenses', newId('expenses')), { ...data, by: ME.uid, ts: Date.now() }));
  }
  editingExpenseId = null; pendingReceipt = null;
  expenseParticipants = new Set(memberUids());
  document.activeElement && document.activeElement.blur();
  renderExpenseForm();
}

/* ===================== 回顧 ===================== */
function renderRecap() {
  const wrap = $('recapContent');
  const totalPhotos = Object.values(PHOTOS).reduce((s, arr) => s + (arr ? arr.length : 0), 0);
  const totalJournal = Object.values(JOURNAL).reduce((s, arr) => s + (arr ? arr.length : 0), 0);
  const ids = checkableItems();
  const totalDone = doneItemsCount(ids);
  const totalSpend = EXPENSES.reduce((s, e) => s + ntdOf(e), 0);
  const board = memberUids().map(u => ({ name: nameOf(u), cnt: ids.filter(id => CHECKINS[id] && CHECKINS[id].checkedBy && CHECKINS[id].checkedBy[u]).length })).sort((a, b) => b.cnt - a.cnt);
  wrap.innerHTML = `
    <div class="recap-grid">
      <div class="recap-stat"><div class="rnum">${totalDone}/${ids.length}</div><div class="rlabel">✅ 共同完成景點</div></div>
      <div class="recap-stat"><div class="rnum">${totalPhotos}</div><div class="rlabel">📷 已載入照片</div></div>
      <div class="recap-stat"><div class="rnum">${totalJournal}</div><div class="rlabel">💌 心得篇數</div></div>
      <div class="recap-stat"><div class="rnum">NT$${Math.round(totalSpend).toLocaleString()}</div><div class="rlabel">💰 總花費</div></div>
    </div>
    <div class="info-card">
      <h3>🏆 景點達成排行</h3>
      ${board.length ? board.map((b, i) => '<div class="recap-board-row"><span class="recap-rank">' + (i + 1) + '</span><span style="flex:1;font-weight:700;">' + esc(b.name) + '</span><span style="color:var(--ink-soft);font-size:12.5px;">' + b.cnt + ' 個景點</span></div>').join('') : '<p class="settle-empty">還沒有人打卡呢</p>'}
    </div>`;
}

/* ===================== 雜項 UI ===================== */
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    $(btn.dataset.view).classList.add('active');
    window.scrollTo(0, 0);
  }));
}
function initLightbox() {
  $('lbClose').addEventListener('click', closeLightbox);
  $('lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') closeLightbox(); });
}
function initSettleModal() {
  $('settleOpenBtn').addEventListener('click', () => $('settleModal').classList.add('open'));
  $('settleCloseBtn').addEventListener('click', () => $('settleModal').classList.remove('open'));
  $('settleModal').addEventListener('click', (e) => { if (e.target.id === 'settleModal') $('settleModal').classList.remove('open'); });
}
function initOfflineBanner() {
  const b = $('offlineBanner');
  const upd = () => { b.style.display = navigator.onLine ? 'none' : ''; };
  window.addEventListener('online', upd); window.addEventListener('offline', upd); upd();
}

/* ===================== BOOT ===================== */
$('loginBtn').addEventListener('click', login);
$('deniedLogoutBtn').addEventListener('click', logout);
initNickScreen();
