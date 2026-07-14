# 🐷 Bot Tabungan Bareng

Bot Telegram untuk tracking tabungan berdua. Tombol interaktif, scan foto struk/transfer otomatis (lewat OpenRouter, model vision gratis), semua lewat chat.

**v2:** dulu jalan mode *polling* di Railway (trial ~sebulan, abis itu bot mati dan data ikut hilang). Sekarang jalan mode **webhook** di **Vercel** — nggak time-boxed, dan nggak butuh proses nyala 24 jam.

## Fitur

| Fitur | Keterangan |
|---|---|
| 💰 Nabung | Tombol nominal cepat atau ketik manual (`75rb`, `1jt`, dst) |
| 📸 Scan struk | Kirim foto/screenshot transfer, nominal dibaca otomatis pakai model vision gratis (OpenRouter) |
| 📊 Saldo | Total & breakdown per orang |
| 📋 Riwayat | 8 transaksi terakhir |
| 📈 Statistik | Rata-rata harian, terbesar/terkecil, estimasi capai target |
| 🎯 Target | Set target + progress bar |
| 🗑 Hapus | Hapus transaksi terakhir kamu |

Command teks juga tetep jalan: `/nabung`, `/saldo`, `/riwayat`, `/statistik`, `/target`, `/hapus`, `/help` — atau ketik pendek kayak `n 50rb`, `s`, `r`, langsung angka doang, dll.

---

## Kenapa struktur project-nya berubah

Bot lama nyimpen "user ini lagi nunggu input apa" (`waiting`) dan "id pesan yang lagi di-edit" (`mainMsg`) di variabel JS biasa — itu cuma aman kalau prosesnya nyala terus (Railway). Di Vercel, tiap update masuk = eksekusi baru, jadi state itu sekarang disimpen di Supabase (tabel `bot_waiting` & `bot_mainmsg`, lihat `schema_webhook_addon.sql`). Dispatch-nya juga diubah dari event listener (`bot.on(...)`) yang nggak nungguin proses async-nya, jadi satu fungsi `handleUpdate()` yang di-`await` penuh sebelum webhook jawab ke Telegram — biar nggak ada pesan yang gagal kekirim gara-gara function-nya keburu berhenti.

```
tabungan-bot/
├── api/
│   ├── webhook.js         # entry point Vercel — Telegram POST ke sini
│   └── dashboard.js       # API buat dashboard web (saldo/riwayat/statistik/target + aksi)
├── lib/
│   └── bot.js             # semua logic bot (handler, render, dsb)
├── scripts/
│   └── set-webhook.js     # jalanin SEKALI setelah deploy
├── index.html               # dashboard web (buka di root URL Vercel)
├── manifest.json            # PWA manifest — biar bisa di-install jadi app di Android
├── sw.js                    # service worker PWA (cache app shell, API tetap live)
├── icons/                    # icon app (di-generate, bukan digambar manual)
├── dev-local.js            # buat testing lokal (mode polling)
├── schema.sql               # tabel lama (transaksi, target)
├── schema_webhook_addon.sql # tabel baru (bot_waiting, bot_mainmsg) — WAJIB dijalanin juga
├── package.json
├── .env.example
└── README.md
```

---

## Setup (ikutin urutan ini)

### 1. Buat Bot di Telegram
1. Buka Telegram → cari **@BotFather**
2. Kirim `/newbot`, ikutin instruksinya
3. Salin **token** → ini `BOT_TOKEN`

### 2. Buat Database di Supabase
1. Buka [dashboard.supabase.com](https://dashboard.supabase.com) → Sign up gratis
2. **New Project** → isi nama & password → Create, tunggu ~1 menit
3. **SQL Editor** → New Query → paste isi `schema.sql` → Run
4. New Query lagi → paste isi **`schema_webhook_addon.sql`** → Run (ini yang baru, jangan skip)
5. **Project Settings → API** → salin **Project URL** (`SUPABASE_URL`) dan **anon public key** (`SUPABASE_KEY`)

### 3. Bikin OpenRouter API Key (buat fitur scan foto)
1. Buka [openrouter.ai/keys](https://openrouter.ai/keys) → Sign in (bisa pakai Google) → Create Key
2. Salin → ini `OPENROUTER_KEY`
3. Fitur scan pakai model gratis (`google/gemini-2.0-flash-exp:free` secara default) — nggak perlu isi billing. Kalau model gratisnya lagi rate-limited/di-deprecate OpenRouter, ganti lewat env var `OPENROUTER_MODEL` (cek model vision gratis lain di [openrouter.ai/models?max_price=0](https://openrouter.ai/models?max_price=0))

### 4. Cari Chat ID kalian (opsional, biar bot private)
1. Telegram → cari **@userinfobot** → `/start` → catat **Id**
2. Suruh Renti lakuin hal yang sama, catat ID-nya juga

### 5. Deploy ke Vercel
1. Push project ini ke GitHub (repo baru atau replace yang lama)
2. Buka [vercel.com](https://vercel.com) → Sign up/in pakai GitHub (kamu udah punya akun dari `tabungan-web`)
3. **Add New → Project** → pilih repo ini → Import
4. Di step **Environment Variables**, tambahin ke-5 ini:
   ```
   BOT_TOKEN=...
   SUPABASE_URL=...
   SUPABASE_KEY=...
   OPENROUTER_KEY=...
   ALLOWED_CHAT_ID=id_kamu,id_renti
   ```
5. Klik **Deploy**. Setelah selesai, catat URL-nya (mis. `https://tabungan-bot-xxxx.vercel.app`)

### 6. Daftarin Webhook ke Telegram (SEKALI SAJA)
Di komputer kamu, dari folder project ini:
```bash
npm install
BOT_TOKEN=isi_token_kamu node scripts/set-webhook.js https://tabungan-bot-xxxx.vercel.app
```
Muncul `✅ Webhook berhasil diset` → bot langsung aktif, coba `/start` di Telegram.

> Kalau deploy ulang dengan URL yang SAMA (custom domain / domain default Vercel yang sama), nggak perlu daftarin ulang. Cuma perlu daftar ulang kalau URL-nya berubah.

---

## Dashboard Web

Selain lewat Telegram, sekarang ada juga dashboard web-nya — bisa liat saldo/riwayat/statistik/target DAN nabung/hapus/set target langsung dari browser. Nggak perlu deploy terpisah, jalan di URL Vercel yang sama (root), misalnya `https://tabungan-bot-xxxx.vercel.app/`.

**Setup:**
1. Tambahin satu env var lagi di Vercel (**Settings → Environment Variables**, tempat yang sama kayak 5 lainnya):
   ```
   DASHBOARD_PASSWORD=password_rahasia_kalian
   ```
2. **Redeploy** — env var baru nggak kepakai kalau nggak redeploy (sama kayak catatan di step 5 di atas).
3. Buka URL Vercel kamu di browser, masukin password itu sekali. Password ke-simpen di browser/HP itu (localStorage) dan auto-login terus tiap buka lagi — **sampai 30 hari nggak dibuka** (otomatis minta password lagi), atau kamu logout manual lewat tombol ⎋ di pojok kanan atas.

Ini cuma satu password buat berdua (bukan akun per-orang) — cukup buat data pribadi berdua, jangan share password-nya ke orang lain karena siapapun yang tau bisa liat & ubah data tabungan kalian.

### Install sebagai App di Android (PWA)

Dashboard-nya sekarang bisa di-install jadi "app" beneran di HP Android — muncul icon 💗 di layar utama, buka full-screen tanpa address bar, kerasa kayak app biasa. Nggak perlu Play Store:

1. Buka URL Vercel kamu di **Chrome** Android, login pakai password seperti biasa.
2. Bakal muncul tombol **📲 Install** di pojok kanan atas dashboard — tap itu, konfirmasi, selesai. (Kalau tombolnya nggak muncul, buka menu titik-tiga Chrome → **Tambahkan ke layar Utama** / **Install app** manual.)
3. Buka dari icon di layar utama — jalan full-screen kayak app native.

Ini PWA (Progressive Web App), bukan file APK — jadi tetap 1 codebase yang sama dengan versi web/Vercel, update otomatis tiap kali kamu deploy ulang, nggak perlu build/install ulang apapun di HP.

---

## Testing Lokal

Nggak perlu deploy tiap kali mau tes — bot bisa jalan mode polling di komputer sendiri:

```bash
npm install
cp .env.example .env   # isi semua value-nya
npm run dev             # atau npm run dev:watch buat auto-restart pas save file
```

Bot lokal ini jalan berdampingan tanpa masalah sama versi Vercel (mereka pakai koneksi Telegram yang beda mode), tapi kalau dua-duanya nyala bersamaan bot bisa balas dobel — matiin salah satu pas testing.

---

## Kalau data lama masih ada

Project Supabase yang lama kemungkinan cuma ke-*pause* (bukan kehapus permanen) karena nggak diakses lama. Login ke [dashboard.supabase.com](https://dashboard.supabase.com), cek apakah project lama masih listed — kalau iya, tinggal di-resume dan datanya harusnya masih utuh. Kalau mau tetap pakai project Supabase yang sama (bukan bikin baru), cukup jalanin `schema_webhook_addon.sql` di project itu, lalu pakai `SUPABASE_URL`/`SUPABASE_KEY` yang lama.
