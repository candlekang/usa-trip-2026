// 批次匯入貼圖：本機資料夾 → Firestore stickers collection
//   IMPORT_EMAIL=<你的登入 email> node scripts/import-stickers.mjs [資料夾]
//   （或 IMPORT_UID=<uid> 直接指定；FIRESTORE_EMULATOR_HOST 有設就寫 emulator）
// - 縮到 240px JPEG；超過 ~95KB 再降到 160px
// - doc id = 檔案內容 hash → 重跑不會重複，只會覆蓋同一份
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

const PROJECT = 'ron-usa-trip-2026';
const MAX_B64 = 130000;           // rules 上限 400000，留大空間
const folder = process.argv[2] || 'data/stickers';
// --id-from-source <dir>：doc id 改用 <dir> 裡同名（不含副檔名）原始檔的 hash
//   → 用去背版覆蓋原本的貼圖時，id 不變，已發的文和反應不會斷
const idxSrc = process.argv.indexOf('--id-from-source');
const idSourceDir = idxSrc > -1 ? process.argv[idxSrc + 1] : null;

initializeApp({ credential: applicationDefault(), projectId: PROJECT });
const db = getFirestore();

let uid = process.env.IMPORT_UID;
if (!uid) {
  const email = process.env.IMPORT_EMAIL;
  if (!email) { console.error('請設 IMPORT_EMAIL（你的登入 email）或 IMPORT_UID'); process.exit(1); }
  uid = (await getAuth().getUserByEmail(email)).uid;
}

const files = readdirSync(folder).filter(f => /\.(jpe?g|png|gif|webp)$/i.test(f)).sort();
if (!files.length) { console.error(`${folder} 裡沒有圖檔`); process.exit(1); }

const tmp = mkdtempSync(join(tmpdir(), 'stickers-'));
function toDataUrl(src, maxDim) {
  // webp/png（去背檔，已是小圖）直接内嵌，過 sips 轉 JPEG 會弄丟透明度
  if (/\.webp$/i.test(src)) return 'data:image/webp;base64,' + readFileSync(src).toString('base64');
  if (/\.png$/i.test(src)) return 'data:image/png;base64,' + readFileSync(src).toString('base64');
  const out = join(tmp, 'out.jpg');
  execSync(`sips -s format jpeg -s formatOptions 78 -Z ${maxDim} ${JSON.stringify(src)} --out ${JSON.stringify(out)}`, { stdio: 'ignore' });
  return 'data:image/jpeg;base64,' + readFileSync(out).toString('base64');
}
function idFor(src, f) {
  if (idSourceDir) {
    const base = f.replace(/\.[^.]+$/, '');
    for (const ext of ['.jpg', '.jpeg', '.png', '.gif', '.webp']) {
      const cand = join(idSourceDir, base + ext);
      try { return createHash('sha1').update(readFileSync(cand)).digest('hex').slice(0, 20); } catch (e) { }
    }
    throw new Error(`--id-from-source: ${idSourceDir} 裡找不到 ${base}.*`);
  }
  return createHash('sha1').update(readFileSync(src)).digest('hex').slice(0, 20);
}

const base = Date.now();
let n = 0, skipped = [];
for (const [i, f] of files.entries()) {
  const src = join(folder, f);
  let data = toDataUrl(src, 240);
  if (data.length > MAX_B64) data = toDataUrl(src, 160);
  if (data.length > MAX_B64) { skipped.push(f); continue; }
  const id = idFor(src, f);
  await db.doc(`stickers/${id}`).set({ by: uid, data, ts: base + i });   // ts 保序
  n++; console.log(`  ✓ ${f} → ${id} (${Math.round(data.length / 1024)}KB)`);
}
rmSync(tmp, { recursive: true, force: true });
const target = process.env.FIRESTORE_EMULATOR_HOST ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}` : `PROJECT ${PROJECT}`;
console.log(`[${target}] imported ${n}/${files.length} stickers as uid ${uid.slice(0, 6)}…`);
if (skipped.length) console.log('跳過（壓不進上限）:', skipped.join(', '));
process.exit(0);
