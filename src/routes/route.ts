import { Router } from "express";
import { getWalkingRoute } from "../services/tmap";
import type { Coordinates } from "../types";

const router = Router();

// POST /api/route
// body: { places: { lat: number; lng: number }[] }
router.post("/", async (req, res) => {
  const places: Coordinates[] = req.body?.places;

  if (!Array.isArray(places) || places.length < 2) {
    res.status(400).json({ error: "places must be an array of at least 2 coordinates" });
    return;
  }

  try {
    const routePath = await getWalkingRoute(places);
    res.json({ routePath });
  } catch (err) {
    console.error("[route] T-Map 오류:", err);
    res.status(500).json({ error: "route fetch failed" });
  }
});

export default router;
