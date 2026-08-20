#!/usr/bin/env node
/**
 * Materialise the generated art bundle from assets/manifest.json.
 *
 * Art is generated once and committed; this script is how it gets from the
 * generator's CDN into the repo, and how it gets regenerated if an asset is
 * revised. It is idempotent — assets already present are skipped — so it is
 * safe to run in CI, in a postinstall, or by hand.
 *
 *   node scripts/fetch-assets.mjs           # fetch anything missing
 *   node scripts/fetch-assets.mjs --force   # re-fetch everything
 *
 * Raster assets are downscaled and re-encoded to WebP via sharp when it is
 * available. Source renders are 2K and 4-10MB each, which is nowhere near the
 * 3MB bundle budget; the postprocess block in the manifest carries the target
 * size for each one. Without sharp the PNG is written through untouched and a
 * warning is printed, because a broken image is worse than a big one.
 */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(REPO, 'apps/web/public/assets');
const force = process.argv.includes('--force');

const exists = (p) => access(p).then(() => true, () => false);

async function loadSharp() {
  try {
    return (await import('sharp')).default;
  } catch {
    return null;
  }
}

async function main() {
  const manifest = JSON.parse(await readFile(resolve(REPO, 'assets/manifest.json'), 'utf8'));
  const sharp = await loadSharp();
  if (!sharp) console.warn('! sharp not installed — raster assets will be written unprocessed');

  let fetched = 0;
  let skipped = 0;

  for (const asset of manifest.assets) {
    const post = asset.postprocess;
    const dest = resolve(OUT, post?.format ? asset.dest.replace(/\.\w+$/, `.${post.format}`) : asset.dest);

    if (!force && (await exists(dest))) {
      skipped++;
      continue;
    }

    const res = await fetch(asset.url);
    if (!res.ok) throw new Error(`${asset.id}: ${res.status} ${res.statusText} for ${asset.url}`);
    let body = Buffer.from(await res.arrayBuffer());

    if (post && sharp) {
      let img = sharp(body).resize({
        width: post.resize,
        height: post.resize,
        fit: 'inside',
        withoutEnlargement: true,
      });
      if (post.format === 'webp') img = img.webp({ quality: post.quality ?? 80, alphaQuality: 100 });
      body = await img.toBuffer();
    }

    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, body);
    fetched++;
    console.log(`  ${asset.id.padEnd(18)} ${(body.length / 1024).toFixed(1).padStart(7)} KB  ${asset.dest}`);
  }

  console.log(`\nassets: ${fetched} fetched, ${skipped} already present -> apps/web/public/assets`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
