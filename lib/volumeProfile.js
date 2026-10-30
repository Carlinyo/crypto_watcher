// Профиль объёма: на каких ценах исторически проходило больше всего торгов.
// POC — цена с максимальным объёмом, VAH/VAL — границы зоны, где прошло 70% объёма,
// HVN — узлы высокого объёма (сильные уровни), LVN — «пустоты», через которые цена проскакивает.
// Объём свечи распределяется по её диапазону с треугольным весом вокруг цены закрытия/типичной цены.

export function volumeProfile(candles, { bins = 60, valueArea = 0.7, weight = (c) => c.volume } = {}) {
  if (!candles?.length) return null;
  let lo = Infinity, hi = -Infinity;
  for (const c of candles) { if (c.low < lo) lo = c.low; if (c.high > hi) hi = c.high; }
  if (!(hi > lo)) return null;
  const step = (hi - lo) / bins;
  const vol = new Array(bins).fill(0);
  const idx = (p) => Math.min(bins - 1, Math.max(0, Math.floor((p - lo) / step)));

  for (const c of candles) {
    const w = weight(c);
    if (!(w > 0)) continue;
    const a = idx(c.low), b = idx(c.high);
    if (a === b) { vol[a] += w; continue; }
    // треугольное распределение: больше объёма около типичной цены свечи
    const tp = idx((c.high + c.low + c.close) / 3);
    let tot = 0;
    const ws = [];
    for (let j = a; j <= b; j++) {
      const d = Math.abs(j - tp) / (b - a + 1);
      const x = 1 - 0.6 * d;
      ws.push(x); tot += x;
    }
    for (let j = a; j <= b; j++) vol[j] += (w * ws[j - a]) / tot;
  }

  const priceAt = (j) => lo + step * (j + 0.5);
  const total = vol.reduce((s, v) => s + v, 0);
  if (!total) return null;
  const pocI = vol.indexOf(Math.max(...vol));

  // Value Area: расширяемся от POC в сторону большего объёма
  let a = pocI, b = pocI, acc = vol[pocI];
  while (acc < total * valueArea && (a > 0 || b < bins - 1)) {
    const left = a > 0 ? vol[a - 1] : -1;
    const right = b < bins - 1 ? vol[b + 1] : -1;
    if (right >= left) acc += vol[++b]; else acc += vol[--a];
  }

  // сглаживание для поиска узлов, чтобы шум соседних корзин не давал ложных пиков
  const sm = vol.map((v, j) => (vol[j - 1] ?? v) * 0.25 + v * 0.5 + (vol[j + 1] ?? v) * 0.25);
  const meanV = total / bins;
  const hvn = [], lvn = [];
  for (let j = 2; j < bins - 2; j++) {
    const isMax = sm[j] >= sm[j - 1] && sm[j] >= sm[j + 1] && sm[j] >= sm[j - 2] && sm[j] >= sm[j + 2];
    const isMin = sm[j] <= sm[j - 1] && sm[j] <= sm[j + 1];
    if (isMax && sm[j] > meanV * 1.25 && Math.abs(j - pocI) > 1) hvn.push({ price: priceAt(j), rel: sm[j] / vol[pocI] });
    if (isMin && sm[j] < meanV * 0.55 && j > a && j < b) lvn.push(priceAt(j));
  }

  return {
    poc: priceAt(pocI),
    vah: lo + step * (b + 1),
    val: lo + step * a,
    hvn: hvn.sort((x, y) => y.rel - x.rel).slice(0, 6),
    lvn,
    step,
    range: [lo, hi],
    bins: vol,
  };
}
