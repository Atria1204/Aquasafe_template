# AquaSafe

Sistem IoT untuk memantau kualitas air kolam (suhu, pH, oksigen terlarut/DO, TDS, debit air), mengatur pakan otomatis, dan melihat CCTV kolam secara live dari dashboard web.

## Arsitektur

```
ESP32 (sensor + feeder) ── HTTP POST /api/sensor/update ──►  Backend (Node.js, port 5000) ◄── Dashboard React
                        ── MQTT aquasafe/data/<deviceId> ──►         │                      (polling tiap 2 detik)
ESP32-CAM ── WebSocket /api/stream/input ─────────────────►         │ ── WebSocket /api/stream/output ──► modal CCTV
                                                                    ▼
                                                              MySQL (aquasafe_iot)
```

| Folder / file | Isi |
|---|---|
| `backend/server.js` | Seluruh API: login, data sensor, kontrol pakan, relay video CCTV, job per menit (simpan log, deteksi alat offline, rata-rata 24 jam) |
| `dashboard/` | Web dashboard (React + Vite + Tailwind + Recharts) |
| `database/schema.sql` | Struktur tabel. Otomatis dijalankan saat database pertama kali dibuat lewat Docker |
| `docker-compose.yml` | Menjalankan MQTT broker, MySQL, phpMyAdmin, backend, dan nginx untuk dashboard |
| `mosquitto.conf` | Konfigurasi MQTT broker |

## Cara menjalankan (Docker)

Yang dibutuhkan: Docker Desktop dan Node.js 20+.

```bash
# 1. Siapkan file rahasia
cp .env.example .env
#    lalu buka .env dan ganti semua password + JWT_SECRET

# 2. Build dashboard
cd dashboard
npm install
npm run build
cd ..

# 3. Jalankan semua service
docker compose up -d --build
```

Setelah itu:
- Dashboard: http://localhost
- API backend: http://localhost:5000
- phpMyAdmin: http://localhost:8080 (login pakai `DB_USER` / `DB_PASSWORD` dari `.env`)

Buka dashboard, klik **Daftar** untuk membuat akun, login, lalu tambahkan perangkat dengan ID yang sama seperti `deviceId` di firmware ESP32 (misal `AQUA-001`).

## Mode development (tanpa Docker untuk backend/dashboard)

```bash
# Backend (butuh MySQL & MQTT yang sudah jalan, misalnya: docker compose up -d db mqtt)
cd backend
cp .env.example .env     # isi DB_PASS & JWT_SECRET
npm install
npm start

# Dashboard
cd dashboard
npm install
npm run dev              # buka http://localhost:5173
```

Kalau backend ada di server lain/domain sendiri, buat `dashboard/.env` dan isi `VITE_API_URL=https://api.domainkamu.com`, lalu build ulang.

## Yang perlu dikirim dari ESP32

**Data sensor:** `POST /api/sensor/update`
```json
{ "deviceId": "AQUA-001",
  "data": { "suhu": 27.5, "ph": 7.1, "do": 6.2, "tds": 450, "flow1": 12.0, "flow2": 10.5,
            "sudahPakan1": 0, "sudahPakan2": 0, "pakanKosong": 0 } }
```
Balasannya berisi `data_pakan` (jadwal pagi/sore, gram, dan `sekarang` = 1 kalau ada perintah pakan manual).

**Reset pakan manual setelah servo selesai:** `POST /api/feeder/manual` dengan body `{ "deviceId": "AQUA-001", "action": 0, "gramManual": 70 }`.

**CCTV (ESP32-CAM):** WebSocket ke `/api/stream/input?deviceId=AQUA-001`. Kirim frame JPEG sebagai binary, dan dengarkan perintah teks `CMD:START` / `CMD:STOP`.

**Device key (opsional, disarankan kalau server dibuka ke internet):** isi `DEVICE_API_KEY` di `.env`. Setelah itu ESP32 wajib mengirim header `x-device-key: <key>`, dan ESP32-CAM menambahkan `&key=<key>` di URL WebSocket.

## Online-kan ke internet (opsional)

Secara default semuanya hanya bisa diakses dari jaringan lokal (WiFi yang sama). Supaya ESP32 dan dashboard bisa diakses dari mana saja, ada 3 komponen yang umum dipakai:

| Komponen | Fungsi | Wajib? |
|---|---|---|
| **Server** (mini PC/NUC, laptop yang selalu nyala, atau VPS) | Tempat menjalankan `docker compose` 24 jam | Ya |
| **Cloudflare Tunnel** | Menghubungkan domain (misal `api.domainkamu.com`) ke server tanpa perlu IP publik atau buka port router | Kalau mau diakses publik |
| **Tailscale** | VPN pribadi untuk remote server (SSH, phpMyAdmin) dari mana saja. Hanya perangkat yang login ke akun Tailscale yang sama yang bisa masuk | Opsional, untuk admin |

### Cloudflare Tunnel
1. Punya domain yang DNS-nya dikelola Cloudflare.
2. Di dashboard Cloudflare: **Zero Trust > Networks > Tunnels > Create a tunnel** (tipe *Cloudflared*). Salin **token**-nya ke `CLOUDFLARE_TUNNEL_TOKEN` di `.env`.
3. Di tab **Public Hostname** tunnel tersebut, tambahkan:
   - `api.domainkamu.com` → `http://backend:5000` (backend + WebSocket CCTV)
   - `domainkamu.com` → `http://frontend:80` (dashboard)
4. Buat `dashboard/.env` berisi `VITE_API_URL=https://api.domainkamu.com`, lalu `npm run build` ulang.
5. Jalankan dengan tunnel: `docker compose --profile tunnel up -d --build`
6. Di firmware ESP32, ganti URL server menjadi `https://api.domainkamu.com/...` dan WebSocket ESP32-CAM ke `api.domainkamu.com` (port 443, path `/api/stream/input`).

Jangan expose phpMyAdmin (8080) atau MySQL (3306) lewat tunnel. Untuk akses admin dari jauh, pakai Tailscale.

### Tailscale (opsional)
1. Install Tailscale di server dan di laptop kamu, login dengan akun yang sama.
2. Server akan dapat IP `100.x.y.z`. Dari laptop, dashboard bisa dibuka di `http://100.x.y.z` dan backend otomatis terdeteksi di `http://100.x.y.z:5000`.
3. Untuk phpMyAdmin lewat Tailscale, ubah port di `docker-compose.yml` dari `127.0.0.1:8080:80` menjadi `8080:80`.

## Keamanan

- Password user disimpan dalam bentuk hash (bcrypt), bukan teks asli.
- Semua endpoint dashboard wajib login (token JWT), dan user hanya bisa melihat/mengontrol kolam miliknya sendiri.
- Tanpa login, ESP32 hanya bisa mengirim data sensor dan perintah STOP pakan.
- MySQL & phpMyAdmin hanya bisa diakses dari komputer server (`127.0.0.1`).
- MQTT broker masih `allow_anonymous`. Jangan buka port 1883/9001 ke internet tanpa menambahkan password.
- Jangan pernah commit file `.env` (berisi password database, JWT_SECRET, dan token Cloudflare).
