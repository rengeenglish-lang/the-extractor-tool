# Link to MP3: Node server with yt-dlp and ffmpeg installed.
FROM node:20-bookworm-slim

# ffmpeg for MP3 encoding, python3 + pip for yt-dlp.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages yt-dlp \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
