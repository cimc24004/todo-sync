'use strict';
// Mechanical size/format conversion of the generated source artwork.
const fs = require('node:fs');
const path = require('node:path');
const electron = require('electron');

if (typeof electron === 'string') {
  const {spawnSync} = require('node:child_process');
  const env = {...process.env};
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(electron, [__filename], {env, stdio: 'inherit', windowsHide: true});
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} else {
  const {app, nativeImage} = electron;
  app.whenReady().then(() => {
    const directory = path.join(__dirname, '..', 'src', 'assets');
    const source = nativeImage.createFromPath(path.join(directory, 'app-icon-source.png'));
    if (source.isEmpty()) throw Error('The generated app icon source could not be read.');
    const png = size => source.resize({width: size, height: size, quality: 'best'}).toPNG();
    for (const size of [32, 180, 192, 256, 512]) {
      fs.writeFileSync(path.join(directory, `app-icon-${size}.png`), png(size));
    }
    const sizes = [16, 32, 48, 256];
    // Windows icon loaders also need the classic DIB representation. NativeImage
    // provides top-down BGRA pixels; ICO stores bottom-up BGRA plus a 1-bit AND mask.
    const dib = size => {
      const pixels = source.resize({width: size, height: size, quality: 'best'}).toBitmap();
      if (pixels.length !== size * size * 4) throw Error(`Unexpected bitmap size for ${size}px icon.`);
      const maskStride = Math.ceil(size / 32) * 4;
      const colorBytes = size * size * 4;
      const frame = Buffer.alloc(40 + colorBytes + maskStride * size);
      frame.writeUInt32LE(40, 0); // BITMAPINFOHEADER
      frame.writeInt32LE(size, 4);
      frame.writeInt32LE(size * 2, 8); // XOR bitmap plus AND mask height
      frame.writeUInt16LE(1, 12);
      frame.writeUInt16LE(32, 14);
      frame.writeUInt32LE(colorBytes + maskStride * size, 20);
      for (let y = 0; y < size; y++) {
        const bottomRow = size - y - 1;
        pixels.copy(frame, 40 + bottomRow * size * 4, y * size * 4, (y + 1) * size * 4);
        for (let x = 0; x < size; x++) {
          if (pixels[(y * size + x) * 4 + 3] < 128) {
            frame[40 + colorBytes + bottomRow * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
          }
        }
      }
      return frame;
    };
    const frames = sizes.map(dib);
    const header = Buffer.alloc(6 + sizes.length * 16);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(sizes.length, 4);
    let offset = header.length;
    sizes.forEach((size, i) => {
      const entry = 6 + i * 16;
      header[entry] = header[entry + 1] = size === 256 ? 0 : size;
      header.writeUInt16LE(1, entry + 4);
      header.writeUInt16LE(32, entry + 6);
      header.writeUInt32LE(frames[i].length, entry + 8);
      header.writeUInt32LE(offset, entry + 12);
      offset += frames[i].length;
    });
    fs.writeFileSync(path.join(directory, 'app-icon.ico'), Buffer.concat([header, ...frames]));
    console.log('Prepared generated favicon, PWA, and Windows app icons.');
    app.quit();
  }).catch(error => {console.error(error.message); app.exit(1);});
}
