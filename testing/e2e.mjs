// Browser end-to-end check of /testing: examples (safe, flagged with the AI, a hospital-network batch), the fraud modes and
// the plain explanation beside the network, the network itself (scorecard highlight, floating data viewer + member
// timeline, expand, entity-to-entity, focus on another claim, merged batch), document upload autofill (DOCX, PDF, PNG)
// and scoring of the autofilled new patient, technical detail, validation, the history menu, no provider names and no
// internal codes on the page, dark mode and the phone layout. Screenshots to testing/e2e-shots/.
// Usage: node testing/e2e.mjs <playwright package dir> [--tanpa-gambar]
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2]);
const TANPA_GAMBAR = process.argv.includes('--tanpa-gambar');
const URL_ = 'http://127.0.0.1:8320/testing';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'e2e-shots');
const DOKS = path.join(HERE, 'dokumen_uji');
fs.mkdirSync(DIR, { recursive: true });
const ok = [], bad = [];
const cek = (c, m) => { (c ? ok : bad).push(m); console.log((c ? '  ✓ ' : '  ✗ ') + m); };
const MEREK = /deepseek|openrouter|muse|glimmer|bedrock|nova lite|gpt|claude|llama|gemini/i;
const KODE = /\b[A-Z]{3,}_[A-Z_]{3,}\b/;

let browser;
try { browser = await chromium.launch(); } catch (e) { browser = await chromium.launch({ channel: 'msedge' }); }
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errs.push('console: ' + m.text()); });
await page.goto(URL_);
await page.waitForFunction(() => document.querySelector('#status').classList.contains('siap'), null, { timeout: 300000 });
cek(!(await page.locator('#kirim').isDisabled()), 'tombol Nilai aktif setelah layanan siap');
cek(await page.locator('#pakai_llm').count() === 0, 'tidak ada tombol pilihan AI');
await page.screenshot({ path: `${DIR}/01-awal.png` });

const simpul = () => page.locator('#net g.simpul').count();
const selesai = () => page.waitForFunction(() => document.querySelector('#langkah').hidden && (!document.querySelector('#p-hasil').hidden || !document.querySelector('#form-galat').hidden), null, { timeout: 300000 });
async function preset(j) {
  await page.click('[data-tabgroup="masuk"] [data-tab="contoh"]');
  await page.click(`#contoh .ex[data-j="${j}"]`);
  await page.waitForFunction((jj) => document.querySelector('#batch').dataset.jenis === jj && !document.querySelector('#kirim').disabled, j, { timeout: 120000 });
  await page.click('#kirim');
  await selesai();
  await page.waitForTimeout(700);
}
async function tungguAI() {  // a batch claim opened later gets its explanation from the AI on request
  await page.waitForFunction(() => !document.querySelector('#ai .menunggu'), null, { timeout: 180000 }).catch(() => {});
}
const teksHalaman = () => page.evaluate(() => document.body.innerText);

// 1. a safe claim
await preset('normal');
const v1 = await page.locator('#vonis .t').innerText();
cek(/Klaim aman/.test(v1), `klaim wajar → ${v1}`);
cek(await simpul() >= 3, `graph tampil langsung di samping penjelasan (${await simpul()} simpul)`);
await page.screenshot({ path: `${DIR}/02-aman.png` });

// 2. a flagged claim: modes, plain paragraph, evidence, network beside it
await preset('ganda');
const v2 = await page.locator('#vonis .t').innerText();
cek(/Terdeteksi/.test(v2), `klaim berulang → ${v2}`);
const chips = await page.locator('#jenis-chips .mchip').allInnerTexts();
cek(chips.length >= 1 && chips.every((c) => /^(M\d\d|\?)/.test(c.trim())), `jenis fraud Permenkes: ${chips.map((c) => c.replace(/\s+/g, ' ')).join(' | ')}`);
const awam = await page.locator('#awam').innerText();
cek(awam.length > 100 && /graph|grafik|dokumen|lingkaran|kotak/i.test(awam), `penjelasan awam ${awam.split(/\s+/).length} kata, merujuk graph`);
console.log('     › ' + awam);
const alasan = await page.locator('#alasan li').allInnerTexts();
cek(alasan.length >= 2, `bukti ${alasan.length} butir`);
alasan.forEach((a) => console.log('       - ' + a));
cek(await page.locator('#perbaikan li').count() >= 2, `perbaikan ${await page.locator('#perbaikan li').count()} butir`);
const n0 = await simpul();
cek(n0 >= 4 && await page.locator('#ai').isVisible(), `graph (${n0} simpul) dan penjelasan tampil berdampingan`);
const isiAI = await page.locator('#ai').innerText();
cek(!KODE.test(isiAI), `penjelasan tanpa kode internal${KODE.test(isiAI) ? ': ' + isiAI.match(KODE)[0] : ''}`);
cek(!MEREK.test(await teksHalaman()), 'tidak ada nama model atau penyedia AI di halaman');
await page.screenshot({ path: `${DIR}/03-terdeteksi.png` });
// network interactions
{ const n = await page.locator('#scorecard .skor').count();  // 5 base scores + the v2 layers (rule, 4 Permenkes-family specialists, the rule route)
  cek(n >= 8, `skor model berisi ${n} skor (peluang, Model 1, jaringan RS, rule, 4 spesialis Permenkes)`); }
await page.locator('#scorecard .skor[data-s="model1"]').click();
cek((await page.locator('#scorecard .skor[data-s="model1"]').getAttribute('aria-pressed')) === 'true', 'klik skor Model 1 menyorot simpulnya');
await page.locator('#sorot button[data-s="semua"]').click();
await page.locator('#net g.simpul[aria-label^="peserta"] .hit').first().click({ force: true });
await page.waitForTimeout(900);
cek(await page.locator('#dataviewer').isVisible() && /Peserta \(entitas\)/.test(await page.locator('#dataviewer').innerText()), 'klik peserta → kartu data di atas graph');
cek(await page.locator('#lini tr[data-id]').count() >= 1, `lini masa peserta: ${await page.locator('#lini tr[data-id]').count()} klaim`);
await page.screenshot({ path: `${DIR}/04-data-viewer.png` });
await page.locator('#dataviewer .x').click();
cek(await page.locator('#dataviewer').isHidden(), 'kartu data bisa ditutup');
await page.locator('#net g.simpul[aria-label^="rs"] .hit').first().dblclick({ force: true });
await page.waitForTimeout(1500);
const n1 = await simpul();
cek(n1 > n0, `expand RS: ${n0} → ${n1} simpul`);
await page.locator('#mode button[data-m="e2e"]').click();
await page.waitForTimeout(800);
cek(await page.locator('#net g.simpul[aria-label^="klaim"]').count() === 0 && await simpul() >= 2, `entity-to-entity: ${await simpul()} entitas, tanpa dokumen`);
await page.locator('#mode button[data-m="dok"]').click();
await page.waitForTimeout(600);
await page.locator('#net g.simpul[aria-label^="klaim"] .hit').nth(1).click({ force: true });
await page.waitForTimeout(400);
const tombolFokus = page.locator('#dataviewer button[data-a="fokus"]');
if (await tombolFokus.count()) {
  await tombolFokus.click();
  await page.waitForFunction(() => /fokus baru/.test(document.querySelector('#inv-fokus').textContent), null, { timeout: 30000 });
  cek(!(await page.locator('#ke-fokus').isDisabled()), `jadikan fokus klaim lain: ${await page.locator('#inv-fokus').innerText()}`);
  await page.locator('#ke-fokus').click();
  await page.waitForTimeout(500);
  cek(/^UJI-/.test(await page.locator('#inv-fokus').innerText()), 'kembali ke klaim yang dinilai');
} else cek(false, 'tombol Jadikan fokus tidak muncul');

// 3. the hospital-network batch (15 claims)
await preset('ring');
const nStrip = await page.locator('#strip button.c').count();
cek(nStrip === 15, `jaringan RS: strip batch berisi ${nStrip} klaim`);
cek(/Terdeteksi/.test(await page.locator('#vonis .t').innerText()), `jaringan RS, klaim terakhir: ${(await page.locator('#jenis-chips').innerText().catch(() => '')).replace(/\s+/g, ' ')}`);
console.log('     › ' + await page.locator('#awam').innerText().catch(() => ''));
await page.screenshot({ path: `${DIR}/05-jaringan-rs.png` });
const flaggedIdx = await page.locator('#strip button.c.f').first().getAttribute('data-i').catch(() => null);
if (flaggedIdx !== null && flaggedIdx !== '14') {
  await page.locator(`#strip button.c[data-i="${flaggedIdx}"]`).click();
  await page.waitForTimeout(500);
  const sempat = await page.locator('#ai .menunggu').count();
  await tungguAI();
  cek(!(await page.locator('#ai .menunggu').count()) && (await page.locator('#awam').innerText()).length > 60, `klaim batch #${Number(flaggedIdx) + 1} mendapat penjelasan AI saat dibuka${sempat ? ' (setelah menunggu)' : ''}`);
}
await page.locator('#gabung').click();
await page.waitForTimeout(1500);
const nGab = await simpul();
cek(/gabungan/.test(await page.locator('#inv-fokus').innerText()) && nGab >= 15, `network gabungan batch: ${nGab} simpul`);
await page.locator('#sorot button[data-s="model2"]').click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${DIR}/06-gabungan.png` });

// 4. upload autofill: DOCX, PDF, PNG
const harap = JSON.parse(fs.readFileSync(`${DOKS}/harapan.json`, 'utf8'));
const berkas = [['sep_rincian.docx', '07-unggah-docx'], ['resume_medis.pdf', '08-unggah-pdf']];
if (!TANPA_GAMBAR) berkas.push(['sep_foto.png', '09-unggah-png']);
for (const [nama, shot] of berkas) {
  await page.click('#kosongkan');
  await page.click('[data-tabgroup="masuk"] [data-tab="dokumen"]');
  await page.setInputFiles('#berkas', `${DOKS}/${nama}`);
  await page.waitForFunction(() => { const t = document.querySelector('#dok-status').textContent; return t && !/Membaca/.test(t); }, null, { timeout: 180000 });
  const st = await page.locator('#dok-status').innerText();
  const val = async (id) => (await page.inputValue('#' + id)).trim();
  const cocok = {
    nama: (await val('nama_pasien')) === harap.nama_pasien, rm: (await val('no_rm')) === harap.no_rm, masuk: (await val('tanggal_masuk')) === harap.tanggal_masuk,
    pulang: (await val('tanggal_pulang')) === harap.tanggal_pulang, dx: (await val('diagnosis_utama')).replace('.', '') === harap.diagnosis_utama.replace('.', ''),
    kode: (await val('inacbg_kode')) === harap.inacbg_kode, tagih: Number((await val('biaya_tagih_rp')).replace(/\D/g, '')) === harap.biaya_tagih_rp,
    rs: (await val('rs_id')) === harap.rs_id, hak: (await val('hak_kelas')) === String(harap.hak_kelas),
  };
  const nOk = Object.values(cocok).filter(Boolean).length;
  cek(nOk >= 8, `${nama}: ${nOk}/9 isian cocok ${nOk < 9 ? JSON.stringify(cocok) : ''} · ${st.split('\n')[0]}`);
  await page.screenshot({ path: `${DIR}/${shot}.png` });
}
await page.click('#kirim');
await selesai();
const galat = await page.locator('#form-galat').isVisible();
cek(!galat, `klaim dari dokumen dinilai: ${galat ? await page.locator('#form-galat').innerText() : await page.locator('#vonis .t').innerText()}`);
await page.click('[data-tabgroup="hasil"] [data-tab="teknis"]');
const ent = await page.locator('#bukti-entitas').innerText().catch(() => '');
cek(/pasien baru/.test(ent), `entity resolution pasien baru: ${ent.replace(/\s+/g, ' ').slice(0, 100)}`);
cek(!KODE.test(await page.locator('#bukti').innerText()), 'detail teknis tanpa kode internal');
await page.screenshot({ path: `${DIR}/10-detail-teknis.png` });
await page.click('[data-tabgroup="hasil"] [data-tab="hasil"]');

// 5. validation
await page.click('#kosongkan');
await page.click('#kirim');
cek(await page.locator('#form-galat').isVisible(), 'formulir kosong → pesan "Lengkapi dulu"');
cek(await page.locator('#form .err').count() >= 3, `isian wajib ditandai (${await page.locator('#form .err').count()})`);
await page.screenshot({ path: `${DIR}/11-validasi.png` });

// 6. the history menu
await page.click('.menu button[data-view="histori"]');
await page.waitForTimeout(800);
const nRiw = await page.locator('#histori-tabel tbody tr').count();
cek(nRiw >= 3, `menu Histori: ${nRiw} klaim`);
await page.click('#h-filter button[data-f="terdeteksi"]');
const nT = await page.locator('#histori-tabel tbody tr').count();
const semuaTerdeteksi = (await page.locator('#histori-tabel tbody tr td:nth-child(2)').allInnerTexts()).every((t) => /terdeteksi/.test(t));
cek(nT >= 1 && semuaTerdeteksi, `saring Terdeteksi: ${nT} klaim`);
await page.fill('#h-cari', 'M11');
await page.waitForTimeout(300);
cek(await page.locator('#histori-tabel tbody tr').count() >= 1, `cari "M11": ${await page.locator('#histori-tabel tbody tr').count()} klaim`);
cek(!MEREK.test(await teksHalaman()), 'Histori tanpa nama model atau penyedia AI');
await page.screenshot({ path: `${DIR}/12-histori.png` });
await page.locator('#histori-tabel tbody tr').first().click();
await page.waitForTimeout(1500);
cek(!(await page.locator('#v-uji').isHidden()) && !(await page.locator('#vonis').isHidden()) && await simpul() >= 3, 'klik baris Histori membuka hasil dan graph-nya');

// 7. dark mode and the phone
await page.emulateMedia({ colorScheme: 'dark' });
await page.waitForTimeout(600);
await page.screenshot({ path: `${DIR}/13-gelap.png` });
await page.emulateMedia({ colorScheme: 'light' });
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(800);
const lebar = await page.evaluate(() => document.documentElement.scrollWidth);
cek(lebar <= 392, `ponsel 390px: lebar halaman ${lebar}px (tanpa scroll horizontal)`);
await page.screenshot({ path: `${DIR}/14-ponsel.png`, fullPage: true });

cek(errs.length === 0, `galat JavaScript: ${errs.length ? errs.slice(0, 4).join(' | ') : 'tidak ada'}`);
await browser.close();
fs.writeFileSync(path.join(DIR, 'e2e.json'), JSON.stringify({ dijalankan: new Date().toISOString(), lulus: ok, gagal: bad }, null, 1));  // for ML Studio (laporan_v2.py)
console.log(`\nLULUS ${ok.length} · GAGAL ${bad.length}`);
bad.forEach((m) => console.log('  ✗ ' + m));
process.exit(bad.length ? 1 : 0);
