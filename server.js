require('dotenv').config();
const express = require('express');
const { Pool } = require('pg'); // 使用 pg 替代 sqlite3
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 8080;

// --- 1. Cloudinary 配置 (建议从 Railway 变量读取) ---
cloudinary.config({ 
  cloud_name: process.env.CLOUDINARY_NAME || 'ddlbhkmwb', 
  api_key: process.env.CLOUDINARY_KEY || '659513524184184', 
  api_secret: process.env.CLOUDINARY_SECRET || 'iRTD1m-vPfaIu0DQ0uLUf4LUyLU' 
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'dormlift_v8_prod',
    allowed_formats: ['jpg', 'png', 'jpeg'],
  },
});
const upload = multer({ storage: storage });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// --- 2. PostgreSQL 数据库连接 ---
// Railway 会自动注入 DATABASE_URL 环境变量
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Railway 生产环境必须
});

// 初始化表 (仅在不存在时创建)
const initDB = async () => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        student_id TEXT PRIMARY KEY, school_name TEXT, first_name TEXT, given_name TEXT, 
        gender TEXT, anonymous_name TEXT, phone TEXT, email TEXT UNIQUE, password TEXT,
        rating_avg REAL DEFAULT 5.0, task_count INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY, publisher_id TEXT, helper_id TEXT,
        move_date TEXT, move_time TEXT, from_addr TEXT, to_addr TEXT, 
        items_desc TEXT, reward TEXT, has_elevator BOOLEAN, load_weight TEXT, 
        img_url TEXT, status TEXT DEFAULT 'pending', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS reviews (
        id SERIAL PRIMARY KEY, task_id INTEGER, from_id TEXT, to_id TEXT, score INTEGER, comment TEXT
      );
    `);
    console.log("✅ PostgreSQL Tables Verified");
  } finally {
    client.release();
  }
};
initDB();

// --- 3. 核心 API (修改为 Async/Await 风格) ---

app.post('/api/auth/register', async (req, res) => {
    const { student_id, email, password, school_name, first_name, given_name, gender, anonymous_name, phone } = req.body;
    
    // 真实使用校验：仅限新西兰高校邮箱
    if (!email.endsWith('.ac.nz')) {
        return res.status(400).json({ success: false, message: "Please use your .ac.nz student email." });
    }

    try {
        const hashed = await bcrypt.hash(password, 10);
        await pool.query(
            `INSERT INTO users (student_id, school_name, first_name, given_name, gender, anonymous_name, phone, email, password) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [student_id, school_name, first_name, given_name, gender, anonymous_name, phone, email, hashed]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ success: false, message: "Registration failed (ID or Email may exist)" });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM users WHERE student_id = $1`, [req.body.student_id]);
        const user = result.rows[0];
        if (!user || !(await bcrypt.compare(req.body.password, user.password))) {
            return res.status(400).json({ success: false, message: "Invalid credentials" });
        }
        delete user.password; 
        res.json({ success: true, user });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.post('/api/task/create', upload.single('task_image'), async (req, res) => {
    const { publisher_id, move_date, move_time, from_addr, to_addr, items_desc, reward, has_elevator, load_weight } = req.body;
    const imgUrl = req.file ? req.file.path : '';
    try {
        await pool.query(
            `INSERT INTO tasks (publisher_id, move_date, move_time, from_addr, to_addr, items_desc, reward, has_elevator, load_weight, img_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [publisher_id, move_date, move_time, from_addr, to_addr, items_desc, reward, has_elevator === 'true', load_weight, imgUrl]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.get('/api/task/all', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT t.*, u.anonymous_name as pub_name, u.rating_avg 
            FROM tasks t 
            JOIN users u ON t.publisher_id = u.student_id 
            WHERE t.status = 'pending' ORDER BY t.id DESC
        `);
        res.json({ success: true, list: result.rows });
    } catch (err) { res.status(500).json({ success: false }); }
});

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

app.post('/api/user/profile', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM users WHERE student_id = $1`, [req.body.student_id]);
        res.json({ success: true, user: result.rows[0] });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.post('/api/user/dashboard', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM tasks WHERE publisher_id = $1 OR helper_id = $2 ORDER BY id DESC`,
            [req.body.student_id, req.body.student_id]
        );
        res.json({ success: true, list: result.rows });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 DormLift V8.0 Final Engine Active on ${PORT}`));
