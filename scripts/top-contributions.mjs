#!/usr/bin/env node
// Renders the top contributions card: repositories contributed to across all
// contribution years, ranked by star count, in the onedark style of the other
// cards on the output branch.

import { writeFile } from "node:fs/promises";

const token = process.env.GITHUB_TOKEN;
const username = process.argv[2];
const outPath = process.argv[3];
const LIMIT = 5;

if (!token || !username || !outPath) {
  console.error("usage: GITHUB_TOKEN=... top-contributions.mjs <username> <output-path>");
  process.exit(1);
}

async function graphql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

const yearsData = await graphql(
  `query ($login: String!) {
    user(login: $login) { contributionsCollection { contributionYears } }
  }`,
  { login: username },
);
const years = yearsData.user.contributionsCollection.contributionYears;

const repos = new Map();
for (const year of years) {
  const data = await graphql(
    `query ($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          commitContributionsByRepository(maxRepositories: 100) {
            repository { nameWithOwner stargazerCount owner { avatarUrl(size: 64) } }
            contributions { totalCount }
          }
        }
      }
    }`,
    { login: username, from: `${year}-01-01T00:00:00Z`, to: `${year}-12-31T23:59:59Z` },
  );
  for (const entry of data.user.contributionsCollection.commitContributionsByRepository) {
    const key = entry.repository.nameWithOwner;
    const current = repos.get(key) ?? {
      avatarUrl: entry.repository.owner.avatarUrl,
      stars: entry.repository.stargazerCount,
      count: 0,
    };
    current.count += entry.contributions.totalCount;
    current.stars = entry.repository.stargazerCount;
    repos.set(key, current);
  }
}

const top = [...repos.entries()]
  .map(([name, { avatarUrl, stars, count }]) => ({ name, avatarUrl, stars, count }))
  .sort((a, b) => b.stars - a.stars)
  .slice(0, LIMIT);

if (top.length === 0) {
  console.error("no commit contributions found");
  process.exit(1);
}

// Avatars are inlined as data URIs: GitHub proxies READMEs through camo, which
// blocks external loads from inside an SVG rendered via <img>.
async function toDataUri(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`avatar HTTP ${res.status}`);
  const type = res.headers.get("content-type")?.split(";")[0] ?? "image/png";
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:${type};base64,${buf.toString("base64")}`;
}
for (const repo of top) repo.avatar = await toDataUri(repo.avatarUrl);

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const truncate = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

const WIDTH = 467;
const HEADER_HEIGHT = 50;
const ROW_HEIGHT = 42;
const height = HEADER_HEIGHT + top.length * ROW_HEIGHT + 15;
const maxStars = Math.max(...top.map((r) => r.stars));
const BAR_WIDTH = 280;

const formatStars = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : `${n}`);

const rows = top
  .map((r, i) => {
    const y = HEADER_HEIGHT + i * ROW_HEIGHT;
    const barW = Math.max(4, Math.round((r.stars / Math.max(1, maxStars)) * BAR_WIDTH));
    return `  <g transform="translate(25, ${y})">
    <clipPath id="avatar-${i}"><circle cx="12" cy="12" r="12"/></clipPath>
    <image href="${r.avatar}" width="24" height="24" clip-path="url(#avatar-${i})"/>
    <text class="repo" x="36" y="16">${esc(truncate(r.name, 40))}</text>
    <text class="count" x="${WIDTH - 50}" y="16" text-anchor="end">★ ${formatStars(r.stars)}</text>
    <rect x="36" y="24" width="${BAR_WIDTH}" height="6" rx="3" fill="#e4e2e2" fill-opacity="0.15"/>
    <rect x="36" y="24" width="${barW}" height="6" rx="3" fill="#8eb573"/>
  </g>`;
  })
  .join("\n");

const svg = `<svg width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Top contributions">
  <style>
    .header { font: 600 18px 'Segoe UI', Ubuntu, Sans-Serif; fill: #e4bf7a; }
    .repo { font: 600 13px 'Segoe UI', Ubuntu, Sans-Serif; fill: #df6d74; }
    .count { font: 600 13px 'Segoe UI', Ubuntu, Sans-Serif; fill: #e4bf7a; }
  </style>
  <rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" rx="4.5" fill="#282c34" stroke="#e4e2e2"/>
  <text class="header" x="25" y="33">Top Contributions</text>
${rows}
</svg>
`;

await writeFile(outPath, svg);
console.log(`Wrote ${outPath} (${top.length} repositories)`);
