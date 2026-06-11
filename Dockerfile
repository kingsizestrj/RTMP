FROM node:22-alpine

RUN apk add --no-cache ffmpeg

ENV NODE_ENV=production

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

EXPOSE 3000 1935 8000

CMD ["node", "src/index.js"]
