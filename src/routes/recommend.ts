import { Router } from "express";
import type { Request, Response } from "express";
import { getWeather } from "../services/weather";
import {
  getNearByCafes,
  getNearByRestaurants,
  getMockCafes,
} from "../services/kakaoLocal";
import {
  getNearByPopups as getSeoulPopups,
  getMockPopups as getSeoulMockPopups,
} from "../services/publicData";
import {
  getTourAttractions,
  getTourCulture,
  getTourFestivals,
  getMockAttractions,
  getMockFestivals,
} from "../services/tourApi";
import { scorePlace, buildCourses } from "../utils/scoring";
import { isSeoul, deduplicatePlaces } from "../utils/region";
import type { Coordinates, Place } from "../types";

const router = Router();

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
      tourAttractions,
      tourCulture,
      tourFestivals,
      seoulPopups,
    ] = await Promise.all([
      getWeather(coords),

      // 카페/맛집: 카카오 (전국)
      hasKakaoKey
        ? getNearByCafes(coords)
        : Promise.resolve(getMockCafes(coords)),
      hasKakaoKey
        ? getNearByRestaurants(coords)
        : Promise.resolve([]),

      // 관광지/공원: Tour API (전국)
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

      // 서울 한정: 서울시 팝업 API로 보강
      seoul && process.env.PUBLIC_DATA_API_KEY
        ? getSeoulPopups(coords)
        : Promise.resolve(seoul ? getSeoulMockPopups(coords) : []),
    ]);

    console.log(`[recommend] 날씨: ${weather.description} ${weather.temp}°C`);

    // ── 팝업/행사 병합 (서울은 두 소스 합산 후 중복 제거) ──────
    const rawPopups = deduplicatePlaces([...tourFestivals, ...seoulPopups]);

    // ── 공원: Tour API 관광지 + 카카오 공원 검색 합산 ──────────
    const rawParks = deduplicatePlaces(tourAttractions);

    const allPlaces: Place[] = [
      ...cafes,
      ...restaurants,
      ...rawPopups,
      ...rawParks,
      ...tourCulture,
    ];

    console.log(
      `[recommend] 수집: 카페${cafes.length} 맛집${restaurants.length}` +
      ` 팝업${rawPopups.length} 공원${rawParks.length} 문화${tourCulture.length}`
    );

    // ── 스코어 계산 ──────────────────────────────────────────────
    const ctx = { weather, hourOfDay: hour };
    const scoredPlaces = allPlaces.map((p) => ({
      ...p,
      score: scorePlace(p, ctx),
    }));

    // ── 코스 조합 ────────────────────────────────────────────────
    const courses = buildCourses(scoredPlaces, weather, hour);

    const topPlaces = [...scoredPlaces]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 8);

    res.json({
      region: seoul ? "seoul" : "nationwide",
      weather: {
        description: weather.description,
        temp: weather.temp,
        isSunny: weather.isSunny,
        isRainy: weather.isRainy,
      },
      courses,
      places: topPlaces,
    });
  } catch (err) {
    console.error("[recommend] 오류:", err);
    res.status(500).json({ error: "추천을 불러오지 못했어요" });
  }
});

export default router;
