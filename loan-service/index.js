require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const swaggerUi = require('swagger-ui-express');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CATALOG_URL = process.env.CATALOG_SERVICE_URL || 'http://localhost:3001';

// Inisialisasi Database Relasional Lokal (SQLite)
const db = new sqlite3.Database('./library_loans.db');
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS loans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id TEXT NOT NULL,
      book_title TEXT NOT NULL,
      borrower_name TEXT NOT NULL,
      borrower_nim TEXT NOT NULL,
      borrow_date TEXT NOT NULL,
      due_date TEXT NOT NULL,
      return_date TEXT,
      status TEXT DEFAULT 'BORROWED'
    )
  `);
});

// Helper Promise untuk SQLite
const runQuery = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });

const getQuery = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });

const allQuery = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });

// --- DOKUMENTASI SWAGGER UI ---
const swaggerDocument = {
  openapi: '3.0.0',
  info: {
    title: 'Service B - Circulation & Loan API (Local SQLite)',
    version: '1.0.0',
    description: 'REST API Sirkulasi Peminjaman Lokal yang terintegrasi dengan Service A (Cloud)',
  },
  paths: {
    '/api/loans': {
      get: { summary: 'Ambil semua data peminjaman lokal', responses: { 200: { description: 'Berhasil' } } },
      post: {
        summary: 'Buat transaksi peminjaman baru (Call GET & PUT ke Service A)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  book_id: { type: 'string', example: 'firestore_doc_id' },
                  borrower_name: { type: 'string', example: 'Budi Santoso' },
                  borrower_nim: { type: 'string', example: '21120121140001' },
                  days: { type: 'integer', example: 7 },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Peminjaman berhasil dicatat' } },
      },
    },
    '/api/loans/{id}/return': {
      put: {
        summary: 'Kembalikan buku (Call PUT ke Service A untuk tambah stok)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'Buku dikembalikan' } },
      },
    },
    '/api/loans/{id}': {
      delete: {
        summary: 'Hapus/batalkan transaksi peminjaman',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'Transaksi dihapus' } },
      },
    },
  },
};
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Endpoint Info Integrasi untuk Dashboard UI
app.get('/api/config', async (req, res) => {
  let cloudStatus = 'OFFLINE';
  try {
    await axios.get(`${CATALOG_URL}/`);
    cloudStatus = 'ONLINE';
  } catch (_) {}
  res.json({
    localService: 'Service B - Loan Service (SQLite)',
    catalogServiceUrl: CATALOG_URL,
    catalogServiceStatus: cloudStatus,
  });
});

// --- BRIDGE KE SERVICE A (Untuk kemudahan akses dari Web UI) ---
app.get('/api/catalog', async (req, res) => {
  try {
    const response = await axios.get(`${CATALOG_URL}/api/books`);
    res.json({
      ...response.data,
      inter_service_log: `[Service B -> Service A] GET ${CATALOG_URL}/api/books (200 OK)`,
    });
  } catch (error) {
    res.status(502).json({ success: false, message: 'Gagal terhubung ke Service A: ' + error.message });
  }
});

app.post('/api/catalog', async (req, res) => {
  try {
    const response = await axios.post(`${CATALOG_URL}/api/books`, req.body);
    res.status(201).json({
      ...response.data,
      inter_service_log: `[Service B -> Service A] POST ${CATALOG_URL}/api/books (201 Created)`,
    });
  } catch (error) {
    res.status(502).json({ success: false, message: error.response?.data?.message || error.message });
  }
});

app.delete('/api/catalog/:id', async (req, res) => {
  try {
    const response = await axios.delete(`${CATALOG_URL}/api/books/${req.params.id}`);
    res.json({
      ...response.data,
      inter_service_log: `[Service B -> Service A] DELETE ${CATALOG_URL}/api/books/${req.params.id} (200 OK)`,
    });
  } catch (error) {
    res.status(502).json({ success: false, message: error.response?.data?.message || error.message });
  }
});

// --- ENDPOINT UTAMA SERVICE B (GET, POST, PUT, DELETE) ---

// 1. GET All Loans
app.get('/api/loans', async (req, res) => {
  try {
    const loans = await allQuery('SELECT * FROM loans ORDER BY id DESC');
    res.status(200).json({ success: true, data: loans });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 2. POST Create Loan (Komunikasi Antar-Service: GET & PUT ke Service A)
app.post('/api/loans', async (req, res) => {
  const { book_id, borrower_name, borrower_nim, days = 7 } = req.body;
  if (!book_id || !borrower_name || !borrower_nim) {
    return res.status(400).json({ success: false, message: 'book_id, borrower_name, dan borrower_nim wajib diisi' });
  }

  const logs = [];
  try {
    // Langkah 1: GET detail & stok buku dari Service A (Cloud)
    const bookRes = await axios.get(`${CATALOG_URL}/api/books/${book_id}`);
    logs.push(`[Service B -> Service A] GET ${CATALOG_URL}/api/books/${book_id} -> Stok: ${bookRes.data.data.stock}`);

    const book = bookRes.data.data;
    if (book.stock <= 0) {
      return res.status(400).json({ success: false, message: 'Stok buku habis, tidak dapat dipinjam', logs });
    }

    // Langkah 2: PUT kurangi stok buku di Service A (Cloud)
    const newStock = book.stock - 1;
    await axios.put(`${CATALOG_URL}/api/books/${book_id}`, { stock: newStock });
    logs.push(`[Service B -> Service A] PUT ${CATALOG_URL}/api/books/${book_id} -> Stok diperbarui menjadi ${newStock}`);

    // Langkah 3: Simpan transaksi peminjaman ke SQLite Lokal
    const borrowDate = new Date();
    const dueDate = new Date();
    dueDate.setDate(borrowDate.getDate() + Number(days));

    const result = await runQuery(
      `INSERT INTO loans (book_id, book_title, borrower_name, borrower_nim, borrow_date, due_date, status)
       VALUES (?, ?, ?, ?, ?, ?, 'BORROWED')`,
      [book_id, book.title, borrower_name, borrower_nim, borrowDate.toISOString(), dueDate.toISOString()]
    );

    const createdLoan = await getQuery('SELECT * FROM loans WHERE id = ?', [result.id]);
    res.status(201).json({ success: true, data: createdLoan, inter_service_logs: logs });
  } catch (error) {
    const status = error.response?.status || 500;
    const msg = error.response?.data?.message || error.message;
    res.status(status).json({ success: false, message: msg, inter_service_logs: logs });
  }
});

// 3. PUT Return Book (Komunikasi Antar-Service: GET & PUT ke Service A)
app.put('/api/loans/:id/return', async (req, res) => {
  const logs = [];
  try {
    const loan = await getQuery('SELECT * FROM loans WHERE id = ?', [req.params.id]);
    if (!loan) {
      return res.status(404).json({ success: false, message: 'Data peminjaman tidak ditemukan' });
    }
    if (loan.status === 'RETURNED') {
      return res.status(400).json({ success: false, message: 'Buku ini sudah dikembalikan sebelumnya' });
    }

    // Ambil stok terbaru dari Service A dan tambahkan +1
    try {
      const bookRes = await axios.get(`${CATALOG_URL}/api/books/${loan.book_id}`);
      const restoredStock = bookRes.data.data.stock + 1;
      logs.push(`[Service B -> Service A] GET ${CATALOG_URL}/api/books/${loan.book_id} -> Stok saat ini: ${bookRes.data.data.stock}`);

      await axios.put(`${CATALOG_URL}/api/books/${loan.book_id}`, { stock: restoredStock });
      logs.push(`[Service B -> Service A] PUT ${CATALOG_URL}/api/books/${loan.book_id} -> Stok dikembalikan menjadi ${restoredStock}`);
    } catch (cloudErr) {
      logs.push(`[Service B -> Service A] Peringatan: Buku tidak ditemukan di katalog cloud (${cloudErr.message})`);
    }

    const returnDate = new Date().toISOString();
    await runQuery(`UPDATE loans SET status = 'RETURNED', return_date = ? WHERE id = ?`, [returnDate, req.params.id]);

    const updatedLoan = await getQuery('SELECT * FROM loans WHERE id = ?', [req.params.id]);
    res.status(200).json({ success: true, data: updatedLoan, inter_service_logs: logs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message, inter_service_logs: logs });
  }
});

// 4. DELETE Loan Record
app.delete('/api/loans/:id', async (req, res) => {
  const logs = [];
  try {
    const loan = await getQuery('SELECT * FROM loans WHERE id = ?', [req.params.id]);
    if (!loan) {
      return res.status(404).json({ success: false, message: 'Data peminjaman tidak ditemukan' });
    }

    // Jika status masih dipinjam, kembalikan stok ke Service A sebelum menghapus log
    if (loan.status === 'BORROWED') {
      try {
        const bookRes = await axios.get(`${CATALOG_URL}/api/books/${loan.book_id}`);
        const restoredStock = bookRes.data.data.stock + 1;
        await axios.put(`${CATALOG_URL}/api/books/${loan.book_id}`, { stock: restoredStock });
        logs.push(`[Service B -> Service A] PUT ${CATALOG_URL}/api/books/${loan.book_id} -> Stok dipulihkan menjadi ${restoredStock}`);
      } catch (_) {}
    }

    await runQuery('DELETE FROM loans WHERE id = ?', [req.params.id]);
    res.status(200).json({ success: true, message: 'Transaksi peminjaman berhasil dihapus', inter_service_logs: logs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`[Service B - Loan Local] berjalan di http://localhost:${PORT}`);
  console.log(`[Terhubung ke Service A] di ${CATALOG_URL}`);
  console.log(`[Swagger Docs] tersedia di http://localhost:${PORT}/api-docs`);
});