// 把某個白名單帳號標成旁觀者（分帳唯讀）：
//   VIEWER_EMAIL=<email> node scripts/set-viewer.mjs
// 會在 allow/{email} 寫 role=viewer，並把 uid/email 加進 config/viewers（前端用來排除分攤名單）
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
initializeApp({ credential: applicationDefault(), projectId: 'ron-usa-trip-2026' });
const email = (process.env.VIEWER_EMAIL || '').toLowerCase();
if (!email) { console.error('請設 VIEWER_EMAIL'); process.exit(1); }
const db = getFirestore();
await db.doc(`allow/${email}`).set({ role: 'viewer' }, { merge: true });
let uid = null;
try { uid = (await getAuth().getUserByEmail(email)).uid; } catch (e) { }
await db.doc('config/viewers').set({
  emails: FieldValue.arrayUnion(email),
  ...(uid ? { uids: FieldValue.arrayUnion(uid) } : {}),
}, { merge: true });
console.log(`viewer set: role 已寫入 allow；config/viewers emails+1${uid ? '、uids+1' : '（尚未登入，登入後要補跑一次帶 uid）'}`);
process.exit(0);
