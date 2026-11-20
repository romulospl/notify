// Label shown on the public demo pages when they read the demo
// tenant's real data. With sample data it shows nothing.
export function DemoNotice({ sample }: { sample: boolean }) {
  if (sample) return null;
  return (
    <p role="note" className="rounded-control border border-border bg-accent-soft px-3 py-2 text-sm font-medium text-accent-text">
      Public demo: this is Stellytics measuring its own site.
    </p>
  );
}
