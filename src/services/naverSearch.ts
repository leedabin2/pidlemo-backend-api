import axios from "axios";
import type { Coordinates, Place } from "../types";
import { haversineDistance, calcWalkingMinutes } from "../utils/geo";
import { logger } from "../utils/logger";

const CLIENT_ID = process.env.NAVER_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET ?? "";
const KAKAO_KEY = process.env.KAKAO_REST_API_KEY ?? "";
const ENABLED = !!(CLIENT_ID && CLIENT_SECRET);

const LOCAL_URL = "https://openapi.naver.com/v1/search/local.json";
const BLOG_URL = "https://openapi.naver.com/v1/search/blog.json";
const KAKAO_COORD2ADDR_URL = "https://dapi.kakao.com/v2/local/geo/coord2address.json";
const KAKAO_KEYWORD_URL = "https://dapi.kakao.com/v2/local/search/keyword.json";

// 지역명 + 키워드 조합 (네이버 지역 검색은 좌표 정렬을 지원하지 않으므로 지역 prefix 필수)
// - "쇼룸"은 영구 매장(가구·자동차·인테리어)이 대거 잡혀서 제외
// - 박람회/페어/도서전은 대형 행사(서울국제도서전 등) 누락 방지용 — 노이즈는 카테고리 블랙리스트로 차단
const POPUP_KEYWORDS = ["팝업", "팝업스토어", "플래그십", "전시", "박람회", "페어", "도서전"];

const POPUP_DISTANCE_LIMIT_MIN = 60;
const LOCAL_DISPLAY = 10;
// 운영 중 fallback: 운영기간 파싱 실패 시 최근 N일 글 + 최소 K건이 있어야 채택
// - 짧게 잡아야 2023년 종료된 팝업이 우연히 최근 글 1건이 있다고 통과되지 않음
const RECENT_BLOG_DAYS = 30;
const MIN_RECENT_POSTS = 2;
// 운영 검증 + Kakao placeId 매칭에 사용할 후보 상한 (API 호출 비용 제어)
const ENRICH_LIMIT = 12;
// Naver API QPS 제한(약 10/s) 대응: 동시 호출 수 제한
const NAVER_CONCURRENCY = 3;

async function pMapLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// 팝업/전시로 보기 어려운 업종 (네이버 지역검색 category 필드 부분일치)
// - "자동차": 현대자동차, 기아, 르노 등 대리점이 "팝업 행사" 키워드로 잡힘
// - "금융/은행/보험/증권": 지점 이벤트 잡힘
// - "통신": SKT/KT/LGU+ 대리점
// - "병원/의원/치과/약국": 의료 시설
// - "학원/교습소": 교육
// - "부동산/공인중개": 부동산
// - "주유소/세차": 차량 관련
const POPUP_CATEGORY_BLACKLIST = [
  "자동차", "중고차", "매매상사", "카센터", "정비",
  "은행", "금융", "보험", "증권",
  "통신", "휴대폰판매",
  "병원", "의원", "치과", "약국", "한의원",
  "학원", "교습소", "어학원",
  "부동산", "공인중개",
  "주유소", "세차장",
  "관공서", "사무실",
  "교회", "성당", "사찰",
  "장례식장",
  "설비", "수리", "공사", "철물", "건축",
  // 즉석사진/포토부스 — 별도 photo 카테고리로 잡혀야 하므로 팝업 검색에서는 제외
  "사진관", "셀프사진관", "즉석사진", "포토부스", "셀프스튜디오",
  // 노래방·유아동복 등 영구 매장
  // - "팡파르"(노래방), "이모션캐슬스토어"(유아동복) 등이 fallback으로 잘못 통과되는 케이스 차단
  "노래방", "유아동복", "전시,행사대행",
];

// 카테고리는 다양해도 이름에 이 단어가 들어가면 팝업이 아님 (Naver가 "팝업수전" 같은 명칭 트릭으로 잡힘)
const POPUP_NAME_BLACKLIST = [
  "하수구", "싱크대", "변기", "수전", "누수", "세차",
  "매매상사", "MC섭외", "광고산업", "공구상",
  // 포토부스 브랜드 — 매장명에 들어 있으면 팝업이 아니라 photo 카테고리
  "픽닷", "인생네컷", "포토이즘", "포토그레이", "셀픽스", "하루필름",
  // 전시·박람회 기획 B2B 회사명 (행사 자체가 아닌 주최사·대행사)
  // - "메쎄"(Messe): 라인메쎄, 메쎄이상 같은 전시 기획사
  // - "엑스포기획·이벤트프로모션·전시기획·박람회사무국": 주최/사무국 법인
  "메쎄", "엑스포기획", "이벤트프로모션", "전시기획", "박람회사무국",
  "프로모션센터", "이벤트에이전시", "기획주식회사",
];

function isBlacklistedCategory(category: string): boolean {
  if (!category) return false;
  return POPUP_CATEGORY_BLACKLIST.some((term) => category.includes(term));
}

function isBlacklistedName(name: string): boolean {
  if (!name) return false;
  return POPUP_NAME_BLACKLIST.some((term) => name.includes(term));
}

// 검색 위치와 다른 지역에서 열리는 행사 차단용 키워드
// - Naver 좌표가 주최사·대행사 사무실로 잡혀도 행사 본체는 다른 도시일 수 있음
// - 이름·주소에 다른 지역/행사장명이 명시되어 있으면 제외
const OTHER_VENUE_KEYWORDS = [
  // 광역시·도(서울 제외)
  "부산", "대구", "인천", "광주", "대전", "울산", "세종",
  "경기", "고양", "수원", "성남", "분당", "용인", "안양", "평택", "안산", "의정부",
  "강원", "춘천", "원주", "강릉", "속초",
  "충북", "청주", "충주",
  "충남", "천안", "아산",
  "전북", "전주", "군산",
  "전남", "여수", "순천", "목포",
  "경북", "포항", "경주", "구미", "안동",
  "경남", "창원", "김해", "진주",
  "제주",
  // 대표 행사장(서울 외)
  "킨텍스", "벡스코", "엑스코", "송도컨벤시아", "김대중컨벤션",
  "수원컨벤션", "고양컨벤션", "BEXCO", "EXCO", "KINTEX",
];

// 이름·주소에 검색 위치와 다른 지역 키워드가 있으면 true
// - allowedRegion이 키워드를 포함하면(예: "강남구" 검색 → "강남"은 통과) 해당 키워드는 검사에서 제외
function hasOtherVenueKeyword(name: string, address: string, allowedRegion: string | undefined): boolean {
  const haystack = `${name} ${address}`;
  for (const kw of OTHER_VENUE_KEYWORDS) {
    if (allowedRegion && allowedRegion.includes(kw)) continue;
    if (haystack.includes(kw)) return true;
  }
  return false;
}

// 블로그 본문에 행사 종료를 시사하는 패턴이 있으면 true
// - fallback 채택 직전 검증용: 종료된 대형 행사가 회고/후기 글로 통과되는 것 차단
const POST_END_SIGNAL_RE = /(종료(?:되었|됐|함|되었습니다|됐습니다)|폐막|성료|성황리에\s*마|막을\s*내렸|마무리\s*되었|성공적으로\s*마쳤|마지막\s*날이|마지막날이)/;

// 매장명에서 핵심 토큰(브랜드/이벤트 키워드) 추출
// - 풀네임 includes 매칭은 띄어쓰기/축약 차이로 거의 못 잡힘 → 토큰 OR 매칭으로 완화
// - 위치성 토큰(○○점, ○○역, ○○몰, 광역시·구·동) 및 너무 짧은 토큰 제외
const LOCATION_SUFFIX_RE = /(점|역|몰|관|동|구|시)$/;
const GENERIC_TOKEN = new Set(["팝업", "팝업스토어", "플래그십", "스토어", "이벤트", "오픈", "기념", "콜라보", "한정"]);
function extractNameTokens(name: string): string[] {
  return name
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !LOCATION_SUFFIX_RE.test(t) && !GENERIC_TOKEN.has(t));
}

// 행사장 공간 자체로 등록된 항목 차단 (시설 이름이지 팝업/전시가 아님)
// - "코엑스 Hall C", "그랜드볼룸", "컨퍼런스룸 E", "코엑스 B홀", "오디토리움" 등
// - 공간 키워드만 있고 행사 키워드(팝업/박람회/페어/전시…)가 함께 없으면 제외
const VENUE_SPACE_RE = /(Hall\s*[A-Za-z]|[A-Za-z]\s*홀(?!딩스)|그랜드볼룸|볼룸|오디토리움|컨퍼런스룸|회의실|연회장)/i;
const EVENT_KEYWORD_RE = /(팝업|팝업스토어|플래그십|박람회|페어|도서전|엑스포|전시|페스티벌|콘서트|이벤트|쇼케이스|체험)/;

function isVenueSpaceOnly(name: string): boolean {
  if (!name) return false;
  return VENUE_SPACE_RE.test(name) && !EVENT_KEYWORD_RE.test(name);
}

// Naver popup → Kakao Map 장소 상세 페이지
// - placeId가 있으면 place.map.kakao.com/{id}#home (장소 정보 카드)
// - 없으면 이름+주소 조합 키워드 검색 결과 페이지로 폴백 (버튼이 죽지 않도록)
function buildKakaoMapUrl(name: string, address: string, placeId: string | null): string {
  if (placeId) return `https://place.map.kakao.com/${placeId}#home`;
  const query = [name, address].filter(Boolean).join(" ").trim() || name;
  return `https://map.kakao.com/?q=${encodeURIComponent(query)}`;
}

// 카카오 키워드 검색으로 placeId 1개 회수 (radius 200m 내 가장 가까운 결과)
async function kakaoKeywordSearch(query: string, coords: Coordinates): Promise<string | null> {
  if (!KAKAO_KEY || !query) return null;
  try {
    const { data } = await axios.get(KAKAO_KEYWORD_URL, {
      headers: { Authorization: `KakaoAK ${KAKAO_KEY}` },
      params: {
        query,
        x: coords.lng,
        y: coords.lat,
        radius: 200,
        size: 1,
        sort: "distance",
      },
    });
    return data?.documents?.[0]?.id ?? null;
  } catch (err) {
    logger.warn("naver", "kakao keyword 매칭 실패", {
      query,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// 이름 + 좌표로 placeId 회수, 실패 시 주소로 재시도
async function findKakaoPlaceId(name: string, address: string, coords: Coordinates): Promise<string | null> {
  const byName = await kakaoKeywordSearch(name, coords);
  if (byName) return byName;
  if (address) {
    const byAddress = await kakaoKeywordSearch(address, coords);
    if (byAddress) {
      logger.info("naver", "kakao placeId 주소 폴백 성공", { name, address });
      return byAddress;
    }
  }
  return null;
}

// ── 캐시 (좌표 단위, 6h) ─────────────────────────────────────────
interface CacheEntry<T> { data: T; expiresAt: number }
const popupCache = new Map<string, CacheEntry<Place[]>>();
const blogCountCache = new Map<string, CacheEntry<number>>();
const recentPostsCache = new Map<string, CacheEntry<NaverBlogItem[]>>();
const kakaoIdCache = new Map<string, CacheEntry<string | null>>();
const regionCache = new Map<string, CacheEntry<RegionName>>();
const POPUP_TTL = 6 * 60 * 60 * 1000;
const BLOG_TTL = 24 * 60 * 60 * 1000;
const RECENT_BLOG_TTL = 24 * 60 * 60 * 1000;
const KAKAO_ID_TTL = 7 * 24 * 60 * 60 * 1000;
const REGION_TTL = 7 * 24 * 60 * 60 * 1000;

function cacheKey(coords: Coordinates): string {
  return `${coords.lat.toFixed(2)}_${coords.lng.toFixed(2)}`;
}

interface RegionName {
  region2?: string;  // 구 (예: 성동구)
  region3?: string;  // 동 (예: 성수동)
}

// 카카오 coord2address로 행정구역명 추출 (네이버 검색 쿼리 prefix용)
export async function getRegionName(coords: Coordinates): Promise<RegionName> {
  if (!KAKAO_KEY) return {};
  const key = cacheKey(coords);
  const cached = regionCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  try {
    const { data } = await axios.get(KAKAO_COORD2ADDR_URL, {
      params: { x: coords.lng, y: coords.lat },
      headers: { Authorization: `KakaoAK ${KAKAO_KEY}` },
    });
    const doc = data?.documents?.[0];
    const region: RegionName = {
      region2: doc?.address?.region_2depth_name || doc?.road_address?.region_2depth_name,
      region3: doc?.address?.region_3depth_name || doc?.road_address?.region_3depth_name,
    };
    regionCache.set(key, { data: region, expiresAt: Date.now() + REGION_TTL });
    return region;
  } catch (err) {
    logger.warn("naver", "coord2address 실패", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

// ── 타입 ──────────────────────────────────────────────────────
interface NaverLocalItem {
  title: string;         // <b>강조</b> 태그 포함됨
  link: string;
  category: string;
  description: string;
  telephone: string;
  address: string;       // 지번 주소
  roadAddress: string;
  mapx: string;          // 경도 × 1e7 (WGS84)
  mapy: string;          // 위도 × 1e7 (WGS84)
}

interface NaverBlogItem {
  title: string;
  link: string;
  description: string;
  bloggername: string;
  bloggerlink: string;
  postdate: string;      // YYYYMMDD
}

// ── 유틸 ──────────────────────────────────────────────────────
function stripHtmlTags(s: string): string {
  return s.replace(/<\/?b>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
}

// 네이버 지역 검색 mapx/mapy 디코드
// - 2018년 이후 WGS84 × 1e7 형식이 표준이지만, 일부 응답에서 KATEC(TM)이 섞여 들어옴
// - mapy가 ~370000000 범위면 WGS84(위도 37.x × 1e7), ~440000(KATEC)이면 변환 필요
// - 우선 WGS84 가정으로만 처리하고 비정상 범위는 폐기
function parseCoordinates(mapx: string, mapy: string): Coordinates | null {
  const x = parseInt(mapx, 10);
  const y = parseInt(mapy, 10);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  // WGS84 × 1e7 범위 검증 (한국 영역: 위도 33-39, 경도 124-132)
  const lng = x / 1e7;
  const lat = y / 1e7;
  if (lat >= 33 && lat <= 39 && lng >= 124 && lng <= 132) {
    return { lat, lng };
  }
  return null;
}

function buildHeaders(): Record<string, string> {
  return {
    "X-Naver-Client-Id": CLIENT_ID,
    "X-Naver-Client-Secret": CLIENT_SECRET,
  };
}

// 429 한 번 재시도 (Naver 10/s 제한 짧은 burst 흡수)
async function naverGet<T>(url: string, params: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data } = await axios.get<T>(url, { params, headers: buildHeaders() });
      return data;
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 429 && attempt === 0) {
        await new Promise((r) => setTimeout(r, 1100));
        continue;
      }
      throw err;
    }
  }
  throw new Error("naverGet unreachable");
}

function summarizeErrorData(data: unknown): string {
  if (data === undefined || data === null) return "-";
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

// 최근 블로그 글 5건 조회 (24h 캐시) — 운영 기간 추출 + 최신 날짜 fallback에 사용
async function getRecentBlogPosts(name: string): Promise<NaverBlogItem[]> {
  if (!ENABLED || !name) return [];
  const cached = recentPostsCache.get(name);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  try {
    const data = await naverGet<{ items?: NaverBlogItem[] }>(BLOG_URL, { query: name, display: 5, sort: "date" });
    const items = data?.items ?? [];
    recentPostsCache.set(name, { data: items, expiresAt: Date.now() + RECENT_BLOG_TTL });
    return items;
  } catch (err) {
    const response = (err as { response?: { status?: number; data?: unknown } })?.response;
    logger.warn("naver", "최근 블로그 조회 실패", {
      name,
      status: response?.status ?? "unknown",
      body: summarizeErrorData(response?.data),
    });
    return [];
  }
}

function isWithinDays(yyyymmdd: string | null, days: number): boolean {
  if (!yyyymmdd || !/^\d{8}$/.test(yyyymmdd)) return false;
  const year = parseInt(yyyymmdd.slice(0, 4), 10);
  const month = parseInt(yyyymmdd.slice(4, 6), 10) - 1;
  const day = parseInt(yyyymmdd.slice(6, 8), 10);
  const postTime = new Date(year, month, day).getTime();
  if (!Number.isFinite(postTime)) return false;
  return Date.now() - postTime <= days * 24 * 60 * 60 * 1000;
}

// ── 운영 기간/시간 파싱 ─────────────────────────────────────────
interface OperatingPeriod {
  fromYmd: string;
  toYmd: string;
  display: string;
}

function validYmd(y: number, m: number, d: number): boolean {
  return y >= 2020 && y <= 2030 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

function ymd(y: number, m: number, d: number): string {
  return `${y}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}`;
}

function ymdToTime(s: string): number {
  return new Date(
    parseInt(s.slice(0, 4), 10),
    parseInt(s.slice(4, 6), 10) - 1,
    parseInt(s.slice(6, 8), 10),
  ).getTime();
}

function makePeriod(y1: number, m1: number, d1: number, y2: number, m2: number, d2: number): OperatingPeriod {
  const pad = (n: number) => String(n).padStart(2, "0");
  const display = y1 === y2
    ? `${y1}.${pad(m1)}.${pad(d1)} ~ ${pad(m2)}.${pad(d2)}`
    : `${y1}.${pad(m1)}.${pad(d1)} ~ ${y2}.${pad(m2)}.${pad(d2)}`;
  return { fromYmd: ymd(y1, m1, d1), toYmd: ymd(y2, m2, d2), display };
}

// 풀 날짜 범위: 2026.06.01~2026.06.30, 2026-06-01 - 06.30, 2026/6/1~6/30
// 한국식 표기에서 각 날짜 뒤에 마침표(.)가 붙는 경우(`2026.06.18. ~ 06.20.`)까지 포용
const FULL_RANGE_RE = /(20\d{2})[.\/\-\s](\d{1,2})[.\/\-\s](\d{1,2})\.?\s*[~\-–]\s*(?:(20\d{2})[.\/\-\s])?(\d{1,2})[.\/\-\s](\d{1,2})\.?/;
// 월/일 범위 (한글): 6월 1일~6월 30일, 6월 1일 - 30일
const KO_MD_RANGE_RE = /(\d{1,2})월\s*(\d{1,2})일\s*[~\-–][\s부터까지]*\s*(?:(\d{1,2})월\s*)?(\d{1,2})일/;
// 슬래시 월/일 범위: 6/1~6/30, 06/01-06/30 — 너무 범용이라 "팝업|전시|오픈|기간" 컨텍스트 토큰이 같이 있을 때만
const SLASH_MD_RANGE_RE = /(\d{1,2})[.\/](\d{1,2})\.?\s*[~\-–]\s*(\d{1,2})[.\/](\d{1,2})\.?/;
const PERIOD_CONTEXT_RE = /(팝업|팝업스토어|플래그십|전시|기간|오픈|운영|런칭|EVENT|이벤트)/i;
// 종료일만: "8월 31일까지", "8/31까지", "2026.8.31까지"
const KO_UNTIL_RE = /(?:(20\d{2})[.\/\-\s])?(\d{1,2})월\s*(\d{1,2})일\s*까지/;
// 시간 범위: 11:00 ~ 21:00
const TIME_RANGE_RE = /(\d{1,2}):(\d{2})\s*[~\-–]\s*(\d{1,2}):(\d{2})/;

// 본문에 명시적으로 등장하는 가장 가까운 미래(또는 현재) 연도를 추출
// - 종료된 행사 회고글이 매년 같은 월·일을 언급할 때 `thisYear`로 자동 가정해 잘못 매칭되는 문제 방지
// - 본문에 thisYear 또는 그 이상 연도가 등장하면 신뢰, 과거 연도만 있으면 reject
function inferYearFromText(text: string, thisYear: number): number | null {
  const matches = text.match(/20\d{2}/g);
  if (!matches) return null;
  const years = matches.map((s) => parseInt(s, 10)).filter((y) => y >= 2020 && y <= 2030);
  if (years.length === 0) return null;
  // thisYear와 같거나 이후 연도가 있으면 그중 가장 작은 값을 채택, 없으면 null (=과거)
  const futureOrCurrent = years.filter((y) => y >= thisYear).sort((a, b) => a - b);
  return futureOrCurrent[0] ?? null;
}

function parseOperatingPeriod(text: string): OperatingPeriod | null {
  if (!text) return null;
  const cleaned = text.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  const thisYear = new Date().getFullYear();

  const full = cleaned.match(FULL_RANGE_RE);
  if (full) {
    const y1 = parseInt(full[1], 10);
    const m1 = parseInt(full[2], 10);
    const d1 = parseInt(full[3], 10);
    const y2 = full[4] ? parseInt(full[4], 10) : y1;
    const m2 = parseInt(full[5], 10);
    const d2 = parseInt(full[6], 10);
    if (validYmd(y1, m1, d1) && validYmd(y2, m2, d2)) {
      return makePeriod(y1, m1, d1, y2, m2, d2);
    }
  }

  // 연도 없는 매칭은 본문에 현재/미래 연도가 있을 때만 신뢰
  const md = cleaned.match(KO_MD_RANGE_RE);
  if (md) {
    const inferredYear = inferYearFromText(cleaned, thisYear);
    if (inferredYear !== null) {
      const m1 = parseInt(md[1], 10);
      const d1 = parseInt(md[2], 10);
      const m2 = md[3] ? parseInt(md[3], 10) : m1;
      const d2 = parseInt(md[4], 10);
      let y2 = inferredYear;
      if (m2 < m1 || (m2 === m1 && d2 < d1)) y2 = inferredYear + 1;
      if (validYmd(inferredYear, m1, d1) && validYmd(y2, m2, d2)) {
        return makePeriod(inferredYear, m1, d1, y2, m2, d2);
      }
    }
  }

  // 슬래시 패턴은 버전번호 등과 충돌하므로 팝업 컨텍스트 토큰이 있을 때만 + 연도 검증
  if (PERIOD_CONTEXT_RE.test(cleaned)) {
    const slash = cleaned.match(SLASH_MD_RANGE_RE);
    if (slash) {
      const inferredYear = inferYearFromText(cleaned, thisYear);
      if (inferredYear !== null) {
        const m1 = parseInt(slash[1], 10);
        const d1 = parseInt(slash[2], 10);
        const m2 = parseInt(slash[3], 10);
        const d2 = parseInt(slash[4], 10);
        let y2 = inferredYear;
        if (m2 < m1 || (m2 === m1 && d2 < d1)) y2 = inferredYear + 1;
        if (validYmd(inferredYear, m1, d1) && validYmd(y2, m2, d2)) {
          return makePeriod(inferredYear, m1, d1, y2, m2, d2);
        }
      }
    }
  }

  // "XX월 XX일까지" — 시작일은 오늘로 가정, 연도 없으면 본문 연도 단서 사용
  const until = cleaned.match(KO_UNTIL_RE);
  if (until) {
    let y: number | null = until[1] ? parseInt(until[1], 10) : null;
    if (y === null) y = inferYearFromText(cleaned, thisYear);
    if (y !== null) {
      const m = parseInt(until[2], 10);
      const d = parseInt(until[3], 10);
      if (validYmd(y, m, d)) {
        const now = new Date();
        return makePeriod(now.getFullYear(), now.getMonth() + 1, now.getDate(), y, m, d);
      }
    }
  }

  return null;
}

function parseOperatingTime(text: string): string | null {
  if (!text) return null;
  const m = text.match(TIME_RANGE_RE);
  if (!m) return null;
  const h1 = parseInt(m[1], 10);
  const h2 = parseInt(m[3], 10);
  if (h1 < 0 || h1 > 24 || h2 < 0 || h2 > 24) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}~${m[3].padStart(2, "0")}:${m[4]}`;
}

function isPeriodCurrent(p: OperatingPeriod): boolean {
  const now = Date.now();
  const from = ymdToTime(p.fromYmd);
  const to = ymdToTime(p.toYmd) + 24 * 60 * 60 * 1000;
  return from <= now && now < to;
}

// 종료일이 오늘 이후(=아직 끝나지 않음). 시작 전인 행사도 포함.
function isPeriodNotEnded(p: OperatingPeriod): boolean {
  const now = Date.now();
  const to = ymdToTime(p.toYmd) + 24 * 60 * 60 * 1000;
  return now < to;
}

// findKakaoPlaceId를 7일 캐시로 래핑
async function getKakaoPlaceIdCached(name: string, address: string, coords: Coordinates): Promise<string | null> {
  const key = `${name}__${coords.lat.toFixed(4)}_${coords.lng.toFixed(4)}`;
  const cached = kakaoIdCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.data;
  const id = await findKakaoPlaceId(name, address, coords);
  kakaoIdCache.set(key, { data: id, expiresAt: Date.now() + KAKAO_ID_TTL });
  return id;
}

// ── 지역 검색: 팝업/플래그십 발굴 ─────────────────────────────────
async function searchLocal(query: string, display = LOCAL_DISPLAY): Promise<NaverLocalItem[]> {
  try {
    const data = await naverGet<{ items?: NaverLocalItem[] }>(LOCAL_URL, { query, display, sort: "random" });
    return data?.items ?? [];
  } catch (err) {
    const response = (err as { response?: { status?: number; data?: unknown } })?.response;
    logger.error("naver", "지역 검색 오류", {
      query,
      status: response?.status ?? "unknown",
      body: summarizeErrorData(response?.data),
    });
    return [];
  }
}

export async function getNearByNaverPopups(coords: Coordinates): Promise<Place[]> {
  if (!ENABLED) {
    logger.info("naver", "키 없음 → 스킵");
    return [];
  }

  const key = cacheKey(coords);
  const cached = popupCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    logger.info("naver", "팝업 캐시 HIT", { key, applied: cached.data.length });
    return cached.data;
  }

  // 좌표 → 행정구역명 → 지역 prefix 쿼리 생성
  const region = await getRegionName(coords);
  const prefixes = [region.region3, region.region2].filter((s): s is string => !!s);
  // region3가 동까지 잡히면 동 우선, 구도 보조로 → 둘 다 없으면 generic 쿼리(전국 노이즈)
  const queries: string[] = prefixes.length > 0
    ? prefixes.flatMap((prefix) => POPUP_KEYWORDS.map((kw) => `${prefix} ${kw}`))
    : POPUP_KEYWORDS;

  logger.info("naver", "팝업 쿼리 생성", { region2: region.region2, region3: region.region3, queries: queries.length });

  const results = await pMapLimit(queries, NAVER_CONCURRENCY, (q) => searchLocal(q, LOCAL_DISPLAY));
  // dedup: HTML 태그 차이로 같은 가게가 두 번 들어가는 것 방지
  const merged = new Map<string, NaverLocalItem>();
  results.forEach((items) => items.forEach((it) => {
    const id = `${stripHtmlTags(it.title)}__${it.address}`;
    if (!merged.has(id)) merged.set(id, it);
  }));

  let invalidCoordExcluded = 0;
  let distanceExcluded = 0;
  let categoryExcluded = 0;
  let otherVenueExcluded = 0;
  let venueSpaceExcluded = 0;

  // 지역 키워드 화이트리스트: 검색 위치 기반 (이름/주소에 이 키워드 들어 있으면 OK)
  // - region2(구) + region3(동) 둘 다 후보로 + "서울" 광역 자체도 허용
  const allowedRegionText = [region.region2, region.region3, "서울"].filter(Boolean).join(" ");

  interface BasicCandidate {
    name: string;
    address: string;
    coordinates: Coordinates;
    walkingMinutes: number;
    officialUrl: string;  // Naver 지역검색 응답의 공식 사이트 link (없으면 "")
    category: string;     // Naver 카테고리 원문 (디버깅/사후 분석용)
  }

  const basicCandidates: BasicCandidate[] = [];
  for (const item of merged.values()) {
    const cleanName = stripHtmlTags(item.title);
    if (isBlacklistedCategory(item.category) || isBlacklistedName(cleanName)) {
      categoryExcluded += 1;
      continue;
    }
    // 행사장 공간 자체(Hall/홀/볼룸/오디토리움/컨퍼런스룸) 차단 — 행사명이 같이 없으면 시설
    if (isVenueSpaceOnly(cleanName)) {
      logger.info("naver", "팝업 제외(행사장 공간)", { name: cleanName });
      venueSpaceExcluded += 1;
      continue;
    }
    const itemAddress = item.roadAddress || item.address || "";
    // 다른 지역에서 열리는 행사 차단 — 이름/주소에 검색 위치와 다른 지역 키워드가 있으면 제외
    if (hasOtherVenueKeyword(cleanName, itemAddress, allowedRegionText)) {
      logger.info("naver", "팝업 제외(타지역)", { name: cleanName, address: itemAddress });
      otherVenueExcluded += 1;
      continue;
    }
    const coordsFromItem = parseCoordinates(item.mapx, item.mapy);
    if (!coordsFromItem) {
      invalidCoordExcluded += 1;
      continue;
    }
    const dist = haversineDistance(coords, coordsFromItem);
    const walkingMinutes = calcWalkingMinutes(dist);
    if (walkingMinutes > POPUP_DISTANCE_LIMIT_MIN) {
      distanceExcluded += 1;
      continue;
    }

    basicCandidates.push({
      name: cleanName,
      address: itemAddress,
      coordinates: coordsFromItem,
      walkingMinutes,
      officialUrl: item.link || "",
      category: item.category || "",
    });
  }

  // 가까운 순으로 정렬 후 상한 — 운영검증/카카오매칭 API 호출 비용 제어
  const enrichTargets = basicCandidates
    .sort((a, b) => a.walkingMinutes - b.walkingMinutes)
    .slice(0, ENRICH_LIMIT);

  // 운영 검증(블로그 본문에서 운영기간 추출) + Kakao placeId 매칭
  // - Naver QPS 제한(~10/s) 대응으로 concurrency 제한
  const enriched = await pMapLimit(enrichTargets, NAVER_CONCURRENCY, async (c) => {
    const [allPosts, placeId] = await Promise.all([
      getRecentBlogPosts(c.name),
      getKakaoPlaceIdCached(c.name, c.address, c.coordinates),
    ]);

    // 제목에 매장 핵심 토큰이 포함된 글을 우선 사용 — 잡블로그/연관성 낮은 글 노이즈 차단
    // - 풀네임 includes는 띄어쓰기·축약·접미사 차이로 거의 못 잡혀 토큰 OR 매칭으로 완화
    // - period 추출, sourceBlogUrl, recentCount 모두 제목 매칭 글 기준 (없으면 전체로 폴백)
    const nameTokens = extractNameTokens(c.name);
    const titleMatched = nameTokens.length > 0
      ? allPosts.filter((p) => {
          const title = stripHtmlTags(p.title);
          return nameTokens.some((tok) => title.includes(tok));
        })
      : [];
    const preferredPosts = titleMatched.length > 0 ? titleMatched : allPosts;

    let period: OperatingPeriod | null = null;
    let timeRange: string | null = null;
    // 운영기간을 추출한 글의 링크 (없으면 최신 글로 폴백) — 사용자 검증용 참조 링크
    let periodSourceUrl: string | null = null;
    for (const post of preferredPosts) {
      const text = stripHtmlTags(`${post.title} ${post.description}`);
      if (!period) {
        const p = parseOperatingPeriod(text);
        if (p) {
          period = p;
          periodSourceUrl = post.link || null;
        }
      }
      if (!timeRange) {
        const t = parseOperatingTime(text);
        if (t) timeRange = t;
      }
      if (period && timeRange) break;
    }

    const recentCount = preferredPosts.filter((p) => isWithinDays(p.postdate ?? null, RECENT_BLOG_DAYS)).length;
    // fallback 채택 시 제목 매칭 글의 최신 링크를 참조용으로 사용
    const latestPostUrl = preferredPosts[0]?.link ?? null;
    // 종료 시그널: 제목 매칭 글에 "종료/폐막/성료/막을 내렸/성황리에 마..." 등이 보이면 fallback 차단
    const endSignalDetected = preferredPosts.some((p) => {
      const text = stripHtmlTags(`${p.title} ${p.description}`);
      return POST_END_SIGNAL_RE.test(text);
    });

    return {
      ...c,
      period,
      timeRange,
      recentCount,
      placeId,
      periodSourceUrl,
      latestPostUrl,
      endSignalDetected,
      titleMatchedCount: titleMatched.length,
    };
  });

  let staleExcluded = 0;
  let periodEndedExcluded = 0;
  let upcomingCount = 0;
  let needsVerificationCount = 0;
  let endSignalExcluded = 0;
  let titleUnmatchedExcluded = 0;
  // current: 오늘 운영중 (코스 + 장소탭), upcoming: 아직 시작 전(종료일 미도래) (장소탭만)
  // needsVerification: 운영기간 파싱 실패 + 최근 글로 통과 → 사용자에게 직접 확인 안내
  const fresh: Array<typeof enriched[number] & {
    isUpcoming: boolean;
    needsVerification: boolean;
    sourceBlogUrl: string | null;
  }> = [];
  for (const e of enriched) {
    // 1순위: 운영기간 파싱 성공
    if (e.period) {
      if (isPeriodCurrent(e.period)) {
        logger.info("naver", "팝업 채택(기간파싱:current)", { name: e.name, period: e.period.display, category: e.category });
        fresh.push({ ...e, isUpcoming: false, needsVerification: false, sourceBlogUrl: e.periodSourceUrl });
      } else if (isPeriodNotEnded(e.period)) {
        // 시작 전이지만 아직 종료되지 않음 → 장소탭에서만 노출
        logger.info("naver", "팝업 채택(기간파싱:upcoming)", { name: e.name, period: e.period.display, category: e.category });
        fresh.push({ ...e, isUpcoming: true, needsVerification: false, sourceBlogUrl: e.periodSourceUrl });
        upcomingCount += 1;
      } else {
        logger.info("naver", "팝업 제외(기간파싱:ended)", { name: e.name, period: e.period.display });
        periodEndedExcluded += 1;
      }
      continue;
    }
    // 2순위: 운영기간 못 뽑은 경우
    //   - 본문에 종료 시그널("종료/폐막/성료" 등)이 있으면 무조건 제외
    //   - 그 외엔 최근 30일 글이 2건 이상이어야 "현재 운영"으로 인정 (운영 확인 필요 태그)
    if (e.endSignalDetected) {
      logger.info("naver", "팝업 제외(종료시그널)", { name: e.name, recentCount: e.recentCount });
      endSignalExcluded += 1;
      continue;
    }
    // fallback 채택 전제: 제목에 매장명 핵심 토큰이 들어간 글이 최소 1건 있어야 함
    // - 없으면 무관한 글(예: "팡파르" 검색에 "광주북구 세탁실막힘" 글) 첫 결과가 sourceBlogUrl로 잡혀버림
    if (e.titleMatchedCount === 0) {
      logger.info("naver", "팝업 제외(제목매칭 없음)", {
        name: e.name,
        recentCount: e.recentCount,
        category: e.category,
      });
      titleUnmatchedExcluded += 1;
      continue;
    }
    if (e.recentCount >= MIN_RECENT_POSTS) {
      logger.info("naver", "팝업 채택(fallback:최근글)", {
        name: e.name,
        recentCount: e.recentCount,
        titleMatched: e.titleMatchedCount,
        category: e.category,
      });
      fresh.push({ ...e, isUpcoming: false, needsVerification: true, sourceBlogUrl: e.latestPostUrl });
      needsVerificationCount += 1;
    } else {
      logger.info("naver", "팝업 제외(stale)", { name: e.name, recentCount: e.recentCount });
      staleExcluded += 1;
    }
  }

  const result: Place[] = fresh.slice(0, 10).map((c) => {
    const periodText = c.period?.display;
    const operatingHours = periodText && c.timeRange
      ? `${periodText} · ${c.timeRange}`
      : periodText ?? (c.timeRange ?? "운영시간 확인 필요");
    const tags: string[] = [];
    if (c.needsVerification) tags.push("운영 확인 필요");
    // 검증용 참조 링크 우선순위 (운영기간 확인 가능성 순):
    // 1) 운영기간을 추출한 블로그 글 — 본문에 기간이 명시되어 있음
    // 2) 최신 블로그 글 (fallback 채택 시) — 최신 후기로 운영 여부 확인 가능
    // 3) 공식 사이트 — brand.naver.com 같은 카테고리 페이지는 기간 없는 경우 많아 최후 폴백
    const verifyUrl = c.sourceBlogUrl || c.officialUrl || undefined;
    return {
      id: `naver-popup-${c.name}-${c.address}`.replace(/\s+/g, "_"),
      name: c.name,
      category: "popup",
      coordinates: c.coordinates,
      address: c.address,
      walkingMinutes: c.walkingMinutes,
      operatingHours,
      operatingHoursMayDiffer: true,
      isOpen: null,
      tags,
      source: "public_data",
      kakaoMapUrl: buildKakaoMapUrl(c.name, c.address, c.placeId),
      isUpcoming: c.isUpcoming || undefined,
      sourceBlogUrl: verifyUrl,
    };
  });

  logger.info("naver", "팝업 수집 결과", {
    queries: queries.length,
    raw: merged.size,
    categoryExcluded,
    venueSpaceExcluded,
    otherVenueExcluded,
    invalidCoordExcluded,
    distanceExcluded,
    enriched: enrichTargets.length,
    periodEndedExcluded,
    endSignalExcluded,
    titleUnmatchedExcluded,
    staleExcluded,
    upcoming: upcomingCount,
    needsVerification: needsVerificationCount,
    applied: result.length,
  });

  popupCache.set(key, { data: result, expiresAt: Date.now() + POPUP_TTL });
  return result;
}

// ── 블로그 검색 count: 인기도 proxy ─────────────────────────────
export async function getNaverBlogCount(name: string): Promise<number> {
  if (!ENABLED || !name) return 0;

  const cached = blogCountCache.get(name);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  try {
    const data = await naverGet<{ total?: number }>(BLOG_URL, { query: name, display: 1 });
    const total = typeof data?.total === "number" ? data.total : 0;
    blogCountCache.set(name, { data: total, expiresAt: Date.now() + BLOG_TTL });
    return total;
  } catch (err) {
    const response = (err as { response?: { status?: number; data?: unknown } })?.response;
    logger.error("naver", "블로그 검색 오류", {
      name,
      status: response?.status ?? "unknown",
      body: summarizeErrorData(response?.data),
    });
    return 0;
  }
}

// 여러 장소의 블로그 count를 병렬로 (호출 수 제한: items.length만큼)
export async function attachNaverBlogCounts<T extends { name: string }>(
  items: T[],
): Promise<Array<T & { blogCount: number }>> {
  if (!ENABLED) return items.map((p) => ({ ...p, blogCount: 0 }));

  const counts = await Promise.all(items.map((p) => getNaverBlogCount(p.name)));
  return items.map((p, i) => ({ ...p, blogCount: counts[i] }));
}

// 가져온 blog count로 인기도 가중치 산출 (0-10 점)
// - 100건 이상: +2
// - 1,000건 이상: +4
// - 5,000건 이상: +7
// - 20,000건 이상: +10
export function blogCountToScore(blogCount: number): number {
  if (blogCount >= 20000) return 10;
  if (blogCount >= 5000) return 7;
  if (blogCount >= 1000) return 4;
  if (blogCount >= 100) return 2;
  return 0;
}
