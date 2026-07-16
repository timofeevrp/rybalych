// Погодный модуль: Open-Meteo (бесплатно, без ключа). См. концепцию, п.14.

const BASE_URL = "https://api.open-meteo.com/v1/forecast";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Бесплатный Open-Meteo иногда отвечает 429 (слишком много запросов) под
// всплеском нагрузки — например, когда несколько человек одновременно
// открывают приложение с одного интернета (общий IP). Это почти всегда
// кратковременно, поэтому пробуем ещё раз с паузой вместо немедленного отказа.
async function fetchWithRetry(url, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url);
    if (res.status !== 429) return res;
    if (i < attempts - 1) await sleep(600 * (i + 1));
  }
  return fetch(url);
}

export async function fetchWeather(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    current: "temperature_2m,pressure_msl,wind_speed_10m,wind_direction_10m,precipitation,cloud_cover",
    hourly: "temperature_2m,pressure_msl,wind_speed_10m,precipitation,cloud_cover",
    past_hours: "120",
    forecast_days: "7",
    timezone: "auto",
  });

  const res = await fetchWithRetry(`${BASE_URL}?${params.toString()}`);
  if (!res.ok) throw new Error(`Weather API error: ${res.status}`);
  const json = await res.json();

  const hourlyTimes = json.hourly.time.map((t) => new Date(t));
  const nowIdx = findClosestIndex(hourlyTimes, new Date());
  const idx3hAgo = Math.max(0, nowIdx - 3);
  const idx24hAgo = Math.max(0, nowIdx - 24);

  const pressureNow = json.current.pressure_msl;
  const pressure3hAgo = json.hourly.pressure_msl[idx3hAgo];
  const pressure24hAgo = json.hourly.pressure_msl[idx24hAgo];

  // Температура воды не измеряется напрямую (нет открытых датчиков по большинству
  // водоёмов) — оцениваем её как сглаженную за 5 дней температуру воздуха: вода
  // прогревается/остывает медленнее воздуха, поэтому такое скользящее среднее —
  // куда более честный proxy, чем температура воздуха "прямо сейчас".
  const waterWindowStart = Math.max(0, nowIdx - 5 * 24);
  const waterSlice = json.hourly.temperature_2m.slice(waterWindowStart, nowIdx + 1);
  const waterTempEstimate =
    waterSlice.reduce((s, t) => s + t, 0) / waterSlice.length;

  const current = {
    time: new Date(json.current.time),
    tempAir: json.current.temperature_2m,
    waterTempEstimate,
    pressure: pressureNow,
    pressureTrend3h: pressureNow - pressure3hAgo,
    pressureTrend24h: pressureNow - pressure24hAgo,
    windSpeed: json.current.wind_speed_10m,
    windDir: json.current.wind_direction_10m,
    precip: json.current.precipitation,
    cloud: json.current.cloud_cover,
  };

  const daily = buildDailyAggregates(hourlyTimes, json.hourly, waterTempEstimate);

  return { current, daily, hourlyTimes, hourly: json.hourly, nowIdx };
}

// Простая иконка условий по трём параметрам — для быстрого визуального считывания,
// не выдаёт себя за точный "код погоды" (Open-Meteo weather_code не запрашиваем).
export function weatherIcon({ tempAir, precip, cloud }) {
  if (precip >= 0.3 && tempAir <= 0) return "🌨️";
  if (precip >= 3) return "🌧️";
  if (precip >= 0.3) return "🌦️";
  if (cloud < 20) return "☀️";
  if (cloud < 55) return "🌤️";
  if (cloud < 85) return "⛅";
  return "☁️";
}

function findClosestIndex(times, target) {
  let best = 0;
  let bestDiff = Infinity;
  times.forEach((t, i) => {
    const diff = Math.abs(t.getTime() - target.getTime());
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  });
  return best;
}

function buildDailyAggregates(times, hourly, waterTempEstimate) {
  const byDate = new Map();
  times.forEach((t, i) => {
    // пропускаем прошедшие часы (past_hours) для дневной агрегации будущих дней
    const key = t.toISOString().slice(0, 10);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(i);
  });

  const days = [...byDate.entries()].map(([dateKey, idxs]) => {
    const avg = (arr) => idxs.reduce((s, i) => s + arr[i], 0) / idxs.length;
    const first = idxs[0];
    const last = idxs[idxs.length - 1];
    const dayTempAir = avg(hourly.temperature_2m);
    return {
      date: new Date(dateKey),
      tempAir: dayTempAir,
      // на будущие дни вода меняется медленно — берём смесь текущей оценки и
      // дневного воздуха, вес воздуха растёт по мере удаления от сегодняшнего дня
      waterTempEstimate: waterTempEstimate * 0.7 + dayTempAir * 0.3,
      pressure: avg(hourly.pressure_msl),
      pressureTrend: hourly.pressure_msl[last] - hourly.pressure_msl[first],
      windSpeed: avg(hourly.wind_speed_10m),
      precip: idxs.reduce((s, i) => s + hourly.precipitation[i], 0),
      cloud: avg(hourly.cloud_cover),
    };
  });

  const today = new Date().toISOString().slice(0, 10);
  return days.filter((d) => d.date.toISOString().slice(0, 10) >= today).slice(0, 7);
}
