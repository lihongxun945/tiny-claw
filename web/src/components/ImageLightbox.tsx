import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { Attachment } from "../types.js";

const SWIPE_THRESHOLD_PX = 50;

interface Props {
  attachments: Attachment[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

export default function ImageLightbox({
  attachments,
  index,
  onIndexChange,
  onClose,
}: Props) {
  const pointerStartX = useRef<number | null>(null);
  const hasPrevious = index > 0;
  const hasNext = index < attachments.length - 1;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft" && hasPrevious) onIndexChange(index - 1);
      if (event.key === "ArrowRight" && hasNext) onIndexChange(index + 1);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [hasNext, hasPrevious, index, onClose, onIndexChange]);

  const finishSwipe = (clientX: number) => {
    const startX = pointerStartX.current;
    pointerStartX.current = null;
    if (startX === null) return;

    const distance = clientX - startX;
    if (distance <= -SWIPE_THRESHOLD_PX && hasNext) onIndexChange(index + 1);
    if (distance >= SWIPE_THRESHOLD_PX && hasPrevious) onIndexChange(index - 1);
  };

  return createPortal(
    <div
      className="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button
        type="button"
        className="image-lightbox-close"
        aria-label="关闭图片预览"
        onClick={onClose}
        autoFocus
      >
        ×
      </button>

      {attachments.length > 1 && (
        <>
          <button
            type="button"
            className="image-lightbox-nav previous"
            aria-label="上一张图片"
            disabled={!hasPrevious}
            onClick={() => onIndexChange(index - 1)}
          >
            ‹
          </button>
          <button
            type="button"
            className="image-lightbox-nav next"
            aria-label="下一张图片"
            disabled={!hasNext}
            onClick={() => onIndexChange(index + 1)}
          >
            ›
          </button>
        </>
      )}

      <div
        className="image-lightbox-viewport"
        onPointerDown={(event) => {
          pointerStartX.current = event.clientX;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerUp={(event) => finishSwipe(event.clientX)}
        onPointerCancel={() => {
          pointerStartX.current = null;
        }}
      >
        <div
          className="image-lightbox-track"
          style={{ transform: `translateX(-${index * 100}%)` }}
        >
          {attachments.map((attachment) => (
            <figure className="image-lightbox-slide" key={attachment.id}>
              <img src={attachment.url} alt={attachment.name} />
              <figcaption>{attachment.name}</figcaption>
            </figure>
          ))}
        </div>
      </div>

      {attachments.length > 1 && (
        <div className="image-lightbox-counter" aria-live="polite">
          {index + 1} / {attachments.length}
        </div>
      )}
    </div>,
    document.body,
  );
}
