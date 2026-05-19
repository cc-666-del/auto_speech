import fs from "node:fs/promises";
import path from "node:path";

const repository = process.env.GITHUB_REPOSITORY ?? process.argv[2] ?? "cc-666-del/auto_speech";
const token = process.env.GITHUB_TOKEN;
const [owner, repo] = repository.split("/");

if (!owner || !repo) {
  throw new Error(`Invalid repository: ${repository}`);
}

const headers = {
  Accept: "application/vnd.github.star+json",
  "User-Agent": "auto-speech-star-history"
};

if (token) {
  headers.Authorization = `Bearer ${token}`;
}

async function githubJson(url) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GitHub request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchStargazers() {
  const stars = [];
  for (let page = 1; page < 100; page += 1) {
    const url = `https://api.github.com/repos/${owner}/${repo}/stargazers?per_page=100&page=${page}`;
    const batch = await githubJson(url);
    if (batch.length === 0) {
      break;
    }
    stars.push(...batch);
    if (batch.length < 100) {
      break;
    }
  }
  return stars;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function buildChart(repoInfo, stargazers) {
  const width = 900;
  const height = 520;
  const padding = { left: 76, right: 36, top: 72, bottom: 76 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const createdAt = new Date(repoInfo.created_at);
  const today = new Date();
  const stars = stargazers
    .map(star => new Date(star.starred_at))
    .filter(date => !Number.isNaN(date.getTime()))
    .sort((left, right) => left.getTime() - right.getTime());

  const endDate = stars.at(-1) && stars.at(-1) > today ? stars.at(-1) : today;
  const startTime = createdAt.getTime();
  const endTime = Math.max(endDate.getTime(), startTime + 24 * 60 * 60 * 1000);
  const maxStars = Math.max(1, stars.length);
  const points = [{ date: createdAt, count: 0 }];
  stars.forEach((date, index) => points.push({ date, count: index + 1 }));
  points.push({ date: endDate, count: stars.length });

  const xFor = date => padding.left + ((date.getTime() - startTime) / (endTime - startTime)) * chartWidth;
  const yFor = count => padding.top + chartHeight - (count / maxStars) * chartHeight;
  const pathData = points.map((point, index) => `${index === 0 ? "M" : "L"} ${xFor(point.date).toFixed(1)} ${yFor(point.count).toFixed(1)}`).join(" ");

  const yTicks = Array.from(new Set([0, Math.ceil(maxStars / 2), maxStars]));
  const xTicks = [createdAt, endDate];
  const latestCount = stars.length;
  const latestLabel = `${latestCount} ${latestCount === 1 ? "star" : "stars"}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(repository)} star history</title>
  <desc id="desc">Star history line chart for ${escapeXml(repository)}.</desc>
  <rect width="${width}" height="${height}" rx="18" fill="#ffffff"/>
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="18" fill="none" stroke="#d8dee4"/>
  <text x="${padding.left}" y="38" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="24" font-weight="700" fill="#24292f">Star History</text>
  <text x="${padding.left}" y="60" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="13" fill="#57606a">${escapeXml(repository)} - ${escapeXml(latestLabel)}</text>
  <g stroke="#d8dee4" stroke-width="1">
    ${yTicks
      .map(count => `<line x1="${padding.left}" y1="${yFor(count).toFixed(1)}" x2="${width - padding.right}" y2="${yFor(count).toFixed(1)}"/>`)
      .join("\n    ")}
  </g>
  <g font-family="Inter,Segoe UI,Arial,sans-serif" font-size="12" fill="#57606a">
    ${yTicks
      .map(count => `<text x="${padding.left - 14}" y="${(yFor(count) + 4).toFixed(1)}" text-anchor="end">${count}</text>`)
      .join("\n    ")}
    ${xTicks
      .map(date => `<text x="${xFor(date).toFixed(1)}" y="${height - 36}" text-anchor="middle">${formatDate(date)}</text>`)
      .join("\n    ")}
  </g>
  <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${height - padding.bottom}" stroke="#8c959f"/>
  <line x1="${padding.left}" y1="${height - padding.bottom}" x2="${width - padding.right}" y2="${height - padding.bottom}" stroke="#8c959f"/>
  <path d="${pathData}" fill="none" stroke="#0969da" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
  ${points
    .filter((point, index, array) => index === 0 || index === array.length - 1 || point.count > array[index - 1].count)
    .map(point => `<circle cx="${xFor(point.date).toFixed(1)}" cy="${yFor(point.count).toFixed(1)}" r="4.5" fill="#ffffff" stroke="#0969da" stroke-width="3"/>`)
    .join("\n  ")}
  <text x="${width - padding.right}" y="${padding.top - 18}" text-anchor="end" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="13" fill="#57606a">Updated ${formatDate(today)}</text>
</svg>
`;
}

const repoInfo = await githubJson(`https://api.github.com/repos/${owner}/${repo}`);
const stargazers = await fetchStargazers();
const svg = buildChart(repoInfo, stargazers);
const outputPath = path.join("assets", "star-history.svg");

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, svg, "utf8");
console.log(`Updated ${outputPath}`);
