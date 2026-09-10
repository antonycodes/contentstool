// Vercel Serverless Function — render link web thành PDF bằng headless Chromium
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

const ASSET_WAIT_TIMEOUT = 15000;
const LAZY_LOAD_PAUSE = 180;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function safeLogUrl(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch (_) {
    return '[invalid-url]';
  }
}

async function activateLazyContent(page) {
  await page.evaluate(async ({ pause, maxSteps }) => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const stepSize = () => Math.max(400, Math.floor(window.innerHeight * 0.8));

    // Scroll in increments so IntersectionObserver-based lazy loaders see each section.
    let lastHeight = -1;
    let stableAtEnd = 0;
    let y = 0;
    for (let step = 0; step < maxSteps; step += 1) {
      const height = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
      );
      const maxY = Math.max(0, height - window.innerHeight);
      y = Math.min(y + stepSize(), maxY);
      window.scrollTo(0, y);
      await wait(pause);

      const currentHeight = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
      );
      const atEnd = window.scrollY >= Math.max(0, currentHeight - window.innerHeight - 4);
      if (atEnd && currentHeight === lastHeight) stableAtEnd += 1;
      else stableAtEnd = 0;
      lastHeight = currentHeight;

      if (atEnd && stableAtEnd >= 2) break;
    }

    // Trigger lazy content inside independently scrolling panels too.
    const containers = Array.from(document.querySelectorAll('*'))
      .filter((element) => {
        const style = getComputedStyle(element);
        return (
          element.scrollHeight > element.clientHeight + 4
          && /(auto|scroll|overlay)/.test(style.overflowY)
        );
      })
      .slice(0, 40);

    for (const container of containers) {
      const maxTop = container.scrollHeight - container.clientHeight;
      const increment = Math.max(300, Math.floor(container.clientHeight * 0.8));
      for (let top = 0; top < maxTop; top += increment) {
        container.scrollTop = Math.min(top + increment, maxTop);
        await wait(pause);
      }
      container.scrollTop = 0;
    }

    window.scrollTo(0, 0);
    await wait(pause);
  }, { pause: LAZY_LOAD_PAUSE, maxSteps: 120 });
}

async function waitForPageAssets(page) {
  await page.evaluate(async (timeout) => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitForImage = (image) => new Promise((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        image.removeEventListener('load', settle);
        image.removeEventListener('error', settle);
        resolve();
      };
      image.addEventListener('load', settle, { once: true });
      image.addEventListener('error', settle, { once: true });
      setTimeout(settle, timeout);
    });

    const imagePromises = Array.from(document.images).map((image) => (
      image.complete ? Promise.resolve() : waitForImage(image)
    ));
    await Promise.all(imagePromises);

    if (document.fonts && document.fonts.ready) {
      await Promise.race([document.fonts.ready, wait(timeout)]);
    }

    // CSS background images are not included in document.images.
    const backgroundUrls = new Set();
    const urlPattern = /url\(\s*["']?([^"')]+)["']?\s*\)/g;
    for (const element of document.querySelectorAll('*')) {
      const backgroundImage = getComputedStyle(element).backgroundImage;
      let match;
      while ((match = urlPattern.exec(backgroundImage)) !== null) {
        if (!match[1].startsWith('data:')) backgroundUrls.add(match[1]);
      }
    }

    await Promise.all(Array.from(backgroundUrls).map((source) => new Promise((resolve) => {
      const image = new Image();
      image.onload = resolve;
      image.onerror = resolve;
      try {
        image.src = new URL(source, document.baseURI).href;
      } catch (_) {
        resolve();
        return;
      }
      setTimeout(resolve, timeout);
    })));
  }, ASSET_WAIT_TIMEOUT);
}

async function getImageState(page) {
  return page.evaluate(() => Array.from(document.images).reduce((state, image) => {
    state.total += 1;
    if (!image.complete) state.pending += 1;
    else if (image.currentSrc && image.naturalWidth === 0) state.failed += 1;
    return state;
  }, { total: 0, pending: 0, failed: 0 }));
}

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
    const imageIssues = [];
    const recordImageIssue = (issue) => {
      if (imageIssues.length < 20) imageIssues.push(issue);
    };
    page.on('requestfailed', (request) => {
      if (request.resourceType() === 'image') {
        recordImageIssue({
          type: 'requestfailed',
          url: safeLogUrl(request.url()),
          reason: request.failure()?.errorText || 'unknown',
        });
      }
    });
    page.on('response', (response) => {
      if (response.request().resourceType() === 'image' && response.status() >= 400) {
        recordImageIssue({
          type: 'http',
          url: safeLogUrl(response.url()),
          status: response.status(),
        });
      }
    });
    await page.setViewport({ width: vpWidth, height: 1080, deviceScaleFactor: 1 });
    // PDF uses print CSS by default. Keep the page's screen layout and backgrounds.
    await page.emulateMediaType('screen');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    await activateLazyContent(page);
    await page.waitForNetworkIdle({ idleTime: 800, timeout: ASSET_WAIT_TIMEOUT }).catch(() => {});
    await waitForPageAssets(page);
    // Dynamic pages can append images after the first pass.
    await sleep(250);
    await waitForPageAssets(page);

    const imageState = await getImageState(page);
    if (imageIssues.length || imageState.pending || imageState.failed) {
      console.warn('[htmltopdf] image warnings', {
        source: safeLogUrl(url),
        state: imageState,
        requests: imageIssues,
      });
    }

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
