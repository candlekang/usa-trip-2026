// 一次性：把 index.html 的靜態資料抽成 data/itinerary.json（SVG art 留在 HTML）
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
const html = readFileSync('index.html', 'utf8');
const start = html.indexOf('const TRIP_START');
const end = html.indexOf('/* ===================== STORAGE');
const src = html.slice(start, end) + '\n;({TRIP_START,TRIP_END,DAYS,CHECKLIST_DEFAULT,INFO_SECTIONS,GUIDE_ITEMS,REGIONS,DAY_ART,DAY_ICONS})';
const d = vm.runInNewContext(src, {});
const regionArt = d.REGIONS.map(r => r.art);
const regions = d.REGIONS.map(({art, ...rest}) => rest);
// DAY_ART 有些指向 REGIONS[n].art（SVG 字串）→ 轉成 'region:n'
const dayArt = {};
for (const [k, v] of Object.entries(d.DAY_ART)) {
  const idx = regionArt.indexOf(v);
  dayArt[k] = idx >= 0 ? `region:${idx}` : v;
}
const out = {
  tripStart: d.TRIP_START.toISOString(), tripEnd: d.TRIP_END.toISOString(),
  days: d.DAYS, regions, info: d.INFO_SECTIONS, checklist: d.CHECKLIST_DEFAULT, guide: d.GUIDE_ITEMS,
};
writeFileSync('data/itinerary.json', JSON.stringify(out, null, 1));
writeFileSync('data/art.json', JSON.stringify({ regionArt, dayArt, dayIcons: d.DAY_ICONS }, null, 1));
console.log('days', out.days.length, 'regions', out.regions.length, 'info', out.info.length, 'checklist', out.checklist.length, 'guide', out.guide.length);
console.log('dayArt', JSON.stringify(dayArt));
console.log('itinerary.json bytes', JSON.stringify(out).length, '| art.json bytes', JSON.stringify({regionArt, dayIcons: d.DAY_ICONS}).length);
