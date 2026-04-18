import "dotenv/config";
import express from "express";
import cors from "cors";
import recommendRouter from "./routes/recommend";

const app = express();
const PORT = process.env.PORT ?? 4000;

app.use(cors({ origin: ["http://localhost:5173", "http://localhost:4173"] }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

app.use("/api/recommend", recommendRouter);

app.listen(PORT, () => {
  console.log(`\n🚀 피들모 백엔드 실행 중: http://localhost:${PORT}`);
  console.log(`   헬스체크: http://localhost:${PORT}/health`);
  console.log(`   추천 API: http://localhost:${PORT}/api/recommend?lat=37.55&lng=126.92\n`);
});
