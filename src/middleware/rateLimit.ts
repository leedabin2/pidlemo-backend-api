import type { Request, Response, NextFunction } from "express";

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

const IS_DEV = process.env.NODE_ENV !== "production";
const LIMIT_PER_DAY = parseInt(process.env.RATE_LIMIT_PER_DAY ?? "5", 10);

const store = new Map<string, RateLimitRecord>();

function kstMidnight(): number {
  const kst = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  kst.setHours(24, 0, 0, 0);
  return kst.getTime();
}

// 나중에 유저 식별키(토큰, 기기ID 등)로 교체 가능
function getIdentifier(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

export function ipRateLimit(req: Request, res: Response, next: NextFunction): void {
  if (IS_DEV) {
    res.locals.rateLimitRemaining = null;
    next();
    return;
  }

  const id = getIdentifier(req);
  const now = Date.now();

  let record = store.get(id);
  if (!record || now >= record.resetAt) {
    record = { count: 0, resetAt: kstMidnight() };
  }

  record.count += 1;
  store.set(id, record);

  const remaining = Math.max(0, LIMIT_PER_DAY - record.count);
  res.locals.rateLimitRemaining = remaining;

  if (record.count > LIMIT_PER_DAY) {
    res.status(429).json({
      error: "오늘 추천 횟수를 모두 사용했어요. 내일 다시 시도해주세요.",
      remainingToday: 0,
      resetAt: record.resetAt,
    });
    return;
  }

  next();
}
