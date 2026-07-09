// Предупреждения по текущим условиям — честно предупреждаем о рисках,
// а не только продаём "хороший прогноз" (см. бриф: доверие важнее красивых цифр).

export function computeWarnings(current, month) {
  const warnings = [];

  if (current.windSpeed >= 10) {
    warnings.push({
      icon: "💨",
      text: "На воде будет ветрено. Лодку лучше не брать.",
    });
  }

  if (Math.abs(current.pressureTrend3h) >= 3) {
    warnings.push({
      icon: current.pressureTrend3h > 0 ? "📈" : "📉",
      text: "Давление резко скачет. Рыба может капризничать сильнее обычного.",
    });
  }

  if (current.precip >= 4) {
    warnings.push({
      icon: "🌧️",
      text: "Ожидается сильный дождь. Возьмите дождевик и берегите снасти.",
    });
  }

  if ([11, 0, 1].includes(month) && current.tempAir <= 2) {
    warnings.push({
      icon: "🧊",
      text: "Зима. На льду проверяйте толщину и не выходите в одиночку.",
    });
  }

  return warnings;
}
