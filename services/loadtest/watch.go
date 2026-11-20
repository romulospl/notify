package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// watcher samples CPU and memory of local processes (by PID, via /proc) and of
// containers (via docker stats) during the test.
type watcher struct {
	procs      map[string]int // name -> pid
	containers []string

	mu           sync.Mutex
	samples      []sample
	dockerWarned bool
}

type sample struct {
	at       time.Time
	name     string
	cpuCores float64 // 1.0 = one whole core
	rssMB    float64
}

// newWatcher reads "name=pid,..." and "container,...".
func newWatcher(procSpec, containerSpec string) (*watcher, error) {
	w := &watcher{procs: map[string]int{}}
	for _, p := range splitList(procSpec) {
		n, pid, ok := strings.Cut(p, "=")
		id, err := strconv.Atoi(pid)
		if !ok || err != nil {
			return nil, fmt.Errorf("-watch: %q, use name=pid", p)
		}
		w.procs[n] = id
	}
	w.containers = splitList(containerSpec)
	return w, nil
}

func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// cpuTicks returns the process's utime+stime, in 100 Hz ticks, and the RSS in MB.
func procUsage(pid int) (ticks float64, rssMB float64, err error) {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0, 0, err
	}
	s := string(b)
	f := strings.Fields(s[strings.LastIndexByte(s, ')')+2:])
	// After the ")" the first field is the file's 3rd (state); utime is the 14th.
	ut, _ := strconv.ParseFloat(f[11], 64)
	st, _ := strconv.ParseFloat(f[12], 64)
	rss, _ := strconv.ParseFloat(f[21], 64) // pages
	return ut + st, rss * float64(os.Getpagesize()) / (1 << 20), nil
}

func (w *watcher) run(ctx context.Context, every time.Duration) {
	if w == nil {
		return
	}
	prev := map[string]float64{}
	last := time.Now()
	for n, pid := range w.procs {
		if t, _, err := procUsage(pid); err == nil {
			prev[n] = t
		}
	}
	tick := time.NewTicker(every)
	defer tick.Stop()
	dockerEvery := 0
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-tick.C:
			el := now.Sub(last).Seconds()
			last = now
			for n, pid := range w.procs {
				t, rss, err := procUsage(pid)
				if err != nil {
					continue
				}
				w.add(sample{now, n, (t - prev[n]) / 100 / el, rss})
				prev[n] = t
			}
			// docker stats takes ~1-2 s per call: every 2 cycles.
			if dockerEvery++; len(w.containers) > 0 && dockerEvery%2 == 0 {
				w.dockerSample(ctx, now)
			}
		}
	}
}

func (w *watcher) add(s sample) {
	w.mu.Lock()
	w.samples = append(w.samples, s)
	w.mu.Unlock()
}

func (w *watcher) dockerSample(ctx context.Context, at time.Time) {
	args := append([]string{"stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"}, w.containers...)
	out, err := exec.CommandContext(ctx, "docker", args...).Output()
	if err != nil {
		if ctx.Err() == nil && !w.dockerWarned {
			w.dockerWarned = true
			fmt.Fprintf(os.Stderr, "warning: docker stats failed (%v); no container samples\n", err)
		}
		return
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		f := strings.Split(line, "\t")
		if len(f) != 3 {
			continue
		}
		cpu, _ := strconv.ParseFloat(strings.TrimSuffix(f[1], "%"), 64)
		mem := strings.Fields(f[2])[0]
		var mb float64
		switch {
		case strings.HasSuffix(mem, "GiB"):
			mb, _ = strconv.ParseFloat(strings.TrimSuffix(mem, "GiB"), 64)
			mb *= 1024
		case strings.HasSuffix(mem, "MiB"):
			mb, _ = strconv.ParseFloat(strings.TrimSuffix(mem, "MiB"), 64)
		case strings.HasSuffix(mem, "KiB"):
			mb, _ = strconv.ParseFloat(strings.TrimSuffix(mem, "KiB"), 64)
			mb /= 1024
		}
		w.add(sample{at, "docker:" + f[0], cpu / 100, mb})
	}
}

// report prints mean and peak CPU (in cores) and peak memory per step.
func (w *watcher) report(steps []step, starts []time.Time, end time.Time) {
	if w == nil {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	names := map[string]bool{}
	for _, s := range w.samples {
		names[s.name] = true
	}
	fmt.Printf("\n%-34s %-18s %10s %10s %10s\n", "resource", "step", "cpu mean", "cpu peak", "mem peak")
	for name := range names {
		for i, st := range steps {
			from := starts[i]
			to := end
			if i+1 < len(starts) {
				to = starts[i+1]
			}
			var sum, mx, mem float64
			n := 0
			for _, s := range w.samples {
				if s.name != name || s.at.Before(from) || !s.at.Before(to) {
					continue
				}
				sum += s.cpuCores
				mx = max(mx, s.cpuCores)
				mem = max(mem, s.rssMB)
				n++
			}
			if n > 0 {
				fmt.Printf("%-34s %-18s %6.2f core %6.2f core %7.0f MB\n", name, st, sum/float64(n), mx, mem)
			}
		}
	}
}
