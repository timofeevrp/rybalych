import { SEED_POINTS, FISH_SPECIES } from "./data.js";
import { Storage } from "./storage.js";
import { getAstroData } from "./astro.js";
import { fetchWeather, weatherIcon } from "./weather.js";
import { computeScore, scoreInterpretation } from "./score.js";
import { computeSpeciesLikelihood, DEFAULT_SPECIES_POOL } from "./species.js";
import { reverseGeocode } from "./geocode.js";
import { getLevelInfo } from "./levels.js";
import { computeDayWindows } from "./timewindows.js";
import { computeWarnings } from "./warnings.js";
import { getGearTips } from "./gear.js";
import { computeAchievements } from "./achievements.js";
import { getMockLeaderboard, getMonthTheme, MONTHLY_PRIZE } from "./leaderboard.js";
import { ARTICLES, getArticleById } from "./articles.js";
import { fetchKpIndex, kpLabel } from "./geomagnetic.js";

const DEFAULT_CENTER = { lat: 55.7558, lon: 37.6173 }; // Москва, фолбэк без геолокации
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

  const loc = skipGeo ? null : await getLocation();
  state.userLocation = loc || DEFAULT_CENTER;
  state.geoDenied = !loc;

  const nearby = getAllPoints()
    .map((p) => ({ ...p, distanceKm: haversineKm(state.userLocation, p) }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, 8);

  const forecasts = await Promise.all(
    nearby.map((p) => getPointForecast(p).catch(() => null))
  );
  const withForecast = nearby
    .map((point, i) => ({ point, forecast: forecasts[i] }))
    .filter((x) => x.forecast);

  loadingEl.classList.add("hidden");
  contentEl.classList.remove("hidden");

  if (!withForecast.length) {
    document.getElementById("header-status").textContent = "";
    contentEl.innerHTML = `<div class="empty-state"><div class="icon">🎣</div>Не получилось загрузить прогноз — проверьте интернет-соединение и потяните экран, чтобы попробовать ещё раз.</div>`;
    return;
  }

  // "hero" — ближайшая точка с прогнозом, на её погоде строим весь обзор дня
  const hero = withForecast[0];
  const { result: heroResult, weather: heroWeather } = hero.forecast;
  const heroInterp = scoreInterpretation(heroResult.score);
  const month = new Date().getMonth();

  const dayWindows = computeDayWindows(heroWeather, hero.point.lat, hero.point.lon, Storage.getReports(hero.point.id));
  const warnings = computeWarnings(heroWeather.current, month);
  const gearTips = getGearTips(heroWeather.current);

  document.getElementById("header-status").textContent = `Сегодня клёв: ${heroInterp.label.toLowerCase()}`;

  const geoNotice = state.geoDenied
    ? `<div class="card" style="background:var(--green-100);border:none;">🧭 Не вижу вашу геолокацию, поэтому показываю проверенные места по Москве и области. Разрешите доступ в браузере или откройте карту — можно выбрать точку вручную.</div>`
    : "";

  const bestPoints = withForecast
    .slice()
    .sort((a, b) => b.forecast.result.score - a.forecast.result.score)
    .slice(0, 3);

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

    ${geoNotice}

    <div class="card">
      <div class="card-sub">${getGreeting()}! Прогноз на сегодня — ${hero.point.name} и окрестности</div>
      ${renderScoreWidget(heroResult, heroInterp, weatherIcon(heroWeather.current))}
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

    <div class="quick-actions">
      <div class="quick-action" data-action="map"><span class="qa-icon">🗺️</span>Карта</div>
      <div class="quick-action" data-action="report"><span class="qa-icon">📝</span>Отчёт</div>
      <div class="quick-action" data-action="favorites"><span class="qa-icon">⭐</span>Избранное</div>
      <div class="quick-action" data-action="relocate"><span class="qa-icon">📍</span>Локация</div>
    </div>

    ${warnings.length ? `
    <div class="section-header"><span class="icon">⚠️</span><h3>Стоит учесть</h3></div>
    <div class="warning-banner">
      ${warnings.map((w) => `<div class="warning-item"><span class="w-icon">${w.icon}</span><span>${w.text}</span></div>`).join("")}
    </div>` : ""}

    <div class="section-header"><span class="icon">📍</span><h3>Куда поехать сегодня</h3></div>
    <div class="card">
      ${bestPoints.map(({ point, forecast }) => renderPointListItem(point, forecast.result)).join("")}
    </div>

    <div class="section-header"><span class="icon">🗺️</span><h3>Регионы</h3></div>
    <div class="card">
      ${renderRegionsPreview()}
    </div>

    <div class="section-header"><span class="icon">🏆</span><h3>Рейтинг рыбаков</h3></div>
    <div class="card">
      ${renderLeaderboardPreview(profileStats.reportsCount)}
    </div>

    <div class="section-header"><span class="icon">🎒</span><h3>Что взять с собой</h3></div>
    <div class="card">
      <div class="gear-tip-list">
        ${gearTips.map((t) => `<div class="gear-tip"><span class="g-icon">✅</span><span>${t}</span></div>`).join("")}
      </div>
    </div>

    <div class="section-header"><span class="icon">📚</span><h3>Полезные статьи</h3></div>
    <div class="card">
      ${renderArticlesList(ARTICLES.slice(0, 4))}
    </div>

    <div class="section-header"><span class="icon">📰</span><h3>Свежие отчёты</h3></div>
    <div class="card">
      ${recentReports.length ? renderRecentReportsFeed(recentReports) : `<div class="empty-state" style="padding:16px 0;"><div class="icon">📝</div>Пока никто не оставил отчёт. Станьте первым — это займёт минуту и сделает прогноз точнее для всех рыбаков рядом.</div>`}
    </div>
  `;

  contentEl.innerHTML = html;
  bindOpenPointButtons(contentEl);
  bindArticleCards(contentEl);
  bindRegionChips(contentEl);

  document.getElementById("mini-profile-card").addEventListener("click", () => {
    state.viewStack = ["profile"];
    showView("profile", { pushHistory: false });
  });

  const lbBtn = contentEl.querySelector("#btn-open-leaderboard");
  if (lbBtn) lbBtn.addEventListener("click", () => openLeaderboard());

  contentEl.querySelector('[data-action="map"]').addEventListener("click", () => {
    state.viewStack = ["map"];
    showView("map", { pushHistory: false });
  });
  contentEl.querySelector('[data-action="favorites"]').addEventListener("click", () => {
    state.viewStack = ["favorites"];
    showView("favorites", { pushHistory: false });
  });
  contentEl.querySelector('[data-action="report"]').addEventListener("click", () => {
    state.viewStack = ["point", "report"];
    openReportForm(hero.point.id);
  });
  contentEl.querySelector('[data-action="relocate"]').addEventListener("click", async () => {
    showToast("Обновляю геолокацию...");
    await loadHome();
  });
}

function renderConfidenceBadge(result) {
  const labels = { high: "Высокая точность", medium: "Средняя точность", low: "Базовый прогноз" };
  return `<div class="confidence-badge confidence-${result.confidence}" title="${result.confidenceText}">🎯 ${labels[result.confidence]}</div>`;
}

function renderRecentReportsFeed(reports) {
  return reports
    .map((r) => {
      const point = getPointById(r.pointId);
      const date = new Date(r.datetime);
      const timeAgo = formatTimeAgo(date);
      return `
      <div class="mini-report">
        <div>${r.isBiting ? "🟢" : "🔴"}</div>
        <div>
          <div class="mini-report-point">${point ? point.name : "Точка"}${r.species ? " · " + r.species : ""}</div>
          <div class="mini-report-meta">${timeAgo}${r.comment ? " · " + r.comment : ""}</div>
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
    ${!result.hasReports ? `<div class="score-sub" style="margin-top:8px;">Свежих отчётов по этой точке пока нет — прогноз строится на погоде и луне. Оставьте первый отчёт, и он станет точнее для всех рыбаков рядом.</div>` : ""}
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
  state.map = L.map("map").setView([center.lat, center.lon], 9);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap",
    maxZoom: 18,
  }).addTo(state.map);
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
    openAdhocPoint(e.latlng.lat, e.latlng.lng);
  });
}

async function renderMarkers() {
  state.markersLayer.clearLayers();
  const typeFilter = document.getElementById("filter-type").value;
  let points = getAllPoints();
  if (typeFilter !== "all") {
    points = points.filter((p) => (typeFilter === "paid" ? p.paid : p.type === typeFilter));
  }

  points.forEach((point) => {
    const icon = L.divIcon({
      className: "marker-score",
      html: `<div class="map-pin sc-2"><span>…</span></div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 30],
    });
    const marker = L.marker([point.lat, point.lon], { icon }).addTo(state.markersLayer);
    marker.on("click", () => openPoint(point.id));

    getPointForecast(point)
      .then(({ result }) => {
        const interp = scoreInterpretation(result.score);
        marker.setIcon(
          L.divIcon({
            className: "marker-score",
            html: `<div class="map-pin sc-${interp.tier}"><span>${result.score}</span></div>`,
            iconSize: [30, 30],
            iconAnchor: [15, 30],
          })
        );
      })
      .catch(() => {});
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

document.getElementById("map-search").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  const resultsEl = document.getElementById("map-search-results");
  if (!q) {
    resultsEl.classList.add("hidden");
    resultsEl.innerHTML = "";
    return;
  }
  const matches = getAllPoints()
    .filter((p) => p.name.toLowerCase().includes(q))
    .slice(0, 8);
  if (!matches.length) {
    resultsEl.innerHTML = `<div class="map-search-result" style="color:var(--gray-500);">Ничего не нашлось</div>`;
  } else {
    resultsEl.innerHTML = matches
      .map((p) => `<div class="map-search-result" data-goto-point="${p.id}">${p.name}<div class="sr-town">${p.town || ""}</div></div>`)
      .join("");
  }
  resultsEl.classList.remove("hidden");
});

document.getElementById("map-search-results").addEventListener("click", (e) => {
  const el = e.target.closest("[data-goto-point]");
  if (!el) return;
  document.getElementById("map-search").value = "";
  document.getElementById("map-search-results").classList.add("hidden");
  openPoint(el.dataset.gotoPoint);
});

function typeLabel(type) {
  return { lake: "Озеро", river: "Река", reservoir: "Водохранилище", paid: "Платный водоём" }[type] || type;
}

// ---------- КАРТОЧКА ТОЧКИ (в т.ч. точка, выбранная тапом по карте) ----------

function makeAdhocPoint(lat, lon) {
  return {
    id: `adhoc_${lat.toFixed(4)}_${lon.toFixed(4)}`,
    name: `Точка на карте (${lat.toFixed(3)}, ${lon.toFixed(3)})`,
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

function openAdhocPoint(lat, lon) {
  openPoint(makeAdhocPoint(lat, lon));
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

    const reports = point.adhoc ? [] : Storage.getReports(point.id);
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
        <div class="card-sub" style="margin-top:8px;margin-bottom:0;">Баллы 0–100, как и общий прогноз — не проценты вероятности.</div>
      </div>

      <div class="quick-report-box">
        <div class="qr-label">Как сейчас клюёт? Отметьте за секунду — это сразу улучшит прогноз</div>
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
        ${renderReportsList(reports)}
      </div>` : `<div class="empty-state" style="font-size:13px;">Сохраните это место, чтобы оставлять отчёты и видеть, что здесь ловят другие рыбаки.</div>`}
    `;

    renderDayPills();
    updateScoreSlot();
    updateWhySlot();
    updateSpeciesSlot(point);
    loadGeomagneticLine();

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
    visibility: "public",
    quick: true,
  };
  Storage.addReport(report);
  invalidatePointCache(targetPoint.id);

  const statsAfter = getProfileStats();
  const newAchievements = checkNewAchievements(statsBefore, statsAfter);

  showToast(isBiting ? "Отмечено: клюёт! Спасибо, учли в прогнозе. 🎣" : "Отмечено: не клюёт. Тоже полезная информация — спасибо!");
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
    ${isGeneric ? `<div class="card-sub">Виды для этой точки неизвестны — оценка ориентировочная для региона.</div>` : ""}
    ${list
      .map((s) => {
        const tier = scoreInterpretation(s.score).tier;
        return `
        <div class="species-row">
          <div class="species-row-head">
            <span class="species-name">${s.name}</span>
            <span class="species-score sc-${tier}">${s.score}/100</span>
          </div>
          <div class="species-bait">🪱 ${s.bait} · 🎣 ${s.tackle}</div>
        </div>`;
      })
      .join("")}
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

function renderReportsList(reports) {
  if (!reports.length) {
    return `<div class="empty-state"><div class="icon">📝</div>Отчётов здесь пока нет. Будьте первым — это займёт минуту и поможет другим рыбакам.</div>`;
  }
  return reports
    .map((r) => {
      const date = new Date(r.datetime);
      return `
      <div class="report-item">
        <div class="report-item-head">
          <span>${date.toLocaleDateString("ru-RU")} ${date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</span>
          <span class="${r.isBiting ? "report-biting-yes" : "report-biting-no"}">${r.isBiting ? "🟢 Клюёт" : "🔴 Не клюёт"}</span>
        </div>
        ${r.species ? `<div style="font-weight:600;margin-top:4px;">${r.species}${r.amount ? " · " + r.amount : ""}</div>` : ""}
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

// ---------- ФОРМА ОТЧЁТА ----------

function openReportForm(pointId) {
  const point = getPointById(pointId);
  document.getElementById("report-point-id").value = pointId;
  document.getElementById("report-form").reset();
  state.reportSelection = { isBiting: true, rating: 0, photoDataUrl: null };
  document.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.biting === "true"));
  document.querySelectorAll("#report-stars span").forEach((s) => s.classList.remove("active"));
  document.getElementById("report-photo-preview").innerHTML = "";
  document.getElementById("photo-upload-label").classList.remove("has-photo");
  document.getElementById("photo-upload-text").textContent = "Нажмите, чтобы сделать фото или выбрать из галереи";
  document.getElementById("report-point-display").innerHTML = point
    ? `📍 ${point.name}${point.town ? ` <span class="card-sub" style="margin:0;">· ${point.town}</span>` : ""}`
    : "";
  showView("report");
}

document.querySelectorAll(".seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.reportSelection.isBiting = btn.dataset.biting === "true";
  });
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
    document.getElementById("photo-upload-text").textContent = "✅ Фото добавлено — можно заменить";
  };
  reader.readAsDataURL(file);
});

document.getElementById("report-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const pointId = document.getElementById("report-point-id").value;
  const statsBefore = getProfileStats();

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
    visibility: document.getElementById("report-visibility").value,
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
        Откройте карту, найдите точку и нажмите «Сохранить» — в следующий раз прогноз по ней будет на расстоянии одного тапа.
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
  const entries = await Promise.all(
    points.map(async (point) => {
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
    })
  );
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

function renderLeaderboardPreview(userReportsCount) {
  const profile = Storage.getProfile();
  const board = getMockLeaderboard(profile.name, userReportsCount);
  const top3 = board.slice(0, 3);
  const you = board.find((b) => b.isYou);

  return `
    <div class="lb-theme-banner">
      <div class="lb-theme-label">Тема месяца · двойные баллы</div>
      <div class="lb-theme-value">🐟 ${getMonthTheme()}</div>
    </div>
    ${top3.map((b) => renderLeaderboardRow(b)).join("")}
    ${you.rank > 3 ? `<div style="text-align:center;color:var(--gray-500);font-size:12px;padding:2px 0;">⋯</div>${renderLeaderboardRow(you)}` : ""}
    <button class="btn-secondary btn-full" id="btn-open-leaderboard" style="margin-top:10px;">Смотреть весь рейтинг</button>
  `;
}

function renderLeaderboardRow(b) {
  return `
    <div class="lb-row ${b.isYou ? "you" : ""}">
      <div class="lb-rank">${b.rank}</div>
      <div class="lb-name">${b.name}</div>
      <div class="lb-count">${b.reports} отч.</div>
    </div>`;
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
    <div class="empty-state" style="font-size:12px;">Это демо-версия рейтинга: соперники здесь — тестовые имена. Настоящий общий зачёт заработает, когда у приложения появится сервер и другие рыбаки на связи.</div>
  `;
}

// ---------- СТАТЬИ ----------

function renderArticlesList(articles) {
  return articles
    .map(
      (a) => `
    <div class="article-card" data-open-article="${a.id}">
      <div class="article-icon">${a.icon}</div>
      <div>
        <div class="article-title">${a.title}</div>
        <div class="article-summary">${a.summary}</div>
      </div>
    </div>`
    )
    .join("");
}

function bindArticleCards(container) {
  container.querySelectorAll("[data-open-article]").forEach((el) => {
    el.addEventListener("click", () => openArticle(el.dataset.openArticle));
  });
}

function openArticle(id) {
  const article = getArticleById(id);
  if (!article) return;
  showView("article");
  document.getElementById("article-content").innerHTML = `
    <div class="card">
      <div class="article-icon" style="margin-bottom:10px;">${article.icon}</div>
      <div class="card-title" style="font-size:19px;">${article.title}</div>
      <div class="article-body">${article.body.map((p) => `<p>${p}</p>`).join("")}</div>
    </div>
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

function renderRegionsPreview() {
  const regions = getRegionsSummary().slice(0, 4);
  if (!regions.length) {
    return `<div class="empty-state" style="padding:16px 0;">Пока нет точек с определённым регионом.</div>`;
  }
  return `
    <div class="region-chip-row">
      ${regions
        .map(
          (r) => `
        <div class="region-chip" data-open-region="${escapeHtml(r.region)}">
          <div class="region-chip-name">${r.region}</div>
          <div class="region-chip-count">${r.points.length} точ. · ${r.reportsCount} отч.</div>
        </div>`
        )
        .join("")}
    </div>
    <button class="btn-secondary btn-full" id="btn-open-regions" style="margin-top:10px;">Все регионы</button>
  `;
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
    container.innerHTML = `<div class="empty-state"><div class="icon">🗺️</div>Пока нет точек с определённым регионом. Добавьте точку на карте — регион определится автоматически.</div>`;
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
  const forecasts = await Promise.all(points.map((p) => getPointForecast(p).catch(() => null)));
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
}

// ---------- ПРОФИЛЬ ----------

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
            : `<div class="card-sub">Вы достигли максимального уровня — легенда водоёма!</div>`}
        </div>
      </div>
      ${next ? `<div class="level-bar"><div class="level-bar-fill" style="width:${progress}%;"></div></div>` : ""}
    </div>

    <div class="card">
      <div class="card-row"><span>Отчётов оставлено</span><span class="badge">${stats.reportsCount}</span></div>
      <div class="card-row" style="margin-top:8px;"><span>Сохранённых мест</span><span class="badge">${stats.favCount}</span></div>
      <div class="card-row" style="margin-top:8px;"><span>Водоёмов освоено</span><span class="badge">${stats.distinctPoints}</span></div>
      <div class="card-row" style="margin-top:8px;"><span>С нами с</span><span class="card-sub">${memberSince}</span></div>
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
        Каждый отчёт делает прогноз точнее — не только для вас, но и для рыбаков рядом. Плюс это быстрый способ расти в уровне и открывать новые достижения.
      </div>
    </div>

    <div class="empty-state" style="font-size:12px;">Это прототип: имя и данные хранятся только в вашем браузере, без сервера и авторизации. Со своего телефона или другого браузера они видны не будут.</div>
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
}

// ---------- СТАРТ ----------

showOnboardingIfNeeded();
