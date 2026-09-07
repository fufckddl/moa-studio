import type { ContentPack, Photo } from '../types';

const SIGNED_STORAGE_PREFIX = '/storage/v1/object/sign/';

function signedStorageVersion(photo: Photo): string | null {
  if (!photo.storagePath) return null;
  let url: URL;
  try {
    url = new URL(photo.dataUrl);
  } catch {
    return null;
  }
  if (!url.pathname.startsWith(SIGNED_STORAGE_PREFIX)) return null;
  const signedPath = url.pathname.slice(SIGNED_STORAGE_PREFIX.length);
  const firstSlash = signedPath.indexOf('/');
  if (firstSlash < 1) return null;
  const bucket = signedPath.slice(0, firstSlash);
  const objectPath = signedPath.slice(firstSlash + 1);
  try {
    if (decodeURIComponent(objectPath) !== photo.storagePath) return null;
    return JSON.stringify(['signed-storage', photo.id, photo.storagePath, url.origin, `${SIGNED_STORAGE_PREFIX}${bucket}/${objectPath}`]);
  } catch {
    return null;
  }
}

export function photoVersion(photo?: Photo): string | null {
  if (!photo) return null;
  return signedStorageVersion(photo) ?? JSON.stringify(['photo', photo.id, photo.dataUrl]);
}

// Each accepted edit keeps a new photo ID so saving cannot overwrite the
// original storage object needed by Undo or another saved project.
export function replaceWorkspacePhoto(photos: Photo[], pack: ContentPack, previous: Photo, next: Photo): { photos: Photo[]; pack: ContentPack } | null {
  if (!photos.some(photo => photoVersion(photo) === photoVersion(previous))) return null;
  if (next.id !== previous.id && photos.some(photo => photo.id === next.id)) return null;
  return {
    photos: photos.map(photo => photo.id === previous.id ? next : photo),
    pack: { ...pack, cards: pack.cards.map(card => card.imageId === previous.id ? { ...card, imageId: next.id } : card) },
  };
}
