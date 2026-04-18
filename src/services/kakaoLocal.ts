import axios from "axios";
import type { Coordinates, Place } from "../types";

const API_KEY = process.env.KAKAO_REST_API_KEY ?? "";
const CATEGORY_URL = "https://dapi.kakao.com/v2/local/search/category.json";
const DETAIL_URL   = "https://dapi.kakao.com/v2/local/place.json"; // 영업시간 보완용
const RADIUS = 1500;

function calcWalkingMinutes(distanceMeters: number): number {
  return Math.max(1, Math.round(distanceMeters / 80));
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

interface KakaoPlaceDetail {
  basicInfo?: {
    openHour?: {
      periodList?: { timeList?: { dayOfWeek: string; timeSE: string }[] }[];
    };
  };
}

async function searchByCategory(
  categoryCode: "CE7" | "FD6",
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

// B안: Kakao Place Detail로 영업시간 보완 (상위 몇 개만)
async function fetchOperatingHours(placeId: string): Promise<string | null> {
  if (!API_KEY) return null;
  try {
    const { data } = await axios.get<KakaoPlaceDetail>(DETAIL_URL, {
      headers: { Authorization: `KakaoAK ${API_KEY}` },
      params: { id: placeId },
    });
    const periods = data.basicInfo?.openHour?.periodList;
    if (!periods?.length) return null;

    // 오늘 요일에 해당하는 시간 찾기
    const dayNames = ["일", "월", "화", "수", "목", "금", "토"];
    const today = dayNames[new Date().getDay()];
    for (const period of periods) {
      for (const time of period.timeList ?? []) {
        if (time.dayOfWeek.includes(today)) {
          // timeSE 형식: "0900~2100" → "09:00-21:00"
          const m = time.timeSE.match(/(\d{2})(\d{2})~(\d{2})(\d{2})/);
          if (m) return `${m[1]}:${m[2]}-${m[3]}:${m[4]}`;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

function isOpenNow(operatingHours: string): boolean {
  const m = operatingHours.match(/(\d{2}):(\d{2})-(\d{2}):(\d{2})/);
  if (!m) return true;
  const now = new Date().getHours() * 60 + new Date().getMinutes();
  const open  = parseInt(m[1]) * 60 + parseInt(m[2]);
  const close = parseInt(m[3]) * 60 + parseInt(m[4]);
  return now >= open && now <= close;
}

// C안: 카카오맵 장소 링크
function kakaoMapUrl(placeId: string): string {
  return `https://place.map.kakao.com/${placeId}`;
}

async function docsToPlaces(
  docs: KakaoDocument[],
  category: Place["category"],
  fetchHours: boolean
): Promise<Place[]> {
  const TOP_N = 3; // Place Detail API는 상위 3개만 호출 (rate limit 방어)

  return Promise.all(
    docs.map(async (doc, i) => {
      const rawHours = fetchHours && i < TOP_N
        ? await fetchOperatingHours(doc.id)
        : null;

      const defaultHours = category === "cafe" ? "09:00-21:00" : "11:00-22:00";
      const operatingHours = rawHours ?? defaultHours;

      return {
        id: `${category}-${doc.id}`,
        name: doc.place_name,
        category,
        coordinates: { lat: parseFloat(doc.y), lng: parseFloat(doc.x) },
        address: doc.road_address_name || doc.address_name,
        walkingMinutes: calcWalkingMinutes(parseInt(doc.distance, 10)),
        operatingHours,
        isOpen: isOpenNow(operatingHours),
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
  return docsToPlaces(docs.slice(0, 5), "cafe", true);
}

export async function getNearByRestaurants(coords: Coordinates): Promise<Place[]> {
  const docs = await searchByCategory("FD6", coords, 8);
  console.log(`[kakao] 음식점 검색 결과: ${docs.length}개`);
  return docsToPlaces(docs.slice(0, 5), "restaurant", true);
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
