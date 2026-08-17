Install WebFetch only, and make the installation as easy as possible.

Repository:
https://github.com/josephtandle/ultimate-web-fetch

Your job is to:

1. Detect whether this computer uses macOS, Windows PowerShell, Windows WSL, or Linux.
2. Install WebFetch and every dependency it directly needs.
3. Automatically choose the correct commands for this operating system.
4. Repair normal installation problems automatically, including:
   - missing Node.js or npm
   - missing Python
   - missing Playwright Chromium
   - missing FFmpeg
   - missing yt-dlp
   - missing Python packages
   - npm permission problems
   - incorrect PATH or command availability
   - incomplete previous installations
5. Do not install Agent Browser, Vercel CLI, RTK, workflows, or unrelated tools.
6. Do not make me manually research dependencies or copy commands between operating systems.
7. If the current WebFetch installer is unnecessarily difficult, improve the installer or setup instructions in the WebFetch repository so future users can install it more easily.
8. Use dynamic paths. Never hardcode a username or machine-specific path.
9. Keep the installation persistent so the webfetch command remains available after this session.
10. Preserve existing user files and local work.

Installation target:

- Create or use a Tools/ultimate-web-fetch folder inside the current user’s home directory.
- If the repository is already there, update it without deleting local work.
- If it is not there, clone it.
- Install the project dependencies.
- Install Playwright Chromium.
- Make the webfetch command available globally when possible.
- If global npm installation fails, automatically use a working local fallback and make that fallback easy to run.

After installation:

1. Run the project’s check or preflight command.
2. Automatically repair any ordinary dependency or configuration problems.
3. Run a real test fetch against:

   https://example.com

4. Confirm that the result is returned successfully.
5. Confirm the exact command a user should run next time.
6. If the installation process itself is confusing, improve the README or installer script with the simplest instructions for macOS, Windows, WSL, and Linux.

Do not stop for routine setup problems. Diagnose them, fix them, and continue.

Only stop and ask me for help if:

- administrator approval is genuinely required,
- the repository cannot be reached,
- the operating system cannot be identified,
- or a required credential is missing.

When finished, report:

- whether WebFetch installed successfully
- what dependencies were installed
- where it lives
- the one-line command to run it
- whether the test fetch succeeded
- what installer or documentation improvements you made
