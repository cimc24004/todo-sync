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
    const frames = sizes.map(png);
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
