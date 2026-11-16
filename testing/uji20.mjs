// 20 synthetic claims through the /testing page with architecture v3 (the user, 2026-11-12: "check end2end pake 20 pertanyaan,
// jawab pake deepseek openrouter dulu aja"): all 13 fraud examples and 7 ordinary claims. For each: the verdict against the
// expectation, the fraud modes, the AI paragraph (length, refers to the graph), which AI answered (read from the API: it must be
// DeepSeek on OpenRouter; the page itself shows no provider), the v3 flow strip and the highlight the graph opens with, the
// network, internal codes or provider names on the page, JavaScript errors, time.
// Writes testing/e2e-shots/uji20/uji20.json and a screenshot per claim. Usage: node testing/uji20.mjs <playwright package dir>
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2]);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'e2e-shots', 'uji20');
fs.mkdirSync(DIR, { recursive: true });
const MEREK = /deepseek|openrouter|muse|glimmer|bedrock|nova lite|gpt|claude|llama|gemini/i;
const KODE = /\b[A-Z]{3,}_[A-Z_]{3,}\b/;
const KASUS = [
  ['ganda', true, 'M11'], ['kartu_dipinjam', true, 'M06'], ['kelas_naik', true, 'M13'], ['dx_sekunder', true, 'M04'], ['topup_fiktif', true, 'M17'],
  ['topup_inflasi', true, 'M07'], ['prosedur_fiktif', true, 'M14'], ['kode_tidak_sesuai', true, 'M15'], ['setelah_meninggal', true, 'M06'], ['kloning', true, 'M05'],
  ['upcoding', true, 'M04'], ['los_bergeser', true, 'M12'], ['ring', true, 'M10'],
  ['normal', false], ['normal', false], ['normal', false], ['normal', false], ['normal', false], ['normal', false], ['normal', false],
];
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
let errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errs.push('console: ' + m.text()); });
await page.goto('http://127.0.0.1:8320/testing');
await page.waitForFunction(() => document.querySelector('#status').classList.contains('siap'), null, { timeout: 300000 });
const nRiw0 = Number(await page.locator('#n-riwayat').innerText());
const hasil = [];
for (const [n, [j, fraud, modus]] of KASUS.entries()) {
  errs = [];
  const t0 = Date.now();
  await page.click('[data-tabgroup="masuk"] [data-tab="contoh"]');
  await page.click(`#contoh .ex[data-j="${j}"]`);
  await page.waitForFunction((jj) => document.querySelector('#batch').dataset.jenis === jj && !document.querySelector('#kirim').disabled, j, { timeout: 120000 });
  const nKlaim = (await page.locator('#batch').innerText()).match(/(\d+) klaim dinilai/) ? Number((await page.locator('#batch').innerText()).match(/(\d+) klaim dinilai/)[1]) : 1;
  await page.click('#kirim');
  await page.waitForFunction(() => document.querySelector('#langkah').hidden && (!document.querySelector('#p-hasil').hidden || !document.querySelector('#form-galat').hidden), null, { timeout: 400000 });
  await page.waitForTimeout(900);
  await page.waitForFunction(() => !document.querySelector('#ai .menunggu > i'), null, { timeout: 150000 }).catch(() => {});  // the AI paragraph, if still coming
  const galat = await page.locator('#form-galat').isVisible() ? await page.locator('#form-galat').innerText() : '';
  const judul = galat ? '' : await page.locator('#vonis .t').innerText();
  const terdeteksi = /Terdeteksi/.test(judul);
  const chips = terdeteksi ? (await page.locator('#jenis-chips .mchip').allInnerTexts()).map((c) => c.replace(/\s+/g, ' ').trim()) : [];
  const awam = terdeteksi ? await page.locator('#awam').innerText().catch(() => '') : '';
  const ai = await page.locator('#ai').innerText().catch(() => '');
  const simpul = await page.locator('#net g.simpul').count();
  const menunggu = await page.locator('#ai .menunggu > i').count();  // the spinner, not the rule note of a safe claim
  const halaman = await page.evaluate(() => document.body.innerText);
  // which AI answered (the API keeps it; the page must not show it) and the v3 parts of the page
  const info = galat ? {} : await page.evaluate(async () => {
    const h = await (await fetch('/testing/api/hasil/' + KASUS.aktif)).json();
    const ditekan = document.querySelector('#sorot button[aria-pressed="true"]');
    return { sumber: (h.penjelasan || {}).sumber || null, usd: (h.penjelasan || {}).biaya_usd ?? null, alur: !!document.querySelector('#scorecard .alurk'),
             ket: (document.querySelector('#sorot-ket') || {}).textContent || '', sorot: ditekan ? ditekan.dataset.s : null };
  });
  const r = {
    no: n + 1, contoh: j, klaim: nKlaim, harap: fraud ? 'terdeteksi' : 'aman', hasil: galat ? 'galat' : terdeteksi ? 'terdeteksi' : 'aman', judul, jenis: chips,
    modus_harap: modus || null, modus_ada: modus ? chips.some((c) => c.startsWith(modus)) : null, kata_awam: awam ? awam.split(/\s+/).length : 0,
    awam_rujuk_graph: awam ? /graph|grafik|dokumen|lingkaran|kotak|belah ketupat/i.test(awam) : null, simpul, ai_belum_siap: menunggu > 0,
    kode_bocor: (ai.match(KODE) || [null])[0], merek_bocor: (halaman.match(MEREK) || [null])[0], galat_js: errs.slice(0, 3), galat_form: galat, detik: Math.round((Date.now() - t0) / 1000),
    penyedia: info.sumber, biaya_usd: info.usd, alur_v3: info.alur, sorot_awal: info.sorot, ket_sorot: info.ket,
    awam,
  };
  r.bug = [r.hasil === 'galat' && 'penilaian gagal', r.simpul < 3 && 'graph kosong', r.kode_bocor && 'kode internal tampil', r.merek_bocor && 'nama model tampil',
    r.galat_js.length && 'galat JavaScript', fraud && terdeteksi && !awam && 'penjelasan kosong', r.ai_belum_siap && 'penjelasan AI belum siap',
    fraud && terdeteksi && r.kata_awam > 110 && 'paragraf terlalu panjang',
    terdeteksi && !/^deepseek\//.test(r.penyedia || '') && `penjelasan bukan dari DeepSeek OpenRouter (${r.penyedia})`,
    !galat && !r.alur_v3 && 'alur v3 tidak tampil', !galat && !r.ket_sorot && 'keterangan sorotan kosong',
    terdeteksi && r.sorot_awal !== (modus === 'M10' || /M10/.test(chips.join(' ')) ? 'model2' : 'model1') && `sorotan awal ${r.sorot_awal}`,
    !terdeteksi && !galat && r.sorot_awal !== 'semua' && `sorotan awal ${r.sorot_awal}`].filter(Boolean);
  r.cocok = r.hasil === r.harap;
  hasil.push(r);
  await page.screenshot({ path: `${DIR}/${String(n + 1).padStart(2, '0')}-${j}.png` });
  console.log(`${String(n + 1).padStart(2)} ${j.padEnd(18)} ${String(nKlaim).padStart(2)} klaim · harap ${r.harap.padEnd(10)} hasil ${r.hasil.padEnd(10)} ${r.cocok ? 'cocok' : 'BEDA '} · ${chips.map((c) => c.slice(0, 3)).join(',') || '-'} · ${r.terdeteksi !== false && terdeteksi ? (r.penyedia || '-') : '-'} · ${r.kata_awam} kata · sorot ${r.sorot_awal} · ${r.detik}s${r.bug.length ? ' · BUG: ' + r.bug.join(', ') : ''}`);
}
await page.click('.menu button[data-view="histori"]');
await page.waitForTimeout(800);
const nRiw1 = Number(await page.locator('#n-riwayat').innerText());
const totalKlaim = hasil.reduce((s, r) => s + r.klaim, 0);
console.log(`\nHistori: ${nRiw0} → ${nRiw1} (klaim dinilai ${totalKlaim}${nRiw0 >= 300 ? '; daftar dibatasi 300 terbaru' : ''})`);
const cocok = hasil.filter((r) => r.cocok).length, bug = hasil.filter((r) => r.bug.length);
const nF = KASUS.filter((k) => k[1]).length, nN = KASUS.length - nF;
const ds = hasil.filter((r) => r.hasil === 'terdeteksi');
const usd = ds.reduce((s, r) => s + (r.biaya_usd || 0), 0);
console.log(`Cocok dengan harapan: ${cocok}/${KASUS.length} · fraud terdeteksi ${hasil.filter((r) => r.harap === 'terdeteksi' && r.cocok).length}/${nF} · wajar lolos ${hasil.filter((r) => r.harap === 'aman' && r.cocok).length}/${nN} · modus sesuai ${hasil.filter((r) => r.modus_ada).length}/${nF} · klaim dengan bug ${bug.length}`);
console.log(`Penjelasan AI: ${ds.filter((r) => /^deepseek\//.test(r.penyedia || '')).length}/${ds.length} dari DeepSeek OpenRouter · biaya ~$${usd.toFixed(4)}`);
fs.writeFileSync(path.join(DIR, 'uji20.json'), JSON.stringify(hasil, null, 1));
await b.close();
