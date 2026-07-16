import { SEED_POINTS, FISH_SPECIES } from "./data.js";
import { Storage } from "./storage.js";
import { getAstroData } from "./astro.js";
import { fetchWeather, weatherIcon } from "./weather.js";
import { computeScore, scoreInterpretation } from "./score.js";
import { computeSpeciesLikelihood, DEFAULT_SPECIES_POOL } from "./species.js";
import { reverseGeocode, searchPlaces } from "./geocode.js";
import { getLevelInfo } from "./levels.js";
import { computeDayWindows } from "./timewindows.js";
import { computeHourlyBiteSeries } from "./bitechart.js";
import { computeWarnings } from "./warnings.js";
import { computeAchievements } from "./achievements.js";
import { getMockLeaderboard, getMonthTheme, MONTHLY_PRIZE } from "./leaderboard.js";
import { fetchKpIndex, kpLabel } from "./geomagnetic.js";
import { ARTICLES, getArticleById, estimateReadMinutes } from "./articles.js";
import { getGearTips } from "./gear.js";
import { normalizeMaxContact, renderMaxContact } from "./maxlink.js";

const DEFAULT_CENTER = { lat: 55.7558, lon: 37.6173 }; // Москва, фолбэк без геолокации

// Подсказки для поля "Область" в профиле — берём из регионов, которые уже
// есть в базе точек (нейтральный источник, ничего не придумываем и не
// перечисляем вручную); поле всё равно текстовое, можно вписать любой другой.
const RU_REGIONS = [...new Set(SEED_POINTS.map((p) => p.region).filter(Boolean))].sort();

const FISHING_EXPERIENCE_OPTIONS = [
  { value: "", label: "Не указано" },
  { value: "less1", label: "Меньше года" },
  { value: "1-3", label: "1–3 года" },
  { value: "3-5", label: "3–5 лет" },
  { value: "5-10", label: "5–10 лет" },
  { value: "10plus", label: "Больше 10 лет" },
];
const FISHING_EXPERIENCE_LABELS = Object.fromEntries(FISHING_EXPERIENCE_OPTIONS.filter((o) => o.value).map((o) => [o.value, o.label]));
const CACHE_TTL_MS = 20 * 60 * 1000;

const state = {
  userLocation: null,
  geoDenied: false,
  map: null,
  markersLayer: null,
  currentPointId: null,
  viewStack: ["home"],
  reportSelection: { isBiting: true, rating: 0, photoDataUrl: null },
  forecastCache: new Map(), // pointId -> { expires, weather, astro, result }
  dailyCache: new Map(),
};

// ---------- TOAST ----------

function showToast(message, duration = 3000) {
  const container = document.getElementById("toast-container");
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add("toast-out");
    setTimeout(() => el.remove(), 250);
  }, duration);
}

// ---------- ПРОФИЛЬ: статистика/достижения (общие хелперы) ----------

function getProfileStats() {
  const reports = Storage.getReports();
  return {
    reportsCount: reports.length,
    favCount: Storage.getFavorites().length,
    hasPhotoReport: reports.some((r) => !!r.photo),
    distinctPoints: new Set(reports.map((r) => r.pointId)).size,
  };
}

function checkNewAchievements(beforeStats, afterStats) {
  const before = computeAchievements(beforeStats);
  const after = computeAchievements(afterStats);
  return after.filter((a, i) => a.earned && !before[i].earned);
}

function getAllPoints() {
  return [...SEED_POINTS, ...Storage.getUserPoints()];
}
function getPointById(id) {
  return getAllPoints().find((p) => p.id === id);
}

// Ограничивает число одновременных запросов (вместо Promise.all по всем сразу) —
// иначе при открытии главной/карты уходит залпом 8-20+ запросов погоды разом,
// что легко упирается в лимит бесплатного Open-Meteo под нагрузкой нескольких
// пользователей одновременно (см. fetchWithRetry в weather.js — вторая линия
// защиты на тот же случай).
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}

async function getPointForecast(point) {
  const cached = state.forecastCache.get(point.id);
  if (cached && cached.expires > Date.now()) return cached;

  const weather = await fetchWeather(point.lat, point.lon);
  const astro = getAstroData(new Date(), point.lat, point.lon);
  const reports = Storage.getReports(point.id);
  const result = computeScore({ weather, astro, reports, now: new Date() });

  const entry = { expires: Date.now() + CACHE_TTL_MS, weather, astro, result };
  state.forecastCache.set(point.id, entry);
  return entry;
}

function invalidatePointCache(pointId) {
  state.forecastCache.delete(pointId);
  state.dailyCache.delete(pointId);
}

async function getDailyForecast(point) {
  const cached = state.dailyCache.get(point.id);
  if (cached && cached.expires > Date.now()) return cached.days;

  const weather = await fetchWeather(point.lat, point.lon);
  const reports = Storage.getReports(point.id);
  const days = weather.daily.map((d) => {
    const noon = new Date(d.date);
    noon.setHours(12, 0, 0, 0);
    const astro = getAstroData(noon, point.lat, point.lon);
    const dayWeather = {
      current: {
        pressure: d.pressure,
        pressureTrend3h: d.pressureTrend,
        windSpeed: d.windSpeed,
        tempAir: d.tempAir,
        precip: d.precip,
        cloud: d.cloud,
      },
    };
    const result = computeScore({ weather: dayWeather, astro, reports, now: noon });
    return {
      date: d.date,
      tempAir: d.tempAir,
      waterTempEstimate: d.waterTempEstimate,
      precip: d.precip,
      cloud: d.cloud,
      result,
    };
  });
  state.dailyCache.set(point.id, { expires: Date.now() + CACHE_TTL_MS, days });
  return days;
}

// ---------- НАВИГАЦИЯ ----------

function showView(viewId, { pushHistory = true } = {}) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.getElementById(`view-${viewId}`).classList.add("active");
  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === viewId);
  });
  if (pushHistory) state.viewStack.push(viewId);

  if (viewId === "map") initMapIfNeeded();
  if (viewId === "favorites") renderFavorites();
  if (viewId === "profile") renderProfile();
  if (viewId === "home" && homeLoadFailed) loadHome();
}

function goBack() {
  state.viewStack.pop();
  const prev = state.viewStack[state.viewStack.length - 1] || "home";
  showView(prev, { pushHistory: false });
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.viewStack = [btn.dataset.view];
    showView(btn.dataset.view, { pushHistory: false });
  });
});
document.querySelectorAll("[data-back]").forEach((btn) => {
  btn.addEventListener("click", goBack);
});

// ---------- ОНБОРДИНГ ----------

function enterApp() {
  document.getElementById("view-onboarding").classList.add("hidden");
  document.getElementById("app-shell").classList.remove("hidden");
}

function showOnboardingIfNeeded() {
  const profile = Storage.getProfile();
  if (profile.onboardingSeen) {
    enterApp();
    loadHome();
  } else {
    document.getElementById("view-onboarding").classList.remove("hidden");
    document.getElementById("app-shell").classList.add("hidden");
  }
}

document.getElementById("btn-onboarding-start").addEventListener("click", () => {
  Storage.updateProfile({ onboardingSeen: true });
  enterApp();
  loadHome();
});
document.getElementById("btn-onboarding-skip").addEventListener("click", () => {
  Storage.updateProfile({ onboardingSeen: true });
  enterApp();
  loadHome({ skipGeo: true });
});

// ---------- ГЛАВНАЯ ----------

function getLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => resolve(null),
      { timeout: 6000 }
    );
  });
}

function renderHomeSkeleton() {
  return `
    <div class="skeleton-card">
      <div class="skeleton-line" style="width:60%;height:18px;"></div>
      <div class="skeleton-line" style="width:90%;height:70px;border-radius:12px;"></div>
      <div class="skeleton-line" style="width:40%;"></div>
    </div>
    <div class="skeleton-card">
      <div class="skeleton-line" style="width:50%;"></div>
      <div class="skeleton-line" style="width:100%;"></div>
      <div class="skeleton-line" style="width:80%;"></div>
    </div>
  `;
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 5) return "Доброй ночи";
  if (h < 12) return "Доброе утро";
  if (h < 18) return "Добрый день";
  return "Добрый вечер";
}

async function loadHome({ skipGeo = false } = {}) {
  const loadingEl = document.getElementById("home-loading");
  const contentEl = document.getElementById("home-content");
  loadingEl.innerHTML = renderHomeSkeleton();
  loadingEl.classList.remove("hidden");
  contentEl.classList.add("hidden");
  homeLoadFailed = false;

  try {

  const loc = skipGeo ? null : await getLocation();
  state.userLocation = loc || DEFAULT_CENTER;
  state.geoDenied = !loc;

  const nearby = getAllPoints()
    .map((p) => ({ ...p, distanceKm: haversineKm(state.userLocation, p) }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, 8);

  const forecasts = await mapWithConcurrency(nearby, 3, (p) => getPointForecast(p).catch(() => null));
  const withForecast = nearby
    .map((point, i) => ({ point, forecast: forecasts[i] }))
    .filter((x) => x.forecast);

  loadingEl.classList.add("hidden");
  contentEl.classList.remove("hidden");

  if (!withForecast.length) {
    homeLoadFailed = true;
    contentEl.innerHTML = `<div class="empty-state"><div class="icon">🎣</div>Не получилось загрузить прогноз. Проверьте интернет и попробуйте ещё раз.<br><button class="btn-primary" style="margin-top:12px;" id="retry-home">Повторить</button></div>`;
    document.getElementById("retry-home").addEventListener("click", () => loadHome());
    return;
  }

  // "hero" — ближайшая точка с прогнозом, на её погоде строим весь обзор дня
  const hero = withForecast[0];
  const { result: heroResult, weather: heroWeather } = hero.forecast;
  const heroInterp = scoreInterpretation(heroResult.score);
  const month = new Date().getMonth();

  const dayWindows = computeDayWindows(heroWeather, hero.point.lat, hero.point.lon, Storage.getReports(hero.point.id));
  const warnings = computeWarnings(heroWeather.current, month);

  const geoNotice = state.geoDenied
    ? `<div class="card location-notice">
        <div class="ln-row">
          <span class="ln-icon">🧭</span>
          <div>
            <div class="ln-title">Геолокация выключена</div>
            <div class="ln-text">Показываю проверенные места рядом с Москвой. Можно выбрать точку на карте вручную.</div>
          </div>
        </div>
        <div class="ln-actions">
          <button class="btn-secondary" id="btn-geo-allow">Разрешить доступ</button>
          <button class="btn-secondary" id="btn-geo-map">Выбрать на карте</button>
        </div>
      </div>`
    : "";

  const bestPoints = withForecast
    .slice()
    .sort((a, b) => b.forecast.result.score - a.forecast.result.score)
    .slice(0, 3)
    .map((entry) => ({
      ...entry,
      windows: computeDayWindows(
        entry.forecast.weather,
        entry.point.lat,
        entry.point.lon,
        Storage.getReports(entry.point.id)
      ),
    }));

  const recentReports = Storage.getReports().slice(0, 3);
  const profile = Storage.getProfile();
  const profileStats = getProfileStats();
  const { current: level, next: nextLevel, progress: levelProgress } = getLevelInfo(profileStats.reportsCount);

  const html = `
    <div class="mini-profile-card" id="mini-profile-card">
      <span class="level-icon">${level.icon}</span>
      <div style="flex:1;">
        <div class="mp-name">${profile.name || "Рыбак"}</div>
        <div class="mp-level">${level.name}${nextLevel ? ` · до «${nextLevel.name}»: ${profileStats.reportsCount}/${nextLevel.threshold}` : " · максимальный уровень"}</div>
        ${nextLevel ? `<div class="level-bar"><div class="level-bar-fill" style="width:${levelProgress}%;"></div></div>` : ""}
      </div>
      <span class="mp-arrow">›</span>
    </div>

    <div class="hub-grid">
      <div class="hub-card hub-card-banner" data-hub="forecast">
        <img class="hub-banner-img" src="assets/hub-forecast.png" alt="Прогноз" />
        <div class="hub-sub">Шансы, часы и причины</div>
      </div>
      <div class="hub-card hub-card-banner" data-hub="reports">
        <img class="hub-banner-img" src="assets/hub-reports.png" alt="Отчёты" />
        <div class="hub-sub">Что ловят рядом</div>
      </div>
    </div>

    ${geoNotice}

    <div class="card" id="home-forecast-anchor">
      <div class="card-sub">${getGreeting()}. Прогноз на сегодня: ${hero.point.name}</div>
      ${renderScoreWidget(heroResult, heroInterp, weatherIcon(heroWeather.current))}
      <div class="best-window-line">⏰ Лучшее окно: ${dayWindows.best.label.toLowerCase()}, ${dayWindows.best.result.score} из 100</div>
      ${renderConfidenceBadge(heroResult)}
    </div>

    <div class="section-header"><span class="icon">⏰</span><h3>Лучшее окно сегодня</h3></div>
    <div class="card">
      <div class="window-row">
        ${dayWindows.windows
          .map(
            (w) => `
          <div class="window-pill ${w.key === dayWindows.best.key ? "best" : ""}">
            <div class="wp-icon">${w.icon}</div>
            <div class="wp-label">${w.label}</div>
            <div class="wp-score">${w.result.score}</div>
          </div>`
          )
          .join("")}
      </div>
    </div>

    <div class="section-header"><span class="icon">⚡</span><h3>Быстрые действия</h3></div>
    <div class="quick-actions">
      <div class="quick-action" data-action="report"><span class="qa-icon">📝</span>Оставить отчёт</div>
      <div class="quick-action" data-action="relocate"><span class="qa-icon">📍</span>Обновить локацию</div>
      <div class="quick-action" data-action="map"><span class="qa-icon">🗺️</span>Открыть карту</div>
      <div class="quick-action" data-action="gear"><span class="qa-icon">🎒</span>Что взять</div>
    </div>

    ${warnings.length ? `
    <div class="section-header"><span class="icon">⚠️</span><h3>Стоит учесть</h3></div>
    <div class="warning-banner">
      ${warnings.map((w) => `<div class="warning-item"><span class="w-icon">${w.icon}</span><span>${w.text}</span></div>`).join("")}
    </div>` : ""}

    <div class="section-header"><span class="icon">📍</span><h3>Куда поехать сегодня</h3></div>
    <div class="card">
      ${bestPoints.map((entry) => renderPlaceRecommendationCard(entry)).join("")}
    </div>
  `;

  contentEl.innerHTML = html;
  bindOpenPointButtons(contentEl);

  document.getElementById("mini-profile-card").addEventListener("click", () => {
    state.viewStack = ["profile"];
    showView("profile", { pushHistory: false });
  });

  contentEl.querySelector('[data-hub="forecast"]').addEventListener("click", () => {
    document.getElementById("home-forecast-anchor").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  contentEl.querySelector('[data-hub="reports"]').addEventListener("click", () => openRegions());

  contentEl.querySelector('[data-action="report"]').addEventListener("click", () => {
    state.viewStack = ["point", "report"];
    openReportForm(hero.point.id);
  });
  contentEl.querySelector('[data-action="relocate"]').addEventListener("click", async () => {
    showToast("Обновляю геолокацию...");
    await loadHome();
  });
  contentEl.querySelector('[data-action="map"]').addEventListener("click", () => showView("map"));
  contentEl.querySelector('[data-action="gear"]').addEventListener("click", () => openGearScreen(hero.point, heroWeather));

  const geoAllowBtn = document.getElementById("btn-geo-allow");
  if (geoAllowBtn) geoAllowBtn.addEventListener("click", () => loadHome());
  const geoMapBtn = document.getElementById("btn-geo-map");
  if (geoMapBtn) geoMapBtn.addEventListener("click", () => showView("map"));

  } catch (err) {
    // Раньше при сбое сети экран навсегда оставался с крутилкой — теперь
    // явная ошибка с кнопкой "Повторить", как и на карточке точки.
    homeLoadFailed = true;
    loadingEl.classList.add("hidden");
    contentEl.classList.remove("hidden");
    contentEl.innerHTML = `<div class="empty-state"><div class="icon">📡</div>Не получилось загрузить главную. Проверьте интернет и попробуйте ещё раз.<br><button class="btn-primary" style="margin-top:12px;" id="retry-home">Повторить</button></div>`;
    document.getElementById("retry-home").addEventListener("click", () => loadHome());
  }
}

// Более подробная карточка места для "Куда поехать сегодня" на главной —
// отдельная от компактного renderPointListItem, который используют
// избранное/регионы/поиск (там 3 доп. вычисления на точку не нужны).
function renderPlaceRecommendationCard({ point, forecast, distanceKm, windows }) {
  const interp = scoreInterpretation(forecast.result.score);
  const reason = forecast.result.topFactors[0] || "";
  return `
    <div class="place-card" data-open-point="${point.id}">
      <div class="point-mini-score sc-${interp.tier}">${forecast.result.score}</div>
      <div style="flex:1;">
        <div class="card-title">${point.name}</div>
        <div class="card-sub" style="margin-bottom:6px;">${point.town || ""}${distanceKm != null ? " · " + distanceKm.toFixed(1) + " км" : ""}</div>
        <div class="place-meta">
          <span class="place-meta-chip">${windows.best.icon} Лучше ${windows.best.label.toLowerCase()}</span>
          ${reason ? `<span class="place-meta-chip">${reason}</span>` : ""}
        </div>
      </div>
      <span class="place-arrow">›</span>
    </div>`;
}

function renderConfidenceBadge(result) {
  const labels = { high: "Высокая точность", medium: "Средняя точность", low: "Базовый прогноз" };
  return `<div class="confidence-badge confidence-${result.confidence}" title="${result.confidenceText}">🎯 ${labels[result.confidence]}</div>`;
}

function renderRecentReportsFeed(reports) {
  return reports
    .map((raw) => {
      const r = normalizeReport(raw);
      const point = getPointById(r.pointId);
      const date = new Date(r.datetime);
      const timeAgo = formatTimeAgo(date);
      return `
      <div class="mini-report">
        <div>${r.isBiting ? "🟢" : "🔴"}</div>
        <div style="flex:1;">
          ${renderReportAuthorLine(r)}
          <div class="mini-report-point">${locationLabel(r, point)}${r.species ? " · " + r.species : ""}</div>
          <div class="mini-report-meta">${timeAgo}${r.comment ? " · " + escapeHtml(r.comment) : ""}</div>
        </div>
      </div>`;
    })
    .join("");
}

function formatTimeAgo(date) {
  const hours = Math.round((Date.now() - date.getTime()) / 3600000);
  if (hours < 1) return "меньше часа назад";
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.round(hours / 24);
  return `${days} дн назад`;
}

function formatTime(date) {
  if (!date) return "—";
  return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function loadGeomagneticLine() {
  const el = document.getElementById("geomagnetic-line");
  if (!el) return;
  fetchKpIndex()
    .then(({ kp }) => {
      if (!document.getElementById("geomagnetic-line")) return; // экран уже сменился
      const { icon, label } = kpLabel(kp);
      document.getElementById("geomagnetic-line").innerHTML =
        `🧲 Магнитная обстановка: ${icon} ${label} (Kp ${kp.toFixed(1)}) <span style="text-decoration:underline dotted;">ⓘ</span>`;
    })
    .catch(() => {
      if (el) el.textContent = "";
    });
}

function renderScoreWidget(result, interp, icon) {
  return `
    <div class="score-widget">
      <div class="score-circle sc-${interp.tier}">
        <span class="num">${result.score}</span>
        <span class="max">/100</span>
      </div>
      <div>
        <div class="score-label">${icon ? `<span class="score-weather-icon">${icon}</span> ` : ""}${interp.emoji} ${interp.label}</div>
        <div class="score-sub">${interp.text}</div>
      </div>
    </div>
    <div class="score-factors">
      ${result.topFactors.map((f) => `<span class="factor-chip">${f}</span>`).join("")}
    </div>
    ${!result.hasReports ? `<div class="score-sub" style="margin-top:8px;">Свежих отчётов пока нет, прогноз строится на погоде и луне. Оставьте первый, и он станет точнее для всех рыбаков рядом.</div>` : ""}
  `;
}

function renderPointListItem(point, result) {
  const tier = result ? scoreInterpretation(result.score).tier : 2;
  const scoreText = result ? result.score : "…";
  return `
    <div class="point-list-item" data-open-point="${point.id}" style="margin-bottom:10px;">
      <div class="point-mini-score sc-${tier}">${scoreText}</div>
      <div>
        <div class="card-title">${point.name}</div>
        <div class="card-sub">${point.town}${point.distanceKm != null ? " · " + point.distanceKm.toFixed(1) + " км" : ""}</div>
      </div>
    </div>`;
}

function bindOpenPointButtons(container) {
  container.querySelectorAll("[data-open-point]").forEach((el) => {
    el.addEventListener("click", () => openPoint(el.dataset.openPoint));
  });
}

// ---------- КАРТА ----------

let homeLoadFailed = false;
let mapInitialized = false;
function initMapIfNeeded() {
  if (mapInitialized) {
    // контейнер карты был display:none, пока показывался другой экран —
    // без этого Leaflet считает размер карты нулевым и маркеры "уезжают"
    setTimeout(() => state.map.invalidateSize(), 0);
    renderMarkers();
    return;
  }
  mapInitialized = true;
  const center = state.userLocation || DEFAULT_CENTER;
  state.map = L.map("map", { zoomControl: false, attributionControl: false }).setView(
    [center.lat, center.lon],
    9
  );
  L.control.zoom({ position: "bottomright" }).addTo(state.map);
  // Свой attribution-контрол без дефолтного префикса Leaflet (там с версии 1.9 —
  // флаг Украины в SVG, встроенный в саму библиотеку, никак не связан с тайлами карты).
  L.control.attribution({ prefix: "Leaflet" }).addTo(state.map);

  // Схема — стандартные тайлы OpenStreetMap. Раньше тут стоял CARTO Voyager
  // (визуально мягче), но у него подписи городов по умолчанию латиницей
  // ("Pushkino" вместо "Пушкино") — для русскоязычного приложения это плохо
  // читается. У обычных тайлов OSM подписи на локальном языке (кириллица).
  // "Флаг Украины", который раньше путали с этим слоем — на самом деле
  // из атрибуции самого Leaflet (см. ниже), тайлов это не касается.
  // Спутник — Esri World Imagery, удобно смотреть форму берега и
  // растительность вокруг водоёма. Рельеф — OpenTopoMap, горизонтали высот.
  const schemeLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap",
    maxZoom: 19,
    subdomains: "abc",
  }).addTo(state.map);
  const satelliteLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { attribution: "Tiles © Esri", maxZoom: 19 }
  );
  const terrainLayer = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap, © OpenTopoMap (CC-BY-SA)",
    maxZoom: 17,
    subdomains: "abc",
  });

  // Изобаты (линии глубин) — покрытие есть в основном для морей и крупных судоходных
  // водоёмов, для небольших озёр слой обычно пустой. Необязательный оверлей, не базовый слой.
  const depthOverlay = L.tileLayer("https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png", {
    attribution: "© OpenSeaMap",
    maxZoom: 18,
    opacity: 0.8,
  });

  L.control
    .layers(
      { "🗺️ Схема": schemeLayer, "🛰️ Спутник": satelliteLayer, "⛰️ Рельеф": terrainLayer },
      { "🌊 Глубины (где есть данные)": depthOverlay },
      { position: "bottomright", collapsed: true }
    )
    .addTo(state.map);

  state.markersLayer = L.layerGroup().addTo(state.map);

  if (state.userLocation) {
    L.circleMarker([state.userLocation.lat, state.userLocation.lon], {
      radius: 7,
      color: "#1f5e3e",
      fillColor: "#4caf7d",
      fillOpacity: 1,
    }).addTo(state.map).bindPopup("Вы здесь");
  }

  renderMarkers();

  state.map.on("click", (e) => {
    // Если открыт превью-лист точки — первый тап по карте просто закрывает его,
    // чтобы не ставить adhoc-точку случайно поверх уже выбранного места.
    if (closePlaceSheet()) return;
    openAdhocPoint(e.latlng.lat, e.latlng.lng);
  });
}

// ---------- ПРЕВЬЮ ТОЧКИ НА КАРТЕ (bottom-sheet) ----------

function closePlaceSheet() {
  const sheet = document.getElementById("map-place-sheet");
  const wasOpen = sheet.classList.contains("open");
  sheet.classList.remove("open");
  return wasOpen;
}

async function showPlaceSheet(point) {
  const sheet = document.getElementById("map-place-sheet");
  sheet.classList.add("open");
  sheet.innerHTML = `<div class="state-block" style="padding:16px;"><div class="spinner" style="width:22px;height:22px;margin:0 auto;"></div></div>`;

  try {
    const { result, weather } = await getPointForecast(point);
    const interp = scoreInterpretation(result.score);
    const dayWindows = computeDayWindows(weather, point.lat, point.lon, Storage.getReports(point.id));
    const loc = state.userLocation || DEFAULT_CENTER;
    const distanceKm = haversineKm(loc, point);
    const isFav = Storage.isFavorite(point.id);

    sheet.innerHTML = `
      <div class="ps-head">
        <div class="point-mini-score sc-${interp.tier}">${result.score}</div>
        <div style="flex:1;">
          <div class="ps-title">${point.name}</div>
          <div class="ps-sub">${interp.emoji} ${interp.label} · ${distanceKm.toFixed(1)} км · лучше ${dayWindows.best.label.toLowerCase()}</div>
        </div>
        <button class="ps-close" id="ps-close-btn">✕</button>
      </div>
      <div class="ps-actions">
        <button class="btn-primary" id="ps-forecast-btn">Прогноз</button>
        <button class="btn-secondary" id="ps-route-btn">Маршрут</button>
        <button class="btn-secondary" id="ps-save-btn">${isFav ? "★ В избранном" : "☆ Сохранить"}</button>
      </div>
    `;
    document.getElementById("ps-close-btn").addEventListener("click", closePlaceSheet);
    document.getElementById("ps-forecast-btn").addEventListener("click", () => {
      closePlaceSheet();
      openPoint(point.id);
    });
    document.getElementById("ps-route-btn").addEventListener("click", () => {
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${point.lat},${point.lon}`, "_blank");
    });
    document.getElementById("ps-save-btn").addEventListener("click", () => {
      Storage.toggleFavorite(point.id);
      showPlaceSheet(point);
    });
  } catch {
    sheet.innerHTML = `<div class="empty-state" style="padding:12px;font-size:13px;">Не получилось загрузить прогноз для точки.</div>`;
  }
}

async function renderMarkers() {
  closePlaceSheet();
  state.markersLayer.clearLayers();
  const typeFilter = document.getElementById("filter-type").value;
  let points = getAllPoints();
  if (typeFilter !== "all") {
    points = points.filter((p) => (typeFilter === "paid" ? p.paid : p.type === typeFilter));
  }

  const markerEntries = points.map((point) => {
    const icon = L.divIcon({
      className: "marker-score",
      html: `<div class="map-pin sc-2"><span>…</span></div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 30],
    });
    const marker = L.marker([point.lat, point.lon], { icon }).addTo(state.markersLayer);
    marker.on("click", () => showPlaceSheet(point));
    return { point, marker };
  });

  // Запросы погоды на все маркеры разом (их может быть 20+) — ограничиваем
  // параллелизм, см. mapWithConcurrency.
  await mapWithConcurrency(markerEntries, 3, async ({ point, marker }) => {
    try {
      const { result } = await getPointForecast(point);
      const interp = scoreInterpretation(result.score);
      marker.setIcon(
        L.divIcon({
          className: "marker-score",
          html: `<div class="map-pin sc-${interp.tier}"><span>${result.score}</span></div>`,
          iconSize: [30, 30],
          iconAnchor: [15, 30],
        })
      );
    } catch {
      // маркер остаётся с placeholder-иконкой — не критично
    }
  });
}

document.getElementById("filter-type").addEventListener("change", renderMarkers);

document.getElementById("btn-locate").addEventListener("click", async () => {
  const loc = await getLocation();
  if (loc && state.map) {
    state.userLocation = loc;
    state.map.setView([loc.lat, loc.lon], 11);
  }
});

let searchDebounceTimer = null;
let searchRequestId = 0;

function renderLocalMatches(matches) {
  return matches
    .map((p) => `<div class="map-search-result" data-goto-point="${p.id}">${p.name}<div class="sr-town">${p.town || ""}</div></div>`)
    .join("");
}

document.getElementById("map-search").addEventListener("input", (e) => {
  const rawQuery = e.target.value.trim();
  const q = rawQuery.toLowerCase();
  const resultsEl = document.getElementById("map-search-results");
  clearTimeout(searchDebounceTimer);
  const requestId = ++searchRequestId;

  if (!q) {
    resultsEl.classList.add("hidden");
    resultsEl.innerHTML = "";
    return;
  }

  const matches = getAllPoints()
    .filter((p) => p.name.toLowerCase().includes(q))
    .slice(0, 8);

  resultsEl.innerHTML = matches.length
    ? renderLocalMatches(matches)
    : `<div class="map-search-result" style="color:var(--gray-500);">Ищем «${escapeHtml(rawQuery)}» на карте...</div>`;
  resultsEl.classList.remove("hidden");

  // В своей базе только около 20 точек — если там пусто или мало, ищем
  // название на реальной карте (Nominatim/OSM), с задержкой, чтобы не
  // долбить бесплатный geo-сервис на каждое нажатие клавиши.
  if (matches.length >= 3) return;
  searchDebounceTimer = setTimeout(async () => {
    let remote = [];
    try {
      remote = await searchPlaces(rawQuery);
    } catch {
      // тихо игнорируем — локальные совпадения (если были) уже показаны
    }
    if (requestId !== searchRequestId) return; // пользователь уже печатает дальше

    if (!matches.length && !remote.length) {
      resultsEl.innerHTML = `<div class="map-search-result" style="color:var(--gray-500);">Ничего не нашлось</div>`;
      return;
    }
    const remoteHtml = remote
      .map(
        (r, i) => `
        <div class="map-search-result" data-goto-remote="${i}">
          🌍 ${escapeHtml(r.name)}
          <div class="sr-town">${escapeHtml(r.fullLabel)}</div>
        </div>`
      )
      .join("");
    resultsEl.innerHTML = renderLocalMatches(matches) + remoteHtml;
    resultsEl.dataset.remoteResults = JSON.stringify(remote);
  }, 400);
});

document.getElementById("map-search-results").addEventListener("click", (e) => {
  const pointEl = e.target.closest("[data-goto-point]");
  if (pointEl) {
    document.getElementById("map-search").value = "";
    document.getElementById("map-search-results").classList.add("hidden");
    openPoint(pointEl.dataset.gotoPoint);
    return;
  }
  const remoteEl = e.target.closest("[data-goto-remote]");
  if (remoteEl) {
    const resultsEl = document.getElementById("map-search-results");
    const remote = JSON.parse(resultsEl.dataset.remoteResults || "[]");
    const place = remote[Number(remoteEl.dataset.gotoRemote)];
    if (!place) return;
    document.getElementById("map-search").value = "";
    resultsEl.classList.add("hidden");
    if (mapInitialized) state.map.setView([place.lat, place.lon], 12);
    openAdhocPoint(place.lat, place.lon, place.name);
  }
});

function typeLabel(type) {
  return { lake: "Озеро", river: "Река", reservoir: "Водохранилище", paid: "Платный водоём" }[type] || type;
}

// ---------- КАРТОЧКА ТОЧКИ (в т.ч. точка, выбранная тапом по карте) ----------

function makeAdhocPoint(lat, lon, name) {
  return {
    id: `adhoc_${lat.toFixed(4)}_${lon.toFixed(4)}`,
    name: name || `Точка на карте (${lat.toFixed(3)}, ${lon.toFixed(3)})`,
    type: null,
    town: null,
    lat,
    lon,
    paid: false,
    species: [],
    rules: "",
    adhoc: true,
  };
}

function openAdhocPoint(lat, lon, name) {
  openPoint(makeAdhocPoint(lat, lon, name));
}

function saveAdhocPoint(point) {
  const name = window.prompt("Название места:", point.name.split(" (")[0] === "Точка на карте" ? "" : point.name) || "Моя точка";
  const type = window.prompt("Тип водоёма (lake / river / reservoir / paid):", "lake") || "lake";
  const saved = { ...point, id: "u" + Date.now(), name, type, town: point.town || "Добавлено вами", adhoc: false };
  Storage.addUserPoint(saved);
  Storage.toggleFavorite(saved.id);
  if (mapInitialized) renderMarkers();
  return saved;
}

let currentDays = [];
let currentSelectedIdx = 0;
let currentOpenPoint = null;
let currentWeather = null;
let currentReports = [];
let biteChartMode = "weather";

async function openPoint(pointOrId) {
  const point = typeof pointOrId === "string" ? getPointById(pointOrId) : pointOrId;
  state.currentPointId = point.id;
  currentOpenPoint = point;
  showView("point");
  const container = document.getElementById("point-content");
  container.innerHTML = `<div class="state-block"><div class="spinner"></div><p>Считаем прогноз для «${point.name}»...</p></div>`;

  try {
    const [{ result, weather }, days] = await Promise.all([
      getPointForecast(point),
      getDailyForecast(point),
    ]);
    // "Сегодня" показываем по данным live-погоды (точнее дневного агрегата)
    days[0] = {
      date: days[0]?.date || new Date(),
      tempAir: weather.current.tempAir,
      waterTempEstimate: weather.current.waterTempEstimate,
      precip: weather.current.precip,
      cloud: weather.current.cloud,
      result,
      isNow: true,
    };
    currentDays = days;
    currentSelectedIdx = 0;
    currentWeather = weather;
    biteChartMode = "weather";

    const reports = point.adhoc ? [] : Storage.getReports(point.id);
    currentReports = reports;
    const isFav = point.adhoc ? false : Storage.isFavorite(point.id);
    const isAdhoc = !!point.adhoc;

    const dayWindows = computeDayWindows(weather, point.lat, point.lon, reports);
    const warnings = computeWarnings(weather.current, new Date().getMonth());
    const astroNow = getAstroData(new Date(), point.lat, point.lon);
    const speciesPool = point.species?.length ? point.species : DEFAULT_SPECIES_POOL;

    container.innerHTML = `
      <div class="card">
        <div class="card-row">
          <div>
            <div class="card-title" style="font-size:18px;">${point.name}</div>
            <div class="card-sub" id="point-subtitle">${point.type ? typeLabel(point.type) + " · " : ""}${point.town || "Определяем район…"}${point.paid ? " · 💰 " + (point.price || "платно") : ""}</div>
          </div>
        </div>
        ${point.species?.length ? `<div class="tags">${point.species.map((s) => `<span class="tag">${s}</span>`).join("")}</div>` : ""}

        <div class="day-pills" id="day-pills"></div>

        <div id="score-widget-slot"></div>
        <div style="margin-top:6px;color:var(--gray-500);font-size:12px;" id="moon-phase-line"></div>
        <div style="margin-top:2px;color:var(--gray-500);font-size:12px;">
          🌙 ${astroNow.lunarDay}-й лунный день · восход луны ${formatTime(astroNow.moonrise)} · заход ${formatTime(astroNow.moonset)}
        </div>
        <div style="margin-top:2px;color:var(--gray-500);font-size:12px;" id="geomagnetic-line" title="Информационно: научная связь геомагнитной активности с клёвом не подтверждена.">🧲 Проверяем геомагнитную обстановку…</div>
      </div>

      <div class="section-header"><span class="icon">⏰</span><h3>Лучшие часы сегодня</h3></div>
      <div class="card">
        <div class="window-row">
          ${dayWindows.windows
            .map(
              (w) => `
            <div class="window-pill ${w.key === dayWindows.best.key ? "best" : ""}">
              <div class="wp-icon">${w.icon}</div>
              <div class="wp-label">${w.label}</div>
              <div class="wp-score">${w.result.score}</div>
            </div>`
            )
            .join("")}
        </div>
      </div>

      <div class="section-header"><span class="icon">📊</span><h3>Клёв по часам</h3></div>
      <div class="card" id="bite-chart-slot"></div>

      <div class="section-header"><span class="icon">🌦️</span><h3>Погода по часам</h3></div>
      <div class="card">
        ${renderHourlyStrip(weather)}
      </div>

      <div class="section-header"><span class="icon">📉</span><h3>Давление за 48 часов</h3></div>
      <div class="card">
        ${renderPressureSparkline(weather)}
      </div>

      ${warnings.length ? `
      <div class="warning-banner">
        ${warnings.map((w) => `<div class="warning-item"><span class="w-icon">${w.icon}</span><span>${w.text}</span></div>`).join("")}
      </div>` : ""}

      <div class="card">
        <div class="card-title">Почему такой прогноз?</div>
        <div id="why-slot"></div>
      </div>

      <div class="card" id="species-slot"></div>

      <div class="section-header"><span class="icon">📅</span><h3>Клёв по видам и времени суток</h3></div>
      <div class="card">
        ${renderSpeciesGrid(speciesPool, dayWindows, weather.current.waterTempEstimate)}
        <div class="card-sub" style="margin-top:8px;margin-bottom:0;">Баллы 0–100, как и общий прогноз. Это не проценты вероятности.</div>
      </div>

      <div class="quick-report-box">
        <div class="qr-label">Как сейчас клюёт? Отметьте за секунду, это сразу улучшит прогноз</div>
        <div class="quick-report-row">
          <button class="qr-btn qr-yes" id="btn-quick-yes">🟢 Клюёт</button>
          <button class="qr-btn qr-no" id="btn-quick-no">🔴 Не клюёт</button>
        </div>
      </div>

      <div class="card-row" style="gap:8px;margin-bottom:14px;">
        <button class="btn-secondary" id="btn-fav" style="flex:1;">${isAdhoc ? "💾 Сохранить точку" : isFav ? "★ В избранном" : "☆ Сохранить"}</button>
        <button class="btn-secondary" id="btn-route" style="flex:1;">🧭 Маршрут</button>
        <button class="btn-secondary" id="btn-report" style="flex:1;">📋 Подробно</button>
      </div>

      ${point.rules ? `<div class="card"><div class="card-title">Правила / ограничения</div><div class="card-sub">${point.rules}</div></div>` : ""}

      ${!isAdhoc ? `
      <div class="card">
        <div class="card-title">Отчёты рыбаков (${reports.length})</div>
        ${renderReportsList(reports, point)}
      </div>` : `<div class="empty-state" style="font-size:13px;">Сохраните это место, чтобы оставлять отчёты и видеть, что здесь ловят другие рыбаки.</div>`}
    `;

    renderDayPills();
    updateScoreSlot();
    updateWhySlot();
    updateSpeciesSlot(point);
    updateBiteChartSlot();
    loadGeomagneticLine();
    bindReportAuthorLinks(container);

    if (!point.town) {
      reverseGeocode(point.lat, point.lon)
        .then(({ town, region }) => {
          if (!town || currentOpenPoint !== point) return;
          point.town = town;
          point.region = region;
          const subtitleEl = document.getElementById("point-subtitle");
          if (subtitleEl) {
            subtitleEl.textContent = `${point.type ? typeLabel(point.type) + " · " : ""}${town}`;
          }
        })
        .catch(() => {
          const subtitleEl = document.getElementById("point-subtitle");
          if (subtitleEl && subtitleEl.textContent.includes("Определяем")) {
            subtitleEl.textContent = "Координаты выбраны на карте";
          }
        });
    }

    document.getElementById("btn-fav").addEventListener("click", () => {
      if (isAdhoc) {
        const saved = saveAdhocPoint(point);
        openPoint(saved.id);
      } else {
        Storage.toggleFavorite(point.id);
        openPoint(point.id);
      }
    });
    document.getElementById("btn-route").addEventListener("click", () => {
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${point.lat},${point.lon}`, "_blank");
    });
    document.getElementById("btn-report").addEventListener("click", () => {
      if (isAdhoc) {
        const saved = saveAdhocPoint(point);
        openReportForm(saved.id);
      } else {
        openReportForm(point.id);
      }
    });
    document.getElementById("btn-quick-yes").addEventListener("click", () => submitQuickReport(point, isAdhoc, true));
    document.getElementById("btn-quick-no").addEventListener("click", () => submitQuickReport(point, isAdhoc, false));
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><div class="icon">📡</div>Не достучались до погодного сервиса. Проверьте интернет и попробуйте ещё раз.<br><button class="btn-primary" style="margin-top:12px;" id="retry-point">Повторить</button></div>`;
    document.getElementById("retry-point").addEventListener("click", () => openPoint(point));
  }
}

// Быстрый отчёт в 1-2 тапа: без формы, для тех, кому некогда её заполнять на воде.
// Полную форму (вид рыбы, фото, наживка) можно добавить отдельно кнопкой "Подробно".
function submitQuickReport(point, isAdhoc, isBiting) {
  const targetPoint = isAdhoc ? saveAdhocPoint(point) : point;
  const statsBefore = getProfileStats();
  const profile = Storage.getProfile();
  const authorVisibility = profile.privacy.defaultReportAuthorVisibility;

  const report = {
    id: "r" + Date.now(),
    pointId: targetPoint.id,
    datetime: new Date().toISOString(),
    isBiting,
    species: "",
    amount: "",
    tackle: "",
    bait: "",
    comment: "",
    photo: null,
    rating: 0,
    locationPrivacy: profile.privacy.defaultLocationPrivacy,
    authorVisibility,
    ...(authorVisibility === "named"
      ? { authorName: profile.name, authorLevel: getLevelInfo(statsBefore.reportsCount).current.name, authorAvatar: profile.avatar || null }
      : {}),
    quick: true,
  };
  Storage.addReport(report);
  invalidatePointCache(targetPoint.id);

  const statsAfter = getProfileStats();
  const newAchievements = checkNewAchievements(statsBefore, statsAfter);

  showToast(isBiting ? "Отмечено: клюёт! Спасибо, учли в прогнозе. 🎣" : "Отмечено: не клюёт. Тоже полезная информация, спасибо!");
  newAchievements.forEach((a, i) => {
    setTimeout(() => showToast(`🏅 Новое достижение: «${a.title}»`), 1400 + i * 1800);
  });

  openPoint(targetPoint.id);
}

function renderDayPills() {
  const dayNames = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
  const el = document.getElementById("day-pills");
  el.innerHTML = currentDays
    .map((d, idx) => {
      const interp = scoreInterpretation(d.result.score);
      const label = d.isNow ? "Сейчас" : idx === 1 ? "Завтра" : dayNames[d.date.getDay()];
      return `
      <div class="day-pill ${idx === currentSelectedIdx ? "selected" : ""}" data-day-idx="${idx}">
        <div class="day-pill-label">${label}</div>
        <div class="score-circle sc-${interp.tier}" style="width:44px;height:44px;">
          <span class="num" style="font-size:14px;">${d.result.score}</span>
        </div>
      </div>`;
    })
    .join("");
  el.querySelectorAll(".day-pill").forEach((pillEl) => {
    pillEl.addEventListener("click", () => {
      currentSelectedIdx = Number(pillEl.dataset.dayIdx);
      renderDayPills();
      updateScoreSlot();
      updateWhySlot();
      updateSpeciesSlot(currentOpenPoint);
      updateBiteChartSlot();
    });
  });
}

function updateScoreSlot() {
  const day = currentDays[currentSelectedIdx];
  const interp = scoreInterpretation(day.result.score);
  const slot = document.getElementById("score-widget-slot");
  slot.innerHTML =
    renderScoreWidget(day.result, interp, weatherIcon(day)) +
    renderConfidenceBadge(day.result) +
    (!day.isNow
      ? `<div class="future-note">Прогноз на будущую дату менее точен: погода и solunar-окна могут измениться.</div>`
      : "");
  const moonLineEl = document.getElementById("moon-phase-line");
  moonLineEl.textContent =
    `Фаза луны: ${day.result.moonPhaseLabel} · Вода (≈): ${Math.round(day.waterTempEstimate)}°C, воздух: ${Math.round(day.tempAir)}°C`;
  moonLineEl.title = "Температура воды — оценка по сглаженной температуре воздуха за 5 дней, не прямое измерение датчиком.";
}

function updateWhySlot() {
  const day = currentDays[currentSelectedIdx];
  const slot = document.getElementById("why-slot");
  slot.innerHTML = day.result.allFactors
    .map(
      (f) => `
      <div class="factor-row ${f.positive ? "positive" : "negative"}">
        <div class="fr-top">
          <span class="fr-name">${f.name}</span>
          <span class="fr-value">${f.value}/100</span>
        </div>
        <div class="fr-label">${f.label}</div>
      </div>`
    )
    .join("");
}

function updateSpeciesSlot(point) {
  const day = currentDays[currentSelectedIdx];
  const isGeneric = !point.species || !point.species.length;
  const pool = isGeneric ? DEFAULT_SPECIES_POOL : point.species;
  const list = computeSpeciesLikelihood(pool, day.date.getMonth(), day.waterTempEstimate, day.result.score).slice(0, 3);

  const slot = document.getElementById("species-slot");
  slot.innerHTML = `
    <div class="card-title">Что может клевать ${isGeneric ? "в этом районе" : "здесь"}</div>
    ${isGeneric ? `<div class="card-sub">Виды для этой точки неизвестны, оценка ориентировочная для региона.</div>` : ""}
    ${list
      .map((s, i) => {
        const tier = scoreInterpretation(s.score).tier;
        return `
        <div class="species-row ${i === 0 ? "top" : ""}">
          <div class="species-row-head">
            <span class="species-name">${i === 0 ? "🏆 " : ""}${s.name}</span>
            <span class="species-score sc-${tier}">${s.score}/100</span>
          </div>
          <div class="species-bait">🪱 ${s.bait} · 🎣 ${s.tackle}</div>
        </div>`;
      })
      .join("")}
  `;
}

function updateBiteChartSlot() {
  const day = currentDays[currentSelectedIdx];
  const slot = document.getElementById("bite-chart-slot");
  if (!slot || !day || !currentWeather || !currentOpenPoint) return;
  const series = computeHourlyBiteSeries({
    weather: currentWeather,
    lat: currentOpenPoint.lat,
    lon: currentOpenPoint.lon,
    reports: currentReports,
    date: day.date,
  });
  slot.innerHTML = renderBiteChart(series, biteChartMode, !!day.isNow, new Date().getHours());
}

document.getElementById("point-content").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-bc-mode]");
  if (!btn) return;
  biteChartMode = btn.dataset.bcMode;
  updateBiteChartSlot();
});

// Почасовой бар-чарт клёва на сутки (00–23): высота и цвет бара = score/100,
// текущий час подсвечен и подписан значением. Есть вкладки погода/луна —
// solunar-подсчёт берём как отдельный субфактор той же формулы (score.js).
function renderBiteChart(series, mode, isToday, nowHour) {
  const key = mode === "moon" ? "solunarScore" : "score";
  const W = 300, H = 96, padTop = 14;
  const slotW = W / 24;
  const barW = Math.max(1, slotW - 2);

  const bars = series.hours
    .map((h, i) => {
      const val = h[key];
      const barH = Math.max(2, (val / 100) * H);
      const x = i * slotW + (slotW - barW) / 2;
      const y = padTop + H - barH;
      const isNow = isToday && h.hour === nowHour;
      if (isNow) {
        return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="2" class="bc-bar bc-bar-now" />
          <text x="${(x + barW / 2).toFixed(1)}" y="${Math.max(10, y - 5).toFixed(1)}" class="bc-now-label">${val}%</text>`;
      }
      const opacity = (0.28 + (val / 100) * 0.72).toFixed(2);
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="2" class="bc-bar" style="opacity:${opacity}" />`;
    })
    .join("");

  const gridLines = [25, 50, 75, 100]
    .map((pct) => {
      const y = (padTop + H - (pct / 100) * H).toFixed(1);
      return `<line x1="0" y1="${y}" x2="${W}" y2="${y}" class="bc-grid" />`;
    })
    .join("");

  const summary =
    mode === "moon"
      ? { avg: series.avgSolunar, peak: series.peakSolunarLabel, good: series.goodSolunarLabel }
      : { avg: series.avgScore, peak: series.peakLabel, good: series.goodLabel };

  return `
    <div class="bite-chart-tabs">
      <button class="bc-tab ${mode === "weather" ? "active" : ""}" data-bc-mode="weather">Клёв по погоде</button>
      <button class="bc-tab ${mode === "moon" ? "active" : ""}" data-bc-mode="moon">Клёв по луне</button>
    </div>
    <svg viewBox="0 0 ${W} ${padTop + H}" class="bite-chart" preserveAspectRatio="none">
      ${gridLines}
      ${bars}
    </svg>
    <div class="bite-chart-hours">
      ${[0, 4, 8, 12, 16, 20].map((h) => `<span>${String(h).padStart(2, "0")}:00</span>`).join("")}
    </div>
    <div class="bite-chart-summary">
      <div class="bcs-item"><div class="bcs-label">Пик клёва</div><div class="bcs-value">${summary.peak}</div></div>
      <div class="bcs-item"><div class="bcs-label">Средняя оценка</div><div class="bcs-value">${summary.avg}%</div></div>
      <div class="bcs-item"><div class="bcs-label">Хороший клёв</div><div class="bcs-value">${summary.good}</div></div>
    </div>
  `;
}

// Сетка "вид рыбы × время суток" — как в народных рыболовных календарях,
// но на нашей реальной погодной формуле, а не по одной луне.
function renderHourlyStrip(weather) {
  const { hourlyTimes, hourly, nowIdx } = weather;
  const cells = [];
  for (let i = nowIdx; i < Math.min(nowIdx + 13, hourlyTimes.length); i++) {
    cells.push({
      time: hourlyTimes[i],
      tempAir: hourly.temperature_2m[i],
      wind: hourly.wind_speed_10m[i],
      precip: hourly.precipitation[i],
      cloud: hourly.cloud_cover[i],
    });
  }
  return `
    <div class="hourly-strip">
      ${cells
        .map(
          (c, idx) => `
        <div class="hourly-cell">
          <div class="hc-time">${idx === 0 ? "Сейчас" : formatTime(c.time)}</div>
          <div class="hc-icon">${weatherIcon(c)}</div>
          <div class="hc-temp">${Math.round(c.tempAir)}°</div>
          <div class="hc-wind">💨 ${Math.round(c.wind)}</div>
        </div>`
        )
        .join("")}
    </div>
  `;
}

function renderPressureSparkline(weather) {
  const { hourly, nowIdx } = weather;
  const start = Math.max(0, nowIdx - 24);
  const end = Math.min(hourly.pressure_msl.length, nowIdx + 25);
  const slice = hourly.pressure_msl.slice(start, end);
  const min = Math.min(...slice);
  const max = Math.max(...slice);
  const range = max - min || 1;
  const w = 300, h = 64, pad = 4;

  const points = slice
    .map((p, i) => {
      const x = pad + (i / (slice.length - 1)) * (w - pad * 2);
      const y = h - pad - ((p - min) / range) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const nowX = (pad + ((nowIdx - start) / (slice.length - 1)) * (w - pad * 2)).toFixed(1);
  const nowY = (h - pad - ((hourly.pressure_msl[nowIdx] - min) / range) * (h - pad * 2)).toFixed(1);

  return `
    <svg viewBox="0 0 ${w} ${h}" class="pressure-sparkline" preserveAspectRatio="none">
      <polyline points="${points}" class="ps-line" />
      <line x1="${nowX}" y1="0" x2="${nowX}" y2="${h}" class="ps-now-line" />
      <circle cx="${nowX}" cy="${nowY}" r="3" class="ps-now-dot" />
    </svg>
    <div class="ps-labels">
      <span>−24ч</span>
      <span>сейчас</span>
      <span>+24ч</span>
    </div>
    <div class="card-sub" style="margin-top:4px;margin-bottom:0;">
      Мин ${Math.round(min)} · сейчас ${Math.round(hourly.pressure_msl[nowIdx])} · макс ${Math.round(max)} гПа
    </div>
  `;
}

function renderSpeciesGrid(pool, dayWindows, waterTemp) {
  const rows = pool.map((name) => {
    const cells = dayWindows.windows.map((w) => {
      // температура воды почти не меняется в течение суток — берём общую оценку
      // на сегодня, а по времени суток варьируется общий score окна
      const [s] = computeSpeciesLikelihood([name], w.time.getMonth(), waterTemp, w.result.score);
      return { key: w.key, icon: w.icon, score: s.score };
    });
    return { name, cells };
  });

  return `
    <div class="sg-wrap">
      <table class="species-grid">
        <thead>
          <tr>
            <th></th>
            ${dayWindows.windows.map((w) => `<th>${w.icon}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (r) => `
            <tr>
              <td class="sg-name">${r.name}</td>
              ${r.cells.map((c) => `<td><span class="sg-cell sc-${scoreInterpretation(c.score).tier}">${c.score}</span></td>`).join("")}
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderReportsList(reports, point) {
  if (!reports.length) {
    return `<div class="empty-state"><div class="icon">📝</div>Отчётов здесь пока нет. Оставьте первый — это минута, зато другим рыбакам будет полезно.</div>`;
  }
  return reports
    .map((raw) => {
      const r = normalizeReport(raw);
      const date = new Date(r.datetime);
      return `
      <div class="report-item">
        ${renderReportAuthorLine(r)}
        <div class="report-item-head">
          <span>${locationLabel(r, point)} · ${date.toLocaleDateString("ru-RU")} ${date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</span>
          <span class="${r.isBiting ? "report-biting-yes" : "report-biting-no"}">${r.isBiting ? "🟢 Клюёт" : "🔴 Не клюёт"}</span>
        </div>
        ${r.species ? `<div style="font-weight:600;margin-top:4px;">${escapeHtml(r.species)}${r.amount ? " · " + escapeHtml(r.amount) : ""}</div>` : ""}
        ${r.photo ? `<img class="report-photo" src="${r.photo}" />` : ""}
        ${r.comment ? `<div style="font-size:14px;margin-top:4px;">${escapeHtml(r.comment)}</div>` : ""}
        ${r.rating ? `<div style="color:var(--yellow);margin-top:4px;">${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}</div>` : ""}
      </div>`;
    })
    .join("");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Приводит отчёт (в т.ч. старый, сохранённый до появления авторства/приватности
// места) к безопасному виду для отображения. Координат в модели отчёта никогда
// не было — раскрывать в старых записях нечего сверх названия точки.
const LEGACY_VISIBILITY_MAP = { public: "water", area: "district", private: "hidden" };
function normalizeReport(r) {
  const locationPrivacy = r.locationPrivacy || LEGACY_VISIBILITY_MAP[r.visibility] || "hidden";
  const authorVisibility = r.authorVisibility || "anonymous";
  return { ...r, locationPrivacy, authorVisibility };
}

function locationLabel(report, point) {
  const p = point || getPointById(report.pointId);
  switch (report.locationPrivacy) {
    case "exact":
      return p ? p.name : "Точка";
    case "district":
      return `Район: ${(p && (p.town || p.region)) || "не указан"}`;
    case "water":
      return `Водоём: ${p ? p.name : "не указан"}`;
    default:
      return "Место скрыто";
  }
}

function renderReportAuthorLine(report) {
  if (report.authorVisibility !== "named" || !report.authorName) {
    return `<div class="report-author"><span class="ra-avatar">🎣</span><span class="ra-name">Анонимный рыбак</span></div>`;
  }
  const avatar = report.authorAvatar
    ? `<img src="${report.authorAvatar}" class="ra-avatar-img" />`
    : `<span class="ra-avatar">🎣</span>`;
  return `
    <div class="report-author" data-open-public-profile="1" style="cursor:pointer;">
      ${avatar}
      <span class="ra-name">${escapeHtml(report.authorName)}</span>
      ${report.authorLevel ? `<span class="ra-level">${escapeHtml(report.authorLevel)}</span>` : ""}
    </div>`;
}

function bindReportAuthorLinks(container) {
  container.querySelectorAll("[data-open-public-profile]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      openPublicProfile();
    });
  });
}

// ---------- ФОРМА ОТЧЁТА ----------

function openReportForm(pointId) {
  const point = getPointById(pointId);
  const profile = Storage.getProfile();
  document.getElementById("report-point-id").value = pointId;
  document.getElementById("report-form").reset();
  state.reportSelection = {
    isBiting: true,
    rating: 0,
    photoDataUrl: null,
    authorVisibility: profile.privacy.defaultReportAuthorVisibility,
  };
  document.querySelectorAll("[data-biting]").forEach((b) => b.classList.toggle("active", b.dataset.biting === "true"));
  document.querySelectorAll("[data-author]").forEach((b) => b.classList.toggle("active", b.dataset.author === state.reportSelection.authorVisibility));
  document.querySelectorAll("#report-stars span").forEach((s) => s.classList.remove("active"));
  document.getElementById("report-photo-preview").innerHTML = "";
  document.getElementById("photo-upload-label").classList.remove("has-photo");
  document.getElementById("photo-upload-text").textContent = "Нажмите, чтобы сделать фото или выбрать из галереи";
  document.getElementById("report-point-display").innerHTML = point
    ? `📍 ${point.name}${point.town ? ` <span class="card-sub" style="margin:0;">· ${point.town}</span>` : ""}`
    : "";
  const locationSelect = document.getElementById("report-location-privacy");
  locationSelect.value = profile.privacy.defaultLocationPrivacy;
  document.getElementById("report-exact-warning").style.display = locationSelect.value === "exact" ? "block" : "none";
  showView("report");
}

document.querySelectorAll("[data-biting]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-biting]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.reportSelection.isBiting = btn.dataset.biting === "true";
  });
});

document.querySelectorAll("[data-author]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-author]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.reportSelection.authorVisibility = btn.dataset.author;
  });
});

document.getElementById("report-location-privacy").addEventListener("change", (e) => {
  document.getElementById("report-exact-warning").style.display = e.target.value === "exact" ? "block" : "none";
});

document.querySelectorAll("#report-stars span").forEach((star) => {
  star.addEventListener("click", () => {
    const val = Number(star.dataset.star);
    state.reportSelection.rating = val;
    document.querySelectorAll("#report-stars span").forEach((s) => {
      s.classList.toggle("active", Number(s.dataset.star) <= val);
    });
  });
});

document.getElementById("report-photo").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    state.reportSelection.photoDataUrl = reader.result;
    document.getElementById("report-photo-preview").innerHTML = `<img src="${reader.result}" />`;
    document.getElementById("photo-upload-label").classList.add("has-photo");
    document.getElementById("photo-upload-text").textContent = "✅ Фото добавлено, можно заменить";
  };
  reader.readAsDataURL(file);
});

document.getElementById("report-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const pointId = document.getElementById("report-point-id").value;
  const statsBefore = getProfileStats();
  const profile = Storage.getProfile();
  const authorVisibility = state.reportSelection.authorVisibility || "anonymous";

  const report = {
    id: "r" + Date.now(),
    pointId,
    datetime: new Date().toISOString(),
    isBiting: state.reportSelection.isBiting,
    species: document.getElementById("report-species").value.trim(),
    amount: document.getElementById("report-amount").value.trim(),
    tackle: document.getElementById("report-tackle").value.trim(),
    bait: document.getElementById("report-bait").value.trim(),
    comment: document.getElementById("report-comment").value.trim(),
    photo: state.reportSelection.photoDataUrl,
    rating: state.reportSelection.rating,
    locationPrivacy: document.getElementById("report-location-privacy").value,
    authorVisibility,
    ...(authorVisibility === "named"
      ? { authorName: profile.name, authorLevel: getLevelInfo(statsBefore.reportsCount).current.name, authorAvatar: profile.avatar || null }
      : {}),
  };
  Storage.addReport(report);
  invalidatePointCache(pointId);

  const statsAfter = getProfileStats();
  const newAchievements = checkNewAchievements(statsBefore, statsAfter);

  state.viewStack = ["point"];
  openPoint(pointId);

  showToast("Спасибо! Отчёт сохранён и сделает прогноз точнее для рыбаков рядом. 🎣");
  newAchievements.forEach((a, i) => {
    setTimeout(() => showToast(`🏅 Новое достижение: «${a.title}»`), 1200 + i * 1800);
  });
});

// ---------- ИЗБРАННОЕ ----------

let favSortMode = "score";
let favDataCache = null;

async function renderFavorites() {
  const container = document.getElementById("favorites-content");
  const favIds = Storage.getFavorites();
  if (!favIds.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="icon">🗺️</div>
        Здесь появятся ваши проверенные места.<br>
        Откройте карту, найдите точку и нажмите «Сохранить». В следующий раз прогноз по ней будет в один тап.
        <div style="margin-top:14px;">
          <button class="btn-primary" id="fav-goto-map">Найти места на карте</button>
        </div>
      </div>`;
    document.getElementById("fav-goto-map").addEventListener("click", () => {
      state.viewStack = ["map"];
      showView("map", { pushHistory: false });
    });
    return;
  }

  container.innerHTML = `
    <div class="skeleton-card">
      <div class="skeleton-line" style="width:70%;"></div>
      <div class="skeleton-line" style="width:100%;"></div>
    </div>`;

  const points = favIds.map(getPointById).filter(Boolean);
  const loc = state.userLocation || DEFAULT_CENTER;
  const entries = await mapWithConcurrency(points, 3, async (point) => {
      const forecast = await getPointForecast(point).catch(() => null);
      if (!forecast) return { point, forecast: null };
      const dayWindows = computeDayWindows(forecast.weather, point.lat, point.lon, Storage.getReports(point.id));
      const reports = Storage.getReports(point.id);
      const lastReport = reports.length
        ? reports.reduce((a, b) => (new Date(a.datetime) > new Date(b.datetime) ? a : b))
        : null;
      return {
        point,
        forecast,
        distanceKm: haversineKm(loc, point),
        best: dayWindows.best,
        lastReport,
      };
    });
  favDataCache = entries.filter((e) => e.forecast);
  renderFavoritesList(container);
}

function renderFavoritesList(container) {
  const entries = favDataCache.slice();
  if (favSortMode === "score") entries.sort((a, b) => b.forecast.result.score - a.forecast.result.score);
  else if (favSortMode === "distance") entries.sort((a, b) => a.distanceKm - b.distanceKm);
  else if (favSortMode === "fresh") {
    entries.sort((a, b) => {
      const at = a.lastReport ? new Date(a.lastReport.datetime).getTime() : 0;
      const bt = b.lastReport ? new Date(b.lastReport.datetime).getTime() : 0;
      return bt - at;
    });
  }

  const sortChips = [
    { key: "score", label: "Потенциал" },
    { key: "distance", label: "Расстояние" },
    { key: "fresh", label: "Свежесть отчётов" },
  ];

  container.innerHTML = `
    <div class="sort-chips">
      ${sortChips
        .map((c) => `<div class="sort-chip ${favSortMode === c.key ? "active" : ""}" data-sort="${c.key}">${c.label}</div>`)
        .join("")}
    </div>
    <div class="card">
      ${entries.map((e) => renderFavoriteCard(e)).join("")}
    </div>
  `;

  container.querySelectorAll("[data-sort]").forEach((chip) => {
    chip.addEventListener("click", () => {
      favSortMode = chip.dataset.sort;
      renderFavoritesList(container);
    });
  });
  bindOpenPointButtons(container);
  container.querySelectorAll("[data-route]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${btn.dataset.route}`, "_blank");
    });
  });
  container.querySelectorAll("[data-remove-fav]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      Storage.toggleFavorite(btn.dataset.removeFav);
      showToast("Убрано из избранного");
      renderFavorites();
    });
  });
}

function renderFavoriteCard(entry) {
  const { point, forecast, distanceKm, best, lastReport } = entry;
  const interp = scoreInterpretation(forecast.result.score);
  const badges = [];
  if (best && (best.key === "morning" || best.key === "evening")) {
    badges.push(`${best.icon} Лучше ${best.key === "morning" ? "утром" : "вечером"}`);
  }
  if (forecast.result.subs.pressure >= 70) badges.push("📊 Давление стабильно");
  if (forecast.result.subs.wind <= 40) badges.push("💨 Ветер мешает");
  if (lastReport) badges.push(`📝 Отчёт ${formatTimeAgo(new Date(lastReport.datetime))}`);

  return `
    <div class="point-list-item" data-open-point="${point.id}" style="margin-bottom:14px;align-items:flex-start;">
      <div class="point-mini-score sc-${interp.tier}">${forecast.result.score}</div>
      <div style="flex:1;">
        <div class="card-title">${point.name}</div>
        <div class="card-sub">${point.town || ""}${distanceKm != null ? " · " + distanceKm.toFixed(1) + " км" : ""}</div>
        ${badges.length ? `<div class="fav-badges">${badges.map((b) => `<span class="fav-badge">${b}</span>`).join("")}</div>` : ""}
        <div class="card-row" style="margin-top:8px;gap:6px;">
          <button class="btn-secondary" style="flex:1;padding:6px;font-size:12px;">Открыть</button>
          <button class="btn-secondary" data-route="${point.lat},${point.lon}" style="flex:1;padding:6px;font-size:12px;">Маршрут</button>
          <button class="btn-secondary" data-remove-fav="${point.id}" style="flex:1;padding:6px;font-size:12px;">Убрать</button>
        </div>
      </div>
    </div>`;
}

// ---------- РЕЙТИНГ РЫБАКОВ ----------
// Демонстрационный макет: реальный общий рейтинг требует backend с другими
// пользователями. Список соперников — mock-данные (см. leaderboard.js).

function renderLeaderboardRow(b) {
  return `
    <div class="lb-row ${b.isYou ? "you" : ""}">
      <div class="lb-rank">${b.rank}</div>
      <div class="lb-name">${b.name}</div>
      <div class="lb-count">${b.reports} отч.</div>
    </div>`;
}

// ---------- СТАТЬИ ----------

function openArticles() {
  showView("articles");
  const container = document.getElementById("articles-content");
  container.innerHTML = `<div class="card">
    ${ARTICLES.map(
      (a) => `
      <div class="point-list-item" data-open-article="${a.id}" style="margin-bottom:12px;align-items:flex-start;">
        <div class="hub-icon" style="width:44px;height:44px;font-size:20px;flex-shrink:0;">${a.icon}</div>
        <div>
          <div class="card-title" style="margin-bottom:0;">${a.title}</div>
          <div class="card-sub" style="margin-bottom:4px;">${a.category} · ${estimateReadMinutes(a)} мин чтения</div>
          <div style="font-size:13px;color:var(--gray-500);">${a.summary}</div>
        </div>
      </div>`
    ).join("")}
  </div>`;
  container.querySelectorAll("[data-open-article]").forEach((el) => {
    el.addEventListener("click", () => openArticleDetail(el.dataset.openArticle));
  });
}

function openArticleDetail(id) {
  const article = getArticleById(id);
  if (!article) return;
  showView("article-detail");
  document.getElementById("article-detail-content").innerHTML = `
    <div class="card-sub" style="margin-bottom:2px;">${article.category} · ${estimateReadMinutes(article)} мин чтения</div>
    <h2 style="margin-top:2px;">${article.icon} ${article.title}</h2>
    <div class="card">
      ${article.body.map((p) => `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;">${p}</p>`).join("")}
    </div>
  `;
}

// ---------- ЧТО ВЗЯТЬ С СОБОЙ ----------

function openGearScreen(point, weather) {
  showView("gear");
  const container = document.getElementById("gear-content");
  if (!point || !weather) {
    container.innerHTML = `<div class="empty-state"><div class="icon">🎒</div>Не нашли погоду для ближайшей точки. Откройте карту и выберите место вручную.</div>`;
    return;
  }
  const tips = getGearTips(weather.current);
  container.innerHTML = `
    <div class="card-sub" style="margin-bottom:12px;">По погоде у точки «${point.name}» на сегодня</div>
    ${tips.length
      ? `<div class="card">
          ${tips.map((t) => `
            <div class="mini-report">
              <div style="font-size:20px;">${t.icon}</div>
              <div style="align-self:center;font-size:14px;">${t.text}</div>
            </div>`).join("")}
        </div>`
      : `<div class="empty-state"><div class="icon">☀️</div>Погода спокойная, ничего особенного брать не нужно.</div>`}
  `;
}

function openLeaderboard() {
  showView("leaderboard");
  const profile = Storage.getProfile();
  const stats = getProfileStats();
  const board = getMockLeaderboard(profile.name, stats.reportsCount);

  document.getElementById("leaderboard-content").innerHTML = `
    <div class="lb-theme-banner">
      <div class="lb-theme-label">Тема месяца · двойные баллы за отчёты</div>
      <div class="lb-theme-value">🐟 ${getMonthTheme()}</div>
    </div>
    <div class="card">
      ${board.map((b) => renderLeaderboardRow(b)).join("")}
    </div>
    <div class="lb-prize-card">
      <div class="lb-prize-icon">🎁</div>
      <div class="lb-prize-title">${MONTHLY_PRIZE.title}</div>
      <div class="lb-prize-sponsor">${MONTHLY_PRIZE.sponsor}</div>
      <div class="lb-prize-rule">${MONTHLY_PRIZE.rule}</div>
    </div>
    <div class="empty-state" style="font-size:12px;">Это демо-версия рейтинга: соперники здесь — тестовые имена. Настоящий зачёт заработает, когда к приложению подключатся другие рыбаки.</div>
  `;
}

// ---------- РЕГИОНЫ ----------

function getRegionsSummary() {
  const points = getAllPoints().filter((p) => p.region);
  const reports = Storage.getReports();
  const byRegion = new Map();

  points.forEach((p) => {
    if (!byRegion.has(p.region)) byRegion.set(p.region, { region: p.region, points: [] });
    byRegion.get(p.region).points.push(p);
  });

  return [...byRegion.values()]
    .map((r) => {
      const pointIds = new Set(r.points.map((p) => p.id));
      const reportsCount = reports.filter((rep) => pointIds.has(rep.pointId)).length;
      return { ...r, reportsCount };
    })
    .sort((a, b) => b.points.length - a.points.length);
}

function bindRegionChips(container) {
  container.querySelectorAll("[data-open-region]").forEach((el) => {
    el.addEventListener("click", () => openRegionDetail(el.dataset.openRegion));
  });
  const btn = container.querySelector("#btn-open-regions");
  if (btn) btn.addEventListener("click", () => openRegions());
}

function openRegions() {
  showView("regions");
  const regions = getRegionsSummary();
  const container = document.getElementById("regions-content");
  if (!regions.length) {
    container.innerHTML = `<div class="empty-state"><div class="icon">🗺️</div>Пока нет точек с определённым регионом. Добавьте точку на карте, регион определится автоматически.</div>`;
    return;
  }
  container.innerHTML = `<div class="card">
    ${regions
      .map(
        (r) => `
      <div class="point-list-item" data-open-region="${escapeHtml(r.region)}" style="margin-bottom:12px;">
        <div class="point-mini-score sc-3" style="font-size:12px;">${r.points.length}</div>
        <div>
          <div class="card-title">${r.region}</div>
          <div class="card-sub">${r.points.length} точ${pluralPoints(r.points.length)} · ${r.reportsCount} отчёт${pluralReports(r.reportsCount)}</div>
        </div>
      </div>`
      )
      .join("")}
  </div>`;
  bindRegionChips(container);
}

function pluralPoints(n) {
  const m = n % 10, m2 = n % 100;
  if (m === 1 && m2 !== 11) return "ка";
  if ([2, 3, 4].includes(m) && ![12, 13, 14].includes(m2)) return "ки";
  return "ек";
}
function pluralReports(n) {
  const m = n % 10, m2 = n % 100;
  if (m === 1 && m2 !== 11) return "";
  if ([2, 3, 4].includes(m) && ![12, 13, 14].includes(m2)) return "а";
  return "ов";
}

async function openRegionDetail(regionName) {
  showView("region-detail");
  const container = document.getElementById("region-detail-content");
  container.innerHTML = `<div class="state-block"><div class="spinner"></div></div>`;

  const points = getAllPoints().filter((p) => p.region === regionName);
  const forecasts = await mapWithConcurrency(points, 3, (p) => getPointForecast(p).catch(() => null));
  const pointIds = new Set(points.map((p) => p.id));
  const reports = Storage.getReports()
    .filter((r) => pointIds.has(r.pointId))
    .slice(0, 10);

  container.innerHTML = `
    <h2>${regionName}</h2>
    <div class="section-header"><span class="icon">📍</span><h3>Точки (${points.length})</h3></div>
    <div class="card">
      ${points.map((p, i) => renderPointListItem(p, forecasts[i]?.result)).join("")}
    </div>
    <div class="section-header"><span class="icon">📰</span><h3>Отчёты рыбаков в регионе</h3></div>
    <div class="card">
      ${reports.length ? renderRecentReportsFeed(reports) : `<div class="empty-state" style="padding:16px 0;"><div class="icon">📝</div>В этом регионе ещё нет отчётов. Оставьте первый по любой точке отсюда.</div>`}
    </div>
  `;
  bindOpenPointButtons(container);
  bindReportAuthorLinks(container);
}

// ---------- ПРОФИЛЬ ----------

// ---------- ПУБЛИЧНЫЙ ПРОФИЛЬ (предпросмотр) ----------
// Приложение работает только в localStorage одного устройства — реальных
// "других пользователей", которые могли бы открыть чей-то ещё профиль, нет.
// Поэтому это честный предпросмотр СВОЕГО профиля таким, каким его увидели бы
// другие, если бы для этого был сервер, а не имитация чужого профиля.

function buildPublicProfile(profile) {
  const p = profile.privacy;
  const stats = getProfileStats();
  const { current } = getLevelInfo(stats.reportsCount);
  const allReports = Storage.getReports().map(normalizeReport);
  const publicReports = p.showReports
    ? allReports.filter((r) => r.locationPrivacy !== "hidden" && r.authorVisibility === "named").slice(0, 5)
    : [];

  return {
    name: profile.name || "Рыбак",
    avatarUrl: p.showAvatar ? profile.avatar : null,
    level: current.name,
    region: p.showRegion ? profile.region : "",
    city: p.showRegion ? profile.city : "",
    fishingExperience: p.showFishingExperience ? FISHING_EXPERIENCE_LABELS[profile.fishingExperience] || "" : "",
    favoriteFishingTypes: p.showFavoriteFishingTypes ? profile.favoriteFishingTypes || [] : [],
    favoriteWaters: p.showFavoriteWaters ? profile.favoriteWaters || [] : [],
    reportsCount: stats.reportsCount,
    exploredWatersCount: stats.distinctPoints,
    achievements: p.showAchievements ? computeAchievements(stats).filter((a) => a.earned) : [],
    recentReports: publicReports,
    maxPhoneDigits: p.showMaxContact ? profile.contact.maxPhoneDigits : "",
    maxPhoneDisplay: p.showMaxContact ? profile.contact.maxPhoneDisplay : "",
  };
}

function openPublicProfile() {
  showView("public-profile");
  const container = document.getElementById("public-profile-content");
  const profile = Storage.getProfile();

  if (!profile.publicProfileEnabled) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="icon">🔒</div>
        <div style="font-weight:700;font-size:16px;margin-bottom:4px;">Профиль закрыт</div>
        Вы ещё не включили публичный профиль. Другие рыбаки видят только «Анонимный рыбак» в ваших отчётах.
        <div style="margin-top:14px;">
          <button class="btn-primary" id="pp-open-settings">Открыть настройки</button>
        </div>
      </div>`;
    document.getElementById("pp-open-settings").addEventListener("click", () => {
      state.viewStack = ["profile"];
      showView("profile", { pushHistory: false });
    });
    return;
  }

  const pub = buildPublicProfile(profile);
  container.innerHTML = `
    <div class="card-sub" style="margin-bottom:8px;">Предпросмотр — так профиль увидят другие рыбаки</div>
    <div class="card" style="text-align:center;">
      ${pub.avatarUrl ? `<img src="${pub.avatarUrl}" class="avatar-img" style="width:72px;height:72px;border-radius:50%;" />` : `<span class="avatar-placeholder">🎣</span>`}
      <div style="font-weight:700;font-size:18px;margin-top:8px;">${escapeHtml(pub.name)}</div>
      <div class="card-sub">${escapeHtml(pub.level)}${pub.region ? " · " + escapeHtml([pub.city, pub.region].filter(Boolean).join(", ")) : ""}</div>
    </div>

    <div class="stats-grid">
      <div class="stat-tile"><div class="stat-value">${pub.reportsCount}</div><div class="stat-label">Отчётов</div></div>
      <div class="stat-tile"><div class="stat-value">${pub.exploredWatersCount}</div><div class="stat-label">Водоёмов освоено</div></div>
    </div>

    <div class="section-header"><span class="icon">🎣</span><h3>О рыбаке</h3></div>
    <div class="card">
      ${pub.fishingExperience ? `<div class="card-row" style="margin-bottom:6px;"><span>Стаж</span><span>${escapeHtml(pub.fishingExperience)}</span></div>` : ""}
      ${pub.favoriteFishingTypes.length ? `<div class="tags">${pub.favoriteFishingTypes.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}</div>` : ""}
      ${pub.favoriteWaters.length ? `<div class="card-sub" style="margin-top:6px;">Любимые водоёмы: ${pub.favoriteWaters.map(escapeHtml).join(", ")}</div>` : ""}
      ${!pub.fishingExperience && !pub.favoriteFishingTypes.length && !pub.favoriteWaters.length ? `<div class="card-sub" style="margin-bottom:0;">Рыбак пока не заполнил этот раздел.</div>` : ""}
    </div>

    ${pub.achievements.length ? `
    <div class="section-header"><span class="icon">🏅</span><h3>Достижения</h3></div>
    <div class="achv-grid">
      ${pub.achievements.map((a) => `<div class="achv-card earned"><div class="achv-icon">${a.icon}</div><div class="achv-title">${a.title}</div></div>`).join("")}
    </div>` : ""}

    <div class="section-header"><span class="icon">📰</span><h3>Публичные отчёты</h3></div>
    <div class="card">
      ${pub.recentReports.length
        ? renderReportsList(pub.recentReports)
        : `<div class="empty-state" style="padding:12px 0;">Публичных отчётов пока нет.</div>`}
    </div>

    ${renderMaxContact(pub.maxPhoneDigits, pub.maxPhoneDisplay, escapeHtml)}
  `;
}

function renderProfile() {
  const container = document.getElementById("profile-content");
  const profile = Storage.getProfile();
  const stats = getProfileStats();
  const memberSince = new Date(profile.createdAt).toLocaleDateString("ru-RU");
  const { current, next, progress } = getLevelInfo(stats.reportsCount);
  const achievements = computeAchievements(stats);
  const earnedCount = achievements.filter((a) => a.earned).length;

  container.innerHTML = `
    <div class="card" style="text-align:center;">
      <label class="avatar-upload" id="avatar-upload-label">
        <input type="file" id="profile-avatar-input" accept="image/*" />
        ${profile.avatar ? `<img src="${profile.avatar}" class="avatar-img" />` : `<span class="avatar-placeholder">📷</span>`}
      </label>
      <div class="card-sub" style="margin-top:8px;margin-bottom:0;">Нажмите, чтобы добавить свою фотографию</div>
    </div>

    <div class="card">
      <label class="field-label">Ваше имя</label>
      <input type="text" id="profile-name" value="${profile.name || ""}" />
    </div>

    <div class="card">
      <div class="level-row">
        <span class="level-icon">${current.icon}</span>
        <div style="flex:1;">
          <div class="card-title" style="margin-bottom:0;">${current.name}</div>
          ${next
            ? `<div class="card-sub">До «${next.name}»: ${stats.reportsCount}/${next.threshold} отчётов</div>`
            : `<div class="card-sub">Вы достигли максимального уровня. Легенда водоёма!</div>`}
        </div>
      </div>
      ${next ? `<div class="level-bar"><div class="level-bar-fill" style="width:${progress}%;"></div></div>` : ""}
    </div>

    <div class="stats-grid">
      <div class="stat-tile"><div class="stat-value">${stats.reportsCount}</div><div class="stat-label">Отчётов</div></div>
      <div class="stat-tile"><div class="stat-value">${stats.favCount}</div><div class="stat-label">Сохранено мест</div></div>
      <div class="stat-tile"><div class="stat-value">${stats.distinctPoints}</div><div class="stat-label">Водоёмов освоено</div></div>
      <div class="stat-tile"><div class="stat-value" style="font-size:15px;">${memberSince}</div><div class="stat-label">С нами с</div></div>
    </div>

    <button class="btn-secondary btn-full" id="btn-profile-leaderboard">🏆 Рейтинг рыбаков</button>

    <div class="section-header"><span class="icon">🌐</span><h3>Публичный профиль</h3></div>
    <div class="card">
      ${renderSwitchRow("public-enabled", "Показывать мой профиль другим", profile.publicProfileEnabled
        ? "Другие рыбаки видят открытые данные и публичные отчёты."
        : "Профиль закрыт. Отчёты можно оставлять анонимно.", profile.publicProfileEnabled)}
      <button class="btn-secondary btn-full" id="btn-preview-profile" style="margin-top:12px;">👁️ Предпросмотр профиля</button>
    </div>

    <div class="section-header"><span class="icon">🔎</span><h3>Что показывать</h3></div>
    <div class="card">
      ${renderSwitchRow("show-avatar", "Аватар", "", profile.privacy.showAvatar)}
      ${renderSwitchRow("show-region", "Регион", "", profile.privacy.showRegion)}
      ${renderSwitchRow("show-fishingExperience", "Стаж", "", profile.privacy.showFishingExperience)}
      ${renderSwitchRow("show-favoriteFishingTypes", "Любимые виды ловли", "", profile.privacy.showFavoriteFishingTypes)}
      ${renderSwitchRow("show-favoriteWaters", "Любимые водоёмы", "Показывайте только если готовы делиться этой информацией.", profile.privacy.showFavoriteWaters)}
      ${renderSwitchRow("show-achievements", "Достижения", "", profile.privacy.showAchievements)}
      ${renderSwitchRow("show-reports", "Публичные отчёты", "", profile.privacy.showReports)}
    </div>

    <div class="card">
      <label class="field-label">Область</label>
      <input type="text" id="profile-region" list="profile-region-options" value="${escapeHtml(profile.region || "")}" placeholder="Например: Московская область" />
      <datalist id="profile-region-options">
        ${RU_REGIONS.map((r) => `<option value="${escapeHtml(r)}"></option>`).join("")}
      </datalist>
      <label class="field-label">Город или посёлок</label>
      <input type="text" id="profile-city" value="${escapeHtml(profile.city || "")}" placeholder="Например: Дмитров" />
      <label class="field-label">Стаж рыбалки</label>
      <select id="profile-experience">
        ${FISHING_EXPERIENCE_OPTIONS.map((o) => `<option value="${o.value}" ${profile.fishingExperience === o.value ? "selected" : ""}>${o.label}</option>`).join("")}
      </select>
    </div>

    <div class="section-header"><span class="icon">💬</span><h3>MAX-контакт</h3></div>
    <div class="card">
      ${renderSwitchRow("show-maxContact", "Показывать номер для MAX", "Включайте только если готовы получать сообщения и звонки.", profile.privacy.showMaxContact)}
      <label class="field-label">Номер телефона для MAX</label>
      <input type="tel" id="profile-max" value="${escapeHtml(profile.contact.maxRaw || "")}" placeholder="+7 999 123-45-67" />
      <div id="max-field-feedback"></div>
      <div class="privacy-notice">Контакт увидят только те, кому вы разрешите его показывать.</div>
    </div>

    <div class="section-header"><span class="icon">📝</span><h3>Приватность отчётов по умолчанию</h3></div>
    <div class="card">
      <label class="field-label">Автор</label>
      <select id="profile-default-author">
        <option value="anonymous" ${profile.privacy.defaultReportAuthorVisibility === "anonymous" ? "selected" : ""}>Анонимно</option>
        <option value="named" ${profile.privacy.defaultReportAuthorVisibility === "named" ? "selected" : ""}>От имени профиля</option>
      </select>
      <label class="field-label">Место</label>
      <select id="profile-default-location">
        <option value="exact" ${profile.privacy.defaultLocationPrivacy === "exact" ? "selected" : ""}>Точная точка</option>
        <option value="district" ${profile.privacy.defaultLocationPrivacy === "district" ? "selected" : ""}>Только район</option>
        <option value="water" ${profile.privacy.defaultLocationPrivacy === "water" ? "selected" : ""}>Только водоём</option>
        <option value="hidden" ${profile.privacy.defaultLocationPrivacy === "hidden" ? "selected" : ""}>Скрыть место</option>
      </select>
    </div>

    <div class="section-header"><span class="icon">🏅</span><h3>Достижения (${earnedCount}/${achievements.length})</h3></div>
    <div class="achv-grid">
      ${achievements
        .map(
          (a) => `
        <div class="achv-card ${a.earned ? "earned" : "locked"}">
          <div class="achv-icon">${a.icon}</div>
          <div class="achv-title">${a.title}</div>
          <div class="achv-desc">${a.desc}</div>
        </div>`
        )
        .join("")}
    </div>

    <div class="card" style="margin-top:14px;">
      <div class="card-title">Зачем оставлять отчёты?</div>
      <div class="card-sub" style="margin-bottom:0;">
        Каждый отчёт делает прогноз точнее для вас и для рыбаков рядом. И это быстрый способ расти в уровне и открывать достижения.
      </div>
    </div>

    <div class="section-header"><span class="icon">🗂️</span><h3>Управление данными</h3></div>
    <div class="card-row" style="gap:8px;flex-wrap:wrap;">
      <button class="btn-secondary" id="btn-clear-max" style="flex:1;">Очистить MAX</button>
      <button class="btn-secondary" id="btn-remove-avatar" style="flex:1;">Удалить аватар</button>
    </div>
    <button class="btn-secondary btn-full" id="btn-anonymize-reports" style="margin-top:8px;">Сделать все отчёты анонимными</button>

    <div class="empty-state" style="font-size:12px;">Данные хранятся только в этом браузере. Без регистрации и сервера.</div>
  `;
  document.getElementById("profile-name").addEventListener("change", (e) => {
    Storage.updateProfile({ name: e.target.value });
  });
  document.getElementById("profile-avatar-input").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      Storage.updateProfile({ avatar: reader.result });
      renderProfile();
    };
    reader.readAsDataURL(file);
  });
  document.getElementById("btn-profile-leaderboard").addEventListener("click", () => openLeaderboard());
  document.getElementById("btn-preview-profile").addEventListener("click", () => openPublicProfile());

  document.getElementById("public-enabled").addEventListener("change", (e) => {
    if (e.target.checked) {
      const ok = confirm(
        "Другие рыбаки смогут видеть ваше имя, уровень и публичные отчёты. Контакты и точные места останутся скрыты, пока вы сами их не откроете."
      );
      if (!ok) {
        e.target.checked = false;
        return;
      }
    }
    Storage.updateProfile({ publicProfileEnabled: e.target.checked });
    renderProfile();
  });

  ["avatar", "region", "fishingExperience", "favoriteFishingTypes", "favoriteWaters", "achievements", "reports", "maxContact"].forEach((key) => {
    const el = document.getElementById(`show-${key}`);
    if (!el) return;
    el.addEventListener("change", (e) => {
      const privacy = { ...Storage.getProfile().privacy, [`show${key.charAt(0).toUpperCase()}${key.slice(1)}`]: e.target.checked };
      Storage.updateProfile({ privacy });
    });
  });

  document.getElementById("profile-region").addEventListener("change", (e) => {
    Storage.updateProfile({ region: e.target.value.trim() });
  });
  document.getElementById("profile-city").addEventListener("change", (e) => {
    Storage.updateProfile({ city: e.target.value.trim() });
  });
  document.getElementById("profile-experience").addEventListener("change", (e) => {
    Storage.updateProfile({ fishingExperience: e.target.value });
  });

  const maxFeedback = document.getElementById("max-field-feedback");
  document.getElementById("profile-max").addEventListener("change", (e) => {
    const { phoneDigits, display, error } = normalizeMaxContact(e.target.value);
    if (error) {
      maxFeedback.innerHTML = `<div class="max-field-error">${escapeHtml(error)}</div>`;
      Storage.updateProfile({ contact: { ...Storage.getProfile().contact, maxRaw: e.target.value, maxPhoneDigits: "", maxPhoneDisplay: "" } });
      return;
    }
    maxFeedback.innerHTML = phoneDigits
      ? `<div class="max-field-warn">Сохранено. Рыбаки смогут написать или позвонить вам в MAX, как только вы включите показ номера выше.</div>`
      : "";
    Storage.updateProfile({ contact: { maxRaw: e.target.value, maxPhoneDigits: phoneDigits, maxPhoneDisplay: display } });
  });

  document.getElementById("profile-default-author").addEventListener("change", (e) => {
    Storage.updateProfile({ privacy: { ...Storage.getProfile().privacy, defaultReportAuthorVisibility: e.target.value } });
  });
  document.getElementById("profile-default-location").addEventListener("change", (e) => {
    Storage.updateProfile({ privacy: { ...Storage.getProfile().privacy, defaultLocationPrivacy: e.target.value } });
  });

  document.getElementById("btn-clear-max").addEventListener("click", () => {
    Storage.updateProfile({ contact: { maxRaw: "", maxPhoneDigits: "", maxPhoneDisplay: "" }, privacy: { ...Storage.getProfile().privacy, showMaxContact: false } });
    showToast("MAX-контакт очищен");
    renderProfile();
  });
  document.getElementById("btn-remove-avatar").addEventListener("click", () => {
    Storage.updateProfile({ avatar: null });
    renderProfile();
  });
  document.getElementById("btn-anonymize-reports").addEventListener("click", () => {
    if (!confirm("Убрать имя со всех ваших отчётов? Дальше они будут показаны как «Анонимный рыбак».")) return;
    Storage.anonymizeAllReports();
    showToast("Все отчёты теперь анонимны");
  });
}

function renderSwitchRow(id, title, hint, checked) {
  return `
    <label class="switch-row" for="${id}">
      <span>
        <span class="switch-row-title">${title}</span>
        ${hint ? `<span class="switch-row-hint">${hint}</span>` : ""}
      </span>
      <input type="checkbox" class="switch-input" id="${id}" ${checked ? "checked" : ""} />
      <span class="switch-track"><span class="switch-thumb"></span></span>
    </label>`;
}

// ---------- СТАРТ ----------

showOnboardingIfNeeded();
