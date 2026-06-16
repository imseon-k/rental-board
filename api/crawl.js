// Vercel Serverless Function: /api/crawl
// Crawls Skyline Living, REALTOR.ca (internal JSON API), and Apartments.com
// for self-contained rental listings in Fergus / Acton / Milton / Oakville / Burlington
// under the target rent cap. Returns a normalized listings array + per-source stats.
//
// Each source is wrapped in try/catch so one failing source never breaks the response.
// Frontend dedupes by URL/externalId against its own approved + rejected sets.

const cheerio = require("cheerio");

const MAX_RENT = 1350;
const ALLOWED_TOWNS = ["Fergus", "Acton", "Milton", "Oakville", "Burlington"];

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const baseHeaders = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-CA,en;q=0.9",
  "Cache-Control": "no-cache",
};

async function fetchHTML(url, extra = {}) {
  const res = await fetch(url, {
    headers: { ...baseHeaders, ...extra },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

function parseRent(text) {
  if (!text) return null;
  const m = String(text).replace(/\s/g, "").match(/\$?([0-9][0-9,]*)/);
  if (!m) return null;
  const n = parseInt(m[1].replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function classifyShared(text) {
  // Returns true if the listing text looks like a room / shared-housing post.
  if (!text) return false;
  const t = text.toLowerCase();
  const banned = [
    "room for rent",
    "private room",
    "shared room",
    "roommate",
    "roomie",
    "shared kitchen",
    "shared bath",
    "den only",
    "single room",
  ];
  return banned.some((b) => t.includes(b));
}

// ---------------------------------------------------------------------------
// Source 1: Skyline Living — SSR friendly, easy
// ---------------------------------------------------------------------------
async function crawlSkyline() {
  const cityPages = [
    { town: "Fergus", url: "https://www.skylineliving.ca/en/apartments/ontario/fergus" },
    { town: "Acton", url: "https://www.skylineliving.ca/en/apartments/ontario/acton" },
    { town: "Milton", url: "https://www.skylineliving.ca/en/apartments/ontario/milton" },
    { town: "Oakville", url: "https://www.skylineliving.ca/en/apartments/ontario/oakville" },
    { town: "Burlington", url: "https://www.skylineliving.ca/en/apartments/ontario/burlington" },
  ];

  const buildingUrls = new Set();

  for (const { town, url } of cityPages) {
    try {
      const html = await fetchHTML(url);
      const $ = cheerio.load(html);
      $('a[href*="/apartments/ontario/"]').each((_, el) => {
        const href = $(el).attr("href");
        if (!href) return;
        const abs = href.startsWith("http") ? href : `https://www.skylineliving.ca${href}`;
        // Building detail URLs look like /apartments/ontario/<city>/<address>
        const segs = abs.split("/").filter(Boolean);
        if (segs.length >= 6 && segs[5] === town.toLowerCase()) {
          if (!abs.endsWith(`/${town.toLowerCase()}`)) {
            buildingUrls.add(abs + "||" + town);
          }
        }
      });
    } catch (e) {
      // city page failed; skip
    }
  }

  const results = [];

  for (const item of buildingUrls) {
    const [bUrl, town] = item.split("||");
    try {
      const html = await fetchHTML(bUrl);
      const $ = cheerio.load(html);
      const title = $("h1").first().text().trim() || $("title").text().trim();
      const address = $('[itemprop="address"], .address, .building-address').first().text().trim();

      // Skyline shows multiple suite types per building with their starting prices.
      let cheapest = null;
      $("body").find(":contains('Bachelor'), :contains('Studio'), :contains('Bedroom')").each(
        (_, el) => {
          const txt = $(el).text();
          const priceMatches = txt.match(/\$\s?([0-9],?[0-9]{3})/g);
          if (priceMatches) {
            for (const p of priceMatches) {
              const n = parseRent(p);
              if (n && (!cheapest || n < cheapest)) cheapest = n;
            }
          }
        }
      );

      // Fallback: any first price we find on the page
      if (cheapest == null) {
        const bodyText = $("body").text();
        cheapest = parseRent(bodyText.match(/\$\s?[0-9],?[0-9]{3}/)?.[0]);
      }

      results.push({
        source: "Skyline Living",
        town,
        url: bUrl,
        title: title || `Skyline ${town} building`,
        address: address || town,
        rent: cheapest,
        beds: "Confirm on page",
        externalId: bUrl,
      });
    } catch (e) {
      // detail failed; continue
    }
  }

  // Only keep ones within budget or unknown rent
  return results.filter((r) => r.rent == null || r.rent <= MAX_RENT);
}

// ---------------------------------------------------------------------------
// Source 2: REALTOR.ca — internal JSON API (PropertySearch_Post)
// NOTE: heavy anti-bot. May fail intermittently on Vercel IPs. Treated as best-effort.
// ---------------------------------------------------------------------------
async function crawlRealtor() {
  const queries = [
    { town: "Burlington", LongitudeMin: -79.92, LatitudeMin: 43.30, LongitudeMax: -79.70, LatitudeMax: 43.43 },
    { town: "Oakville",   LongitudeMin: -79.78, LatitudeMin: 43.40, LongitudeMax: -79.60, LatitudeMax: 43.53 },
    { town: "Milton",     LongitudeMin: -80.00, LatitudeMin: 43.45, LongitudeMax: -79.78, LatitudeMax: 43.62 },
    { town: "Fergus",     LongitudeMin: -80.48, LatitudeMin: 43.66, LongitudeMax: -80.28, LatitudeMax: 43.77 },
    { town: "Acton",      LongitudeMin: -80.10, LatitudeMin: 43.58, LongitudeMax: -79.95, LatitudeMax: 43.70 },
  ];

  const results = [];

  for (const q of queries) {
    try {
      const body = new URLSearchParams({
        ZoomLevel: "11",
        LatitudeMax: String(q.LatitudeMax),
        LongitudeMax: String(q.LongitudeMax),
        LatitudeMin: String(q.LatitudeMin),
        LongitudeMin: String(q.LongitudeMin),
        Sort: "6-D",
        PropertySearchTypeId: "1",
        TransactionTypeId: "3", // For Rent
        PriceMin: "0",
        PriceMax: String(MAX_RENT),
        RecordsPerPage: "30",
        CurrentPage: "1",
        ApplicationId: "1",
        CultureId: "1",
        Version: "7.0",
      });

      const res = await fetch("https://api2.realtor.ca/Listing.svc/PropertySearch_Post", {
        method: "POST",
        headers: {
          "User-Agent": UA,
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json, text/plain, */*",
          "Origin": "https://www.realtor.ca",
          "Referer": "https://www.realtor.ca/",
          "Accept-Language": "en-CA,en;q=0.9",
        },
        body: body.toString(),
      });
      if (!res.ok) {
        // Bail this town but keep others
        continue;
      }
      const data = await res.json();
      for (const r of data.Results || []) {
        const rent = parseRent(r?.Property?.Price);
        const addressText = r?.Property?.Address?.AddressText || "";
        const type = r?.Property?.Type || "";
        const desc = (r?.PublicRemarks || "") + " " + type;
        if (classifyShared(desc)) continue;
        if (!rent || rent > MAX_RENT) continue;

        results.push({
          source: "REALTOR.ca",
          town: q.town,
          url: r.RelativeURLEn
            ? `https://www.realtor.ca${r.RelativeURLEn}`
            : `https://www.realtor.ca/`,
          title: `${type} · ${addressText.split(",")[0] || ""}`.trim(),
          address: addressText.replace(/\|/g, ", "),
          rent,
          beds: r?.Building?.Bedrooms || "Confirm",
          baths: r?.Building?.BathroomTotal || "Confirm",
          externalId: `realtor:${r.Id}`,
        });
      }
    } catch (e) {
      // network/JSON failure for this town
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Source 3: Apartments.com — SSR result pages
// ---------------------------------------------------------------------------
async function crawlApartments() {
  const cityPages = [
    {
      town: "Burlington",
      url: "https://www.apartments.com/burlington-on/max-1350/",
    },
    {
      town: "Oakville",
      url: "https://www.apartments.com/oakville-on/max-1350/",
    },
    {
      town: "Milton",
      url: "https://www.apartments.com/milton-on/max-1350/",
    },
  ];

  const results = [];

  for (const { town, url } of cityPages) {
    try {
      const html = await fetchHTML(url, { Referer: "https://www.apartments.com/" });
      const $ = cheerio.load(html);

      $("article.placard, [data-listingid], li.mortar-wrapper").each((_, el) => {
        const $el = $(el);
        const link =
          $el.find("a.property-link").attr("href") ||
          $el.find("a.placardTitle").attr("href") ||
          $el.find("a[data-listingid]").attr("href");
        if (!link) return;

        const title =
          $el.find(".property-title, .placardTitle, .property-name").first().text().trim() ||
          $el.find("[title]").first().attr("title") ||
          "";
        const address = $el.find(".property-address, .address").first().text().trim();
        const priceText = $el.find(".property-pricing, .price-range, .priceRange").first().text();
        const beds = $el.find(".property-beds, .bed-range, .bedRange").first().text().trim();
        const rent = parseRent(priceText);

        if (rent && rent > MAX_RENT) return;

        results.push({
          source: "Apartments.com",
          town,
          url: link.startsWith("http") ? link : `https://www.apartments.com${link}`,
          title: title || `Apartments.com listing`,
          address: address || town,
          rent,
          beds: beds || "Confirm",
          externalId: link.split("?")[0],
        });
      });
    } catch (e) {
      // city page failed; continue
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
module.exports = async (req, res) => {
  // Basic CORS so the page can call it even from a preview deployment.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=300");

  const t0 = Date.now();

  const [skyline, realtor, apartments] = await Promise.allSettled([
    crawlSkyline(),
    crawlRealtor(),
    crawlApartments(),
  ]);

  const pick = (r) => (r.status === "fulfilled" ? r.value : []);
  const err = (r) =>
    r.status === "rejected" ? String(r.reason && r.reason.message ? r.reason.message : r.reason) : null;

  let listings = [...pick(skyline), ...pick(realtor), ...pick(apartments)];

  // Final town gate (defense in depth)
  listings = listings.filter((l) =>
    ALLOWED_TOWNS.some((t) => (l.town || "").toLowerCase().includes(t.toLowerCase()))
  );

  // Dedup by externalId or URL
  const seen = new Set();
  listings = listings.filter((l) => {
    const k = l.externalId || l.url;
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  res.status(200).json({
    ok: true,
    crawledAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    stats: {
      skyline: pick(skyline).length,
      realtor: pick(realtor).length,
      apartments: pick(apartments).length,
      errors: {
        skyline: err(skyline),
        realtor: err(realtor),
        apartments: err(apartments),
      },
    },
    listings,
  });
};
