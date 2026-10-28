'use strict';

const express = require('express');
const session = require('express-session');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(__dirname, 'downloads');
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 2);
const FILE_TTL_MS = Number(process.env.FILE_TTL_MS || 60 * 60 * 1000); // 1 hour
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

// ---------- State ----------
const jobs = new Map();   // id -> job (server-side only, file paths never sent to clients)
const queue = [];         // jobs waiting for a free worker
let active = 0;

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

function oauthClient() {
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, `${BASE_URL}/auth/google/callback`);
}

function isHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function lastLine(text) {
  const lines = String(text || '').trim().split('\n').filter(Boolean);
  return (lines[lines.length - 1] || '').replace(/^ERROR:\s*/, '');
}

function publicJob(job) {
  return {
    id: job.id,
    url: job.url,
    status: job.status,           // queued | running | done | error
    progress: job.progress,
    title: job.title,
    filename: job.filename,
    error: job.error,
    drive: job.drive              // null | { status: pending|uploading|saved|error, ... }
  };
}

// ---------- Extraction ----------
app.post('/api/jobs', (req, res) => {
  const url = String((req.body && req.body.url) || '').trim();
  if (!isHttpUrl(url)) return res.status(400).json({ error: 'Enter a valid http(s) URL.' });

  const id = crypto.randomUUID();
  const dir = path.join(DOWNLOAD_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  const driveTokens = req.session.drive ? req.session.drive.tokens : null;
  const job = {
    id, url, dir,
    status: 'queued',
    progress: 0,
    title: null,
    filename: null,
    filePath: null,
    error: null,
    drive: driveTokens ? { status: 'pending' } : null,
    driveTokens,
    createdAt: Date.now()
  };
  jobs.set(id, job);
  queue.push(job);
  pump();
  res.status(202).json({ id });
});

function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    active++;
    runJob(job).finally(() => { active--; pump(); });
  }
}

function runJob(job) {
  return new Promise((resolve) => {
    job.status = 'running';
    const args = [
      '--no-playlist',
      '--no-warnings',
      '--newline',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '-o', path.join(job.dir, '%(title).150B [%(id)s].%(ext)s'),
      job.url
    ];

    const proc = spawn(YTDLP, args);
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        const m = line.match(/\[download\]\s+([\d.]+)%/);
        if (m) job.progress = Math.min(95, parseFloat(m[1]));
      }
    });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('error', (err) => {
      job.status = 'error';
      job.error = err.code === 'ENOENT' ? 'yt-dlp is not installed on the server.' : err.message;
      resolve();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        job.status = 'error';
        job.error = lastLine(stderr) || `Extraction failed (exit code ${code}).`;
        return resolve();
      }
      const mp3 = fs.readdirSync(job.dir).find((f) => f.toLowerCase().endsWith('.mp3'));
      if (!mp3) {
        job.status = 'error';
        job.error = 'No MP3 was produced. ffmpeg may be missing on the server.';
        return resolve();
      }
      job.filename = mp3;
      job.filePath = path.join(job.dir, mp3);
      job.title = mp3.replace(/\.mp3$/i, '');
      job.progress = 100;
      job.status = 'done';
      resolve();
      if (job.driveTokens) uploadToDrive(job);   // starts immediately, does not block the download
    });
  });
}

// ---------- Google Drive ----------
async function uploadToDrive(job) {
  job.drive = { status: 'uploading' };
  try {
    const client = oauthClient();
    client.setCredentials(job.driveTokens);
    const drive = google.drive({ version: 'v3', auth: client });
    const { data } = await drive.files.create({
      requestBody: { name: job.filename },
      media: { mimeType: 'audio/mpeg', body: fs.createReadStream(job.filePath) },
      fields: 'id,name,webViewLink'
    });
    job.drive = { status: 'saved', id: data.id, name: data.name, link: data.webViewLink };
  } catch (err) {
    job.drive = { status: 'error', error: err.message || 'Upload to Google Drive failed.' };
  }
}

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found or expired.' });
  res.json(publicJob(job));
});

app.get('/api/jobs/:id/file', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done' || !job.filePath) return res.status(404).send('File not available.');
  res.download(job.filePath, job.filename);
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

// ---------- Cleanup ----------
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > FILE_TTL_MS) {
      fs.rmSync(job.dir, { recursive: true, force: true });
      jobs.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`Audio Extractor running at ${BASE_URL}`);
});
