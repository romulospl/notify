package fingerprint

import (
	"net/netip"
	"sync"
	"testing"
	"time"
)

var (
	ip        = netip.MustParseAddr("203.0.113.0")
	otherIP   = netip.MustParseAddr("198.51.100.0")
	site      = "6f1c2b9e-3a4d-4c8e-9f00-1234567890ab"
	otherSite = "0a0b0c0d-0e0f-4000-8000-000000000001"
)

func TestOf(t *testing.T) {
	base := Of("Mozilla/5.0 Firefox", "de-DE", "de-DE", "1920x1080")
	if base != Of("Mozilla/5.0 Firefox", "de-DE", "de-DE", "1920x1080") {
		t.Error("same input, different fingerprints")
	}
	for name, fp := range map[string]uint64{
		"another UA":                Of("Mozilla/5.0 Chrome", "de-DE", "de-DE", "1920x1080"),
		"another language":          Of("Mozilla/5.0 Firefox", "en-US", "de-DE", "1920x1080"),
		"another screen":            Of("Mozilla/5.0 Firefox", "de-DE", "de-DE", "390x844"),
		"fields joined another way": Of("Mozilla/5.0 Firefoxd", "e-DE", "de-DE", "1920x1080"),
	} {
		if fp == base {
			t.Errorf("%s: same fingerprint", name)
		}
	}
}

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func TestAllow(t *testing.T) {
	clk := &clock{t: time.Unix(1_800_000_000, 0)}
	c := New(3, 10*time.Minute).WithClock(clk.now)

	for fp := uint64(1); fp <= 3; fp++ {
		if !c.Allow(ip, site, fp) {
			t.Fatalf("fingerprint %d within the limit refused", fp)
		}
	}
	if c.Allow(ip, site, 4) {
		t.Error("fourth fingerprint on the same IP accepted")
	}
	// Those already seen keep passing, and another IP or another site have
	// their own count: filling the quota of one site does not take the slots of
	// the others.
	if !c.Allow(ip, site, 2) {
		t.Error("known fingerprint refused")
	}
	if !c.Allow(otherIP, site, 4) {
		t.Error("another IP refused")
	}
	for fp := uint64(1); fp <= 3; fp++ {
		if !c.Allow(ip, otherSite, 100+fp) {
			t.Errorf("another site on the same IP refused (fingerprint %d)", 100+fp)
		}
	}

	// Once the window passes with no events from the old ones, new fingerprints
	// fit.
	clk.t = clk.t.Add(5 * time.Minute)
	c.Allow(ip, site, 3) // 3 stays active
	clk.t = clk.t.Add(6 * time.Minute)
	if !c.Allow(ip, site, 5) {
		t.Error("new fingerprint refused after the old ones left the window")
	}
	if !c.Allow(ip, site, 6) {
		t.Error("second freed slot refused")
	}
	if c.Allow(ip, site, 7) {
		t.Error("limit ignored: 3, 5 and 6 are still in the window")
	}
}

func TestDisabled(t *testing.T) {
	c := New(0, time.Minute)
	for fp := uint64(0); fp < 100; fp++ {
		if !c.Allow(ip, site, fp) {
			t.Fatal("limit 0 should turn the check off")
		}
	}
	if c.Len() != 0 {
		t.Error("check turned off stored an IP")
	}
}

func TestSweep(t *testing.T) {
	clk := &clock{t: time.Unix(1_800_000_000, 0)}
	c := New(3, 10*time.Minute).WithClock(clk.now)
	c.Allow(ip, site, 1)
	c.Allow(otherIP, site, 1)
	clk.t = clk.t.Add(5 * time.Minute)
	c.Allow(otherIP, site, 2)
	clk.t = clk.t.Add(6 * time.Minute)
	c.Sweep()
	if c.Len() != 1 {
		t.Errorf("Len = %d, want 1 (only the IP with a recent fingerprint)", c.Len())
	}
}

func TestFullAccountKeepsNoNewState(t *testing.T) {
	c := New(2, 10*time.Minute)
	c.Allow(ip, site, 1)
	c.Allow(ip, site, 2)
	for fp := uint64(3); fp < 100; fp++ {
		if c.Allow(ip, site, fp) {
			t.Fatalf("fingerprint %d accepted with the count full", fp)
		}
	}
	c.mu.Lock()
	n := len(c.keys[key{ip, site}])
	c.mu.Unlock()
	if n != 2 {
		t.Errorf("full count stored %d fingerprints, want 2", n)
	}
}

// Run with -race: Allow and Sweep at the same time.
func TestConcurrentAllowAndSweep(t *testing.T) {
	c := New(10, time.Minute)
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 500; i++ {
				c.Allow(netip.AddrFrom4([4]byte{10, 0, byte(g), 0}), site, uint64(i%20))
				if i%50 == 0 {
					c.Sweep()
				}
			}
		}(g)
	}
	wg.Wait()
}

func TestAdmitAndForget(t *testing.T) {
	c := New(2, time.Minute)
	ip := netip.MustParseAddr("192.0.2.0")
	if ok, fresh := c.Admit(ip, "s", 1); !ok || !fresh {
		t.Fatalf("first: ok=%v fresh=%v", ok, fresh)
	}
	if ok, fresh := c.Admit(ip, "s", 1); !ok || fresh {
		t.Fatalf("repeated: ok=%v fresh=%v", ok, fresh)
	}
	c.Admit(ip, "s", 2)
	if ok, _ := c.Admit(ip, "s", 3); ok {
		t.Fatal("the third should be refused")
	}
	c.Forget(ip, "s", 2) // undoes the admission of a new fingerprint
	if ok, fresh := c.Admit(ip, "s", 3); !ok || !fresh {
		t.Fatalf("after Forget: ok=%v fresh=%v", ok, fresh)
	}
	c.Forget(ip, "s", 1)
	c.Forget(ip, "s", 3)
	if c.Len() != 0 {
		t.Errorf("an empty count should leave memory: %d", c.Len())
	}
	c.Forget(ip, "other", 9) // a nonexistent count does nothing
}
