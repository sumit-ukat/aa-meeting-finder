/**
 * Express server for Recovery Meeting Finder connector.
 * Provides unified API for searching AA, CA, and NA meetings.
 */

const express = require("express");
const path = require("path");

// Import all scrapers
const aa = require("./scraper");
const ca = require("./scraper-ca");
const na = require("./scraper-na");

const SCRAPERS = {
  aa: aa,
  ca: ca,
  na: na,
};

const FELLOWSHIP_NAMES = {
  aa: "Alcoholics Anonymous",
  ca: "Cocaine Anonymous",
  na: "Narcotics Anonymous",
};

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS for embedding on external sites (e.g. UKAT)
app.use("/api", (req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Serve static frontend
app.use(express.static(path.join(__dirname, "static")));

// API: Search meetings (with 90s timeout for FlareSolverr)
app.get("/api/search", async (req, res) => {
  req.setTimeout(95000);
  res.setTimeout(95000);

  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({ error: "Request timed out. The source website may be slow or blocking requests." });
    }
  }, 90000);

  try {
    const fellowship = (req.query.fellowship || "aa").toLowerCase();
    const formType = req.query.form_type || "in_person";
    const location = (req.query.location || "").trim();
    const country = req.query.country || "United Kingdom";
    const daysParam = req.query.days || "";
    const timesParam = req.query.times || "";
    const sort = req.query.sort || null;
    const page = parseInt(req.query.page, 10) || 1;

    const scraper = SCRAPERS[fellowship];
    if (!scraper) {
      clearTimeout(timeout);
      return res.status(400).json({
        error: `Unknown fellowship: ${fellowship}. Valid options: aa, ca, na`,
      });
    }

    if (formType === "in_person" && !location) {
      clearTimeout(timeout);
      return res.status(400).json({ error: "Location is required for in-person meetings" });
    }

    const days = daysParam
      ? daysParam.split(",").filter((d) => scraper.VALID_DAYS.includes(d.trim()))
      : null;
    const times = timesParam
      ? timesParam.split(",").filter((t) => scraper.VALID_TIMES.includes(t.trim()))
      : null;

    console.log(`[Server] Searching ${fellowship.toUpperCase()} meetings: ${formType}, location=${location || 'any'}, page=${page}`);

    const result = await scraper.searchMeetings({
      formType,
      location: location || null,
      country,
      days,
      times,
      sort,
      page,
    });

    // Add fellowship info to the result
    result.fellowship = fellowship;
    result.fellowship_name = FELLOWSHIP_NAMES[fellowship] || fellowship;

    clearTimeout(timeout);
    if (!res.headersSent) {
      res.json(result);
    }
  } catch (err) {
    clearTimeout(timeout);
    console.error("Search error:", err.message, err.stack);
    if (!res.headersSent) {
      res.status(500).json({ error: `Search failed: ${err.message}` });
    }
  }
});

// API: Meeting detail (AA only for now)
app.get("/api/meeting/:id", async (req, res) => {
  try {
    const meetingId = parseInt(req.params.id, 10);
    if (isNaN(meetingId)) {
      return res.status(400).json({ error: "Invalid meeting ID" });
    }
    const detail = await aa.getMeetingDetail(meetingId);
    if (!detail) {
      return res.status(404).json({ error: "Could not fetch meeting details" });
    }
    res.json(detail);
  } catch (err) {
    console.error("Detail error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await aa.closeBrowser();
  await ca.closeBrowser();
  await na.closeBrowser();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await aa.closeBrowser();
  await ca.closeBrowser();
  await na.closeBrowser();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`Recovery Meeting Finder running at http://localhost:${PORT}`);
});
