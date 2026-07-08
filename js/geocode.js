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
