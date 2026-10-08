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

## Keamanan

- Password user disimpan dalam bentuk hash (bcrypt), bukan teks asli.
- Semua endpoint dashboard wajib login (token JWT), dan user hanya bisa melihat/mengontrol kolam miliknya sendiri.
- Tanpa login, ESP32 hanya bisa mengirim data sensor dan perintah STOP pakan.
- MySQL & phpMyAdmin hanya bisa diakses dari komputer server (`127.0.0.1`).
- MQTT broker masih `allow_anonymous`. Jangan buka port 1883/9001 ke internet tanpa menambahkan password.
- Jangan pernah commit file `.env`.
