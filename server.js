/**
 * Express server for Recovery Meeting Finder connector.
 * Provides unified API for searching AA, CA, and NA meetings.
 * Includes client-side post-filtering as safety net for type, day, and time.
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

/**
 * Post-processing: classify a time string into a time-of-day bucket.
 * Morning: 7am-12pm, Afternoon: 12pm-5pm, Evening: 5pm-10pm, Overnight/Late Night: 10pm-7am
 */
function classifyTimeBucket(timeStr) {
  if (!timeStr) return null;
  // Match various time formats: "18:00", "6:30 PM", "18:00-19:00", "6:30pm"
  const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(am|pm|AM|PM)?/);
  if (!match) return null;
  let hour = parseInt(match[1], 10);
  const ampm = (match[3] || "").toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour >= 7 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "overnight"; // 22-7
}

/**
 * Map short day codes to full day names for matching.
 */
const DAY_CODE_TO_NAMES = {
  mon: ["monday"],
  tue: ["tuesday"],
  wed: ["wednesday"],
  thu: ["thursday"],
  fri: ["friday"],
  sat: ["saturday"],
  sun: ["sunday"],
};

/**
 * Post-filter meetings by formType, days, and times.
 * This acts as a safety net when source websites don't properly filter.
 */
function postFilterMeetings(meetings, formType, days, times) {
  let filtered = meetings;

  // Filter by meeting type (in_person vs online)
  filtered = filtered.filter(m => {
    const mType = (m.type || "").toLowerCase();
    if (formType === "in_person") {
      // Keep meetings that are NOT online (in_person, empty, or any non-online value)
      return mType !== "online";
    } else if (formType === "online") {
      return mType === "online";
    }
    return true;
  });

  // Filter by day
  if (days && days.length > 0) {
    const allowedDays = new Set();
    for (const d of days) {
      const names = DAY_CODE_TO_NAMES[d.toLowerCase()];
      if (names) names.forEach(n => allowedDays.add(n));
    }
    filtered = filtered.filter(m => {
      if (!m.day) return true; // Keep meetings with unknown day
      const meetingDay = m.day.toLowerCase().trim();
      // Check if any allowed day name is contained in the meeting's day field
      for (const allowed of allowedDays) {
        if (meetingDay.includes(allowed)) return true;
      }
      return false;
    });
  }

  // Filter by time bucket
  if (times && times.length > 0) {
    const allowedTimes = new Set(times.map(t => t.toLowerCase()));
    filtered = filtered.filter(m => {
      if (!m.time) return true; // Keep meetings with unknown time
      const bucket = classifyTimeBucket(m.time);
      if (!bucket) return true; // Keep if we can't classify
      return allowedTimes.has(bucket);
    });
  }

  return filtered;
}

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

    // Post-filter meetings as safety net (source sites may not filter correctly)
    const beforeCount = result.meetings ? result.meetings.length : 0;
    if (result.meetings && result.meetings.length > 0) {
      result.meetings = postFilterMeetings(result.meetings, formType, days, times);
      const afterCount = result.meetings.length;
      if (beforeCount !== afterCount) {
        console.log(`[Server] Post-filter: ${beforeCount} -> ${afterCount} meetings (formType=${formType}, days=${days}, times=${times})`);
      }
      // Update total_results to reflect filtered count
      result.total_results = result.meetings.length;
    }

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

// Debug: Check curl availability
app.get("/api/debug", (req, res) => {
  const { execSync } = require("child_process");
  const results = {};
  try {
    results.curl_chrome = execSync("which curl_chrome116 2>&1 || echo 'NOT FOUND'", { encoding: "utf8" }).trim();
  } catch (e) { results.curl_chrome = `error: ${e.message}`; }
  try {
    results.curl = execSync("which curl 2>&1 || echo 'NOT FOUND'", { encoding: "utf8" }).trim();
  } catch (e) { results.curl = `error: ${e.message}`; }
  try {
    results.cat_script = execSync("head -5 /usr/local/bin/curl_chrome116 2>&1 || echo 'N/A'", { encoding: "utf8" }).trim();
  } catch (e) { results.cat_script = `error: ${e.message.substring(0, 200)}`; }
  try {
    results.ldd_binary = execSync("ldd /usr/local/bin/curl-impersonate-chrome 2>&1 | head -15 || echo 'N/A'", { encoding: "utf8" }).trim();
  } catch (e) { results.ldd_binary = `error: ${e.message.substring(0, 200)}`; }
  try {
    results.ls_lib = execSync("ls /usr/local/lib/libcurl* 2>&1 || echo 'none'", { encoding: "utf8" }).trim();
  } catch (e) { results.ls_lib = `error: ${e.message}`; }
  try {
    results.test_direct = execSync("LD_LIBRARY_PATH=/usr/local/lib CURL_IMPERSONATE=chrome116 /usr/local/bin/curl-impersonate-chrome -s --max-time 10 -o /dev/null -w '%{http_code}' 'https://meetings.cocaineanonymous.org.uk/meetings/' 2>&1", { encoding: "utf8", timeout: 15000 }).trim();
  } catch (e) { results.test_direct = `error: ${e.message.substring(0, 200)}`; }
  try {
    results.ls_bin = execSync("ls /usr/local/bin/curl* 2>&1 || echo 'none'", { encoding: "utf8" }).trim();
  } catch (e) { results.ls_bin = `error: ${e.message}`; }
  res.json(results);
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
