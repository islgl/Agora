import logoLight from '../../../assets/logo-light.png';

// ── Noise texture ─────────────────────────────────────────────────────────────
let _noiseUrl: string | null = null;
function noiseDataUrl(): string {
  if (_noiseUrl) return _noiseUrl;
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = (Math.random() * 255) | 0;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = (Math.random() * 20) | 0;
  }
  ctx.putImageData(img, 0, 0);
  _noiseUrl = c.toDataURL('image/png');
  return _noiseUrl;
}

// ── Seeded RNG ────────────────────────────────────────────────────────────────
function mkRng(seed: number) {
  let s = seed | 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 0) / 4294967296; };
}

// ── Rough line ────────────────────────────────────────────────────────────────
function roughLine(x1: number, y1: number, x2: number, y2: number, w: number, r: () => number) {
  const mx = (x1 + x2) / 2 + (r() - 0.5) * w * 2;
  const my = (y1 + y2) / 2 + (r() - 0.5) * w * 2;
  return `M${x1.toFixed(1)},${y1.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
}

// ── Deckled clip-path ─────────────────────────────────────────────────────────
function buildDeckledClip(W: number, H: number, depth: number, step: number) {
  const r = mkRng(0xfeed_cafe);
  const edge = (x1: number, y1: number, x2: number, y2: number, nx: number, ny: number) => {
    const dx = x2 - x1, dy = y2 - y1;
    const n = Math.round(Math.hypot(dx, dy) / step);
    let s = '';
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const h = i % 2 === 0 ? 0 : depth * (0.25 + r() * 0.9);
      s += ` L${(x1 + dx*t + nx*h).toFixed(1)},${(y1 + dy*t + ny*h).toFixed(1)}`;
    }
    return s;
  };
  return ['M0,0', edge(0,0,W,0,0,1), edge(W,0,W,H,-1,0), edge(W,H,0,H,0,-1), edge(0,H,0,0,1,0), 'Z'].join('');
}

// ── Botanical wreath ──────────────────────────────────────────────────────────
function buildWreath(cx: number, cy: number, r: number, seed: number) {
  const rng = mkRng(seed);
  const leaves: string[] = [];
  const berries: [number, number, number][] = [];
  const count = 18;

  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
    const rVar  = r * (0.82 + rng() * 0.18);
    const lLen  = 11 + rng() * 8;
    const lWid  = 4  + rng() * 3;
    const tilt  = angle + (rng() - 0.5) * 0.25;

    const lx = cx + Math.cos(angle) * rVar;
    const ly = cy + Math.sin(angle) * rVar;

    const bx = lx - Math.cos(tilt) * lLen * 0.4;
    const by = ly - Math.sin(tilt) * lLen * 0.4;
    const tx = lx + Math.cos(tilt) * lLen * 0.6;
    const ty = ly + Math.sin(tilt) * lLen * 0.6;

    const c1x = lx + Math.cos(tilt + Math.PI/2) * lWid;
    const c1y = ly + Math.sin(tilt + Math.PI/2) * lWid;
    const c2x = lx - Math.cos(tilt + Math.PI/2) * lWid;
    const c2y = ly - Math.sin(tilt + Math.PI/2) * lWid;

    leaves.push(
      `M${bx.toFixed(1)},${by.toFixed(1)} ` +
      `Q${c1x.toFixed(1)},${c1y.toFixed(1)} ${tx.toFixed(1)},${ty.toFixed(1)} ` +
      `Q${c2x.toFixed(1)},${c2y.toFixed(1)} ${bx.toFixed(1)},${by.toFixed(1)} Z`
    );

    // Berries between some leaves
    if (i % 3 === 1) {
      const ba = angle + (Math.PI / count);
      const br = rVar * 0.88;
      berries.push([cx + Math.cos(ba)*br, cy + Math.sin(ba)*br, 1.5 + rng()]);
    }
  }
  return { leaves, berries };
}

// ── Rough decorative border (two-pass for double-line effect) ─────────────────
function buildBorder(W: number, H: number, inset: number, wobble: number, seed: number) {
  const rng = mkRng(seed);
  const corners = [
    [inset,   inset  ],
    [W-inset, inset  ],
    [W-inset, H-inset],
    [inset,   H-inset],
  ];
  return corners.map((c, i) => {
    const n = corners[(i + 1) % 4];
    const mx = (c[0]+n[0])/2 + (rng()-0.5)*wobble*2;
    const my = (c[1]+n[1])/2 + (rng()-0.5)*wobble*2;
    return `${i===0?'M':'L'}${c[0].toFixed(1)},${c[1].toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} `;
  }).join('') + 'Z';
}

// ── Constants ─────────────────────────────────────────────────────────────────
const W = 320, H = 460;
const DECKLED    = buildDeckledClip(W, H, 5, 4);
const CX = W / 2, CY = 178;                         // wreath centre
const WREATH     = buildWreath(CX, CY, 72, 0xb07a11);
const BORDER_OUT = buildBorder(W, H, 10,  2.2, 0xaa01);
const BORDER_IN  = buildBorder(W, H, 16,  1.5, 0xaa02);

const INK     = '#1C120A';
const INK_MID = '#5C3D20';
const INK_LT  = '#9B7045';

// ── Component ─────────────────────────────────────────────────────────────────
export interface ShareCardProps {
  displayName: string;
  cardRef: React.RefObject<HTMLDivElement>;
  mouseOffset: { x: number; y: number };
}

export function ShareCard({ displayName, cardRef, mouseOffset }: ShareCardProps) {
  const rx = mouseOffset.y * -10;
  const ry = mouseOffset.x *  10;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Caveat:wght@400;600;700&display=swap');
        @keyframes agora-card-in {
          from { opacity: 0; transform: scale(0.88) translateY(10px) rotate(-0.6deg); }
          to   { opacity: 1; transform: scale(1)    translateY(0)    rotate(0deg); }
        }
      `}</style>

      {/* Tilt + shadow — follows the deckled clip shape */}
      <div style={{
        transform: `perspective(1000px) rotateX(${rx}deg) rotateY(${ry}deg)`,
        transition: 'transform 0.12s ease-out',
        transformStyle: 'preserve-3d',
        lineHeight: 0,
        filter: 'drop-shadow(0 16px 40px rgba(28,18,10,0.28)) drop-shadow(0 4px 10px rgba(28,18,10,0.15))',
      }}>

        {/* ── Card ── */}
        <div
          ref={cardRef}
          style={{
            position: 'relative',
            width: W, height: H,
            background: '#F8F4E8',
            backgroundImage: [
              'repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(120,90,30,0.022) 3px, rgba(120,90,30,0.022) 4px)',
              'repeating-linear-gradient(90deg, transparent, transparent 10px, rgba(120,90,30,0.009) 10px, rgba(120,90,30,0.009) 11px)',
            ].join(', '),
            clipPath: `path("${DECKLED}")`,
            fontFamily: "'Caveat', 'Chalkboard SE', cursive",
            userSelect: 'none',
            flexShrink: 0,
            animation: 'agora-card-in 0.65s cubic-bezier(0.34,1.56,0.64,1) both',
          }}
        >
          {/* ── Decorative SVG layer ── */}
          <svg
            viewBox={`0 0 ${W} ${H}`}
            width={W} height={H}
            style={{ position: 'absolute', top: 0, left: 0 }}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          >
            {/* Outer border */}
            <path d={BORDER_OUT} stroke={INK}     strokeWidth="1.1" opacity="0.55" />
            {/* Inner border */}
            <path d={BORDER_IN}  stroke={INK_MID} strokeWidth="0.75" opacity="0.35" />

            {/* Corner ✦ ornaments (inside the inner border) */}
            {([
              [22, 22], [W-22, 22], [W-22, H-22], [22, H-22],
            ] as [number,number][]).map(([x, y], i) => (
              <g key={i} transform={`translate(${x},${y})`}>
                <line x1="-4" y1="0"  x2="4"  y2="0"  stroke={INK_MID} strokeWidth="0.8" opacity="0.5" />
                <line x1="0"  y1="-4" x2="0"  y2="4"  stroke={INK_MID} strokeWidth="0.8" opacity="0.5" />
                <line x1="-3" y1="-3" x2="3"  y2="3"  stroke={INK_MID} strokeWidth="0.6" opacity="0.35" />
                <line x1="-3" y1="3"  x2="3"  y2="-3" stroke={INK_MID} strokeWidth="0.6" opacity="0.35" />
              </g>
            ))}

            {/* Botanical wreath — leaves */}
            {WREATH.leaves.map((d, i) => (
              <path key={i} d={d}
                fill={INK_MID} fillOpacity="0.18"
                stroke={INK_MID} strokeWidth="0.75" strokeOpacity="0.55"
              />
            ))}
            {/* Wreath berries */}
            {WREATH.berries.map(([x, y, r], i) => (
              <circle key={i} cx={x} cy={y} r={r} fill={INK_MID} fillOpacity="0.45" />
            ))}

            {/* Horizontal dividers flanking the tagline */}
            <path
              d={roughLine(28, H*0.594, W-28, H*0.594, 1.2, mkRng(0xd001))}
              stroke={INK_MID} strokeWidth="0.75" opacity="0.4"
            />
            <path
              d={roughLine(36, H*0.604, W-36, H*0.604, 0.8, mkRng(0xd002))}
              stroke={INK_LT} strokeWidth="0.5" opacity="0.28"
            />
          </svg>

          {/* ── Content layer ── */}

          {/* Top label */}
          <div style={{
            position: 'absolute',
            top: 26, left: 0, right: 0,
            textAlign: 'center',
            fontSize: 9,
            letterSpacing: '3px',
            color: INK_MID,
            textTransform: 'uppercase',
            opacity: 0.55,
          }}>
            A Gift for You
          </div>

          {/* Agora logo — centred in the wreath ring */}
          <div style={{
            position: 'absolute',
            top: CY - 22,
            left: '50%',
            transform: 'translateX(-50%)',
          }}>
            <img
              src={logoLight}
              alt="Agora"
              style={{
                height: 44, objectFit: 'contain',
                filter: 'sepia(50%) brightness(0.45)',
                opacity: 0.9,
                display: 'block',
              }}
            />
          </div>

          {/* App name */}
          <div style={{
            position: 'absolute',
            top: Math.round(H * 0.435),
            left: 0, right: 0,
            textAlign: 'center',
            fontSize: 30,
            fontWeight: 700,
            letterSpacing: '5px',
            color: INK,
            lineHeight: 1,
            paddingLeft: '5px', // compensate letter-spacing
          }}>
            AGORA
          </div>

          {/* Tagline */}
          <div style={{
            position: 'absolute',
            top: Math.round(H * 0.52),
            left: 0, right: 0,
            textAlign: 'center',
            fontSize: 12,
            fontStyle: 'italic',
            color: INK_MID,
            letterSpacing: '0.5px',
            opacity: 0.8,
          }}>
            Stay-in-One AI Hub
          </div>

          {/* Bottom section */}
          <div style={{
            position: 'absolute',
            bottom: 28, left: 28, right: 28,
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
          }}>
            {/* User signature */}
            <div style={{
              fontSize: 14,
              color: INK_MID,
              fontStyle: 'italic',
              opacity: displayName ? 0.85 : 0,
            }}>
              — {displayName || ''}
            </div>

            {/* Logo watermark */}
            <img
              src={logoLight}
              alt="Agora"
              style={{
                height: 18,
                objectFit: 'contain',
                opacity: 0.35,
                filter: 'sepia(40%) brightness(0.5)',
              }}
            />
          </div>

          {/* Grain overlay */}
          <div style={{
            position: 'absolute', inset: 0, pointerEvents: 'none',
            backgroundImage: `url("${noiseDataUrl()}")`,
            backgroundRepeat: 'repeat',
            backgroundSize: '256px 256px',
            mixBlendMode: 'multiply',
            opacity: 0.38,
          }} />
        </div>
      </div>
    </>
  );
}
