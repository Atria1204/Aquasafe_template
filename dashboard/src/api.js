import { API_BASE_URL } from './config';

// Pembungkus fetch: otomatis menambahkan token login ke setiap request ke backend.
// Kalau token sudah kedaluwarsa (401), sesi dihapus dan halaman kembali ke login.
export async function apiFetch(path, options = {}) {
    const token = localStorage.getItem('token');
    const headers = { ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });

    if (res.status === 401 && token) {
        localStorage.removeItem('token');
        localStorage.removeItem('userId');
        localStorage.removeItem('userName');
        window.location.reload();
    }
    return res;
}
