import axios from "axios";
import type { Coordinates, Place } from "../types";
import { getOpenStateNow } from "../utils/openHours";
import { logger } from "../utils/logger";

const API_KEY = process.env.KAKAO_REST_API_KEY ?? "";
const CATEGORY_URL = "https://dapi.kakao.com/v2/local/search/category.json";
const KEYWORD_URL = "https://dapi.kakao.com/v2/local/search/keyword.json";
const RADIUS = 1500;
const DEFAULT_CATEGORY_LIMIT = 8;
const DEFAULT_SEARCH_SIZE = 12;
const KAKAO_MAX_PAGE_SIZE = 15;

function calcWalkingMinutes(distanceMeters: number): number {
  return Math.max(1, Math.round(distanceMeters / 80));
}

// "음식점 > 한식 > 해장국" → "한식" / "카페 > 커피전문점" → "커피전문점"
function parseSubCategory(categoryName: string): string | undefined {
  const parts = categoryName.split(" > ").map((p) => p.trim());
  return parts.length >= 2 ? parts[1] : undefined;
}

const EXCLUDE_KEYWORDS = ["스터디", "독서실", "코인노래", "24시간스터디", "자습"];

// 카페 중 테이크아웃 전용 제외 (이름 키워드)
const CAFE_TAKEOUT_NAME_KW = ["투고", "to go", "togo", "테이크아웃", "takeout", "take out"];
// 카카오 category_name에 이 키워드가 있으면 테이크아웃 전용으로 판단
const CAFE_TAKEOUT_CATEGORY_KW = ["테이크아웃"];
const CAFE_EXCLUDE_CATEGORY_KW = ["키즈", "키즈카페", "어린이", "유아"];
const CAFE_EXCLUDE_NAME_KW = ["키즈", "키즈카페", "어린이", "유아"];

// 감성 소품샵 결과에서 제외
const SHOPPING_EXCLUDE_CATEGORY_KW = [
  "인터넷쇼핑", "홈쇼핑", "통신판매",
  "인테리어 공사", "시공", "건자재", "철물", "가구", "가구판매", "가구,인테리어",
  "농기구", "공구", "축산", "축산업", "정육", "수산", "청과", "반찬", "식자재",
  "편의점", "슈퍼마켓", "슈퍼", "마트", "식품", "식품판매",
  "주유소", "세차", "수선", "세탁", "생활용품", "잡자재",
];

// 감성 소품샵으로 허용할 category_name 키워드
// "문구" → "디자인문구" 로 좁힘 (일반 문구점 차단)
// "캐릭터" 제거 (캐릭터 용품점·도화재료점 유입 방지)
const SHOPPING_ALLOW_CATEGORY_KW = [
  "소품", "편집", "라이프스타일", "디자인문구", "잡화", "팬시", "공예",
];

const MALL_EXCLUDE_CATEGORY_KW = [
  "인터넷쇼핑", "홈쇼핑", "통신판매", "대형마트", "마트", "식품", "식품판매",
  "가구", "가구판매", "축산", "정육", "수산", "청과", "반찬", "도매",
];

const MALL_ALLOW_CATEGORY_KW = [
  "복합쇼핑몰", "쇼핑몰", "백화점", "아울렛",
];

const POPUP_INCLUDE_CATEGORY_KW = ["공연", "전시", "행사", "축제", "문화", "아트", "이벤트홀", "컨벤션"];
const POPUP_EXCLUDE_CATEGORY_KW = [
  "음식점", "카페", "편의점", "약국", "병원", "주차",
  "마트", "슈퍼", "식품", "식품판매", "정육", "수산", "청과", "반찬", "주류",
  "제과", "베이커리", "편의", "생활용품",
  "유흥", "유흥주점", "단란주점", "호프", "룸살롱", "클럽", "라운지", "포차", "이자카야", "와인바", "칵테일바",
  "부동산", "공인중개", "분양", "오피스텔", "모델하우스", "서비스",
];

const CULTURE_ALLOW_CATEGORY_KW = [
  "미술관", "박물관", "전시관", "갤러리", "공연장", "문화센터", "문화시설", "아트홀", "복합문화공간",
];
const CULTURE_EXCLUDE_CATEGORY_KW = [
  "음식점", "카페", "편의점", "미용", "헤어", "네일", "꽃집", "화원", "부동산", "학원", "병원", "약국",
];

const TOURIST_ALLOW_CATEGORY_KW = [
  "관광명소", "문화유적", "역사유적", "자연경관", "유원지", "테마공원", "공원", "호수", "수목원", "둘레길",
];
const TOURIST_EXCLUDE_CATEGORY_KW = [
  "유명거리", "먹자골목", "가구거리", "상가", "쇼핑", "인테리어", "가구", "음식점", "카페", "편의점", "주차",
];

const PHOTO_ALLOW_CATEGORY_KW = ["포토부스", "셀프사진관", "사진관", "스튜디오"];
const PHOTO_EXCLUDE_CATEGORY_KW = ["음식점", "카페", "편의점", "마트", "주차", "병원", "약국"];

const BAR_ALLOW_CATEGORY_KW = ["술집", "이자카야", "와인바", "칵테일바", "포장마차", "호프"];
const BAR_EXCLUDE_CATEGORY_KW = ["음식점 > 카페", "편의점", "마트", "주차", "병원", "약국"];

const ACTIVITY_ALLOW_CATEGORY_KW = ["만화방", "보드카페", "방탈출", "오락실", "VR", "멀티방"];
const ACTIVITY_EXCLUDE_CATEGORY_KW = [
  "음식점", "제과", "편의점", "마트", "병원", "약국", "주차", "키즈", "키즈카페", "놀이방", "어린이", "유아",
];

const NATURE_ALLOW_CATEGORY_KW = [
  "자연경관", "산", "오름", "등산로", "둘레길", "호수", "계곡", "폭포", "숲", "수목원", "식물원", "해변", "해수욕장", "목장",
];
const NATURE_EXCLUDE_CATEGORY_KW = [
  "음식점", "카페", "제과", "편의점", "마트", "쇼핑", "병원", "약국", "주차",
  "식품", "식품판매", "축산", "정육", "수산", "청과", "반찬", "식자재",
  "부동산", "공인중개", "분양", "오피스텔", "모델하우스", "서비스",
  "건축", "설비", "시공", "전기시공", "인테리어", "가구", "학원", "미용", "헤어", "네일",
];

function matchesCategoryAllowlist(
  categoryName: string,
  allowKeywords: string[],
  excludeKeywords: string[] = []
): boolean {
  const lower = categoryName.toLowerCase();
  if (excludeKeywords.some((kw) => lower.includes(kw.toLowerCase()))) return false;
  return allowKeywords.some((kw) => lower.includes(kw.toLowerCase()));
}

// 쇼핑 subCategory 분류 (category_name 기준)
function shoppingSubCategory(categoryName: string): string | undefined {
  if (categoryName.includes("디자인문구") || categoryName.includes("문구")) return "디자인문구";
  if (categoryName.includes("소품") || categoryName.includes("잡화")) return "소품샵";
  if (categoryName.includes("편집")) return "편집샵";
  if (categoryName.includes("라이프스타일")) return "라이프스타일";
  if (categoryName.includes("공예")) return "공예소품";
  return parseSubCategory(categoryName);
}

function mallSubCategory(categoryName: string): string | undefined {
  if (categoryName.includes("복합쇼핑몰")) return "복합쇼핑몰";
  if (categoryName.includes("백화점")) return "백화점";
  if (categoryName.includes("아울렛")) return "아울렛";
  if (categoryName.includes("쇼핑몰")) return "쇼핑몰";
  return parseSubCategory(categoryName);
}

function isCuratedShoppingCandidate(doc: KakaoDocument): boolean {
  return matchesCategoryAllowlist(doc.category_name, SHOPPING_ALLOW_CATEGORY_KW, SHOPPING_EXCLUDE_CATEGORY_KW);
}

function isMallCandidate(doc: KakaoDocument): boolean {
  return matchesCategoryAllowlist(doc.category_name, MALL_ALLOW_CATEGORY_KW, MALL_EXCLUDE_CATEGORY_KW);
}

function isCafeCandidate(doc: KakaoDocument): boolean {
  const name = doc.place_name.toLowerCase();
  const cat = doc.category_name.toLowerCase();
  if (CAFE_TAKEOUT_NAME_KW.some((kw) => name.includes(kw))) return false;
  if (CAFE_TAKEOUT_CATEGORY_KW.some((kw) => cat.includes(kw))) return false;
  if (CAFE_EXCLUDE_NAME_KW.some((kw) => name.includes(kw.toLowerCase()))) return false;
  if (CAFE_EXCLUDE_CATEGORY_KW.some((kw) => cat.includes(kw.toLowerCase()))) return false;
  return true;
}

function isPopupCandidate(doc: KakaoDocument): boolean {
  return matchesCategoryAllowlist(doc.category_name, POPUP_INCLUDE_CATEGORY_KW, POPUP_EXCLUDE_CATEGORY_KW);
}

function isCultureVenueCandidate(doc: KakaoDocument): boolean {
  return matchesCategoryAllowlist(doc.category_name, CULTURE_ALLOW_CATEGORY_KW, CULTURE_EXCLUDE_CATEGORY_KW);
}

function isTouristSpotCandidate(doc: KakaoDocument): boolean {
  return matchesCategoryAllowlist(
    doc.category_name,
    TOURIST_ALLOW_CATEGORY_KW,
    [...AT4_EXCLUDE_KW, ...TOURIST_EXCLUDE_CATEGORY_KW]
  );
}

function getTouristSpotCategory(doc: KakaoDocument): Place["category"] {
  const categoryName = doc.category_name;
  if (
    categoryName.includes("자연경관") ||
    categoryName.includes("호수") ||
    categoryName.includes("둘레길")
  ) {
    return "nature";
  }
  if (
    categoryName.includes("공원") ||
    categoryName.includes("유원지") ||
    categoryName.includes("수목원") ||
    categoryName.includes("테마공원")
  ) {
    return "park";
  }
  return "exhibition";
}

interface KakaoDocument {
  id: string;
  place_name: string;
  address_name: string;
  road_address_name: string;
  x: string;
  y: string;
  distance: string;
  category_group_code: string;
  category_name: string;
  place_url: string;
  phone?: string;
}

async function searchByCategory(
  categoryCode: "CE7" | "FD6" | "AT4",
  coords: Coordinates,
  size = DEFAULT_SEARCH_SIZE,
  radius = RADIUS
): Promise<KakaoDocument[]> {
  if (!API_KEY) return [];

  try {
    const { data } = await axios.get(CATEGORY_URL, {
      headers: { Authorization: `KakaoAK ${API_KEY}` },
      params: {
        category_group_code: categoryCode,
        x: coords.lng,
        y: coords.lat,
        radius,
        size: Math.min(size, KAKAO_MAX_PAGE_SIZE),
        sort: "distance",
      },
    });

    const docs: KakaoDocument[] = data.documents ?? [];
    return docs.filter(
      (doc) => !EXCLUDE_KEYWORDS.some((kw) => doc.place_name.includes(kw))
    );
  } catch (err) {
    if (axios.isAxiosError(err)) {
      logger.error("kakao", "category search 실패", {
        categoryCode,
        status: err.response?.status ?? "unknown",
        message: JSON.stringify(err.response?.data ?? {}),
      });
    } else {
      logger.error("kakao", "category search 실패", {
        categoryCode,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return [];
  }
}

async function searchByKeyword(
  query: string,
  coords: Coordinates,
  size = DEFAULT_SEARCH_SIZE,
  radius = RADIUS,
  sort: "distance" | "accuracy" = "distance"
): Promise<KakaoDocument[]> {
  if (!API_KEY) return [];

  try {
    const { data } = await axios.get(KEYWORD_URL, {
      headers: { Authorization: `KakaoAK ${API_KEY}` },
      params: {
        query,
        x: coords.lng,
        y: coords.lat,
        radius,
        size: Math.min(size, KAKAO_MAX_PAGE_SIZE),
        sort,
      },
    });

    const docs: KakaoDocument[] = data.documents ?? [];
    return docs.filter(
      (doc) => !EXCLUDE_KEYWORDS.some((kw) => doc.place_name.includes(kw))
    );
  } catch (err) {
    if (axios.isAxiosError(err)) {
      logger.error("kakao", "keyword search 실패", {
        query,
        status: err.response?.status ?? "unknown",
        message: JSON.stringify(err.response?.data ?? {}),
      });
    } else {
      logger.error("kakao", "keyword search 실패", {
        query,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return [];
  }
}

// C안: 카카오맵 장소 링크
function kakaoMapUrl(placeId: string): string {
  return `https://place.map.kakao.com/${placeId}`;
}

async function docsToPlaces(
  docs: KakaoDocument[],
  category: Place["category"]
): Promise<Place[]> {
  return Promise.all(
    docs.map(async (doc) => {
      const operatingHours = "영업시간 확인 필요";
      return {
        id: `${category}-${doc.id}`,
        name: doc.place_name,
        category,
        coordinates: { lat: parseFloat(doc.y), lng: parseFloat(doc.x) },
        address: doc.road_address_name || doc.address_name,
        phone: doc.phone || undefined,
        walkingMinutes: calcWalkingMinutes(parseInt(doc.distance, 10)),
        operatingHours,
        isOpen: getOpenStateNow(operatingHours),
        subCategory: parseSubCategory(doc.category_name),
        kakaoMapUrl: kakaoMapUrl(doc.id),
        tags: [],
        source: "kakao" as const,
      };
    })
  );
}

export async function getNearByCafes(coords: Coordinates, baseRadius = RADIUS): Promise<Place[]> {
  const docs = await searchByCategory("CE7", coords, 16, baseRadius);
  const filtered = docs.filter(isCafeCandidate);
  logger.info("kakao", "카페 검색 결과", { raw: docs.length, filtered: filtered.length });
  return docsToPlaces(filtered.slice(0, DEFAULT_CATEGORY_LIMIT), "cafe");
}

const RESTAURANT_EXCLUDE_CATEGORY_KW = ["베이커리", "제과", "빵", "케이크", "디저트", "패스트푸드", "분식"];

export async function getNearByRestaurants(coords: Coordinates, baseRadius = RADIUS): Promise<Place[]> {
  const docs = await searchByCategory("FD6", coords, 14, baseRadius);
  const filtered = docs.filter(
    (doc) => !RESTAURANT_EXCLUDE_CATEGORY_KW.some((kw) => doc.category_name.includes(kw))
  );
  logger.info("kakao", "음식점 검색 결과", { raw: docs.length, filtered: filtered.length });
  return docsToPlaces(filtered.slice(0, DEFAULT_CATEGORY_LIMIT), "restaurant");
}

export async function getNearByShoppingPlaces(coords: Coordinates, baseRadius = RADIUS): Promise<Place[]> {
  const queries = ["소품샵", "편집샵", "라이프스타일샵", "감성문구", "디자인문구", "리빙소품", "셀렉트숍"];

  const results = await Promise.all(queries.map((q) => searchByKeyword(q, coords, 10, Math.max(1800, baseRadius))));

  const deduped = new Map<string, KakaoDocument>();
  for (const docs of results) {
    for (const doc of docs) {
      if (!deduped.has(doc.id)) deduped.set(doc.id, doc);
    }
  }

  const allDocs = [...deduped.values()];
  logger.list("kakao", `쇼핑 후보 ${allDocs.length}개`, allDocs.map((d) => `${d.place_name}(${d.category_name})`), 12);

  const shoppingDocs = allDocs
    .filter(isCuratedShoppingCandidate)
    .sort((a, b) => parseInt(a.distance) - parseInt(b.distance))
    .slice(0, DEFAULT_CATEGORY_LIMIT);

  logger.list("kakao", `쇼핑 필터 후 ${shoppingDocs.length}개`, shoppingDocs.map((d) => `${d.place_name}(${d.category_name})`), 12);

  // subCategory를 쇼핑 분류 기준으로 재지정
  const places = await docsToPlaces(shoppingDocs, "shopping");
  return places.map((p, i) => ({
    ...p,
    subCategory: shoppingSubCategory(shoppingDocs[i]?.category_name ?? ""),
  }));
}

export async function getNearByMallPlaces(coords: Coordinates, baseRadius = RADIUS): Promise<Place[]> {
  const queries = ["복합쇼핑몰", "쇼핑몰", "백화점", "아울렛"];

  const results = await Promise.all(queries.map((q) => searchByKeyword(q, coords, 10, Math.max(4000, baseRadius))));

  const deduped = new Map<string, KakaoDocument>();
  for (const docs of results) {
    for (const doc of docs) {
      if (!deduped.has(doc.id)) deduped.set(doc.id, doc);
    }
  }

  const allDocs = [...deduped.values()];
  logger.list("kakao", `쇼핑몰 후보 ${allDocs.length}개`, allDocs.map((d) => `${d.place_name}(${d.category_name})`), 12);

  const mallDocs = allDocs
    .filter(isMallCandidate)
    .sort((a, b) => parseInt(a.distance) - parseInt(b.distance))
    .slice(0, DEFAULT_CATEGORY_LIMIT);

  logger.list("kakao", `쇼핑몰 필터 후 ${mallDocs.length}개`, mallDocs.map((d) => `${d.place_name}(${d.category_name})`), 12);

  const places = await docsToPlaces(mallDocs, "mall");
  return places.map((p, i) => ({
    ...p,
    subCategory: mallSubCategory(mallDocs[i]?.category_name ?? ""),
    tags: ["실내", ...p.tags],
  }));
}

export async function getNearByPhotoBooth(coords: Coordinates, baseRadius = RADIUS): Promise<Place[]> {
  const queries = ["인생네컷", "포토이즘", "하루필름", "포토부스", "셀프사진관"];
  const results = await Promise.all(queries.map((q) => searchByKeyword(q, coords, 8, Math.max(2000, baseRadius))));
  const deduped = new Map<string, KakaoDocument>();
  for (const docs of results) {
    for (const doc of docs) {
      if (!deduped.has(doc.id)) deduped.set(doc.id, doc);
    }
  }
  const photoDocs = [...deduped.values()]
    .filter((doc) => matchesCategoryAllowlist(doc.category_name, PHOTO_ALLOW_CATEGORY_KW, PHOTO_EXCLUDE_CATEGORY_KW))
    .sort((a, b) => parseInt(a.distance) - parseInt(b.distance))
    .slice(0, 6);
  logger.info("kakao", "포토부스 검색 결과", { count: photoDocs.length });
  const places = await docsToPlaces(photoDocs, "photo");
  return places.map((p, i) => ({
    ...p,
    subCategory: photoDocs[i]?.place_name.includes("인생네컷") ? "인생네컷"
      : photoDocs[i]?.place_name.includes("포토이즘") ? "포토이즘"
      : photoDocs[i]?.place_name.includes("하루필름") ? "하루필름"
      : "포토부스",
    tags: ["실내", "감성"],
  }));
}

export async function getNearByBars(coords: Coordinates, baseRadius = RADIUS): Promise<Place[]> {
  const queries = ["이자카야", "와인바", "칵테일바", "루프탑바", "포차"];
  const results = await Promise.all(queries.map((q) => searchByKeyword(q, coords, 8, Math.max(1500, baseRadius))));
  const deduped = new Map<string, KakaoDocument>();
  for (const docs of results) {
    for (const doc of docs) {
      if (!deduped.has(doc.id)) deduped.set(doc.id, doc);
    }
  }
  const barDocs = [...deduped.values()]
    .filter((doc) => matchesCategoryAllowlist(doc.category_name, BAR_ALLOW_CATEGORY_KW, BAR_EXCLUDE_CATEGORY_KW))
    .sort((a, b) => parseInt(a.distance) - parseInt(b.distance))
    .slice(0, 6);
  logger.info("kakao", "바/이자카야 검색 결과", { count: barDocs.length });
  const places = await docsToPlaces(barDocs, "bar");
  return places.map((p, i) => {
    const name = barDocs[i]?.place_name ?? "";
    const cat = barDocs[i]?.category_name ?? "";
    const sub = name.includes("이자카야") ? "이자카야"
      : name.includes("와인") || cat.includes("와인") ? "와인바"
      : name.includes("칵테일") ? "칵테일바"
      : name.includes("루프탑") ? "루프탑바"
      : "바";
    return { ...p, subCategory: sub, tags: ["야간"] };
  });
}

export async function getNearByNaturePlaces(coords: Coordinates, baseRadius = RADIUS): Promise<Place[]> {
  const queries = ["등산로", "해수욕장", "해변", "목장", "식물원", "수목원", "오름"];
  const results = await Promise.all(queries.map((q) => searchByKeyword(q, coords, 6, Math.max(15000, baseRadius))));
  const deduped = new Map<string, KakaoDocument>();
  for (const docs of results) {
    for (const doc of docs) {
      if (!deduped.has(doc.id)) deduped.set(doc.id, doc);
    }
  }
  const natureDocs = [...deduped.values()]
    .filter((doc) => matchesCategoryAllowlist(doc.category_name, NATURE_ALLOW_CATEGORY_KW, NATURE_EXCLUDE_CATEGORY_KW))
    .sort((a, b) => parseInt(a.distance) - parseInt(b.distance))
    .slice(0, 6);
  logger.info("kakao", "자연 검색 결과", { count: natureDocs.length });
  const places = await docsToPlaces(natureDocs, "nature");
  return places.map((p) => ({
    ...p,
    operatingHours: "상시",
    isOpen: true as const,
    tags: ["야외", "자연"],
  }));
}

export async function getNearByCinemas(coords: Coordinates, baseRadius = RADIUS): Promise<Place[]> {
  const docs = await searchByKeyword("영화관", coords, 8, Math.max(5000, baseRadius));
  const cinemaDocs = docs
    .filter((doc) =>
      doc.place_name.includes("CGV") ||
      doc.place_name.includes("롯데시네마") ||
      doc.place_name.includes("메가박스") ||
      doc.category_name.includes("영화관")
    )
    .slice(0, 6);
  logger.info("kakao", "영화관 검색 결과", { count: cinemaDocs.length });
  const places = await docsToPlaces(cinemaDocs, "cinema");
  return places.map((p) => ({
    ...p,
    tags: ["실내"],
  }));
}

export async function getNearByWellnessPlaces(coords: Coordinates): Promise<Place[]> {
  const queries = ["찜질방", "사우나", "스파"];
  const results = await Promise.all(queries.map((q) => searchByKeyword(q, coords, 6)));
  const deduped = new Map<string, KakaoDocument>();
  for (const docs of results) {
    for (const doc of docs) {
      if (!deduped.has(doc.id)) deduped.set(doc.id, doc);
    }
  }
  const wellnessDocs = [...deduped.values()].slice(0, 6);
  logger.info("kakao", "찜질방/웰니스 검색 결과", { count: wellnessDocs.length });
  const places = await docsToPlaces(wellnessDocs, "park");
  return places.map((p) => ({
    ...p,
    subCategory: "찜질방/스파",
    tags: ["실내", "우천 대안"],
  }));
}

export function getMockWellnessPlaces(coords: Coordinates): Place[] {
  return [
    {
      id: "mock-wellness-1",
      name: "스파랜드 강남",
      category: "park" as const,
      coordinates: { lat: coords.lat + 0.003, lng: coords.lng - 0.003 },
      address: "서울 강남구",
      walkingMinutes: 12,
      operatingHours: "06:00-22:00",
      isOpen: getOpenStateNow("06:00-22:00"),
      subCategory: "찜질방/스파",
      tags: ["실내", "우천 대안"],
      source: "kakao" as const,
    },
  ];
}

// category_name 기반 공원 판별 — 이름이 아닌 카카오 분류 태그로 검증
const PARK_CATEGORY_KW = ["공원", "자연경관", "관광,명소", "유원지", "숲", "수목원", "정원", "한강", "생태"];
const PARK_EXCLUDE_CATEGORY_KW_LIST = ["인테리어", "가구", "음식점", "카페", "병원", "학원", "편의점", "주차"];

export async function getNearByParks(coords: Coordinates, baseRadius = RADIUS): Promise<Place[]> {
  const docs = await searchByKeyword("공원", coords, 12, baseRadius);
  const parkDocs = docs
    .filter((doc) => {
      const cat = doc.category_name;
      // category_name에 인테리어·상업시설 있으면 제외 (이름에 공원 있어도)
      if (PARK_EXCLUDE_CATEGORY_KW_LIST.some((kw) => cat.includes(kw))) return false;
      // category_name 기준으로 실제 공원/자연 카테고리인지 확인
      return PARK_CATEGORY_KW.some((kw) => cat.includes(kw));
    })
    .slice(0, 7);
  logger.info("kakao", "공원 검색 결과", { count: parkDocs.length });
  const places = await docsToPlaces(parkDocs, "park");
  return places.map((p) => ({
    ...p,
    operatingHours: "상시",
    isOpen: true as const,
    tags: ["야외"],
  }));
}

const AT4_EXCLUDE_KW = ["음식점", "카페", "편의점", "주차", "키즈", "키즈카페", "놀이방", "어린이", "유아"];

// AT4: 카카오 관광명소 카테고리 (공원·명소·역사유적·자연경관 포함)
export async function getNearByTouristSpots(coords: Coordinates, baseRadius = RADIUS): Promise<Place[]> {
  const docs = await searchByCategory("AT4", coords, 12, baseRadius);
  const filtered = docs
    .filter(isTouristSpotCandidate)
    .slice(0, DEFAULT_CATEGORY_LIMIT);
  logger.list("kakao", `관광명소(AT4) ${filtered.length}개`, filtered.map((d) => d.place_name), 12);
  return filtered.map((doc) => ({
    id: `${getTouristSpotCategory(doc)}-${doc.id}`,
    name: doc.place_name,
    category: getTouristSpotCategory(doc),
    coordinates: { lat: parseFloat(doc.y), lng: parseFloat(doc.x) },
    address: doc.road_address_name || doc.address_name,
    phone: doc.phone || undefined,
    walkingMinutes: calcWalkingMinutes(parseInt(doc.distance, 10)),
    operatingHours: getTouristSpotCategory(doc) === "exhibition" ? "영업시간 확인 필요" : "상시",
    isOpen: getTouristSpotCategory(doc) === "exhibition" ? getOpenStateNow("영업시간 확인 필요") : true,
    subCategory: doc.category_name.includes("공원") ? "공원/명소" : parseSubCategory(doc.category_name) ?? "관광명소",
    kakaoMapUrl: kakaoMapUrl(doc.id),
    tags: ["명소"],
    source: "kakao" as const,
  }));
}

// 갤러리·미술관·박물관·공연장 키워드 검색
export async function getNearByCultureVenues(coords: Coordinates, baseRadius = RADIUS): Promise<Place[]> {
  const queries = ["갤러리", "미술관", "박물관", "전시관", "공연장", "문화센터", "아트홀", "복합문화공간"];
  const results = await Promise.all(queries.map((q) => searchByKeyword(q, coords, 6, Math.max(3000, baseRadius))));
  const deduped = new Map<string, KakaoDocument>();
  for (const docs of results) {
    for (const doc of docs) {
      if (!deduped.has(doc.id)) deduped.set(doc.id, doc);
    }
  }
  const cultureDocs = [...deduped.values()]
    .filter(isCultureVenueCandidate)
    .sort((a, b) => parseInt(a.distance) - parseInt(b.distance))
    .slice(0, DEFAULT_CATEGORY_LIMIT);
  logger.list("kakao", `문화시설 ${cultureDocs.length}개`, cultureDocs.map((d) => d.place_name), 12);
  const places = await docsToPlaces(cultureDocs, "exhibition");
  return places.map((p, i) => {
    const categoryName = cultureDocs[i]?.category_name ?? "";
    const sub = categoryName.includes("미술관") ? "미술관"
      : categoryName.includes("박물관") ? "박물관"
      : categoryName.includes("갤러리") ? "갤러리"
      : categoryName.includes("공연장") ? "공연장"
      : categoryName.includes("문화센터") ? "문화센터"
      : parseSubCategory(categoryName) ?? "문화시설";
    return { ...p, subCategory: sub, tags: ["실내", "문화"] };
  });
}

// 카카오 accuracy(인기/관련도) 정렬로 인기 장소 수집
// sort=accuracy → 카카오맵 내 리뷰수·저장수·방문수 기반 정렬
export async function getNearByPopularPlaces(coords: Coordinates, baseRadius = RADIUS): Promise<Place[]> {
  const queries: Array<{ query: string; category: Place["category"]; filter?: (doc: KakaoDocument) => boolean }> = [
    { query: "카페",   category: "cafe", filter: isCafeCandidate },
    { query: "맛집",   category: "restaurant",
      filter: (doc) => !RESTAURANT_EXCLUDE_CATEGORY_KW.some((kw) => doc.category_name.includes(kw)) },
    { query: "소품샵", category: "shopping",
      filter: isCuratedShoppingCandidate },
    { query: "쇼핑몰", category: "mall",
      filter: isMallCandidate },
    { query: "전시",   category: "exhibition", filter: isCultureVenueCandidate },
    { query: "팝업",   category: "popup", filter: isPopupCandidate },
  ];

  const results = await Promise.all(
    queries.map(({ query, category, filter }) =>
      searchByKeyword(query, coords, 8, Math.max(3000, baseRadius), "accuracy").then((docs) => {
        const filtered = filter ? docs.filter(filter) : docs;
        return docsToPlaces(filtered.slice(0, 4), category);
      })
    )
  );

  const all = results.flat();
  // 중복 제거 (id 기준)
  const seen = new Set<string>();
  const deduped = all.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  logger.info("kakao", "인기 장소(accuracy)", { count: deduped.length });
  return deduped;
}

// 카카오 키워드로 팝업/행사/마켓 검색
// 공공 API에 없는 소규모 행사도 카카오맵 등록 기준으로 잡힘
const POPUP_QUERIES = ["팝업스토어", "팝업", "플리마켓", "야시장", "버스킹", "축제", "마켓"];

export async function getNearByKakaoPopups(coords: Coordinates, baseRadius = RADIUS): Promise<Place[]> {
  const results = await Promise.all(
    POPUP_QUERIES.map((q) => searchByKeyword(q, coords, 8, Math.max(2000, baseRadius)))
  );
  const deduped = new Map<string, KakaoDocument>();
  for (const docs of results) {
    for (const doc of docs) {
      if (!deduped.has(doc.id)) deduped.set(doc.id, doc);
    }
  }

  const popupDocs = [...deduped.values()]
    .filter(isPopupCandidate)
    .sort((a, b) => parseInt(a.distance) - parseInt(b.distance))
    .slice(0, DEFAULT_CATEGORY_LIMIT);

  logger.list("kakao", `팝업/행사 키워드 검색 ${popupDocs.length}개`, popupDocs.map((d) => d.place_name), 12);
  return docsToPlaces(popupDocs, "popup");
}

export async function getNearByActivityPlaces(coords: Coordinates, baseRadius = RADIUS): Promise<Place[]> {
  const queries = ["만화카페", "보드게임카페", "방탈출", "오락실"];
  const results = await Promise.all(queries.map((q) => searchByKeyword(q, coords, 8, Math.max(2000, baseRadius))));
  const deduped = new Map<string, KakaoDocument>();
  for (const docs of results) {
    for (const doc of docs) {
      if (!deduped.has(doc.id)) deduped.set(doc.id, doc);
    }
  }

  const allDeduped = [...deduped.values()];
  logger.block("activity", `카카오 원본 ${allDeduped.length}개`, allDeduped.map(
    (doc) => `"${doc.place_name}" | category: "${doc.category_name}" | distance: ${doc.distance}m`
  ));

  const activityDocs = allDeduped
    .filter((doc) => {
      const included = matchesCategoryAllowlist(doc.category_name, ACTIVITY_ALLOW_CATEGORY_KW, ACTIVITY_EXCLUDE_CATEGORY_KW);
      if (!included) {
        logger.info("activity", "후보 제외", {
          name: doc.place_name,
          category: doc.category_name,
        });
        return false;
      }
      return true;
    })
    .sort((a, b) => parseInt(a.distance) - parseInt(b.distance))
    .slice(0, 6);

  logger.list("kakao", `액티비티 검색 결과 ${activityDocs.length}개`, activityDocs.map((d) => d.place_name), 12);

  const places = await docsToPlaces(activityDocs, "activity");
  return places.map((p, i) => {
    const name = activityDocs[i]?.place_name ?? "";
    const sub = name.includes("만화") ? "만화카페"
      : name.includes("보드게임") ? "보드게임카페"
      : name.includes("방탈출") ? "방탈출"
      : name.includes("오락실") || name.includes("펀샵") ? "오락실"
      : "실내 액티비티";
    return { ...p, subCategory: sub, tags: ["실내"] };
  });
}

export function getMockKakaoParks(coords: Coordinates): Place[] {
  return [
    {
      id: "mock-kakao-park-1",
      name: "서울숲",
      category: "park" as const,
      coordinates: { lat: coords.lat + 0.008, lng: coords.lng + 0.004 },
      address: "서울 성동구 뚝섬로",
      walkingMinutes: 22,
      operatingHours: "상시",
      isOpen: true,
      tags: ["야외"],
      source: "kakao" as const,
    },
    {
      id: "mock-kakao-park-2",
      name: "남산공원",
      category: "park" as const,
      coordinates: { lat: coords.lat - 0.005, lng: coords.lng + 0.006 },
      address: "서울 용산구 남산공원길",
      walkingMinutes: 28,
      operatingHours: "상시",
      isOpen: true,
      tags: ["야외"],
      source: "kakao" as const,
    },
  ];
}

export function getMockCafes(coords: Coordinates): Place[] {
  return [
    {
      id: "mock-cafe-1",
      name: "블루보틀 합정",
      category: "cafe",
      coordinates: { lat: coords.lat + 0.003, lng: coords.lng + 0.002 },
      address: "서울 마포구 합정동 123",
      walkingMinutes: 5,
      operatingHours: "08:00-21:00",
      isOpen: true,
      kakaoMapUrl: "https://place.map.kakao.com/26338954",
      representativeMenus: [
        { name: "아이스 아메리카노", price: 5500 },
        { name: "뉴올리언스 아이스", price: 7500 },
      ],
      tags: [],
      source: "kakao",
    },
    {
      id: "mock-cafe-2",
      name: "스타벅스 망원점",
      category: "cafe",
      coordinates: { lat: coords.lat + 0.005, lng: coords.lng - 0.001 },
      address: "서울 마포구 망원동 456",
      walkingMinutes: 10,
      operatingHours: "07:00-22:00",
      isOpen: true,
      kakaoMapUrl: "https://place.map.kakao.com/8137464",
      representativeMenus: [
        { name: "아이스 아메리카노", price: 4500 },
        { name: "카페라떼", price: 5000 },
      ],
      tags: [],
      source: "kakao",
    },
  ];
}

export function getMockShoppingPlaces(coords: Coordinates): Place[] {
  return [
    {
      id: "mock-shopping-1",
      name: "오브젝트 서교",
      category: "shopping",
      coordinates: { lat: coords.lat + 0.002, lng: coords.lng + 0.001 },
      address: "서울 마포구 서교동 351-2",
      walkingMinutes: 7,
      operatingHours: "12:00-21:00",
      isOpen: true,
      subCategory: "소품샵",
      kakaoMapUrl: "https://place.map.kakao.com/1809376314",
      tags: ["구경하기 좋아요"],
      source: "kakao",
    },
    {
      id: "mock-shopping-2",
      name: "포인트오브뷰 연남",
      category: "shopping",
      coordinates: { lat: coords.lat + 0.004, lng: coords.lng - 0.002 },
      address: "서울 마포구 연남동 241-77",
      walkingMinutes: 11,
      operatingHours: "11:00-20:00",
      isOpen: true,
      subCategory: "편집샵",
      kakaoMapUrl: "https://place.map.kakao.com/936558791",
      tags: ["소품샵"],
      source: "kakao",
    },
  ];
}

export function getMockMallPlaces(coords: Coordinates): Place[] {
  return [
    {
      id: "mock-mall-1",
      name: "코엑스몰",
      category: "mall",
      coordinates: { lat: coords.lat + 0.006, lng: coords.lng + 0.001 },
      address: "서울 강남구 영동대로 513",
      walkingMinutes: 14,
      operatingHours: "10:30-22:00",
      isOpen: getOpenStateNow("10:30-22:00"),
      subCategory: "복합쇼핑몰",
      tags: ["실내"],
      source: "kakao",
    },
    {
      id: "mock-mall-2",
      name: "롯데월드몰",
      category: "mall",
      coordinates: { lat: coords.lat + 0.008, lng: coords.lng - 0.003 },
      address: "서울 송파구 올림픽로 300",
      walkingMinutes: 18,
      operatingHours: "10:30-22:00",
      isOpen: getOpenStateNow("10:30-22:00"),
      subCategory: "복합쇼핑몰",
      tags: ["실내"],
      source: "kakao",
    },
  ];
}
