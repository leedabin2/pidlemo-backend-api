import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import type { Coordinates, Place } from "../types";
import { haversineDistance, calcWalkingMinutes } from "../utils/geo";
import { logger } from "../utils/logger";

// ─────────────────────────────────────────────────────────────
// Claude + web_search 기반 팝업/전시 수집기
// - Naver raw를 통한 노이즈 누적 한계로, LLM에 검색·정제·판정 일임
// - 그리드 파일 캐시 + 결과별 TTL(성공/빈/실패) + 부팅 시 14일↑ 파일 청소
// - 월 예산 한도 도달 시 null 반환 (호출측에서 naver fallback)
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
const MAX_WEB_SEARCH_USES = Number(process.env.POPUP_CLAUDE_MAX_WEB_SEARCH ?? "2");
// 검색 도메인 화이트리스트 (쉼표 구분) — 빈 값이면 제한 없음
const ALLOWED_DOMAINS = (process.env.POPUP_CLAUDE_ALLOWED_DOMAINS
  ?? "popply.co.kr,popga.co.kr,dayforyou.com,namu.wiki")
  .split(",").map((s) => s.trim()).filter(Boolean);

// 결과별 TTL (ms) — 성공 7일, 빈 결과 24시간, 호출 실패 12시간
const TTL_OK_MS = Number(process.env.POPUP_CLAUDE_TTL_OK_HOURS ?? "168") * 3600_000;
const TTL_EMPTY_MS = Number(process.env.POPUP_CLAUDE_TTL_EMPTY_HOURS ?? "24") * 3600_000;
const TTL_ERROR_MS = Number(process.env.POPUP_CLAUDE_TTL_ERROR_HOURS ?? "12") * 3600_000;
// 부팅 청소: mtime이 N일 이상 안 건드린 캐시 파일 삭제
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

// ── 캐시 (위치 그리드, 결과별 TTL) ──────────────────────────
function gridKey(c: Coordinates): string {
  return `${c.lat.toFixed(2)}_${c.lng.toFixed(2)}`;
}

function cachePath(c: Coordinates): string {
  return path.join(POPUP_CACHE_DIR, `${gridKey(c)}.json`);
}

type CacheStatus = "ok" | "empty" | "error";

interface CachedPopup {
  generatedAt: number;
  expiresAt: number;
  status: CacheStatus;
  items: PopupItem[];
}

function ttlFor(status: CacheStatus): number {
  if (status === "ok") return TTL_OK_MS;
  if (status === "empty") return TTL_EMPTY_MS;
  return TTL_ERROR_MS;
}

function writeCache(c: Coordinates, status: CacheStatus, items: PopupItem[]): void {
  const now = Date.now();
  const payload: CachedPopup = {
    generatedAt: now,
    expiresAt: now + ttlFor(status),
    status,
    items,
  };
  fs.writeFileSync(cachePath(c), JSON.stringify(payload, null, 2));
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

// PopupItem → Place 변환 (위경도 거리 계산)
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

function buildPrompt(coords: Coordinates, regionLabel: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const sites = ALLOWED_DOMAINS.length
    ? `\n검색 사이트 (큐레이션·달력 기반, 운영기간 명시):\n- popply.co.kr (지도 기반 팝업 검색)\n- popga.co.kr (성수/더현대/홍대 팝업 일정 정리)\n- dayforyou.com (날짜·지역별 달력 조회)\n- namu.wiki (대형 백화점 팝업 라인업 정리)\n`
    : "";
  return `오늘 (${today}) 기준 "${regionLabel}" 일대 (위도 ${coords.lat}, 경도 ${coords.lng}, 도보 30분 반경) 운영 중인 팝업스토어 / 전시 / 박람회 / 플래그십을 web_search로 찾아.
${sites}
규칙:
- 시작일 ≤ 오늘 ≤ 종료일 인 행사만 (오늘 운영 중)
- 영구 매장, 노래방, 일반 카페·식당, 대행/기획사 법인 제외
- 행사장 공간 자체(Hall C, 그랜드볼룸)는 제외, 행사명이 분리되어야 함
- 검색 위치와 다른 지역(타 광역시·도, 킨텍스·벡스코 등) 행사는 제외
- 각 항목마다 운영기간을 본문에 명시한 출처 URL 첨부 (위 큐레이션 사이트 우선)
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

// 메인 진입점: Claude 결과 반환 / 예산 초과·실패·미설정 시 null (호출측에서 fallback)
export async function getClaudePopups(
  coords: Coordinates,
  regionLabel: string,
): Promise<Place[] | null> {
  if (!ENABLED) {
    logger.info("popupClaude", "키 없음 → 스킵");
    return null;
  }

  // 1) 캐시 HIT → expiresAt 체크 + 종료일 재필터
  const cp = cachePath(coords);
  if (fs.existsSync(cp)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cp, "utf-8")) as CachedPopup;
      if (cached.expiresAt && Date.now() < cached.expiresAt) {
        const fresh = cached.items.filter(isActiveToday);
        logger.info("popupClaude", "캐시 HIT", {
          key: gridKey(coords),
          status: cached.status,
          total: cached.items.length,
          activeToday: fresh.length,
          ttlLeftMin: Math.round((cached.expiresAt - Date.now()) / 60000),
        });
        // 실패 캐시는 fallback 트리거를 위해 null 반환 (재호출은 막음)
        if (cached.status === "error") return null;
        return fresh.map(toPlace(coords));
      }
      logger.info("popupClaude", "캐시 만료 → 재호출", { key: gridKey(coords), status: cached.status });
    } catch (err) {
      logger.warn("popupClaude", "캐시 파싱 실패 → 재호출", { error: String(err) });
    }
  }

  // 2) 월 예산 가드 — 임계치 도달 시 호출 차단
  const usedUsd = getMonthlyClaudeUsd();
  if (usedUsd >= MONTHLY_BUDGET_USD) {
    logger.info("popupClaude", "월 예산 초과 → fallback", {
      monthlyUsd: usedUsd.toFixed(4),
      budgetUsd: MONTHLY_BUDGET_USD,
    });
    return null;
  }

  // 3) Claude 호출
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: MAX_WEB_SEARCH_USES,
          ...(ALLOWED_DOMAINS.length ? { allowed_domains: ALLOWED_DOMAINS } : {}),
        } as unknown as Anthropic.Messages.Tool,
      ],
      messages: [{ role: "user", content: buildPrompt(coords, regionLabel) }],
    });

    const { usd, webSearchCalls } = estimateUsd(response.usage as unknown as UsageBlock);
    addUsage(usd);

    const textBlock = response.content.find((b): b is Anthropic.Messages.TextBlock => b.type === "text");
    const text = textBlock?.text ?? "[]";
    const m = text.match(/\[[\s\S]*\]/);
    const items: PopupItem[] = m ? (JSON.parse(m[0]) as PopupItem[]) : [];

    const status: CacheStatus = items.length > 0 ? "ok" : "empty";
    writeCache(coords, status, items);

    const fresh = items.filter(isActiveToday);
    logger.info("popupClaude", "신규 호출 완료", {
      key: gridKey(coords),
      regionLabel,
      status,
      total: items.length,
      activeToday: fresh.length,
      webSearchCalls,
      costUsd: usd.toFixed(4),
      monthlyUsd: (usedUsd + usd).toFixed(4),
      budgetUsd: MONTHLY_BUDGET_USD,
    });
    return fresh.map(toPlace(coords));
  } catch (err) {
    // 호출 실패도 짧은 TTL로 캐시 → 연쇄 재시도/비용 폭주 방지
    try { writeCache(coords, "error", []); } catch { /* 캐시 쓰기 실패는 무시 */ }
    logger.error("popupClaude", "호출 실패 → fallback (실패 캐시 기록)", {
      error: err instanceof Error ? err.message : String(err),
      ttlErrorHours: TTL_ERROR_MS / 3600_000,
    });
    return null;
  }
}
