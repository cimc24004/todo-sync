# Project workflow

- User preference: after finishing application changes, always rebuild the Windows portable executable with `npm run build:win` and report the resulting `.exe` path. Overwrite the existing `.exe` at the same path; the user explicitly authorized this. A source-only update does not finish the task.
- Run the checks appropriate to the change before the final build. Keep credentials, tokens, `.env` files, and user task data out of source control and distributable files.
- User explicitly forbids test play: do not launch the app, operate its UI, or run a preview/demo to validate changes. Do not add test/preview buttons to the product. Build the executable without launching it.
- If `dist/win-unpacked` is in use, build with `npm run build:win -- --config.directories.output=dist/windows-build`, then copy the resulting portable `.exe` over the stable file in `dist/`. Do not stop or launch the running app just for the build.
