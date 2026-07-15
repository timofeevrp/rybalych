// Реверс-геокодинг: Nominatim (OpenStreetMap), бесплатно, без ключа. См. концепцию, п.14.
// В проде за реальным трафиком стоит проксировать через свой backend (политика Nominatim
// просит не более 1 запроса/сек и не подходит для прод-нагрузки напрямую с клиента).

const cache = new Map();

export async function reverseGeocode(lat, lon) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (cache.has(key)) return cache.get(key);

  const params = new URLSearchParams({
    format: "json",
    lat,
    lon,
    zoom: "12",
    addressdetails: "1",
    "accept-language": "ru",
  });

  const res = await fetch(`https://nominatim.openstreetmap.org/reverse?${params.toString()}`);
  if (!res.ok) throw new Error(`Geocode error: ${res.status}`);
  const data = await res.json();
  const addr = data.address || {};
  const town =
    addr.village || addr.town || addr.city || addr.municipality || addr.county || null;
  // addr.state — в России это область/край/республика, ровно то деление,
  // по которому строится экран "Регионы"
  const region = addr.state || null;

  const result = { town, region };
  cache.set(key, result);
  return result;
}

// Поиск по названию через тот же Nominatim — в отличие от нашей базы (~20
// заведённых точек), находит любой водоём/город, который есть в OpenStreetMap.
// Используется как fallback, когда в своей базе ничего не нашлось.
const searchCache = new Map();
export async function searchPlaces(query) {
  const key = query.trim().toLowerCase();
  if (!key) return [];
  if (searchCache.has(key)) return searchCache.get(key);

  const params = new URLSearchParams({
    q: query,
    format: "json",
    addressdetails: "1",
    "accept-language": "ru",
    countrycodes: "ru",
    limit: "6",
  });

  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`);
  if (!res.ok) throw new Error(`Geocode search error: ${res.status}`);
  const data = await res.json();
  const results = data.map((item) => ({
    name: item.display_name.split(",")[0],
    fullLabel: item.display_name,
    lat: parseFloat(item.lat),
    lon: parseFloat(item.lon),
  }));
  searchCache.set(key, results);
  return results;
}
