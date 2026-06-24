// Vercel Serverless Function: /api/crawl
// Crawls multiple Canadian rental sources for self-contained listings in the
// Halton + Centre Wellington area under the target rent cap. Returns a
// normalized listings array + per-source stats.
//
// Each source is wrapped in try/catch and has a per-fetch timeout so one
// failing or slow source never breaks the response. Frontend dedupes by URL /
// externalId against its own approved + rejected sets.
//
// Sources (priority order):
//   1. Rentals.ca       — Next.js __NEXT_DATA__ JSON
//   1. REALTOR.ca       — internal PropertySearch_Post JSON API
//   2. Zolo             — cheerio over SSR cards
//   2. Kijiji           — cheerio over SSR cards
//   3. Apartments.com   — cheerio over SSR placards
//   3. RentCafe         — cheerio over SSR property cards
//   3. Viewit.ca        — cheerio over legacy listing table
//   3. RentBoard        — cheerio over SSR listings
//   bonus. Skyline Living — kept; reliable for building-level listings
//
// Intentionally NOT crawled:
//   - Zillow             — does not list Canadian rentals
//   - Facebook Marketplace — requires login; use the manual UI instead

const cheerio = require("cheerio");

const MAX_RENT = 1350;
const ALLOWED_TOWNS = [
  "Fergus", "Acton", "Milton", "Oakville", "Burlington",
  "Halton Hills", "Georgetown",
];

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const baseHeaders = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-CA,en;q=0.9",
  "Cache-Control": "no-cache",
};

const FETCH_TIMEOUT_MS = 7000;

async function fetchHTML(url, extra = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { ...baseHeaders, ...extra },
      redirect: "follow",
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function parseRent(text) {
  if (!text) return null;
  const m = String(text).replace(/\s/g, "").match(/\$?([0-9][0-9,]*)/);
  if (!m) return null;
  const n = parseInt(m[1].replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function classifyShared(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  const banned = [
    "room for rent", "private room", "shared room", "roommate", "roomie",
    "shared kitchen", "shared bath", "den only", "single room",
    "room only", "share house", "shared accommodation",
  ];
  return banned.some((b) => t.includes(b));
}

function townMatches(value) {
  if (!value) return null;
  const v = String(value).toLowerCase();
  for (const t of ALLOWED_TOWNS) {
    if (v.includes(t.toLowerCase())) return t;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Source 1: Skyline Living — SSR friendly
// ---------------------------------------------------------------------------
async function crawlSkyline() {
  const cityPages = [
    "fergus", "acton", "milton", "oakville", "burlington",
  ].map((c) => ({
    town: c.charAt(0).toUpperCase() + c.slice(1),
    url: `https://www.skylineliving.ca/en/apartments/ontario/${c}`,
  }));

  const buildingUrls = new Set();

  await Promise.allSettled(cityPages.map(async ({ town, url }) => {
    try {
      const html = await fetchHTML(url);
      const $ = cheerio.load(html);
      $('a[href*="/apartments/ontario/"]').each((_, el) => {
        const href = $(el).attr("href");
        if (!href) return;
        const abs = href.startsWith("http") ? href : `https://www.skylineliving.ca${href}`;
        const segs = abs.split("/").filter(Boolean);
        if (segs.length >= 6 && segs[5] === town.toLowerCase()) {
          if (!abs.endsWith(`/${town.toLowerCase()}`)) {
            buildingUrls.add(abs + "||" + town);
          }
        }
      });
    } catch (e) {}
  }));

  const results = [];
  await Promise.allSettled([...buildingUrls].map(async (item) => {
    const [bUrl, town] = item.split("||");
    try {
      const html = await fetchHTML(bUrl);
      const $ = cheerio.load(html);
      const title = $("h1").first().text().trim() || $("title").text().trim();
      const address = $('[itemprop="address"], .address, .building-address').first().text().trim();

      let cheapest = null;
      $("body").find(":contains('Bachelor'), :contains('Studio'), :contains('Bedroom')").each((_, el) => {
        const txt = $(el).text();
        const priceMatches = txt.match(/\$\s?([0-9],?[0-9]{3})/g);
        if (priceMatches) {
          for (const p of priceMatches) {
            const n = parseRent(p);
            if (n && (!cheapest || n < cheapest)) cheapest = n;
          }
        }
      });
      if (cheapest == null) {
        const bodyText = $("body").text();
        cheapest = parseRent(bodyText.match(/\$\s?[0-9],?[0-9]{3}/)?.[0]);
      }

      if (cheapest != null && cheapest > MAX_RENT) return;

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
    } catch (e) {}
  }));

  return results;
}

// ---------------------------------------------------------------------------
// Source 2: REALTOR.ca — internal JSON API
// ---------------------------------------------------------------------------
async function crawlRealtor() {
  const queries = [
    { town: "Burlington",   LongitudeMin: -79.92, LatitudeMin: 43.30, LongitudeMax: -79.70, LatitudeMax: 43.43 },
    { town: "Oakville",     LongitudeMin: -79.78, LatitudeMin: 43.40, LongitudeMax: -79.60, LatitudeMax: 43.53 },
    { town: "Milton",       LongitudeMin: -80.00, LatitudeMin: 43.45, LongitudeMax: -79.78, LatitudeMax: 43.62 },
    { town: "Halton Hills", LongitudeMin: -80.10, LatitudeMin: 43.55, LongitudeMax: -79.90, LatitudeMax: 43.75 },
    { town: "Fergus",       LongitudeMin: -80.48, LatitudeMin: 43.66, LongitudeMax: -80.28, LatitudeMax: 43.77 },
    { town: "Acton",        LongitudeMin: -80.10, LatitudeMin: 43.58, LongitudeMax: -79.95, LatitudeMax: 43.70 },
  ];

  const results = [];
  await Promise.allSettled(queries.map(async (q) => {
    try {
      const body = new URLSearchParams({
        ZoomLevel: "11",
        LatitudeMax: String(q.LatitudeMax),
        LongitudeMax: String(q.LongitudeMax),
        LatitudeMin: String(q.LatitudeMin),
        LongitudeMin: String(q.LongitudeMin),
        Sort: "6-D",
        PropertySearchTypeId: "1",
        TransactionTypeId: "3",
        PriceMin: "0",
        PriceMax: String(MAX_RENT),
        RecordsPerPage: "30",
        CurrentPage: "1",
        ApplicationId: "1",
        CultureId: "1",
        Version: "7.0",
      });
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      let res;
      try {
        res = await fetch("https://api2.realtor.ca/Listing.svc/PropertySearch_Post", {
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
          signal: ctrl.signal,
        });
      } finally { clearTimeout(t); }
      if (!res.ok) return;
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
          url: r.RelativeURLEn ? `https://www.realtor.ca${r.RelativeURLEn}` : "https://www.realtor.ca/",
          title: `${type} · ${addressText.split(",")[0] || ""}`.trim(),
          address: addressText.replace(/\|/g, ", "),
          rent,
          beds: r?.Building?.Bedrooms || "Confirm",
          baths: r?.Building?.BathroomTotal || "Confirm",
          externalId: `realtor:${r.Id}`,
        });
      }
    } catch (e) {}
  }));
  return results;
}

// ---------------------------------------------------------------------------
// Source 3: Apartments.com — SSR result pages
// ---------------------------------------------------------------------------
async function crawlApartments() {
  const cityPages = [
    { town: "Burlington", url: "https://www.apartments.com/burlington-on/max-1350/" },
    { town: "Oakville",   url: "https://www.apartments.com/oakville-on/max-1350/" },
    { town: "Milton",     url: "https://www.apartments.com/milton-on/max-1350/" },
  ];

  const results = [];
  await Promise.allSettled(cityPages.map(async ({ town, url }) => {
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
          $el.find("[title]").first().attr("title") || "";
        const address = $el.find(".property-address, .address").first().text().trim();
        const priceText = $el.find(".property-pricing, .price-range, .priceRange").first().text();
        const beds = $el.find(".property-beds, .bed-range, .bedRange").first().text().trim();
        const rent = parseRent(priceText);
        if (rent && rent > MAX_RENT) return;
        results.push({
          source: "Apartments.com",
          town,
          url: link.startsWith("http") ? link : `https://www.apartments.com${link}`,
          title: title || "Apartments.com listing",
          address: address || town,
          rent,
          beds: beds || "Confirm",
          externalId: link.split("?")[0],
        });
      });
    } catch (e) {}
  }));
  return results;
}

// ---------------------------------------------------------------------------
// Source 4: Rentals.ca — Next.js __NEXT_DATA__ JSON parse
// ---------------------------------------------------------------------------
async function crawlRentalsCa() {
  const cityPages = [
    { town: "Burlington",   slug: "burlington-on" },
    { town: "Oakville",     slug: "oakville-on" },
    { town: "Milton",       slug: "milton-on" },
    { town: "Halton Hills", slug: "halton-hills-on" },
    { town: "Georgetown",   slug: "georgetown-on" },
    { town: "Fergus",       slug: "fergus-on" },
    { town: "Acton",        slug: "acton-on" },
  ];

  const results = [];
  await Promise.allSettled(cityPages.map(async ({ town, slug }) => {
    try {
      const html = await fetchHTML(`https://rentals.ca/${slug}`);
      const $ = cheerio.load(html);
      const nextData = $('script#__NEXT_DATA__').html();
      if (!nextData) return;
      let data;
      try { data = JSON.parse(nextData); } catch (e) { return; }
      const pageProps = data?.props?.pageProps || {};
      const candidates =
        pageProps.listings ||
        pageProps.initialProps?.listings ||
        pageProps.searchResults?.listings ||
        pageProps.results ||
        [];
      for (const l of candidates) {
        const rent = parseRent(l.rent ?? l.price ?? l.priceLow ?? l.priceMin);
        if (!rent || rent > MAX_RENT) continue;
        const desc = (l.description || "") + " " + (l.title || "") + " " + (l.unitType || "");
        if (classifyShared(desc)) continue;
        const path = l.url || l.path || l.slug || "";
        const url = path.startsWith("http") ? path : `https://rentals.ca${path.startsWith("/") ? "" : "/"}${path}`;
        results.push({
          source: "Rentals.ca",
          town,
          url,
          title: l.title || l.unitType || "Rentals.ca listing",
          address: l.fullAddress || l.address || l.location || town,
          rent,
          beds: l.bedrooms || l.beds || "Confirm",
          baths: l.bathrooms || l.baths || "Confirm",
          externalId: `rentalsca:${l.id || l._id || path}`,
        });
      }
    } catch (e) {}
  }));
  return results;
}

// ---------------------------------------------------------------------------
// Source 5: Zolo — SSR rental cards
// ---------------------------------------------------------------------------
async function crawlZolo() {
  const cityPages = [
    { town: "Burlington",   slug: "burlington-real-estate/rentals" },
    { town: "Oakville",     slug: "oakville-real-estate/rentals" },
    { town: "Milton",       slug: "milton-real-estate/rentals" },
    { town: "Halton Hills", slug: "halton-hills-real-estate/rentals" },
    { town: "Georgetown",   slug: "georgetown-real-estate/rentals" },
  ];

  const results = [];
  await Promise.allSettled(cityPages.map(async ({ town, slug }) => {
    try {
      const html = await fetchHTML(`https://www.zolo.ca/${slug}`);
      const $ = cheerio.load(html);
      $('article.card, .listing-card, [data-testid="listing-card"]').each((_, el) => {
        const $el = $(el);
        const link = $el.find("a").first().attr("href");
        if (!link) return;
        const title = $el.find(".card-address, .listing-card-address, h3").first().text().trim();
        const priceText = $el.find(".card-price, .listing-card-price, .price").first().text();
        const rent = parseRent(priceText);
        if (!rent || rent > MAX_RENT) return;
        const desc = $el.text();
        if (classifyShared(desc)) return;
        const beds = $el.find(".card-bedrooms, .beds").first().text().trim() || "Confirm";
        results.push({
          source: "Zolo",
          town,
          url: link.startsWith("http") ? link : `https://www.zolo.ca${link}`,
          title: title || "Zolo rental",
          address: title || town,
          rent,
          beds,
          externalId: `zolo:${link}`,
        });
      });
    } catch (e) {}
  }));
  return results;
}

// ---------------------------------------------------------------------------
// Source 6: Kijiji — keyword search (Kijiji 2024+ moved away from location IDs;
// the canonical pattern is now /b-apartments-condos/canada/{query}/k0c37l0).
// We loose-walk listing anchors and use the actual container text as address
// so the final strict town gate decides what survives.
// ---------------------------------------------------------------------------
async function crawlKijiji() {
  const cityPages = [
    { town: "Burlington",   q: "burlington" },
    { town: "Oakville",     q: "oakville" },
    { town: "Milton",       q: "milton" },
    { town: "Halton Hills", q: "halton+hills" },
    { town: "Georgetown",   q: "georgetown" },
    { town: "Fergus",       q: "fergus" },
    { town: "Acton",        q: "acton" },
  ];

  const results = [];
  await Promise.allSettled(cityPages.map(async ({ town, q }) => {
    try {
      const url = `https://www.kijiji.ca/b-apartments-condos/canada/${q}/k0c37l0?ad=offering&price=0__${MAX_RENT}`;
      const html = await fetchHTML(url);
      const $ = cheerio.load(html);

      const seenLinks = new Set();
      $('a[href*="/v-apartments-condos/"]').each((_, el) => {
        const $a = $(el);
        const link = $a.attr("href");
        if (!link || seenLinks.has(link)) return;
        seenLinks.add(link);

        // Find the listing container (walk up to a reasonable card-like ancestor).
        const $container = $a.closest('section, article, li, div[class*="listing"], div[class*="item"], div[class*="card"]');
        const containerText = ($container.length ? $container.text() : $a.parent().text()).replace(/\s+/g, " ").trim();
        if (!containerText) return;

        // Real address-bearing town match (NOT our search keyword — defense in depth).
        const matchedTown = townMatches(containerText);
        if (!matchedTown) return;

        if (classifyShared(containerText)) return;

        const priceMatch = containerText.match(/\$\s?([0-9],?[0-9]{3})/);
        const rent = parseRent(priceMatch ? priceMatch[0] : null);
        if (!rent || rent > MAX_RENT) return;

        const title = ($a.attr("title") || $a.text() || "").trim() || "Kijiji listing";
        const fullUrl = link.startsWith("http") ? link : `https://www.kijiji.ca${link}`;

        results.push({
          source: "Kijiji",
          town: matchedTown,
          url: fullUrl,
          title,
          address: containerText.slice(0, 240),
          rent,
          beds: "Confirm",
          externalId: `kijiji:${fullUrl.split("?")[0]}`,
        });
      });
    } catch (e) {}
  }));
  return results;
}

// ---------------------------------------------------------------------------
// Source 7: RentCafe — SSR property cards
// ---------------------------------------------------------------------------
async function crawlRentCafe() {
  const cityPages = [
    { town: "Burlington",   slug: "burlington" },
    { town: "Oakville",     slug: "oakville" },
    { town: "Milton",       slug: "milton" },
    { town: "Halton Hills", slug: "halton-hills" },
  ];

  const results = [];
  await Promise.allSettled(cityPages.map(async ({ town, slug }) => {
    try {
      const url = `https://www.rentcafe.com/apartments-for-rent/ca/canada/on/${slug}/`;
      const html = await fetchHTML(url);
      const $ = cheerio.load(html);
      $('.property-card, [data-listing-id], article.property').each((_, el) => {
        const $el = $(el);
        const link = $el.find('a.property-link, a.property-card-link, a[href*="/apartments/"]').first().attr("href");
        if (!link) return;
        const title = $el.find(".property-name, h3").first().text().trim();
        const priceText = $el.find(".price, .property-rents, [data-rent]").first().text();
        const rent = parseRent(priceText);
        if (rent && rent > MAX_RENT) return;
        const desc = $el.text();
        if (classifyShared(desc)) return;
        const address = $el.find(".address, .property-address").first().text().trim() || town;
        results.push({
          source: "RentCafe",
          town,
          url: link.startsWith("http") ? link : `https://www.rentcafe.com${link}`,
          title: title || "RentCafe property",
          address,
          rent,
          beds: "Confirm",
          externalId: `rentcafe:${link.split("?")[0]}`,
        });
      });
    } catch (e) {}
  }));
  return results;
}

// ---------------------------------------------------------------------------
// Source 8: Viewit.ca — legacy SSR
// ---------------------------------------------------------------------------
async function crawlViewit() {
  const cities = ["Burlington", "Oakville", "Milton"];

  const results = [];
  await Promise.allSettled(cities.map(async (town) => {
    try {
      const url = `https://www.viewit.ca/Search.aspx?City=${encodeURIComponent(town)}&Province=ON`;
      const html = await fetchHTML(url);
      const $ = cheerio.load(html);
      $('.listing, .result-row, tr.searchResult').each((_, el) => {
        const $el = $(el);
        const link = $el.find('a[href*="Detail.aspx"], a[href*="Listing"]').first().attr("href");
        if (!link) return;
        const title = $el.find(".address, .title").first().text().trim();
        const priceText = $el.find(".price, .rent").first().text();
        const rent = parseRent(priceText);
        if (!rent || rent > MAX_RENT) return;
        const desc = $el.text();
        if (classifyShared(desc)) return;
        const fullUrl = link.startsWith("http") ? link : `https://www.viewit.ca/${link.replace(/^\//, "")}`;
        results.push({
          source: "Viewit.ca",
          town,
          url: fullUrl,
          title: title || "Viewit listing",
          address: title || town,
          rent,
          beds: "Confirm",
          externalId: `viewit:${fullUrl}`,
        });
      });
    } catch (e) {}
  }));
  return results;
}

// ---------------------------------------------------------------------------
// Source 9: RentBoard.ca — SSR
// ---------------------------------------------------------------------------
async function crawlRentBoard() {
  const cities = ["Burlington", "Oakville", "Milton", "Georgetown"];

  const results = [];
  await Promise.allSettled(cities.map(async (town) => {
    try {
      const url = `https://www.rentboard.ca/rentals/listings.aspx?city=${encodeURIComponent(town)}&province=ON&maxRent=${MAX_RENT}`;
      const html = await fetchHTML(url);
      const $ = cheerio.load(html);
      $('.listing-item, .rentalListing, .listing, tr.dataRow').each((_, el) => {
        const $el = $(el);
        const link = $el.find('a[href*="listing"], a[href*="rental"]').first().attr("href");
        if (!link) return;
        const title = $el.find(".title, .address, h3").first().text().trim();
        const priceText = $el.find(".price, .rent").first().text();
        const rent = parseRent(priceText);
        if (!rent || rent > MAX_RENT) return;
        const desc = $el.text();
        if (classifyShared(desc)) return;
        const fullUrl = link.startsWith("http") ? link : `https://www.rentboard.ca${link.startsWith("/") ? "" : "/"}${link}`;
        results.push({
          source: "RentBoard",
          town,
          url: fullUrl,
          title: title || "RentBoard listing",
          address: title || town,
          rent,
          beds: "Confirm",
          externalId: `rentboard:${fullUrl.split("?")[0]}`,
        });
      });
    } catch (e) {}
  }));
  return results;
}

// ---------------------------------------------------------------------------
const SOURCES = [
  { key: "rentalsCa",   label: "Rentals.ca",     fn: crawlRentalsCa },
  { key: "realtor",     label: "REALTOR.ca",     fn: crawlRealtor },
  { key: "zolo",        label: "Zolo",           fn: crawlZolo },
  { key: "kijiji",      label: "Kijiji",         fn: crawlKijiji },
  { key: "apartments",  label: "Apartments.com", fn: crawlApartments },
  { key: "rentCafe",    label: "RentCafe",       fn: crawlRentCafe },
  { key: "viewit",      label: "Viewit.ca",      fn: crawlViewit },
  { key: "rentBoard",   label: "RentBoard",      fn: crawlRentBoard },
  { key: "skyline",     label: "Skyline Living", fn: crawlSkyline },
];

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=300");

  const t0 = Date.now();
  const settled = await Promise.allSettled(SOURCES.map((s) => s.fn()));

  const stats = {};
  const errors = {};
  let listings = [];
  settled.forEach((r, i) => {
    const s = SOURCES[i];
    if (r.status === "fulfilled") {
      stats[s.key] = { label: s.label, count: r.value.length };
      listings = listings.concat(r.value);
    } else {
      stats[s.key] = { label: s.label, count: 0 };
      errors[s.key] = String(r.reason && r.reason.message ? r.reason.message : r.reason);
    }
  });

  // Final town gate (defense in depth) — trust the actual address / URL / title,
  // NOT the source-provided town label (some sources mis-route by location ID).
  listings = listings.filter((l) =>
    townMatches(l.address) || townMatches(l.url) || townMatches(l.title)
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
    stats,
    errors,
    listings,
  });
};
