import type { Coordinates } from "../types";

// 한국 영토 경계 (제주도 포함)
const KOREA_BOUNDS = {
  latMin: 33.0,
  latMax: 38.9,
  lngMin: 124.5,
  lngMax: 132.0,
};

export function isKorea(coords: Coordinates): boolean {
  return (
    coords.lat >= KOREA_BOUNDS.latMin &&
    coords.lat <= KOREA_BOUNDS.latMax &&
    coords.lng >= KOREA_BOUNDS.lngMin &&
    coords.lng <= KOREA_BOUNDS.lngMax
  );
}

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
