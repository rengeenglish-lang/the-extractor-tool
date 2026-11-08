'use strict';

// Content storyboard creator: ChatGPT writes the scenes, OpenAI's image model draws them, and the
// result can be saved to the user's Google Drive. Nothing is stored on the server.
//
// This spends the owner's OpenAI credit, so it stays switched off until both OPENAI_API_KEY and
// STORYBOARD_ACCESS_CODE are set, every call needs the access code, and each visitor is rate limited.

const crypto = require('crypto');
const express = require('express');
const { Readable } = require('stream');
const { google } = require('googleapis');

const OPENAI_BASE = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const TEXT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
// Images use OpenAI's image API. They switch off by default when the text model comes from another
// provider (Groq, Gemini...), or explicitly with STORYBOARD_IMAGES=off (or on).
const IMAGES_ENABLED = process.env.STORYBOARD_IMAGES
  ? !/^(off|0|false|no)$/i.test(process.env.STORYBOARD_IMAGES)
  : /^https:\/\/api\.openai\.com\//i.test(OPENAI_BASE);
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'dall-e-3';
const IMAGE_QUALITY = process.env.OPENAI_IMAGE_QUALITY || '';          // optional, e.g. "low" for gpt-image-1
const MAX_TEXT_PER_HOUR = Number(process.env.STORYBOARD_TEXT_PER_HOUR || 12);
const MAX_IMAGES_PER_HOUR = Number(process.env.STORYBOARD_IMAGES_PER_HOUR || 40);

const PLATFORMS = {
  youtube: { label: 'YouTube video', aspect: '16:9', pacing: 'full-length video, steady pacing with a clear hook, middle and close' },
  shorts: { label: 'Short vertical video (Shorts, Reels, TikTok)', aspect: '9:16', pacing: 'very fast pacing, a hook in the first two seconds, one idea per scene' },
  lesson: { label: 'Classroom or online lesson', aspect: '16:9', pacing: 'teaching flow: warm-up, explanation, examples, practice, recap' },
  social: { label: 'Social media carousel or post series', aspect: '1:1', pacing: 'each scene is one slide that works on its own' }
};

// ---------- Small helpers ----------
const cap = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

function sameCode(given, expected) {
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(String(expected || '')).digest();
  return crypto.timingSafeEqual(a, b);
}

// Simple per-visitor hourly counter, in memory.
const usage = new Map();
function allow(req, kind, limit) {
  const key = `${kind}:${req.ip}`;
  const now = Date.now();
  let u = usage.get(key);
  if (!u || now > u.reset) { u = { n: 0, reset: now + 3600 * 1000 }; usage.set(key, u); }
  if (u.n >= limit) return false;
  u.n++;
  if (usage.size > 5000) for (const [k, v] of usage) if (now > v.reset) usage.delete(k);
  return true;
}

async function openai(path, body, timeoutMs) {
  let r;
  try {
    r = await fetch(`${OPENAI_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (e) {
    throw Object.assign(new Error(e.name === 'TimeoutError' ? 'OpenAI took too long to answer. Try again.' : 'Could not reach OpenAI.'), { status: 504 });
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = cap(data && data.error && data.error.message, 200);
    let msg = detail || `OpenAI answered with HTTP ${r.status}.`;
    if (r.status === 401) msg = 'OpenAI rejected the API key set on the server.';
    else if (r.status === 429) msg = 'OpenAI says the rate limit or credit is used up. Try again later or check the billing page.';
    else if (r.status === 400 && /content|safety|policy/i.test(detail)) msg = 'OpenAI declined that request (content policy). Reword the topic or the scene.';
    console.log(`[storyboard] openai ${path} http=${r.status}`);
    throw Object.assign(new Error(msg), { status: 502 });
  }
  return data;
}

// ---------- Text: the storyboard ----------
function storyboardPrompt({ topic, platform, audience, tone, scenes, style, language }) {
  const p = PLATFORMS[platform];
  const system =
    'You are an experienced content storyboard writer. You turn a topic into a clear scene-by-scene storyboard ' +
    'for video or teaching content. Reply with one JSON object only, no other text, in this shape:\n' +
    '{"title": string, "logline": string, "scenes": [{"title": string, "duration": number (seconds), ' +
    '"narration": string (what is said), "visual": string (what the viewer sees), "onScreenText": string (short text on screen, may be empty), ' +
    '"imagePrompt": string (a self-contained prompt for an image model that draws this scene)}]}\n' +
    'Rules: exactly the requested number of scenes; each imagePrompt describes one concrete picture, mentions no real people ' +
    'or brands, contains no text to render in the image, and ends with the visual style given; narration and on-screen text are in the requested language.';
  const user =
    `Topic: ${topic}\nFormat: ${p.label} (${p.pacing})\nAudience: ${audience || 'general audience'}\nTone: ${tone || 'friendly and clear'}\n` +
    `Number of scenes: ${scenes}\nVisual style for every image: ${style}\nLanguage: ${language}`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

function normalizeStoryboard(raw, wanted, style) {
  const list = Array.isArray(raw && raw.scenes) ? raw.scenes : [];
  const scenes = list.slice(0, wanted).map((s, i) => ({
    n: i + 1,
    title: cap(s.title, 120) || `Scene ${i + 1}`,
    duration: Math.min(600, Math.max(1, Math.round(Number(s.duration) || 5))),
    narration: cap(s.narration, 1500),
    visual: cap(s.visual, 800),
    onScreenText: cap(s.onScreenText, 160),
    imagePrompt: cap(s.imagePrompt, 900) || cap(s.visual, 600)
  }));
  if (!scenes.length) throw Object.assign(new Error('ChatGPT did not return any scenes. Try again.'), { status: 502 });
  return { title: cap(raw.title, 140) || 'Untitled storyboard', logline: cap(raw.logline, 400), style, scenes };
}

// ---------- Images ----------
function imageSize(aspect) {
  const gptImage = /^gpt-image/i.test(IMAGE_MODEL);
  if (aspect === '9:16') return gptImage ? '1024x1536' : '1024x1792';
  if (aspect === '1:1') return '1024x1024';
  return gptImage ? '1536x1024' : '1792x1024';
}

function register(app, deps) {
  const { oauthClient } = deps;
  const configured = () => !!(process.env.OPENAI_API_KEY && process.env.STORYBOARD_ACCESS_CODE);

  app.get('/api/storyboard/status', (req, res) => {
    res.json({
      configured: configured(),
      missing: [!process.env.OPENAI_API_KEY && 'OPENAI_API_KEY', !process.env.STORYBOARD_ACCESS_CODE && 'STORYBOARD_ACCESS_CODE'].filter(Boolean),
      platforms: Object.fromEntries(Object.entries(PLATFORMS).map(([k, v]) => [k, { label: v.label, aspect: v.aspect }])),
      textModel: TEXT_MODEL,
      imageModel: IMAGE_MODEL,
      images: IMAGES_ENABLED
    });
  });

  // Everything that spends credit needs the access code.
  function guard(req, res, next) {
    if (!configured()) return res.status(503).json({ error: 'The storyboard tool is not set up on the server yet.' });
    if (!sameCode(req.get('X-Access-Code'), process.env.STORYBOARD_ACCESS_CODE)) {
      return res.status(401).json({ error: 'Wrong access code.' });
    }
    next();
  }

  app.post('/api/storyboard/generate', guard, async (req, res) => {
    const b = req.body || {};
    const topic = cap(b.topic, 1200);
    if (topic.length < 3) return res.status(400).json({ error: 'Describe the topic in a few words.' });
    const platform = PLATFORMS[b.platform] ? b.platform : 'youtube';
    const scenes = Math.min(12, Math.max(3, Math.round(Number(b.scenes) || 6)));
    const style = cap(b.style, 120) || 'clean flat illustration, soft colors';
    if (!allow(req, 'text', MAX_TEXT_PER_HOUR)) return res.status(429).json({ error: 'Hourly limit reached for storyboards. Try again later.' });

    try {
      const data = await openai('/chat/completions', {
        model: TEXT_MODEL,
        response_format: { type: 'json_object' },
        temperature: 0.8,
        messages: storyboardPrompt({
          topic, platform, scenes, style,
          audience: cap(b.audience, 160),
          tone: cap(b.tone, 80),
          language: cap(b.language, 40) || 'English'
        })
      }, 90000);
      let parsed;
      try { parsed = JSON.parse(data.choices[0].message.content); } catch (_) {
        throw Object.assign(new Error('ChatGPT answered in an unexpected format. Try again.'), { status: 502 });
      }
      const board = normalizeStoryboard(parsed, scenes, style);
      board.platform = platform;
      board.aspect = PLATFORMS[platform].aspect;
      res.json(board);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message || 'Could not create the storyboard.' });
    }
  });

  app.post('/api/storyboard/image', guard, async (req, res) => {
    if (!IMAGES_ENABLED) return res.status(404).json({ error: 'Image drawing is switched off on this server. Copy the prompts into a free image tool instead.' });
    const b = req.body || {};
    const prompt = cap(b.prompt, 1000);
    if (prompt.length < 5) return res.status(400).json({ error: 'The scene has no image prompt.' });
    const aspect = ['16:9', '9:16', '1:1'].includes(b.aspect) ? b.aspect : '16:9';
    if (!allow(req, 'image', MAX_IMAGES_PER_HOUR)) return res.status(429).json({ error: 'Hourly limit reached for images. Try again later.' });

    try {
      const body = { model: IMAGE_MODEL, prompt, n: 1, size: imageSize(aspect) };
      if (!/^gpt-image/i.test(IMAGE_MODEL)) body.response_format = 'b64_json';
      if (IMAGE_QUALITY) body.quality = IMAGE_QUALITY;
      const data = await openai('/images/generations', body, 120000);
      const item = data.data && data.data[0];
      if (!item || !item.b64_json) throw Object.assign(new Error('OpenAI did not return an image.'), { status: 502 });
      res.json({ image: `data:image/png;base64,${item.b64_json}` });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message || 'Could not create the image.' });
    }
  });

  // ---------- Save to Google Drive: one folder, then the files one at a time ----------
  function driveFor(req) {
    const tokens = req.session.drive && req.session.drive.tokens;
    if (!tokens) return null;
    const client = oauthClient();
    client.setCredentials(tokens);
    return google.drive({ version: 'v3', auth: client });
  }

  app.post('/api/storyboard/drive/folder', async (req, res) => {
    const drive = driveFor(req);
    if (!drive) return res.status(401).json({ error: 'Connect Google Drive first.' });
    try {
      const name = cap((req.body && req.body.name) || 'Storyboard', 120).replace(/[\\/:*?"<>|]+/g, '_') || 'Storyboard';
      const r = await drive.files.create({
        requestBody: { name, mimeType: 'application/vnd.google-apps.folder' },
        fields: 'id,webViewLink'
      });
      res.json({ id: r.data.id, link: r.data.webViewLink || null });
    } catch (e) {
      console.error('Storyboard Drive folder failed:', e.message);
      res.status(502).json({ error: 'Could not create the folder in Drive.' });
    }
  });

  const MIME_OK = new Set(['image/png', 'image/jpeg', 'text/markdown', 'text/plain']);
  app.post('/api/storyboard/drive/file', express.raw({ type: '*/*', limit: '12mb' }), async (req, res) => {
    const drive = driveFor(req);
    if (!drive) return res.status(401).json({ error: 'Connect Google Drive first.' });
    const folderId = String(req.query.folderId || '');
    const mime = String(req.query.mime || '');
    const name = cap(req.query.name, 150).replace(/[\\/:*?"<>|]+/g, '_');
    if (!/^[\w-]{10,}$/.test(folderId) || !MIME_OK.has(mime) || !name || !Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: 'Bad upload request.' });
    }
    try {
      await drive.files.create({
        requestBody: { name, parents: [folderId] },
        media: { mimeType: mime, body: Readable.from(req.body) },
        fields: 'id'
      });
      res.json({ ok: true });
    } catch (e) {
      console.error('Storyboard Drive upload failed:', e.message);
      res.status(502).json({ error: 'Could not upload that file to Drive.' });
    }
  });
}

module.exports = { register };
