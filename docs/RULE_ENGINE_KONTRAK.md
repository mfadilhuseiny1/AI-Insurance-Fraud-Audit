# Rule engine: user-defined rules with AI assistance — API contract

User request (2026-11-12): rules can be added and edited in plain language. DeepSeek on OpenRouter converts the text into a rule
for the rule engine, and an AI-assisted edit fixes a rule the same way. Every new or edited rule is **tested first, then approved
by an admin**, and only then becomes active. The editor lives in a new top-level tab **"System Architecture"**, next to the ML
architecture in use and the AI Agent Swarm config. Synthetic data only.

This file is the contract between the backend (API 8300, `api/aip/realtime/aturan_kustom.py` + routes) and the frontend
(`web/src/components/aip/SystemArchitectureView.tsx`). Field names are Indonesian, as in the rest of the realtime API.

## Concepts

- **Built-in rules** (`bawaan`): the engine's existing signals, registered in `aip/realtime/modus.py` `SIGNALS`. The logic stays in
  Python. What can change is `aktif` (on/off) and `bobot` (weight). Every change goes through the same draft → test → approve flow
  as a custom rule.
  - A plain-language edit of a built-in rule produces one of two things:
    - a parameter change, or
    - a **custom rule that replaces it**: the custom rule records `menggantikan: "<KODE_BAWAAN>"`, and when approved the built-in
      one is switched off.
- **Custom rules** (`kustom`): a condition written in a small, safe expression language over a fixed field catalogue (below).
  - When active, a rule raises signal `kode` with weight `bobot` on every FKRTL claim whose condition is true.
  - That signal enters the engine's rule score (PERIKSA/TAHAN), the explanation and the case. It is not a model feature until a
    model is retrained.
- **Status** of a custom rule or a built-in change: `draf` → `diuji` (a backtest exists for the current version) → `menunggu`
  (submitted) → `aktif` | `ditolak`. Also `nonaktif` (switched off by an admin).
  - Every edit creates a new `versi` and returns the rule to `draf`. Rollback re-activates an earlier version, admin only, and is
    logged.
- **AI**: DeepSeek V4.1 Flash on OpenRouter (`deepseek/deepseek-v4.1-flash`, reasoning low, `provider.data_collection: deny`). The
  key `OPENROUTER_API_KEY` is in `.env.local` and must never be printed or logged.
  - The AI gets the field catalogue, the function list, the Permenkes 16/2019 modes (M01–M20) and, for an edit, the current rule.
    It **never gets claim rows**. For an "improve" request it may get the backtest's aggregate numbers.
  - The AI's output is always validated by the parser before it is shown. It can never activate anything.

## Expression language (`kondisi`)

- Python-like boolean expressions, parsed with `ast` and evaluated by a whitelist evaluator. No `eval`/`exec`, no attribute access,
  no imports, no comprehensions, no lambdas.
- Allowed:
  - `and`, `or`, `not`;
  - comparisons (`== != < <= > >= in not in`);
  - arithmetic `+ - * /`;
  - number, string and list literals;
  - names from the catalogue;
  - calls to the whitelisted functions.
- Missing values are `None`. A comparison with `None` is `False`, never an error.

Example: `tingkat_pelayanan == "RITL" and sd_tarif_rp > 3 * p95_topup("sd_tarif_rp") and hari_sejak_sebelumnya > 30`

### Field catalogue (served by `GET /aturan/katalog`, so the UI and the AI read the same list)

- **Claim fields** (KlaimIn): `tingkat_pelayanan`, `kelas_rawat`, `inacbg_kode`, `inacbg_keparahan`, `dx_primer_icd3`,
  `jumlah_dx_sekunder`, `prosedur` (text or None), `los_hari`, `tarif_inacbg_rp`, `sa_tarif_rp`, `sp_tarif_rp`, `rr_tarif_rp`,
  `si_tarif_rp`, `sd_tarif_rp`, `biaya_tagih_rp`, `kabkota_fkrtl_kode`, `jenis_fkrtl`, `tipe_fkrtl`, `kepemilikan_fkrtl`, `poli`,
  `status_pulang`, `tgl_datang`, `tgl_pulang`.
- **Derived**: `topup_total`, `ada_prosedur`, `kode_digit` (the 3rd character of the INA-CBG code), `sev` (I/II/III/0).
- **Member** (registry): `jk`, `umur`, `hak_kelas` (1/2/3), `segmen`, `pbi` (bool), `kab_fktp_terdaftar`.
- **Engine features** (the feature row the engine already computes for the claim): `idx_los`, `rasio_tagih_tarif`,
  `idx_tarif_kode`, `hari_sejak_sebelumnya`, `kunjungan_peserta`, `kunjungan_peserta_faskes`, `kembar`, `frek_kode`, `frek_dx`,
  `p_berat_dx`, `p_prosedur_dx`.
- **Reference functions** (from the engine's references; the argument is optional and defaults to the claim's own code/column):
  - `med_los()`, `p90_los()`, `dx_sek_p99()`, `p95_topup(kolom)`, `n_topup(kolom)` (claims of the code with that top-up),
  - `frek_pasangan()` (claims with this diagnosis and code), `rare_pair()` (bool).
- **Existing signals**: `sinyal("KODE")` is True when that built-in signal fired on this claim.
- Further functions may be added by the backend. They must appear in `/aturan/katalog` with a one-line description.

## Endpoints (prefix `/api/aip/realtime/v1`; read = `_reader()`, write = signed-in user, approve/reject/rollback/off = `_admin()`)

```
GET  /aturan/katalog
     -> { fields: [{nama, jenis: "angka"|"teks"|"bool"|"tanggal", sumber: "klaim"|"turunan"|"peserta"|"fitur", deskripsi}],
          fungsi: [{nama, argumen, deskripsi}], modus: [{kode, nama}], contoh: [string] }

GET  /aturan
     -> { bawaan: [{kode, label, modus: [string], tag, bobot_default, bobot, aktif, deskripsi, perubahan_menunggu: Perubahan|null}],
          kustom: [Aturan], ringkas: {aktif, menunggu, draf} }

Aturan = { id, kode, label, deskripsi, kondisi, modus: [string], bobot, status, versi, menggantikan: string|null,
           dibuat_oleh, dibuat, diubah_oleh, diubah, uji: Uji|null, riwayat: [{versi, status, oleh, waktu, catatan}] }

POST /aturan/validasi        {kondisi}                -> {ok, error: string|null, field: [string], fungsi: [string]}
POST /aturan/ai/draf         {teks}                   -> Draf
POST /aturan/ai/edit         {id | kode_bawaan, teks} -> Draf & {sebelum: {kondisi, bobot, aktif}, perubahan: string}
POST /aturan/ai/perbaiki     {id}                     -> Draf   (uses the rule's last backtest aggregates)
     Draf = {kode, label, deskripsi, kondisi, modus, bobot, menggantikan: string|null, aksi: "aturan_baru"|"ubah_parameter",
             parameter: {aktif?, bobot?} | null, penjelasan, field_dipakai: [string], peringatan: [string], valid, error,
             biaya_usd}

POST /aturan                 {kode, label, deskripsi, kondisi, modus, bobot, menggantikan?} -> Aturan (status draf)
PUT  /aturan/{id}            same body                -> Aturan (new versi, status draf)
POST /aturan/bawaan/{kode}   {aktif?, bobot?, catatan?} -> Perubahan (a pending change to a built-in rule, status draf)
POST /aturan/{id}/uji        -> Uji   (also /aturan/bawaan/{kode}/uji for a pending built-in change)
     Uji = { versi, waktu, data: string, klaim, normal, fraud,
             kena: {normal, fraud}, laju_normal, recall, precision,
             per_skema: [{skema, label, n, kena}],
             unik: {fraud_baru_vs_rule: n, fraud_baru_vs_keputusan: n},   // fraud it catches that no active rule / no
                                                                         // PERIKSA-TAHAN decision caught
             beban_per_hari, contoh_kode: [string] (claim ids only, no claim content), detik }
POST /aturan/{id}/ajukan     {catatan?}  -> Aturan (status menunggu; refused unless uji exists for the current versi)
POST /aturan/{id}/setujui    {catatan?}  -> Aturan (aktif; admin)    — also /aturan/bawaan/{kode}/setujui
POST /aturan/{id}/tolak      {catatan}   -> Aturan (ditolak; admin)
POST /aturan/{id}/nonaktifkan            -> Aturan (nonaktif; admin)
POST /aturan/{id}/rollback   {versi}     -> Aturan (that version active again; admin)
GET  /aturan/log             -> [{waktu, oleh, aksi, id|kode, versi, catatan}]
```

## Backtest data

- The labelled synthetic FKRTL claims the engine has already judged: stored events with a truth label (`kebenaran`), plus the
  replay window's normal claims. A custom rule is evaluated on each stored event's claim fields, member fields and feature row.
- `data` names what was used, e.g. "aliran replay 2024-12-18–31, 57.475 klaim".
- `beban_per_hari` = rows hit / days in the data.

## Storage

- Rules, versions, pending built-in changes and the log live in `data/aip/realtime/aturan/` (JSON, one file per rule plus
  `log.jsonl`), inside the instance's data dir (`aip.realtime.store` / `mesin.data_dir()`).
- The engine reloads active rules when they change.
- Approval writes the built-in weight/on-off into the engine config (`E.set_config(bobot=...)` / a disabled-signals list), so the
  existing scoring code applies it.
