import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { useSettingsStore } from '@/store/settingsStore';
import { AgoraLogo } from '@/components/icons/AgoraLogo';

const GREETINGS = [
  'Hello', 'Hi', 'Hey',
  '你好', 'こんにちは', '안녕하세요',
  'Hola', 'Bonjour', 'Salut',
  'Hallo', 'Olá', 'Ciao',
  'Привет', 'مرحباً', 'नमस्ते',
  'Xin chào', 'สวัสดี', 'Merhaba',
  'Shalom', 'Hej', 'Γεια σου',
  'Ahoj', 'Cześć', 'Kamusta',
];

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

export function ChatWelcome() {
  const nickname = useSettingsStore((s) => s.globalSettings.nickname);
  const greeting = useMemo(() => GREETINGS[Math.floor(Math.random() * GREETINGS.length)], []);
  const title = nickname ? `${greeting}, ${nickname}` : greeting;

  return (
    <div className="flex-1 min-h-0 flex items-center justify-center px-4">
      <div className="relative w-full max-w-3xl mx-auto py-20 text-foreground">
        <div className="absolute inset-0">
          <motion.svg
            width="100%"
            height="100%"
            viewBox="0 0 1000 500"
            initial="hidden"
            animate="visible"
            preserveAspectRatio="none"
            className="w-full h-full"
          >
            <motion.path
              d="M 800 80
                 C 1050 250, 850 410, 500 430
                 C 200 430, 100 380, 100 250
                 C 100 120, 280 70, 500 70
                 C 720 70, 800 160, 800 160"
              fill="none"
              strokeWidth={8}
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              variants={draw}
              className="opacity-70"
            />
          </motion.svg>
        </div>

        <div className="relative z-10 flex items-center justify-center">
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto auto',
              columnGap: '1.25rem',
            }}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.7 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.3, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
              style={{ gridColumn: 1, gridRow: 1, alignSelf: 'center' }}
            >
              <AgoraLogo className="w-11 h-11" />
            </motion.div>

            <motion.h1
              className="text-4xl md:text-5xl tracking-tight"
              style={{
                gridColumn: 2,
                gridRow: 1,
                fontFamily: 'Georgia, serif',
                fontWeight: 500,
                lineHeight: 1.2,
              }}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.5, duration: 0.8 }}
            >
              {title}
            </motion.h1>

          </div>
        </div>
      </div>
    </div>
  );
}
