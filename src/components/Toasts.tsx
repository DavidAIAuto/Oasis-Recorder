import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import type { Toast } from '../types/recording';
import { cx } from '../lib/format';

const STYLE = {
  info: { icon: Info, cls: 'border-sky-500/40 text-sky-200' },
  success: { icon: CheckCircle2, cls: 'border-emerald-500/40 text-emerald-200' },
  warning: { icon: AlertTriangle, cls: 'border-amber-500/40 text-amber-200' },
  error: { icon: XCircle, cls: 'border-red-500/40 text-red-200' },
} as const;

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
      {toasts.map((t) => {
        const { icon: Icon, cls } = STYLE[t.kind];
        return (
          <div key={t.id} className={cx('pointer-events-auto flex items-start gap-3 rounded-xl border bg-zinc-900/95 p-3 text-sm shadow-xl backdrop-blur', cls)}>
            <Icon className="mt-0.5 size-4 shrink-0" />
            <p className="flex-1 text-zinc-200">{t.message}</p>
            <button onClick={() => onDismiss(t.id)} className="text-zinc-500 hover:text-zinc-200" aria-label="Dismiss">
              <X className="size-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
