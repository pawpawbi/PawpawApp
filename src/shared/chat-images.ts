// Images the user pastes into the chat: the limits, and the checks on what's saved. The app
// re-encodes every pasted image as a PNG or JPEG within these limits (src/chat-image.ts) and
// keeps it in the project as chat/images/<id>.png or .jpg. Those files, and the names on saved
// messages, come from a project file that may be someone else's, so they're checked before use.
// No browser or Node APIs, so both the app and the main process use it.
import type { ChatMessage, PastedImage } from './types';

/** How many images one message can have. */
export const MAX_MESSAGE_IMAGES = 4;
/** The largest image file. Keeps a request with several well inside the providers' limits. */
export const MAX_IMAGE_BYTES = 300_000;
/** The longest side, in pixels: more than this, the models scale down anyway. */
export const MAX_IMAGE_EDGE = 1568;
/**
 * How many of the conversation's images are sent with a request: the latest ones. Every
 * request carries the conversation again, so older images are left out and said to be.
 */
export const MAX_SENT_IMAGES = 4;

/** An image's file name in chat/images/. */
export const IMAGE_FILE = /^[a-z0-9]{1,32}\.(png|jpg)$/;

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];

const startsWith = (bytes: Uint8Array, start: number[]) =>
  bytes.length > start.length && start.every((byte, i) => bytes[i] === byte);

/** What kind of image these bytes are, from how they start, or null if neither kind. */
export function imageMediaType(
  bytes: Uint8Array,
): PastedImage['mediaType'] | null {
  if (startsWith(bytes, PNG)) return 'image/png';
  if (startsWith(bytes, JPEG)) return 'image/jpeg';
  return null;
}

/** The kind of image a file in chat/images/ should be, by its name. */
export const fileMediaType = (name: string): PastedImage['mediaType'] =>
  name.endsWith('.png') ? 'image/png' : 'image/jpeg';

/** The image files a saved message names, leaving out anything that isn't one. */
export function messageImages(message: ChatMessage): string[] {
  const images: unknown = message.images;
  if (!Array.isArray(images)) return [];
  return images
    .filter(
      (name): name is string =>
        typeof name === 'string' && IMAGE_FILE.test(name),
    )
    .slice(0, MAX_MESSAGE_IMAGES);
}
