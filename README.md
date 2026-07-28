# q2api

QW Web Chat → OpenAI API 代理，面向 N1（OpenWrt, arm64）。

侧车架构：主服务（轻量，无 Chromium）+ waf-harvester（含 Chromium 的 WAF cookie 采集器）。
WAF cookie 由 harvester 用无头浏览器自动采集，无需手动导入。

## N1 上运行（推荐：从 GHCR 直接拉取）

### 1. 登录 GHCR（镜像默认 private，需 token）
```bash
# GitHub → Settings → Developer settings → Personal access tokens → 生成只读 token（read:packages）
docker login ghcr.io -u Thisko -p ghp_你的token
```
> 想免登录：去 GitHub 个人页 → Packages 把 `q2api`、`qwaf-harvester` 改成 public。

### 2. 拉取镜像 + 启动
```bash
git clone https://github.com/Thisko/q2api-4242-frok.git
cd q2api-4242-frok
cp .env.example .env
vi .env          # 必填：QW_ACCOUNTS=邮箱:密码
docker compose -f docker-compose.n1.yml pull
docker compose -f docker-compose.n1.yml up -d
```

### 3. 验证
```bash
curl http://127.0.0.1:3000/healthz
# {"status":"ok","waf":{"mode":"remote-harvester","ready":true,...}}
```

### 4. 更新版本
```bash
docker compose -f docker-compose.n1.yml pull && up -d
```

## 接口

- `POST /v1/chat/completions` — OpenAI 聊天（支持 thinking/search/tools）
- `POST /v1/images/generations` — OpenAI 生图（默认返回 b64_json，直接显示）
- `GET /v1/models` — 模型列表
- `GET /admin` — 管理面板
- `GET /healthz` / `/readyz` — 健康检查

生图示例：
```bash
curl -X POST http://127.0.0.1:3000/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{"model":"Qw-image","prompt":"一只橘猫","n":1}'
```

## 离线/无外网 N1：用 tar 导入（备用）

GitHub Actions 每次 tag 会构建镜像，如需 tar 下载：
- 去 Actions → 对应 run → Artifacts 下载
- 或本地用 `scripts/build-all.sh` 交叉构建

```bash
docker load -i Qw-2api-1.2.0-arm64.tar
docker load -i waf-harvester-1.0.0-arm64.tar
# 此时需把 docker-compose.n1.yml 的 image 改回本地 tag
docker compose -f docker-compose.n1.yml up -d
```

## 说明
- N1 架构 `linux/arm64`，镜像由 GitHub Actions 用 QEMU 交叉构建
- WAF cookie 走无头浏览器自动采集，缓存在 `data/waf-cookies.json`，20 分钟刷新
- harvester 侧车 `shm_size: 256mb` + `seccomp:unconfined` 是 Chromium 运行所需
- 镜像地址：`ghcr.io/thisko/q2api`、`ghcr.io/thisko/qwaf-harvester`
