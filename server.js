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

// --- 1. Cloudinary 配置 (从环境变量读取，保护密钥) ---
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

// --- 2. PostgreSQL 连接池 ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Railway 生产环境必需
});

// 初始化数据库表 (真实使用：增加字段约束)
const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        student_id TEXT PRIMARY KEY, 
        school_name TEXT, 
        first_name TEXT, 
        given_name TEXT, 
        gender TEXT, 
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
    console.log("✅ Database tables synced and ready.");
  } catch (err) {
    console.error("❌ Database init error:", err);
  }
};
initDB();

// --- 3. 核心 API 路由 ---

// 注册：加入学校邮箱后缀验证
app.post('/api/auth/register', async (req, res) => {
    const { student_id, email, password, school_name, first_name, given_name, anonymous_name } = req.body;
    
    // 真实使用安全检查：仅限 .ac.nz 邮箱
    if (!email.toLowerCase().endsWith('.ac.nz')) {
        return res.status(400).json({ success: false, message: "Valid NZ student email required (.ac.nz)" });
    }

    try {
        const hashed = await bcrypt.hash(password, 10);
        await pool.query(
            `INSERT INTO users (student_id, school_name, first_name, given_name, anonymous_name, email, password) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [student_id, school_name, first_name, given_name, anonymous_name, email, hashed]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ success: false, message: "Registration failed. ID or Email already exists." });
    }
});

// 登录
app.post('/api/auth/login', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM users WHERE student_id = $1`, [req.body.student_id]);
        const user = result.rows[0];
        if (!user || !(await bcrypt.compare(req.body.password, user.password))) {
            return res.status(401).json({ success: false, message: "Invalid ID or password." });
        }
        delete user.password; 
        res.json({ success: true, user });
    } catch (err) { res.status(500).json({ success: false }); }
});

// 创建任务 (支持图片上传)
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

// 获取所有待处理任务 (Marketplace)
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

// 工作流：接受、完成任务
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

// 评价系统：提交评价并自动更新用户平均分
app.post('/api/task/review', async (req, res) => {
    const { task_id, to_id, score, comment } = req.body;
    try {
        await pool.query('BEGIN');
        // 1. 插入评价
        await pool.query(`INSERT INTO reviews (task_id, to_id, score, comment) VALUES ($1, $2, $3, $4)`, [task_id, to_id, score, comment]);
        // 2. 更新任务状态为 'reviewed' 防止重复评价
        await pool.query(`UPDATE tasks SET status = 'reviewed' WHERE id = $1`, [task_id]);
        // 3. 重新计算该 Helper 的平均分和任务总数
        const stats = await pool.query(`SELECT AVG(score) as avg, COUNT(id) as count FROM reviews WHERE to_id = $1`, [to_id]);
        await pool.query(`UPDATE users SET rating_avg = $1, task_count = $2 WHERE student_id = $3`, 
            [parseFloat(stats.rows[0].avg).toFixed(1), stats.rows[0].count, to_id]);
        
        await pool.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await pool.query('ROLLBACK');
        res.status(500).json({ success: false });
    }
});

// 获取个人资料
app.post('/api/user/profile', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM users WHERE student_id = $1`, [req.body.student_id]);
        res.json({ success: true, user: result.rows[0] });
    } catch (err) { res.status(500).json({ success: false }); }
});

// 获取用户相关的任务看板数据
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
    console.log(`
    ---------------------------------------------------
    🚀 DormLift V8.0 Final Engine Active
    📍 Port: ${PORT}
    🌐 Mode: PostgreSQL Production
    📸 Cloudinary: Integrated
    ---------------------------------------------------
    `);
});
