# Petunjuk untuk peninjau ahli

Terima kasih telah meninjau kasus-kasus ini. Perkiraan waktu: sekitar satu jam. (Disusun mengikuti
`templates/expert_review_instructions.md` di healthkathon-eval-kit.)

## Yang Anda terima

`review_sheet.csv`: satu baris per klaim, berisi rincian klaim dan dua kolom kosong, `judgement` dan
`unrealistic_case`. Lembar ini berisi campuran kasus. Anda tidak diberi tahu kasus mana yang dipilih sistem atau berapa
jumlah tiap jenisnya, dan mohon tidak mencoba menebaknya. Nilailah setiap klaim dari rinciannya sendiri.

## Yang perlu dilakukan

Untuk setiap baris, isi `judgement` dengan tepat salah satu dari (dalam bahasa Inggris, persis seperti ini):

- `suspicious`: Anda ingin klaim ini diperiksa lebih lanjut
- `not suspicious`: klaim ini tampak wajar
- `cannot judge`: rinciannya tidak cukup untuk memutuskan

Bila sebuah klaim tampak tidak realistis (kombinasi kode, lama rawat atau nilai yang tidak mungkin terjadi), jelaskan
apa yang janggal di `unrealistic_case`, meskipun Anda juga menilainya. Kosongkan bila tidak ada.

Mohon tidak membahas kasus-kasus ini dengan tim sebelum lembar dikembalikan.

## Untuk apa jawaban Anda dipakai

Penilaian Anda dibandingkan antarkelompok kasus untuk melihat apakah pilihan sistem tampak lebih mencurigakan bagi ahli
daripada kasus lain. Catatan tentang kasus yang tidak realistis dipakai untuk memperbaiki data uji. Kecurigaan ahli
bukan fraud yang terbukti, dan hasilnya dilaporkan seperti itu.

Klaim di lembar ini berasal dari Data Sampel BPJS Kesehatan 2025 (data nyata yang dianonimkan).
