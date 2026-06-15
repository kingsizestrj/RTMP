FROM node:22-alpine

# yt-dlp: binário oficial mais recente (extratores do YouTube mudam com
# frequência — versões de repositório de distro ficam defasadas e quebram)
RUN apk add --no-cache ffmpeg python3 ttf-dejavu tzdata \
  && wget -qO /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp

ENV NODE_ENV=production

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

EXPOSE 3000 1935 8000

CMD ["node", "src/index.js"]
