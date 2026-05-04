type LogLevel = "INFO" | "WARN" | "ERROR";

function timestamp(): string {
  return new Date().toLocaleTimeString("ko-KR", {
    hour12: false,
    timeZone: "Asia/Seoul",
  });
}

function formatMeta(meta?: Record<string, unknown>): string {
  if (!meta) return "";
  const entries = Object.entries(meta).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return "";
  return entries
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
}

function print(level: LogLevel, scope: string, message: string, meta?: Record<string, unknown>): void {
  const base = `[${timestamp()}] [${level}] [${scope}] ${message}`;
  const suffix = formatMeta(meta);
  const line = suffix ? `${base} | ${suffix}` : base;

  if (level === "ERROR") {
    console.error(line);
    return;
  }
  if (level === "WARN") {
    console.warn(line);
    return;
  }
  console.log(line);
}

export const logger = {
  info(scope: string, message: string, meta?: Record<string, unknown>) {
    print("INFO", scope, message, meta);
  },
  warn(scope: string, message: string, meta?: Record<string, unknown>) {
    print("WARN", scope, message, meta);
  },
  error(scope: string, message: string, meta?: Record<string, unknown>) {
    print("ERROR", scope, message, meta);
  },
  list(scope: string, title: string, items: string[], max = 12) {
    const visible = items.slice(0, max);
    const suffix = items.length > max ? ` 외 ${items.length - max}개` : "";
    print("INFO", scope, `${title}: ${visible.join(", ")}${suffix}`);
  },
  block(scope: string, title: string, lines: string[]) {
    print("INFO", scope, title);
    for (const line of lines) {
      console.log(`  - ${line}`);
    }
  },
};
