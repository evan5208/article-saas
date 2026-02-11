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
    // 使用本地代理（你电脑上的 Gemini API）
    const response = await fetch('http://localhost:8787/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });
    
    const data = await response.json();
    
    if (data.error) {
      res.json({ ok: false, error: data.error });
    } else {
      res.json({ ok: true, image: data.image });
    }
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});
