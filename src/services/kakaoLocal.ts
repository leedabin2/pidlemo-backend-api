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
  size = 8
): Promise<KakaoDocument[]> {
  if (!API_KEY) return [];

  const { data } = await axios.get(KEYWORD_URL, {
    headers: { Authorization: `KakaoAK ${API_KEY}` },
    params: {
      query,
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
  const docs = await searchByCategory("CE7", coords, 8);
  console.log(`[kakao] 카페 검색 결과: ${docs.length}개`);
  return docsToPlaces(docs.slice(0, 5), "cafe");
}

export async function getNearByRestaurants(coords: Coordinates): Promise<Place[]> {
  const docs = await searchByCategory("FD6", coords, 8);
  console.log(`[kakao] 음식점 검색 결과: ${docs.length}개`);
  return docsToPlaces(docs.slice(0, 5), "restaurant");
}

export async function getNearByShoppingPlaces(coords: Coordinates): Promise<Place[]> {
  const queries = ["소품샵", "편집샵", "라이프스타일샵"];
  const results = await Promise.all(queries.map((query) => searchByKeyword(query, coords, 5)));
  const deduped = new Map<string, KakaoDocument>();

  for (const docs of results) {
    for (const doc of docs) {
      if (!deduped.has(doc.id)) deduped.set(doc.id, doc);
    }
  }

  const shoppingDocs = [...deduped.values()].slice(0, 5);
  console.log(`[kakao] 쇼핑/소품샵 검색 결과: ${shoppingDocs.length}개`);
  return docsToPlaces(shoppingDocs, "shopping");
}

export async function getNearByParks(coords: Coordinates): Promise<Place[]> {
  const docs = await searchByKeyword("공원", coords, 8);
  const parkDocs = docs
    .filter((doc) =>
      doc.place_name.includes("공원") ||
      doc.place_name.includes("정원") ||
      doc.place_name.includes("숲") ||
      doc.place_name.includes("산책")
    )
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
