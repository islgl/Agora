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
 * Password-like input that shows a short compact preview (`sk-an•••••ab12`)
 * when the field is blurred and non-empty, instead of the native masked dots
 * which grow with the key length. On focus we swap to a real text input so
 * the user can inspect/edit it without seeing a wall of `•`.
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
      // Plain text on focus — a `password` input renders one dot per
      // character, which blows up visually for 50-char API keys. Users
      // focused the field to inspect/edit, so revealing the value is the
      // whole point. Blurred state swaps back to the fixed 15-dot preview.
      type="text"
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
