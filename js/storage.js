// Локальное хранилище прототипа: пользовательские точки, отчёты, избранное, профиль.
// В реальном продукте это заменяется на backend + Postgres (см. концепцию, п.13).

const KEYS = {
  points: "petrovich_user_points",
  reports: "petrovich_reports",
  favorites: "petrovich_favorites",
  profile: "petrovich_profile",
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export const Storage = {
  getUserPoints() {
    return read(KEYS.points, []);
  },
  addUserPoint(point) {
    const points = Storage.getUserPoints();
    points.push(point);
    write(KEYS.points, points);
    return point;
  },

  getReports(pointId = null) {
    const reports = read(KEYS.reports, []);
    return pointId ? reports.filter((r) => r.pointId === pointId) : reports;
  },
  addReport(report) {
    const reports = read(KEYS.reports, []);
    reports.unshift(report);
    write(KEYS.reports, reports);
    return report;
  },

  getFavorites() {
    return read(KEYS.favorites, []);
  },
  isFavorite(pointId) {
    return Storage.getFavorites().includes(pointId);
  },
  toggleFavorite(pointId) {
    let favs = Storage.getFavorites();
    if (favs.includes(pointId)) {
      favs = favs.filter((id) => id !== pointId);
    } else {
      favs.push(pointId);
    }
    write(KEYS.favorites, favs);
    return favs;
  },

  getProfile() {
    const saved = read(KEYS.profile, null);
    const defaults = {
      name: "Рыбак",
      createdAt: new Date().toISOString(),
      region: "",
      city: "",
      fishingExperience: "",
      favoriteFishingTypes: [],
      favoriteWaters: [],
      publicProfileEnabled: false,
      privacy: {
        showAvatar: true,
        showRegion: false,
        showFishingExperience: false,
        showFavoriteFishingTypes: false,
        showFavoriteWaters: false,
        showAchievements: true,
        showReports: true,
        showMaxContact: false,
        defaultReportAuthorVisibility: "anonymous",
        defaultLocationPrivacy: "water",
      },
      contact: { maxRaw: "", maxSafeUrl: "" },
    };
    if (!saved) return defaults;
    // Глубокий мердж — у профилей, сохранённых до этой версии, нет вложенных
    // privacy/contact, поверхностный спред оставил бы их undefined.
    return {
      ...defaults,
      ...saved,
      privacy: { ...defaults.privacy, ...(saved.privacy || {}) },
      contact: { ...defaults.contact, ...(saved.contact || {}) },
    };
  },
  updateProfile(patch) {
    const profile = { ...Storage.getProfile(), ...patch };
    write(KEYS.profile, profile);
    return profile;
  },

  // Массово снимает авторство со всех отчётов — используется только по явной
  // кнопке пользователя "Сделать все отчёты анонимными" в профиле.
  anonymizeAllReports() {
    const reports = read(KEYS.reports, []).map((r) => {
      const { authorName, authorLevel, authorAvatar, ...rest } = r;
      return { ...rest, authorVisibility: "anonymous" };
    });
    write(KEYS.reports, reports);
    return reports;
  },
};
