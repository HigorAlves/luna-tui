import { Mark } from "@/components/brand"
import { board, boardKeys, boardMachine, type BadgeTone } from "@/content/board"

const tones: Record<BadgeTone, string> = {
  muted: "bg-secondary text-muted-foreground",
  you: "bg-status-you/15 text-status-you",
  orc: "bg-status-orc/15 text-status-orc",
}

export function BoardFrame() {
  return (
    <div className="rounded-[10px] border border-term-border bg-term text-term-foreground">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-term-border px-3 py-2 font-mono text-xs text-term-muted">
        <span className="flex items-center gap-2">
          <Mark width={14} height={14} />
          herdr · Luna TUI
        </span>
        <span>
          machine {boardMachine.address} · <span className="text-term-green">{boardMachine.status}</span> · {boardMachine.slots}
        </span>
      </div>
      <div className="overflow-x-auto p-3" tabIndex={0} role="region" aria-label="Sample board">
        <div className="grid min-w-[1140px] grid-cols-9 gap-2">
          {board.map((col) => (
            <div key={col.name} className="min-w-0">
              <h3 className="mb-2 flex items-baseline gap-1.5 font-mono text-[11px] font-normal uppercase tracking-wide text-term-muted">
                <span>{col.name}</span>
                <span className="rounded bg-term-border px-1 text-[10px] text-term-foreground/70">{col.count}</span>
              </h3>
              <ul className="flex flex-col gap-2">
                {col.cards.map((card) => (
                  <li
                    key={card.title}
                    className={`rounded-md border border-term-border bg-term-card p-2 text-[11.5px] leading-snug ${card.dim ? "opacity-55" : ""} ${card.slides ? "board-slide" : ""}`}
                  >
                    <div>{card.title}</div>
                    {card.badge && (
                      <span className={`mt-1.5 inline-block rounded px-1.5 py-0.5 font-mono text-[10.5px] ${tones[card.badge.tone]}`}>{card.badge.text}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
      <ul aria-label="Keys" className="flex flex-wrap gap-x-4 gap-y-1 border-t border-term-border px-3 py-2 font-mono text-[11.5px] text-term-muted">
        {boardKeys.map((k) => (
          <li key={k.key}>
            <kbd className="font-mono text-term-foreground">{k.key}</kbd> <span>{k.label}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
