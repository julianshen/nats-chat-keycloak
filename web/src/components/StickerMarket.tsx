import React, { useState, useEffect, useRef } from 'react';
import type { ChatClient } from '../lib/chat-client';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ArrowLeft, Loader2 } from 'lucide-react';

interface StickerProduct {
  id: string;
  name: string;
  thumbnailUrl: string;
}

interface Sticker {
  id: string;
  imageUrl: string;
}

interface Props {
  open: boolean;
  client: ChatClient;
  onSelect: (stickerUrl: string) => void;
  onClose: () => void;
}

export const StickerMarket: React.FC<Props> = ({ open, client, onSelect, onClose }) => {
  const [products, setProducts] = useState<StickerProduct[]>([]);
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<StickerProduct | null>(null);
  const [loading, setLoading] = useState(false);
  const fetchedRef = useRef(false);

  // Fetch products once on first open
  useEffect(() => {
    if (!open || fetchedRef.current) return;
    fetchedRef.current = true;
    let cancelled = false;
    setLoading(true);
    client.getStickerProducts()
      .then((data) => {
        if (cancelled) return;
        setProducts(data as StickerProduct[]);
      })
      .catch((err) => {
        console.warn('[Stickers] Failed to fetch products:', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, client]);

  // Fetch stickers when product selected
  useEffect(() => {
    if (!selectedProduct) {
      setStickers([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    client.getStickersByProduct(selectedProduct.id)
      .then((data) => {
        if (cancelled) return;
        setStickers(data as Sticker[]);
      })
      .catch((err) => {
        console.warn('[Stickers] Failed to fetch stickers:', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [client, selectedProduct]);

  // Reset to product list when dialog closes
  useEffect(() => {
    if (!open) {
      setSelectedProduct(null);
    }
  }, [open]);

  const renderContent = () => {
    if (loading) {
      return (
        <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading...
        </div>
      );
    }
    if (!selectedProduct) {
      if (products.length === 0) {
        return <div className="text-center py-8 text-muted-foreground text-sm">No sticker packs available</div>;
      }
      return (
        <div className="grid grid-cols-3 gap-2.5">
          {products.map((product) => (
            <button
              key={product.id}
              className="flex flex-col items-center gap-1.5 p-3 bg-background border border-border rounded-lg cursor-pointer hover:bg-accent transition-colors"
              onClick={() => setSelectedProduct(product)}
            >
              <img src={product.thumbnailUrl} alt={product.name} className="w-14 h-14 object-contain" />
              <span className="text-[11px] text-foreground/80 text-center leading-tight">{product.name}</span>
            </button>
          ))}
        </div>
      );
    }
    if (stickers.length === 0) {
      return <div className="text-center py-8 text-muted-foreground text-sm">No stickers in this pack</div>;
    }
    return (
      <div className="grid grid-cols-3 gap-2.5">
        {stickers.map((sticker) => (
          <button
            key={sticker.id}
            className="flex items-center justify-center p-2 bg-background border border-border rounded-lg cursor-pointer hover:bg-accent transition-colors"
            onClick={() => onSelect(sticker.imageUrl)}
          >
            <img src={sticker.imageUrl} alt={sticker.id} className="w-[72px] h-[72px] object-contain" />
          </button>
        ))}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-[440px] p-0 gap-0" showCloseButton={false}>
        <DialogHeader className="px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            {selectedProduct && (
              <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Back to sticker packs" onClick={() => setSelectedProduct(null)}>
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}
            <DialogTitle className="text-sm">
              {selectedProduct ? selectedProduct.name : 'Sticker Market'}
            </DialogTitle>
          </div>
        </DialogHeader>
        <ScrollArea className="max-h-[360px]">
          <div className="p-3">
            {renderContent()}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
};
