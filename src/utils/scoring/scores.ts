import type { Place, WeatherInfo } from "../../types";
import type {
  WeatherCondition, TimeSlot, NormalizedOptions, ScoreContext, CompanionPreference,
} from "./types";
import { isIndoorCategory } from "./types";

export function getTimeSlot(hour: number): TimeSlot {
  if (hour >= 0 && hour < 6) return "dawn";
  if (hour >= 6 && hour < 11) return "morning";
  if (hour >= 11 && hour < 14) return "lunch";
  if (hour >= 14 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}

export function getWeatherCondition(weather: WeatherInfo, weatherAware = true): WeatherCondition {
  if (!weatherAware) return "쾌적";
  if (weather.isRainy) return "실내전용";
  const fl = weather.feelsLike;
  if (fl >= 33 || fl <= 5) return "실내전용";
  if (fl >= 28 || fl <= 12) return "실내선호";
  if (weather.isSunny && fl >= 18 && fl <= 27) return "야외최적";
  return "쾌적";
}

export function weatherScore(category: Place["category"], condition: WeatherCondition): number {
  const table: Record<WeatherCondition, Partial<Record<Place["category"], number>>> = {
    야외최적: { park: 32, cafe: 25, popup: 22, restaurant: 20, exhibition: 15, shopping: 18, mall: 12, nature: 35, bar: 10, photo: 18, cinema: 12, activity: 10 },
    쾌적:    { park: 24, cafe: 22, popup: 22, restaurant: 20, exhibition: 20, shopping: 20, mall: 18, nature: 26, bar: 16, photo: 20, cinema: 18, activity: 18 },
    실내선호: { cafe: 28, exhibition: 28, popup: 24, restaurant: 22, park: 5, shopping: 27, mall: 30, nature: 5, bar: 22, photo: 24, cinema: 28, activity: 28 },
    실내전용: { cafe: 30, exhibition: 30, popup: 25, restaurant: 24, park: 0, shopping: 28, mall: 32, nature: 0, bar: 24, photo: 26, cinema: 30, activity: 32 },
  };
  return table[condition][category] ?? 15;
}

function timeScore(category: Place["category"], slot: TimeSlot): number {
  const table: Record<Place["category"], Record<TimeSlot, number>> = {
    cafe:       { dawn: 8,  morning: 20, lunch: 12, afternoon: 20, evening: 12, night: 8  },
    restaurant: { dawn: 0,  morning: 10, lunch: 22, afternoon: 14, evening: 22, night: 16 },
    popup:      { dawn: 0,  morning: 20, lunch: 22, afternoon: 24, evening: 22, night: 10 },
    exhibition: { dawn: 0,  morning: 20, lunch: 22, afternoon: 24, evening: 20, night: 6  },
    park:       { dawn: 20, morning: 18, lunch: 14, afternoon: 20, evening: 16, night: 5  },
    shopping:   { dawn: 0,  morning: 10, lunch: 14, afternoon: 22, evening: 18, night: 10 },
    mall:       { dawn: 0,  morning: 12, lunch: 18, afternoon: 24, evening: 20, night: 12 },
    bar:        { dawn: 12, morning: 0,  lunch: 0,  afternoon: 5,  evening: 22, night: 30 },
    photo:      { dawn: 0,  morning: 14, lunch: 18, afternoon: 22, evening: 20, night: 14 },
    nature:     { dawn: 18, morning: 22, lunch: 16, afternoon: 18, evening: 14, night: 2  },
    cinema:     { dawn: 0,  morning: 10, lunch: 14, afternoon: 22, evening: 20, night: 18 },
    activity:   { dawn: 4,  morning: 8,  lunch: 12, afternoon: 18, evening: 26, night: 30 },
  };
  return table[category]?.[slot] ?? 10;
}

export function companionScore(
  category: Place["category"],
  companion: CompanionPreference,
  slot: TimeSlot,
): number {
  if (companion === "상관없음") return 0;

  const table: Record<Exclude<CompanionPreference, "상관없음">, Partial<Record<Place["category"], number>>> = {
    "아이와 함께": {
      restaurant: 10, cafe: 6, popup: 2, exhibition: 10, park: 12, shopping: -10, mall: 16,
      bar: -22, photo: 2, nature: 8, cinema: 12, activity: 14,
    },
    데이트: {
      restaurant: 8, cafe: 12, popup: 8, exhibition: 10, park: 8, shopping: 6, mall: 2,
      bar: 6, photo: 10, nature: 6, cinema: 12, activity: 3,
    },
    "친구들과": {
      restaurant: 8, cafe: 4, popup: 3, exhibition: 2, park: 6, shopping: 4, mall: 5,
      bar: 10, photo: 4, nature: 8, cinema: 8, activity: 14,
    },
    직장모임: {
      restaurant: 14, cafe: 8, popup: 2, exhibition: -2, park: -6, shopping: -10, mall: -6,
      bar: 12, photo: -6, nature: -8, cinema: -4, activity: 0,
    },
    가족과: {
      restaurant: 14, cafe: 8, popup: 4, exhibition: 8, park: 10, shopping: -8, mall: 14,
      bar: -18, photo: 2, nature: 8, cinema: 8, activity: 6,
    },
  };

  let score = table[companion][category] ?? 0;
  if (companion === "아이와 함께" && (slot === "night" || slot === "dawn")) {
    if (category === "bar") score -= 6;
    if (category === "park" || category === "nature") score -= 8;
  }
  if (companion === "직장모임" && (slot === "evening" || slot === "night")) {
    if (category === "restaurant" || category === "bar") score += 4;
  }
  if (companion === "데이트" && slot === "evening") {
    if (category === "park" || category === "bar" || category === "photo" || category === "cinema") score += 3;
  }
  return score;
}

function companionPlaceHeuristicScore(place: Place, companion: CompanionPreference, slot: TimeSlot): number {
  if (companion === "상관없음") return 0;
  let score = 0;
  const haystack = `${place.name} ${place.subCategory ?? ""} ${place.tags.join(" ")}`;

  if (companion === "데이트") {
    if (place.category === "cinema" && (slot === "afternoon" || slot === "evening" || slot === "night")) score += 8;
    if (place.category === "cafe" && place.googleRating && place.googleRating >= 4.3) score += 2;
  }

  if (companion === "직장모임") {
    if (place.category === "restaurant" || place.category === "bar" || place.category === "cafe") {
      score += 4;
      if ((place.googleReviewCount ?? 0) >= 300) score += 6;
      else if ((place.googleReviewCount ?? 0) >= 100) score += 3;
      if (place.walkingMinutes <= 10) score += 3;
    }
    if (place.goodForGroups) score += 12;
    if (["park", "nature", "photo", "mall"].includes(place.category)) score -= 6;
    if ((slot === "evening" || slot === "night") && (place.category === "restaurant" || place.category === "bar")) score += 4;
  }

  if (companion === "아이와 함께" || companion === "가족과") {
    if (place.category === "mall") score += 10;
    if (place.goodForChildren === true) score += 8;
    if (place.goodForChildren === false) score -= 20;
    if (place.menuForChildren === true) score += 4;
    if (place.restroom === true) score += 2;
    if (place.restroom === false) score -= 10;
    if (place.category === "activity" && /(홀덤|포커|오락실|방탈출|보드게임|보드카페|만화방|만화카페|VR|멀티방)/.test(haystack)) {
      score -= 40;
    }
    if (place.category === "bar") score -= 40;
  }

  return score;
}

function transportScore(place: Place, transport: NormalizedOptions["transport"]): number {
  if (transport !== "차량") return 0;
  if (place.hasParking) return 10;
  if (place.parkingSummary) return 6;
  return 0;
}

function preferenceScore(category: Place["category"], options: NormalizedOptions, slot: TimeSlot): number {
  let score = 0;
  if (options.selectedCategories.includes(category)) score += 16;
  if (options.environment === "실내") score += isIndoorCategory(category) ? 8 : -14;
  if (options.environment === "야외") score += category === "park" ? 12 : -4;
  score += companionScore(category, options.companion, slot);
  return score;
}

function ratingScore(place: Place): number {
  if (place.category !== "cafe" && place.category !== "restaurant") return 0;
  const { googleRating, googleReviewCount } = place;
  if (!googleRating || !googleReviewCount || googleReviewCount <= 0) return 0;

  const priorMean = 4.2;
  const priorWeight = 50;
  const weightedRating =
    (googleReviewCount / (googleReviewCount + priorWeight)) * googleRating +
    (priorWeight / (googleReviewCount + priorWeight)) * priorMean;

  const confidence = Math.min(1, Math.log10(googleReviewCount + 1) / 2);
  const baseScore = Math.max(-6, Math.min(18, (weightedRating - 3.8) * 12));
  let score = baseScore * confidence;

  if (googleReviewCount >= 500) score += 4;
  else if (googleReviewCount >= 100) score += 2;
  if (googleReviewCount < 5) score = Math.min(score, 2);

  return Math.round(score);
}

function popularityScore(place: Place): number {
  if (!place.tags.includes("주변 인기 후보") && !place.tags.includes("인기")) return 0;
  if (place.category === "cafe" || place.category === "restaurant") return 16;
  if (["shopping", "mall", "popup", "exhibition"].includes(place.category)) return 10;
  return 6;
}

function touristSpotScore(place: Place, ctx: ScoreContext): number {
  if (!place.tags.includes("명소")) return 0;
  const slot = getTimeSlot(ctx.hourOfDay);
  const outdoorSpot = place.category === "park" || place.category === "nature";
  const indoorSpot = place.category === "exhibition";

  if (ctx.condition === "실내전용") {
    if (outdoorSpot) return -12;
    if (indoorSpot) return 4;
    return 0;
  }
  if (slot === "night" || slot === "dawn") return outdoorSpot ? -8 : -4;
  if (outdoorSpot) return ctx.condition === "야외최적" ? 10 : 7;
  if (indoorSpot) return 6;
  return 3;
}

export function scorePlace(place: Place, ctx: ScoreContext): number {
  let score = 0;
  const slot = getTimeSlot(ctx.hourOfDay);
  score += Math.max(0, ((30 - place.walkingMinutes) / 30) * 40);
  score += weatherScore(place.category, ctx.condition);
  score += timeScore(place.category, slot);
  score += preferenceScore(place.category, ctx.preferences, slot);
  score += companionPlaceHeuristicScore(place, ctx.preferences.companion, slot);
  score += transportScore(place, ctx.preferences.transport);
  score += ratingScore(place);
  score += popularityScore(place);
  score += touristSpotScore(place, ctx);

  if (place.tags.some((tag) => tag.includes("마감") || tag.includes("남음"))) score += 10;
  if (place.isOpen === false) score -= 60;

  const isLateNight = ctx.hourOfDay >= 21 || (ctx.hourOfDay >= 0 && ctx.hourOfDay < 6);
  const isDawn = ctx.hourOfDay >= 0 && ctx.hourOfDay < 6;
  if (isLateNight && place.isOpen === null) score -= 35;
  if (isDawn && place.isOpen === true) score += 15;

  // 2차 필터: atmosphere 데이터가 있는 장소에만 작동 (undefined = 중립)
  const prefs = ctx.preferences;
  if (prefs.requireParking && place.hasParking === false) score -= 50;
  if (prefs.requireRestroom && place.restroom === false) score -= 35;
  if (prefs.requireChildFacilities) {
    if (place.goodForChildren === false && place.menuForChildren === false) score -= 40;
    else if (place.goodForChildren === false) score -= 20;
  }

  return Math.round(score);
}
