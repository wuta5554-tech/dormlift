require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

// --- 1. Cloudinary Configuration ---
// These credentials should be set in Railway's Variables tab
cloudinary.config({ 
  cloud_name: process.env.CLOUDINARY_NAME, 
  api_key: process.env.CLOUDINARY_KEY, 
  api_secret: process.env.CLOUDINARY_SECRET 
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'dormlift_v8_production',
    allowed_formats: ['jpg', 'png', 'jpeg'],
    public_id: (req, file) => `task-${Date.now()}`
  },
});
const upload = multer({ storage: storage });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// --- 2. PostgreSQL Connection Pool ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } 
});

// Database Initialization (Ensuring all fields match your registration form)
const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        student_id TEXT PRIMARY KEY, 
        school_name TEXT, 
        first_name TEXT, 
        given_name TEXT, 
        anonymous_name TEXT, 
        phone TEXT, 
        email TEXT UNIQUE, 
        password TEXT,
        rating_avg REAL DEFAULT 5.0, 
        task_count INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY, 
        publisher_id TEXT, 
        helper_id TEXT,
        move_date TEXT, 
        move_time TEXT, 
        from_addr TEXT, 
        to_addr TEXT, 
        items_desc TEXT, 
        reward TEXT, 
        has_elevator BOOLEAN DEFAULT false, 
        load_weight TEXT, 
        img_url TEXT, 
        status TEXT DEFAULT 'pending', 
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS reviews (
        id SERIAL PRIMARY KEY, 
        task_id INTEGER, 
        from_id TEXT, 
        to_id TEXT, 
        score INTEGER, 
        comment TEXT
      );
    `);
    console.log("✅ Database tables synced successfully.");
  } catch (err) {
    console.error("❌ Database initialization error:", err);
  }
};
initDB();

// --- 3. Authentication Routes ---

// Registration with full fields and NZ email check
app.post('/api/auth/register', async (req, res) => {
    const { student_id, email, password, school_name, first_name, given_name, anonymous_name, phone } = req.body;
    
    // Safety check for NZ Uni emails
    if (!email.toLowerCase().endsWith('.ac.nz')) {
        return res.status(400).json({ success: false, message: "Only .ac.nz student emails are allowed." });
    }

    try {
        const hashed = await bcrypt.hash(password, 10);
        const sql = `
            INSERT INTO users (student_id, school_name, first_name, given_name, anonymous_name, phone, email, password) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `;
        await pool.query(sql, [student_id, school_name, first_name, given_name, anonymous_name, phone, email, hashed]);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ success: false, message: "ID or Email already registered." });
    }
});

// Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM users WHERE student_id = $1`, [req.body.student_id]);
        const user = result.rows[0];
        if (!user || !(await bcrypt.compare(req.body.password, user.password))) {
            return res.status(401).json({ success: false, message: "Invalid ID or password." });
        }
        delete user.password; // Security: don't send hash back to client
        res.json({ success: true, user });
    } catch (err) { res.status(500).json({ success: false }); }
});

// --- 4. Task Management Routes ---

// Create Task (Multer + Cloudinary)
app.post('/api/task/create', upload.single('task_image'), async (req, res) => {
    const { publisher_id, move_date, move_time, from_addr, to_addr, items_desc, reward, has_elevator, load_weight } = req.body;
    const imgUrl = req.file ? req.file.path : '';
    try {
        const sql = `
            INSERT INTO tasks (publisher_id, move_date, move_time, from_addr, to_addr, items_desc, reward, has_elevator, load_weight, img_url) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `;
        await pool.query(sql, [publisher_id, move_date, move_time, from_addr, to_addr, items_desc, reward, has_elevator === 'true', load_weight, imgUrl]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

// Get Marketplace Tasks
app.get('/api/task/all', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT t.*, u.anonymous_name as pub_name, u.rating_avg 
            FROM tasks t 
            JOIN users u ON t.publisher_id = u.student_id 
            WHERE t.status = 'pending' 
            ORDER BY t.id DESC
        `);
        res.json({ success: true, list: result.rows });
    } catch (err) { res.status(500).json({ success: false }); }
});

// Update Workflow (Assign or Complete)
app.post('/api/task/workflow', async (req, res) => {
    const { task_id, status, helper_id } = req.body;
    try {
        if (helper_id) {
            await pool.query(`UPDATE tasks SET status = $1, helper_id = $2 WHERE id = $3`, [status, helper_id, task_id]);
        } else {
            await pool.query(`UPDATE tasks SET status = $1 WHERE id = $2`, [status, task_id]);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

// Review System (Atomic Transaction)
app.post('/api/task/review', async (req, res) => {
    const { task_id, to_id, score, comment } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`INSERT INTO reviews (task_id, to_id, score, comment) VALUES ($1, $2, $3, $4)`, [task_id, to_id, score, comment]);
        await client.query(`UPDATE tasks SET status = 'reviewed' WHERE id = $1`, [task_id]);
        
        // Recalculate Rating
        const stats = await client.query(`SELECT AVG(score) as avg, COUNT(id) as count FROM reviews WHERE to_id = $1`, [to_id]);
        await client.query(`UPDATE users SET rating_avg = $1, task_count = $2 WHERE student_id = $3`, 
            [parseFloat(stats.rows[0].avg).toFixed(1), stats.rows[0].count, to_id]);
        
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false });
    } finally {
        client.release();
    }
});

// User Profile & Dashboard
app.post('/api/user/profile', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM users WHERE student_id = $1`, [req.body.student_id]);
        res.json({ success: true, user: result.rows[0] });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.post('/api/user/dashboard', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM tasks WHERE publisher_id = $1 OR helper_id = $1 ORDER BY id DESC`,
            [req.body.student_id]
        );
        res.json({ success: true, list: result.rows });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 DormLift Engine Active on ${PORT} | PostgreSQL & Cloudinary Ready`);
});
