require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

// --- 1. Cloudinary Setup (For Task Images) ---
cloudinary.config({ 
  cloud_name: process.env.CLOUDINARY_NAME, 
  api_key: process.env.CLOUDINARY_KEY, 
  api_secret: process.env.CLOUDINARY_SECRET 
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'dormlift_v8_nz',
    allowed_formats: ['jpg', 'png', 'jpeg'],
  },
});
const upload = multer({ storage: storage });

// --- 2. SMTP Setup (For Real Gmail Verification) ---
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_EMAIL,    // From Railway Variables
    pass: process.env.SMTP_PASSWORD // From Railway Variables (App Password)
  }
});

// Temporary in-memory store for verification codes
const verificationCodes = new Map();

// --- 3. PostgreSQL Connection ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } 
});

const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        student_id TEXT PRIMARY KEY, school_name TEXT, first_name TEXT, given_name TEXT, 
        anonymous_name TEXT, phone TEXT, email TEXT UNIQUE, password TEXT,
        rating_avg REAL DEFAULT 5.0, task_count INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY, publisher_id TEXT, helper_id TEXT,
        move_date TEXT, move_time TEXT, from_addr TEXT, to_addr TEXT, 
        items_desc TEXT, reward TEXT, has_elevator BOOLEAN DEFAULT false, 
        load_weight TEXT, img_url TEXT, status TEXT DEFAULT 'pending', 
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS reviews (
        id SERIAL PRIMARY KEY, task_id INTEGER, from_id TEXT, to_id TEXT, score INTEGER, comment TEXT
      );
    `);
    console.log("✅ Database tables initialized for NZ production.");
  } catch (err) { console.error("❌ DB Init Error:", err); }
};
initDB();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// --- 4. Authentication API ---

// SEND REAL VERIFICATION CODE
app.post('/api/auth/send-code', async (req, res) => {
    const { email } = req.body;
    if (!email.toLowerCase().endsWith('.ac.nz')) {
        return res.status(400).json({ success: false, message: "Only .ac.nz emails are allowed." });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    verificationCodes.set(email, { code, expires: Date.now() + 600000 }); // 10 mins expiry

    try {
        await transporter.sendMail({
            from: `"DormLift NZ" <${process.env.SMTP_EMAIL}>`,
            to: email,
            subject: 'DormLift | Your Verification Code',
            html: `
                <div style="font-family: sans-serif; padding: 20px; border: 1px solid #3498db; border-radius: 12px;">
                    <h2 style="color: #3498db;">Verify Your Account</h2>
                    <p>Kia Ora! Use this code to join the student moving community:</p>
                    <div style="font-size: 32px; font-weight: bold; color: #2c3e50; padding: 20px; background: #f4f7f9; text-align: center;">
                        ${code}
                    </div>
                </div>`
        });
        res.json({ success: true, message: "Code sent!" });
    } catch (err) {
        res.status(500).json({ success: false, message: "Email service failed." });
    }
});

// REGISTER WITH CODE VERIFICATION
app.post('/api/auth/register', async (req, res) => {
    const { student_id, email, password, code, first_name, given_name, anonymous_name, phone } = req.body;
    
    const record = verificationCodes.get(email);
    if (!record || record.code !== code || Date.now() > record.expires) {
        return res.status(400).json({ success: false, message: "Invalid or expired code." });
    }

    try {
        const hashed = await bcrypt.hash(password, 10);
        await pool.query(
            `INSERT INTO users (student_id, email, password, first_name, given_name, anonymous_name, phone, school_name) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [student_id, email, hashed, first_name, given_name, anonymous_name, phone, "University of Auckland"]
        );
        verificationCodes.delete(email);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ success: false, message: "User ID already exists." });
    }
});

// LOGIN
app.post('/api/auth/login', async (req, res) => {
    const result = await pool.query(`SELECT * FROM users WHERE student_id = $1`, [req.body.student_id]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(req.body.password, user.password))) {
        return res.status(401).json({ success: false, message: "Invalid credentials." });
    }
    delete user.password;
    res.json({ success: true, user });
});

// --- 5. Task & Workflow API ---

app.post('/api/task/create', upload.single('task_image'), async (req, res) => {
    const { publisher_id, move_date, move_time, from_addr, to_addr, items_desc, reward, has_elevator, load_weight } = req.body;
    const imgUrl = req.file ? req.file.path : '';
    await pool.query(
        `INSERT INTO tasks (publisher_id, move_date, move_time, from_addr, to_addr, items_desc, reward, has_elevator, load_weight, img_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [publisher_id, move_date, move_time, from_addr, to_addr, items_desc, reward, has_elevator === 'true', load_weight, imgUrl]
    );
    res.json({ success: true });
});

app.get('/api/task/all', async (req, res) => {
    const result = await pool.query(`SELECT t.*, u.anonymous_name as pub_name, u.rating_avg FROM tasks t JOIN users u ON t.publisher_id = u.student_id WHERE t.status = 'pending' ORDER BY t.id DESC`);
    res.json({ success: true, list: result.rows });
});

app.post('/api/task/workflow', async (req, res) => {
    const { task_id, status, helper_id } = req.body;
    if (helper_id) await pool.query(`UPDATE tasks SET status = $1, helper_id = $2 WHERE id = $3`, [status, helper_id, task_id]);
    else await pool.query(`UPDATE tasks SET status = $1 WHERE id = $2`, [status, task_id]);
    res.json({ success: true });
});

app.post('/api/user/profile', async (req, res) => {
    const result = await pool.query(`SELECT * FROM users WHERE student_id = $1`, [req.body.student_id]);
    res.json({ success: true, user: result.rows[0] });
});

app.post('/api/user/dashboard', async (req, res) => {
    const result = await pool.query(`SELECT * FROM tasks WHERE publisher_id = $1 OR helper_id = $1 ORDER BY id DESC`, [req.body.student_id]);
    res.json({ success: true, list: result.rows });
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 DormLift NZ V8.0 PRO Online on port ${PORT}`));
