# ABD makro veri takvimi

ABD ve Türkiye makro veri takvimi (FOMC, TÜFE/CPI, ÜFE/PPI, istihdam, GSYH, PCE, TCMB PPK, TÜİK TÜFE/işsizlik/GSYH): önümüzdeki 60 gün, resmî kaynaklardan, JSON.

- Sources (US): Federal Reserve calendar JSON, BLS release schedule (ICS), BEA release schedule (ICS):
  `https://www.federalreserve.gov/json/calendar.json`,
  `https://www.bls.gov/schedule/news_release/bls.ics`,
  `https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics`.
- Sources (TR): TÜİK official release calendar JSON (current and next year) and the TCMB calendar page (PPK decision dates):
  `https://www.tuik.gov.tr/Kurumsal/GetYillikHaberBulteniListesi?yil=<YYYY>`,
  `https://www.tcmb.gov.tr/wps/wcm/connect/TR/TCMB+TR/Main+Menu/Duyurular/Takvim`.
- A GitHub Action refreshes `takvim.json` daily (05:17 UTC) and commits only when the events change.
- Schema: `{ "guncellendi": ISO time, "olaylar": [ { "id", "kod", "ulke", "olay", "kurum", "tarih_utc", "onem", "kaynak_link" } ] }`.
- `ulke` is `US` or `TR`; `kod` is one of `fomc | fomc_tutanak | cpi | ppi | nfp | gdp | pce | tufe | ppk | issizlik_tr | gsyh_tr` (`fomc` = rate decision, `fomc_tutanak` = minutes; `tufe` = TÜİK CPI, `ppk` = TCMB rate decision, `issizlik_tr` = TÜİK labour force statistics, `gsyh_tr` = TÜİK quarterly GDP); `onem` is `yuksek` or `orta`.
- All times are `tarih_utc` (ISO 8601, UTC). Only release dates and times, no forecasts or values.
- TÜİK times come from the time in the official calendar entry (Istanbul local time, converted to UTC).
- PPK decision time is 14:00 Istanbul time, taken from the yearly TCMB "Para Politikası" text (2026: item 13). Years without a verified text are skipped (their PPK dates are not published until that year's text is read and added).
- Kaynak: TÜİK (https://www.tuik.gov.tr) / Kaynak: TCMB (https://www.tcmb.gov.tr). Release dates are taken from these official calendars.
- Not investment advice.
