import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/images.ts', import.meta.url), 'utf8');

function loadModule() {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    require: (specifier) => {
      throw new Error(`unexpected import: ${specifier}`);
    },
    globalThis,
    window: { location: { origin: 'https://app.example.test' } },
    URL,
    Image: globalThis.Image,
    document: globalThis.document,
    FileReader: globalThis.FileReader,
    Blob,
    Promise,
    Error,
    Set,
    Date,
    Math,
    RegExp,
    String,
  };
  vm.runInNewContext(outputText, sandbox);
  return module.exports;
}

function installBrowserMocks({ failExport = false, width = 960, height = 540 } = {}) {
  const imageEvents = [];
  const canvases = [];

  globalThis.Image = class {
    naturalWidth = width;
    naturalHeight = height;
    onload = null;
    onerror = null;
    _crossOrigin = '';

    set crossOrigin(value) {
      this._crossOrigin = value;
      imageEvents.push(['crossOrigin', value]);
    }

    get crossOrigin() {
      return this._crossOrigin;
    }

    set src(value) {
      imageEvents.push(['src', value, this._crossOrigin]);
      Promise.resolve().then(() => this.onload?.());
    }
  };

  globalThis.FileReader = class {
    result = '';
    onload = null;
    onerror = null;

    readAsDataURL() {
      this.result = 'data:image/jpeg;base64,PREPARED';
      this.onload?.();
    }
  };

  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const canvas = {
        width: 0,
        height: 0,
        contextCalls: [],
        getContext(type) {
          assert.equal(type, '2d');
          return {
            set fillStyle(value) {
              canvas.contextCalls.push(['fillStyle', value]);
            },
            fillRect: (...args) => canvas.contextCalls.push(['fillRect', ...args]),
            drawImage: (...args) => canvas.contextCalls.push(['drawImage', ...args]),
          };
        },
        toBlob(callback, type, quality) {
          if (failExport) throw new Error('Tainted canvases may not be exported.');
          canvas.toBlobArgs = [type, quality];
          callback(new Blob(['prepared'], { type }));
        },
      };
      canvases.push(canvas);
      return canvas;
    },
  };

  return {
    imageEvents,
    canvases,
    restore() {
      delete globalThis.Image;
      delete globalThis.FileReader;
      delete globalThis.document;
    },
  };
}

test('remote photo edit images request anonymous CORS before assigning src', async () => {
  const mocks = installBrowserMocks();
  try {
    const { preparePhotoForEdit } = loadModule();

    const prepared = await preparePhotoForEdit({
      id: 'stored-photo',
      name: 'Stored photo',
      dataUrl: 'https://project.supabase.co/storage/v1/object/sign/moa-photos/user/photo.jpg?token=signed',
      storagePath: 'user/photo.jpg',
    });

    assert.equal(prepared.dataUrl, 'data:image/jpeg;base64,PREPARED');
    assert.equal(prepared.storagePath, 'user/photo.jpg');
    assert.deepEqual(mocks.imageEvents.slice(0, 2), [
      ['crossOrigin', 'anonymous'],
      ['src', 'https://project.supabase.co/storage/v1/object/sign/moa-photos/user/photo.jpg?token=signed', 'anonymous'],
    ]);
    assert.deepEqual(mocks.canvases[0].toBlobArgs, ['image/jpeg', 0.9]);
  } finally {
    mocks.restore();
  }
});

test('data, blob, and local edit images keep plain image loading', async () => {
  for (const dataUrl of [
    'data:image/jpeg;base64,AAAA',
    'blob:https://app.example.test/photo',
    '/assets/cafe-latte.png',
    './assets/cafe-latte.png',
    'assets/cafe-latte.png',
  ]) {
    const mocks = installBrowserMocks();
    try {
      const { preparePhotoForEdit } = loadModule();
      await preparePhotoForEdit({ id: dataUrl, name: 'Local photo', dataUrl });
      assert.deepEqual(mocks.imageEvents, [['src', dataUrl, '']]);
    } finally {
      mocks.restore();
    }
  }
});

test('photo preparation rejects when the canvas cannot be exported', async () => {
  const mocks = installBrowserMocks({ failExport: true });
  try {
    const { preparePhotoForEdit } = loadModule();

    await assert.rejects(
      () => preparePhotoForEdit({ id: 'photo', name: 'Photo', dataUrl: 'data:image/jpeg;base64,AAAA' }),
      /저장용 이미지로 변환/,
    );
  } finally {
    mocks.restore();
  }
});


test('edit inputs retain detail up to 1024px without stretching the source', async () => {
  const mocks = installBrowserMocks({ width: 2048, height: 1536 });
  try {
    const { preparePhotoForEdit } = loadModule();
    await preparePhotoForEdit({ id: 'portrait', name: '참고', dataUrl: 'data:image/jpeg;base64,AAAA' });
    assert.equal(mocks.canvases[0].width, 1024);
    assert.equal(mocks.canvases[0].height, 768);
  } finally { mocks.restore(); }
});
