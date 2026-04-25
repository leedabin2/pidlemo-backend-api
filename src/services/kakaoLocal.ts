import axios from "axios";
import type { Coordinates, Place } from "../types";
import { getOpenStateNow } from "../utils/openHours";

const API_KEY = process.env.KAKAO_REST_API_KEY ?? "";
const CATEGORY_URL = "https://dapi.kakao.com/v2/local/search/category.json";
const KEYWORD_URL = "https://dapi.kakao.com/v2/local/search/keyword.json";
const RADIUS = 1500;

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

// 쇼핑 결과에서 제외
const SHOPPING_EXCLUDE_CATEGORY_KW = [
  "인터넷쇼핑", "홈쇼핑", "통신판매",
  "인테리어 공사", "시공", "건자재", "철물",
  "농기구", "공구",
  "편의점", "슈퍼마켓", "슈퍼", "마트", "식품",  // 편의점/마트 계열
  "주유소", "세차", "수선", "세탁",              // 서비스 업종
];

// 장소명에 있으면 무조건 제외 (카테고리와 무관하게)
const SHOPPING_EXCLUDE_NAME_KW = [
  "편의점", "CU", "GS25", "이마트24", "세븐일레븐", "미니스톱",
  "마트", "슈퍼", "푸드마켓", "식품관",
  "주차장", "주차",
];

// 쇼핑으로 허용할 category_name 키워드
const SHOPPING_ALLOW_CATEGORY_KW = [
  "소품", "편집", "라이프스타일", "패션", "의류", "복합쇼핑몰", "백화점",
  "아울렛", "잡화", "쇼핑몰", "문구", "완구", "서점",
];

// 쇼핑 subCategory 분류 (category_name 기준)
function shoppingSubCategory(categoryName: string): string | undefined {
  if (categoryName.includes("백화점")) return "백화점";
  if (categoryName.includes("복합쇼핑몰") || categoryName.includes("쇼핑몰")) return "쇼핑몰";
  if (categoryName.includes("아울렛")) return "아울렛";
  if (categoryName.includes("패션") || categoryName.includes("의류")) return "패션";
  if (categoryName.includes("소품") || categoryName.includes("잡화")) return "소품샵";
  if (categoryName.includes("편집")) return "편집샵";
  if (categoryName.includes("라이프스타일")) return "라이프스타일";
  return parseSubCategory(categoryName);
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
}

async function searchByCategory(
  categoryCode: "CE7" | "FD6" | "AT4",
  coords: Coordinates,
  size = 8
): Promise<KakaoDocument[]> {
  if (!API_KEY) return [];

  const { data } = await axios.get(CATEGORY_URL, {
    headers: { Authorization: `KakaoAK ${API_KEY}` },
    params: {
      category_group_code: categoryCode,
      x: coords.lng,
      y: coords.lat,
      radius: RADIUS,
      size,
      sort: "distance",
    },
  });

  const docs: KakaoDocument[] = data.documents ?? [];
  return docs.filter(
    (doc) => !EXCLUDE_KEYWORDS.some((kw) => doc.place_name.includes(kw))
  );
}

async function searchByKeyword(
  query: string,
  coords: Coordinates,
  size = 8,
  radius = RADIUS,
  sort: "distance" | "accuracy" = "distance"
): Promise<KakaoDocument[]> {
  if (!API_KEY) return [];

  const { data } = await axios.get(KEYWORD_URL, {
    headers: { Authorization: `KakaoAK ${API_KEY}` },
    params: {
      query,
      x: coords.lng,
      y: coords.lat,
      radius,
      size,
      sort,
    },
  });

  const docs: KakaoDocument[] = data.documents ?? [];
  return docs.filter(
    (doc) => !EXCLUDE_KEYWORDS.some((kw) => doc.place_name.includes(kw))
  );
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

export async function getNearByCafes(coords: Coordinates): Promise<Place[]> {
  const docs = await searchByCategory("CE7", coords, 12);
  const filtered = docs.filter((doc) => {
    const name = doc.place_name.toLowerCase();
    const cat = doc.category_name.toLowerCase();
    if (CAFE_TAKEOUT_NAME_KW.some((kw) => name.includes(kw))) return false;
    if (CAFE_TAKEOUT_CATEGORY_KW.some((kw) => cat.includes(kw))) return false;
    return true;
  });
  console.log(`[kakao] 카페 검색 결과: ${docs.length}개 → 테이크아웃 제외 후 ${filtered.length}개`);
  return docsToPlaces(filtered.slice(0, 5), "cafe");
}

const RESTAURANT_EXCLUDE_CATEGORY_KW = ["베이커리", "제과", "빵", "케이크", "디저트", "패스트푸드", "분식"];

export async function getNearByRestaurants(coords: Coordinates): Promise<Place[]> {
  const docs = await searchByCategory("FD6", coords, 10);
  const filtered = docs.filter(
    (doc) => !RESTAURANT_EXCLUDE_CATEGORY_KW.some((kw) => doc.category_name.includes(kw))
  );
  console.log(`[kakao] 음식점 검색 결과: ${docs.length}개 → 베이커리/분식 제외 후 ${filtered.length}개`);
  return docsToPlaces(filtered.slice(0, 5), "restaurant");
}

export async function getNearByShoppingPlaces(coords: Coordinates): Promise<Place[]> {
  // 감성/트렌디 소형 매장: 1.5km, 대형몰: 5km
  const nearQueries = ["소품샵", "편집샵", "라이프스타일샵", "감성문구", "디자인문구", "감성잡화"];
  const farQueries = ["복합쇼핑몰", "백화점", "쇼핑몰", "아울렛"];

  const [nearResults, farResults] = await Promise.all([
    Promise.all(nearQueries.map((q) => searchByKeyword(q, coords, 8, 1500))),
    Promise.all(farQueries.map((q) => searchByKeyword(q, coords, 6, 5000))),
  ]);

  const deduped = new Map<string, KakaoDocument>();
  for (const docs of [...nearResults, ...farResults]) {
    for (const doc of docs) {
      if (!deduped.has(doc.id)) deduped.set(doc.id, doc);
    }
  }

  const allDocs = [...deduped.values()];
  console.log(`[kakao] 쇼핑 후보 ${allDocs.length}개:`, allDocs.map(d => `${d.place_name}(${d.category_name})`).join(", "));

  const shoppingDocs = allDocs
    .filter((doc) => {
      const cat = doc.category_name.toLowerCase();
      const name = doc.place_name;
      // 1) 장소명 블록리스트 먼저 (카테고리 무관하게 제외)
      if (SHOPPING_EXCLUDE_NAME_KW.some((kw) => name.includes(kw))) return false;
      // 2) 카테고리 블록리스트
      if (SHOPPING_EXCLUDE_CATEGORY_KW.some((kw) => cat.includes(kw.toLowerCase()))) return false;
      // 3) 허용 카테고리
      if (SHOPPING_ALLOW_CATEGORY_KW.some((kw) => cat.includes(kw.toLowerCase()))) return true;
      // 4) 장소명으로 판단 (마켓/마트 제외, 소품/편집/라이프/몰/백화점/아울렛만)
      if (["소품", "편집", "라이프", "몰", "백화점", "아울렛"].some((kw) => name.includes(kw))) return true;
      // 5) 쇼핑 카테고리 중 오프라인 계열만 (편의점/마트 제외)
      if (cat.startsWith("쇼핑") && !cat.includes("인터넷") && !cat.includes("홈쇼핑") && !cat.includes("통신") && !cat.includes("편의") && !cat.includes("마트") && !cat.includes("슈퍼")) return true;
      return false;
    })
    .sort((a, b) => parseInt(a.distance) - parseInt(b.distance))
    .slice(0, 8);

  console.log(`[kakao] 쇼핑 필터 후 ${shoppingDocs.length}개:`, shoppingDocs.map(d => `${d.place_name}(${d.category_name})`).join(", "));

  // subCategory를 쇼핑 분류 기준으로 재지정
  const places = await docsToPlaces(shoppingDocs, "shopping");
  return places.map((p, i) => ({
    ...p,
    subCategory: shoppingSubCategory(shoppingDocs[i]?.category_name ?? ""),
  }));
}

export async function getNearByPhotoBooth(coords: Coordinates): Promise<Place[]> {
  const queries = ["인생네컷", "포토이즘", "하루필름", "포토부스", "셀프사진관"];
  const results = await Promise.all(queries.map((q) => searchByKeyword(q, coords, 6, 2000)));
  const deduped = new Map<string, KakaoDocument>();
  for (const docs of results) {
    for (const doc of docs) {
      if (!deduped.has(doc.id)) deduped.set(doc.id, doc);
    }
  }
  const photoDocs = [...deduped.values()]
    .sort((a, b) => parseInt(a.distance) - parseInt(b.distance))
    .slice(0, 5);
  console.log(`[kakao] 포토부스 검색 결과: ${photoDocs.length}개`);
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

export async function getNearByBars(coords: Coordinates): Promise<Place[]> {
  const queries = ["이자카야", "와인바", "칵테일바", "루프탑바", "포차"];
  const results = await Promise.all(queries.map((q) => searchByKeyword(q, coords, 6, 1500)));
  const deduped = new Map<string, KakaoDocument>();
  for (const docs of results) {
    for (const doc of docs) {
      if (!deduped.has(doc.id)) deduped.set(doc.id, doc);
    }
  }
  const barDocs = [...deduped.values()]
    .sort((a, b) => parseInt(a.distance) - parseInt(b.distance))
    .slice(0, 5);
  console.log(`[kakao] 바/이자카야 검색 결과: ${barDocs.length}개`);
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

// 자연 카테고리 - 식당/카페/상점 이름에 자연 단어가 들어간 경우 제외
const NATURE_EXCLUDE_CATEGORY_KW = ["음식점", "카페", "제과", "편의점", "마트", "쇼핑", "병원", "약국", "주차"];
const NATURE_NAME_KW = ["바다", "해변", "해수욕장", "해안", "산", "숲", "계곡", "폭포", "목장", "식물원", "수목원", "오름", "둘레길", "등산"];

export async function getNearByNaturePlaces(coords: Coordinates): Promise<Place[]> {
  const queries = ["등산로", "해수욕장", "해변", "목장", "식물원", "수목원", "오름"];
  const results = await Promise.all(queries.map((q) => searchByKeyword(q, coords, 4, 15000)));
  const deduped = new Map<string, KakaoDocument>();
  for (const docs of results) {
    for (const doc of docs) {
      if (!deduped.has(doc.id)) deduped.set(doc.id, doc);
    }
  }
  const natureDocs = [...deduped.values()]
    .filter((doc) => {
      const cat = doc.category_name.toLowerCase();
      const name = doc.place_name;
      // 식당/카페 계열 카테고리면 제외
      if (NATURE_EXCLUDE_CATEGORY_KW.some((kw) => cat.includes(kw.toLowerCase()))) return false;
      // 장소명에 자연 키워드가 있어야 통과
      return NATURE_NAME_KW.some((kw) => name.includes(kw));
    })
    .sort((a, b) => parseInt(a.distance) - parseInt(b.distance))
    .slice(0, 4);
  console.log(`[kakao] 자연 검색 결과: ${natureDocs.length}개`);
  const places = await docsToPlaces(natureDocs, "nature");
  return places.map((p) => ({
    ...p,
    operatingHours: "상시",
    isOpen: true as const,
    tags: ["야외", "자연"],
  }));
}

export async function getNearByCinemas(coords: Coordinates): Promise<Place[]> {
  const docs = await searchByKeyword("영화관", coords, 6, 5000);
  const cinemaDocs = docs
    .filter((doc) =>
      doc.place_name.includes("CGV") ||
      doc.place_name.includes("롯데시네마") ||
      doc.place_name.includes("메가박스") ||
      doc.category_name.includes("영화관")
    )
    .slice(0, 4);
  console.log(`[kakao] 영화관 검색 결과: ${cinemaDocs.length}개`);
  const places = await docsToPlaces(cinemaDocs, "cinema");
  return places.map((p) => ({
    ...p,
    tags: ["실내"],
  }));
}

export async function getNearByWellnessPlaces(coords: Coordinates): Promise<Place[]> {
  const queries = ["찜질방", "사우나", "스파"];
  const results = await Promise.all(queries.map((q) => searchByKeyword(q, coords, 4)));
  const deduped = new Map<string, KakaoDocument>();
  for (const docs of results) {
    for (const doc of docs) {
      if (!deduped.has(doc.id)) deduped.set(doc.id, doc);
    }
  }
  const wellnessDocs = [...deduped.values()].slice(0, 4);
  console.log(`[kakao] 찜질방/웰니스 검색 결과: ${wellnessDocs.length}개`);
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

export async function getNearByParks(coords: Coordinates): Promise<Place[]> {
  const docs = await searchByKeyword("공원", coords, 10);
  const parkDocs = docs
    .filter((doc) => {
      const cat = doc.category_name;
      // category_name에 인테리어·상업시설 있으면 제외 (이름에 공원 있어도)
      if (PARK_EXCLUDE_CATEGORY_KW_LIST.some((kw) => cat.includes(kw))) return false;
      // category_name 기준으로 실제 공원/자연 카테고리인지 확인
      return PARK_CATEGORY_KW.some((kw) => cat.includes(kw));
    })
    .slice(0, 5);
  console.log(`[kakao] 공원 검색 결과: ${parkDocs.length}개`);
  const places = await docsToPlaces(parkDocs, "park");
  return places.map((p) => ({
    ...p,
    operatingHours: "상시",
    isOpen: true as const,
    tags: ["야외"],
  }));
}

// AT4: 카카오 관광명소 카테고리 (공원·명소·역사유적·자연경관 포함)
export async function getNearByTouristSpots(coords: Coordinates): Promise<Place[]> {
  const docs = await searchByCategory("AT4", coords, 12);
  const filtered = docs
    .filter((doc) => {
      const cat = doc.category_name;
      // 음식점·카페·편의점 계열은 AT4 안에 섞여 들어오므로 제외
      if (cat.includes("음식점") || cat.includes("카페") || cat.includes("편의점") || cat.includes("주차")) return false;
      return true;
    })
    .slice(0, 6);
  console.log(`[kakao] 관광명소(AT4) ${filtered.length}개:`, filtered.map(d => d.place_name).join(", "));
  const places = await docsToPlaces(filtered, "exhibition");
  return places.map((p, i) => ({
    ...p,
    subCategory: filtered[i]?.category_name.includes("공원") ? "공원/명소" : "관광명소",
    tags: ["명소"],
  }));
}

// 갤러리·미술관·박물관·공연장 키워드 검색
export async function getNearByCultureVenues(coords: Coordinates): Promise<Place[]> {
  const queries = ["갤러리", "미술관", "박물관", "전시관", "공연장", "문화센터"];
  const results = await Promise.all(queries.map((q) => searchByKeyword(q, coords, 5, 3000)));
  const deduped = new Map<string, KakaoDocument>();
  for (const docs of results) {
    for (const doc of docs) {
      if (!deduped.has(doc.id)) deduped.set(doc.id, doc);
    }
  }
  const cultureDocs = [...deduped.values()]
    .filter((doc) => {
      const cat = doc.category_name.toLowerCase();
      return !cat.includes("음식점") && !cat.includes("카페") && !cat.includes("편의점");
    })
    .sort((a, b) => parseInt(a.distance) - parseInt(b.distance))
    .slice(0, 6);
  console.log(`[kakao] 문화시설 ${cultureDocs.length}개:`, cultureDocs.map(d => d.place_name).join(", "));
  const places = await docsToPlaces(cultureDocs, "exhibition");
  return places.map((p, i) => {
    const name = cultureDocs[i]?.place_name ?? "";
    const sub = name.includes("미술관") ? "미술관"
      : name.includes("박물관") ? "박물관"
      : name.includes("갤러리") ? "갤러리"
      : name.includes("공연장") ? "공연장"
      : "문화시설";
    return { ...p, subCategory: sub, tags: ["실내", "문화"] };
  });
}

// 카카오 accuracy(인기/관련도) 정렬로 인기 장소 수집
// sort=accuracy → 카카오맵 내 리뷰수·저장수·방문수 기반 정렬
export async function getNearByPopularPlaces(coords: Coordinates): Promise<Place[]> {
  // 각 카테고리별 인기순 상위 결과
  const queries: Array<{ query: string; category: Place["category"] }> = [
    { query: "카페",     category: "cafe" },
    { query: "맛집",     category: "restaurant" },
    { query: "소품샵",   category: "shopping" },
    { query: "전시",     category: "exhibition" },
    { query: "팝업",     category: "popup" },
  ];

  const results = await Promise.all(
    queries.map(({ query, category }) =>
      searchByKeyword(query, coords, 5, 3000, "accuracy").then((docs) =>
        docsToPlaces(docs.slice(0, 3), category)
      )
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

  console.log(`[kakao] 인기 장소(accuracy): ${deduped.length}개`);
  return deduped;
}

// 카카오 키워드로 팝업/행사/마켓 검색
// 공공 API에 없는 소규모 행사도 카카오맵 등록 기준으로 잡힘
const POPUP_QUERIES = ["팝업스토어", "팝업", "플리마켓", "야시장", "버스킹", "축제", "마켓"];
// 일반 상점/음식점 카테고리는 팝업이 아님
const POPUP_EXCLUDE_CATEGORY_KW = ["음식점", "카페", "편의점", "약국", "병원", "주차", "마트"];

export async function getNearByKakaoPopups(coords: Coordinates): Promise<Place[]> {
  const results = await Promise.all(
    POPUP_QUERIES.map((q) => searchByKeyword(q, coords, 6, 2000))
  );
  const deduped = new Map<string, KakaoDocument>();
  for (const docs of results) {
    for (const doc of docs) {
      if (!deduped.has(doc.id)) deduped.set(doc.id, doc);
    }
  }

  const popupDocs = [...deduped.values()]
    .filter((doc) => {
      const cat = doc.category_name.toLowerCase();
      // 일반 상시 운영 업종 제외
      if (POPUP_EXCLUDE_CATEGORY_KW.some((kw) => cat.includes(kw.toLowerCase()))) return false;
      // 장소명에 팝업/마켓/행사 키워드가 있어야 함
      const name = doc.place_name;
      return POPUP_QUERIES.some((kw) => name.includes(kw)) ||
        cat.includes("공연") || cat.includes("전시") || cat.includes("행사");
    })
    .sort((a, b) => parseInt(a.distance) - parseInt(b.distance))
    .slice(0, 6);

  console.log(`[kakao] 팝업/행사 키워드 검색: ${popupDocs.length}개`, popupDocs.map(d => d.place_name).join(", "));
  return docsToPlaces(popupDocs, "popup");
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
