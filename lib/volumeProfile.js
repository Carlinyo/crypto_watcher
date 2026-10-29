// 1. Профиль объёма: на каких ценах исторически проходило больше всего торгов.
// POC — цена с максимальным объёмом, VAH/VAL — границы зоны, где прошло 70% объёма,
// HVN — узлы высокого объёма (сильные уровни), LVN — «пустоты», через которые цена проскакивает.

export function volumeProfile(candles, { bins = 60, valueArea = 0.7 } = {}) {
  const lo = Math.min(...candles.map((c) => c.low));
  const hi = Math.max(...candles.map((c) => c.high));
  const step = (hi - lo) / bins || 1;
  const vol = new Array(bins).fill(0);
  const idx = (p) => Math.min(bins - 1, Math.max(0, Math.floor((p - lo) / step)));

  // объём свечи распределяем равномерно по ценовому диапазону, который она прошла
  for (const c of candles) {
    const a = idx(c.low), b = idx(c.high);
    const per = c.volume / (b - a + 1);
    for (let j = a; j <= b; j++) vol[j] += per;
  }

  const priceAt = (j) => lo + step * (j + 0.5);
  const total = vol.reduce((s, v) => s + v, 0);
  const pocI = vol.indexOf(Math.max(...vol));

  // Value Area: расширяемся от POC в сторону большего объёма
  let a = pocI, b = pocI, acc = vol[pocI];
  while (acc < total * valueArea && (a > 0 || b < bins - 1)) {
    const left = a > 0 ? vol[a - 1] : -1;
    const right = b < bins - 1 ? vol[b + 1] : -1;
    if (right >= left) acc += vol[++b]; else acc += vol[--a];
  }

  const mean = total / bins;
  const hvn = [], lvn = [];
  for (let j = 1; j < bins - 1; j++) {
    const localMax = vol[j] >= vol[j - 1] && vol[j] >= vol[j + 1];
    const localMin = vol[j] <= vol[j - 1] && vol[j] <= vol[j + 1];
    if (localMax && vol[j] > mean * 1.3 && j !== pocI) hvn.push(priceAt(j));
    if (localMin && vol[j] < mean * 0.6) lvn.push(priceAt(j));
  }

  return {
    poc: priceAt(pocI),
    vah: lo + step * (b + 1),
    val: lo + step * a,
    hvn,
    lvn,
    step,
    range: [lo, hi],
  };
}
