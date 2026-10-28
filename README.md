# Link to MP3

One input box. Paste a link, the server extracts the audio as MP3, you download it to your PC, and if Google Drive is connected the file is also saved there as soon as extraction finishes.

## Requirements on the server

- Node.js 18 or newer
- `yt-dlp` on the PATH (or set `YTDLP_PATH`)
- `ffmpeg` on the PATH (yt-dlp uses it to convert to MP3)

## Setup

```bash
cd audio-extractor-app
npm install
```

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port | `3000` |
| `BASE_URL` | Public URL of the app, used for Google OAuth | `http://localhost:3000` |
| `YTDLP_PATH` | Path to yt-dlp binary | `yt-dlp` |
| `MAX_CONCURRENT` | Extractions running at once | `2` |
| `FILE_TTL_MS` | How long files stay on the server | `3600000` (1 hour) |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID (enables Drive) | empty |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | empty |
| `SESSION_SECRET` | Cookie signing secret | random per start |

## Google Drive setup (optional)

1. In Google Cloud Console, create a project and enable the **Google Drive API**.
2. Configure the OAuth consent screen (External, add yourself as a test user).
3. Create an **OAuth client ID** of type *Web application*.
4. Add this authorized redirect URI: `${BASE_URL}/auth/google/callback`
   (for local testing: `http://localhost:3000/auth/google/callback`).
5. Start the server with `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `BASE_URL` set.

The app requests only the `drive.file` scope, which limits it to files it creates.

## Run

```bash
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... BASE_URL=http://localhost:3000 npm start
```

Open http://localhost:3000.

## Notes

- Sessions use an in-memory store. Restarting the server disconnects Drive and clears job history; move to a persistent session store (e.g. Redis) before running it for more than one user.
- Job files are stored in `downloads/` and deleted after one hour.
- The app does not check URLs against site rules; you are responsible for what you process.
