// Images pasted into the chat, kept in the project as chat/images/<id>.png or .jpg. What comes
// from the window is checked before it's written, and what's in the project (which may be
// someone else's) before it's shown or sent to the model.
// No Electron imports, so it's tested with plain Node.
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  IMAGE_FILE,
  MAX_IMAGE_BYTES,
  MAX_MESSAGE_IMAGES,
  fileMediaType,
  imageMediaType,
} from '../shared/chat-images';
import { newId } from '../shared/ids';
import type { PastedImage } from '../shared/types';

const imagesDir = (filesDir: string) => path.join(filesDir, 'chat', 'images');

/** The images sent with a message, as bytes. Throws if they aren't what the chat sends. */
export function checkImages(images: unknown): Buffer[] {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images) || images.length > MAX_MESSAGE_IMAGES) {
    throw new Error(
      `A message can have at most ${MAX_MESSAGE_IMAGES} images. Remove some, then send it again.`,
    );
  }
  return images.map((image: Partial<PastedImage> | null) => {
    const bytes =
      typeof image?.data === 'string'
        ? Buffer.from(image.data, 'base64')
        : Buffer.alloc(0);
    const type = imageMediaType(bytes);
    if (!type || type !== image?.mediaType || bytes.length > MAX_IMAGE_BYTES) {
      throw new Error("One of the images couldn't be read. Paste it again.");
    }
    return bytes;
  });
}

/** Writes a message's images to the project and returns their file names. */
export async function writeImages(
  filesDir: string,
  images: Buffer[],
): Promise<string[]> {
  if (!images.length) return [];
  await fs.mkdir(imagesDir(filesDir), { recursive: true });
  const names: string[] = [];
  for (const bytes of images) {
    const extension = imageMediaType(bytes) === 'image/png' ? 'png' : 'jpg';
    const name = `${newId(12)}.${extension}`;
    await fs.writeFile(path.join(imagesDir(filesDir), name), bytes);
    names.push(name);
  }
  return names;
}

/** One of the project's chat images, or null if it's missing or isn't a sound image file. */
export async function readImage(
  filesDir: string,
  name: unknown,
): Promise<PastedImage | null> {
  if (typeof name !== 'string' || !IMAGE_FILE.test(name)) return null;
  const file = path.join(imagesDir(filesDir), name);
  try {
    const { size } = await fs.stat(file);
    if (size > MAX_IMAGE_BYTES) return null;
    const bytes = await fs.readFile(file);
    const mediaType = imageMediaType(bytes);
    if (!mediaType || mediaType !== fileMediaType(name)) return null;
    return { mediaType, data: bytes.toString('base64') };
  } catch {
    return null;
  }
}
