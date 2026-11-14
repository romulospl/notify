import type { Delta } from "@/lib/format";

// Variação contra o período anterior (#28, #29). A cor diz se a mudança é boa
// (depende da métrica: rejeição subir é ruim) e sempre vem com seta e texto,
// nunca só a cor. Cores de estado da skill dataviz.
export function DeltaText({ delta, upIsGood = true }: { delta: NonNullable<Delta>; upIsGood?: boolean }) {
  if (delta.direction === "flat") return <span className="text-zinc-500">{delta.text}</span>;
  const good = (delta.direction === "up") === upIsGood;
  return (
    <span className={good ? "text-[#006300] dark:text-[#0ca30c]" : "text-[#d03b3b]"}>
      <span aria-hidden>{delta.direction === "up" ? "▲ " : "▼ "}</span>
      <span className="sr-only">{delta.direction === "up" ? "Up " : "Down "}</span>
      {delta.text}
    </span>
  );
}
