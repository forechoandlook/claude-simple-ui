import esbuild from 'esbuild';
import { readFile, writeFile, copyFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';

await mkdir('dist', { recursive: true });

// Bundle + minify JS (mark CDN libs as external)
await esbuild.build({
  entryPoints: ['public/app.js'],
  bundle:      true,
  minify:      true,
  format:      'esm',
  outfile:     'dist/app.js',
  // lib.js re-exports from CDN — keep that URL as-is
  plugins: [{
    name: 'cdn-external',
    setup(build) {
      build.onResolve({ filter: /^https?:\/\// }, args => ({ path: args.path, external: true }));
    },
  }],
});

// Minify CSS (esbuild handles it too)
await esbuild.build({
  entryPoints: ['public/style.css'],
  bundle:      false,
  minify:      true,
  outfile:     'dist/style.css',
});

// Patch index.html: point to dist assets
let html = await readFile('public/index.html', 'utf8');
html = html
  .replace('href="style.css"',  'href="style.css"')   // same name, served from dist
  .replace('src="app.js"',      'src="app.js" type="module"');
await writeFile('dist/index.html', html);

console.log('Build complete → dist/');
