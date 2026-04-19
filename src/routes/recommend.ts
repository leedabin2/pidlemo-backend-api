import { Router } from "express";
import type { Request, Response } from "express";
import { getWeather } from "../services/weather";
import {
  getNearByCafes,
  getNearByRestaurants,
  getMockCafes,
  getNearByShoppingPlaces,
  getMockShoppingPlaces,
  getNearByParks as getKakaoParks,
  getMockKakaoParks,
} from "../services/kakaoLocal";
import {
  getNearByPopups as getSeoulPopups,
  getMockPopups as getSeoulMockPopups,
  getNearByParks as getSeoulParks,
  getMockParks as getSeoulMockParks,
} from "../services/publicData";
import {
  getTourAttractions,
  getTourCulture,
  getTourFestivals,
  getMockAttractions,
  getMockFestivals,
} from "../services/tourApi";
import {
  buildCourses,
  getWeatherCondition,
  scorePlace,
  type RecommendationOptions,
} from "../utils/scoring";
import { isSeoul, deduplicatePlaces } from "../utils/region";
import type { Coordinates, Place, PlaceCategory, PlaceGroup } from "../types";

const router = Router();
const PLACE_CATEGORY_ORDER: PlaceCategory[] = [
  "cafe",
  "restaurant",
  "shopping",
  "popup",
  "exhibition",
  "park",
];

function parseCategories(value: unknown): PlaceCategory[] {
  if (typeof value !== "string" || !value.trim()) return [];
  const validCategories = new Set<PlaceCategory>(PLACE_CATEGORY_ORDER);
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is PlaceCategory => validCategories.has(item as PlaceCategory));
}

function parseEnvironment(value: unknown): RecommendationOptions["environment"] {
  if (value === "실내") return "실내";
  if (value === "실외" || value === "야외") return "야외";
  return "상관없음";
}

function parseWeatherAware(value: unknown): boolean {
  if (value === "false") return false;
  if (value === "0") return false;
  return true;
}

function buildPlaceGroups(scoredPlaces: Place[]): PlaceGroup[] {
  return PLACE_CATEGORY_ORDER.map((category) => ({
    category,
    title:
      category === "cafe" ? "카페" :
      category === "restaurant" ? "맛집" :
      category === "shopping" ? "소품샵/쇼핑" :
      category === "popup" ? "팝업/행사" :
      category === "exhibition" ? "전시/문화" :
      "공원 산책",
    places: scoredPlaces
      .filter((place) => place.category === category)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 4),
  })).filter((group) => group.places.length > 0);
}

router.get("/", async (req: Request, res: Response) => {
  const lat = parseFloat(req.query.lat as string);
  const lng = parseFloat(req.query.lng as string);

  if (isNaN(lat) || isNaN(lng)) {
    res.status(400).json({ error: "lat, lng 파라미터가 필요해요" });
    return;
  }

  const coords: Coordinates = { lat, lng };
  const hour = new Date().getHours();
  const seoul = isSeoul(coords);
  const options: RecommendationOptions = {
    selectedCategories: parseCategories(req.query.categories),
    duration: typeof req.query.duration === "string" ? req.query.duration : undefined,
    environment: parseEnvironment(req.query.environment),
    weatherAware: parseWeatherAware(req.query.weatherAware),
  };

  const hasKakaoKey = !!process.env.KAKAO_REST_API_KEY;
  const hasTourKey = !!process.env.TOUR_API_KEY;

  console.log(`\n[recommend] 요청: lat=${lat}, lng=${lng}, 시간=${hour}시`);
  console.log(`[recommend] 지역: ${seoul ? "서울" : "서울 외"}`);
  console.log(`[recommend] Kakao:${hasKakaoKey ? "✅" : "❌"} Tour:${hasTourKey ? "✅" : "❌"}`);

  try {
    // ── 병렬 데이터 수집 ────────────────────────────────────────
    const [
      weather,
      cafes,
      restaurants,
      shoppingPlaces,
      kakaoParks,
      tourAttractions,
      tourCulture,
      tourFestivals,
      seoulPopups,
      seoulParks,
    ] = await Promise.all([
      getWeather(coords),

      // 카페/맛집/쇼핑/공원: 카카오 (전국)
      hasKakaoKey
        ? getNearByCafes(coords)
        : Promise.resolve(getMockCafes(coords)),
      hasKakaoKey
        ? getNearByRestaurants(coords)
        : Promise.resolve([]),
      hasKakaoKey
        ? getNearByShoppingPlaces(coords)
        : Promise.resolve(getMockShoppingPlaces(coords)),
      hasKakaoKey
        ? getKakaoParks(coords)
        : Promise.resolve(getMockKakaoParks(coords)),

      // 관광지/공원 보강: Tour API (전국)
      hasTourKey
        ? getTourAttractions(coords)
        : Promise.resolve(getMockAttractions(coords)),

      // 문화시설: Tour API (전국)
      hasTourKey
        ? getTourCulture(coords)
        : Promise.resolve([]),

      // 행사/축제: Tour API (전국)
      hasTourKey
        ? getTourFestivals(coords)
        : Promise.resolve(getMockFestivals(coords)),

      // 서울 한정: 서울시 팝업/공원 API로 보강
      seoul && process.env.PUBLIC_DATA_API_KEY
        ? getSeoulPopups(coords)
        : Promise.resolve(seoul ? getSeoulMockPopups(coords) : []),
      seoul && process.env.PUBLIC_DATA_API_KEY
        ? getSeoulParks(coords)
        : Promise.resolve(seoul ? getSeoulMockParks(coords) : []),
    ]);

    console.log(`[recommend] 날씨: ${weather.description} ${weather.temp}°C (체감 ${weather.feelsLike}°C) → ${getWeatherCondition(weather)}`);

    // ── 팝업/행사 병합 (서울은 두 소스 합산 후 중복 제거) ──────
    const rawPopups = deduplicatePlaces([...tourFestivals, ...seoulPopups]);

    // ── 공원: 카카오(키워드) + Tour API 관광지 + 서울시 공원 합산 ──
    const rawParks = deduplicatePlaces([...kakaoParks, ...tourAttractions, ...seoulParks]);

    const allPlaces: Place[] = [
      ...cafes,
      ...restaurants,
      ...shoppingPlaces,
      ...rawPopups,
      ...rawParks,
      ...tourCulture,
    ];

    console.log(
      `[recommend] 수집: 카페${cafes.length} 맛집${restaurants.length} 쇼핑${shoppingPlaces.length}` +
      ` 팝업${rawPopups.length} 공원${rawParks.length}(카카오${kakaoParks.length}) 문화${tourCulture.length}`
    );

    // ── 스코어 계산 ──────────────────────────────────────────────
    const ctx = {
      weather,
      condition: getWeatherCondition(weather, options.weatherAware),
      hourOfDay: hour,
      preferences: {
        selectedCategories: options.selectedCategories ?? [],
        environment: options.environment ?? "상관없음",
        durationBudgetMinutes: null,
        weatherAware: options.weatherAware ?? true,
      },
    };
    const scoredPlaces = allPlaces.map((p) => ({
      ...p,
      score: scorePlace(p, ctx),
    }));

    // ── 코스 조합 ────────────────────────────────────────────────
    const courses = buildCourses(scoredPlaces, weather, hour, options);

    const topPlaces = [...scoredPlaces]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 12);
    const placeGroups = buildPlaceGroups(scoredPlaces);

    res.json({
      region: seoul ? "seoul" : "nationwide",
      weather: {
        description: weather.description,
        temp: weather.temp,
        feelsLike: weather.feelsLike,
        isSunny: weather.isSunny,
        isRainy: weather.isRainy,
      },
      courses,
      places: topPlaces,
      placeGroups,
    });
  } catch (err) {
    console.error("[recommend] 오류:", err);
    res.status(500).json({ error: "추천을 불러오지 못했어요" });
  }
});

export default router;
