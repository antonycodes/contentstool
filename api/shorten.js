// Vercel Serverless Function — proxy tạo shortlink qua short.io
// API key nằm trong biến môi trường SHORTIO_API_KEY (không lộ ra client)
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const key = process.env.SHORTIO_API_KEY;
  if (!key) {
    res.status(500).json({ error: 'Server chưa cấu hình SHORTIO_API_KEY' });
    return;
  }

  // Đọc body (Vercel thường tự parse JSON; fallback đọc stream)
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  if (!body) {
    body = await new Promise((resolve) => {
      let d = '';
      req.on('data', (c) => (d += c));
      req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (_) { resolve({}); } });
    });
  }

  const { originalURL, path, domain } = body || {};
  if (!originalURL) {
    res.status(400).json({ error: 'Thiếu link gốc' });
    return;
  }

  try {
    const payload = { domain: domain || 'short.vhws.online', originalURL };
    if (path) payload.path = path;
    const r = await fetch('https://api.short.io/links', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': key,
      },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      res.status(r.status).json({ error: data.error || data.message || 'Lỗi từ short.io', detail: data });
      return;
    }
    res.status(200).json({
      shortURL: data.shortURL,
      idString: data.idString,
      originalURL: data.originalURL,
      path: data.path,
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
