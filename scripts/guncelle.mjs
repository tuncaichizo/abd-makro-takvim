// Builds takvim.json: next 60 days of official US (Fed, BLS, BEA) and Turkish (TÜİK, TCMB) macro release dates.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'takvim.json');
const DAY = 86400000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- US Eastern wall time -> UTC (DST-aware via Intl) ----
const etFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
function etParts(ms) {
  const p = Object.fromEntries(etFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
}
// Try the candidate offsets and keep the one that maps back to the same wall time.
function etToUtc(y, mo, d, h, mi) {
  const base = Date.UTC(y, mo - 1, d, h, mi);
  for (const off of [4, 5]) {
    const t = base + off * 3600000;
    const p = etParts(t);
    if (p.y === y && p.mo === mo && p.d === d && p.h === h && p.mi === mi) return t;
  }
  return null; // nonexistent wall time
}
// ---- Europe/Istanbul wall time -> UTC (Intl-based, no hard-coded offset) ----
const istFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Istanbul', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
function istParts(ms) {
  const p = Object.fromEntries(istFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
}
// Wall time read as UTC, minus the zone's offset at that instant (found by round-trip, two passes).
function istToUtc(y, mo, d, h, mi) {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let t = wall;
  for (let i = 0; i < 2; i++) {
    const p = istParts(t);
    t += wall - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  }
  const p = istParts(t);
  return p.y === y && p.mo === mo && p.d === d && p.h === h && p.mi === mi ? t : null;
}
const istDate = (ms) => { const p = istParts(ms); return `${p.y}-${pad(p.mo)}-${pad(p.d)}`; };
const pad = (n) => String(n).padStart(2, '0');
const isoZ = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const etDate = (ms) => { const p = etParts(ms); return `${p.y}-${pad(p.mo)}-${pad(p.d)}`; };

if (process.argv.includes('--selftest')) {
  const eq = (a, b, m) => { if (a !== b) { console.error(`FAIL ${m}: ${a} != ${b}`); process.exit(1); } console.log(`ok ${m}: ${a}`); };
  eq(isoZ(etToUtc(2026, 7, 15, 8, 30)), '2026-07-15T12:30:00Z', 'ET 2026-07-15 08:30 (EDT)');
  eq(isoZ(etToUtc(2026, 12, 15, 8, 30)), '2026-12-15T13:30:00Z', 'ET 2026-12-15 08:30 (EST)');
  eq(isoZ(istToUtc(2026, 12, 3, 10, 0)), '2026-12-03T07:00:00Z', 'Istanbul 2026-12-03 10:00');
  eq(isoZ(istToUtc(2026, 12, 10, 14, 0)), '2026-12-10T11:00:00Z', 'Istanbul 2026-12-10 14:00');
  process.exit(0);
}

const UA = process.env.KAYNAK_UA;
if (!UA) { console.error('error: KAYNAK_UA is empty'); process.exit(1); }
const DRY = process.argv.includes('--dry');

// ---- HTTP with one retry (after 5 s) on 429/5xx/network error ----
async function getText(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (r.ok) return await r.text();
      if (!(r.status === 429 || r.status >= 500) || attempt) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      if (attempt || /^HTTP/.test(e.message)) throw e;
    }
    await sleep(5000);
  }
}

// ---- ICS helpers ----
function icsEvents(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const unfolded = [];
  for (const l of lines) {
    if (/^[ \t]/.test(l) && unfolded.length) unfolded[unfolded.length - 1] += l.slice(1);
    else unfolded.push(l);
  }
  const events = [];
  let cur = null;
  for (const l of unfolded) {
    if (l === 'BEGIN:VEVENT') cur = {};
    else if (l === 'END:VEVENT') { if (cur) events.push(cur); cur = null; }
    else if (cur) {
      const i = l.indexOf(':');
      if (i < 0) continue;
      const head = l.slice(0, i);
      const name = head.split(';')[0].toUpperCase();
      if (name === 'SUMMARY') cur.summary = l.slice(i + 1);
      else if (name === 'DTSTART') cur.dtstart = { params: head, value: l.slice(i + 1).trim() };
    }
  }
  return events;
}
const unescapeIcs = (s) => s.replace(/\\([,;\\nN])/g, (_, c) => (c === 'n' || c === 'N' ? ' ' : c));

// ---- Source 1: Fed ----
const FED_LINK = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
function parseFed(text) {
  const data = JSON.parse(text.replace(/^﻿/, ''));
  if (!Array.isArray(data.events)) throw new Error('no events[]');
  const out = [];
  for (const e of data.events) {
    if (e.type !== 'FOMC') continue;
    let olay, onem, prefix, kod;
    if (e.title === 'FOMC Meeting') { olay = 'FOMC faiz kararı'; onem = 'yuksek'; prefix = 'fomc'; kod = 'fomc'; }
    else if (e.title === 'FOMC Minutes') { olay = 'FOMC toplantı tutanakları'; onem = 'orta'; prefix = 'fomc-tutanak'; kod = 'fomc_tutanak'; }
    else continue;
    const mm = /^(\d{4})-(\d{2})$/.exec(e.month || '');
    const nums = String(e.days || '').match(/\d+/g);
    const tm = /^(\d{1,2}):(\d{2})\s*([ap])\.?m\.?$/i.exec(String(e.time || '').trim());
    if (!mm || !nums || !tm) continue; // never assume a time
    let h = +tm[1] % 12;
    if (tm[3].toLowerCase() === 'p') h += 12;
    const ms = etToUtc(+mm[1], +mm[2], +nums[nums.length - 1], h, +tm[2]);
    if (ms === null) continue;
    out.push({ id: `${prefix}-${etDate(ms)}`, kod, ulke: 'US', olay, kurum: 'Federal Rezerv (Fed)', tarih_utc: isoZ(ms), onem, kaynak_link: FED_LINK });
  }
  return out;
}

// ---- Source 2: BLS ----
const BLS = {
  'Consumer Price Index': ['cpi', 'ABD enflasyonu (TÜFE / CPI)', 'yuksek', 'https://www.bls.gov/schedule/news_release/cpi.htm'],
  'Producer Price Index': ['ppi', 'ABD üretici fiyatları (ÜFE / PPI)', 'orta', 'https://www.bls.gov/schedule/news_release/ppi.htm'],
  'Employment Situation': ['nfp', 'ABD tarım dışı istihdam ve işsizlik oranı', 'yuksek', 'https://www.bls.gov/schedule/news_release/empsit.htm'],
};
function parseBls(text) {
  const out = [];
  for (const e of icsEvents(text)) {
    const m = BLS[(e.summary || '').trim()];
    const d = e.dtstart && /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/.exec(e.dtstart.value);
    if (!m || !d) continue;
    const ms = etToUtc(+d[1], +d[2], +d[3], +d[4], +d[5]); // US-Eastern local time
    if (ms === null) continue;
    out.push({ id: `${m[0]}-${etDate(ms)}`, kod: m[0], ulke: 'US', olay: m[1], kurum: 'ABD Çalışma İstatistikleri Bürosu (BLS)', tarih_utc: isoZ(ms), onem: m[2], kaynak_link: m[3] });
  }
  return out;
}

// ---- Source 3: BEA ----
const TR_MONTHS = { January: 'Ocak', February: 'Şubat', March: 'Mart', April: 'Nisan', May: 'Mayıs', June: 'Haziran', July: 'Temmuz', August: 'Ağustos', September: 'Eylül', October: 'Ekim', November: 'Kasım', December: 'Aralık' };
const GDP = [
  ['GDP (Advance Estimate)', 'ABD GSYH, öncü tahmin', 'yuksek'],
  ['GDP (Second Estimate)', 'ABD GSYH, ikinci tahmin', 'orta'],
  ['GDP (Third Estimate)', 'ABD GSYH, üçüncü tahmin', 'orta'],
];
function parseBea(text) {
  const out = [];
  for (const e of icsEvents(text)) {
    if (!e.summary || !e.dtstart) continue;
    const s = unescapeIcs(e.summary).trim();
    const d = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?Z$/.exec(e.dtstart.value);
    if (!d) continue;
    const ms = Date.UTC(+d[1], +d[2] - 1, +d[3], +d[4], +d[5], +(d[6] || 0));
    let kod, olay, onem;
    const g = GDP.find(([p]) => s.startsWith(p));
    if (g) {
      kod = 'gdp'; olay = g[1]; onem = g[2];
      const q = /(\d)(?:st|nd|rd|th) Quarter(?: and Year)? (\d{4})/.exec(s);
      if (q) olay += ` (${q[2]} ${q[1]}. çeyrek)`;
    } else if (s.startsWith('Personal Income and Outlays')) {
      kod = 'pce'; onem = 'yuksek'; olay = 'ABD kişisel gelir ve harcamalar (PCE)';
      const pm = /^Personal Income and Outlays,\s*([A-Za-z]+)\s+(\d{4})/.exec(s);
      if (pm && TR_MONTHS[pm[1]]) olay += ` - ${TR_MONTHS[pm[1]]} ${pm[2]}`;
    } else continue;
    out.push({ id: `${kod}-${etDate(ms)}`, kod, ulke: 'US', olay, kurum: 'ABD Ekonomik Analiz Bürosu (BEA)', tarih_utc: isoZ(ms), onem, kaynak_link: 'https://www.bea.gov/news/schedule' });
  }
  return out;
}

// ---- Source 4: TÜİK (official release calendar JSON) ----
const TUIK_LINK = 'https://www.tuik.gov.tr/Kurumsal/Veri_Takvimi';
const TUIK = {
  'Tüketici Fiyat Endeksi (TÜFE)': ['tufe', 'Türkiye enflasyonu (TÜFE)', 'yuksek'],
  'İşgücü İstatistikleri': ['issizlik_tr', 'Türkiye işgücü istatistikleri (işsizlik)', 'orta'],
  'Dönemsel Gayrisafi Yurt İçi Hasıla': ['gsyh_tr', 'Türkiye GSYH (çeyreklik)', 'orta'],
};
function parseTuik(texts) {
  const out = [];
  for (const text of texts) {
    const data = JSON.parse(text.replace(/^﻿/, ''));
    if (!Array.isArray(data.yayindaOlanlarList) || !Array.isArray(data.yayindaOlmayanlarList)) throw new Error('no list keys');
    for (const r of [...data.yayindaOlanlarList, ...data.yayindaOlmayanlarList]) {
      if (r.sorumluKisaAd !== 'TÜİK') continue;
      const m = TUIK[r.adi];
      const d = m && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(r.gTarih || ''));
      if (!d) continue; // no time part: never assume one
      const ms = istToUtc(+d[1], +d[2], +d[3], +d[4], +d[5]);
      if (ms === null) continue;
      const donem = String(r.donemi || '').trim();
      out.push({ id: `${m[0]}-${istDate(ms)}`, kod: m[0], ulke: 'TR', olay: donem ? `${m[1]} - ${donem}` : m[1], kurum: 'Türkiye İstatistik Kurumu (TÜİK)', tarih_utc: isoZ(ms), onem: m[2], kaynak_link: TUIK_LINK });
    }
  }
  return out;
}

// ---- Source 5: TCMB PPK decision dates (static HTML table) ----
const TCMB_LINK = 'https://www.tcmb.gov.tr/wps/wcm/connect/TR/TCMB+TR/Main+Menu/Duyurular/Takvim';
// Decision time per year, 14:00 Istanbul time: TCMB "2026 Para Politikası" text, item 13
// (https://www.tcmb.gov.tr/wps/wcm/connect/50433504-d77c-472a-82d0-6ad1cc25c927/2026_Para_Politikas%C4%B1_Metni.pdf?MOD=AJPERES).
// Add a year ONLY after reading that year's Para Politikası text; dates of other years are skipped.
const PPK_SAAT = { 2026: '14:00' };
const TR_AY = { ocak: 1, şubat: 2, mart: 3, nisan: 4, mayıs: 5, haziran: 6, temmuz: 7, ağustos: 8, eylül: 9, ekim: 10, kasım: 11, aralık: 12 };
function parsePpk(text) {
  const h2 = text.indexOf('PARA POLİTİKASI KURULU TOPLANTILARI VE RAPOR TAKVİMİ');
  if (h2 < 0) throw new Error('PPK heading not found');
  const end = text.indexOf('</table>', h2);
  const rows = text.slice(h2, end < 0 ? undefined : end).split(/<tr[\s>]/i).slice(1);
  const out = [];
  const skipped = new Set();
  for (const row of rows) {
    const cell = /<td[^>]*>([\s\S]*?)<\/td>/i.exec(row);
    if (!cell || /<h3/i.test(cell[1])) continue; // header row
    const m = /^(\d{1,2})\s+(\S+)\s+(\d{4})$/.exec(cell[1].replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim().toLocaleLowerCase('tr'));
    const mo = m && TR_AY[m[2]];
    if (!mo) continue;
    const saat = PPK_SAAT[+m[3]];
    if (!saat) { skipped.add(m[3]); continue; }
    const [hh, mi] = saat.split(':').map(Number);
    const ms = istToUtc(+m[3], mo, +m[1], hh, mi);
    if (ms === null) continue;
    out.push({ id: `ppk-${istDate(ms)}`, kod: 'ppk', ulke: 'TR', olay: 'TCMB faiz kararı (PPK)', kurum: 'Türkiye Cumhuriyet Merkez Bankası (TCMB)', tarih_utc: isoZ(ms), onem: 'yuksek', kaynak_link: TCMB_LINK });
  }
  for (const y of skipped) console.warn(`warning: PPK dates in ${y} skipped (no verified decision time for that year in PPK_SAAT)`);
  return out;
}

const SOURCES = [
  { name: 'Fed', url: 'https://www.federalreserve.gov/json/calendar.json', parse: parseFed, kods: ['fomc', 'fomc_tutanak'] },
  { name: 'BLS', url: 'https://www.bls.gov/schedule/news_release/bls.ics', parse: parseBls, kods: ['cpi', 'ppi', 'nfp'] },
  { name: 'BEA', url: 'https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics', parse: parseBea, kods: ['gdp', 'pce'] },
  { name: 'TUIK', url: (y) => [y, y + 1].map((k) => `https://www.tuik.gov.tr/Kurumsal/GetYillikHaberBulteniListesi?yil=${k}`), parse: parseTuik, kods: ['tufe', 'issizlik_tr', 'gsyh_tr'] },
  { name: 'TCMB', url: TCMB_LINK, parse: parsePpk, kods: ['ppk'] },
];

// ---- Main ----
const now = Date.now();
const winStart = Math.floor(now / DAY) * DAY;
const winEnd = now + 60 * DAY;
const inWindow = (e) => { const t = Date.parse(e.tarih_utc); return t >= winStart && t <= winEnd; };

const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { olaylar: [] };
const prevEvents = Array.isArray(prev.olaylar) ? prev.olaylar : [];

const all = [];
let okCount = 0;
for (let i = 0; i < SOURCES.length; i++) {
  const s = SOURCES[i];
  if (i) await sleep(1000);
  let events;
  try {
    const urls = typeof s.url === 'function' ? s.url(new Date().getUTCFullYear()) : [s.url];
    const texts = [];
    for (let j = 0; j < urls.length; j++) { if (j) await sleep(1000); texts.push(await getText(urls[j])); }
    const parsed = s.parse(urls.length > 1 ? texts : texts[0]);
    if (!parsed.length) throw new Error('0 matching events');
    events = parsed;
    okCount++;
  } catch (e) {
    console.warn(`warning: ${s.name} failed (${e.message}); keeping previous events`);
    events = prevEvents.filter((p) => s.kods.includes(p.kod));
  }
  all.push(...events.filter(inWindow));
}
if (!okCount) { console.error('error: all sources failed'); process.exit(1); }

const seen = new Set();
const olaylar = all
  .filter((e) => !seen.has(e.id) && seen.add(e.id))
  .sort((a, b) => (a.tarih_utc < b.tarih_utc ? -1 : a.tarih_utc > b.tarih_utc ? 1 : a.id < b.id ? -1 : 1));

if (DRY) {
  for (const e of olaylar) console.log(`${e.tarih_utc}  ${e.id.padEnd(26)} ${e.onem.padEnd(6)} ${e.olay}`);
  console.log(`${olaylar.length} events (dry run, nothing written)`);
} else if (JSON.stringify(olaylar) === JSON.stringify(prevEvents)) {
  console.log(`no change (${olaylar.length} events)`);
} else {
  writeFileSync(OUT, JSON.stringify({ guncellendi: new Date().toISOString(), olaylar }, null, 2) + '\n');
  console.log(`written: ${olaylar.length} events`);
}
