// A pasted image made ready for the chat: redrawn (so only its pixels are kept, not whatever
// else the file held) as a PNG, or a JPEG when that's what fits, within the limits in
// shared/chat-images.ts. Runs in the window.
import { MAX_IMAGE_BYTES, MAX_IMAGE_EDGE } from './shared/chat-images';
import type { PastedImage } from './shared/types';

/** What the chat shows for an image, and sends. */
export const imageUrl = (image: PastedImage) =>
  `data:${image.mediaType};base64,${image.data}`;

function encode(
  canvas: HTMLCanvasElement,
  type: PastedImage['mediaType'],
  quality?: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Throws if the file isn't an image the app can read. */
export async function prepareImage(file: Blob): Promise<PastedImage> {
  const bitmap = await createImageBitmap(file);
  try {
    let scale = Math.min(
      1,
      MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height),
    );
    // Smaller each time round, until it fits.
    for (let attempt = 0; attempt < 8; attempt++, scale *= 0.7) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      if (!context) break;
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const tries: [PastedImage['mediaType'], number?][] = [
        ['image/png'],
        ['image/jpeg', 0.85],
        ['image/jpeg', 0.6],
      ];
      for (const [mediaType, quality] of tries) {
        if (mediaType === 'image/jpeg' && quality === 0.85) {
          // JPEG has no transparency: put the picture on white.
          context.globalCompositeOperation = 'destination-over';
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, canvas.width, canvas.height);
        }
        const blob = await encode(canvas, mediaType, quality);
        if (blob && blob.type === mediaType && blob.size <= MAX_IMAGE_BYTES) {
          return { mediaType, data: await base64(blob) };
        }
      }
    }
  } finally {
    bitmap.close();
  }
  throw new Error('The image is too large.');
}
