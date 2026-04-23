interface AgoraLogoProps {
  className?: string;
}

export function AgoraLogo({ className }: AgoraLogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      className={className}
      aria-hidden="true"
    >
      <g transform="translate(16,16)">
        {/* Long petals — cardinal directions */}
        <path fill="#E05A2B" d="M 0,-2 C 2.2,-6 2.2,-11 0,-14 C -2.2,-11 -2.2,-6 0,-2 Z" />
        <path fill="#8B5CF6" d="M -2,0 C -6,-2.2 -11,-2.2 -14,0 C -11,2.2 -6,2.2 -2,0 Z" />
        <path fill="#0EA5E9" d="M 0,2 C -2.2,6 -2.2,11 0,14 C 2.2,11 2.2,6 0,2 Z" />
        <path fill="#22C55E" d="M 2,0 C 6,2.2 11,2.2 14,0 C 11,-2.2 6,-2.2 2,0 Z" />
        {/* Short petals — diagonal directions */}
        <path fill="#F59E0B" d="M 0,-2 C 1.7,-5 1.7,-8.5 0,-10 C -1.7,-8.5 -1.7,-5 0,-2 Z" transform="rotate(45)" />
        <path fill="#14B8A6" d="M 0,-2 C 1.7,-5 1.7,-8.5 0,-10 C -1.7,-8.5 -1.7,-5 0,-2 Z" transform="rotate(135)" />
        <path fill="#6366F1" d="M 0,-2 C 1.7,-5 1.7,-8.5 0,-10 C -1.7,-8.5 -1.7,-5 0,-2 Z" transform="rotate(225)" />
        <path fill="#EC4899" d="M 0,-2 C 1.7,-5 1.7,-8.5 0,-10 C -1.7,-8.5 -1.7,-5 0,-2 Z" transform="rotate(315)" />
      </g>
    </svg>
  );
}
