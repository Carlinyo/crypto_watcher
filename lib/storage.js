// Надёжное хранение состояния на диске.
// • запись атомарная: во временный файл → fsync → переименование; при сбое питания или падении
//   программы посреди записи старый файл остаётся целым;
// • предыдущая версия хранится в .bak — если основной файл всё же повреждён, читается она;
// • файлы доступны только владельцу (0600): в них журнал сделок и история.
import fs from 'node:fs';
import path from 'node:path';

export function writeJsonAtomic(file, data, { pretty = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const json = pretty ? JSON.stringify(data, null, 1) : JSON.stringify(data);
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (fs.existsSync(file)) {
    try { fs.renameSync(file, `${file}.bak`); } catch { /* не критично */ }
  }
  fs.renameSync(tmp, file);
}

/** Прочитать JSON; если файл повреждён — взять резервную копию (.bak), если и её нет — fallback */
export function readJson(file, fallback = null, { log = console.error } = {}) {
  for (const f of [file, `${file}.bak`]) {
    let raw;
    try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
    try {
      const v = JSON.parse(raw);
      if (f !== file) log(`⚠️ ${path.basename(file)} повреждён или отсутствует — восстановлено из резервной копии`);
      return v;
    } catch {
      log(`⚠️ ${path.basename(f)} повреждён (${raw.length} байт) — ${f === file ? 'пробую резервную копию' : 'резервная копия тоже повреждена'}`);
      try { fs.copyFileSync(f, `${f}.corrupt-${Date.now()}`); } catch { /* для разбора */ }
    }
  }
  return fallback;
}
