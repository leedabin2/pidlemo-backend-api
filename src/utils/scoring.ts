import type { Coordinates, Course, Place, WeatherInfo } from "../types";
import { getOpenStateAtOffset } from "./openHours";

type WeatherCondition = "실내전용" | "실내선호" | "쾌적" | "야외최적";
type TimeSlot = "morning" | "lunch" | "afternoon" | "evening" | "night";
type EnvironmentPreference = "실내" | "야외" | "상관없음";

interface CourseTemplate {
  categories: Place["category"][];
  title: string;
}

export interface RecommendationOptions {
  selectedCategories?: Place["category"][];
  environment?: EnvironmentPreference;
  duration?: string;
  weatherAware?: boolean;
}

interface NormalizedOptions {
  selectedCategories: Place["category"][];
  environment: EnvironmentPreference;
  durationBudgetMinutes: number | null;
  weatherAware: boolean;
}

interface ScoreContext {
  weather: WeatherInfo;
  condition: WeatherCondition;
  hourOfDay: number;
  preferences: NormalizedOptions;
}

const STAY_TIME: Record<Place["category"], number> = {
  cafe: 60,
  popup: 45,
  exhibition: 60,
  park: 50,
  restaurant: 65,
  shopping: 40,
};

const CATEGORY_LABEL: Record<Place["category"], string> = {
  cafe: "카페",
  popup: "팝업",
  exhibition: "전시",
  park: "공원 산책",
  restaurant: "맛집",
  shopping: "소품샵",
};

const CATEGORY_ORDER_BY_SLOT: Record<TimeSlot, Place["category"][]> = {
  morning: ["cafe", "park", "exhibition", "popup", "shopping", "restaurant"],
  lunch: ["restaurant", "cafe", "popup", "exhibition", "shopping", "park"],
  afternoon: ["shopping", "cafe", "popup", "exhibition", "park", "restaurant"],
  evening: ["restaurant", "shopping", "popup", "cafe", "park", "exhibition"],
  night: ["restaurant", "cafe", "shopping", "popup", "exhibition", "park"],
};

const BASE_TEMPLATES: Record<TimeSlot, CourseTemplate[]> = {
  morning: [
    { categories: ["cafe", "park", "exhibition"], title: "아침 산책 코스 추천!" },
    { categories: ["cafe", "exhibition", "popup"], title: "느긋한 문화 코스 추천!" },
    { categories: ["shopping", "cafe", "park"], title: "가볍게 둘러보는 오전 코스 추천!" },
    { categories: ["park", "cafe", "popup"], title: "가볍게 걷는 코스 추천!" },
    { categories: ["exhibition", "cafe", "park"], title: "조용한 오전 코스 추천!" },
    { categories: ["cafe", "popup"], title: "가볍게 시작하는 코스 추천!" },
  ],
  lunch: [
    { categories: ["restaurant", "cafe", "popup"], title: "점심 후 둘러보기 코스 추천!" },
    { categories: ["restaurant", "exhibition", "cafe"], title: "문화 충전 코스 추천!" },
    { categories: ["restaurant", "park", "cafe"], title: "식사 후 산책 코스 추천!" },
    { categories: ["shopping", "restaurant", "cafe"], title: "소품샵 구경 코스 추천!" },
    { categories: ["popup", "restaurant", "cafe"], title: "놀거리 많은 코스 추천!" },
    { categories: ["restaurant", "cafe"], title: "짧고 깔끔한 점심 코스 추천!" },
  ],
  afternoon: [
    { categories: ["shopping", "cafe", "park"], title: "소품샵 구경 코스 추천!" },
    { categories: ["cafe", "popup", "park"], title: "가볍게 돌아다니는 코스 추천!" },
    { categories: ["exhibition", "cafe", "popup"], title: "놀거리 많은 코스 추천!" },
    { categories: ["park", "cafe", "restaurant"], title: "햇살 좋은 힐링 코스 추천!" },
    { categories: ["popup", "cafe", "exhibition"], title: "트렌디한 오후 코스 추천!" },
    { categories: ["cafe", "exhibition"], title: "차분한 실내 코스 추천!" },
  ],
  evening: [
    { categories: ["cafe", "restaurant", "park"], title: "테라스 감성 코스 추천!" },
    { categories: ["restaurant", "park", "cafe"], title: "퇴근 후 힐링 코스 추천!" },
    { categories: ["shopping", "restaurant", "cafe"], title: "소품샵 구경 코스 추천!" },
    { categories: ["restaurant", "popup", "cafe"], title: "놀거리 많은 저녁 코스 추천!" },
    { categories: ["restaurant", "exhibition", "cafe"], title: "저녁 문화 코스 추천!" },
    { categories: ["popup", "restaurant", "cafe"], title: "데이트 느낌 코스 추천!" },
    { categories: ["restaurant", "cafe"], title: "퇴근 후 가볍게 코스 추천!" },
  ],
  night: [
    { categories: ["restaurant", "popup"], title: "밤까지 즐기는 코스 추천!" },
    { categories: ["restaurant", "cafe"], title: "늦은 시간 편한 코스 추천!" },
    { categories: ["shopping", "cafe"], title: "늦게까지 구경하는 코스 추천!" },
    { categories: ["cafe", "popup"], title: "가볍게 마무리 코스 추천!" },
    { categories: ["restaurant", "exhibition"], title: "야간 실내 코스 추천!" },
    { categories: ["popup", "cafe"], title: "트렌디한 야간 코스 추천!" },
  ],
};

const PARK_FALLBACKS: Place["category"][] = ["exhibition", "popup", "shopping", "cafe"];

function normalizeOptions(options?: RecommendationOptions): NormalizedOptions {
  const durationBudgetMinutes = (() => {
    switch (options?.duration) {
      case "1h":
        return 90;
      case "2h":
        return 150;
      case "3h":
        return 210;
      case "4h+":
      case "5h":
        return 300;
      default:
        return null;
    }
  })();

  return {
    selectedCategories: options?.selectedCategories ?? [],
    environment: options?.environment ?? "상관없음",
    durationBudgetMinutes,
    weatherAware: options?.weatherAware ?? true,
  };
}

function getDesiredStopCount(options: NormalizedOptions): number {
  if (!options.durationBudgetMinutes) return 3;
  if (options.durationBudgetMinutes <= 90) return 2;
  return 3;
}

function isIndoorCategory(category: Place["category"]): boolean {
  return category !== "park";
}

function calcTravelMinutes(from: Coordinates, to: Coordinates): number {
  const R = 6371000;
  const dLat = ((to.lat - from.lat) * Math.PI) / 180;
  const dLng = ((to.lng - from.lng) * Math.PI) / 180;
  const aa =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((from.lat * Math.PI) / 180) *
      Math.cos((to.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  const meters = R * 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
  return Math.max(1, Math.round(meters / 80));
}

function dedupeTemplates(templates: CourseTemplate[]): CourseTemplate[] {
  const seen = new Set<string>();
  return templates.filter((template) => {
    const key = template.categories.join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getTimeSlot(hour: number): TimeSlot {
  if (hour >= 7 && hour < 11) return "morning";
  if (hour >= 11 && hour < 14) return "lunch";
  if (hour >= 14 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}

export function getWeatherCondition(
  weather: WeatherInfo,
  weatherAware = true
): WeatherCondition {
  if (!weatherAware) return "쾌적";
  if (weather.isRainy) return "실내전용";
  const fl = weather.feelsLike;
  if (fl >= 33 || fl <= 5) return "실내전용";
  if (fl >= 28 || fl <= 12) return "실내선호";
  if (weather.isSunny && fl >= 18 && fl <= 27) return "야외최적";
  return "쾌적";
}

function buildFocusTemplates(
  slot: TimeSlot,
  options: NormalizedOptions
): CourseTemplate[] {
  return options.selectedCategories.map((category) => {
    const ordered = [
      category,
      ...CATEGORY_ORDER_BY_SLOT[slot].filter((item) => item !== category),
    ];
    return {
      categories: ordered.slice(0, getDesiredStopCount(options)),
      title: `${CATEGORY_LABEL[category]} 중심 코스 추천!`,
    };
  });
}

function buildConditionTemplates(
  slot: TimeSlot,
  condition: WeatherCondition
): CourseTemplate[] {
  if (condition === "야외최적") {
    if (slot === "evening") {
      return [
        { categories: ["cafe", "restaurant", "park"], title: "테라스 감성 코스 추천!" },
        { categories: ["shopping", "restaurant", "cafe"], title: "소품샵 구경 코스 추천!" },
        { categories: ["restaurant", "park", "cafe"], title: "퇴근 후 힐링 코스 추천!" },
      ];
    }

    if (slot === "afternoon") {
      return [
        { categories: ["shopping", "cafe", "park"], title: "햇살 좋은 산책 코스 추천!" },
        { categories: ["popup", "cafe", "park"], title: "놀거리 많은 코스 추천!" },
      ];
    }
  }

  if (condition === "실내전용" || condition === "실내선호") {
    if (slot === "evening") {
      return [
        { categories: ["shopping", "restaurant", "cafe"], title: "비 오는 날 실내 코스 추천!" },
        { categories: ["restaurant", "exhibition", "cafe"], title: "저녁 문화 코스 추천!" },
      ];
    }

    return [
      { categories: ["exhibition", "cafe", "shopping"], title: "실내에서 쉬기 좋은 코스 추천!" },
      { categories: ["shopping", "cafe", "popup"], title: "실내 구경 코스 추천!" },
    ];
  }

  return [];
}

function swapParkForIndoor(template: Place["category"][]): Place["category"][] {
  const used = new Set<Place["category"]>();
  return template.map((category) => {
    if (category !== "park") {
      used.add(category);
      return category;
    }

    const fallback = PARK_FALLBACKS.find((item) => !used.has(item));
    const replacement = fallback ?? "cafe";
    used.add(replacement);
    return replacement;
  });
}

function applyPreferencesToTemplate(
  template: CourseTemplate,
  condition: WeatherCondition,
  options: NormalizedOptions
): CourseTemplate {
  let adjusted = [...template.categories];

  if (
    condition === "실내전용" ||
    condition === "실내선호" ||
    options.environment === "실내"
  ) {
    adjusted = swapParkForIndoor(adjusted);
  }

  if (options.environment === "야외" && condition !== "실내전용") {
    if (!adjusted.includes("park")) {
      adjusted[adjusted.length - 1] = "park";
    }
  }

  for (const category of options.selectedCategories) {
    if (adjusted.includes(category)) continue;
    adjusted = [category, ...adjusted.filter((item) => item !== category)];
  }

  const deduped: Place["category"][] = [];
  for (const category of adjusted) {
    if (!deduped.includes(category)) deduped.push(category);
  }

  let title = template.title;
  if ((condition === "실내전용" || condition === "실내선호") && title.includes("힐링")) {
    title = "비 오는 날 실내 코스 추천!";
  }
  if ((condition === "실내전용" || condition === "실내선호") && title.includes("햇살")) {
    title = "실내에서 쉬기 좋은 코스 추천!";
  }

  return {
    ...template,
    title,
    categories: deduped.slice(0, getDesiredStopCount(options)),
  };
}

function weatherScore(category: Place["category"], condition: WeatherCondition): number {
  const table: Record<WeatherCondition, Partial<Record<Place["category"], number>>> = {
    야외최적: { park: 32, cafe: 25, popup: 22, restaurant: 20, exhibition: 15, shopping: 18 },
    쾌적: { park: 24, cafe: 22, popup: 22, restaurant: 20, exhibition: 20, shopping: 20 },
    실내선호: { cafe: 28, exhibition: 28, popup: 24, restaurant: 22, park: 5, shopping: 27 },
    실내전용: { cafe: 30, exhibition: 30, popup: 25, restaurant: 24, park: 0, shopping: 28 },
  };
  return table[condition][category] ?? 15;
}

function timeScore(category: Place["category"], slot: TimeSlot): number {
  const table: Record<Place["category"], Record<TimeSlot, number>> = {
    cafe: { morning: 20, lunch: 12, afternoon: 20, evening: 12, night: 8 },
    restaurant: { morning: 5, lunch: 20, afternoon: 12, evening: 20, night: 16 },
    popup: { morning: 10, lunch: 15, afternoon: 20, evening: 18, night: 12 },
    exhibition: { morning: 12, lunch: 14, afternoon: 20, evening: 16, night: 8 },
    park: { morning: 18, lunch: 14, afternoon: 20, evening: 16, night: 5 },
    shopping: { morning: 10, lunch: 14, afternoon: 22, evening: 18, night: 10 },
  };
  return table[category][slot];
}

function preferenceScore(category: Place["category"], options: NormalizedOptions): number {
  let score = 0;

  if (options.selectedCategories.includes(category)) {
    score += 16;
  }

  if (options.environment === "실내") {
    score += isIndoorCategory(category) ? 8 : -14;
  }

  if (options.environment === "야외") {
    score += category === "park" ? 12 : -4;
  }

  return score;
}

export function scorePlace(place: Place, ctx: ScoreContext): number {
  let score = 0;
  score += Math.max(0, ((30 - place.walkingMinutes) / 30) * 40);
  score += weatherScore(place.category, ctx.condition);
  score += timeScore(place.category, getTimeSlot(ctx.hourOfDay));
  score += preferenceScore(place.category, ctx.preferences);

  if (place.tags.some((tag) => tag.includes("마감") || tag.includes("남음"))) {
    score += 10;
  }

  if (place.isOpen === false) {
    score -= 10;
  }

  return Math.round(score);
}

function routeCandidateScore(
  candidate: Place,
  lastPlace: Place | null,
  elapsedMinutes: number
): number {
  const travelMinutes = lastPlace
    ? calcTravelMinutes(lastPlace.coordinates, candidate.coordinates)
    : candidate.walkingMinutes;
  const arrivalOffset = elapsedMinutes + travelMinutes;
  const openAtArrival = getOpenStateAtOffset(candidate.operatingHours, arrivalOffset);

  let score = candidate.score ?? 0;
  score -= Math.min(travelMinutes, 35) * 0.9;

  if (openAtArrival === true) score += 10;
  if (openAtArrival === false) score -= 40;
  if (lastPlace && lastPlace.category === candidate.category) score -= 6;

  return score;
}

function buildCourseFromTemplate(
  sorted: Place[],
  template: Place["category"][],
  excludedIds: Set<string>
): Place[] {
  const result: Place[] = [];
  const usedIds = new Set<string>();
  let elapsedMinutes = 0;
  let lastPlace: Place | null = null;

  for (const category of template) {
    const filterCandidates = (ignoreExcluded: boolean) =>
      sorted
      .filter((place) =>
        place.category === category &&
        !usedIds.has(place.id) &&
        (ignoreExcluded || !excludedIds.has(place.id))
      )
      .sort((a, b) => routeCandidateScore(b, lastPlace, elapsedMinutes) - routeCandidateScore(a, lastPlace, elapsedMinutes));

    const candidates = filterCandidates(false);
    const pool = candidates.length > 0 ? candidates : filterCandidates(true);

    const picked = pool.find((candidate) => {
      const travelMinutes = lastPlace
        ? calcTravelMinutes(lastPlace.coordinates, candidate.coordinates)
        : candidate.walkingMinutes;
      const arrivalOffset = elapsedMinutes + travelMinutes;
      return getOpenStateAtOffset(candidate.operatingHours, arrivalOffset) !== false;
    }) ?? pool[0];

    if (!picked) continue;

    const travelMinutes = lastPlace
      ? calcTravelMinutes(lastPlace.coordinates, picked.coordinates)
      : picked.walkingMinutes;

    result.push(picked);
    usedIds.add(picked.id);
    elapsedMinutes += travelMinutes + STAY_TIME[picked.category];
    lastPlace = picked;
  }

  return result;
}

function calcDuration(places: Place[]): number {
  if (places.length === 0) return 0;

  let duration = places[0].walkingMinutes + STAY_TIME[places[0].category];
  for (let i = 1; i < places.length; i += 1) {
    duration += calcTravelMinutes(places[i - 1].coordinates, places[i].coordinates);
    duration += STAY_TIME[places[i].category];
  }
  return duration;
}

function limitCourseByDuration(
  places: Place[],
  options: NormalizedOptions
): Place[] {
  if (!options.durationBudgetMinutes) return places;

  const trimmed = [...places];
  while (trimmed.length > 2 && calcDuration(trimmed) > options.durationBudgetMinutes + 20) {
    trimmed.pop();
  }
  return trimmed;
}

function buildFallbackTitle(places: Place[], options: NormalizedOptions): string {
  const titles = places.map((place) => CATEGORY_LABEL[place.category]);
  if (options.selectedCategories.length === 1) {
    return `${CATEGORY_LABEL[options.selectedCategories[0]]} 중심 코스 추천!`;
  }
  if (titles.includes("공원 산책") && titles.includes("카페")) {
    return "힐링 코스 추천!";
  }
  if (titles.includes("전시") || titles.includes("팝업")) {
    return "놀거리 많은 코스 추천!";
  }
  return "지금 어울리는 코스 추천!";
}

function makeUniqueTitle(
  title: string,
  places: Place[],
  existingTitles: Set<string>
): string {
  if (!existingTitles.has(title)) return title;

  const qualifiers = [
    places[0] ? `${CATEGORY_LABEL[places[0].category]}부터` : undefined,
    places[1] ? `${CATEGORY_LABEL[places[1].category]} 포함` : undefined,
    "가볍게",
    "지금 딱",
  ].filter((value): value is string => Boolean(value));

  for (const qualifier of qualifiers) {
    const nextTitle = `${title.replace(/ 추천!$/, "")} · ${qualifier}`;
    if (!existingTitles.has(nextTitle)) return nextTitle;
  }

  let index = 2;
  let fallback = `${title.replace(/ 추천!$/, "")} ${index}`;
  while (existingTitles.has(fallback)) {
    index += 1;
    fallback = `${title.replace(/ 추천!$/, "")} ${index}`;
  }
  return fallback;
}

function buildTags(
  condition: WeatherCondition,
  slot: TimeSlot,
  places: Place[],
  options: NormalizedOptions
): string[] {
  const tags: string[] = [];
  const conditionTag: Record<WeatherCondition, string> = {
    야외최적: "맑음 최적",
    쾌적: "쾌적한 날씨",
    실내선호: "실내 위주",
    실내전용: "실내 전용",
  };
  const slotTag: Record<TimeSlot, string> = {
    morning: "오전 추천",
    lunch: "점심 추천",
    afternoon: "오후 추천",
    evening: "저녁 추천",
    night: "야간 추천",
  };

  tags.push(conditionTag[condition], slotTag[slot]);

  if (options.selectedCategories.length === 1) {
    tags.push(`${CATEGORY_LABEL[options.selectedCategories[0]]} 중심`);
  }

  if (places.some((place) => place.tags.includes("오늘 마감"))) {
    tags.push("오늘 마감");
  }

  return tags;
}

function hasSamePlaces(a: Place[], b: Place[]): boolean {
  if (a.length !== b.length) return false;
  const ids = new Set(a.map((place) => place.id));
  return b.every((place) => ids.has(place.id));
}

function pickDiversePlaces(places: Place[], count: number): Place[] {
  const result: Place[] = [];
  const seenCategories = new Set<string>();

  for (const place of places) {
    if (result.length >= count) break;
    if (seenCategories.has(place.category)) continue;
    result.push(place);
    seenCategories.add(place.category);
  }

  return result;
}

export function buildCourses(
  scoredPlaces: Place[],
  weather: WeatherInfo,
  hour: number = new Date().getHours(),
  options?: RecommendationOptions
): Course[] {
  const normalized = normalizeOptions(options);
  const condition = getWeatherCondition(weather, normalized.weatherAware);
  const slot = getTimeSlot(hour);
  const sorted = [...scoredPlaces].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const templates = dedupeTemplates([
    ...buildConditionTemplates(slot, condition),
    ...buildFocusTemplates(slot, normalized),
    ...BASE_TEMPLATES[slot],
  ]);
  const courses: Course[] = [];
  const usedPlaceIdsAcrossCourses = new Set<string>();
  const existingTitles = new Set<string>();

  for (const rawTemplate of templates) {
    const template = applyPreferencesToTemplate(rawTemplate, condition, normalized);
    const places = limitCourseByDuration(
      buildCourseFromTemplate(sorted, template.categories, usedPlaceIdsAcrossCourses),
      normalized
    );
    if (places.length < 2) continue;
    if (courses.some((course) => hasSamePlaces(course.places, places))) continue;

    const title = makeUniqueTitle(template.title, places, existingTitles);

    courses.push({
      id: `course-${courses.length + 1}`,
      title,
      durationMinutes: calcDuration(places),
      places,
      tags: buildTags(condition, slot, places, normalized),
    });

    existingTitles.add(title);
    for (const place of places) usedPlaceIdsAcrossCourses.add(place.id);

    if (courses.length >= 5) break;
  }

  const fallbackCount = getDesiredStopCount(normalized);
  while (courses.length < 3) {
    const usedIds = new Set(courses.flatMap((course) => course.places.map((place) => place.id)));
    const fallbackPlaces = pickDiversePlaces(
      sorted.filter((place) => !usedIds.has(place.id)),
      fallbackCount
    );
    if (fallbackPlaces.length < 2) break;

    const title = makeUniqueTitle(
      buildFallbackTitle(fallbackPlaces, normalized),
      fallbackPlaces,
      existingTitles
    );

    courses.push({
      id: `course-${courses.length + 1}`,
      title,
      durationMinutes: calcDuration(fallbackPlaces),
      places: fallbackPlaces,
      tags: buildTags(condition, slot, fallbackPlaces, normalized),
    });
    existingTitles.add(title);
  }

  return courses;
}
