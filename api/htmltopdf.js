// Vercel Serverless Function — render link web thành PDF bằng headless Chromium
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Đọc body
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  if (!body) {
    body = await new Promise((resolve) => {
      let d = '';
      req.on('data', (c) => (d += c));
      req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (_) { resolve({}); } });
    });
  }

  let { url, format, orientation } = body || {};
  if (!url) { res.status(400).json({ error: 'Thiếu URL' }); return; }
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const landscape = orientation === 'landscape';
  const isWide = format === '1920x1080';
  const vpWidth = isWide ? (landscape ? 1920 : 1080) : 1280;

  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
    const page = await browser.newPage();
    await page.setViewport({ width: vpWidth, height: 1080, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    // cuộn xuống cuối để kích hoạt lazy-load rồi về đầu
    await page.evaluate(async () => {
      await new Promise(r => { let y = 0; const t = setInterval(() => { window.scrollBy(0, 800); y += 800; if (y >= document.body.scrollHeight) { clearInterval(t); window.scrollTo(0, 0); r(); } }, 60); });
    });

    const pdfOpts = { printBackground: true };
    if (isWide) {
      // Full trang: bề rộng cố định, chiều cao = toàn bộ nội dung → 1 trang PDF dài
      const fullHeight = await page.evaluate(() => Math.max(
        document.body.scrollHeight, document.documentElement.scrollHeight,
        document.body.offsetHeight, document.documentElement.offsetHeight));
      pdfOpts.width = vpWidth + 'px';
      pdfOpts.height = Math.max(fullHeight, 200) + 'px';
    } else {
      pdfOpts.format = 'A4';
      pdfOpts.landscape = landscape;
      pdfOpts.margin = { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' };
    }

    const pdf = await page.pdf(pdfOpts);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(Buffer.from(pdf));
  } catch (e) {
    res.status(500).json({ error: 'Render lỗi: ' + String((e && e.message) || e) });
  } finally {
    if (browser) { try { await browser.close(); } catch (_) {} }
  }
};
