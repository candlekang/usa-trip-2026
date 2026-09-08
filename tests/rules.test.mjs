// Firestore Rules 單元測試 — 跑在 emulator 上
//   npm run test:rules
// 涵蓋：未登入 / 非白名單 / 白名單成員 / 本人 vs 他人 / 打勾只能動自己那格 / 欄位形狀

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import {
  doc, setDoc, getDoc, updateDoc, deleteDoc, collection, getDocs,
} from 'firebase/firestore';

const PROJECT = 'ustrip2026-rules-test';
const ALICE = { uid: 'alice-uid', email: 'alice@example.com' };
const BOB   = { uid: 'bob-uid',   email: 'bob@example.com' };
const EVE   = { uid: 'eve-uid',   email: 'eve@evil.example' }; // 不在白名單

let env;

function ctx(user, extra = {}) {
  return env.authenticatedContext(user.uid, { email: user.email, email_verified: true, ...extra }).firestore();
}
function anon() { return env.unauthenticatedContext().firestore(); }

before(async () => {
  const host = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
  env = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: {
      rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'),
      host: host[0], port: Number(host[1]),
    },
  });
});
after(async () => { await env.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  // 白名單 + 行程設定 由管理者（Rules 關閉）寫入
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    await setDoc(doc(db, 'allow', ALICE.email), {});
    await setDoc(doc(db, 'allow', BOB.email), {});
    await setDoc(doc(db, 'config', 'itinerary'), { days: [{ id: 'd1' }] });
    await setDoc(doc(db, 'members', ALICE.uid), { name: 'Alice', avatar: null, joinedAt: 1 });
  });
});

// ---------- 讀取門檻 ----------
test('未登入：任何 collection 都讀不到', async () => {
  const db = anon();
  await assertFails(getDoc(doc(db, 'config', 'itinerary')));
  await assertFails(getDocs(collection(db, 'members')));
  await assertFails(getDocs(collection(db, 'expenses')));
  await assertFails(getDoc(doc(db, 'allow', ALICE.email)));
});

test('登入但不在白名單：讀不到、也不能建立成員', async () => {
  const db = ctx(EVE);
  await assertFails(getDoc(doc(db, 'config', 'itinerary')));
  await assertFails(getDocs(collection(db, 'members')));
  await assertFails(setDoc(doc(db, 'members', EVE.uid), { name: 'Eve', avatar: null, joinedAt: 1 }));
});

test('白名單但 email 未驗證：拒絕', async () => {
  const db = env.authenticatedContext(ALICE.uid, { email: ALICE.email, email_verified: false }).firestore();
  await assertFails(getDoc(doc(db, 'config', 'itinerary')));
});

test('白名單成員：讀得到行程與成員，讀不到白名單本身', async () => {
  const db = ctx(ALICE);
  await assertSucceeds(getDoc(doc(db, 'config', 'itinerary')));
  await assertSucceeds(getDocs(collection(db, 'members')));
  await assertFails(getDoc(doc(db, 'allow', ALICE.email)));
  await assertFails(setDoc(doc(db, 'config', 'itinerary'), { days: [] }));
});

// ---------- 成員 ----------
test('成員：只能建立/修改/刪除自己的文件', async () => {
  const bob = ctx(BOB);
  await assertSucceeds(setDoc(doc(bob, 'members', BOB.uid), { name: 'Bob', avatar: null, joinedAt: 2 }));
  await assertFails(setDoc(doc(bob, 'members', ALICE.uid), { name: 'Hacked', avatar: null, joinedAt: 1 }));
  await assertFails(updateDoc(doc(bob, 'members', ALICE.uid), { name: 'Hacked' }));
  await assertFails(deleteDoc(doc(bob, 'members', ALICE.uid)));
  await assertSucceeds(updateDoc(doc(bob, 'members', BOB.uid), { name: 'Bobby' }));
  // 名字長度 / 多餘欄位 / 假的 avatar
  await assertFails(updateDoc(doc(bob, 'members', BOB.uid), { name: '' }));
  await assertFails(updateDoc(doc(bob, 'members', BOB.uid), { name: '1234567890123' }));
  await assertFails(updateDoc(doc(bob, 'members', BOB.uid), { role: 'admin' }));
  await assertFails(updateDoc(doc(bob, 'members', BOB.uid), { avatar: 'javascript:alert(1)' }));
  await assertSucceeds(updateDoc(doc(bob, 'members', BOB.uid), { avatar: 'data:image/jpeg;base64,AAAA' }));
  await assertSucceeds(deleteDoc(doc(bob, 'members', BOB.uid)));
});

// ---------- 打勾 ----------
test('打勾：只能動自己那一格，別人的格子動不了', async () => {
  const alice = ctx(ALICE), bob = ctx(BOB);
  await assertSucceeds(setDoc(doc(alice, 'checkins', 'd1-i0'), { checkedBy: { [ALICE.uid]: true } }));
  // Alice 想順便幫 Bob 打勾 → 拒
  await assertFails(setDoc(doc(alice, 'checkins', 'd1-i1'), { checkedBy: { [ALICE.uid]: true, [BOB.uid]: true } }));
  // Bob 加自己那格（merge）→ 過
  await assertSucceeds(setDoc(doc(bob, 'checkins', 'd1-i0'), { checkedBy: { [BOB.uid]: true } }, { merge: true }));
  // Bob 想拿掉 Alice 的勾 → 拒
  await assertFails(setDoc(doc(bob, 'checkins', 'd1-i0'), { checkedBy: { [BOB.uid]: true } }));
  await assertFails(updateDoc(doc(bob, 'checkins', 'd1-i0'), { [`checkedBy.${ALICE.uid}`]: false }));
  // Bob 取消自己的勾（刪自己的 key）→ 過
  const { deleteField } = await import('firebase/firestore');
  await assertSucceeds(updateDoc(doc(bob, 'checkins', 'd1-i0'), { [`checkedBy.${BOB.uid}`]: deleteField() }));
  // 多餘欄位 → 拒；整份刪除 → 拒
  await assertFails(setDoc(doc(bob, 'checkins', 'd1-i2'), { checkedBy: { [BOB.uid]: true }, extra: 1 }));
  await assertFails(deleteDoc(doc(alice, 'checkins', 'd1-i0')));
  // 行前清單同規則
  await assertSucceeds(setDoc(doc(alice, 'pretrip', '0'), { checkedBy: { [ALICE.uid]: true } }));
  await assertFails(setDoc(doc(bob, 'pretrip', '0'), { checkedBy: { [ALICE.uid]: false, [BOB.uid]: true } }));
});

// ---------- 留言 / 心得 ----------
test('留言：建立要 by=自己，只有本人能改文字或刪除', async () => {
  const alice = ctx(ALICE), bob = ctx(BOB);
  const ok = { itemId: 'd1-i0', by: ALICE.uid, text: 'hi', ts: 1 };
  await assertSucceeds(setDoc(doc(alice, 'comments', 'c1'), ok));
  await assertFails(setDoc(doc(alice, 'comments', 'c2'), { ...ok, by: BOB.uid }));          // 冒名
  await assertFails(setDoc(doc(alice, 'comments', 'c3'), { ...ok, text: '' }));             // 空字串
  await assertFails(setDoc(doc(alice, 'comments', 'c4'), { ...ok, text: 'x'.repeat(61) })); // 超長
  await assertFails(setDoc(doc(alice, 'comments', 'c5'), { ...ok, html: '<b>' }));         // 多餘欄位
  await assertFails(updateDoc(doc(bob, 'comments', 'c1'), { text: 'pwned' }));             // 他人改
  await assertFails(deleteDoc(doc(bob, 'comments', 'c1')));                                // 他人刪
  await assertFails(updateDoc(doc(alice, 'comments', 'c1'), { by: BOB.uid }));             // 轉讓
  await assertFails(updateDoc(doc(alice, 'comments', 'c1'), { itemId: 'd2-i0' }));         // 搬家
  await assertSucceeds(updateDoc(doc(alice, 'comments', 'c1'), { text: 'edited' }));
  await assertSucceeds(deleteDoc(doc(alice, 'comments', 'c1')));
});

test('心得：同留言規則，80 字上限', async () => {
  const alice = ctx(ALICE), bob = ctx(BOB);
  await assertSucceeds(setDoc(doc(alice, 'journal', 'j1'), { dayId: 'd1', by: ALICE.uid, text: 'good', ts: 1 }));
  await assertFails(setDoc(doc(alice, 'journal', 'j2'), { dayId: 'd1', by: ALICE.uid, text: 'x'.repeat(81), ts: 1 }));
  await assertFails(updateDoc(doc(bob, 'journal', 'j1'), { text: 'pwned' }));
  await assertFails(deleteDoc(doc(bob, 'journal', 'j1')));
});

// ---------- 照片 ----------
test('照片：只能上傳 data:image、有大小上限、只有本人能刪、不能改', async () => {
  const alice = ctx(ALICE), bob = ctx(BOB);
  const img = 'data:image/jpeg;base64,' + 'A'.repeat(1000);
  await assertSucceeds(setDoc(doc(alice, 'photos', 'p1'), { dayId: 'd1', by: ALICE.uid, data: img, ts: 1 }));
  await assertFails(setDoc(doc(alice, 'photos', 'p2'), { dayId: 'd1', by: ALICE.uid, data: 'https://evil/x.png', ts: 1 }));
  await assertFails(setDoc(doc(alice, 'photos', 'p3'), { dayId: 'd1', by: ALICE.uid, data: 'data:image/jpeg;base64,' + 'A'.repeat(400001), ts: 1 }));
  await assertFails(setDoc(doc(alice, 'photos', 'p4'), { dayId: 'd1', by: BOB.uid, data: img, ts: 1 }));
  await assertFails(updateDoc(doc(alice, 'photos', 'p1'), { dayId: 'd2' }));
  await assertFails(deleteDoc(doc(bob, 'photos', 'p1')));
  await assertSucceeds(deleteDoc(doc(alice, 'photos', 'p1')));
});

// ---------- 分帳 ----------
test('分帳：形狀檢查、只有建立者能改刪、ts 不可改', async () => {
  const alice = ctx(ALICE), bob = ctx(BOB);
  const base = { desc: '油錢', amount: 45, currency: 'USD', rate: 32.5, payer: ALICE.uid, note: null,
                 participants: [ALICE.uid, BOB.uid], receipt: null, by: ALICE.uid, ts: 100 };
  await assertSucceeds(setDoc(doc(alice, 'expenses', 'e1'), base));
  await assertFails(setDoc(doc(alice, 'expenses', 'e2'), { ...base, by: BOB.uid }));                 // 冒名
  await assertFails(setDoc(doc(alice, 'expenses', 'e3'), { ...base, amount: -5 }));                 // 負數
  await assertFails(setDoc(doc(alice, 'expenses', 'e4'), { ...base, amount: '45' }));               // 字串
  await assertFails(setDoc(doc(alice, 'expenses', 'e5'), { ...base, currency: 'JPY' }));            // 幣別
  await assertFails(setDoc(doc(alice, 'expenses', 'e6'), { ...base, rate: null }));                 // USD 無匯率
  await assertSucceeds(setDoc(doc(alice, 'expenses', 'e7'), { ...base, currency: 'NTD', rate: null, amount: 1200 }));
  await assertFails(setDoc(doc(alice, 'expenses', 'e8'), { ...base, participants: [] }));           // 無人分攤
  await assertFails(setDoc(doc(alice, 'expenses', 'e9'), { ...base, receipt: 'https://x' }));       // 收據非 data:image
  await assertFails(updateDoc(doc(bob, 'expenses', 'e1'), { amount: 1 }));                          // 他人改
  await assertFails(deleteDoc(doc(bob, 'expenses', 'e1')));                                         // 他人刪
  await assertFails(updateDoc(doc(alice, 'expenses', 'e1'), { ts: 999 }));                          // 改時間
  await assertFails(updateDoc(doc(alice, 'expenses', 'e1'), { by: BOB.uid }));                      // 轉讓
  await assertSucceeds(updateDoc(doc(alice, 'expenses', 'e1'), { amount: 50, note: '含小費' }));
  await assertSucceeds(deleteDoc(doc(alice, 'expenses', 'e1')));
});

// ---------- 共用備註 ----------
test('共用備註：成員可寫，updatedBy 必須是自己，長度上限', async () => {
  const alice = ctx(ALICE), eve = ctx(EVE);
  await assertSucceeds(setDoc(doc(alice, 'notes', 'car'), { text: '記得加油', updatedBy: ALICE.uid, ts: 1 }));
  await assertFails(setDoc(doc(alice, 'notes', 'car'), { text: 'x', updatedBy: BOB.uid, ts: 1 }));
  await assertFails(setDoc(doc(alice, 'notes', 'car'), { text: 'x'.repeat(2001), updatedBy: ALICE.uid, ts: 1 }));
  await assertFails(setDoc(doc(eve, 'notes', 'car'), { text: 'x', updatedBy: EVE.uid, ts: 1 }));
});

// ---------- 未定義路徑 ----------
test('未定義的 collection 一律拒絕', async () => {
  const alice = ctx(ALICE);
  await assertFails(setDoc(doc(alice, 'admin', 'x'), { a: 1 }));
  await assertFails(getDoc(doc(alice, 'secrets', 'x')));
});
