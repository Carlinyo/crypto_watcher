FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Yerevan
RUN apk add --no-cache tzdata
COPY package.json ./
RUN npm install --omit=optional --omit=dev --no-audit --no-fund
COPY . .
VOLUME /app/data
CMD ["node", "index.js"]
