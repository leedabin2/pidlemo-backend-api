import type { Coordinates } from "../types";

const SEOUL_BOUNDS = {
  latMin: 37.42,
  latMax: 37.70,
  lngMin: 126.76,
  lngMax: 127.18,
};

export function isSeoul(coords: Coordinates): boolean {
  return (
    coords.lat >= SEOUL_BOUNDS.latMin &&
    coords.lat <= SEOUL_BOUNDS.latMax &&
    coords.lng >= SEOUL_BOUNDS.lngMin &&
    coords.lng <= SEOUL_BOUNDS.lngMax
  );
}

// 이름 앞 5글자 기준 중복 제거
export function deduplicatePlaces<T extends { name: string; id: string }>(
  places: T[]
): T[] {
  const seen = new Set<string>();
  return places.filter((p) => {
    const key = p.name.slice(0, 5).trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
