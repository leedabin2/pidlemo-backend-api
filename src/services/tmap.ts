import type { Coordinates } from "../types";

const TMAP_KEY = process.env.TMAP_API_KEY ?? "";

// 구간 캐시: "lat1,lng1→lat2,lng2" → 경로 좌표 배열
const routeCache = new Map<string, Coordinates[]>();

function cacheKey(from: Coordinates, to: Coordinates): string {
  return `${from.lat.toFixed(5)},${from.lng.toFixed(5)}→${to.lat.toFixed(5)},${to.lng.toFixed(5)}`;
}

async function fetchSegmentRoute(from: Coordinates, to: Coordinates): Promise<Coordinates[]> {
  const key = cacheKey(from, to);
  if (routeCache.has(key)) return routeCache.get(key)!;

  if (!TMAP_KEY) return fallbackLine(from, to);

  try {
    const res = await fetch("https://apis.openapi.sk.com/tmap/routes/pedestrian?version=1", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        appKey: TMAP_KEY,
      },
      body: JSON.stringify({
        startX: from.lng,
        startY: from.lat,
        endX: to.lng,
        endY: to.lat,
        reqCoordType: "WGS84GEO",
        resCoordType: "WGS84GEO",
        startName: "출발",
        endName: "도착",
      }),
    });

    if (!res.ok) return fallbackLine(from, to);

    const json = await res.json() as { features?: { geometry?: { type: string; coordinates: number[][] } }[] };
    const coords: Coordinates[] = [];

    for (const feature of json.features ?? []) {
      if (feature.geometry?.type === "LineString") {
        for (const [lng, lat] of feature.geometry.coordinates) {
          coords.push({ lat, lng });
        }
      }
    }

    const result = coords.length > 1 ? coords : fallbackLine(from, to);
    routeCache.set(key, result);
    return result;
  } catch {
    return fallbackLine(from, to);
  }
}

function fallbackLine(from: Coordinates, to: Coordinates): Coordinates[] {
  return [from, to];
}

export async function getWalkingRoute(places: Coordinates[]): Promise<Coordinates[]> {
  if (places.length < 2) return places;

  const segments = await Promise.all(
    places.slice(0, -1).map((from, i) => fetchSegmentRoute(from, places[i + 1]))
  );

  // 구간 연결 (중복 점 제거)
  const full: Coordinates[] = [segments[0][0]];
  for (const seg of segments) {
    full.push(...seg.slice(1));
  }
  return full;
}
