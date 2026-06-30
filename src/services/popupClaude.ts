import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import type { Coordinates, Place } from "../types";
import { haversineDistance, calcWalkingMinutes } from "../utils/geo";
import { isSeoul } from "../utils/region";
import { logger } from "../utils/logger";

// ─────────────────────────────────────────────────────────────
// Claude + web_search 기반 팝업/전시 수집기 (region 단위)
// - 좌표 그리드 X → 지역(서울/그 외) 단위로 한 번에 광역 수집 → 좌표 필터
// - lazy refresh: TTL 만료 후 첫 사용자 요청에서 1회 호출
// - 결과별 TTL(성공/빈/실패) + 월 예산 가드 + 부팅 시 14일↑ 파일 청소
// ─────────────────────────────────────────────────────────────

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });
const ENABLED = !!process.env.ANTHROPIC_API_KEY;

const CACHE_DIR = path.join(process.cwd(), "cache");
const POPUP_CACHE_DIR = path.join(CACHE_DIR, "popup");
const USAGE_FILE = path.join(CACHE_DIR, "usage_claude.json");
const MONTHLY_BUDGET_USD = Number(process.env.POPUP_CLAUDE_MONTHLY_BUDGET_USD ?? "5");
const MODEL = process.env.POPUP_CLAUDE_MODEL ?? "claude-haiku-4-5-20251001";
// 가격 ($/MTok) — 모델 바꾸면 env로 같이 덮어쓰기 (기본값은 Haiku 4.5 기준)
const PRICE_INPUT_PER_MTOK = Number(process.env.POPUP_CLAUDE_PRICE_INPUT_PER_MTOK ?? "1.0");
const PRICE_OUTPUT_PER_MTOK = Number(process.env.POPUP_CLAUDE_PRICE_OUTPUT_PER_MTOK ?? "5.0");
// Anthropic web_search: $10 / 1,000 calls
const PRICE_WEB_SEARCH_PER_CALL = 0.01;
const MAX_WEB_SEARCH_USES = Number(process.env.POPUP_CLAUDE_MAX_WEB_SEARCH ?? "3");

// 결과별 TTL (ms) — 성공 7일, 빈 결과 24시간, 호출 실패 12시간
const TTL_OK_MS = Number(process.env.POPUP_CLAUDE_TTL_OK_HOURS ?? "168") * 3600_000;
const TTL_EMPTY_MS = Number(process.env.POPUP_CLAUDE_TTL_EMPTY_HOURS ?? "24") * 3600_000;
const TTL_ERROR_MS = Number(process.env.POPUP_CLAUDE_TTL_ERROR_HOURS ?? "12") * 3600_000;
const CLEANUP_OLDER_THAN_DAYS = Number(process.env.POPUP_CLAUDE_CLEANUP_DAYS ?? "14");

fs.mkdirSync(POPUP_CACHE_DIR, { recursive: true });

// 부팅 시 오래된 캐시 파일 청소 (블로킹, 1회만 실행)
function cleanupStaleCacheFiles(): void {
  const cutoff = Date.now() - CLEANUP_OLDER_THAN_DAYS * 86400_000;
  try {
    const files = fs.readdirSync(POPUP_CACHE_DIR);
    let removed = 0;
    for (const f of files) {
      const full = path.join(POPUP_CACHE_DIR, f);
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(full);
          removed += 1;
        }
      } catch {
        // 개별 파일 실패는 무시
      }
    }
    if (removed > 0) {
      logger.info("popupClaude", "부팅 캐시 청소", { removed, olderThanDays: CLEANUP_OLDER_THAN_DAYS });
    }
  } catch {
    // 디렉토리 자체 접근 실패는 무시
  }
}
cleanupStaleCacheFiles();

// ── 비용 누적 (월별 파일 영속화) ─────────────────────────────
interface UsageEntry { usd: number; calls: number }
type UsageStore = Record<string, UsageEntry>;

function readUsage(): UsageStore {
  try {
    return JSON.parse(fs.readFileSync(USAGE_FILE, "utf-8")) as UsageStore;
  } catch {
    return {};
  }
}

function writeUsage(s: UsageStore): void {
  fs.writeFileSync(USAGE_FILE, JSON.stringify(s, null, 2));
}

function monthKey(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export function getMonthlyClaudeUsd(): number {
  return readUsage()[monthKey()]?.usd ?? 0;
}

function addUsage(usd: number): void {
  const store = readUsage();
  const k = monthKey();
  const prev = store[k] ?? { usd: 0, calls: 0 };
  store[k] = { usd: prev.usd + usd, calls: prev.calls + 1 };
  writeUsage(store);
}

// ── 지역 정의 ───────────────────────────────────────────────
interface RegionInfo {
  key: string;
  label: string;
  hints: string;  // 검색어 유도용 랜드마크 힌트
}

function resolveRegion(coords: Coordinates): RegionInfo {
  if (isSeoul(coords)) {
    return {
      key: "seoul",
      label: "서울",
      hints: "성수, 더현대 서울(여의도), 코엑스/스타필드(삼성), 잠실 롯데월드몰, 홍대, 강남, 신사, 한남, 명동, 동대문",
    };
  }
  return {
    key: "default",
    label: "수도권",
    hints: "송도 트리플스트리트, 일산 스타필드, 분당, 판교, 인천 차이나타운",
  };
}

// ── 캐시 (지역 단위, 결과별 TTL) ────────────────────────────
function cachePath(regionKey: string): string {
  return path.join(POPUP_CACHE_DIR, `region_${regionKey}.json`);
}

type CacheStatus = "ok" | "empty" | "error";

interface CachedPopup {
  generatedAt: number;
  expiresAt: number;
  status: CacheStatus;
  regionKey: string;
  items: PopupItem[];
}

function ttlFor(status: CacheStatus): number {
  if (status === "ok") return TTL_OK_MS;
  if (status === "empty") return TTL_EMPTY_MS;
  return TTL_ERROR_MS;
}

function writeCache(regionKey: string, status: CacheStatus, items: PopupItem[]): void {
  const now = Date.now();
  const payload: CachedPopup = {
    generatedAt: now,
    expiresAt: now + ttlFor(status),
    status,
    regionKey,
    items,
  };
  fs.writeFileSync(cachePath(regionKey), JSON.stringify(payload, null, 2));
}

function readCache(regionKey: string): CachedPopup | null {
  const cp = cachePath(regionKey);
  if (!fs.existsSync(cp)) return null;
  try {
    return JSON.parse(fs.readFileSync(cp, "utf-8")) as CachedPopup;
  } catch {
    return null;
  }
}

interface PopupItem {
  name: string;
  address: string;
  lat: number;
  lng: number;
  fromYmd: string;        // YYYYMMDD
  toYmd: string;          // YYYYMMDD
  operatingHours?: string;
  sourceUrl?: string;
  category?: string;
}

function todayYmd(now = new Date()): string {
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
}

function isActiveToday(p: PopupItem): boolean {
  const t = todayYmd();
  return p.fromYmd <= t && t <= p.toYmd;
}

// PopupItem → Place 변환
function toPlace(userCoords: Coordinates) {
  return (p: PopupItem): Place => {
    const coordinates: Coordinates = { lat: p.lat, lng: p.lng };
    const dist = haversineDistance(userCoords, coordinates);
    const walkingMinutes = calcWalkingMinutes(dist);
    const fromD = `${p.fromYmd.slice(0, 4)}.${p.fromYmd.slice(4, 6)}.${p.fromYmd.slice(6, 8)}`;
    const toD = `${p.toYmd.slice(0, 4)}.${p.toYmd.slice(4, 6)}.${p.toYmd.slice(6, 8)}`;
    const operatingHours = p.operatingHours
      ? `${fromD} ~ ${toD} · ${p.operatingHours}`
      : `${fromD} ~ ${toD}`;
    const query = `${p.name} ${p.address}`.trim();
    return {
      id: `claude-popup-${p.name}-${p.address}`.replace(/\s+/g, "_"),
      name: p.name,
      category: "popup",
      coordinates,
      address: p.address,
      walkingMinutes,
      operatingHours,
      operatingHoursMayDiffer: false,
      isOpen: null,
      tags: [],
      source: "public_data",
      kakaoMapUrl: `https://map.kakao.com/?q=${encodeURIComponent(query)}`,
      sourceBlogUrl: p.sourceUrl,
    };
  };
}

function buildRegionPrompt(region: RegionInfo): string {
  const today = new Date().toISOString().slice(0, 10);
  return `오늘 (${today}) 기준 "${region.label}" 전역에서 운영 중인 팝업스토어 / 전시 / 박람회 / 플래그십을 web_search로 30~50개 찾아.

주요 거점 힌트: ${region.hints}

검색 사이트 우선순위 (큐레이션 → 위키 → 공식):
- popply.co.kr (지도/달력 기반 팝업)
- popga.co.kr (성수/더현대/홍대 팝업 일정)
- namu.wiki (더현대 서울, 롯데월드몰, 코엑스 같은 대형 venue 팝업 라인업)
- 백화점/venue 공식 사이트

규칙:
- 시작일 ≤ 오늘 ≤ 종료일 인 행사만
- 영구 매장, 노래방, 일반 카페·식당, 대행/기획사 법인 제외
- 행사장 공간 자체(Hall C, 그랜드볼룸)는 제외, 행사명이 분리되어야 함
- "${region.label}" 외 다른 광역시·도(킨텍스·벡스코 등) 행사는 제외
- 각 항목마다 정확한 lat/lng 좌표 + 운영기간을 본문에 명시한 출처 URL 첨부
- 검증 안 되면 빼고, 추측 금지

응답은 JSON 배열로만 (다른 설명·코드블록 없이):
[{"name":"행사명","address":"주소","lat":37.xx,"lng":127.xx,"fromYmd":"YYYYMMDD","toYmd":"YYYYMMDD","operatingHours":"11:00~21:00","sourceUrl":"https://...","category":"팝업"}]

찾지 못하면 [] 만 반환.`;
}

interface UsageBlock {
  input_tokens: number;
  output_tokens: number;
  server_tool_use?: { web_search_requests?: number };
}

function estimateUsd(u: UsageBlock): { usd: number; webSearchCalls: number } {
  const webSearchCalls = u.server_tool_use?.web_search_requests ?? 0;
  const usd =
    (u.input_tokens / 1e6) * PRICE_INPUT_PER_MTOK +
    (u.output_tokens / 1e6) * PRICE_OUTPUT_PER_MTOK +
    webSearchCalls * PRICE_WEB_SEARCH_PER_CALL;
  return { usd, webSearchCalls };
}

// 지역 단위로 Claude 호출 (lazy refresh)
async function fetchRegionalPopups(region: RegionInfo): Promise<CacheStatus> {
  const usedUsd = getMonthlyClaudeUsd();
  if (usedUsd >= MONTHLY_BUDGET_USD) {
    logger.info("popupClaude", "월 예산 초과 → 호출 스킵", {
      monthlyUsd: usedUsd.toFixed(4),
      budgetUsd: MONTHLY_BUDGET_USD,
    });
    return "error";
  }

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8192,  // region-wide → 출력 크기 큼
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: MAX_WEB_SEARCH_USES,
        } as unknown as Anthropic.Messages.Tool,
      ],
      messages: [{ role: "user", content: buildRegionPrompt(region) }],
    });

    const { usd, webSearchCalls } = estimateUsd(response.usage as unknown as UsageBlock);
    addUsage(usd);

    const textBlock = response.content.find((b): b is Anthropic.Messages.TextBlock => b.type === "text");
    const text = textBlock?.text ?? "[]";
    const m = text.match(/\[[\s\S]*\]/);
    const items: PopupItem[] = m ? (JSON.parse(m[0]) as PopupItem[]) : [];

    const status: CacheStatus = items.length > 0 ? "ok" : "empty";
    writeCache(region.key, status, items);

    logger.info("popupClaude", "지역 호출 완료", {
      region: region.key,
      status,
      total: items.length,
      activeToday: items.filter(isActiveToday).length,
      webSearchCalls,
      costUsd: usd.toFixed(4),
      monthlyUsd: (usedUsd + usd).toFixed(4),
      budgetUsd: MONTHLY_BUDGET_USD,
    });
    return status;
  } catch (err) {
    try { writeCache(region.key, "error", []); } catch { /* 캐시 쓰기 실패는 무시 */ }
    logger.error("popupClaude", "호출 실패 → 실패 캐시 기록", {
      region: region.key,
      error: err instanceof Error ? err.message : String(err),
      ttlErrorHours: TTL_ERROR_MS / 3600_000,
    });
    return "error";
  }
}

// 메인 진입점: 사용자 좌표/반경 → 지역 캐시 로드(만료 시 lazy fetch) → 거리 필터
export async function getClaudePopups(
  coords: Coordinates,
  radiusMeters: number,
): Promise<Place[] | null> {
  if (!ENABLED) {
    logger.info("popupClaude", "키 없음 → 스킵");
    return null;
  }

  const region = resolveRegion(coords);

  // 1) 캐시 확인 (만료면 lazy fetch)
  let cached = readCache(region.key);
  if (!cached || !cached.expiresAt || Date.now() >= cached.expiresAt) {
    logger.info("popupClaude", "캐시 미존재/만료 → lazy fetch", {
      region: region.key,
      hadCache: !!cached,
      prevStatus: cached?.status,
    });
    await fetchRegionalPopups(region);
    cached = readCache(region.key);
  } else {
    logger.info("popupClaude", "캐시 HIT", {
      region: region.key,
      status: cached.status,
      total: cached.items.length,
      ttlLeftMin: Math.round((cached.expiresAt - Date.now()) / 60000),
    });
  }

  // 2) 캐시 결과 처리
  if (!cached || cached.status === "error") return null;

  // 3) 오늘 운영 중 + 사용자 반경 안 필터
  const nearby = cached.items
    .filter(isActiveToday)
    .filter((p) => haversineDistance(coords, { lat: p.lat, lng: p.lng }) <= radiusMeters);

  logger.info("popupClaude", "거리 필터 적용", {
    region: region.key,
    cached: cached.items.length,
    activeToday: cached.items.filter(isActiveToday).length,
    withinRadius: nearby.length,
    radiusMeters,
  });

  return nearby.map(toPlace(coords));
}
