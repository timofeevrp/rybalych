// Движок "потенциала улова" — реализация псевдоформулы из продуктовой концепции (раздел 5).
// Это объяснимая эвристика для MVP, а не научная модель: веса и пороги
// откалиброваны на здравом смысле и легко донастраиваются (в реальном продукте — через админку).

import { moonPhaseLabel } from "./astro.js";

const clamp = (v, min = 0, max = 100) => Math.max(min, Math.min(max, v));

function pressureScore(pressure, trend3h) {
  let score;
  const absTrend = Math.abs(trend3h);
  if (trend3h <= -1 && trend3h >= -4) score = 85; // плавное падение перед фронтом — хорошо
  else if (trend3h < -4) score = 55; // слишком резкое падение — нестабильно
  else if (absTrend < 1) score = 70; // стабильное давление — неплохо
  else if (trend3h > 1 && trend3h <= 3) score = 40; // растёт — хуже
  else score = 20; // резкий рост — плохо

  if (pressure < 995 || pressure > 1030) score -= 10;
  return clamp(score);
}

function windScore(speedMs) {
  if (speedMs < 0.5) return 50; // штиль
  if (speedMs <= 3) return 75;
  if (speedMs <= 6) return 90;
  if (speedMs <= 10) return 60;
  if (speedMs <= 14) return 35;
  return 15;
}

function tempScore(tempAir) {
  return clamp(100 - Math.abs(tempAir - 17) * 4, 10, 90);
}

function precipCloudScore(precipMm, cloudPct) {
  let score = 55;
  if (precipMm === 0) score += 10;
  else if (precipMm < 1) score += 15; // лёгкий дождь часто позитивен
  else if (precipMm < 5) score += 0;
  else score -= 30; // ливень — плохо

  if (cloudPct >= 40 && cloudPct <= 90) score += 10; // облачность продлевает активность
  else if (cloudPct < 10) score -= 5;

  return clamp(score);
}

function solunarScore(astro, now) {
  const phase = astro.moonPhaseAngle;
  let score = 50 + 40 * Math.cos(4 * Math.PI * phase);

  if (astro.isMajorWindowNow) score += 20;
  else if (astro.isMinorWindowNow) score += 10;

  const nearSun = (t) => Math.abs(now.getTime() - t.getTime()) <= 45 * 60000;
  if (nearSun(astro.sunrise) || nearSun(astro.sunset)) score += 10;

  return clamp(score);
}

const SEASON_TABLE = {
  0: 30, 1: 30, 2: 45, 3: 70, 4: 60, 5: 75,
  6: 70, 7: 65, 8: 80, 9: 75, 10: 55, 11: 35,
};
function seasonScore(date) {
  return SEASON_TABLE[date.getMonth()];
}

function userReportsScore(reports, now) {
  const recent = reports.filter((r) => {
    const hours = (now.getTime() - new Date(r.datetime).getTime()) / 3600000;
    return hours >= 0 && hours <= 72;
  });
  if (recent.length === 0) return null;

  let weightSum = 0;
  let bitingWeighted = 0;
  recent.forEach((r) => {
    const hours = (now.getTime() - new Date(r.datetime).getTime()) / 3600000;
    const weight = Math.max(0, 1 - hours / 72);
    weightSum += weight;
    bitingWeighted += (r.isBiting ? 1 : 0) * weight;
  });
  if (weightSum === 0) return null;
  return clamp((bitingWeighted / weightSum) * 100);
}

const BASE_WEIGHTS = {
  pressure: 0.2,
  wind: 0.15,
  solunar: 0.15,
  temp: 0.1,
  precipCloud: 0.1,
  season: 0.1,
  userReports: 0.2,
};

const FACTOR_LABELS = {
  pressure: { up: "Давление стабильно или плавно падает, это хороший знак", down: "Давление резко растёт, клёв может ухудшиться" },
  wind: { up: "Комфортный ветер для клёва", down: "Слишком сильный ветер или штиль" },
  solunar: { up: "Хорошая фаза луны / solunar-окно сейчас", down: "Слабая лунная фаза для клёва" },
  temp: { up: "Комфортная температура воздуха", down: "Температура далека от комфортной" },
  precipCloud: { up: "Облачность и осадки благоприятны", down: "Сильный дождь или яркое солнце мешают клёву" },
  season: { up: "Хороший сезон для клёва", down: "Не самый активный сезон" },
  userReports: { up: "Рыбаки рядом сообщают, что клюёт", down: "Рыбаки рядом сообщают, что клёв слабый" },
};

const FACTOR_NAMES = {
  pressure: "Давление",
  wind: "Ветер",
  solunar: "Луна и время суток",
  temp: "Температура",
  precipCloud: "Осадки и облачность",
  season: "Сезон",
  userReports: "Отчёты рыбаков рядом",
};

function recentReportsCount(reports, now) {
  return reports.filter((r) => {
    const hours = (now.getTime() - new Date(r.datetime).getTime()) / 3600000;
    return hours >= 0 && hours <= 72;
  }).length;
}

export function computeScore({ weather, astro, reports, now = new Date() }) {
  const subs = {
    pressure: pressureScore(weather.current.pressure, weather.current.pressureTrend3h),
    wind: windScore(weather.current.windSpeed),
    solunar: solunarScore(astro, now),
    temp: tempScore(weather.current.tempAir),
    precipCloud: precipCloudScore(weather.current.precip, weather.current.cloud),
    season: seasonScore(now),
    userReports: userReportsScore(reports, now),
  };

  const hasReports = subs.userReports !== null;
  const weights = { ...BASE_WEIGHTS };
  if (!hasReports) {
    const freed = weights.userReports;
    delete weights.userReports;
    const restKeys = Object.keys(weights);
    const restSum = restKeys.reduce((s, k) => s + weights[k], 0);
    restKeys.forEach((k) => (weights[k] += (weights[k] / restSum) * freed));
  }

  let total = 0;
  const contributions = [];
  Object.keys(weights).forEach((key) => {
    const value = subs[key];
    if (value === null || value === undefined) return;
    const w = weights[key];
    total += value * w;
    contributions.push({ key, value, weight: w, contribution: w * (value - 50) });
  });

  const score = Math.round(clamp(total));

  const sortedContributions = contributions
    .slice()
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  const topFactors = sortedContributions
    .slice(0, 2)
    .map((c) => (c.contribution >= 0 ? FACTOR_LABELS[c.key].up : FACTOR_LABELS[c.key].down));

  const allFactors = sortedContributions.map((c) => ({
    key: c.key,
    name: FACTOR_NAMES[c.key],
    value: Math.round(c.value),
    positive: c.contribution >= 0,
    label: c.contribution >= 0 ? FACTOR_LABELS[c.key].up : FACTOR_LABELS[c.key].down,
  }));

  const reportsN = recentReportsCount(reports, now);
  let confidence, confidenceText;
  if (reportsN >= 3) {
    confidence = "high";
    confidenceText = "Подтверждено свежими отчётами рыбаков рядом — прогнозу можно доверять сильнее обычного.";
  } else if (reportsN >= 1) {
    confidence = "medium";
    confidenceText = "Есть немного свежих отчётов рядом — прогноз чуть точнее, но данных пока мало.";
  } else {
    confidence = "low";
    confidenceText = "Отчётов по этой точке пока нет — прогноз строится только на погоде, луне и сезоне.";
  }

  return {
    score,
    subs,
    hasReports,
    topFactors,
    allFactors,
    confidence,
    confidenceText,
    reportsN,
    moonPhaseLabel: moonPhaseLabel(astro.moonPhaseAngle),
  };
}

export function scoreInterpretation(score) {
  if (score <= 15) return { emoji: "🔴", label: "Очень низкий шанс", tier: 0, text: "Сегодня не лучший день. Лучше выбрать другую дату." };
  if (score <= 35) return { emoji: "🟠", label: "Слабый клёв", tier: 1, text: "Шанс есть, но небольшой. Погода не на вашей стороне." };
  if (score <= 55) return { emoji: "🟡", label: "Средний потенциал", tier: 2, text: "Может сработать в правильное время суток." };
  if (score <= 75) return { emoji: "🟢", label: "Хороший шанс", tier: 3, text: "Погода располагает. Стоит выбраться." };
  if (score <= 90) return { emoji: "🟢", label: "Отличные условия", tier: 4, text: "Один из лучших дней за последнее время. Не упустите." };
  return { emoji: "🟩", label: "Пик активности", tier: 4, text: "Редкое сочетание факторов. Шансы максимальные." };
}
