import "dotenv/config";
import express from "express";
import cors from "cors";
import recommendRouter from "./routes/recommend";
import routeRouter from "./routes/route";
import { logger } from "./utils/logger";

const app = express();
const PORT = process.env.PORT ?? 4000;

app.use(cors({ origin: ["http://localhost:5173", "http://localhost:4173"] }));
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
