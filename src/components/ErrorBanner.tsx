import { ShieldAlert, X } from 'lucide-react';

export function ErrorBanner({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-2xl border border-red-500/40 bg-red-950/40 p-4 text-sm text-red-100">
      <ShieldAlert className="mt-0.5 size-5 shrink-0 text-red-400" />
      <p className="flex-1 leading-relaxed">{message}</p>
      <button onClick={onClose} className="text-red-300/70 hover:text-red-100" aria-label="Dismiss error">
        <X className="size-4" />
      </button>
    </div>
  );
}
