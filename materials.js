'use strict';

// Materials: list the PDFs, e-books, videos and audio files that a web page links to, then stream the
// one the user picks to their Google Drive (or to their device when Drive is not connected).
// Nothing is written to disk on the server.

const { spawn } = require('child_process');
const { PassThrough, Readable } = require('stream');
const net = require('net');
const { google } = require('googleapis');

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_MATERIAL_BYTES = Number(process.env.MAX_MATERIAL_MB || 1500) * 1024 * 1024;
const MAX_MATERIAL_MS = Number(process.env.MAX_MATERIAL_MS || 30 * 60 * 1000);
const MAX_ITEMS = 100;

// extension -> what it is, and the MIME type used when it is saved
const FILE_TYPES = {
  pdf: { kind: 'pdf', mime: 'application/pdf' },
  epub: { kind: 'book', mime: 'application/epub+zip' },
  mobi: { kind: 'book', mime: 'application/x-mobipocket-ebook' },
  mp4: { kind: 'video', mime: 'video/mp4' },
  webm: { kind: 'video', mime: 'video/webm' },
  mov: { kind: 'video', mime: 'video/quicktime' },
  mkv: { kind: 'video', mime: 'video/x-matroska' },
  m3u8: { kind: 'video', mime: 'video/mp4', via: 'ytdlp', ext: 'mp4' },
  mp3: { kind: 'audio', mime: 'audio/mpeg' },
  m4a: { kind: 'audio', mime: 'audio/mp4' },
  ogg: { kind: 'audio', mime: 'audio/ogg' },
  wav: { kind: 'audio', mime: 'audio/wav' }
};
const EXT_RE = /\.([a-z0-9]{2,5})$/i;
const EMBED_HOST = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com)$/i;

// ---------- Safety: only public web addresses ----------
function privateIPv4(h) {
  const [a, b] = h.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function isPublicHttpUrl(s) {
  let u;
  try { u = new URL(s); } catch (_) { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (process.env.ALLOW_PRIVATE_HOSTS === '1') return true;   // local testing only
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false;
  const ip = net.isIP(h);
  if (ip === 4) return !privateIPv4(h);
  if (ip === 6) return !(h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:'));
  return true;
}

// The user's cookie goes only to the site they pasted (and its subdomains), never to third-party hosts.
function cookieFor(target, pageUrl, cookie) {
  if (!cookie) return undefined;
  try {
    const t = new URL(target).hostname;
    const p = new URL(pageUrl).hostname;
    return t === p || t.endsWith('.' + p) ? cookie : undefined;
  } catch (_) {
    return undefined;
  }
}

// fetch that follows redirects by hand so every hop is checked and gets the right cookie.
async function safeFetch(url, { pageUrl, cookie, method = 'GET', timeoutMs = 15000, signal } = {}) {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    if (!isPublicHttpUrl(current)) throw new Error('That address is not allowed.');
    const headers = { 'User-Agent': BROWSER_UA, Accept: '*/*' };
    const c = cookieFor(current, pageUrl || url, cookie);
    if (c) headers.Cookie = c;
    if (pageUrl && pageUrl !== current) headers.Referer = pageUrl;
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    const r = await fetch(current, { method, headers, redirect: 'manual', signal: AbortSignal.any(signals) });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      current = new URL(r.headers.get('location'), current).href;
      continue;
    }
    return { res: r, finalUrl: current };
  }
  throw new Error('Too many redirects.');
}

// A clear message for a site that refused us, and a log line (host and status only) for the operator.
function siteRefused(op, url, status) {
  let host = '';
  try { host = new URL(url).host; } catch (_) {}
  console.log(`[materials] ${op} refused host=${host} http=${status}`);
  if (status === 401 || status === 403) {
    return `This site blocked the server (HTTP ${status}). If the page needs a login, paste your cookie under "Site needs a login?". Some sites refuse requests from hosting servers altogether, and then it cannot be fetched here.`;
  }
  if (status === 404 || status === 410) return `The page or file was not found (HTTP ${status}).`;
  if (status === 429) return 'The site is limiting requests (HTTP 429). Try again later.';
  return `The site answered with HTTP ${status}.`;
}

// ---------- Finding materials on a page ----------
function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&#0?38;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

function plainText(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function classify(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch (_) { return null; }
  if (EMBED_HOST.test(u.hostname)) {
    const isPlayer = /^\/(embed\/|watch$|video\/)/i.test(u.pathname) || /^player\./i.test(u.hostname) ||
      (/(^|\.)youtu\.be$/i.test(u.hostname) && u.pathname.length > 1) ||
      (/(^|\.)vimeo\.com$/i.test(u.hostname) && /^\/\d+/.test(u.pathname));
    if (isPlayer) return { kind: 'video', via: 'ytdlp', mime: 'video/mp4', ext: 'mp4' };
    return null;
  }
  const m = EXT_RE.exec(u.pathname);
  const t = m && FILE_TYPES[m[1].toLowerCase()];
  return t ? { ...t, ext: t.ext || m[1].toLowerCase() } : null;
}

function nameFromUrl(urlStr) {
  try {
    let base = new URL(urlStr).pathname.split('/').pop() || '';
    try { base = decodeURIComponent(base); } catch (_) {}
    return base.replace(EXT_RE, '').replace(/[_+]+/g, ' ').trim();
  } catch (_) {
    return '';
  }
}

function findMaterials(html, baseUrl) {
  const found = new Map();   // url -> item
  const add = (raw, text) => {
    let abs;
    try { abs = new URL(decodeEntities(raw).trim(), baseUrl).href; } catch (_) { return; }
    const cls = classify(abs);
    if (!cls) return;
    const title = (text || '').slice(0, 140) || nameFromUrl(abs) || 'Untitled';
    const old = found.get(abs);
    if (old) { if (text && old.fromName) { old.title = title; old.fromName = false; } return; }
    if (found.size < MAX_ITEMS) found.set(abs, { url: abs, kind: cls.kind, via: cls.via || 'direct', ext: cls.ext, title, fromName: !text });
  };

  // Links first, so their visible text becomes the title.
  for (const m of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) add(m[2], plainText(m[3]));
  // Then players, sources, embeds and lazy-load attributes.
  for (const m of html.matchAll(/\b(?:src|href|data-src|data-url|data-href|data-file|data-video)\s*=\s*(["'])(.*?)\1/gi)) add(m[2], '');

  return [...found.values()].map(({ fromName, ...item }) => item);
}

async function discover(pageUrl, cookie) {
  const { res: r, finalUrl } = await safeFetch(pageUrl, { pageUrl, cookie });
  if (!r.ok) throw new Error(siteRefused('find', finalUrl, r.status));

  const type = r.headers.get('content-type') || '';
  if (!/html/i.test(type)) {
    const cls = classify(finalUrl);
    if (!cls) throw new Error('That link is not a web page or a supported file.');
    return { title: nameFromUrl(finalUrl), items: [{ url: finalUrl, kind: cls.kind, via: cls.via || 'direct', ext: cls.ext, title: nameFromUrl(finalUrl) || 'File' }] };
  }

  const html = (await r.text()).slice(0, 3 * 1024 * 1024);
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const items = findMaterials(html, finalUrl);

  // Nothing linked: let yt-dlp try the page itself (video players built with scripts).
  if (!items.length) {
    items.push({ url: finalUrl, kind: 'video', via: 'ytdlp', ext: 'mp4', title: 'Video on this page (let the video finder try)' });
  }
  return { title: t ? plainText(t[1]).slice(0, 140) : '', items };
}

// ---------- Saving a material ----------
function safeName(name, ext) {
  const clean = String(name || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150) || 'material';
  return new RegExp('\\.' + ext + '$', 'i').test(clean) ? clean : `${clean}.${ext}`;
}

// Content-Disposition value that survives any filename (Turkish, Arabic, emoji): an ASCII fallback
// for old clients plus the UTF-8 form, since HTTP headers cannot carry other characters directly.
function contentDisposition(name) {
  const ascii = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  const star = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${star}`;
}

function lastLine(text, fallback) {
  const lines = String(text || '').trim().split('\n').filter(Boolean);
  return (lines[lines.length - 1] || fallback).replace(/^ERROR:\s*/, '');
}

function register(app, deps) {
  const { acquire, release, oauthClient, YTDLP } = deps;

  app.post('/api/materials/find', async (req, res) => {
    const pageUrl = String((req.body && req.body.url) || '').trim();
    const cookie = String((req.body && req.body.cookie) || '').trim() || undefined;
    if (!isPublicHttpUrl(pageUrl)) return res.status(400).json({ error: 'Enter a valid public http(s) address.' });
    try {
      res.json(await discover(pageUrl, cookie));
    } catch (e) {
      const msg = e.name === 'TimeoutError' ? 'The site took too long to answer.' : (e.message || 'Could not read that page.');
      res.status(502).json({ error: msg });
    }
  });

  app.post('/api/materials/save', async (req, res) => {
    const body = req.body || {};
    const url = String(body.url || '').trim();
    const pageUrl = String(body.pageUrl || url).trim();
    const cookie = String(body.cookie || '').trim() || undefined;
    if (!isPublicHttpUrl(url) || !isPublicHttpUrl(pageUrl)) return res.status(400).json({ error: 'Not a valid public address.' });

    const cls = classify(url) || (body.via === 'ytdlp' ? { kind: 'video', via: 'ytdlp', mime: 'video/mp4', ext: 'mp4' } : null);
    if (!cls) return res.status(400).json({ error: 'That is not a supported file type.' });
    const viaYtdlp = cls.via === 'ytdlp' || body.via === 'ytdlp';
    const filename = safeName(body.name || nameFromUrl(url), cls.ext);

    await acquire();
    let released = false;
    const finish = () => { if (!released) { released = true; release(); } };

    const abort = new AbortController();
    let proc = null;
    const stop = () => { abort.abort(); if (proc) proc.kill('SIGKILL'); };
    const timer = setTimeout(stop, MAX_MATERIAL_MS);
    res.on('close', () => { if (!res.writableEnded) stop(); clearTimeout(timer); finish(); });

    try {
      // 1. Open the source as a readable stream.
      let source;
      let total = 0;
      let stderr = '';
      if (viaYtdlp) {
        const args = ['--no-playlist', '--no-warnings', '-f', 'best[ext=mp4]/best', '-o', '-'];
        const c = cookieFor(url, pageUrl, cookie);
        if (c) args.push('--add-header', `Cookie:${c}`);
        proc = spawn(YTDLP, [...args, url]);
        proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
        source = proc.stdout;
      } else {
        const { res: r, finalUrl } = await safeFetch(url, { pageUrl, cookie, timeoutMs: 20000, signal: abort.signal });
        if (!r.ok || !r.body) throw new Error(siteRefused('save', finalUrl, r.status));
        total = Number(r.headers.get('content-length')) || 0;
        const type = r.headers.get('content-type') || '';
        if (/text\/html/i.test(type) && cls.kind !== 'video') throw new Error('The link opened a web page, not the file. It may need a login.');
        source = Readable.fromWeb(r.body);
      }
      if (total > MAX_MATERIAL_BYTES) throw new Error('That file is larger than the server allows.');

      // 2. Count bytes and enforce the size limit.
      let bytes = 0;
      const counted = new PassThrough();
      counted.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_MATERIAL_BYTES) counted.destroy(new Error('That file is larger than the server allows.'));
      });
      source.on('error', (e) => counted.destroy(e));
      source.pipe(counted);

      const mime = cls.mime || 'application/octet-stream';
      const tokens = req.session.drive && req.session.drive.tokens;

      if (!tokens) {
        // No Drive: send the file straight to the browser.
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Disposition': contentDisposition(filename),
          ...(total && !viaYtdlp ? { 'Content-Length': String(total) } : {}),
          'Cache-Control': 'no-store'
        });
        counted.pipe(res);
        counted.on('error', (e) => { console.error('Material download failed:', e.message); res.destroy(); });
        return;
      }

      // 3. Drive: stream to Drive; report progress as lines so the connection stays alive.
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      const send = (obj) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n'); };
      send({ start: true, name: filename, total });
      const tick = setInterval(() => send({ progress: bytes, total }), 1000);

      try {
        const client = oauthClient();
        client.setCredentials(tokens);
        const drive = google.drive({ version: 'v3', auth: client });
        const r = await drive.files.create({
          requestBody: { name: filename },
          media: { mimeType: mime, body: counted },
          fields: 'id,webViewLink'
        });
        send({ done: true, name: filename, bytes, driveId: r.data.id, link: r.data.webViewLink || null });
      } catch (e) {
        console.error('Material Drive upload failed:', e.message);
        send({ error: viaYtdlp && stderr ? lastLine(stderr, e.message) : (e.message || 'Upload to Drive failed.') });
      } finally {
        clearInterval(tick);
        res.end();
      }
    } catch (e) {
      const msg = e.name === 'TimeoutError' ? 'The site took too long to answer.' : (e.message || 'Could not fetch that file.');
      if (!res.headersSent) res.status(502).json({ error: msg });
      else res.end();
      finish();
    }
  });
}

module.exports = { register, findMaterials, isPublicHttpUrl, contentDisposition };
