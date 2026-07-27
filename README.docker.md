# qwen-2api

## 推荐：VPS 构建 -> N1 运行

N1 本机构建很慢/容易失败。在 x86_64 VPS 上交叉构建 arm64 镜像，再拷回 N1。

### 在 VPS 上
```bash
# 需要 docker + buildx
chmod +x scripts/build-arm64-export.sh

# 轻量版（推荐）
./scripts/build-arm64-export.sh

# 或 Playwright 自动采 cookie 版（很大）
./scripts/build-arm64-export.sh playwright
```

产物：
- `dist/qwen-2api-1.2.0-arm64.tar`
- 或 `dist/qwen-2api-1.2.0-playwright-arm64.tar`

### 拷回 N1
```bash
# 例：scp
scp dist/qwen-2api-1.2.0-arm64.tar root@<N1IP>:/root/
scp -r . root@<N1IP>:/root/qwen-2api-openwrt/
```

### 在 N1 上
```bash
cd /root/qwen-2api-openwrt
docker load -i /root/qwen-2api-1.2.0-arm64.tar
cp .env.example .env
# 编辑 QWEN_ACCOUNTS=...
docker compose up -d
# 不要再 --build
```

导入 WAF cookie（轻量版必须）：
```bash
curl -X POST http://127.0.0.1:3000/admin/api/waf/import \
  -H "Content-Type: application/json" \
  -d '{"cookie":"ssxmod_itna=...; tfstk=...; acw_tc=..."}'
```

## 本机构建（不推荐 N1）
```bash
docker compose up -d --build                 # light
docker compose -f docker-compose.playwright.yml up -d --build
```

## 说明
- N1 架构是 `linux/arm64`
- VPS 若是 amd64，必须用 buildx 的 `--platform linux/arm64`
- Playwright 镜像 tar 可能数 GB，轻量版小很多
