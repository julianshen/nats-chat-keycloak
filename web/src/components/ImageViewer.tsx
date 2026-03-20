import React, { useEffect, useCallback, useState, useRef } from 'react';
import { X, ZoomIn, ZoomOut, RotateCw, Download, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ImageItem {
  src: string;
  alt: string;
}

interface Props {
  images: ImageItem[];
  startIndex?: number;
  onClose: () => void;
}

export const ImageViewer: React.FC<Props> = ({ images, startIndex = 0, onClose }) => {
  const [currentIndex, setCurrentIndex] = useState(startIndex);
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const posStart = useRef({ x: 0, y: 0 });

  const current = images[currentIndex];
  const hasMultiple = images.length > 1;

  const resetView = useCallback(() => {
    setScale(1);
    setRotation(0);
    setPosition({ x: 0, y: 0 });
  }, []);

  const goNext = useCallback(() => {
    if (currentIndex < images.length - 1) {
      setCurrentIndex(i => i + 1);
      resetView();
    }
  }, [currentIndex, images.length, resetView]);

  const goPrev = useCallback(() => {
    if (currentIndex > 0) {
      setCurrentIndex(i => i - 1);
      resetView();
    }
  }, [currentIndex, resetView]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === '+' || e.key === '=') setScale(s => Math.min(s + 0.25, 5));
      if (e.key === '-') setScale(s => Math.max(s - 0.25, 0.25));
      if (e.key === '0') resetView();
      if (e.key === 'ArrowRight') goNext();
      if (e.key === 'ArrowLeft') goPrev();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose, resetView, goNext, goPrev]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setScale(s => Math.max(0.25, Math.min(5, s + delta)));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY };
    posStart.current = { ...position };
  }, [position]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return;
    setPosition({
      x: posStart.current.x + (e.clientX - dragStart.current.x),
      y: posStart.current.y + (e.clientY - dragStart.current.y),
    });
  }, [dragging]);

  const handleMouseUp = useCallback(() => {
    setDragging(false);
  }, []);

  if (!current) return null;

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* Toolbar */}
      <div className="absolute top-4 right-4 flex items-center gap-1 z-10">
        <button
          className="p-2 rounded-lg bg-black/50 text-white hover:bg-black/70 transition-colors"
          onClick={() => setScale(s => Math.min(s + 0.25, 5))}
          title="Zoom in (+)"
        >
          <ZoomIn className="h-5 w-5" />
        </button>
        <button
          className="p-2 rounded-lg bg-black/50 text-white hover:bg-black/70 transition-colors"
          onClick={() => setScale(s => Math.max(s - 0.25, 0.25))}
          title="Zoom out (-)"
        >
          <ZoomOut className="h-5 w-5" />
        </button>
        <button
          className="p-2 rounded-lg bg-black/50 text-white hover:bg-black/70 transition-colors"
          onClick={() => setRotation(r => r + 90)}
          title="Rotate"
        >
          <RotateCw className="h-5 w-5" />
        </button>
        <button
          className="p-2 rounded-lg bg-black/50 text-white hover:bg-black/70 transition-colors"
          onClick={resetView}
          title="Reset (0)"
        >
          <span className="text-xs font-medium px-1">1:1</span>
        </button>
        <a
          href={current.src}
          download={current.alt}
          className="p-2 rounded-lg bg-black/50 text-white hover:bg-black/70 transition-colors"
          title="Download"
          onClick={(e) => e.stopPropagation()}
        >
          <Download className="h-5 w-5" />
        </a>
        <button
          className="p-2 rounded-lg bg-black/50 text-white hover:bg-black/70 transition-colors"
          onClick={onClose}
          title="Close (Esc)"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Prev button */}
      {hasMultiple && currentIndex > 0 && (
        <button
          className="absolute left-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors z-10"
          onClick={goPrev}
          title="Previous image"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>
      )}

      {/* Next button */}
      {hasMultiple && currentIndex < images.length - 1 && (
        <button
          className="absolute right-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors z-10"
          onClick={goNext}
          title="Next image"
        >
          <ChevronRight className="h-6 w-6" />
        </button>
      )}

      {/* Scale indicator */}
      {scale !== 1 && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-black/50 text-white text-sm z-10">
          {Math.round(scale * 100)}%
        </div>
      )}

      {/* Image */}
      <img
        src={current.src}
        alt={current.alt}
        className={cn(
          'max-w-[90vw] max-h-[90vh] object-contain select-none',
          dragging ? 'cursor-grabbing' : 'cursor-grab',
        )}
        style={{
          transform: `translate(${position.x}px, ${position.y}px) scale(${scale}) rotate(${rotation}deg)`,
          transition: dragging ? 'none' : 'transform 0.2s ease',
        }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        draggable={false}
      />

      {/* Footer: filename + counter */}
      <div className="absolute bottom-4 right-4 flex items-center gap-3 z-10">
        {hasMultiple && (
          <div className="px-3 py-1 rounded-lg bg-black/50 text-white text-xs">
            {currentIndex + 1} / {images.length}
          </div>
        )}
        <div className="px-3 py-1 rounded-lg bg-black/50 text-white text-xs">
          {current.alt}
        </div>
      </div>
    </div>
  );
};
