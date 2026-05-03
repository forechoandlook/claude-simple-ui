import esbuild from 'esbuild';
import { execSync } from 'child_process';
import { readFile, writeFile, mkdir, copyFile, rm } from 'fs/promises';

const pkg     = JSON.parse(await readFile('package.json', 'utf8'));
const version = pkg.version;
const REPO    = 'forechoandlook/claude-simple-ui';
const CDN     = `https://cdn.jsdelivr.net/gh/${REPO}@v${version}/dist`;

await rm('dist', { recursive: true, force: true });
await mkdir('dist');

// 1. Tailwind v4 + DaisyUI v5 — local build
console.log('Building CSS...');
execSync(
  `npx @tailwindcss/cli -i public/base.css -o dist/style.${version}.min.css --minify`,
  { stdio: 'inherit' }
);
// Append custom styles
const custom = await readFile('public/style.css', 'utf8');
const built  = await readFile(`dist/style.${version}.min.css`, 'utf8');
await writeFile(`dist/style.${version}.min.css`, built + '\n' + custom);

// 2. Bundle + minify JS
console.log('Bundling JS...');
await esbuild.build({
  entryPoints: ['public/app.js'],
  bundle:      true,
  minify:      true,
  format:      'esm',
  outfile:     `dist/app.${version}.min.js`,
  plugins: [{
    name: 'cdn-external',
    setup(build) {
      build.onResolve({ filter: /^https?:\/\// }, args => ({ path: args.path, external: true }));
    },
  }],
});

// 3. marked — copy from node_modules (already a dep of the CDN, but inline it)
const markedSrc = `node_modules/marked/marked.min.js`;
try {
  await copyFile(markedSrc, `dist/marked.min.js`);
} catch {
  // fallback: fetch from CDN
  const res = await fetch('https://cdn.jsdelivr.net/npm/marked@9/marked.min.js');
  await writeFile('dist/marked.min.js', await res.text());
}

// 4. index.html pointing to jsDelivr CDN
await writeFile('dist/index.html', `<!DOCTYPE html>
<html lang="en" data-theme="night">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
  <title>Claude Code</title>
  <link rel="stylesheet" href="${CDN}/style.${version}.min.css">
  <script src="${CDN}/marked.min.js"></script>
</head>
<body class="h-dvh overflow-hidden flex flex-col bg-base-100 text-base-content">
  <div id="root" class="flex flex-col flex-1 overflow-hidden"></div>
  <script type="module" src="${CDN}/app.${version}.min.js"></script>
</body>
</html>
`);


console.log(`\nDone → dist/  (v${version})`);
console.log(`  CSS: ${CDN}/style.${version}.min.css`);
console.log(`  JS:  ${CDN}/app.${version}.min.js`);
console.log(`\nDeploy: git tag v${version} && git push --tags`);
