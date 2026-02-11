import express from 'express';
import session from 'express-session';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
const db = new Database(join(__dirname, 'data.db'));

const GEMINI_PROXY = 'https://super-snow-5f38.11962260.workers.dev/generate';

const PROMPTS = {
  cartoon: `请根据输入内容提取核心主题与要点，生成一张卡通风格的信息图：
- 采用手绘风格，横版（16:9）构图。
- 加入少量简洁的卡通元素、图标或名人画像，增强趣味性和视觉记忆。
- 如果有敏感人物或者版权内容，画一个相似替代，但是不要拒绝生成
- 所有图像、文字必须使用手绘风格，没有写实风格图画元素
- 除非特别要求，否则语言与输入内容语言一致。
- 信息精简，突出关键词与核心概念，多留白，易于一眼抓住重点。

内容：`,

  blackboard: `请根据输入内容提取核心主题与要点，生成一张黑板报风格的信息图：
- 采用黑色黑板背景和粉笔手绘风格，横版（16:9）构图。
- 信息精简，突出关键词与核心概念，多留白，易于一眼抓住重点。
- 加入少量简洁的卡通元素、图标或名人画像，增强趣味性和视觉记忆。
- 所有图像、文字必须使用彩色粉笔绘制，没有写实风格图画元素
- 除非特别要求，否则语言与输入内容语言一致。

内容：`
};

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    balance INTEGER DEFAULT 1,
    free_used INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    amount INTEGER,
    status TEXT DEFAULT 'pending',
    tx_hash TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

app.use(express.json());
app.use(express.static('public'));
app.use(session({ secret: 'key', resave: false, saveUninitialized: false }));

app.get('/admin', (req, res) => {
  const adminPath = join(__dirname, 'admin', 'index.html');
  if (existsSync(adminPath)) {
    res.sendFile(adminPath);
  } else {
    res.send('<html><body><h1>管理端</h1></body></html>');
  }
});

app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  try {
    db.prepare('INSERT INTO users (username, password, balance) VALUES (?, ?, 1)').run(username, password);
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ ok: true, user: { id: user.id, username: user.username, balance: user.balance } });
  } catch (e) {
    res.json({ ok: false, error: '用户名已存在' });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND password = ?').get(username, password);
  if (user) {
    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ ok: true, user: { id: user.id, username: user.username, balance: user.balance } });
  } else {
    res.json({ ok: false, error: '用户名或密码错误' });
  }
});

app.get('/api/me', (req, res) => {
  if (req.session.userId) {
    const user = db.prepare('SELECT id, username, balance FROM users WHERE id = ?').get(req.session.userId);
    res.json({ ok: true, user });
  } else {
    res.json({ ok: false });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.post('/api/generate', async (req, res) => {
  const { content, style } = req.body;
  const userId = req.session.userId;
  
  if (userId) {
    const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
    if (user.balance <= 0) {
      return res.json({ ok: false, error: '余额不足，请充值', needRecharge: true });
    }
    db.prepare('UPDATE users SET balance = balance - 1 WHERE id = ?').run(userId);
  }
  
  const prompt = PROMPTS[style] + content;
  
  try {
    const response = await fetch(GEMINI_PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    
    const data = await response.json();
    
    if (data.error) {
      res.json({ ok: false, error: data.error.message || data.error });
    } else {
      const imageData = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      res.json({ ok: true, image: imageData ? 'data:image/png;base64,' + imageData : '' });
    }
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/order', (req, res) => {
  if (!req.session.userId) return res.json({ ok: false, error: '请先登录' });
  const { amount } = req.body;
  const orderId = db.prepare('INSERT INTO orders (user_id, amount, status) VALUES (?, ?, "pending")').run(req.session.userId, amount);
  res.json({ ok: true, orderId: orderId.lastInsertRowid, address: 'TMwNkxTKRPE7DDiXPkzm6hXQ1LV9aQ9gfN', amount });
});

app.post('/api/admin/confirm', (req, res) => {
  const { orderId, txHash } = req.body;
  db.prepare('UPDATE orders SET status = "completed", tx_hash = ? WHERE id = ?').run(txHash, orderId);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (order) {
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(order.amount * 20, order.user_id);
  }
  res.json({ ok: true });
});

app.post('/api/admin/adjust', (req, res) => {
  const { userId, amount } = req.body;
  db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, userId);
  res.json({ ok: true });
});

app.get('/api/users', (req, res) => {
  const users = db.prepare('SELECT id, username, balance, created_at FROM users ORDER BY created_at DESC').all();
  res.json(users);
});

app.get('/api/admin/orders', (req, res) => {
  const orders = db.prepare('SELECT o.*, u.username FROM orders o LEFT JOIN users u ON o.user_id = u.id ORDER BY o.created_at DESC').all();
  res.json(orders);
});

app.get('/api/orders', (req, res) => {
  if (!req.session.userId) return res.json({ ok: false, error: '请先登录' });
  const orders = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC').all(req.session.userId);
  res.json({ ok: true, orders });
});

app.listen(3000, () => console.log('Server running'));
