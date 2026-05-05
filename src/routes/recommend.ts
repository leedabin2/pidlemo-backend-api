import { Router } from "express";
import type { Request, Response } from "express";
import { ipRateLimit } from "../middleware/rateLimit";
import { getWeather, getWeatherForecast } from "../services/weather";
import { getNearByWellnessPlaces, getMockWellnessPlaces } from "../services/kakaoLocal";
import { formatOperatingHoursLabel, getPlaceAtmosphere, getPlaceDetails, isOpenAtOffset } from "../services/googlePlaces";
import { buildCourses, getWeatherCondition, scorePlace, type RecommendationOptions } from "../utils/scoring";
import { PLACE_CATEGORY_ORDER, CATEGORY_TITLE } from "../constants/categories";
import { isSeoul, isKorea, deduplicatePlaces } from "../utils/region";
import { generateCourseSummaries } from "../services/aiSummary";
import { logQuotaUsageSnapshot } from "../services/quotaTracker";
import { logger } from "../utils/logger";
import { poolKey, getCachedPool, setCachedPool, fetchPlacePool } from "../services/placePool";
import { POPULAR_CANDIDATE_TAG, candidateStageScore, selectCandidatePlaces } from "../services/candidateSelector";
import type { Coordinates, Place, PlaceCategory, PlaceGroup } from "../types";

const router = Router();

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
  return value !== "false" && value !== "0";
}

function parseTransport(value: unknown): "도보" | "대중교통" | "차량" {
  if (value === "대중교통") return "대중교통";
  if (value === "차량") return "차량";
  return "도보";
}

function parseCompanion(value: unknown): RecommendationOptions["companion"] {
  if (
    value === "아이와 함께" || value === "데이트" ||
    value === "친구들과" || value === "직장모임" || value === "가족과"
  ) return value;
  return "상관없음";
}

function parseBoolFlag(value: unknown): boolean {
  return value === "true" || value === "1";
}

function mergeUniqueTags(tags: string[]): string[] {
  return [...new Set(tags)];
}

function buildPlaceGroups(scoredPlaces: Place[]): PlaceGroup[] {
  return PLACE_CATEGORY_ORDER.map((category) => ({
    category,
    title: CATEGORY_TITLE[category],
    places: scoredPlaces
      .filter((place) => place.category === category)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 6),
  })).filter((group) => group.places.length > 0);
}

function preferPrimaryPlaces(primary: Place[], fallback: Place[], limit: number): Place[] {
  const primaryDeduped = deduplicatePlaces(primary).slice(0, limit);
  if (primaryDeduped.length >= limit) return primaryDeduped;

  const seen = new Set(primaryDeduped.map((p) => p.name.slice(0, 5).trim()));
  const supplemental = fallback.filter((p) => {
    const key = p.name.slice(0, 5).trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return [...primaryDeduped, ...supplemental].slice(0, limit);
}

function hasBreakTime(hours: import("../services/googlePlaces").PlaceHours): boolean {
  const today = new Date().getDay();
  return hours.periods.filter((p) => p.open.day === today).length >= 2;
}

async function enrichWithGoogleDetails(places: Place[]): Promise<Place[]> {
  if (!process.env.GOOGLE_PLACES_API_KEY) return places;

  return Promise.all(
    places.map(async (place) => {
      try {
        const details = await getPlaceDetails(place.name, place.coordinates, place.address, place.phone, place.category);
        if (!details) return place;

        const { hours, rating, reviewCount, priceLevel, photoUrl } = details;
        const openAtArrival = hours ? isOpenAtOffset(hours, place.walkingMinutes) : null;
        const closingSoon = hours?.closesAtMinutesFromNow !== null && (hours?.closesAtMinutesFromNow ?? Infinity) <= 30;
        const breakTime = closingSoon && hours ? hasBreakTime(hours) : false;

        return {
          ...place,
          operatingHours: hours ? formatOperatingHoursLabel(hours) : place.operatingHours,
          isOpen: hours ? hours.isOpenNow : place.isOpen,
          googleRating: rating ?? undefined,
          googleReviewCount: reviewCount ?? undefined,
          priceLevel: priceLevel ?? undefined,
          photoUrl: photoUrl ?? undefined,
          googleHours: hours ?? undefined,
          tags: [
            ...place.tags,
            ...(breakTime ? ["브레이크타임"] : closingSoon ? ["곧 마감"] : []),
            ...(openAtArrival === false ? ["도착 시 마감"] : []),
          ],
        };
      } catch {
        return place;
      }
    })
  );
}

function shouldFetchAtmosphere(options: RecommendationOptions) {
  return (
    options.transport === "차량" ||
    options.requireParking === true ||
    options.companion === "아이와 함께" ||
    options.requireChildFacilities === true ||
    options.requireRestroom === true ||
    options.companion === "직장모임"
  );
}

const coordKey = (p: Place) => `${p.coordinates.lat.toFixed(3)}_${p.coordinates.lng.toFixed(3)}`;

function isChildFriendlyActivity(place: Place): boolean {
  const haystack = `${place.name} ${place.subCategory ?? ""} ${place.tags.join(" ")}`;
  if (/(홀덤|포커|오락실|방탈출|보드게임|보드카페|만화방|만화카페|VR|멀티방)/.test(haystack)) return false;
  return /(키즈|어린이|유아|패밀리|가족|체험)/.test(haystack) || place.goodForChildren === true;
}

function isChildFriendlyAtmosphereCandidate(place: Place): boolean {
  const haystack = `${place.name} ${place.subCategory ?? ""} ${place.tags.join(" ")}`;
  if (/(홀덤|포커|이자카야|바|주점|포차)/.test(haystack)) return false;
  if (place.category === "activity" && !isChildFriendlyActivity(place)) return false;
  return true;
}

function companionGuardrailReason(
  place: Place,
  options: RecommendationOptions,
): string | null {
  const companion = options.companion ?? "상관없음";
  const haystack = `${place.name} ${place.subCategory ?? ""} ${place.tags.join(" ")}`;

  if (companion === "아이와 함께") {
    if (place.category === "bar") return "아이동반: bar 제외";
    if (place.category === "shopping") return "아이동반: 감성 소품샵 제외";
    if (place.category === "activity" && !isChildFriendlyActivity(place)) {
      return `아이동반: 부적합 activity 제외(${place.subCategory ?? place.name})`;
    }
    if (/(홀덤|포커|카지노|주점|포차|이자카야)/.test(haystack)) return "아이동반: 유흥/성인향 제외";
  }

  if (companion === "가족과") {
    if (place.category === "bar") return "가족과: bar 제외";
    if (place.category === "shopping") return "가족과: 감성 소품샵 제외";
    if (place.category === "activity" && /(홀덤|포커|오락실|방탈출|보드게임|보드카페|만화방|만화카페|VR|멀티방)/.test(haystack)) {
      return `가족과: 부적합 activity 제외(${place.subCategory ?? place.name})`;
    }
  }

  if (companion === "직장모임") {
    if (place.category === "shopping") return "직장모임: 감성 소품샵 제외";
  }

  return null;
}

function applyCompanionGuardrails(
  places: Place[],
  options: RecommendationOptions,
): Place[] {
  if (!options.companion || options.companion === "상관없음") return places;

  const kept: Place[] = [];
  const excluded: string[] = [];

  for (const place of places) {
    const reason = companionGuardrailReason(place, options);
    if (reason) {
      excluded.push(`${place.name}(${place.category}) - ${reason}`);
      continue;
    }
    kept.push(place);
  }

  if (excluded.length > 0) {
    logger.list("recommend", `동반자 가드레일 제외 ${excluded.length}개`, excluded, 20);
  }

  return kept;
}

function applyChildCategoryDefaults(places: Place[]): Place[] {
  const defaulted: string[] = [];
  const result = places.map((p) => {
    if (p.goodForChildren !== undefined) return p;
    if (["mall", "park", "cinema", "nature"].includes(p.category)) {
      defaulted.push(`${p.name}(${p.category})`);
      return { ...p, goodForChildren: true };
    }
    return p;
  });
  if (defaulted.length > 0) {
    logger.list("recommend", `🧒 카테고리 기본값 → goodForChildren=true ${defaulted.length}개`, defaulted, 20);
  }
  return result;
}

function pickAtmosphereTargets(places: Place[], options: RecommendationOptions): Place[] {
  const picked: Place[] = [];
  const seen = new Set<string>();
  const byStage = [...places].sort((a, b) => candidateStageScore(b) - candidateStageScore(a));
  const seenCoords = new Set<string>();

  const priorityFor = (category: Place["category"]): number => {
    if (options.companion === "아이와 함께") {
      return ["mall", "activity", "cinema", "park", "exhibition", "restaurant", "cafe"].indexOf(category);
    }
    if (options.companion === "직장모임") {
      return ["restaurant", "bar", "cafe", "mall"].indexOf(category);
    }
    if (options.transport === "차량") {
      return ["mall", "restaurant", "cinema", "activity", "cafe", "shopping"].indexOf(category);
    }
    return 0;
  };

  const sortByAtmospherePriority = (source: Place[]) =>
    [...source].sort((a, b) => {
      const aPriority = priorityFor(a.category);
      const bPriority = priorityFor(b.category);
      const normalizedAPriority = aPriority === -1 ? 999 : aPriority;
      const normalizedBPriority = bPriority === -1 ? 999 : bPriority;
      if (normalizedAPriority !== normalizedBPriority) return normalizedAPriority - normalizedBPriority;
      const stageDiff = candidateStageScore(b) - candidateStageScore(a);
      if (stageDiff !== 0) return stageDiff;
      return a.walkingMinutes - b.walkingMinutes;
    });

  const globalCap = options.companion === "아이와 함께" ? 20 : 12;
  const addTop = (source: Place[], limit: number) => {
    let added = 0;
    for (const place of sortByAtmospherePriority(source)) {
      if (picked.length >= globalCap || added >= limit) break;
      if (seen.has(place.id)) continue;
      const coord = coordKey(place);
      if (seenCoords.has(coord)) continue;
      seen.add(place.id);
      seenCoords.add(coord);
      picked.push(place);
      added += 1;
    }
  };

  if (options.transport === "차량") {
    addTop(byStage.filter((p) => ["restaurant", "cafe", "shopping", "mall", "cinema", "activity"].includes(p.category)), 3);
  }
  if (options.companion === "아이와 함께") {
    // mall/park/cinema/nature → 카테고리 기본값으로 처리 (applyChildCategoryDefaults), API 불필요
    // restaurant/cafe/popup/activity/exhibition → 실제 여부 Google API로 확인
    addTop(
      byStage.filter((p) =>
        ["restaurant", "cafe", "popup", "activity", "exhibition"].includes(p.category) &&
        isChildFriendlyAtmosphereCandidate(p)
      ),
      20,
    );
  }
  if (options.companion === "직장모임") {
    addTop(byStage.filter((p) => ["restaurant", "bar", "cafe"].includes(p.category)), 4);
  }

  return picked;
}

async function enrichWithGoogleAtmosphere(places: Place[], options: RecommendationOptions): Promise<Place[]> {
  if (!process.env.GOOGLE_PLACES_API_KEY || !shouldFetchAtmosphere(options)) return places;

  const targets = pickAtmosphereTargets(places, options);
  if (targets.length === 0) return places;

  logger.info("recommend", "Places API (New) atmosphere 대상 선정", {
    count: targets.length,
    transport: options.transport, companion: options.companion,
  });
  logger.list("placesNew", `🎯 atmosphere 대상 ${targets.length}개`, targets.map((place) => {
    const badges = [
      options.transport === "차량" ? "🚗" : null,
      options.companion === "아이와 함께" ? "🧒" : null,
      options.companion === "직장모임" ? "👥" : null,
    ].filter(Boolean).join("");
    return `${badges} ${place.name}(${place.category})`;
  }), 12);

  const byId = new Map<string, Place>(places.map((place) => [place.id, place]));

  // 좌표 → 동일 위치 place id 목록 (API 결과를 같은 건물 전체에 적용)
  const coordToIds = new Map<string, string[]>();
  for (const place of places) {
    const key = coordKey(place);
    if (!coordToIds.has(key)) coordToIds.set(key, []);
    coordToIds.get(key)!.push(place.id);
  }

  await Promise.all(
    targets.map(async (place) => {
      const atmosphere = await getPlaceAtmosphere(
        place.name, place.coordinates,
        {
          parking: options.transport === "차량" || options.requireParking === true,
          children: options.companion === "아이와 함께" || options.requireChildFacilities === true || options.requireRestroom === true,
          groups: options.companion === "직장모임",
        },
        place.address, place.phone, place.category
      );
      if (!atmosphere) return;

      for (const id of (coordToIds.get(coordKey(place)) ?? [place.id])) {
        const current = byId.get(id);
        if (!current) continue;
        byId.set(id, {
          ...current,
          hasParking: atmosphere.hasParking ?? current.hasParking,
          parkingSummary: atmosphere.parkingSummary ?? current.parkingSummary,
          goodForChildren: atmosphere.goodForChildren ?? current.goodForChildren,
          menuForChildren: atmosphere.menuForChildren ?? current.menuForChildren,
          goodForGroups: atmosphere.goodForGroups ?? current.goodForGroups,
          restroom: atmosphere.restroom ?? current.restroom,
          tags: mergeUniqueTags([
            ...(atmosphere.hasParking ? ["주차 가능"] : []),
            ...(atmosphere.goodForChildren || atmosphere.menuForChildren ? ["아이 동반"] : []),
            ...(atmosphere.goodForGroups ? ["단체 모임"] : []),
            ...current.tags,
          ]),
        });
      }
    })
  );

  return places.map((place) => byId.get(place.id) ?? place);
}
// ── Layer 2: AI 요약 캐시 (4시간) ─────────────────────────────────
const aiSummaryCache = new Map<string, { summaries: string[]; expiresAt: number }>();
const AI_TTL_MS = 4 * 60 * 60 * 1000;

function aiKey(courses: import("../types").Course[], slot: string, condition: string): string {
  const ids = courses.map((c) => c.places.map((p) => p.id).join("+")).join("|");
  return `${ids}__${slot}__${condition}`;
}

router.get("/", ipRateLimit, async (req: Request, res: Response) => {
  const lat = parseFloat(req.query.lat as string);
  const lng = parseFloat(req.query.lng as string);

  if (isNaN(lat) || isNaN(lng)) {
    res.status(400).json({ error: "lat, lng 파라미터가 필요해요" });
    return;
  }

  const coords: Coordinates = { lat, lng };

  if (!isKorea(coords)) {
    res.status(422).json({ error: "현재 한국에서만 사용할 수 있어요 🇰🇷" });
    return;
  }

  const hour = new Date().getHours();
  const seoul = isSeoul(coords);
  const options: RecommendationOptions = {
    selectedCategories: parseCategories(req.query.categories),
    duration: typeof req.query.duration === "string" ? req.query.duration : undefined,
    environment: parseEnvironment(req.query.environment),
    weatherAware: parseWeatherAware(req.query.weatherAware),
    transport: parseTransport(req.query.transport),
    companion: parseCompanion(req.query.companion),
    requireParking: parseBoolFlag(req.query.requireParking),
    requireRestroom: parseBoolFlag(req.query.requireRestroom),
    requireChildFacilities: parseBoolFlag(req.query.requireChildFacilities),
  };

  const hasKakaoKey = !!process.env.KAKAO_REST_API_KEY;
  const hasTourKey = !!process.env.TOUR_API_KEY;
  const hasGoogleKey = !!process.env.GOOGLE_PLACES_API_KEY;

  logger.info("recommend", "추천 요청", {
    lat, lng, hour,
    transport: options.transport, companion: options.companion,
    region: seoul ? "서울" : "서울 외",
    kakao: hasKakaoKey ? "Y" : "N", tour: hasTourKey ? "Y" : "N", google: hasGoogleKey ? "Y" : "N",
  });
  logQuotaUsageSnapshot("[quota][before]");

  try {
    const [weather, forecast] = await Promise.all([
      getWeather(coords),
      getWeatherForecast(coords),
    ]);

    // ── Layer 1: 장소 풀 캐시 ─────────────────────────────────────
    const pKey = poolKey(coords, seoul);
    let pool = getCachedPool(pKey);
    if (pool) {
      logger.info("recommend", "장소 풀 캐시 HIT", { key: pKey });
    } else {
      logger.info("recommend", "장소 풀 캐시 MISS → API 수집", { key: pKey });
      pool = await fetchPlacePool(coords, seoul, hasKakaoKey, hasTourKey);
      setCachedPool(pKey, pool);
    }

    const {
      cafes, restaurants, shoppingPlaces, mallPlaces, kakaoParks,
      photoBooths, bars, naturePlaces, cinemas,
      kakaoPopups, popularPlaces, kakaoTouristSpots, kakaoCultureVenues,
      tourAttractions, tourCulture, tourFestivals,
      seoulPopups, seoulParks, activityPlaces,
    } = pool;

    logger.info("recommend", "날씨 요약", {
      weather: weather.description, temp: `${weather.temp}°C`,
      feelsLike: `${weather.feelsLike}°C`, condition: getWeatherCondition(weather),
    });

    const primaryPopups = deduplicatePlaces([...seoulPopups, ...tourFestivals]);
    const rawPopups = preferPrimaryPlaces(primaryPopups, kakaoPopups, 10);
    const rawParks = deduplicatePlaces([...kakaoParks, ...tourAttractions, ...seoulParks, ...kakaoTouristSpots]);
    const curatedCulture = preferPrimaryPlaces(tourCulture, kakaoCultureVenues, 10);

    const taggedPopularPlaces = popularPlaces.map((place) => ({
      ...place,
      tags: mergeUniqueTags([POPULAR_CANDIDATE_TAG, ...place.tags]),
    }));

    const allPlaces: Place[] = deduplicatePlaces([
      ...taggedPopularPlaces, ...cafes, ...restaurants, ...shoppingPlaces, ...mallPlaces,
      ...rawPopups, ...rawParks, ...curatedCulture, ...photoBooths, ...bars,
      ...naturePlaces, ...cinemas, ...activityPlaces,
    ]);

    logger.info("recommend", "원천 수집 요약", {
      cafe: cafes.length, restaurant: restaurants.length,
      shopping: shoppingPlaces.length, mall: mallPlaces.length,
      popup: `${rawPopups.length}(공공${primaryPopups.length}/카카오${kakaoPopups.length})`,
      park: rawParks.length, exhibition: curatedCulture.length,
      photo: photoBooths.length, bar: bars.length,
      nature: naturePlaces.length, cinema: cinemas.length, activity: activityPlaces.length,
    });

    const nearbyFirst = [...allPlaces].sort((a, b) => a.walkingMinutes - b.walkingMinutes).slice(0, 40);
    const googleCandidates = [...new Map(
      [...nearbyFirst, ...taggedPopularPlaces].map((place) => [place.id, place] as const)
    ).values()];
    const enrichedCandidates = hasGoogleKey ? await enrichWithGoogleDetails(googleCandidates) : googleCandidates;
    const enrichedById = new Map(enrichedCandidates.map((p) => [p.id, p]));
    const enrichedPlaces = allPlaces.map((p) => enrichedById.get(p.id) ?? p);

    const restaurantSourcePool = enrichedPlaces
      .filter((p) => p.category === "restaurant")
      .sort((a, b) => {
        const pop = Number(b.tags.includes(POPULAR_CANDIDATE_TAG)) - Number(a.tags.includes(POPULAR_CANDIDATE_TAG));
        return pop !== 0 ? pop : a.walkingMinutes - b.walkingMinutes;
      })
      .slice(0, 15)
      .map((p) => `${p.name}${p.tags.includes(POPULAR_CANDIDATE_TAG) ? "(인기후보)" : ""}`);
    logger.list("recommend", `맛집 원천 후보 ${restaurantSourcePool.length}개`, restaurantSourcePool, 15);

    const guardrailedPlaces = applyCompanionGuardrails(enrichedPlaces, options);
    const candidatePlacesBase = selectCandidatePlaces(guardrailedPlaces);
    let candidatePlaces = await enrichWithGoogleAtmosphere(candidatePlacesBase, options);
    if (options.companion === "아이와 함께") {
      candidatePlaces = applyChildCategoryDefaults(candidatePlaces);
      const childLog = candidatePlaces.map((p) => {
        const gfc = p.goodForChildren;
        const icon = gfc === true ? "✅" : gfc === false ? "❌" : "❓";
        return `${icon} ${p.name}(${p.category}) goodForChildren=${gfc ?? "null"}`;
      });
      logger.list("recommend", `🧒 아이동반 후보 goodForChildren 현황 ${candidatePlaces.length}개`, childLog, 30);
    }
    logger.info("recommend", "후보 선정 요약", {
      categories: PLACE_CATEGORY_ORDER.map((cat) =>
        `${cat}${candidatePlaces.filter((p) => p.category === cat).length}`
      ).join(" "),
    });

    const ctx = {
      weather,
      condition: getWeatherCondition(weather, options.weatherAware),
      hourOfDay: hour,
      preferences: {
        selectedCategories: options.selectedCategories ?? [],
        environment: options.environment ?? "상관없음",
        durationBudgetMinutes: null,
        weatherAware: options.weatherAware ?? true,
        transport: options.transport,
        companion: options.companion ?? "상관없음",
        requireParking: options.requireParking ?? false,
        requireRestroom: options.requireRestroom ?? false,
        requireChildFacilities: options.requireChildFacilities ?? false,
      },
    };
    const scoredPlaces = candidatePlaces.map((p) => ({ ...p, score: scorePlace(p, ctx) }));

    const courses = buildCourses(scoredPlaces, weather, hour, options, forecast);

    const popularIds = new Set(taggedPopularPlaces.map((p) => p.id));
    const enrichedPopularPlaces = candidatePlaces.filter((p) => popularIds.has(p.id));
    if (enrichedPopularPlaces.length >= 2) {
      const scoredPopular = enrichedPopularPlaces.map((p) => ({ ...p, score: scorePlace(p, ctx) }));
      const popularCourse = buildCourses(scoredPopular, weather, hour, options, forecast);
      const best = popularCourse[0];
      if (best && !courses.some((c) => c.places.every((p, i) => p.id === best.places[i]?.id))) {
        courses.unshift({
          ...best,
          id: "course-popular",
          title: "🔥 주변 인기 장소 코스",
          tags: mergeUniqueTags([POPULAR_CANDIDATE_TAG, "인기", ...best.tags]),
          isPopular: true,
        });
      }
    }

    // ── Layer 2: AI 요약 캐시 ─────────────────────────────────────
    const condition = getWeatherCondition(weather, options.weatherAware);
    const slot = hour < 6 ? "dawn" : hour < 11 ? "morning" : hour < 14 ? "lunch" : hour < 17 ? "afternoon" : hour < 21 ? "evening" : "night";
    const aKey = aiKey(courses, slot, condition);
    const cachedAi = aiSummaryCache.get(aKey);

    let summaries: string[];
    if (cachedAi && Date.now() < cachedAi.expiresAt) {
      logger.info("recommend", "AI 요약 캐시 HIT");
      summaries = cachedAi.summaries;
    } else {
      summaries = await generateCourseSummaries(courses, weather, hour);
      aiSummaryCache.set(aKey, { summaries, expiresAt: Date.now() + AI_TTL_MS });
    }

    const coursesWithSummary = courses.map((c, i) => ({ ...c, aiReason: summaries[i] || undefined }));

    const topPlaces = [...scoredPlaces]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 18);
    const placeGroups = buildPlaceGroups(scoredPlaces);
    logQuotaUsageSnapshot("[quota][after]");

    // ── 종일 비 → 찜질방/웰니스 코스 추가 ───────────────────────
    const allDayRain = weather.isRainy && forecast.every((e) => e.isRainy);
    if (allDayRain && courses.length < 5) {
      const wellnessPlaces = hasKakaoKey
        ? await getNearByWellnessPlaces(coords)
        : getMockWellnessPlaces(coords);

      if (wellnessPlaces.length > 0) {
        courses.push({
          id: "course-wellness",
          title: "비 오는 날 실내 힐링 코스 추천!",
          durationMinutes: wellnessPlaces.reduce((acc, p) => acc + p.walkingMinutes + 90, 0),
          places: wellnessPlaces,
          tags: ["실내 전용", "우천 대안"],
          weatherHint: "종일 비 예보가 있어요. 따뜻하게 쉬다 오세요 ☔",
        });
      }
    }

    const isDawn = hour >= 0 && hour < 6;
    const confirmedOpenCount = scoredPlaces.filter((p) => p.isOpen === true).length;
    const emptyReason: string | null =
      isDawn && courses.length === 0 && confirmedOpenCount < 2
        ? "새벽이라 근처에서 운영 중인 곳이 없어요.\n24시간 공원이나 편의점을 찾아보세요."
        : null;

    const sample = courses[0]?.places.slice(0, 3).map((p) =>
      `${p.name}(rating:${p.googleRating ?? "없음"},open:${p.isOpen})`
    ).join(" / ");
    logger.info("recommend", "첫 코스 Google 데이터", { sample: sample ?? "없음" });

    res.json({
      region: seoul ? "seoul" : "nationwide",
      weather: {
        description: weather.description, temp: weather.temp,
        feelsLike: weather.feelsLike, isSunny: weather.isSunny, isRainy: weather.isRainy,
      },
      courses: coursesWithSummary,
      places: topPlaces,
      placeGroups,
      emptyReason,
      remainingToday: res.locals.rateLimitRemaining as number | null,
    });
  } catch (err) {
    logger.error("recommend", "추천 처리 오류", {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: "추천을 불러오지 못했어요" });
  }
});

export default router;
