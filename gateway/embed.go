package main

import "embed"

// embeddedWeb is populated from ../public by the Makefile's prepare-web target
// before every production build.
//
//go:embed all:web
var embeddedWeb embed.FS
