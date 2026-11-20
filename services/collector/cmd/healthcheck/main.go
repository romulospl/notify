// Command healthcheck is the healthcheck of the collector container, which has
// no shell and no curl (scratch image). It sends a GET to the OTLP HTTP
// receiver: any HTTP response (the receiver answers 401 without a key or 405 to
// a GET) means the collector is up. It exits with 0 if it answered and 1 if not.
package main

import (
	"net/http"
	"os"
	"time"
)

func main() {
	addr := os.Getenv("HEALTHCHECK_URL")
	if addr == "" {
		addr = "http://127.0.0.1:4318/v1/metrics"
	}
	c := http.Client{Timeout: 3 * time.Second}
	resp, err := c.Get(addr)
	if err != nil {
		os.Exit(1)
	}
	resp.Body.Close()
}
