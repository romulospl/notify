package main

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

// checkTargets refuses targets that are not loopback, unless allowRemote is
// true: setup, teardown and the loads write and delete data, and must not
// point by mistake at a production database or service. It prints host and
// database of each target before any action.
func checkTargets(allowRemote bool, targets map[string]string) error {
	for name, raw := range targets {
		u, err := url.Parse(raw)
		if err != nil || u.Hostname() == "" {
			return fmt.Errorf("%s: invalid URL %q", name, redact(raw))
		}
		fmt.Printf("target %-12s host=%s database=%s\n", name, u.Host, strings.TrimPrefix(u.Path, "/"))
		if !isLoopback(u.Hostname()) && !allowRemote {
			return fmt.Errorf("%s points at %q, which is not loopback; use -allow-remote if it is on purpose", name, u.Hostname())
		}
	}
	return nil
}

func redact(s string) string {
	if u, err := url.Parse(s); err == nil && u.User != nil {
		u.User = url.User("***")
		return u.String()
	}
	return s
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
