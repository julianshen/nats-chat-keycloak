import React, { useState, useEffect } from 'react';
import type { ChatClient } from '../lib/chat-client';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ArrowLeft, X, Loader2 } from 'lucide-react';

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
  client: ChatClient;
  onSelect: (stickerUrl: string) => void;
  onClose: () => void;
}

export const StickerMarket: React.FC<Props> = ({ client, onSelect, onClose }) => {
  const [products, setProducts] = useState<StickerProduct[]>([]);
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<StickerProduct | null>(null);
  const [loading, setLoading] = useState(true);

  // Fetch products on mount
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    client.getStickerProducts()
      .then((data) => {
        if (cancelled) return;
        setProducts(data as StickerProduct[]);
      })
      .catch((err) => {
        console.log('[Stickers] Failed to fetch products:', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [client]);

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
        console.log('[Stickers] Failed to fetch stickers:', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [client, selectedProduct]);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-[440px] p-0 gap-0">
        <DialogHeader className="px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            {selectedProduct && (
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setSelectedProduct(null)}>
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
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground text-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading...
              </div>
            ) : !selectedProduct ? (
              products.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">No sticker packs available</div>
              ) : (
                <div className="grid grid-cols-3 gap-2.5">
                  {products.map((product) => (
                    <button
                      key={product.id}
                      className="flex flex-col items-center gap-1.5 p-3 bg-background border border-border rounded-lg cursor-pointer hover:bg-accent transition-colors"
                      onClick={() => setSelectedProduct(product)}
                    >
                      <img
                        src={product.thumbnailUrl}
                        alt={product.name}
                        className="w-14 h-14 object-contain"
                      />
                      <span className="text-[11px] text-foreground/80 text-center leading-tight">{product.name}</span>
                    </button>
                  ))}
                </div>
              )
            ) : (
              stickers.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">No stickers in this pack</div>
              ) : (
                <div className="grid grid-cols-3 gap-2.5">
                  {stickers.map((sticker) => (
                    <button
                      key={sticker.id}
                      className="flex items-center justify-center p-2 bg-background border border-border rounded-lg cursor-pointer hover:bg-accent transition-colors"
                      onClick={() => onSelect(sticker.imageUrl)}
                    >
                      <img
                        src={sticker.imageUrl}
                        alt={sticker.id}
                        className="w-[72px] h-[72px] object-contain"
                      />
                    </button>
                  ))}
                </div>
              )
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
};
