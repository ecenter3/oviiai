import { useToast } from '../stores/toast';

export function Toaster() {
  const toasts = useToast((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((x) => (
        <div key={x.id} className={`toast ${x.tone}`}>
          {x.text}
        </div>
      ))}
    </div>
  );
}
