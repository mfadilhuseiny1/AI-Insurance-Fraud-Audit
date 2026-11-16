# Google Maps / Google Earth di App Ini

Dua mode, satu API key yang sama:

| Mode | Teknologi | Di mana |
|---|---|---|
| Basemap 2D `Satellite` / `Hybrid` | Map Tiles API (session token → tile 2D) | Semua peta berbasis `MapCanvas`: Map app, Workshop, Slate |
| Mode `3D Earth` | Maps JavaScript API beta — Photorealistic 3D (`gmp-map-3d`) | Tombol **3D Earth** di peta tersimpan (`/map/...`) bila peta punya titik layer |

Tanpa API key, peta tetap berfungsi dengan basemap bebas OpenStreetMap/Esri
dan panel 3D menampilkan petunjuk ini. Tidak ada kunci yang di-hardcode.

Catatan teknis hybrid: `hybrid` bukan nilai `mapType` session yang valid di
Map Tiles API (`createSession` membalas 400). Hybrid dirender dari dua lapis:
tile dasar satellite (JPEG, session `mapType: satellite`) ditumpuk tile overlay
roadmap transparan (PNG, session `satellite` + `layerTypes: ["layerRoadmap"]`
+ `overlay: true`). Lihat `web/src/lib/googleMaps.ts`.

## Cara Membuat API Key (oleh pemilik akun Google Cloud)

1. Buka [Google Cloud Console](https://console.cloud.google.com/) → buat/pilih project.
2. **Billing**: tautkan akun penagihan (wajib untuk Maps Platform; ada kuota gratis bulanan).
3. **APIs & Services → Library**, aktifkan:
   - `Maps JavaScript API`
   - `Map Tiles API`
4. **APIs & Services → Credentials → Create credentials → API key**.
5. Batasi kunci (penting, karena kunci browser bersifat publik per desain):
   - Application restrictions: **Websites** — tambahkan `http://localhost:8888/*`
     dan domain produksi app.
   - API restrictions: hanya **Maps JavaScript API** + **Map Tiles API**.
6. Isi di `web/.env.local` (jangan commit, jangan tempel di chat/repo):

   ```ini
   NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=AIza...kunci-anda
   ```

7. Restart web (`npm run dev` di folder `web`, atau `start.ps1` dari root).

## Verifikasi

- Buka peta mana pun → pemilih basemap kini berisi **Satellite** dan **Hybrid**.
- Buka peta tersimpan yang punya layer titik → tombol **3D Earth** di kanan atas
  peta; klik untuk orbit/tilt ala Google Earth dengan marker 3D dari layer.
- Bila tile kosong: cek kuota/billing, pembatasan referrer, dan bahwa kedua API
  di langkah 3 sudah aktif. Pesan error session tampil di bagian bawah peta.
