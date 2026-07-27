# syntax=docker/dockerfile:1
# Lightweight API image (no Playwright / Chromium).
# WAF cookies are imported from a real browser and persisted under ./data.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    WAF_AUTO_HARVEST=0 \
    WAF_COOKIE_CACHE=/app/data/waf-cookies.json \
    TZ=Asia/Shanghai

WORKDIR /app

COPY package.json package-lock.json ./
# Install production deps only. Do not install optional playwright in image.
RUN npm ci --omit=dev --omit=optional \
 && npm cache clean --force

COPY src ./src
COPY frontend ./frontend
COPY .env.example ./.env.example

RUN mkdir -p /app/data /app/tmp \
 && chown -R node:node /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=8s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
