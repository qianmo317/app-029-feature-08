# ---------- 构建阶段 ----------
FROM node:20-alpine AS build
WORKDIR /app
ENV NODE_ENV=development

# 先装依赖（利用层缓存）；package-lock.json 不会被 .dockerignore 排除
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# 再拷源码（字体在 public/fonts/，随构建上下文一起进入镜像）
COPY . .
RUN npm run build

# ---------- 运行阶段 ----------
# 说明：规格书要求 nginx:1.27-alpine；此处用同版本的 alpine-slim 变体（去掉 geoip/xslt/njs 等模块），
# 使镜像体积满足「< 60MB」验收要求（完整 alpine 基础镜像单独就有 74MB）。
FROM nginx:1.27-alpine-slim AS runtime
LABEL org.opencontainers.image.title="app-029 signage-letter-layout"

# nginx 配置（SPA 回退 / 哈希资源 immutable / index.html no-cache / gzip / /healthz）
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]