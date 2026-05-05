import "dotenv/config";
import express from "express";
import cors from "cors";
import recommendRouter from "./routes/recommend";
import routeRouter from "./routes/route";
import { logger } from "./utils/logger";

const app = express();
const PORT = process.env.PORT ?? 4000;

const explicitAllowedOrigins = [
  "http://localhost:5173",
  "http://localhost:4173",
  "https://pidle-app.vercel.app",
  ...(process.env.FRONTEND_ORIGINS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
];

function isAllowedOrigin(origin: string): boolean {
  if (explicitAllowedOrigins.includes(origin)) return true;

  try {
    const url = new URL(origin);
    const host = url.hostname;

    if (host === "localhost" || host === "127.0.0.1") return true;
    if (host.endsWith(".vercel.app")) return true;
    if (host.endsWith(".ngrok-free.app") || host.endsWith(".ngrok.app") || host.endsWith(".ngrok.io")) return true;
    if (host.endsWith(".trycloudflare.com")) return true;
    if (host.endsWith(".tossmini.com")) return true;
  } catch {
    return false;
  }

  return false;
}

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);

    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }

    logger.warn("server", "CORS 차단", { origin });
    return callback(new Error(`CORS blocked: ${origin}`));
  },
}));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

app.use("/api/recommend", recommendRouter);
app.use("/api/route", routeRouter);

app.listen(PORT, () => {
  logger.info("server", "피들모 백엔드 실행", {
    url: `http://localhost:${PORT}`,
    health: `http://localhost:${PORT}/health`,
    recommend: `http://localhost:${PORT}/api/recommend?lat=37.55&lng=126.92`,
  });
});
