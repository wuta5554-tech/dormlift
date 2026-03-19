require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 8080;

// --- 1. 生产级 SMTP 配置 (使用 465 端口 + 强制 SSL) ---
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465, // 465 端口通常比 587 在云端更稳定
  secure: true, // 使用 SSL
  auth: {
    user: process.env.SMTP_EMAIL,
    pass: process.env.SMTP_PASSWORD // 必须是 16 位 App Password
  },
  pool: true, // 使用连接池提高效率
  maxConnections: 5,
  maxMessages: 100
});

// 验证 SMTP 连接状态
transporter.verify((error, success) => {
  if (error) {
    console.error("❌ SMTP 生产配置错误:", error.message);
  } else {
    console.log("✅ SMTP 邮件服务已就绪 (Real Production)");
  }
});

// --- 2. Cloudinary & 数据库配置 ---
cloudinary.config({ 
  cloud_name: process.env.CLOUDINARY_NAME, 
  api_key: process.env.CLOUDINARY_KEY, 
  api_secret: process.env.CLOUDINARY_SECRET 
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: { folder: 'dormlift_prod', allowed_formats: ['jpg', 'png', 'jpeg'] }
});
const upload = multer({ storage: storage });

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
        rating_avg REAL DEFAULT 5.0
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY, publisher_id TEXT, helper_id TEXT,
        move_date TEXT, move_time TEXT, from_addr TEXT, to_addr TEXT, 
        items_desc TEXT, reward TEXT, img_url TEXT, status TEXT DEFAULT 'pending'
      );
    `);
    console.log("✅ 数据库表已同步");
  } catch (err) { console.error("❌ 数据库初始化失败:", err.message); }
};
initDB();

const verificationCodes = new Map();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// --- 3. 真实验证码逻辑 ---
app.post('/api/auth/send-code', async (req, res) => {
    const { email } = req.body;
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    verificationCodes.set(email, { code, expires: Date.now() + 600000 });

    const mailOptions = {
        from: `"DormLift NZ" <${process.env.SMTP_EMAIL}>`,
        to: email,
        subject: "DormLift 验证码",
        html: `
            <div style="font-family: sans-serif; max-width: 500px; margin: auto; border: 1px solid #eee; padding: 20px;">
                <h2 style="color: #2980b9;">账号验证</h2>
                <p>您好，您的验证码如下，请在 10 分钟内完成注册：</p>
                <div style="background: #f9f9f9; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 10px; color: #2c3e50;">
                    ${code}
                </div>
            </div>`
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`[SMTP] 验证码已真实投递至: ${email}`);
        res.json({ success: true, message: "验证码已发送" });
    } catch (err) {
        console.error("❌ 邮件投递失败:", err.message);
        res.status(500).json({ success: false, message: "邮件服务暂时不可用，请稍后再试" });
    }
});

// --- 4. 注册与登录 (移除所有 Debug 码，只认真实 Code) ---
app.post('/api/auth/register', async (req, res) => {
    const { student_id, email, password, code, first_name, given_name, anonymous_name, phone } = req.body;
    const record = verificationCodes.get(email);
    
    if (!record || record.code !== code || Date.now() > record.expires) {
        return res.status(400).json({ success: false, message: "验证码错误或已过期" });
    }

    try {
        const hashed = await bcrypt.hash(password, 10);
        await pool.query(
            `INSERT INTO users (student_id, email, password, first_name, given_name, anonymous_name, phone) 
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [student_id, email, hashed, first_name, given_name, anonymous_name, phone]
        );
        verificationCodes.delete(email); // 注册成功后清除
        res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, message: "注册失败，该 ID 或邮箱可能已存在" }); }
});

app.post('/api/auth/login', async (req, res) => {
    const result = await pool.query(`SELECT * FROM users WHERE student_id = $1`, [req.body.student_id]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(req.body.password, user.password))) {
        return res.status(401).json({ success: false, message: "学号或密码错误" });
    }
    delete user.password;
    res.json({ success: true, user });
});

// --- 5. 任务管理接口 ---
app.post('/api/task/create', upload.single('task_image'), async (req, res) => {
    const { publisher_id, move_date, move_time, from_addr, to_addr, items_desc, reward } = req.body;
    const imgUrl = req.file ? req.file.path : '';
    await pool.query(
        `INSERT INTO tasks (publisher_id, move_date, move_time, from_addr, to_addr, items_desc, reward, img_url) 
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [publisher_id, move_date, move_time, from_addr, to_addr, items_desc, reward, imgUrl]
    );
    res.json({ success: true });
});

app.get('/api/task/all', async (req, res) => {
    const result = await pool.query(`
        SELECT t.*, u.anonymous_name, u.rating_avg 
        FROM tasks t JOIN users u ON t.publisher_id = u.student_id 
        WHERE t.status = 'pending' ORDER BY t.id DESC
    `);
    res.json({ success: true, list: result.rows });
});

app.post('/api/task/workflow', async (req, res) => {
    const { task_id, status, helper_id } = req.body;
    if (status === 'assigned') {
        await pool.query(`UPDATE tasks SET status = $1, helper_id = $2 WHERE id = $3`, [status, helper_id, task_id]);
    } else {
        await pool.query(`UPDATE tasks SET status = $1 WHERE id = $2`, [status, task_id]);
    }
    res.json({ success: true });
});

app.post('/api/user/dashboard', async (req, res) => {
    const result = await pool.query(`SELECT * FROM tasks WHERE publisher_id = $1 OR helper_id = $1 ORDER BY id DESC`, [req.body.student_id]);
    res.json({ success: true, list: result.rows });
});

app.post('/api/user/profile', async (req, res) => {
    const result = await pool.query(`SELECT * FROM users WHERE student_id = $1`, [req.body.student_id]);
    res.json({ success: true, user: result.rows[0] });
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 DormLift NZ V8.0 Production Online`));
