import express from 'express';
import session from 'express-session';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const db = new Database('data.db');

const API_KEY = 'AIzaSyCWZhr9vVaNJHXULNCxhN1gtWg4tbCmlFo';

// 提示词模板
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

// 初始化数据库
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

// 注册 - 送1次免费
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

// 登录
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

// 获取用户信息
app.get('/api/me', (req, res) => {
  if (req.session.userId) {
    const user = db.prepare('SELECT id, username, balance, free_used FROM users WHERE id = ?').get(req.session.userId);
    res.json({ ok: true, user });
  } else {
    res.json({ ok: false });
  }
});

// 退出
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// 生成图片
app.post('/api/generate', async (req, res) => {
  const { content, style } = req.body;
  const userId = req.session.userId;
  
  if (userId) {
    const user = db.prepare('SELECT balance, free_used FROM users WHERE id = ?').get(userId);
    if (user.balance <= 0) {
      return res.json({ ok: false, error: '余额不足，请充值', needRecharge: true });
    }
    // 扣费
    db.prepare('UPDATE users SET balance = balance - 1 WHERE id = ?').run(userId);
  } else {
    // 未登录用户，检查IP限制（简化版用session检查）
    if (!req.session.freeUsed) {
      req.session.freeUsed = true;
    } else {
      return res.json({ ok: false, error: '免费次数已用完，请登录后充值', needLogin: true });
    }
  }
  
  // 组合完整提示词
  const prompt = PROMPTS[style] + content;
  
  try {
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=' + API_KEY,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      }
    );
    
    const data = await response.json();
    
    if (data.error) {
      res.json({ ok: false, error: data.error.message });
    } else {
      const imageData = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      res.json({ ok: true, image: imageData ? 'data:image/png;base64,' + imageData : '' });
    }
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// 创建充值订单 - 1 USDT = 20次
app.post('/api/order', (req, res) => {
  if (!req.session.userId) return res.json({ ok: false, error: '请先登录' });
  const { amount } = req.body;
  const orderId = db.prepare('INSERT INTO orders (user_id, amount, status) VALUES (?, ?, "pending")').run(req.session.userId, amount);
  res.json({ ok: true, orderId: orderId.lastInsertRowid, address: 'TMwNkxTKRPE7DDiXPkzm6hXQ1LV9aQ9gfN', amount });
});

// 确认充值
app.post('/api/admin/confirm', (req, res) => {
  const { orderId, txHash } = req.body;
  db.prepare('UPDATE orders SET status = "completed", tx_hash = ? WHERE id = ?').run(txHash, orderId);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (order) {
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(order.amount * 20, order.user_id);
  }
  res.json({ ok: true });
});

// 获取用户订单
app.get('/api/orders', (req, res) => {
  if (!req.session.userId) return res.json({ ok: false, error: '请先登录' });
  const orders = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC').all(req.session.userId);
  res.json({ ok: true, orders });
});

app.listen(3000, () => console.log('Server running'));
