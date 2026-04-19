import { useState } from 'react';
import { Input } from '@/components/ui/input';

interface MaskedKeyInputProps {
  id?: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  className?: string;
}

/**
 * Password-like input. Blurred + non-empty shows a fixed 15-dot preview so
 * long keys don't stretch the field. Focused swaps to `type="password"` so
 * the browser masks the live value too — the user can still paste / edit,
 * just never sees plaintext on screen.
 */
export function MaskedKeyInput({
  id,
  value,
  onChange,
  placeholder,
  className,
}: MaskedKeyInputProps) {
  const [focused, setFocused] = useState(false);
  const showPreview = !focused && value.length > 0;

  if (showPreview) {
    return (
      <Input
        id={id}
        type="text"
        readOnly
        value={mask(value)}
        onFocus={() => setFocused(true)}
        className={className}
        // A simple click / tab into the field flips us to the editable mode.
        // No need to eat the event — the onFocus above already handles it.
      />
    );
  }

  return (
    <Input
      id={id}
      type="password"
      placeholder={placeholder}
      className={className}
      value={value}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={(e) => onChange(e.target.value)}
      autoComplete="off"
      spellCheck={false}
    />
  );
}

function mask(_v: string): string {
  // Fixed-length mask so long keys don't stretch the field. Click in to edit.
  return '•'.repeat(15);
}
