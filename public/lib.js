// Pinned, not @latest: this file is served straight to production browsers by
// the live hub (see docs/deployment.md) with no build step in between, so an
// unpinned @latest here means every push to the mini-react repo — tested or
// not — goes live immediately. Bump deliberately after verifying against
// this app, not as a side effect of publishing a mini-react release.
export * from 'https://cdn.jsdelivr.net/gh/forechoandlook/mini-react@v0.1.13/dist/mini-react.min.js';
// doc from https://cdn.jsdelivr.net/gh/forechoandlook/mini-react@v0.1.13/README.mini.md
