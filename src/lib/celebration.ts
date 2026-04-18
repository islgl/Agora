import confetti from 'canvas-confetti';

const FIRST_SEND_FLAG = 'agora_first_send_celebrated';

/** Side-cannons effect (mirrors magicui's `Confetti` "side-cannons" demo). */
export function fireSideCannons() {
  const end = Date.now() + 2500;
  const colors = ['#a786ff', '#fd8bbc', '#eca184', '#f8deb1'];

  const frame = () => {
    if (Date.now() > end) return;

    confetti({
      particleCount: 3,
      angle: 60,
      spread: 55,
      startVelocity: 60,
      origin: { x: 0, y: 0.55 },
      colors,
      zIndex: 1000,
    });
    confetti({
      particleCount: 3,
      angle: 120,
      spread: 55,
      startVelocity: 60,
      origin: { x: 1, y: 0.55 },
      colors,
      zIndex: 1000,
    });

    requestAnimationFrame(frame);
  };
  frame();
}

/**
 * Fire the celebration once — the very first time the user ever sends a
 * message. The flag is persisted in localStorage so it survives reloads and
 * doesn't re-fire after the user clears their conversation list.
 */
export function celebrateFirstSendOnce() {
  if (typeof window === 'undefined') return;
  if (localStorage.getItem(FIRST_SEND_FLAG)) return;
  localStorage.setItem(FIRST_SEND_FLAG, '1');
  fireSideCannons();
}
