# 🗄️ Telegram Vault Personal Bot 

Bot penyimpanan awan pribadi tanpa batas berbasis **Node.js & Telegraf**. Versi ini dirancang khusus untuk penggunaan personal/teman tanpa fitur berat Google Drive, sehingga **sangat ringan (<25 MB RAM)** dan **siap online 24 jam nonstop di Cloud Gratis (Render / Railway / Koyeb) atau di laptop lokal**.

---

## 🌟 Fitur Utama
1. **📁 Sistem Folder Cerdas & Otomatis:**
   - Kelola folder langsung lewat chat Telegram (`/folders`, `/mkdir <nama>`, `/use <nama>`).
   - Setiap folder otomatis memiliki Tagar unik (`#Folder_NamaFolder`) dan Pinned Divider di Channel.
2. **📲 Direct Media Storage:**
   - Kirim Foto, Video, Dokumen, Lagu, atau Voice Note langsung ke bot.
   - File otomatis disalin ke Private Channel dengan format caption rapi dan ukuran file.
3. **🔒 Keamanan & Auto-Pairing:**
   - Jika `OWNER_CHAT_ID` di `.env` dikosongkan, bot otomatis mengenali dan mengunci aksesnya ke orang pertama yang menekan `/start`! Orang lain yang mencoba chat akan otomatis ditolak.
4. **🌐 Cloud Ready (Healthcheck Endpoint):**
   - Dilengkapi web server Express bawaan di port 3000 (`/health`) sehingga langsung lolos verifikasi deploy di Render, Railway, atau Koyeb.

---

## 🚀 Cara Menjalankan

### 1. Isi Konfigurasi di file `.env`
Buka file `.env` dan isi 2 variabel utama:
```env
TELEGRAM_BOT_TOKEN=token_dari_botfather
STORAGE_CHANNEL_ID=-100xxxxxxxxxx
```

### 2. Jalankan di Komputer Lokal
1. Buka folder ini di Terminal / Command Prompt.
2. Install dependency (cukup sekali):
   ```bash
   npm install
   ```
3. Jalankan bot:
   ```bash
   npm start
   ```
   *(Atau di Windows cukup klik dua kali file `run.bat`)*

---

## ☁️ Cara Deploy Gratis 24/7 ke Render.com

Karena bot ini murni Telegram (tidak mengunduh file besar dari Google Drive ke server), bot ini **100% aman dan gratis** dijalankan di Render.com:

1. Upload / Push folder ini ke akun GitHub kamu (jadikan repository baru, misal: `vault-bot-budi`).
2. Buka [dashboard.render.com](https://dashboard.render.com/) > Klik **New +** > **Web Service**.
3. Hubungkan ke repository GitHub tadi.
4. Setel konfigurasi:
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** `Free`
5. Di bagian **Environment Variables**, tambahkan:
   - `TELEGRAM_BOT_TOKEN` = (Token bot dari BotFather)
   - `STORAGE_CHANNEL_ID` = (ID Channel Private)
6. Klik **Create Web Service**. Bot akan langsung aktif 24 jam nonstop di cloud!
