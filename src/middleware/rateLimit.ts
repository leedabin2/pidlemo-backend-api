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
  res.locals.rateLimitRemaining = null;
  next();
}
