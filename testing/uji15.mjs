// 15 synthetic claims through the /testing page: 10 fraud scenarios and 5 ordinary claims. For each: the verdict against
// the expectation, the fraud modes, the AI paragraph (length, refers to the graph), the network, internal codes or
// provider names on the page, JavaScript errors, time. Writes testing/e2e-shots/uji15.json and a screenshot per claim.
// Usage: node testing/uji15.mjs <playwright package dir>
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2]);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'e2e-shots', 'uji15');
fs.mkdirSync(DIR, { recursive: true });
const MEREK = /deepseek|openrouter|muse|glimmer|bedrock|nova lite|gpt|claude|llama|gemini/i;
const KODE = /\b[A-Z]{3,}_[A-Z_]{3,}\b/;
const KASUS = [
  ['ganda', true, 'M11'], ['kartu_dipinjam', true, 'M06'], ['kelas_naik', true, 'M13'], ['dx_sekunder', true, 'M04'], ['topup_fiktif', true, 'M17'],
  ['topup_inflasi', true, 'M07'], ['prosedur_fiktif', true, 'M14'], ['kode_tidak_sesuai', true, 'M15'], ['setelah_meninggal', true, 'M06'], ['kloning', true, 'M05'],
  ['normal', false], ['normal', false], ['normal', false], ['normal', false], ['normal', false],
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
  const galat = await page.locator('#form-galat').isVisible() ? await page.locator('#form-galat').innerText() : '';
  const judul = galat ? '' : await page.locator('#vonis .t').innerText();
  const terdeteksi = /Terdeteksi/.test(judul);
  const chips = terdeteksi ? (await page.locator('#jenis-chips .mchip').allInnerTexts()).map((c) => c.replace(/\s+/g, ' ').trim()) : [];
  const awam = terdeteksi ? await page.locator('#awam').innerText().catch(() => '') : '';
  const ai = await page.locator('#ai').innerText().catch(() => '');
  const simpul = await page.locator('#net g.simpul').count();
  const menunggu = await page.locator('#ai .menunggu > i').count();  // the spinner, not the rule note of a safe claim
  const halaman = await page.evaluate(() => document.body.innerText);
  const r = {
    no: n + 1, contoh: j, klaim: nKlaim, harap: fraud ? 'terdeteksi' : 'aman', hasil: galat ? 'galat' : terdeteksi ? 'terdeteksi' : 'aman', judul, jenis: chips,
    modus_harap: modus || null, modus_ada: modus ? chips.some((c) => c.startsWith(modus)) : null, kata_awam: awam ? awam.split(/\s+/).length : 0,
    awam_rujuk_graph: awam ? /graph|grafik|dokumen|lingkaran|kotak|belah ketupat/i.test(awam) : null, simpul, ai_belum_siap: menunggu > 0,
    kode_bocor: (ai.match(KODE) || [null])[0], merek_bocor: (halaman.match(MEREK) || [null])[0], galat_js: errs.slice(0, 3), galat_form: galat, detik: Math.round((Date.now() - t0) / 1000),
    awam,
  };
  r.bug = [r.hasil === 'galat' && 'penilaian gagal', r.simpul < 3 && 'graph kosong', r.kode_bocor && 'kode internal tampil', r.merek_bocor && 'nama model tampil',
    r.galat_js.length && 'galat JavaScript', fraud && terdeteksi && !awam && 'penjelasan kosong', r.ai_belum_siap && 'penjelasan AI belum siap',
    fraud && terdeteksi && r.kata_awam > 110 && 'paragraf terlalu panjang'].filter(Boolean);
  r.cocok = r.hasil === r.harap;
  hasil.push(r);
  await page.screenshot({ path: `${DIR}/${String(n + 1).padStart(2, '0')}-${j}.png` });
  console.log(`${String(n + 1).padStart(2)} ${j.padEnd(18)} ${String(nKlaim).padStart(2)} klaim · harap ${r.harap.padEnd(10)} hasil ${r.hasil.padEnd(10)} ${r.cocok ? 'cocok' : 'BEDA '} · ${chips.join(', ') || '-'} · ${r.kata_awam} kata · ${simpul} simpul · ${r.detik}s${r.bug.length ? ' · BUG: ' + r.bug.join(', ') : ''}`);
}
await page.click('.menu button[data-view="histori"]');
await page.waitForTimeout(800);
const nRiw1 = Number(await page.locator('#n-riwayat').innerText());
const totalKlaim = hasil.reduce((s, r) => s + r.klaim, 0);
console.log(`\nHistori: ${nRiw0} → ${nRiw1} (klaim dinilai ${totalKlaim}${nRiw0 >= 300 ? '; daftar dibatasi 300 terbaru' : ''})`);
const cocok = hasil.filter((r) => r.cocok).length, bug = hasil.filter((r) => r.bug.length);
console.log(`Cocok dengan harapan: ${cocok}/15 · fraud terdeteksi ${hasil.filter((r) => r.harap === 'terdeteksi' && r.cocok).length}/10 · wajar lolos ${hasil.filter((r) => r.harap === 'aman' && r.cocok).length}/5 · modus sesuai ${hasil.filter((r) => r.modus_ada).length}/10 · klaim dengan bug ${bug.length}`);
fs.writeFileSync(path.join(DIR, 'uji15.json'), JSON.stringify(hasil, null, 1));
await b.close();
