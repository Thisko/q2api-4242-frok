# syntax=docker/dockerfile:1
# WAF harvester 侧车镜像：独立的 Playwright/Chromium cookie 采集服务
# qwen2api 主服务通过 HTTP 调用它，主镜像因此不需要装 Chromium（大幅瘦身）
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3100 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    WAF_PROFILE_DIR=/data/chrome-profile-waf \
    TZ=Asia/Shanghai

WORKDIR /app

# 先装依赖再装 Chromium（Playwright 官方脚本负责 apt 系统依赖）
COPY package.json ./
RUN npm install --omit=dev \
 && npx playwright install --with-deps chromium \
 && npm cache clean --force

COPY index.mjs ./

RUN mkdir -p /data /ms-playwright \
 && chown -R node:node /app /data /ms-playwright

USER node

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=8s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.mjs"]