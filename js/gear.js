// "Что взять" — короткие практичные советы по одежде/снаряжению под текущую погоду.

export function getGearTips(current) {
  const tips = [];

  if (current.tempAir <= 0) {
    tips.push({ icon: "🧤", text: "Термобельё и тёплые перчатки. На воде холоднее, чем кажется по прогнозу." });
  } else if (current.tempAir <= 10) {
    tips.push({ icon: "🧥", text: "Тёплая куртка и слой потеплее. Утро и вечер будут прохладными." });
  } else if (current.tempAir <= 20) {
    tips.push({ icon: "🧥", text: "Лёгкая куртка не помешает. К вечеру может посвежеть." });
  } else {
    tips.push({ icon: "🧢", text: "Лёгкая одежда и головной убор от солнца. Днём будет жарко." });
  }

  if (current.precip >= 0.5) {
    tips.push({ icon: "☔", text: "Дождевик и непромокаемая обувь. Без них будет неуютно." });
  }

  if (current.windSpeed >= 8) {
    tips.push({ icon: "💨", text: "Ветрозащитная куртка и место, закрытое от ветра. Сегодня продувает." });
  }

  return tips;
}
