import React, { useState, useEffect } from 'react';
import type { NatsConnection, Codec } from 'nats.ws';
import { tracedHeaders } from '../utils/tracing';

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
  nc: NatsConnection;
  sc: Codec<string>;
  onSelect: (stickerUrl: string) => void;
  onClose: () => void;
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },
  modal: {
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: '12px',
    width: '420px',
    maxHeight: '480px',
    display: 'flex',
    flexDirection: 'column',
    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    borderBottom: '1px solid #334155',
  },
  title: {
    fontSize: '15px',
    fontWeight: 700,
    color: '#f1f5f9',
  },
  backBtn: {
    background: 'transparent',
    border: 'none',
    color: '#94a3b8',
    fontSize: '13px',
    cursor: 'pointer',
    padding: '4px 8px',
    borderRadius: '4px',
  },
  closeBtn: {
    background: 'transparent',
    border: 'none',
    color: '#64748b',
    fontSize: '18px',
    cursor: 'pointer',
    padding: '4px 8px',
    lineHeight: 1,
  },
  body: {
    flex: 1,
    overflowY: 'auto',
    padding: '12px',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '10px',
  },
  productCard: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '6px',
    padding: '12px 8px',
    background: '#0f172a',
    border: '1px solid #334155',
    borderRadius: '8px',
    cursor: 'pointer',
  },
  productThumb: {
    width: '56px',
    height: '56px',
    objectFit: 'contain',
  },
  productName: {
    fontSize: '11px',
    color: '#cbd5e1',
    textAlign: 'center',
    lineHeight: 1.3,
  },
  stickerCard: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '8px',
    background: '#0f172a',
    border: '1px solid #334155',
    borderRadius: '8px',
    cursor: 'pointer',
  },
  stickerImg: {
    width: '72px',
    height: '72px',
    objectFit: 'contain',
  },
  loading: {
    textAlign: 'center',
    color: '#64748b',
    fontSize: '13px',
    padding: '24px',
  },
  empty: {
    textAlign: 'center',
    color: '#475569',
    fontSize: '13px',
    padding: '24px',
  },
};

export const StickerMarket: React.FC<Props> = ({ nc, sc, onSelect, onClose }) => {
  const [products, setProducts] = useState<StickerProduct[]>([]);
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<StickerProduct | null>(null);
  const [loading, setLoading] = useState(true);

  // Fetch products on mount
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const { headers } = tracedHeaders();
    nc.request('stickers.products', sc.encode(''), { timeout: 5000, headers })
      .then((reply) => {
        if (cancelled) return;
        const data = JSON.parse(sc.decode(reply.data)) as StickerProduct[];
        setProducts(data);
      })
      .catch((err) => {
        console.log('[Stickers] Failed to fetch products:', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [nc, sc]);

  // Fetch stickers when product selected
  useEffect(() => {
    if (!selectedProduct) {
      setStickers([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const { headers } = tracedHeaders();
    nc.request(`stickers.product.${selectedProduct.id}`, sc.encode(''), { timeout: 5000, headers })
      .then((reply) => {
        if (cancelled) return;
        const data = JSON.parse(sc.decode(reply.data)) as Sticker[];
        setStickers(data);
      })
      .catch((err) => {
        console.log('[Stickers] Failed to fetch stickers:', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [nc, sc, selectedProduct]);

  const handleProductClick = (product: StickerProduct) => {
    setSelectedProduct(product);
  };

  const handleStickerClick = (sticker: Sticker) => {
    onSelect(sticker.imageUrl);
  };

  const handleBack = () => {
    setSelectedProduct(null);
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {selectedProduct && (
              <button style={styles.backBtn} onClick={handleBack}>
                &#8592;
              </button>
            )}
            <span style={styles.title}>
              {selectedProduct ? selectedProduct.name : 'Sticker Market'}
            </span>
          </div>
          <button style={styles.closeBtn} onClick={onClose}>
            &#10005;
          </button>
        </div>
        <div style={styles.body}>
          {loading ? (
            <div style={styles.loading}>Loading...</div>
          ) : !selectedProduct ? (
            products.length === 0 ? (
              <div style={styles.empty}>No sticker packs available</div>
            ) : (
              <div style={styles.grid}>
                {products.map((product) => (
                  <div
                    key={product.id}
                    style={styles.productCard}
                    onClick={() => handleProductClick(product)}
                  >
                    <img
                      src={product.thumbnailUrl}
                      alt={product.name}
                      style={styles.productThumb}
                    />
                    <span style={styles.productName}>{product.name}</span>
                  </div>
                ))}
              </div>
            )
          ) : (
            stickers.length === 0 ? (
              <div style={styles.empty}>No stickers in this pack</div>
            ) : (
              <div style={styles.grid}>
                {stickers.map((sticker) => (
                  <div
                    key={sticker.id}
                    style={styles.stickerCard}
                    onClick={() => handleStickerClick(sticker)}
                  >
                    <img
                      src={sticker.imageUrl}
                      alt={sticker.id}
                      style={styles.stickerImg}
                    />
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
};
