FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Yerevan HOST=0.0.0.0 PORT=8080
RUN apk add --no-cache tzdata
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
VOLUME /app/data
EXPOSE 8080
# статус «healthy/unhealthy» в docker ps; при зависании программа сама завершается и Docker её перезапускает
HEALTHCHECK --interval=60s --timeout=10s --start-period=180s --retries=5 CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "index.js"]
