'use strict';

// Link to MP3: a bridge. Nothing is written to disk on the server.
// yt-dlp finds the direct audio URL -> ffmpeg reads it and encodes MP3 -> HTTP response -> the user's device.

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

// Concurrency limit so one user cannot exhaust the host.
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

function lastErrorLine(text, fallback) {
  const lines = String(text || '').trim().split('\n').filter(Boolean);
  return (lines[lines.length - 1] || fallback).replace(/^ERROR:\s*/, '');
}

function oauthClient() {
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, `${BASE_URL}/auth/google/callback`);
}

// Ask yt-dlp (one call) for the title and the direct URL of the best audio stream. ffmpeg reads
// that URL itself, which avoids piping containers that cannot be streamed (such as m4a with its
// index at the end).
function getDirectUrl(url) {
  return new Promise((resolve) => {
    const p = spawn(YTDLP, ['--no-playlist', '--no-warnings', '--impersonate', 'chrome', '-f', 'bestaudio/best', '-j', url]);
    let out = '';
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), 60 * 1000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.code === 'ENOENT' ? 'yt-dlp is not installed on the server.' : e.message });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ ok: false, error: lastErrorLine(err, 'No audio could be found at this link.') });
      try {
        const info = JSON.parse(out);
        const fmt = (info.requested_formats && info.requested_formats[0]) || info;
        if (!fmt.url) throw new Error('no url');
        resolve({
          ok: true,
          url: fmt.url,
          headers: fmt.http_headers || {},
          title: info.title || null,
          isMp3: fmt.acodec === 'mp3' || fmt.ext === 'mp3'
        });
      } catch (_) {
        resolve({ ok: false, error: 'Could not read the audio stream for this link.' });
      }
    });
  });
}

// Optional Google Drive copy. The same bytes stream to Drive during the download.
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

  let ffmpeg = null;
  let drive = null;
  let errText = '';
  let started = false;      // response headers sent, audio streaming
  let haveTitle = false;
  let titleName = null;
  let ffmpegDone = false;
  let ffmpegCode = null;
  let sawAudio = false;
  const queue = [];         // audio chunks produced before the headers can be sent

  const killAll = () => {
    if (ffmpeg) ffmpeg.kill('SIGKILL');
  };

  res.on('close', () => {
    if (!res.writableEnded) killAll();
    finish();
  });

  const timeout = setTimeout(killAll, MAX_RUNTIME_MS);

  function writeChunk(chunk) {
    if (drive && !drive.destroyed) drive.write(chunk);
    if (!res.write(chunk)) {
      ffmpeg.stdout.pause();
      res.once('drain', () => ffmpeg.stdout.resume());
    }
  }

  function tryStart() {
    if (started || !haveTitle || !sawAudio) return;
    started = true;
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Disposition': `attachment; filename="${titleName.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(titleName)}`,
      'Cache-Control': 'no-store'
    });
    if (req.session.drive) drive = startDriveUpload(req.session.drive.tokens, titleName);
    for (const chunk of queue.splice(0)) writeChunk(chunk);
    finalize();
  }

  function finalize() {
    if (!ffmpegDone) return;
    if (started) {
      if (drive && !drive.destroyed) drive.end();
      res.end();
      finish();
      return;
    }
    // Finished without audio. Wait for the title so the error can be sent as JSON.
    if (!haveTitle) return;
    clearTimeout(timeout);
    if (!res.headersSent) {
      const msg = lastErrorLine(errText, 'No audio could be extracted from this link.');
      res.status(502).json({ error: msg });
    }
    finish();
  }

  try {
    const direct = await getDirectUrl(url);
    titleName = sanitizeFilename(direct.title || 'audio');
    haveTitle = true;

    if (!direct.ok) {
      clearTimeout(timeout);
      if (!res.headersSent) res.status(502).json({ error: direct.error });
      finish();
      return;
    }

    // Pass the site's own request headers (user agent, referer, etc.) so ffmpeg can read the stream.
    const headerText = Object.entries(direct.headers || {}).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    const headerArgs = headerText ? ['-headers', headerText] : [];

    ffmpeg = spawn(FFMPEG, [
      '-hide_banner', '-loglevel', 'error',
      ...headerArgs,
      '-i', direct.url, '-vn',
      // Already MP3: copy the stream as is. Anything else is encoded.
      ...(direct.isMp3 ? ['-codec:a', 'copy'] : ['-codec:a', 'libmp3lame', '-q:a', '4']),
      '-f', 'mp3', 'pipe:1'
    ]);

    ffmpeg.stderr.on('data', (d) => { errText = (errText + d).slice(-2000); });

    ffmpeg.stdout.on('data', (chunk) => {
      sawAudio = true;
      if (!started) {
        queue.push(chunk);
        tryStart();
        return;
      }
      writeChunk(chunk);
    });

    ffmpeg.on('close', (code) => {
      clearTimeout(timeout);
      ffmpegDone = true;
      ffmpegCode = code;
      if (code !== 0) console.error('Extraction failed:', lastErrorLine(errText, `exit ${code}`));
      finalize();
    });

    tryStart();
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
