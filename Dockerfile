FROM node:24-slim
ENV NODE_ENV=production \
    TZ=Asia/Taipei \
    PORT=8080 \
    DB_FILE=/data/crawler.db \
    SITES_FILE=/data/sites.json
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY config.json ./
COPY src ./src
COPY public ./public
# 資料庫與日誌放 /data，雲端平台要掛持久化磁碟到這裡
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://localhost:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
