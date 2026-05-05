import type { Place, Course, WeatherInfo, ForecastEntry } from "../../types";
import type { WeatherCondition, NormalizedOptions, ScoreContext } from "./types";
import { STAY_TIME, CATEGORY_LABEL } from "./types";
import {
  normalizeOptions, getDesiredStopCount, dedupeTemplates,
  buildFeaturedTemplates, buildCompanionTemplates, BASE_TEMPLATES,
  buildConditionTemplates, buildFocusTemplates, applyPreferencesToTemplate,
} from "./templates";
import { getTimeSlot, getWeatherCondition, weatherScore } from "./scores";
import { isOpenAtOffset as isGoogleOpenAtOffset } from "../../services/googlePlaces";
import { getOpenStateAtOffset } from "../openHours";
import type { RecommendationOptions } from "./types";

function calcTravelMinutes(from: Place["coordinates"], to: Place["coordinates"]): number {
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

function conditionFromForecast(entry: ForecastEntry): WeatherCondition {
  if (entry.isRainy) return "실내전용";
  const fl = entry.feelsLike;
  if (fl >= 33 || fl <= 5) return "실내전용";
  if (fl >= 28 || fl <= 12) return "실내선호";
  if (entry.isSunny && fl >= 18 && fl <= 27) return "야외최적";
  return "쾌적";
}

function getConditionAtOffset(
  base: WeatherCondition,
  elapsedMinutes: number,
  forecast: ForecastEntry[] | undefined,
): WeatherCondition {
  if (!forecast?.length) return base;
  const offsetHours = elapsedMinutes / 60;
  const entry = forecast.reduce((prev, curr) =>
    Math.abs(curr.offsetHours - offsetHours) < Math.abs(prev.offsetHours - offsetHours) ? curr : prev
  );
  if (Math.abs(entry.offsetHours - offsetHours) > 4) return base;
  return conditionFromForecast(entry);
}

function routeCandidateScore(
  candidate: Place,
  lastPlace: Place | null,
  elapsedMinutes: number,
  baseCondition: WeatherCondition,
  forecast: ForecastEntry[] | undefined,
): number {
  const travelMinutes = lastPlace
    ? calcTravelMinutes(lastPlace.coordinates, candidate.coordinates)
    : candidate.walkingMinutes;
  const arrivalOffset = elapsedMinutes + travelMinutes;
  const openAtArrival = candidate.googleHours
    ? isGoogleOpenAtOffset(candidate.googleHours, arrivalOffset)
    : getOpenStateAtOffset(candidate.operatingHours, arrivalOffset);

  let score = candidate.score ?? 0;
  score -= Math.min(travelMinutes, 35) * 0.9;

  if (openAtArrival === true) score += 10;
  if (openAtArrival === false) score -= 80;
  if (openAtArrival === null) {
    const hour = new Date().getHours();
    if (hour >= 21 || hour < 9) score -= 25;
  }
  if (lastPlace && lastPlace.category === candidate.category) score -= 6;

  const conditionAtArrival = getConditionAtOffset(baseCondition, arrivalOffset, forecast);
  if (conditionAtArrival !== baseCondition) {
    score += weatherScore(candidate.category, conditionAtArrival) - weatherScore(candidate.category, baseCondition);
  }

  return score;
}

function buildCourseFromTemplate(
  sorted: Place[],
  template: Place["category"][],
  excludedIds: Set<string>,
  baseCondition: WeatherCondition,
  forecast: ForecastEntry[] | undefined,
): Place[] {
  const result: Place[] = [];
  const usedIds = new Set<string>();
  let elapsedMinutes = 0;
  let lastPlace: Place | null = null;

  for (const category of template) {
    const scoreCandidate = (p: Place) =>
      routeCandidateScore(p, lastPlace, elapsedMinutes, baseCondition, forecast);

    const filterCandidates = (ignoreExcluded: boolean) =>
      sorted
        .filter((place) =>
          place.category === category &&
          !usedIds.has(place.id) &&
          place.isOpen !== false &&
          (ignoreExcluded || !excludedIds.has(place.id))
        )
        .sort((a, b) => scoreCandidate(b) - scoreCandidate(a));

    const candidates = filterCandidates(false);
    const pool = candidates.length > 0 ? candidates : filterCandidates(true);

    const picked = pool.find((candidate) => {
      const travelMinutes = lastPlace
        ? calcTravelMinutes(lastPlace.coordinates, candidate.coordinates)
        : candidate.walkingMinutes;
      const arrivalOffset = elapsedMinutes + travelMinutes;
      const openAtArrival = candidate.googleHours
        ? isGoogleOpenAtOffset(candidate.googleHours, arrivalOffset)
        : getOpenStateAtOffset(candidate.operatingHours, arrivalOffset);
      return openAtArrival !== false;
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

export function calcDuration(places: Place[]): number {
  if (places.length === 0) return 0;
  let duration = places[0].walkingMinutes + STAY_TIME[places[0].category];
  for (let i = 1; i < places.length; i += 1) {
    duration += calcTravelMinutes(places[i - 1].coordinates, places[i].coordinates);
    duration += STAY_TIME[places[i].category];
  }
  return duration;
}

function limitCourseByDuration(places: Place[], options: NormalizedOptions): Place[] {
  if (!options.durationBudgetMinutes) return places;
  const trimmed = [...places];
  while (trimmed.length > 2 && calcDuration(trimmed) > options.durationBudgetMinutes + 20) {
    trimmed.pop();
  }
  return trimmed;
}

function buildFallbackTitle(places: Place[], options: NormalizedOptions): string {
  const titles = places.map((place) => CATEGORY_LABEL[place.category]);
  if (options.selectedCategories.length === 1) return `${CATEGORY_LABEL[options.selectedCategories[0]]} 중심 코스 추천!`;
  if (titles.includes("공원 산책") && titles.includes("카페")) return "힐링 코스 추천!";
  if (titles.includes("전시") || titles.includes("팝업")) return "놀거리 많은 코스 추천!";
  return "지금 어울리는 코스 추천!";
}

function inferIntentFromPlaces(places: Place[]): string {
  const categories = places.map((p) => p.category);
  if (categories.includes("park") || categories.includes("nature")) return "walk";
  if (categories.includes("activity")) return "activity";
  if (categories.includes("mall")) return "mall";
  if (categories.includes("shopping")) return "shopping";
  if (categories.includes("exhibition") || categories.includes("popup")) return "culture";
  if (categories.includes("bar")) return "nightlife";
  if (categories.includes("cinema")) return "cinema";
  if (categories.includes("photo")) return "photo";
  if (places.length <= 2) return "short";
  return "general";
}

function makeUniqueTitle(title: string, places: Place[], existingTitles: Set<string>): string {
  if (!existingTitles.has(title)) return title;

  const qualifiers = [
    places[0] ? `${CATEGORY_LABEL[places[0].category]}부터` : undefined,
    places[1] ? `${CATEGORY_LABEL[places[1].category]} 포함` : undefined,
    "가볍게",
    "지금 딱",
  ].filter((v): v is string => Boolean(v));

  for (const qualifier of qualifiers) {
    const next = `${title.replace(/ 추천!$/, "")} · ${qualifier}`;
    if (!existingTitles.has(next)) return next;
  }

  let index = 2;
  let fallback = `${title.replace(/ 추천!$/, "")} ${index}`;
  while (existingTitles.has(fallback)) { index += 1; fallback = `${title.replace(/ 추천!$/, "")} ${index}`; }
  return fallback;
}

function buildTags(
  condition: WeatherCondition,
  slot: ReturnType<typeof getTimeSlot>,
  places: Place[],
  options: NormalizedOptions,
): string[] {
  const conditionTag: Record<WeatherCondition, string> = {
    야외최적: "맑음 최적", 쾌적: "쾌적한 날씨", 실내선호: "실내 위주", 실내전용: "실내 전용",
  };
  const slotTag: Record<ReturnType<typeof getTimeSlot>, string> = {
    dawn: "새벽 추천", morning: "오전 추천", lunch: "점심 추천",
    afternoon: "오후 추천", evening: "저녁 추천", night: "야간 추천",
  };

  const tags = [conditionTag[condition], slotTag[slot]];
  if (options.selectedCategories.length === 1) tags.push(`${CATEGORY_LABEL[options.selectedCategories[0]]} 중심`);
  if (options.companion !== "상관없음") tags.push(options.companion);
  if (places.some((p) => p.tags.includes("오늘 마감"))) tags.push("오늘 마감");
  return tags;
}

function hasSamePlaces(a: Place[], b: Place[]): boolean {
  if (a.length !== b.length) return false;
  const ids = new Set(a.map((p) => p.id));
  return b.every((p) => ids.has(p.id));
}

function isFallbackAllowed(place: Place, options: NormalizedOptions, slot: ReturnType<typeof getTimeSlot>): boolean {
  if (options.companion === "아이와 함께") {
    if (place.category === "bar" || place.category === "shopping") return false;
    if ((slot === "night" || slot === "dawn") && (place.category === "park" || place.category === "nature")) return false;
  }
  if (options.companion === "가족과") {
    if (place.category === "bar" || place.category === "shopping") return false;
    if (slot === "night" && (place.category === "park" || place.category === "nature")) return false;
  }
  if (options.companion === "직장모임") {
    if (place.category === "shopping") return false;
  }
  return true;
}

function pickDiversePlaces(
  places: Place[],
  count: number,
  options: NormalizedOptions,
  slot: ReturnType<typeof getTimeSlot>,
): Place[] {
  const result: Place[] = [];
  const seenCategories = new Set<string>();
  for (const place of places) {
    if (result.length >= count) break;
    if (!isFallbackAllowed(place, options, slot)) continue;
    if (seenCategories.has(place.category)) continue;
    result.push(place);
    seenCategories.add(place.category);
  }
  return result;
}

function generateWeatherHint(
  places: Place[],
  weather: WeatherInfo,
  hourOfDay: number,
  forecast: ForecastEntry[] | undefined,
): string | undefined {
  if (!forecast?.length) return undefined;
  const hasOutdoor = places.some((p) => p.category === "park");
  const allRainy = weather.isRainy && forecast.every((e) => e.isRainy);

  if (allRainy) {
    return hasOutdoor
      ? "종일 비 예보가 있어요. 공원 방문은 어려울 수 있어요 ☔"
      : "종일 비 예보가 있어요. 실내 코스를 추천드려요 ☔";
  }

  if (weather.isRainy) {
    const clearEntry = forecast.find((e) => !e.isRainy);
    if (clearEntry) {
      const timeLabel = `${(hourOfDay + clearEntry.offsetHours) % 24}시`;
      return hasOutdoor
        ? `${timeLabel}쯤 비가 그칠 예정이에요. 공원 동선에 참고하세요 ☀️`
        : `${timeLabel}쯤 비가 그칠 예정이에요 ☀️`;
    }
    return undefined;
  }

  if (!weather.isRainy && hasOutdoor) {
    const rainEntry = forecast.find((e) => e.isRainy);
    if (rainEntry && rainEntry.offsetHours <= 3) {
      const targetHour = (hourOfDay + rainEntry.offsetHours) % 24;
      return `${targetHour}시쯤 비가 올 수 있어요. 공원은 서둘러 방문하세요 ☔`;
    }
  }

  return undefined;
}

export function buildCourses(
  scoredPlaces: Place[],
  weather: WeatherInfo,
  hour: number = new Date().getHours(),
  options?: RecommendationOptions,
  forecast?: ForecastEntry[],
): Course[] {
  const normalized = normalizeOptions(options);
  const condition = getWeatherCondition(weather, normalized.weatherAware);
  const slot = getTimeSlot(hour);
  const sorted = [...scoredPlaces].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const primaryTemplates = normalized.companion === "상관없음"
    ? [
      ...buildFeaturedTemplates(slot, condition),
      ...buildCompanionTemplates(slot, normalized, condition),
    ]
    : [
      ...buildCompanionTemplates(slot, normalized, condition),
      ...buildFeaturedTemplates(slot, condition),
    ];
  const templates = dedupeTemplates([
    ...primaryTemplates,
    ...BASE_TEMPLATES[slot],
    ...buildConditionTemplates(slot, condition),
    ...buildFocusTemplates(slot, normalized),
  ]);

  const courses: Course[] = [];
  const usedPlaceIdsAcrossCourses = new Set<string>();
  const existingTitles = new Set<string>();
  const usedIntents = new Set<string>();

  for (const rawTemplate of templates) {
    const template = applyPreferencesToTemplate(rawTemplate, condition, normalized);
    if (!template.featured && usedIntents.has(template.intent)) continue;

    const places = limitCourseByDuration(
      buildCourseFromTemplate(sorted, template.categories, usedPlaceIdsAcrossCourses, condition, forecast),
      normalized,
    );
    if (places.length < 2) continue;
    if (courses.some((c) => hasSamePlaces(c.places, places))) continue;

    const resolvedIntent = template.featured ? "featured" : template.intent || inferIntentFromPlaces(places);
    if (!template.featured && usedIntents.has(resolvedIntent)) continue;

    const title = makeUniqueTitle(template.title, places, existingTitles);
    courses.push({
      id: `course-${courses.length + 1}`,
      title,
      durationMinutes: calcDuration(places),
      places,
      tags: buildTags(condition, slot, places, normalized),
      weatherHint: generateWeatherHint(places, weather, hour, forecast),
    });

    existingTitles.add(title);
    usedIntents.add(resolvedIntent);
    for (const blocked of template.blocksIntents ?? []) usedIntents.add(blocked);
    for (const place of places) usedPlaceIdsAcrossCourses.add(place.id);
    if (courses.length >= 5) break;
  }

  const fallbackCount = getDesiredStopCount(normalized);
  const minCourses = slot === "dawn" ? 0 : 3;
  while (courses.length < minCourses) {
    const usedIds = new Set(courses.flatMap((c) => c.places.map((p) => p.id)));
    const fallbackPlaces = pickDiversePlaces(
      sorted.filter((p) => !usedIds.has(p.id) && p.isOpen !== false),
      fallbackCount,
      normalized,
      slot,
    );
    if (fallbackPlaces.length < 2) break;

    const fallbackIntent = inferIntentFromPlaces(fallbackPlaces);
    if (usedIntents.has(fallbackIntent) && courses.length > 0) break;

    const title = makeUniqueTitle(buildFallbackTitle(fallbackPlaces, normalized), fallbackPlaces, existingTitles);
    courses.push({
      id: `course-${courses.length + 1}`,
      title,
      durationMinutes: calcDuration(fallbackPlaces),
      places: fallbackPlaces,
      tags: buildTags(condition, slot, fallbackPlaces, normalized),
      weatherHint: generateWeatherHint(fallbackPlaces, weather, hour, forecast),
    });
    existingTitles.add(title);
    usedIntents.add(fallbackIntent);
  }

  return courses;
}
