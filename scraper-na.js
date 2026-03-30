/**
 * NA (Narcotics Anonymous) Meeting Scraper
 * Scrapes meeting data from meetings.ukna.org
 * Uses FlareSolverr to bypass any protection.
 * Drupal site with form-based search.
 */

const cheerio = require("cheerio");
const fetch = require("node-fetch");

const BASE_URL = "https://meetings.ukna.org/meeting/search";
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || "http://localhost:8191/v1";

const VALID_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const VALID_TIMES = ["morning", "afternoon", "evening", "overnight"];

// NA uses 1=Sunday, 2=Monday ... 7=Saturday
const DAY_MAP = {
  sun: "1",
  mon: "2",
  tue: "3",
  wed: "4",
  thu: "5",
  fri: "6",
  sat: "7",
};

// NA time filter values: 1=Morning, 2=Afternoon, 3=Evening
// "overnight" has no direct mapping; we treat it as evening or skip server-side
const TIME_MAP = {
  morning: "1",
  afternoon: "2",
  evening: "3",
  overnight: "3", // Map overnight to evening as closest match
};

const DAY_NUMBER_TO_NAME = {
  1: "Sunday",
  2: "Monday",
  3: "Tuesday",
  4: "Wednesday",
  5: "Thursday",
  6: "Friday",
  7: "Saturday",
};

/**
 * Build the search URL with query parameters.
 */
function buildSearchUrl(formType, options = {}) {
  const { location, days, times, page = 1 } = options;

  // Online meetings use a different path
  if (formType === "online") {
    let url = `${BASE_URL}/online`;
    const params = new URLSearchParams();

    // Day filter
    if (days && days.length > 0) {
      const dayVal = DAY_MAP[days[0].toLowerCase()];
      if (dayVal) params.set("day", dayVal);
    } else {
      params.set("day", "All");
    }

    // Time filter
    if (times && times.length > 0) {
      const timeVal = TIME_MAP[times[0].toLowerCase()];
      if (timeVal) params.set("time", timeVal);
    } else {
      params.set("time", "All");
    }

    if (page > 1) {
      params.set("page", String(page - 1)); // NA uses 0-indexed pages
    }

    return `${url}?${params.toString()}`;
  }

  // Physical / in-person search
  const params = new URLSearchParams();

  // Location parameters
  if (location) {
    params.set("postcode[value]", "25"); // Search radius in miles
    params.set("postcode[source_configuration][origin_address]", location);
  }

  // Day filter
  if (days && days.length > 0) {
    const dayVal = DAY_MAP[days[0].toLowerCase()];
    if (dayVal) params.set("day", dayVal);
  } else {
    params.set("day", "All");
  }

  // Time filter
  if (times && times.length > 0) {
    const timeVal = TIME_MAP[times[0].toLowerCase()];
    if (timeVal) params.set("time", timeVal);
  } else {
    params.set("time", "All");
  }

  if (page > 1) {
    params.set("page", String(page - 1)); // NA uses 0-indexed pages
  }

  return `${BASE_URL}?${params.toString()}`;
}

/**
 * Fetch a page using FlareSolverr.
 */
async function fetchPage(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      console.log(`[NA-Scraper] FlareSolverr request attempt ${attempt + 1}/${retries + 1} for ${url}`);

      const resp = await fetch(FLARESOLVERR_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cmd: "request.get",
          url: url,
          maxTimeout: 45000,
        }),
      });

      const data = await resp.json();

      if (data.status === "ok" && data.solution) {
        const html = data.solution.response;
        console.log(`[NA-Scraper] FlareSolverr got HTML (${html.length} chars), status: ${data.solution.status}`);

        // Check for meeting content markers
        if (html.includes("meeting") || html.includes("views-row") || html.includes("search-results") || html.includes("view-content")) {
          console.log("[NA-Scraper] Found meeting content in response");
          return html;
        }

        console.log("[NA-Scraper] No meeting content in FlareSolverr response");
        const snippet = html.substring(0, 300).replace(/\s+/g, " ");
        console.log(`[NA-Scraper] Snippet: ${snippet}`);
      } else {
        console.log(`[NA-Scraper] FlareSolverr returned status: ${data.status}, message: ${data.message || "none"}`);
      }

      if (attempt < retries) {
        const delay = 3000 * (attempt + 1);
        console.log(`[NA-Scraper] Retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    } catch (e) {
      console.error(`[NA-Scraper] FlareSolverr error on attempt ${attempt + 1}: ${e.message}`);
      if (attempt < retries) {
        const delay = 3000 * (attempt + 1);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  console.error("[NA-Scraper] All fetch attempts failed");
  return null;
}

/**
 * Parse a single meeting result from the Drupal views output.
 * NA results typically show as a list/table with: meeting name, area, type, day, time, venue, address, county, postcode.
 */
function parseMeetingItem($, item) {
  const meeting = {};
  const $item = $(item);
  const text = $item.text().replace(/\s+/g, " ").trim();

  // Meeting name - look for heading or linked title
  const nameLink = $item.find("a").first();
  if (nameLink.length) {
    meeting.name = nameLink.text().trim();
    const href = nameLink.attr("href") || "";
    meeting.detail_url = href.startsWith("http")
      ? href
      : `https://meetings.ukna.org${href}`;
  }

  // Try to extract structured fields from Drupal field wrappers
  // Common Drupal patterns: .views-field-field-xxx, .field--name-field-xxx
  $item.find("[class*='views-field']").each(function () {
    const cls = $(this).attr("class") || "";
    const value = $(this).find(".field-content").text().trim() || $(this).text().trim();

    if (cls.includes("field-title") || cls.includes("field-name")) {
      if (!meeting.name && value) meeting.name = value;
    } else if (cls.includes("field-area") || cls.includes("field-region")) {
      meeting.region = value;
    } else if (cls.includes("field-type") || cls.includes("field-meeting-type")) {
      if (/online/i.test(value)) {
        meeting.type = "online";
      } else {
        meeting.type = "in_person";
      }
    } else if (cls.includes("field-day")) {
      meeting.day = value;
    } else if (cls.includes("field-time")) {
      meeting.time = value;
    } else if (cls.includes("field-venue") || cls.includes("field-location")) {
      meeting.location = value;
    } else if (cls.includes("field-address")) {
      const addr = value;
      if (addr) {
        meeting.location = meeting.location
          ? `${meeting.location}, ${addr}`
          : addr;
      }
    } else if (cls.includes("field-postcode") || cls.includes("field-postal")) {
      meeting.postcode = value;
    } else if (cls.includes("field-county")) {
      meeting.county = value;
    } else if (cls.includes("field-distance")) {
      meeting.distance = value;
    }
  });

  // Fallback: try to parse from table cells if in table layout
  const cells = $item.find("td");
  if (cells.length >= 4) {
    if (!meeting.name) {
      const nameTd = cells.eq(0);
      const link = nameTd.find("a").first();
      if (link.length) {
        meeting.name = link.text().trim();
        const href = link.attr("href") || "";
        meeting.detail_url = href.startsWith("http")
          ? href
          : `https://meetings.ukna.org${href}`;
      } else {
        meeting.name = nameTd.text().trim();
      }
    }
    if (!meeting.region) meeting.region = cells.eq(1).text().trim() || null;
    if (!meeting.type) {
      const typeText = cells.eq(2).text().trim();
      meeting.type = /online/i.test(typeText) ? "online" : "in_person";
    }
    if (!meeting.day) meeting.day = cells.eq(3).text().trim() || null;
    if (!meeting.time) meeting.time = cells.eq(4).text().trim() || null;
    if (!meeting.location) meeting.location = cells.eq(5).text().trim() || null;
    // Address, county, postcode from remaining cells
    if (cells.length >= 7) {
      const addr = cells.eq(6).text().trim();
      if (addr) {
        meeting.location = meeting.location
          ? `${meeting.location}, ${addr}`
          : addr;
      }
    }
    if (cells.length >= 8) meeting.county = cells.eq(7).text().trim() || null;
    if (cells.length >= 9) meeting.postcode = cells.eq(8).text().trim() || null;
  }

  // Fallback regex extraction for fields not found via structure
  if (!meeting.day) {
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    for (const dn of dayNames) {
      if (text.includes(dn)) {
        meeting.day = dn;
        break;
      }
    }
  }

  if (!meeting.time) {
    const timeMatch = text.match(/(\d{1,2}:\d{2}\s*(?:am|pm|AM|PM)?)\s*(?:[-–to]+\s*(\d{1,2}:\d{2}\s*(?:am|pm|AM|PM)?))?/);
    if (timeMatch) {
      meeting.time = timeMatch[2]
        ? `${timeMatch[1]} - ${timeMatch[2]}`
        : timeMatch[1];
    }
  }

  if (!meeting.postcode) {
    const pcMatch = text.match(/([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})/i);
    if (pcMatch) meeting.postcode = pcMatch[1].toUpperCase();
  }

  // Type detection - check text content for online indicators
  if (!meeting.type) {
    if (/online|zoom|virtual|teams|skype/i.test(text)) {
      meeting.type = "online";
    } else {
      meeting.type = "in_person";
    }
  }

  // Directions URL - look for Google Maps link
  const dirLink = $item.find('a[href*="google.com/maps"], a[href*="maps.google"]').first();
  if (dirLink.length) {
    meeting.directions_url = dirLink.attr("href");
    const coords = meeting.directions_url.match(/destination=([-\d.]+),([-\d.]+)/) ||
                   meeting.directions_url.match(/@([-\d.]+),([-\d.]+)/);
    if (coords) {
      meeting.latitude = parseFloat(coords[1]);
      meeting.longitude = parseFloat(coords[2]);
    }
  }

  // Defaults for missing fields
  if (!meeting.duration) meeting.duration = null;
  if (!meeting.accessibility) meeting.accessibility = null;
  if (!meeting.latitude) meeting.latitude = null;
  if (!meeting.longitude) meeting.longitude = null;
  if (!meeting.directions_url) meeting.directions_url = null;
  if (!meeting.postcode) meeting.postcode = null;
  if (!meeting.distance) meeting.distance = null;

  return meeting;
}

/**
 * Parse the full results page HTML.
 */
function parseResultsPage(html, formType) {
  const $ = cheerio.load(html);

  const meetings = [];

  // Drupal views typically render results as .views-row or table rows
  // Try views-row first (common Drupal list display)
  let items = $(".views-row, .view-content .views-row");

  // Fallback to table rows
  if (items.length === 0) {
    items = $(".view-content table tbody tr, .view-content tr").not("thead tr");
  }

  // Another fallback: any result item pattern
  if (items.length === 0) {
    items = $(".search-result, .node--type-meeting, .meeting-result");
  }

  items.each(function () {
    const meeting = parseMeetingItem($, this);
    if (meeting.name) {
      meetings.push(meeting);
    }
  });

  // Total results - look for Drupal views count or result summary
  let totalResults = meetings.length;
  const countEl = $(".view-header, .views-summary, .result-count, .pager-summary");
  if (countEl.length) {
    const countMatch = countEl.text().match(/(\d+)\s*(?:results?|meetings?|items?)/i);
    if (countMatch) totalResults = parseInt(countMatch[1], 10);
  }

  // Pagination - NA uses ?page=N (0-indexed)
  let maxPage = 1;
  $(".pager a, .pager__item a, a[href*='page=']").each(function () {
    const href = $(this).attr("href") || "";
    const pageMatch = href.match(/page=(\d+)/);
    if (pageMatch) {
      // NA pages are 0-indexed, so page=0 is page 1
      const pNum = parseInt(pageMatch[1], 10) + 1;
      maxPage = Math.max(maxPage, pNum);
    }
  });

  // Also check for "last" page link
  const lastLink = $(".pager__item--last a, .pager-last a");
  if (lastLink.length) {
    const href = lastLink.attr("href") || "";
    const pageMatch = href.match(/page=(\d+)/);
    if (pageMatch) {
      maxPage = Math.max(maxPage, parseInt(pageMatch[1], 10) + 1);
    }
  }

  return {
    total_results: totalResults,
    meetings,
    max_page: maxPage,
  };
}

/**
 * Main search function.
 */
async function searchMeetings(options = {}) {
  const {
    formType = "in_person",
    location,
    days,
    times,
    page = 1,
  } = options;

  const url = buildSearchUrl(formType, { location, days, times, page });

  console.log(`[NA-Scraper] Fetching: ${url}`);
  const html = await fetchPage(url);

  if (!html) {
    return {
      error: "Failed to fetch results from NA website. The site may be temporarily unavailable.",
      meetings: [],
      total_results: 0,
      max_page: 1,
      page,
      search_url: url,
    };
  }

  const result = parseResultsPage(html, formType);
  result.page = page;
  result.search_url = url;

  console.log(`[NA-Scraper] Found ${result.meetings.length} meetings (total: ${result.total_results})`);
  return result;
}

// No browser to close with FlareSolverr approach
async function closeBrowser() {}

module.exports = {
  searchMeetings,
  closeBrowser,
  VALID_DAYS,
  VALID_TIMES,
};
