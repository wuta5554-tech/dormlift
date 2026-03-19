require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const bcrypt = require('bcryptjs');
const fetch = require('node-fetch'); // 确保 package.json 有 node-fetch

const app = express();
const PORT = process.env.PORT || 8080;
const GAS_URL = "https://script.google.com/macros/s/AKfycbz_VqNBKdc1xc225RfAlTEBT4jR-v4LKwRCpzVSPqKm-xO8PsbbHHKRRvGowxxfEBwD/exec";

// --- 1. Cloudinary 配置 ---
cloudinary.config({ 
  cloud_name: process.env.CLOUDINARY_NAME, 
  api_key: process.env.CLOUDINARY_KEY, 
  api_secret: process.env.CLOUDINARY_SECRET 
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: { folder: 'dormlift_nz', allowed_formats: ['jpg', 'png'] }
});
const upload = multer({ storage: storage });

// --- 2. PostgreSQL 配置 (彻底解决 ECONNREFUSED) ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Railway 必须开启这个
});

// 测试数据库连接
pool.connect((err, client, release) => {
  if (err) return console.error('❌ DB Connection Error:', err.stack);
  console.log('✅ Connected to Railway PostgreSQL');
  release();
});

const verificationCodes = new Map();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// --- 3. 验证码逻辑 (使用你的 Google Script) ---
app.post('/api/auth/send-code', async (req, res) => {
    const { email } = req.body;
    if (!email.toLowerCase().endsWith('.ac.nz')) {
        return res.status(400).json({ success: false, message: "Valid .ac.nz email required" });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    verificationCodes.set(email, { code, expires: Date.now() + 600000 });

    try {
        // 调用你的 Google Script Webhook
        await fetch(GAS_URL, {
            method: 'POST',
            body: JSON.stringify({ email, code }),
            headers: { 'Content-Type': 'application/json' }
        });
        res.json({ success: true, message: "Code sent via Google Script" });
    } catch (err) {
        res.status(500).json({ success: false, message: "Mail delivery failed" });
    }
});

// --- 4. 注册与登录 ---
app.post('/api/auth/register', async (req, res) => {
    const { student_id, email, password, code, first_name, given_name, anonymous_name, phone } = req.body;
    const record = verificationCodes.get(email);
    
    if (!record || record.code !== code || Date.now() > record.expires) {
        return res.status(400).json({ success: false, message: "Invalid or expired code" });
    }

    try {
        const hashed = await bcrypt.hash(password, 10);
        await pool.query(
            `INSERT INTO users (student_id, email, password, first_name, given_name, anonymous_name, phone) 
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [student_id, email, hashed, first_name, given_name, anonymous_name, phone]
        );
        verificationCodes.delete(email);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, message: "ID or Email already exists" }); }
});

app.post('/api/auth/login', async (req, res) => {
    const result = await pool.query(`SELECT * FROM users WHERE student_id = $1`, [req.body.student_id]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(req.body.password, user.password))) {
        return res.status(401).json({ success: false, message: "Login failed" });
    }
    delete user.password;
    res.json({ success: true, user });
});

// --- 5. 任务与个人资料 ---
app.post('/api/task/create', upload.single('task_image'), async (req, res) => {
    const { publisher_id, from_addr, to_addr, reward, items_desc } = req.body;
    const imgUrl = req.file ? req.file.path : '';
    await pool.query(
        `INSERT INTO tasks (publisher_id, from_addr, to_addr, reward, items_desc, img_url) VALUES ($1,$2,$3,$4,$5,$6)`,
        [publisher_id, from_addr, to_addr, reward, items_desc, imgUrl]
    );
    res.json({ success: true });
});

app.get('/api/task/all', async (req, res) => {
    const result = await pool.query(`SELECT t.*, u.anonymous_name, u.rating_avg FROM tasks t JOIN users u ON t.publisher_id = u.student_id WHERE t.status = 'pending'`);
    res.json({ success: true, list: result.rows });
});

app.post('/api/user/profile', async (req, res) => {
    const result = await pool.query(`SELECT * FROM users WHERE student_id = $1`, [req.body.student_id]);
    res.json({ success: true, user: result.rows[0] });
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 DormLift NZ V8.0 PRO Online on port ${PORT}`));
