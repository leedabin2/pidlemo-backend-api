import type { Place } from "../types";
import { PLACE_CATEGORY_ORDER, CATEGORY_CANDIDATE_LIMIT } from "../constants/categories";
import { logger } from "../utils/logger";

export const POPULAR_CANDIDATE_TAG = "주변 인기 후보";

export function hasGoogleCandidateSignal(place: Place): boolean {
  return (
    place.googleReviewCount !== undefined ||
    place.googleRating !== undefined ||
    place.googleHours !== undefined ||
    place.priceLevel !== undefined ||
    place.photoUrl !== undefined
  );
}

export function getWeightedGoogleRating(place: Place): number | null {
  if (place.googleRating === undefined || place.googleReviewCount === undefined || place.googleReviewCount <= 0) {
    return null;
  }
  const priorMean = 4.2;
  const priorWeight = 50;
  return (
    (place.googleReviewCount / (place.googleReviewCount + priorWeight)) * place.googleRating +
    (priorWeight / (place.googleReviewCount + priorWeight)) * priorMean
  );
}

export function candidateStageScore(place: Place): number {
  let score = 0;
  const reviewCount = place.googleReviewCount ?? 0;
  const weightedRating = getWeightedGoogleRating(place);

  if (place.category === "cafe" || place.category === "restaurant") {
    score += Math.min(55, Math.round(Math.log10(reviewCount + 1) * 18));
    score += weightedRating ? Math.max(0, Math.round((weightedRating - 3.8) * 24)) : 0;
    if (hasGoogleCandidateSignal(place)) score += 6;
  } else if (hasGoogleCandidateSignal(place)) {
    score += 6;
  }

  if (place.tags.includes(POPULAR_CANDIDATE_TAG) || place.tags.includes("인기")) {
    score += place.category === "cafe" || place.category === "restaurant" ? 14 : 9;
  }

  if (place.tags.includes("명소")) score += 6;
  if (place.tags.includes("도착 시 마감")) score -= 18;
  if (place.tags.includes("곧 마감") || place.tags.includes("브레이크타임")) score -= 8;

  if (place.isOpen === true) score += 8;
  if (place.isOpen === false) score -= 30;
  if (place.isOpen === null) score -= 4;

  if (place.walkingMinutes <= 10) score += 6;
  else if (place.walkingMinutes <= 20) score += 4;
  else if (place.walkingMinutes <= 30) score += 2;

  return score;
}

export function selectCandidatePlaces(places: Place[]): Place[] {
  const result: Place[] = [];

  for (const category of PLACE_CATEGORY_ORDER) {
    const categoryPlaces = places.filter((place) => place.category === category);
    const limit = CATEGORY_CANDIDATE_LIMIT[category];
    const sorter = (a: Place, b: Place) => {
      const scoreDiff = candidateStageScore(b) - candidateStageScore(a);
      if (scoreDiff !== 0) return scoreDiff;
      return a.walkingMinutes - b.walkingMinutes;
    };

    const matched = categoryPlaces.filter(hasGoogleCandidateSignal).sort(sorter);
    const unmatched = categoryPlaces.filter((place) => !hasGoogleCandidateSignal(place)).sort(sorter);

    const selected = [...matched.slice(0, limit)];
    if (selected.length < limit) {
      selected.push(...unmatched.slice(0, limit - selected.length));
    }

    if (category === "restaurant") {
      const debugPool = [...matched, ...unmatched].sort(sorter).slice(0, 15);
      const fmt = (place: Place, i: number) => {
        const wr = getWeightedGoogleRating(place);
        return `${i + 1}.${place.name}(점수 ${candidateStageScore(place)} / 리뷰 ${place.googleReviewCount ?? "-"} / 보정 ${wr ? wr.toFixed(2) : "-"} / 영업 ${place.isOpen === true ? "Y" : place.isOpen === false ? "N" : "?"} / 인기 ${place.tags.includes(POPULAR_CANDIDATE_TAG) ? "Y" : "N"} / 구글 ${hasGoogleCandidateSignal(place) ? "Y" : "N"})`;
      };
      const selectedLog = debugPool.filter((p) => selected.some((s) => s.id === p.id)).map(fmt);
      const cutLog = debugPool.filter((p) => !selected.some((s) => s.id === p.id)).map(fmt);
      logger.info("recommend", "맛집 후보 SELECTED", { items: selectedLog.join(" | ") });
      if (cutLog.length > 0) logger.info("recommend", "맛집 후보 CUT", { items: cutLog.join(" | ") });
    }

    result.push(...selected);
  }

  return result;
}
