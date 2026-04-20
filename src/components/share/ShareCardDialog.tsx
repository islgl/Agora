import { useState, useRef, useEffect, useCallback } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { toPng } from 'html-to-image';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useBrandStore } from '@/store/brandStore';
import { ShareCard } from './ShareCard';

const LS_NAME_KEY = 'agora.shareCard.name';

function parseNameFromUserMd(md: string): string {
  const fm = md.match(/^---[\s\S]*?\nname:\s*(.+?)\s*$/m);
  if (fm) return fm[1].trim();
  const h1 = md.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return '';
}

interface ShareCardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShareCardDialog({ open, onOpenChange }: ShareCardDialogProps) {
  const cardRef = useRef<HTMLDivElement>(null!);
  const [mouseOffset, setMouseOffset] = useState({ x: 0, y: 0 });
  const [displayName, setDisplayName] = useState('');
  const [isExporting, setIsExporting] = useState(false);

  const userMd = useBrandStore((s) => s.payload.user.content);

  useEffect(() => {
    if (!open) return;
    const saved = localStorage.getItem(LS_NAME_KEY);
    setDisplayName(saved ?? parseNameFromUserMd(userMd));
  }, [open, userMd]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setMouseOffset({
      x: (e.clientX - rect.left) / rect.width - 0.5,
      y: (e.clientY - rect.top) / rect.height - 0.5,
    });
  }, []);

  const handlePointerLeave = useCallback(() => setMouseOffset({ x: 0, y: 0 }), []);

  const handleNameChange = (v: string) => {
    setDisplayName(v);
    localStorage.setItem(LS_NAME_KEY, v);
  };

  const handleDownload = async () => {
    if (!cardRef.current) return;
    setIsExporting(true);
    try {
      const png = await toPng(cardRef.current, { pixelRatio: 2, cacheBust: true });
      const a = document.createElement('a');
      a.href = png;
      a.download = 'agora-gift.png';
      a.click();
    } catch (err) {
      console.error('Share card export failed:', err);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} disablePointerDismissal>
      <DialogContent className="sm:max-w-[416px] p-6 gap-5">
        <DialogTitle className="text-sm font-medium">Share as a gift</DialogTitle>

        <div
          onPointerMove={handlePointerMove}
          onPointerLeave={handlePointerLeave}
          style={{ display: 'flex', justifyContent: 'center' }}
        >
          <ShareCard
            displayName={displayName}
            cardRef={cardRef}
            mouseOffset={mouseOffset}
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">Your name on the card</label>
          <Input
            value={displayName}
            onChange={(e) => handleNameChange(e.target.value)}
            placeholder="Your name"
            className="h-8 text-sm"
          />
        </div>

        <button
          onClick={() => void handleDownload()}
          disabled={isExporting}
          className="w-full flex items-center justify-center gap-2 h-9 rounded-lg text-sm
                     font-medium bg-primary text-primary-foreground hover:bg-primary/90
                     transition-colors disabled:opacity-60 disabled:pointer-events-none"
        >
          {isExporting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Download className="size-3.5" />
          )}
          {isExporting ? 'Exporting…' : 'Download PNG'}
        </button>
      </DialogContent>
    </Dialog>
  );
}
