import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/photoProtection.ts', import.meta.url), 'utf8');

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
    Promise,
    Error,
    Number,
    Math,
    RegExp,
    Uint8ClampedArray,
  };
  vm.runInNewContext(outputText, sandbox);
  return module.exports;
}

function createPixels(width, height, pixelFor) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      pixels.set(pixelFor(x, y), (y * width + x) * 4);
    }
  }
  return pixels;
}

function pixelAt(pixels, width, x, y) {
  return Array.from(pixels.slice((y * width + x) * 4, (y * width + x) * 4 + 4));
}

function installBrowserMocks({ exportDataUrl = 'data:image/png;base64,PROTECTED' } = {}) {
  const images = new Map();
  const imageEvents = [];
  const canvases = [];

  function registerImage(src, width, height, pixels) {
    images.set(src, { width, height, pixels });
  }

  globalThis.Image = class {
    naturalWidth = 0;
    naturalHeight = 0;
    onload = null;
    onerror = null;
    _crossOrigin = '';
    _pixels = new Uint8ClampedArray();

    set crossOrigin(value) {
      this._crossOrigin = value;
      imageEvents.push(['crossOrigin', value]);
    }

    get crossOrigin() {
      return this._crossOrigin;
    }

    set src(value) {
      imageEvents.push(['src', value, this._crossOrigin]);
      const image = images.get(value);
      if (!image) {
        Promise.resolve().then(() => this.onerror?.());
        return;
      }

      this.naturalWidth = image.width;
      this.naturalHeight = image.height;
      this._pixels = image.pixels;
      Promise.resolve().then(() => this.onload?.());
    }
  };

  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const canvas = {
        width: 0,
        height: 0,
        _pixels: new Uint8ClampedArray(),
        getContext(type) {
          assert.equal(type, '2d');
          return {
            drawImage: (image, dx, dy, drawWidth, drawHeight) => {
              canvas._pixels = new Uint8ClampedArray(canvas.width * canvas.height * 4);
              for (let y = 0; y < drawHeight; y += 1) {
                for (let x = 0; x < drawWidth; x += 1) {
                  const sourceX = Math.min(image.naturalWidth - 1, Math.floor((x / drawWidth) * image.naturalWidth));
                  const sourceY = Math.min(image.naturalHeight - 1, Math.floor((y / drawHeight) * image.naturalHeight));
                  const sourceOffset = (sourceY * image.naturalWidth + sourceX) * 4;
                  const targetOffset = ((dy + y) * canvas.width + dx + x) * 4;
                  canvas._pixels.set(image._pixels.slice(sourceOffset, sourceOffset + 4), targetOffset);
                }
              }
            },
            getImageData: (x, y, width, height) => {
              const data = new Uint8ClampedArray(width * height * 4);
              for (let row = 0; row < height; row += 1) {
                for (let column = 0; column < width; column += 1) {
                  const sourceOffset = ((y + row) * canvas.width + x + column) * 4;
                  const targetOffset = (row * width + column) * 4;
                  data.set(canvas._pixels.slice(sourceOffset, sourceOffset + 4), targetOffset);
                }
              }
              return { data, width, height };
            },
            putImageData: (imageData, x, y) => {
              for (let row = 0; row < imageData.height; row += 1) {
                for (let column = 0; column < imageData.width; column += 1) {
                  const sourceOffset = (row * imageData.width + column) * 4;
                  const targetOffset = ((y + row) * canvas.width + x + column) * 4;
                  canvas._pixels.set(imageData.data.slice(sourceOffset, sourceOffset + 4), targetOffset);
                }
              }
            },
          };
        },
        toDataURL(type) {
          assert.equal(type, 'image/png');
          canvas.exportType = type;
          return exportDataUrl;
        },
      };
      canvases.push(canvas);
      return canvas;
    },
  };

  return {
    canvases,
    imageEvents,
    registerImage,
    restore() {
      delete globalThis.Image;
      delete globalThis.document;
    },
  };
}

test('preserves the protected source pixels exactly and feathers only the outside collar', async () => {
  const mocks = installBrowserMocks();
  try {
    const sourcePixels = createPixels(8, 8, (x, y) => [x * 20 + 1, y * 20 + 2, x + y + 3, 255]);
    const generatedPixels = createPixels(4, 4, (x, y) => [
      x === 0 ? 10 : 200,
      y === 0 ? 20 : 220,
      x === y ? 30 : 230,
      255,
    ]);
    mocks.registerImage('data:image/png;base64,SOURCE', 8, 8, sourcePixels);
    mocks.registerImage('data:image/png;base64,GENERATED', 4, 4, generatedPixels);

    const { preservePhotoRegion } = loadModule();
    const protectedPhoto = await preservePhotoRegion(
      {
        id: 'source',
        name: 'Original',
        dataUrl: 'data:image/png;base64,SOURCE',
        storagePath: 'photos/source.png',
      },
      {
        id: 'generated',
        name: 'Generated',
        dataUrl: 'data:image/png;base64,GENERATED',
        storagePath: 'photos/generated.jpg',
      },
      { x: 0.375, y: 0.375, width: 0.25, height: 0.25 },
    );

    assert.equal(protectedPhoto.id, 'generated');
    assert.equal(protectedPhoto.name, 'Generated');
    assert.equal(protectedPhoto.dataUrl, 'data:image/png;base64,PROTECTED');
    assert.equal(protectedPhoto.storagePath, undefined);
    assert.equal(mocks.canvases[0].width, 8);
    assert.equal(mocks.canvases[0].height, 8);
    assert.equal(mocks.canvases[0].exportType, 'image/png');

    const outputPixels = mocks.canvases[0]._pixels;
    for (const [x, y] of [[3, 3], [4, 3], [3, 4], [4, 4]]) {
      assert.deepEqual(pixelAt(outputPixels, 8, x, y), pixelAt(sourcePixels, 8, x, y));
    }

    assert.deepEqual(pixelAt(outputPixels, 8, 0, 0), pixelAt(generatedPixels, 4, 0, 0));
    assert.deepEqual(pixelAt(outputPixels, 8, 7, 0), pixelAt(generatedPixels, 4, 3, 0));
    assert.deepEqual(pixelAt(outputPixels, 8, 0, 7), pixelAt(generatedPixels, 4, 0, 3));
    assert.deepEqual(pixelAt(outputPixels, 8, 7, 7), pixelAt(generatedPixels, 4, 3, 3));

    const collarPixel = pixelAt(outputPixels, 8, 2, 3);
    const sourceCollarPixel = pixelAt(sourcePixels, 8, 2, 3);
    const generatedCollarPixel = pixelAt(generatedPixels, 4, 1, 1);
    assert.notDeepEqual(collarPixel, sourceCollarPixel);
    assert.notDeepEqual(collarPixel, generatedCollarPixel);
    assert.ok(collarPixel[0] > Math.min(sourceCollarPixel[0], generatedCollarPixel[0]));
    assert.ok(collarPixel[0] < Math.max(sourceCollarPixel[0], generatedCollarPixel[0]));
  } finally {
    mocks.restore();
  }
});

test('remote images request anonymous CORS before assigning src', async () => {
  const mocks = installBrowserMocks();
  try {
    mocks.registerImage('https://cdn.example.test/source.png', 2, 2, createPixels(2, 2, () => [1, 2, 3, 255]));
    mocks.registerImage('https://cdn.example.test/generated.png', 2, 2, createPixels(2, 2, () => [4, 5, 6, 255]));

    const { preservePhotoRegion } = loadModule();
    await preservePhotoRegion(
      { id: 'source', name: 'Source', dataUrl: 'https://cdn.example.test/source.png' },
      { id: 'generated', name: 'Generated', dataUrl: 'https://cdn.example.test/generated.png' },
      { x: 0, y: 0, width: 0.5, height: 0.5 },
    );

    assert.deepEqual(mocks.imageEvents.slice(0, 4), [
      ['crossOrigin', 'anonymous'],
      ['src', 'https://cdn.example.test/source.png', 'anonymous'],
      ['crossOrigin', 'anonymous'],
      ['src', 'https://cdn.example.test/generated.png', 'anonymous'],
    ]);
  } finally {
    mocks.restore();
  }
});

test('region helpers clip bounded rectangles and reject invalid regions', () => {
  const { clampProtectedRegion, featherRadiusForSize, normalizedRegionToPixels, pngDataUrlBytes } = loadModule();

  assert.deepEqual({ ...clampProtectedRegion({ x: 0.75, y: 0.5, width: 0.5, height: 0.75 }) }, {
    x: 0.75,
    y: 0.5,
    width: 0.25,
    height: 0.5,
  });
  assert.deepEqual({ ...normalizedRegionToPixels({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, 8, 4) }, {
    x: 2,
    y: 1,
    width: 4,
    height: 2,
  });
  assert.equal(featherRadiusForSize(100, 50), 2);
  assert.equal(featherRadiusForSize(1200, 900), 12);
  assert.equal(featherRadiusForSize(2400, 1600), 16);
  assert.equal(pngDataUrlBytes('data:image/png;base64,QUJDRA=='), 4);

  assert.throws(() => clampProtectedRegion({ x: Number.NaN, y: 0, width: 0.5, height: 0.5 }), /좌표/);
  assert.throws(() => clampProtectedRegion({ x: 0, y: 0, width: 0, height: 0.5 }), /너비와 높이/);
  assert.throws(() => clampProtectedRegion({ x: -0.1, y: 0, width: 0.5, height: 0.5 }), /사진 안/);
  assert.throws(() => normalizedRegionToPixels({ x: 0, y: 0, width: 0.5, height: 0.5 }, 0, 4), /사진 크기/);
});

test('oversized protected PNG exports fail instead of silently changing the image', async () => {
  const oversizedPng = `data:image/png;base64,${'A'.repeat(Math.ceil((5 * 1024 * 1024 + 1) / 3) * 4)}`;
  const mocks = installBrowserMocks({ exportDataUrl: oversizedPng });
  try {
    mocks.registerImage('data:image/png;base64,SOURCE', 2, 2, createPixels(2, 2, () => [1, 2, 3, 255]));
    mocks.registerImage('data:image/png;base64,GENERATED', 2, 2, createPixels(2, 2, () => [4, 5, 6, 255]));

    const { preservePhotoRegion } = loadModule();
    await assert.rejects(
      () => preservePhotoRegion(
        { id: 'source', name: 'Source', dataUrl: 'data:image/png;base64,SOURCE' },
        { id: 'generated', name: 'Generated', dataUrl: 'data:image/png;base64,GENERATED' },
        { x: 0, y: 0, width: 0.5, height: 0.5 },
      ),
      /5MB/,
    );
  } finally {
    mocks.restore();
  }
});
