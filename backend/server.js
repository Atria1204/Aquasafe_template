require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mqtt = require('mqtt');
const mysql = require('mysql2');
const http = require('http');
const WebSocket = require('ws');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
// buat server HTTP terpisah agar bisa di-bridge ke WebSocket
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET;
// Kunci rahasia untuk ESP32 (opsional). Kalau diisi, alat wajib kirim header "x-device-key".
const DEVICE_API_KEY = process.env.DEVICE_API_KEY || '';

if (!JWT_SECRET) {
    console.error('❌ JWT_SECRET belum diisi di file .env! Server dihentikan.');
    process.exit(1);
}

app.use(cors());
app.use(express.json());

// =================================================================
// KONEKSI KE DATABASE MYSQL (DOCKER)
// =================================================================
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    dateStrings: true
});

console.log('✅ Database MySQL Pool Siap Digunakan!');

let currentData = {};

// Fungsi Helper untuk mendeteksi event pakan/stok dan mencatatnya ke log
const checkAndLogEvents = (deviceId, newData) => {
    const prevData = currentData[deviceId] || {};

    if (!newData) return;

    // --- OVERRIDE STATUS DARI MEMORI HARIAN (AGAR TIDAK KEMBALI "BELUM") ---
    if (prevData.memoriSudahPagi) newData.sudahPakan1 = 1;
    if (prevData.memoriSudahSore) newData.sudahPakan2 = 1;

    // 1. Cek Jadwal Pagi (berubah dari belum -> sudah)
    const newPagi = newData.sudahPakan1 === 1 || newData.sudahPakan1 === true;
    const prevPagi = prevData.sudahPakan1 === 1 || prevData.sudahPakan1 === true;
    if (newPagi && !prevPagi) {
        db.query('INSERT INTO pakan_logs (device_id, jenis_trigger, jumlah_gram) VALUES (?, ?, (SELECT gram_pagi FROM Pakan WHERE device_id = ? LIMIT 1))', [deviceId, 'Jadwal Pagi', deviceId]);

        if (currentData[deviceId]) currentData[deviceId].memoriSudahPagi = true;

        console.log(`📝 Log Event: ${deviceId} berhasil diberi pakan (Jadwal Pagi)`);
    }

    // 2. Cek Jadwal Sore (berubah dari belum -> sudah)
    const newSore = newData.sudahPakan2 === 1 || newData.sudahPakan2 === true;
    const prevSore = prevData.sudahPakan2 === 1 || prevData.sudahPakan2 === true;
    if (newSore && !prevSore) {
        db.query('INSERT INTO pakan_logs (device_id, jenis_trigger, jumlah_gram) VALUES (?, ?, (SELECT gram_sore FROM Pakan WHERE device_id = ? LIMIT 1))', [deviceId, 'Jadwal Sore', deviceId]);

        if (currentData[deviceId]) currentData[deviceId].memoriSudahSore = true;
        console.log(`📝 Log Event: ${deviceId} berhasil diberi pakan (Jadwal Sore)`);
    }

    // 3. Cek Stok Pakan (IR Sensor mendeteksi habis)
    const newKosong = newData.pakanKosong === 1 || newData.pakanKosong === true;
    const prevKosong = prevData.pakanKosong === 1 || prevData.pakanKosong === true;
    if (newKosong && !prevKosong) {
        db.query('INSERT INTO device_logs (device_id, status) VALUES (?, ?)', [deviceId, 'STOK PAKAN HABIS']);
        console.log(`🚨 Log Event: Stok pakan habis pada ${deviceId}`);
    }
};

// =================================================================
// SISTEM AUTENTIKASI
// =================================================================

// JALUR REGISTER (DAFTAR)
app.post('/api/register', async (req, res) => {
    const { nama, email, password } = req.body;

    if (!nama || !email || !password) {
        return res.status(400).json({ success: false, message: 'Nama, Email, & Password wajib diisi!' });
    }

    try {
        // Password di-hash dulu, jadi yang tersimpan di database bukan password aslinya
        const hash = await bcrypt.hash(password, 10);
        await db.promise().query('INSERT INTO users (nama, email, password) VALUES (?, ?, ?)', [nama, email, hash]);
        res.json({ success: true, message: 'Berhasil daftar! Silakan login.' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ success: false, message: 'Email sudah terdaftar!' });
        }
        console.error('❌ Gagal register:', err);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan server' });
    }
});

// JALUR LOGIN (MASUK)
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email & Password wajib diisi!' });
    }

    try {
        const [results] = await db.promise().query('SELECT id, nama, password FROM users WHERE email = ?', [email]);
        const user = results[0];

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ success: false, message: 'Email atau Password salah!' });
        }

        // Token ini yang dipakai dashboard untuk membuktikan siapa yang sedang login
        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, message: 'Berhasil masuk!', token, userId: user.id, nama: user.nama });
    } catch (err) {
        console.error('❌ Gagal login:', err);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan server' });
    }
});

// Membaca userId dari token JWT (header "Authorization: Bearer <token>"). null kalau tidak valid.
const getUserIdFromToken = (token) => {
    try {
        return jwt.verify(token, JWT_SECRET).userId;
    } catch {
        return null;
    }
};

// Middleware: endpoint dashboard wajib login
const requireAuth = (req, res, next) => {
    const header = req.headers.authorization || '';
    const userId = header.startsWith('Bearer ') ? getUserIdFromToken(header.slice(7)) : null;
    if (!userId) {
        return res.status(401).json({ success: false, message: 'Silakan login terlebih dahulu' });
    }
    req.userId = userId;
    next();
};

// Cek apakah kolam (deviceId) ini memang milik user yang login
const isDeviceOwner = async (userId, deviceId) => {
    const [rows] = await db.promise().query('SELECT 1 FROM devices WHERE device_id = ? AND user_id = ?', [deviceId, userId]);
    return rows.length > 0;
};

// Middleware: user hanya boleh mengakses kolam miliknya sendiri
// deviceId diambil dari URL (/:deviceId) atau dari body request
const requireDeviceOwner = async (req, res, next) => {
    const deviceId = req.params.deviceId || req.body?.deviceId;
    try {
        if (!deviceId || !(await isDeviceOwner(req.userId, deviceId))) {
            return res.status(403).json({ success: false, message: 'Perangkat tidak ditemukan atau bukan milik Anda' });
        }
        next();
    } catch (err) {
        console.error('❌ Gagal cek pemilik perangkat:', err);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan server' });
    }
};

// Cek kunci alat (ESP32). Kalau DEVICE_API_KEY kosong, semua alat diterima.
const isValidDeviceKey = (key) => !DEVICE_API_KEY || key === DEVICE_API_KEY;

const requireDeviceKey = (req, res, next) => {
    if (!isValidDeviceKey(req.headers['x-device-key'])) {
        return res.status(401).json({ success: false, message: 'Device key salah' });
    }
    next();
};

// JALUR HTTP CLOUDFLARE (BUAT ESP32)
app.post('/api/sensor/update', requireDeviceKey, (req, res) => {
    const { deviceId, data } = req.body;

    if (!currentData[deviceId]) {
        currentData[deviceId] = { suhu: 0, ph: 7.0, do: 0, tds: 0, flow1: 0, flow2: 0, lastUpdated: Date.now() };
    }

    if (data && data.ph !== undefined) {
        if (data.ph < 4.0 || data.ph > 9.0) {
            // Anomali terdeteksi: abaikan data baru, pakai data terakhir yang valid
            data.ph = currentData[deviceId].ph;
        }
    }

    console.log(`[${new Date().toLocaleString('id-ID')}] Data HTTP Masuk [${deviceId}]:`, data);

    // --- CEK DAN CATAT LOG EVENT (JADWAL & STOK) ---
    checkAndLogEvents(deviceId, data);

    currentData[deviceId] = { ...currentData[deviceId], ...data, lastUpdated: Date.now() };

    // Balas ESP32 dengan jadwal & gram pakan terbaru dari database
    db.query('SELECT * FROM Pakan WHERE device_id = ?;', [deviceId], (err, result) => {
        if (err) {
            console.error(`❌ Gagal mengambil data pakan:`, err);
            return res.json({ success: true, message: "Data tersimpan, tapi gagal ambil pakan", data_pakan: null });
        }

        const datapakan = result.length > 0 ? result[0] : null;
        res.json({ success: true, message: "Data berhasil tersimpan", data_pakan: datapakan });
    });
});

// JALUR MQTT LOKAL (CADANGAN)
const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883');
mqttClient.on('error', (err) => console.error('❌ MQTT lokal error:', err.message));
mqttClient.on('connect', () => {
    console.log('✅ Terhubung ke MQTT Broker Lokal!');
    mqttClient.subscribe('aquasafe/data/+', (err) => {
        if (!err) console.log('📡 Menunggu aliran data MQTT...');
    });
});

// JALUR MQTT PUBLIK (OPSIONAL, KHUSUS KONTROL KAMERA LINTAS JARINGAN)
// Broker publik bisa dibaca siapa saja, jadi hanya aktif kalau PUBLIC_MQTT_URL diisi di .env
const publicMqttClient = process.env.PUBLIC_MQTT_URL ? mqtt.connect(process.env.PUBLIC_MQTT_URL) : null;
if (publicMqttClient) {
    publicMqttClient.on('connect', () => {
        console.log('✅ Terhubung ke MQTT Broker Publik untuk Kamera!');
    });
}

mqttClient.on('message', (topic, message) => {
    try {
        const data = JSON.parse(message.toString());
        const deviceId = topic.split('/')[2];

        if (!currentData[deviceId]) {
            currentData[deviceId] = { suhu: 0, ph: 7.0, do: 0, tds: 0, flow1: 0, flow2: 0, flow3: 0, flow4: 0, pakansekarang: 0, lastUpdated: Date.now() };
        }

        if (data && data.ph !== undefined) {
            if (data.ph < 4.0 || data.ph > 9.0) {
                // Anomali terdeteksi: abaikan data baru, pakai data terakhir yang valid
                data.ph = currentData[deviceId].ph;
            }
        }

        // --- CEK DAN CATAT LOG EVENT (JADWAL & STOK) ---
        checkAndLogEvents(deviceId, data);

        currentData[deviceId] = { ...currentData[deviceId], ...data, lastUpdated: Date.now() };
    } catch (error) {
        console.error('❌ Kesalahan parsing JSON MQTT:', error.message);
    }
});


// =================================================================
// ENDPOINT API UNTUK FRONTEND
// =================================================================

// Semua endpoint di bawah ini khusus dashboard, jadi wajib login.
// userId selalu diambil dari token, bukan dari URL, supaya user tidak bisa mengintip data orang lain.
app.get('/api/devices', requireAuth, (req, res) => {
    db.query('SELECT device_id, nama_kolam FROM devices WHERE user_id = ?', [req.userId], (err, results) => {
        if (err) return res.status(500).json({ error: 'Gagal mengambil daftar perangkat' });
        res.json(results);
    });
});

// Status live semua kolam milik user yang login (dipakai untuk mengurutkan kolam di header)
app.get('/api/status/all', requireAuth, (req, res) => {
    db.query('SELECT device_id FROM devices WHERE user_id = ?', [req.userId], (err, results) => {
        if (err) return res.status(500).json({ error: 'Gagal mengambil status perangkat' });

        const statuses = {};
        results.forEach(({ device_id }) => {
            if (currentData[device_id]) statuses[device_id] = currentData[device_id];
        });
        res.json(statuses);
    });
});

app.post('/api/devices', requireAuth, (req, res) => {
    const { device_id, nama_kolam } = req.body;
    if (!device_id) {
        return res.status(400).json({ success: false, message: 'ID Perangkat wajib diisi!' });
    }

    const sql = 'INSERT INTO devices (device_id, user_id, nama_kolam) VALUES (?, ?, ?)';

    db.query(sql, [device_id, req.userId, nama_kolam], (err, results) => {
        if (err) {
            if (err.code === 'ER_DUP_ENTRY') {
                console.error(`❌ Gagal: Device ID [${device_id}] sudah ada.`);
                return res.status(400).json({ success: false, message: 'ID Perangkat sudah terdaftar atau sedang digunakan!' });
            }
            // Kalau error database lain:
            console.error('❌ Gagal tambah perangkat:', err);
            return res.status(500).json({ success: false, message: 'Gagal menambah perangkat' });
        }

        if (!currentData[device_id]) {
            currentData[device_id] = { suhu: 0, ph: 0, do: 0, tds: 0, flow1: 0, flow2: 0, flow3: 0, flow4: 0 };
        }
        res.json({ success: true, message: "Perangkat berhasil didaftarkan" });
    });
});

app.put('/api/devices/:deviceId', requireAuth, requireDeviceOwner, (req, res) => {
    const deviceId = req.params.deviceId;
    const { nama_kolam } = req.body;

    const sql = 'UPDATE devices SET nama_kolam = ? WHERE device_id = ?';

    db.query(sql, [nama_kolam, deviceId], (err, result) => {
        if (err) {
            console.error('Gagal update nama:', err);
            return res.status(500).json({ success: false, message: 'Gagal update nama perangkat' });
        }

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Device tidak ditemukan' });
        }

        res.json({ success: true, message: 'Nama kolam berhasil diubah!' });
    });
});

app.delete('/api/devices/:deviceId', requireAuth, requireDeviceOwner, async (req, res) => {
    const deviceId = req.params.deviceId;

    try {
        // Hapus jadwal pakan
        await db.promise().query('DELETE FROM Pakan WHERE device_id = ?', [deviceId]);

        // Hapus dari sensor_logs
        await db.promise().query('DELETE FROM sensor_logs WHERE device_id = ?', [deviceId]);

        // Hapus dari pakan_logs
        await db.promise().query('DELETE FROM pakan_logs WHERE device_id = ?', [deviceId]);

        // Hapus dari device_logs
        await db.promise().query('DELETE FROM device_logs WHERE device_id = ?', [deviceId]);

        // Hapus perangkat dari tabel devices
        const [result] = await db.promise().query('DELETE FROM devices WHERE device_id = ?', [deviceId]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Perangkat tidak ditemukan' });
        }

        delete currentData[deviceId];
        res.json({ success: true, message: 'Perangkat berhasil dihapus beserta log terkait!' });
    } catch (err) {
        console.error('Gagal hapus perangkat:', err);
        res.status(500).json({ success: false, message: 'Gagal hapus perangkat' });
    }
});



app.get('/api/sensor/:deviceId', requireAuth, requireDeviceOwner, (req, res) => {
    const deviceId = req.params.deviceId;

    // Fungsi helper untuk mengambil data pakan dari DB dan mengirim response gabungan
    const sendSensorWithPakan = (sensorData) => {
        db.query('SELECT pagi, sore, sekarang, gram_pagi, gram_sore, gram_manual FROM Pakan WHERE device_id = ?', [deviceId], (err, pakanResults) => {
            const pakan = pakanResults && pakanResults.length > 0 ? pakanResults[0] : {
                pagi: '08:00',
                sore: '16:00',
                sekarang: 0,
                gram_pagi: 70,
                gram_sore: 70,
                gram_manual: 70
            };
            res.json({
                ...sensorData,
                pakan: pakan
            });
        });
    };

    // Jika data di memori sudah ada dan valid, langsung gabungkan dengan pakan dan kirim
    if (currentData[deviceId] && currentData[deviceId].lastUpdated) {
        return sendSensorWithPakan(currentData[deviceId]);
    }

    // Jika memori kosong (misal karena backend baru restart), ambil dari database
    db.query('SELECT * FROM sensor_logs WHERE device_id = ? ORDER BY id DESC LIMIT 1', [deviceId], (err, results) => {
        if (err || results.length === 0) {
            const defaultSensor = currentData[deviceId] || { suhu: 0, ph: 0, do: 0, tds: 0, flow1: 0, flow2: 0 };
            return sendSensorWithPakan(defaultSensor);
        }

        const row = results[0];
        // Masukkan data terakhir dari database ke memori agar alat tidak dikira 0
        currentData[deviceId] = {
            ...currentData[deviceId],
            suhu: row.suhu,
            ph: row.ph,
            do: row.do_level,
            tds: row.tds,
            flow1: row.flow1,
            flow2: row.flow2,
            lastUpdated: row.waktu ? new Date(row.waktu.replace(' ', 'T') + '+07:00').getTime() : Date.now(),
            lastLoggedSensorTime: Date.now()
        };

        sendSensorWithPakan(currentData[deviceId]);
    });
});


app.get('/api/history/:deviceId', requireAuth, requireDeviceOwner, (req, res) => {
    const deviceId = req.params.deviceId;
    const dateFilter = req.query.date;

    let sql = 'SELECT * FROM sensor_logs WHERE device_id = ?';
    let params = [deviceId];

    if (dateFilter) {
        sql += ' AND DATE(waktu) = ?';
        params.push(dateFilter);
        sql += ' ORDER BY id DESC LIMIT 1500';
    } else {
        sql += ' ORDER BY id DESC LIMIT 400';
    }

    db.query(sql, params, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.get('/api/pakan/:deviceId', requireAuth, requireDeviceOwner, (req, res) => {
    const deviceId = req.params.deviceId;

    db.query('SELECT * FROM Pakan WHERE device_id = ?;', [deviceId], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });

        if (results.length > 0) {
            res.json(results[0]);
        } else {
            res.json({ device_id: deviceId, pagi: '08:00', sore: '16:00', sekarang: 0, gram_pagi: 70, gram_sore: 70, gram_manual: 70 });
        }
    });
});


// =================================================================
// JALUR KONTROL AUTO-FEEDER (DARI WEB KE ALAT)
// =================================================================
// Kirim perintah ke alat lewat MQTT (jalur tambahan).
// Jalur utama tetap database: ESP32 membaca jadwal & perintah dari balasan /api/sensor/update,
// jadi kalau MQTT sedang mati, perintah tetap sampai ke alat.
const sendKontrolMqtt = (topic, payload) => {
    if (!mqttClient.connected) {
        console.log(`⚠️ MQTT tidak terhubung, perintah hanya disimpan di database [${topic}]`);
        return;
    }
    mqttClient.publish(topic, payload, (err) => {
        if (err) console.error(`❌ Gagal kirim MQTT [${topic}]:`, err);
        else console.log(`✅ Perintah terkirim via MQTT [${topic}]:`, payload);
    });
};

app.post('/api/feeder/schedule', requireAuth, requireDeviceOwner, async (req, res) => {
    const { deviceId, jadwalPagi, jadwalSore, gramPagi, gramSore } = req.body;

    const payload = JSON.stringify({
        perintah: "SET_JADWAL",
        pagi: jadwalPagi,
        sore: jadwalSore
    });

    sendKontrolMqtt(`aquasafe/kontrol/${deviceId}/feeder`, payload);

    try {
        // LOGIKA: Cek dulu datanya ada atau kosong
        const [results] = await db.promise().query('SELECT id FROM Pakan WHERE device_id = ?;', [deviceId]);
        if (results.length > 0) {
            // Kalau ada isinya, kita UPDATE
            await db.promise().query('UPDATE Pakan SET pagi = ?, sore = ?, gram_pagi = ? , gram_sore = ? WHERE device_id = ?;', [jadwalPagi, jadwalSore, gramPagi, gramSore, deviceId]);
        } else {
            // Kalau KOSONG, kita bikin baris BARU
            await db.promise().query('INSERT INTO Pakan (device_id, pagi, sore, sekarang, gram_pagi, gram_sore, gram_manual) VALUES (?, ?, ?, 0, ?, ?, 70)', [deviceId, jadwalPagi, jadwalSore, gramPagi, gramSore]);
        }
        res.json({ success: true, message: 'Jadwal dan gram pakan berhasil di-set!' });
    } catch (err) {
        console.error('❌ Gagal simpan jadwal pakan:', err);
        res.status(500).json({ success: false, message: 'Gagal menyimpan jadwal pakan' });
    }
});

// Endpoint ini dipanggil dari 2 tempat:
// - Dashboard (pakai token login) untuk menyalakan/mematikan pakan manual
// - ESP32 (tanpa token) untuk me-reset status jadi 0 setelah servo selesai
// Tanpa token login, hanya perintah STOP (action 0) yang diizinkan.
const allowUserOrDeviceStop = (req, res, next) => {
    if (req.headers.authorization) {
        return requireAuth(req, res, () => requireDeviceOwner(req, res, next));
    }
    if (req.body?.action !== 0) {
        return res.status(401).json({ success: false, message: 'Silakan login terlebih dahulu' });
    }
    requireDeviceKey(req, res, next);
};

app.post('/api/feeder/manual', allowUserOrDeviceStop, async (req, res) => {
    const { deviceId, action, gramManual } = req.body; // action: 1 (On) or 0 (Off)

    // Perintah manual feed ke ESP32
    const payload = JSON.stringify({
        perintah: action === 1 ? "BERI_MAKAN_SEKARANG" : "BERHENTI_MAKAN",
        sekarang: action,
        gram: gramManual
    });

    sendKontrolMqtt(`aquasafe/kontrol/${deviceId}/feeder`, payload);

    try {
        // Update database jadi 1 atau 0 sesuai tombol yang dipencet
        await db.promise().query('UPDATE Pakan SET sekarang = ?, gram_manual = ? WHERE device_id = ?;', [action, gramManual, deviceId]);

        // Catat ke Log Pakan Riwayat Manual
        if (action === 1) {
            await db.promise().query('INSERT INTO pakan_logs (device_id, jenis_trigger, jumlah_gram) VALUES (?, ?, ?)', [deviceId, 'Manual (Aplikasi)', gramManual]);
            console.log(`📝 Log Event: ${deviceId} diberi pakan MANUAL sebanyak ${gramManual}g`);
        }

        res.json({ success: true, message: action === 1 ? 'Alat MENYALA!' : 'Alat BERHENTI!' });
    } catch (err) {
        console.error('❌ Gagal simpan perintah pakan manual:', err);
        res.status(500).json({ success: false, message: 'Gagal mengirim sinyal ke alat' });
    }
});


// =================================================================
// BACKGROUND JOB: MENGHITUNG RATA-RATA 24 JAM
// =================================================================
// Fungsi ini berjalan diam-diam setiap 1 menit untuk merekap nilai rata-rata tiap device
const runBackgroundJob = () => {
    // --- SYNC MEMORI HARIAN DARI DATABASE (Mengatasi restart & reset jam 00:00) ---
    db.query('SELECT device_id, jenis_trigger FROM pakan_logs WHERE DATE(waktu) = CURDATE()', (err, results) => {
        if (!err) {
            // Reset memori harian terlebih dahulu (saat pergantian hari jam 00:00)
            Object.keys(currentData).forEach(id => {
                currentData[id].memoriSudahPagi = false;
                currentData[id].memoriSudahSore = false;
            });
            // Timpa memori dengan data aktual dari database hari ini
            results.forEach(row => {
                if (!currentData[row.device_id]) {
                    currentData[row.device_id] = {};
                }
                if (row.jenis_trigger === 'Jadwal Pagi') {
                    currentData[row.device_id].memoriSudahPagi = true;
                    currentData[row.device_id].sudahPakan1 = 1;
                }
                if (row.jenis_trigger === 'Jadwal Sore') {
                    currentData[row.device_id].memoriSudahSore = true;
                    currentData[row.device_id].sudahPakan2 = 1;
                }
            });
        }
    });

    const deviceIds = Object.keys(currentData);
    if (deviceIds.length === 0) return;

    const currentTime = Date.now();

    deviceIds.forEach(deviceId => {
        const cData = currentData[deviceId];

        // --- LOG SENSOR SNAPSHOT TO DATABASE ONCE EVERY 1 MINUTE ---
        const lastLogTime = cData.lastLoggedSensorTime || 0;
        if (cData.lastUpdated && cData.lastUpdated > lastLogTime) {
            const sql = `INSERT INTO sensor_logs (device_id, suhu, ph, do_level, tds, flow1, flow2) VALUES (?, ?, ?, ?, ?, ?, ?)`;
            const values = [deviceId, cData.suhu, cData.ph, cData.do, cData.tds, cData.flow1, cData.flow2];

            db.query(sql, values, (err) => {
                if (err) {
                    console.error(`❌ Gagal mencatat log DB [${deviceId}]:`, err.message);
                } else {
                    cData.lastLoggedSensorTime = currentTime; // Track last logged timestamp
                }
            });
        }

        // --- CEK LOG OFFLINE / ONLINE ---
        if (cData.lastUpdated && (currentTime - cData.lastUpdated > 300000)) {
            // Alat terdeteksi mati (tidak ada kabar > 5 menit)
            if (!cData.isLoggedOffline) {
                db.query('INSERT INTO device_logs (device_id, status) VALUES (?, ?)', [deviceId, 'ALAT OFFLINE']);
                cData.isLoggedOffline = true;
                console.log(`🚨 Log Event: ${deviceId} OFFLINE`);
            }
        } else {
            // Alat aktif / baru saja update
            if (cData.isLoggedOffline) {
                db.query('INSERT INTO device_logs (device_id, status) VALUES (?, ?)', [deviceId, 'ALAT ONLINE KEMBALI']);
                cData.isLoggedOffline = false;
                console.log(`✅ Log Event: ${deviceId} ONLINE KEMBALI`);
            }
        }

        const query = `
            SELECT 
                AVG(suhu) as avg_suhu, MIN(suhu) as min_suhu, MAX(suhu) as max_suhu,
                AVG(ph) as avg_ph, MIN(ph) as min_ph, MAX(ph) as max_ph,
                AVG(do_level) as avg_do, MIN(do_level) as min_do, MAX(do_level) as max_do,
                AVG(tds) as avg_tds, MIN(tds) as min_tds, MAX(tds) as max_tds,
                AVG(flow1) as avg_flow1, MIN(flow1) as min_flow1, MAX(flow1) as max_flow1,
                AVG(flow2) as avg_flow2, MIN(flow2) as min_flow2, MAX(flow2) as max_flow2
            FROM sensor_logs 
            WHERE device_id = ? AND waktu >= NOW() - INTERVAL 24 HOUR
        `;

        db.query(query, [deviceId], (err, results) => {
            if (!err && results.length > 0 && currentData[deviceId]) {
                // Sisipkan data rata-rata langsung ke memory server
                currentData[deviceId].avg24h = results[0];
            }
        });
    });
};

setInterval(runBackgroundJob, 60000); // 60000 ms = 1 menit
setTimeout(runBackgroundJob, 2000); // Eksekusi awal 2 detik setelah server hidup

// =================================================================
// SISTEM CCTV (WEBSOCKETS KONTROL ON/OFF & SINKRONISASI GLOBAL)
// =================================================================
// STRUKTUR PENAMPUNG MULTI-KAMERA (DENGAN PER-USER AUTO SHUTDOWN)
// =================================================================
const esp32Sockets = new Map(); // Map<deviceId, WebSocket>
const viewersMap = new Map();   // Map<deviceId, Set<WebSocket>>
const cameraStreamingStates = new Map(); // Map<deviceId, boolean>

function broadcastEspStatus(deviceId) {
    const isReady = esp32Sockets.has(deviceId);
    const isStreaming = cameraStreamingStates.get(deviceId) || false;

    const viewers = viewersMap.get(deviceId);
    if (viewers) {
        const statusMsg = JSON.stringify({
            type: "ESP_STATUS",
            isReady,
            isStreaming
        });
        for (let viewer of viewers) {
            if (viewer.readyState === WebSocket.OPEN) {
                viewer.send(statusMsg);
            }
        }
    }
}

wss.on('connection', async (ws, req) => {

    const parsedUrl = new URL(req.url, 'http://localhost');
    const pathname = parsedUrl.pathname;
    const deviceId = parsedUrl.searchParams.get('deviceId') || 'AQUA-001';
    ws.alive = true;

    // ESP32-CAM: cek device key (dari query ?key=... atau header x-device-key)
    if (pathname === '/api/stream/input') {
        const key = parsedUrl.searchParams.get('key') || req.headers['x-device-key'];
        if (!isValidDeviceKey(key)) {
            console.log(`⛔ [CCTV] Koneksi kamera ${deviceId} ditolak: device key salah`);
            return ws.close(1008, 'Device key salah');
        }
    }

    // Penonton dashboard: wajib login (?token=...) dan hanya boleh menonton kolam miliknya
    if (pathname === '/api/stream/output') {
        const userId = getUserIdFromToken(parsedUrl.searchParams.get('token'));
        let allowed = false;
        try {
            allowed = !!userId && await isDeviceOwner(userId, deviceId);
        } catch (err) {
            console.error('❌ [CCTV] Gagal cek pemilik perangkat:', err);
        }
        if (!allowed) {
            return ws.close(1008, 'Tidak diizinkan');
        }
    }

    ws.on("error", (err) => {
        ws.alive = false;
        console.error(`📷 [CCTV] Error koneksi ESP32-CAM untuk device ${deviceId}:`, err.message);
        ws.close();
    })

    ws.on("pong", () => {
        ws.alive = true; // Tanda OK
    });

    ws.on("ping", () => {
        ws.alive = true; // Tanda ESP32 Standby masih hidup
    });

    if (pathname === '/api/stream/input') {
        console.log(`📷 [CCTV] ESP32-CAM untuk device ${deviceId} berhasil terhubung!`);

        // Putuskan koneksi lama jika ada untuk deviceId ini
        if (esp32Sockets.has(deviceId)) {
            const oldWs = esp32Sockets.get(deviceId);
            oldWs.close();
        }

        esp32Sockets.set(deviceId, ws);
        broadcastEspStatus(deviceId);

        ws.on('message', (message) => {
            ws.alive = true;
            // Forward binary frame ke semua viewers untuk deviceId ini
            const viewers = viewersMap.get(deviceId);
            if (viewers) {
                for (let viewer of viewers) {
                    if (viewer.readyState === WebSocket.OPEN) {
                        viewer.send(message);
                    }
                }
            }
        });



        ws.on('close', () => {
            // Hanya hapus dan update dashboard JIKA socket yang mati adalah socket yang sedang aktif
            if (esp32Sockets.get(deviceId) === ws) {
                console.log(`📷 [CCTV] Koneksi ESP32-CAM untuk device ${deviceId} benar-benar terputus!`);
                esp32Sockets.delete(deviceId);
                cameraStreamingStates.set(deviceId, false);
                broadcastEspStatus(deviceId);
            } else {
                console.log(`🧹 [BACKEND] Ghost socket untuk ${deviceId} berhasil dibersihkan diam-diam.`);
            }
        });

    }
    else if (pathname === '/api/stream/output') {
        if (!viewersMap.has(deviceId)) {
            viewersMap.set(deviceId, new Set());
        }
        const viewers = viewersMap.get(deviceId);
        viewers.add(ws);

        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: "ESP_STATUS",
                isReady: esp32Sockets.has(deviceId),
                isStreaming: cameraStreamingStates.get(deviceId) || false
            }));
        }

        ws.on('close', () => {
            viewers.delete(ws);
            if (viewers.size === 0) {
                viewersMap.delete(deviceId);
                // === AUTO SHUTDOWN JIKA SUDAH TIDAK ADA PENONTON ===
                if (cameraStreamingStates.get(deviceId) === true) {
                    console.log(`🔌 [CCTV] Tidak ada penonton aktif untuk ${deviceId}. Menghentikan stream kamera.`);
                    cameraStreamingStates.set(deviceId, false);

                    const camWs = esp32Sockets.get(deviceId);
                    if (camWs && camWs.readyState === WebSocket.OPEN) {
                        camWs.send("CMD:STOP");
                    }
                    broadcastEspStatus(deviceId);
                }
            }
        });
    } else {
        ws.close();
    }
});

app.post('/api/kamera/toggle', requireAuth, requireDeviceOwner, (req, res) => {
    const { action, deviceId: reqDeviceId } = req.body; // action: "ON" atau "OFF"
    const deviceId = reqDeviceId || 'AQUA-001';

    console.log(`\n=========================================`);
    console.log(`[BACKEND] Menerima perintah dari web untuk ${deviceId}: ${action}`);

    // Topik MQTT disesuaikan dengan ID Kolam (Misal: aquasafe/kamera/AQUA-001/kontrol)
    const topic = `aquasafe/kamera/${deviceId}/kontrol`;

    // 1. Kirim via MQTT publik (cadangan, hanya kalau PUBLIC_MQTT_URL diisi)
    if (publicMqttClient) {
        publicMqttClient.publish(topic, action, (err) => {
            if (err) console.error(`❌ Gagal mengirim MQTT ke ${topic}:`, err);
        });
    }

    // 2. KIRIM LANGSUNG VIA WEBSOCKET KE ESP32-CAM
    const camWs = esp32Sockets.get(deviceId);
    if (camWs && camWs.readyState === WebSocket.OPEN) {
        const cmd = action === "ON" ? "CMD:START" : "CMD:STOP";
        camWs.send(cmd);
        console.log(`✉️ Berhasil mengirim perintah WebSocket ke ESP32 (${deviceId}): ${cmd}`);
    } else {
        console.log(`⚠️ ESP32-CAM untuk ${deviceId} tidak terhubung ke WebSocket backend!`);
    }

    cameraStreamingStates.set(deviceId, action === "ON");
    broadcastEspStatus(deviceId);

    res.json({ success: true, message: `Perintah ${action} untuk ${deviceId} diproses!` });
});

setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.alive) {
            ws.terminate();
            console.log(`[BACKEND] Mematikan klien yang tidak aktif`);
        } else {
            ws.alive = false;
            ws.ping();
        }
    })
}, 20000);

server.listen(PORT, () => {
    console.log(`🚀 Server Backend Multi-Device berjalan pada port ${PORT} (Dengan WebSockets)`);
});