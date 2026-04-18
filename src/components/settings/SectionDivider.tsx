/**
 * Dashed horizontal rule used between distinct settings regions in the
 * Settings dialog. Softer than a solid hr — signals "these are related
 * but separate concerns" without hard-blocking the eye.
 */
export function SectionDivider({ className = '' }: { className?: string }) {
  return (
    <hr
      className={`border-0 border-t border-dashed border-border ${className}`}
    />
  );
}
