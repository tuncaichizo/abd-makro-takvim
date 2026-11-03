// Builds takvim.json: next 60 days of official US macro release dates (Fed, BLS, BEA).
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
const pad = (n) => String(n).padStart(2, '0');
const isoZ = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const etDate = (ms) => { const p = etParts(ms); return `${p.y}-${pad(p.mo)}-${pad(p.d)}`; };

if (process.argv.includes('--selftest')) {
  const eq = (a, b, m) => { if (a !== b) { console.error(`FAIL ${m}: ${a} != ${b}`); process.exit(1); } console.log(`ok ${m}: ${a}`); };
  eq(isoZ(etToUtc(2026, 7, 15, 8, 30)), '2026-07-15T12:30:00Z', 'ET 2026-07-15 08:30 (EDT)');
  eq(isoZ(etToUtc(2026, 12, 15, 8, 30)), '2026-12-15T13:30:00Z', 'ET 2026-12-15 08:30 (EST)');
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
    let olay, onem, prefix;
    if (e.title === 'FOMC Meeting') { olay = 'FOMC faiz kararı'; onem = 'yuksek'; prefix = 'fomc'; }
    else if (e.title === 'FOMC Minutes') { olay = 'FOMC toplantı tutanakları'; onem = 'orta'; prefix = 'fomc-tutanak'; }
    else continue;
    const mm = /^(\d{4})-(\d{2})$/.exec(e.month || '');
    const nums = String(e.days || '').match(/\d+/g);
    const tm = /^(\d{1,2}):(\d{2})\s*([ap])\.?m\.?$/i.exec(String(e.time || '').trim());
    if (!mm || !nums || !tm) continue; // never assume a time
    let h = +tm[1] % 12;
    if (tm[3].toLowerCase() === 'p') h += 12;
    const ms = etToUtc(+mm[1], +mm[2], +nums[nums.length - 1], h, +tm[2]);
    if (ms === null) continue;
    out.push({ id: `${prefix}-${etDate(ms)}`, kod: 'fomc', ulke: 'US', olay, kurum: 'Federal Rezerv (Fed)', tarih_utc: isoZ(ms), onem, kaynak_link: FED_LINK });
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

const SOURCES = [
  { name: 'Fed', url: 'https://www.federalreserve.gov/json/calendar.json', parse: parseFed, kods: ['fomc'] },
  { name: 'BLS', url: 'https://www.bls.gov/schedule/news_release/bls.ics', parse: parseBls, kods: ['cpi', 'ppi', 'nfp'] },
  { name: 'BEA', url: 'https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics', parse: parseBea, kods: ['gdp', 'pce'] },
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
    const parsed = s.parse(await getText(s.url));
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
