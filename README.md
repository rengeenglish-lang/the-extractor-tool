# Link to MP3

A bridge, not a storage service. Paste a link, the server converts its audio to MP3 and streams it straight to your browser, and the file is saved to your PC or device. The server keeps no copies.

If Google Drive is connected, the same audio is also uploaded to Drive while it streams to your device.

## How it works

1. `GET /api/extract?url=...` starts `yt-dlp` (audio only, to stdout).
2. Its output is piped into `ffmpeg`, which encodes MP3 to stdout.
3. The MP3 is streamed as the HTTP response. Nothing is written to disk.
4. The page reads the stream and saves it on the device.

## Requirements on the server

- Node.js 18 or newer
- `yt-dlp` on the PATH (or set `YTDLP_PATH`)
- `ffmpeg` with the `libmp3lame` encoder on the PATH (or set `FFMPEG_PATH`)

The host must run a long-lived process. Serverless platforms (such as Vercel functions) cannot run these binaries for the length of an extraction.

## Setup

```bash
npm install
```

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port | `3000` |
| `BASE_URL` | Public URL of the app (used for Google OAuth) | `http://localhost:3000` |
| `YTDLP_PATH` | Path to the yt-dlp binary | `yt-dlp` |
| `FFMPEG_PATH` | Path to the ffmpeg binary | `ffmpeg` |
| `MAX_CONCURRENT` | Extractions running at once | `2` |
| `MAX_RUNTIME_MS` | Hard limit per extraction | `900000` (15 min) |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID (enables Drive) | empty |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | empty |
| `SESSION_SECRET` | Cookie signing secret | random per start |

## Google Drive setup (optional)

1. In Google Cloud Console, create a project and enable the **Google Drive API**.
2. Configure the OAuth consent screen (External; add yourself as a test user).
3. Create an **OAuth client ID** of type *Web application*.
4. Add the authorized redirect URI `${BASE_URL}/auth/google/callback`
   (for local testing: `http://localhost:3000/auth/google/callback`).
5. Start the server with `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `BASE_URL` set.

The app requests only the `drive.file` scope, which limits it to files it creates.

## Run

```bash
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... BASE_URL=http://localhost:3000 npm start
```

Open http://localhost:3000.

## Notes

- Large files are held in the browser's memory until the download completes, since the browser needs the whole file to save it.
- Sessions use an in-memory store, so restarting the server disconnects Drive. Use a persistent session store before running it for more than one user.
- You are responsible for what you process.

## Find books and videos on a website

The second panel on the page takes a web page URL and lists the PDFs, e-books (EPUB, MOBI), videos (MP4, WebM, MOV, MKV, HLS, YouTube/Vimeo embeds) and audio files it links to. Picking one saves it to the connected Google Drive, or sends it to the browser when Drive is not connected. Nothing is stored on the server.

- `POST /api/materials/find` `{ url, cookie? }` returns `{ title, items }`.
- `POST /api/materials/save` `{ url, name, via, pageUrl, cookie? }`. With Drive connected it answers with progress lines (`application/x-ndjson`), otherwise with the file.
- Only public web addresses are allowed. Local and private addresses are refused (set `ALLOW_PRIVATE_HOSTS=1` for local testing only).
- The optional cookie is for sites you are logged into. It is used for that request only, sent only to the pasted site and its subdomains, and never stored or logged.
- `MAX_MATERIAL_MB` (default `1500`) and `MAX_MATERIAL_MS` (default 30 minutes) limit one transfer.
- Only fetch content you have the right to download.
