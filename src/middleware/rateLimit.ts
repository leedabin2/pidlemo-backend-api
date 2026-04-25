import type { Request, Response, NextFunction } from "express";

interface IpRecord {
  count: number;
  resetAt: number;
}

// 개발 환경에서는 제한 없음. 프로덕션 기본값 5회/일
const IS_DEV = process.env.NODE_ENV !== "production";
const LIMIT_PER_DAY = parseInt(process.env.RATE_LIMIT_PER_DAY ?? "5", 10);

const store = new Map<string, IpRecord>();

function todayMidnight(): number {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

function getIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

// 남은 횟수를 res.locals에 담아 라우터에서 응답에 포함할 수 있게 함
export function ipRateLimit(req: Request, res: Response, next: NextFunction): void {
  if (IS_DEV) {
    res.locals.rateLimitRemaining = null; // 개발 중 제한 없음
    next();
    return;
  }

  const ip = getIp(req);
  const now = Date.now();

  let record = store.get(ip);
  if (!record || now >= record.resetAt) {
    record = { count: 0, resetAt: todayMidnight() };
  }

  record.count += 1;
  store.set(ip, record);

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
