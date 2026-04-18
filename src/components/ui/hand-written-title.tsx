import { motion } from 'framer-motion';

interface HandWrittenTitleProps {
  title?: string;
  subtitle?: string;
  /** Optional stroke-color override; defaults to the prose foreground. */
  stroke?: string;
}

/**
 * Title with a hand-drawn oval loop sketched in around it. The loop animates
 * as a pen stroke on mount. Uses `currentColor` on the SVG so the ink follows
 * whatever text colour the parent sets (we pass `text-foreground` for the
 * Parchment/dark theme).
 */
export function HandWrittenTitle({
  title = 'Hand Written',
  subtitle,
  stroke,
}: HandWrittenTitleProps) {
  const draw = {
    hidden: { pathLength: 0, opacity: 0 },
    visible: {
      pathLength: 1,
      opacity: 1,
      transition: {
        pathLength: {
          duration: 2.5,
          ease: [0.43, 0.13, 0.23, 0.96] as [number, number, number, number],
        },
        opacity: { duration: 0.5 },
      },
    },
  };

  return (
    <div className="relative w-full max-w-4xl mx-auto py-20 text-foreground">
      <div className="absolute inset-0">
        <motion.svg
          width="100%"
          height="100%"
          viewBox="0 0 1200 600"
          initial="hidden"
          animate="visible"
          preserveAspectRatio="none"
          className="w-full h-full"
        >
          <motion.path
            d="M 950 90
               C 1250 300, 1050 480, 600 520
               C 250 520, 150 480, 150 300
               C 150 120, 350 80, 600 80
               C 850 80, 950 180, 950 180"
            fill="none"
            strokeWidth={10}
            stroke={stroke ?? 'currentColor'}
            strokeLinecap="round"
            strokeLinejoin="round"
            variants={draw}
            className="opacity-80"
          />
        </motion.svg>
      </div>
      <div className="relative text-center z-10 flex flex-col items-center justify-center gap-2">
        <motion.h1
          className="text-4xl md:text-6xl tracking-tight"
          style={{ fontFamily: 'Georgia, serif', fontWeight: 500, lineHeight: 1.2 }}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5, duration: 0.8 }}
        >
          {title}
        </motion.h1>
        {subtitle && (
          <motion.p
            className="text-base md:text-lg text-muted-foreground"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1, duration: 0.8 }}
          >
            {subtitle}
          </motion.p>
        )}
      </div>
    </div>
  );
}
