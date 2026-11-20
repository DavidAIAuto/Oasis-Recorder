export function Countdown({ value, onCancel }: { value: number; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-8 bg-zinc-950/85 backdrop-blur-sm" role="dialog" aria-label="Recording countdown">
      <div className="flex size-48 items-center justify-center rounded-full border-4 border-red-500/70 shadow-[0_0_80px_-10px] shadow-red-500/50">
        <span key={value} className="text-8xl font-bold text-zinc-50 tabular-nums">{value}</span>
      </div>
      <p className="text-sm text-zinc-400">Recording starts in {value}…</p>
      <button onClick={onCancel} className="rounded-full border border-zinc-700 px-5 py-2 text-sm text-zinc-300 hover:bg-zinc-800">
        Cancel
      </button>
    </div>
  );
}
