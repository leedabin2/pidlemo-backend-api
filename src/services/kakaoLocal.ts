import axios from "axios";
import type { Coordinates, Place } from "../types";

const API_KEY = process.env.KAKAO_REST_API_KEY ?? "";
const BASE_URL = "https://dapi.kakao.com/v2/local/search/keyword.json";
const RADIUS = 1500; // 반경 1.5km

// 도보 속도: 약 80m/분
function calcWalkingMinutes(distanceMeters: number): number {
  return Math.round(distanceMeters / 80);
}

function isCurrentlyOpen(openingHours?: string): boolean {
  if (!openingHours) return true;
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const current = hour * 60 + minute;

  const match = openingHours.match(/(\d{2}):(\d{2})\s*[-~]\s*(\d{2}):(\d{2})/);
  if (!match) return true;

  const open = parseInt(match[1]) * 60 + parseInt(match[2]);
  const close = parseInt(match[3]) * 60 + parseInt(match[4]);
  return current >= open && current <= close;
}

interface KakaoDocument {
  id: string;
  place_name: string;
  address_name: string;
  road_address_name: string;
  x: string; // lng
  y: string; // lat
  distance: string;
  category_group_code: string;
}

async function searchByKeyword(
  query: string,
  coords: Coordinates,
  size = 5
): Promise<KakaoDocument[]> {
  if (!API_KEY) return [];

  const { data } = await axios.get(BASE_URL, {
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

  return data.documents ?? [];
}

export async function getNearByCafes(coords: Coordinates): Promise<Place[]> {
  const docs = await searchByKeyword("카페", coords, 5);

  return docs.map((doc, i) => ({
    id: `cafe-${doc.id}`,
    name: doc.place_name,
    category: "cafe" as const,
    coordinates: { lat: parseFloat(doc.y), lng: parseFloat(doc.x) },
    address: doc.road_address_name || doc.address_name,
    walkingMinutes: calcWalkingMinutes(parseInt(doc.distance, 10)),
    operatingHours: "09:00-21:00", // 카카오 Local API는 영업시간 미제공 → 추후 Place API로 보완
    isOpen: i < 3, // 간단한 임시 처리 (실제는 Place detail API 필요)
    tags: [],
    source: "kakao" as const,
  }));
}

export async function getNearByRestaurants(coords: Coordinates): Promise<Place[]> {
  const docs = await searchByKeyword("맛집", coords, 5);

  return docs.map((doc) => ({
    id: `restaurant-${doc.id}`,
    name: doc.place_name,
    category: "restaurant" as const,
    coordinates: { lat: parseFloat(doc.y), lng: parseFloat(doc.x) },
    address: doc.road_address_name || doc.address_name,
    walkingMinutes: calcWalkingMinutes(parseInt(doc.distance, 10)),
    operatingHours: "11:00-22:00",
    isOpen: isCurrentlyOpen("11:00-22:00"),
    tags: [],
    source: "kakao" as const,
  }));
}

// API 키 없을 때 개발용 목업
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
      representativeMenus: [
        { name: "아이스 아메리카노", price: 4500 },
        { name: "카페라떼", price: 5000 },
      ],
      tags: [],
      source: "kakao",
    },
  ];
}
