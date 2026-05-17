/**
 * 분위기 카테고리 필터링 단위 테스트
 * 실행: npx ts-node test-category-filter.ts
 */
import type { Place, PlaceCategory } from "./src/types";

// ── 테스트 헬퍼 ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    failed++;
  }
}

// ── Mock 장소 데이터 ─────────────────────────────────────────────────────────

function makePlaces(categories: PlaceCategory[]): Place[] {
  return categories.map((category, i) => ({
    id: `${category}-${i}`,
    name: `테스트 ${category} ${i}`,
    category,
    coordinates: { lat: 37.5, lng: 127.0 },
    address: "서울",
    walkingMinutes: 5 + i,
    operatingHours: "10:00-22:00",
    isOpen: true,
    tags: [],
    source: "kakao" as const,
  }));
}

// ── 테스트 대상: 카테고리 필터링 로직 ────────────────────────────────────────
// recommend.ts 의 핵심 필터 로직을 추출해서 검증

function filterCandidatesBySelectedCategories(
  candidates: Place[],
  selectedCategories: PlaceCategory[],
): Place[] {
  const selectedCats = selectedCategories ?? [];
  return selectedCats.length >= 1
    ? candidates.filter((p) => selectedCats.includes(p.category))
    : candidates;
}

// ── 테스트 실행 ───────────────────────────────────────────────────────────────

const allCategories: PlaceCategory[] = [
  "cafe", "restaurant", "park", "exhibition", "bar", "cinema", "activity", "shopping",
];
const allPlaces = makePlaces(allCategories);

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("  분위기 카테고리 필터링 단위 테스트");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

// 1. 아무것도 선택 안 함 → 전체 통과
console.log("[ 1 ] 선택 없음 → 템플릿 모드 (전체 카테고리 유지)");
{
  const result = filterCandidatesBySelectedCategories(allPlaces, []);
  assert(result.length === allPlaces.length, `전체 ${allPlaces.length}개 그대로 통과`);
  assert(
    allCategories.every((cat) => result.some((p) => p.category === cat)),
    "모든 카테고리 포함",
  );
}

// 2. cafe + restaurant 선택 → 두 카테고리만 통과
console.log("\n[ 2 ] cafe + restaurant 선택 → 해당 카테고리만");
{
  const selected: PlaceCategory[] = ["cafe", "restaurant"];
  const result = filterCandidatesBySelectedCategories(allPlaces, selected);
  assert(
    result.every((p) => selected.includes(p.category)),
    "결과가 전부 cafe 또는 restaurant",
  );
  assert(
    result.some((p) => p.category === "cafe"),
    "cafe 포함",
  );
  assert(
    result.some((p) => p.category === "restaurant"),
    "restaurant 포함",
  );
  assert(
    !result.some((p) => p.category === "park"),
    "park 제외됨",
  );
  assert(
    !result.some((p) => p.category === "bar"),
    "bar 제외됨",
  );
}

// 3. 5개 선택 → 해당 5개만
console.log("\n[ 3 ] 5개 선택 (cafe·restaurant·exhibition·cinema·activity)");
{
  const selected: PlaceCategory[] = ["cafe", "restaurant", "exhibition", "cinema", "activity"];
  const result = filterCandidatesBySelectedCategories(allPlaces, selected);
  assert(
    result.every((p) => selected.includes(p.category)),
    "결과가 모두 선택한 5개 카테고리 안에 포함",
  );
  assert(
    !result.some((p) => ["park", "bar", "shopping"].includes(p.category)),
    "비선택 카테고리(park·bar·shopping) 제외됨",
  );
  assert(result.length === 5, `정확히 5개 반환 (실제: ${result.length}개)`);
}

// 4. 1개만 선택 → 프론트에서 막지만, 백엔드는 그대로 필터
console.log("\n[ 4 ] 1개 선택 (park) → 해당 카테고리만 (백엔드 정책)");
{
  const selected: PlaceCategory[] = ["park"];
  const result = filterCandidatesBySelectedCategories(allPlaces, selected);
  assert(result.length === 1, "park 1개만 반환");
  assert(result[0]?.category === "park", "반환된 장소가 park");
}

// 5. 존재하지 않는 카테고리 선택 → 빈 배열
console.log("\n[ 5 ] 목록에 없는 카테고리 → 빈 결과");
{
  const cafePlaces = makePlaces(["cafe", "cafe", "cafe"]);
  const result = filterCandidatesBySelectedCategories(cafePlaces, ["bar"]);
  assert(result.length === 0, "bar가 없으면 빈 배열 반환");
}

// 6. 중복 카테고리 장소 여러 개 → 모두 통과
console.log("\n[ 6 ] 같은 카테고리 장소 여러 개 → 모두 통과");
{
  const cafes = makePlaces(["cafe", "cafe", "cafe", "cafe"]);
  const restaurants = makePlaces(["restaurant", "restaurant"]);
  const mixed = [...cafes, ...restaurants];
  const result = filterCandidatesBySelectedCategories(mixed, ["cafe", "restaurant"]);
  assert(result.length === 6, `cafe 4개 + restaurant 2개 = 6개 (실제: ${result.length}개)`);
}

// ── 결과 ────────────────────────────────────────────────────────────────────

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(`  결과: ✅ ${passed}개 통과  ${failed > 0 ? `❌ ${failed}개 실패` : ""}`);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

if (failed > 0) process.exit(1);
