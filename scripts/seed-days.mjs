import { readFileSync } from 'node:fs';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
initializeApp({ credential: applicationDefault(), projectId: 'ron-usa-trip-2026' });
const uid = (await getAuth().getUserByEmail(process.env.IMPORT_EMAIL)).uid;
const days = JSON.parse(readFileSync('data/day_overrides.local.json', 'utf8'));
const db = getFirestore();
for (const [dayId, items] of Object.entries(days)) {
  await db.doc(`itinerary_days/${dayId}`).set({ items, updatedBy: uid, ts: Date.now() });
  console.log(` ✓ ${dayId}: ${items.length} items`);
}
process.exit(0);
