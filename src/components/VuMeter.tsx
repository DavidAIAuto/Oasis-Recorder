import { cx } from '../lib/format';

const SEGMENTS = 24;

export function VuMeter({ level, muted = false, className }: { level: number; muted?: boolean; className?: string }) {
  const lit = muted ? 0 : Math.round(level * SEGMENTS);
  return (
    <div
      className={cx('flex h-3 items-stretch gap-[2px]', className)}
      role="meter"
      aria-label="Microphone level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round((muted ? 0 : level) * 100)}
    >
      {Array.from({ length: SEGMENTS }, (_, i) => {
        const on = i < lit;
        const zone = i >= SEGMENTS * 0.85 ? 'bg-red-500' : i >= SEGMENTS * 0.65 ? 'bg-amber-400' : 'bg-emerald-400';
        return <span key={i} className={cx('flex-1 rounded-[2px] transition-colors duration-75', on ? zone : 'bg-zinc-800')} />;
      })}
    </div>
  );
}
