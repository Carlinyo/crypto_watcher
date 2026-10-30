#!/bin/sh
# Запуск в контейнере от обычного пользователя node, а не от root:
# папка data передаётся пользователю node, затем права root сбрасываются (su-exec).
if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/data
  chown -R node:node /app/data 2>/dev/null || echo "⚠️ не удалось передать папку data пользователю node — проверьте права на ./data" >&2
  exec su-exec node "$@"
fi
exec "$@"
