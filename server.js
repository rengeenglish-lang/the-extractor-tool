'use strict';

// Link to MP3: a bridge. Nothing is written to disk on the server.
// yt-dlp -> ffmpeg -> HTTP response -> the user's device.

const express = require('express');
const session = require('express-session');
const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const crypto = require('crypto');
const path = require('path');
const { google } = require('googleapis');

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 2);
const MAX_RUNTIME_MS = Number(process.env.MAX_RUNTIME_MS || 15 * 60 * 1000);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// ---------- App ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.use(session({
  name: 'ae.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: BASE_URL.startsWith('https://'), maxAge: 7 * 24 * 3600 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// Simple concurrency limit so one user cannot exhaust the host.
let active = 0;
const waiting = [];
function acquire() {
  return new Promise((resolve) => {
    if (active < MAX_CONCURRENT) { active++; resolve(); } else waiting.push(resolve);
  });
}
function release() {
  active--;
  const next = waiting.shift();
  if (next) { active++; next(); }
}

function isHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function sanitizeFilename(name) {
  const clean = String(name || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
  return (clean || 'audio') + '.mp3';
}

function oauthClient() {
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, `${BASE_URL}/auth/google/callback`);
}

// Ask yt-dlp for the title only (no download) so the browser gets a sensible file name.
function getTitle(url) {
  return new Promise((resolve) => {
    const p = spawn(YTDLP, ['--no-playlist', '--no-warnings', '--skip-download', '--print', '%(title)s', url]);
    let out = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), 60 * 1000);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => { clearTimeout(timer); resolve(null); });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out.trim().split('\n')[0] || null : null);
    });
  });
}

// Optional Google Drive copy. Streams the same bytes to Drive as they go to the device.
// Nothing is buffered on disk; the upload runs alongside the download.
function startDriveUpload(tokens, filename) {
  const pass = new PassThrough();
  pass.on('error', () => {});
  (async () => {
    try {
      const client = oauthClient();
      client.setCredentials(tokens);
      const drive = google.drive({ version: 'v3', auth: client });
      await drive.files.create({
        requestBody: { name: filename },
        media: { mimeType: 'audio/mpeg', body: pass },
        fields: 'id'
      });
    } catch (err) {
      console.error('Drive upload failed:', err.message);
      pass.destroy();
    }
  })();
  return pass;
}

// ---------- Extraction bridge ----------
app.get('/api/extract', async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!isHttpUrl(url)) return res.status(400).json({ error: 'Enter a valid http(s) URL.' });

  await acquire();
  let released = false;
  const finish = () => { if (!released) { released = true; release(); } };

  let ytdlp = null;
  let ffmpeg = null;
  let drive = null;
  let started = false;
  let errText = '';

  const killAll = () => {
    if (ytdlp) ytdlp.kill('SIGKILL');
    if (ffmpeg) ffmpeg.kill('SIGKILL');
  };

  // Client went away or the request ended: stop the work and free the slot.
  res.on('close', () => {
    if (!res.writableFinished) killAll();
    finish();
  });

  const timeout = setTimeout(killAll, MAX_RUNTIME_MS);

  try {
    const title = (await getTitle(url)) || 'audio';
    const filename = sanitizeFilename(title);

    ytdlp = spawn(YTDLP, ['--no-playlist', '--no-warnings', '-f', 'bestaudio/best', '-o', '-', url]);
    ffmpeg = spawn(FFMPEG, [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0', '-vn',
      '-codec:a', 'libmp3lame', '-q:a', '2',
      '-f', 'mp3', 'pipe:1'
    ]);

    ytdlp.stdout.pipe(ffmpeg.stdin);
    ytdlp.stdout.on('error', () => {});
    ffmpeg.stdin.on('error', () => {});
    ytdlp.stderr.on('data', (d) => { errText = (errText + d).slice(-2000); });
    ffmpeg.stderr.on('data', (d) => { errText = (errText + d).slice(-2000); });

    ffmpeg.stdout.on('data', (chunk) => {
      if (!started) {
        // Send headers only once audio actually starts, so failures can return a JSON error.
        started = true;
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
          'Cache-Control': 'no-store'
        });
        if (req.session.drive) drive = startDriveUpload(req.session.drive.tokens, filename);
      }
      if (drive && !drive.destroyed) drive.write(chunk);
      if (!res.write(chunk)) {
        ffmpeg.stdout.pause();
        res.once('drain', () => ffmpeg.stdout.resume());
      }
    });

    ytdlp.on('close', (code) => {
      if (code !== 0 && ffmpeg) ffmpeg.stdin.end();
    });

    ffmpeg.on('close', (code) => {
      clearTimeout(timeout);
      if (drive && !drive.destroyed) drive.end();
      if (code !== 0 || !started) {
        if (code !== 0) console.error('Extraction failed:', errText.trim().split('\n').pop());
        if (!res.headersSent) {
          res.status(502).json({ error: (errText.trim().split('\n').pop() || 'Extraction failed.').replace(/^ERROR:\s*/, '') });
        } else {
          res.end();
        }
      } else {
        res.end();
      }
      finish();
    });
  } catch (err) {
    clearTimeout(timeout);
    killAll();
    finish();
    if (!res.headersSent) res.status(500).json({ error: 'Server error while starting extraction.' });
  }
});

// ---------- Google Drive connection ----------
app.get('/api/me', (req, res) => {
  res.json({ drive: !!req.session.drive, driveConfigured: !!GOOGLE_CLIENT_ID });
});

app.get('/auth/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(500).send('Google Drive is not configured on the server.');
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const url = oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/drive.file'],
    state
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  if (!req.query.state || req.query.state !== req.session.oauthState) {
    return res.status(400).send('Invalid OAuth state. Please try connecting again.');
  }
  try {
    const { tokens } = await oauthClient().getToken(String(req.query.code || ''));
    req.session.drive = { tokens };
    delete req.session.oauthState;
    res.redirect('/');
  } catch (err) {
    res.status(500).send('Google sign-in failed.');
  }
});

app.post('/auth/google/disconnect', (req, res) => {
  req.session.drive = null;
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Link to MP3 running at ${BASE_URL}`);
});
