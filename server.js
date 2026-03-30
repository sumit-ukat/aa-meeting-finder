/**
 * Express server for AA Meeting Finder connector.
 * Provides API endpoints for searching in-person and online AA meetings.
 */

const express = require("express");
const path = require("path");
const { searchMeetings, getMeetingDetail, closeBrowser, VALID_DAYS, VALID_TIMES } = require("./scraper");

const app = express();
const PORT = process.env.PORT || 5000;

// Serve static frontend
app.use(express.static(path.join(__dirname, "static")));

// API: Search meetings
app.get("/api/search", async (req, res) => {
  try {
    const formType = req.query.form_type || "in_person";
    const location = (req.query.location || "").trim();
    const country = req.query.country || "United Kingdom";
    const daysParam = req.query.days || "";
    const timesParam = req.query.times || "";
    const sort = req.query.sort || null;
    const page = parseInt(req.query.page, 10) || 1;

    if (formType === "in_person" && !location) {
      return res.status(400).json({ error: "Location is required for in-person meetings" });
    }

    const days = daysParam
      ? daysParam.split(",").filter((d) => VALID_DAYS.includes(d.trim()))
      : null;
    const times = timesParam
      ? timesParam.split(",").filter((t) => VALID_TIMES.includes(t.trim()))
      : null;

    const result = await searchMeetings({
      formType,
      location: location || null,
      country,
      days,
      times,
      sort,
      page,
    });

    res.json(result);
  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// API: Meeting detail
app.get("/api/meeting/:id", async (req, res) => {
  try {
    const meetingId = parseInt(req.params.id, 10);
    if (isNaN(meetingId)) {
      return res.status(400).json({ error: "Invalid meeting ID" });
    }
    const detail = await getMeetingDetail(meetingId);
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
  await closeBrowser();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await closeBrowser();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`AA Meeting Finder running at http://localhost:${PORT}`);
});
