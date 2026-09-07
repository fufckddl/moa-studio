import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const { outputText } = ts.transpileModule(readFileSync(new URL('../src/lib/photo-edit.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { photoVersion, replaceWorkspacePhoto } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const signedUrl = (token, path = 'user/project/original.jpg', origin = 'https://project.supabase.co') => `${origin}/storage/v1/object/sign/moa-photos/${encodeURIComponent(path).replaceAll('%2F', '/')}?token=${token}`;
const original = { id: 'original', name: '원본', dataUrl: 'https://example.test/original', storagePath: 'user/project/original.jpg' };
const signedOriginal = { ...original, dataUrl: signedUrl('first-token') };
const edited = { id: 'edited', name: '수정본', dataUrl: 'data:image/jpeg;base64,AAAA' };
const other = { id: 'other', name: '다른 사진', dataUrl: '/other.jpg' };
const pack = { source: 'template', cards: [{ id: '1', title: '직접 쓴 제목', imageId: 'original', layout: 'poster' }, { id: '2', title: '같은 사진', imageId: 'original' }, { id: '3', title: '다른 카드', imageId: 'other' }], caption: '원래 게시글', hashtags: [], schedule: [] };

test('photoVersion ignores signed Supabase URL token rotation for the same stored photo', () => {
  assert.equal(photoVersion(signedOriginal), photoVersion({ ...signedOriginal, dataUrl: signedUrl('second-token') }));
  assert.notEqual(photoVersion(signedOriginal), photoVersion({ ...signedOriginal, id: 'replacement' }));
});

test('photoVersion keeps local image identity stable when storage metadata is attached', () => {
  const localPhoto = { id: 'local', name: '로컬', dataUrl: 'data:image/jpeg;base64,AAAA' };
  assert.equal(photoVersion(localPhoto), photoVersion({ ...localPhoto, storagePath: 'user/project/local.jpg' }));
  assert.notEqual(photoVersion(localPhoto), photoVersion({ ...localPhoto, dataUrl: 'data:image/jpeg;base64,BBBB' }));
  assert.equal(photoVersion(), null);
});

test('applying and undoing a photo updates linked cards and preserves original storage and card edits', () => {
  const currentOriginal = { ...signedOriginal, dataUrl: signedUrl('refreshed-token') };
  const applied = replaceWorkspacePhoto([currentOriginal, other], pack, signedOriginal, edited);
  assert.deepEqual(applied.photos, [edited, other]);
  assert.deepEqual(applied.pack.cards.map(card => card.imageId), ['edited', 'edited', 'other']);
  assert.equal(applied.pack.cards[0].title, '직접 쓴 제목');
  assert.equal(applied.photos[0].storagePath, undefined);
  assert.equal(original.storagePath, 'user/project/original.jpg');
  const manuallyEditedPack = { ...applied.pack, caption: '적용 후 수정한 게시글' };
  const undone = replaceWorkspacePhoto(applied.photos, manuallyEditedPack, edited, currentOriginal);
  assert.deepEqual(undone.photos, [currentOriginal, other]);
  assert.deepEqual(undone.pack.cards, pack.cards);
  assert.equal(undone.pack.caption, '적용 후 수정한 게시글');
});

test('stale or colliding photo proposals cannot overwrite newer edits', () => {
  assert.equal(replaceWorkspacePhoto([original, other], pack, { ...original, dataUrl: 'old' }, edited), null);
  assert.equal(replaceWorkspacePhoto([signedOriginal, other], pack, { ...signedOriginal, id: 'replacement' }, edited), null);
  assert.equal(replaceWorkspacePhoto([signedOriginal, other], pack, { ...signedOriginal, storagePath: 'user/project/replacement.jpg' }, edited), null);
  assert.equal(replaceWorkspacePhoto([signedOriginal, other], pack, { ...signedOriginal, dataUrl: signedUrl('fresh', 'user/project/replacement.jpg'), storagePath: 'user/project/replacement.jpg' }, edited), null);
  assert.equal(replaceWorkspacePhoto([signedOriginal, other], pack, { ...signedOriginal, dataUrl: signedUrl('fresh', 'user/project/original.jpg', 'https://other.supabase.co') }, edited), null);
  assert.equal(replaceWorkspacePhoto([other], pack, original, edited), null);
  assert.equal(replaceWorkspacePhoto([original, other], pack, original, { ...edited, id: 'other' }), null);
});
