require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const bcrypt = require('bcryptjs');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 8080;

// --- 1. 外部服务配置 (Google Script URL) ---
const GAS_URL = "https://script.google.com/macros/s/AKfycbz_VqNBKdc1xc225RfAlTEBT4jR-v4LKwRCpzVSPqKm-xO8PsbbHHKRRvGowxxfEBwD/exec";

cloudinary.config({ 
  cloud_name: process.env.CLOUDINARY_NAME, 
  api_key: process.env.CLOUDINARY_KEY, 
  api_secret: process.env.CLOUDINARY_SECRET 
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: { folder: 'dormlift_nz', allowed_formats: ['jpg', 'png', 'jpeg'] }
});
const upload = multer({ storage: storage });

// --- 2. 数据库连接 (带 SSL 修复) ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        student_id TEXT PRIMARY KEY, first_name TEXT, given_name TEXT, 
        anonymous_name TEXT, phone TEXT, email TEXT UNIQUE, password TEXT,
        rating_avg REAL DEFAULT 5.0, task_count INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY, publisher_id TEXT, helper_id TEXT,
        move_date TEXT, move_time TEXT, from_addr TEXT, to_addr TEXT, 
        items_desc TEXT, reward TEXT, img_url TEXT, status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("✅ Database Tables Synced & Ready.");
  } catch (err) { console.error("❌ DB Init Error:", err.message); }
};
initDB();

const verificationCodes = new Map();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// --- 3. 身份验证 API (无后缀限制 + 真实验证码) ---

app.post('/api/auth/send-code', async (req, res) => {
    const { email } = req.body;
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    verificationCodes.set(email, { code, expires: Date.now() + 600000 });

    console.log(`[System] 发送验证码 ${code} 到 ${email}`);

    try {
        const response = await fetch(GAS_URL, {
            method: 'POST',
            body: JSON.stringify({ email, code }),
            headers: { 'Content-Type': 'application/json' },
            redirect: 'follow'
        });
        res.json({ success: true, message: "Code sent!" });
    } catch (err) {
        res.status(500).json({ success: false, message: "Mail Service Error" });
    }
});

app.post('/api/auth/register', async (req, res) => {
    const { student_id, email, password, code, first_name, given_name, anonymous_name, phone } = req.body;
    const record = verificationCodes.get(email);
    
    // 支持 888888 应急码
    if (code !== "888888") {
        if (!record || record.code !== code || Date.now() > record.expires) {
            return res.status(400).json({ success: false, message: "Invalid code." });
        }
    }

    try {
        const hashed = await bcrypt.hash(password, 10);
        await pool.query(
            `INSERT INTO users (student_id, email, password, first_name, given_name, anonymous_name, phone) 
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [student_id, email, hashed, first_name, given_name, anonymous_name, phone]
        );
        res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, message: "Registration failed." }); }
});

app.post('/api/auth/login', async (req, res) => {
    const result = await pool.query(`SELECT * FROM users WHERE student_id = $1`, [req.body.student_id]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(req.body.password, user.password))) {
        return res.status(401).json({ success: false });
    }
    delete user.password;
    res.json({ success: true, user });
});

// --- 4. 任务与工作流 API ---

// 发布任务
app.post('/api/task/create', upload.single('task_image'), async (req, res) => {
    const { publisher_id, move_date, move_time, from_addr, to_addr, items_desc, reward } = req.body;
    const imgUrl = req.file ? req.file.path : '';
    try {
        await pool.query(
            `INSERT INTO tasks (publisher_id, move_date, move_time, from_addr, to_addr, items_desc, reward, img_url) 
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [publisher_id, move_date, move_time, from_addr, to_addr, items_desc, reward, imgUrl]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

// 获取大厅待处理任务
app.get('/api/task/all', async (req, res) => {
    const result = await pool.query(`
        SELECT t.*, u.anonymous_name, u.rating_avg 
        FROM tasks t 
        JOIN users u ON t.publisher_id = u.student_id 
        WHERE t.status = 'pending' 
        ORDER BY t.id DESC
    `);
    res.json({ success: true, list: result.rows });
});

// 核心工作流：接受任务、完成任务
app.post('/api/task/workflow', async (req, res) => {
    const { task_id, status, helper_id } = req.body;
    try {
        if (status === 'assigned') {
            await pool.query(`UPDATE tasks SET status = $1, helper_id = $2 WHERE id = $3`, [status, helper_id, task_id]);
        } else {
            await pool.query(`UPDATE tasks SET status = $1 WHERE id = $2`, [status, task_id]);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

// --- 5. 用户中心与看板 API ---

app.post('/api/user/profile', async (req, res) => {
    const result = await pool.query(`SELECT * FROM users WHERE student_id = $1`, [req.body.student_id]);
    res.json({ success: true, user: result.rows[0] });
});

// 获取个人相关的任务（我发布的和我帮助的）
app.post('/api/user/dashboard', async (req, res) => {
    const { student_id } = req.body;
    const result = await pool.query(`
        SELECT * FROM tasks 
        WHERE publisher_id = $1 OR helper_id = $1 
        ORDER BY created_at DESC
    `, [student_id]);
    res.json({ success: true, list: result.rows });
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 DormLift NZ V8.0 Full PRO on port ${PORT}`));
