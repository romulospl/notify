// Command loadtest: load generator for the web pipeline and the API pipeline (#51).
//
// Subcommands:
//
//	setup     creates in Umami and in the stellytics database the test's sites, tenants, services and keys
//	web       sends page views to the gateway (GET /c, JS proof, POST /e)
//	api       sends OTLP/HTTP (metrics or spans) to the collector with an ingest key
//	teardown  deletes everything setup created
//
// The load is open arrival (Poisson): the pace does not wait for the responses,
// so a slow server shows latency and errors instead of slowing the generator
// down. The rate profile is a list of "rate x duration" steps, for example
// "11.6x2m,116x3m,11.6x1m". See docs/reports/load-1m-per-day.md.
package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "setup":
		err = runSetup(os.Args[2:])
	case "teardown":
		err = runTeardown(os.Args[2:])
	case "web":
		err = runWeb(os.Args[2:])
	case "api":
		err = runAPI(os.Args[2:])
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "loadtest:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: loadtest setup|web|api|teardown [flags]  (-h on each subcommand)")
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
