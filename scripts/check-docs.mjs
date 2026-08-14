import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SITE_DIR = 'apps/docs-site';
const STUB_DIRS = ['docs/architecture', 'docs/adr'];
const MAX_STUB_LINES = 30;

const problems = [];

// 1. Repo docs that shadow the site must stay pointers. If one grows back into a
//    full explanation there are two copies, and a reader cannot tell which is stale.
for (const dir of STUB_DIRS) {
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const path = join(dir, name);
    const text = readFileSync(path, 'utf8');
    const lines = text.split('\n').filter((l) => l.trim()).length;
    if (lines > MAX_STUB_LINES) {
      problems.push(
        `${path} has ${lines} lines. Files here are pointers at the docs site; ` +
          `edit apps/docs-site instead. See docs/adr/README.md.`,
      );
    }
    if (!text.includes('arc-doc.mintlify.site')) {
      problems.push(`${path} does not link to the canonical page on the docs site.`);
    }
  }
}

// 2. Every page in the site navigation must exist, or the published nav 404s.
const config = JSON.parse(readFileSync(join(SITE_DIR, 'docs.json'), 'utf8'));
const pages = [];
const walk = (node) => {
  if (Array.isArray(node)) return node.forEach(walk);
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'pages') pages.push(...value.filter((p) => typeof p === 'string'));
      walk(value);
    }
  }
};
walk(config);

for (const page of pages) {
  if (!existsSync(join(SITE_DIR, `${page}.mdx`))) {
    problems.push(`docs.json references ${page}, but ${SITE_DIR}/${page}.mdx does not exist.`);
  }
}

// 3. Every MDX page should be reachable from the navigation.
const orphans = [];
const collect = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (entry.name.endsWith('.mdx')) {
      const route = full.slice(SITE_DIR.length + 1).replace(/\.mdx$/, '');
      if (!pages.includes(route)) orphans.push(route);
    }
  }
};
collect(SITE_DIR);
for (const orphan of orphans) {
  problems.push(`${SITE_DIR}/${orphan}.mdx is not referenced from docs.json navigation.`);
}

if (problems.length > 0) {
  console.error(`\ndocs check failed (${problems.length}):\n`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`docs ok — ${pages.length} pages in navigation, all present and reachable.`);
