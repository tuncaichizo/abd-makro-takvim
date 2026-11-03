# ABD makro veri takvimi

ABD makro veri takvimi (FOMC, TÜFE/CPI, ÜFE/PPI, tarım dışı istihdam, GSYH, PCE): önümüzdeki 60 gün, resmî kaynaklardan, JSON.

- Sources: Federal Reserve calendar JSON, BLS release schedule (ICS), BEA release schedule (ICS):
  `https://www.federalreserve.gov/json/calendar.json`,
  `https://www.bls.gov/schedule/news_release/bls.ics`,
  `https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics`.
- A GitHub Action refreshes `takvim.json` daily (05:17 UTC) and commits only when the events change.
- Schema: `{ "guncellendi": ISO time, "olaylar": [ { "id", "kod", "ulke", "olay", "kurum", "tarih_utc", "onem", "kaynak_link" } ] }`.
- `ulke` is `US` or `TR`; `kod` is one of `fomc | fomc_tutanak | cpi | ppi | nfp | gdp | pce` (`fomc` = rate decision, `fomc_tutanak` = minutes); `onem` is `yuksek` or `orta`.
- All times are `tarih_utc` (ISO 8601, UTC). Only release dates and times, no forecasts or values.
- Not investment advice.
