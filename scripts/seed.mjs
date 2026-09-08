// 把 data/itinerary.local.json → Firestore config/itinerary，data/allow.local.txt → allow/{email}
//   npm run seed                 （寫入；FIRESTORE_EMULATOR_HOST 有設就寫 emulator）
//   npm run seed -- --export     （從 Firestore 匯出 itinerary 到本機）
//   npm run seed -- --allow-only （只寫白名單）
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT = 'ron-usa-trip-2026';
const args = new Set(process.argv.slice(2));
initializeApp({ credential: applicationDefault(), projectId: PROJECT });
const db = getFirestore();
const target = process.env.FIRESTORE_EMULATOR_HOST ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}` : `PROJECT ${PROJECT}`;

if (args.has('--export')) {
  const snap = await db.doc('config/itinerary').get();
  if (!snap.exists) { console.error('config/itinerary 不存在'); process.exit(1); }
  writeFileSync('data/itinerary.local.json', JSON.stringify(snap.data(), null, 1));
  console.log('exported → data/itinerary.local.json'); process.exit(0);
}

if (!args.has('--allow-only')) {
  const it = JSON.parse(readFileSync('data/itinerary.local.json', 'utf8'));
  await db.doc('config/itinerary').set(it);
  console.log(`[${target}] config/itinerary written: ${it.days.length} days, ${it.regions.length} regions`);
}

const allowFile = process.env.ALLOW_FILE || 'data/allow.local.txt';
if (existsSync(allowFile)) {
  const emails = readFileSync(allowFile, 'utf8').split('\n').map(s => s.trim().toLowerCase()).filter(s => s && !s.startsWith('#'));
  const batch = db.batch();
  for (const e of emails) batch.set(db.doc(`allow/${e}`), { addedAt: Date.now() });
  await batch.commit();
  console.log(`[${target}] allow: ${emails.length} emails written`);
} else {
  console.log('data/allow.local.txt 不存在，略過白名單');
}
process.exit(0);
