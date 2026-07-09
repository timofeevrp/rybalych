// Рейтинг рыбаков — макет для демонстрации механики (см. концепцию, "рейтинг рыбаков").
// ВАЖНО: это mock-данные. Реальный общий рейтинг невозможен без backend —
// сейчас в приложении нет других настоящих пользователей, только вы.
// Структура сделана так, чтобы позже просто заменить MOCK_ANGLERS на запрос к API.

const MOCK_ANGLERS = [
  { name: "Алексей С.", reports: 14 },
  { name: "Дмитрий В.", reports: 11 },
  { name: "Игорь М.", reports: 9 },
  { name: "Сергей П.", reports: 7 },
  { name: "Николай Т.", reports: 5 },
  { name: "Пётр К.", reports: 3 },
  { name: "Виктор Л.", reports: 1 },
];

// Тема месяца — как в клубной механике "каждый месяц новая тема": в этом месяце
// двойные баллы за отчёты по конкретному виду рыбы.
const MONTH_THEMES = [
  "Судак", "Судак", "Плотва", "Щука", "Щука", "Карп",
  "Карась", "Сом", "Щука", "Щука", "Лещ", "Налим",
];

export function getMonthTheme(date = new Date()) {
  return MONTH_THEMES[date.getMonth()];
}

export function getMockLeaderboard(userName, userReportsCount) {
  const you = { name: `${userName || "Вы"} (вы)`, reports: userReportsCount, isYou: true };
  const all = [...MOCK_ANGLERS, you].sort((a, b) => b.reports - a.reports);
  return all.map((a, i) => ({ ...a, rank: i + 1 }));
}

export const MONTHLY_PRIZE = {
  title: "Воблер + коробка приманок",
  sponsor: "от партнёров Рыбалыча",
  rule: "Топ-3 рейтинга месяца получают приз. Учитываются только отчёты, подтверждённые модератором (фото рыбы на фоне точки или весов).",
};
