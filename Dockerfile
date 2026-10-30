FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Yerevan HOST=0.0.0.0 PORT=8080
RUN apk add --no-cache tzdata su-exec
COPY package.json ./
# --ignore-scripts: при установке зависимостей не выполняется посторонний код
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts && npm cache clean --force
# --disable-proto=delete — защита от «загрязнения прототипа» через данные из внешних API (только для самой программы)
ENV NODE_OPTIONS=--disable-proto=delete
COPY . .
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data
EXPOSE 8080
# статус «healthy/unhealthy» в docker ps; при зависании программа сама завершается и Docker её перезапускает
HEALTHCHECK --interval=60s --timeout=10s --start-period=180s --retries=5 CMD wget -qO- http://127.0.0.1:8080/health || exit 1
# программа работает от пользователя node (см. docker-entrypoint.sh)
ENTRYPOINT ["/bin/sh", "/app/docker-entrypoint.sh"]
CMD ["node", "index.js"]
