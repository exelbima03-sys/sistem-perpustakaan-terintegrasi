require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const swaggerUi = require('swagger-ui-express');

const app = express();
app.use(cors());
app.use(express.json());

// Inisialisasi Firebase Admin (mendukung env var untuk Cloud atau file lokal)
if (!admin.apps.length) {
  let serviceAccount;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    serviceAccount = require('./serviceAccountKey.json');
  }
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const booksCollection = db.collection('books');

// --- DOKUMENTASI SWAGGER UI ---
const swaggerDocument = {
  openapi: '3.0.0',
  info: {
    title: 'Service A - Book Catalog API (Firebase Firestore)',
    version: '1.0.0',
    description: 'REST API Katalog Buku berbasis Cloud Firestore untuk Sistem Terintegrasi',
  },
  paths: {
    '/api/books': {
      get: { summary: 'Ambil semua daftar buku', responses: { 200: { description: 'Berhasil' } } },
      post: {
        summary: 'Tambah buku baru ke Firestore',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  title: { type: 'string', example: 'Clean Architecture' },
                  author: { type: 'string', example: 'Robert C. Martin' },
                  isbn: { type: 'string', example: '978-0134494166' },
                  category: { type: 'string', example: 'Software Engineering' },
                  stock: { type: 'integer', example: 5 },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Buku ditambahkan' } },
      },
    },
    '/api/books/{id}': {
      get: {
        summary: 'Ambil detail buku berdasarkan ID',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Detail buku' }, 404: { description: 'Tidak ditemukan' } },
      },
      put: {
        summary: 'Update data atau stok buku',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  author: { type: 'string' },
                  category: { type: 'string' },
                  stock: { type: 'integer', example: 4 },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Buku diperbarui' } },
      },
      delete: {
        summary: 'Hapus buku dari katalog',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Buku dihapus' } },
      },
    },
  },
};
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// --- ENDPOINT REST API (GET, POST, PUT, DELETE) ---

app.get('/', (req, res) => {
  res.json({
    service: 'Service A - Book Catalog Service (Cloud Firebase)',
    status: 'ONLINE',
    docs: '/api-docs',
  });
});

// 1. GET All Books
app.get('/api/books', async (req, res) => {
  try {
    const snapshot = await booksCollection.orderBy('createdAt', 'desc').get();
    const books = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.status(200).json({ success: true, data: books });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 2. GET Book by ID
app.get('/api/books/:id', async (req, res) => {
  try {
    const doc = await booksCollection.doc(req.params.id).get();
    if (!doc.exists) {
      return res.status(404).json({ success: false, message: 'Buku tidak ditemukan' });
    }
    res.status(200).json({ success: true, data: { id: doc.id, ...doc.data() } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 3. POST Create Book
app.post('/api/books', async (req, res) => {
  try {
    const { title, author, isbn, category, stock } = req.body;
    if (!title || !author || stock === undefined) {
      return res.status(400).json({ success: false, message: 'Field title, author, dan stock wajib diisi' });
    }
    const newBook = {
      title,
      author,
      isbn: isbn || '-',
      category: category || 'Umum',
      stock: Number(stock),
      createdAt: new Date().toISOString(),
    };
    const docRef = await booksCollection.add(newBook);
    res.status(201).json({ success: true, data: { id: docRef.id, ...newBook } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 4. PUT Update Book / Stock
app.put('/api/books/:id', async (req, res) => {
  try {
    const docRef = booksCollection.doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) {
      return res.status(404).json({ success: false, message: 'Buku tidak ditemukan' });
    }

    const updates = {};
    const { title, author, isbn, category, stock } = req.body;
    if (title !== undefined) updates.title = title;
    if (author !== undefined) updates.author = author;
    if (isbn !== undefined) updates.isbn = isbn;
    if (category !== undefined) updates.category = category;
    if (stock !== undefined) {
      if (Number(stock) < 0) {
        return res.status(400).json({ success: false, message: 'Stok tidak boleh kurang dari 0' });
      }
      updates.stock = Number(stock);
    }
    updates.updatedAt = new Date().toISOString();

    await docRef.update(updates);
    const updatedDoc = await docRef.get();
    res.status(200).json({ success: true, data: { id: updatedDoc.id, ...updatedDoc.data() } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 5. DELETE Book
app.delete('/api/books/:id', async (req, res) => {
  try {
    const docRef = booksCollection.doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) {
      return res.status(404).json({ success: false, message: 'Buku tidak ditemukan' });
    }
    await docRef.delete();
    res.status(200).json({ success: true, message: 'Buku berhasil dihapus dari Firestore' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

const PORT = process.env.PORT || 3001;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[Service A - Catalog Cloud] berjalan di http://localhost:${PORT}`);
    console.log(`[Swagger Docs] tersedia di http://localhost:${PORT}/api-docs`);
  });
}

module.exports = app;