// Уровни рыбака по числу отчётов — геймификация вовлечённости (см. концепцию, п.7).

export const LEVELS = [
  { threshold: 0, name: "Новичок", icon: "🎣" },
  { threshold: 3, name: "Рыбак", icon: "🐟" },
  { threshold: 10, name: "Бывалый", icon: "🥈" },
  { threshold: 25, name: "Мастер клёва", icon: "🥇" },
  { threshold: 50, name: "Легенда водоёма", icon: "👑" },
];

export function getLevelInfo(reportsCount) {
  let current = LEVELS[0];
  let next = LEVELS[1] || null;
  for (let i = 0; i < LEVELS.length; i++) {
    if (reportsCount >= LEVELS[i].threshold) {
      current = LEVELS[i];
      next = LEVELS[i + 1] || null;
    }
  }
  const progress = next
    ? Math.round(((reportsCount - current.threshold) / (next.threshold - current.threshold)) * 100)
    : 100;
  return { current, next, progress: Math.max(0, Math.min(100, progress)) };
}
