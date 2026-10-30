# Project workflow

- User preference: after finishing application changes, always rebuild the Windows portable executable with `npm run build:win` and report the resulting `.exe` path. Overwrite the existing `.exe` at the same path; the user explicitly authorized this. A source-only update does not finish the task.
- Run the checks appropriate to the change before the final build. Keep credentials, tokens, `.env` files, and user task data out of source control and distributable files.
