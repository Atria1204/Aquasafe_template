const hostname = window.location.hostname;

// Kalau VITE_API_URL diisi (lihat dashboard/.env.example), pakai itu (misal https://api.domainkamu.com).
// Kalau kosong, otomatis pakai backend di komputer yang sama port 5000.
const envApiUrl = import.meta.env.VITE_API_URL?.replace(/\/$/, '');

export const API_BASE_URL = envApiUrl || `http://${hostname}:5000`;
export const WS_BASE_URL = API_BASE_URL.replace(/^http/, 'ws');
