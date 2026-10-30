'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WINDOWS_APP_ID = 'jp.local.michitodo';

// Quote an argv item for Windows command-line parsing, without invoking a shell.
function quoteArgument(value) {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}

function createWindowIdentity({ app, platform = process.platform, env = process.env }) {
  if (platform !== 'win32') return () => {};

  // Explorer cannot read Electron's virtual app.asar paths. Keep the taskbar's
  // icon in a stable real file, also after a portable extraction is removed.
  const bytes = fs.readFileSync(path.join(__dirname, '../assets/app-icon.ico'));
  const digest = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const directory = path.join(app.getPath('userData'), 'icons');
  const appIconPath = path.join(directory, `michi-${digest}.ico`);
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(appIconPath) || !fs.readFileSync(appIconPath).equals(bytes)) {
    fs.writeFileSync(appIconPath, bytes);
  }

  const portable = env.PORTABLE_EXECUTABLE_FILE;
  const executable = app.isPackaged && typeof portable === 'string' && path.isAbsolute(portable) && !/[\u0000-\u001f"]/.test(portable)
    ? portable : process.execPath;
  const relaunchCommand = [executable, ...(!app.isPackaged ? [app.getAppPath()] : [])].map(quoteArgument).join(' ');
  const details = { appId: WINDOWS_APP_ID, appIconPath, appIconIndex: 0,
    relaunchCommand, relaunchDisplayName: 'Michi ToDo' };

  return function configureWindow(window) {
    window.setIcon(appIconPath);
    window.setAppDetails(details);
  };
}

module.exports = { createWindowIdentity, WINDOWS_APP_ID };
