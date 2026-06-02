import type { Coordinates, Place } from "../types";
import {
  getNearByCafes, getNearByRestaurants, getNearByShoppingPlaces, getNearByMallPlaces,
  getNearByParks as getKakaoParks, getNearByPhotoBooth, getNearByBars,
  getNearByNaturePlaces, getNearByCinemas, getNearByKakaoPopups,
  getNearByPopularPlaces, getNearByTouristSpots, getNearByCultureVenues,
  getNearByActivityPlaces,
  getMockCafes, getMockShoppingPlaces, getMockMallPlaces, getMockKakaoParks,
} from "./kakaoLocal";
import {
  getNearByPopups as getSeoulPopups, getMockPopups as getSeoulMockPopups,
  getNearByParks as getSeoulParks, getMockParks as getSeoulMockParks,
} from "./publicData";
import {
  getTourAttractions, getTourCulture, getTourFestivals,
  getMockAttractions, getMockFestivals,
} from "./tourApi";
import { logger } from "../utils/logger";

export interface PlacePool {
  cafes: Place[]; restaurants: Place[]; shoppingPlaces: Place[]; mallPlaces: Place[];
  kakaoParks: Place[]; photoBooths: Place[]; bars: Place[];
  naturePlaces: Place[]; cinemas: Place[]; kakaoPopups: Place[];
  popularPlaces: Place[]; kakaoTouristSpots: Place[]; kakaoCultureVenues: Place[];
  tourAttractions: Place[]; tourCulture: Place[]; tourFestivals: Place[];
  seoulPopups: Place[]; seoulParks: Place[];
  activityPlaces: Place[];
}

const placePoolCache = new Map<string, { pool: PlacePool; expiresAt: number }>();
const POOL_TTL_MS = 2 * 60 * 60 * 1000;

export function poolKey(coords: Coordinates, seoul: boolean, transport: "도보" | "대중교통" | "차량" = "도보"): string {
  const t = transport === "차량" ? "car" : transport === "대중교통" ? "transit" : "walk";
  return `${coords.lat.toFixed(2)}_${coords.lng.toFixed(2)}_${seoul ? "s" : "n"}_${t}`;
}

export function getCachedPool(key: string): PlacePool | null {
  const cached = placePoolCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.pool;
  return null;
}

export function setCachedPool(key: string, pool: PlacePool): void {
  placePoolCache.set(key, { pool, expiresAt: Date.now() + POOL_TTL_MS });
}

export async function fetchPlacePool(
  coords: Coordinates,
  seoul: boolean,
  hasKakaoKey: boolean,
  hasTourKey: boolean,
  transport: "도보" | "대중교통" | "차량" = "도보",
): Promise<PlacePool> {
  const baseRadius = transport === "차량" ? 4500 : transport === "대중교통" ? 2500 : 1500;
  const [
    cafes, restaurants, shoppingPlaces, mallPlaces, kakaoParks,
    photoBooths, bars, naturePlaces, cinemas,
    kakaoPopups, popularPlaces, kakaoTouristSpots, kakaoCultureVenues,
    tourAttractions, tourCulture, tourFestivals,
    seoulPopups, seoulParks, activityPlaces,
  ] = await Promise.all([
    hasKakaoKey ? getNearByCafes(coords, baseRadius) : Promise.resolve(getMockCafes(coords)),
    hasKakaoKey ? getNearByRestaurants(coords, baseRadius) : Promise.resolve([]),
    hasKakaoKey ? getNearByShoppingPlaces(coords, baseRadius) : Promise.resolve(getMockShoppingPlaces(coords)),
    hasKakaoKey ? getNearByMallPlaces(coords, baseRadius) : Promise.resolve(getMockMallPlaces(coords)),
    hasKakaoKey ? getKakaoParks(coords, baseRadius) : Promise.resolve(getMockKakaoParks(coords)),
    hasKakaoKey ? getNearByPhotoBooth(coords, baseRadius) : Promise.resolve([]),
    hasKakaoKey ? getNearByBars(coords, baseRadius) : Promise.resolve([]),
    hasKakaoKey ? getNearByNaturePlaces(coords, baseRadius) : Promise.resolve([]),
    hasKakaoKey ? getNearByCinemas(coords, baseRadius) : Promise.resolve([]),
    hasKakaoKey ? getNearByKakaoPopups(coords, baseRadius) : Promise.resolve([]),
    hasKakaoKey ? getNearByPopularPlaces(coords, baseRadius) : Promise.resolve([]),
    hasKakaoKey ? getNearByTouristSpots(coords, baseRadius) : Promise.resolve([]),
    hasKakaoKey ? getNearByCultureVenues(coords, baseRadius) : Promise.resolve([]),
    hasTourKey ? getTourAttractions(coords) : Promise.resolve(getMockAttractions(coords)),
    hasTourKey ? getTourCulture(coords) : Promise.resolve([]),
    hasTourKey ? getTourFestivals(coords) : Promise.resolve(getMockFestivals(coords)),
    seoul && process.env.PUBLIC_DATA_API_KEY ? getSeoulPopups(coords) : Promise.resolve(seoul ? getSeoulMockPopups(coords) : []),
    seoul && process.env.PUBLIC_DATA_API_KEY ? getSeoulParks(coords) : Promise.resolve(seoul ? getSeoulMockParks(coords) : []),
    hasKakaoKey ? getNearByActivityPlaces(coords, baseRadius) : Promise.resolve([]),
  ]);

  logger.info("placePool", "Tour API 후보 풀 반영", {
    enabled: hasTourKey ? "Y" : "N",
    attractionsToPark: tourAttractions.length,
    cultureToExhibition: tourCulture.length,
    festivalsToPopup: tourFestivals.length,
  });

  return {
    cafes, restaurants, shoppingPlaces, mallPlaces, kakaoParks,
    photoBooths, bars, naturePlaces, cinemas,
    kakaoPopups, popularPlaces, kakaoTouristSpots, kakaoCultureVenues,
    tourAttractions, tourCulture, tourFestivals,
    seoulPopups, seoulParks, activityPlaces,
  };
}
