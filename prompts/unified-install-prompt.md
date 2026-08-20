Install MyOS Dispatch on this machine and wire it into Claude Code.

You must keep going until it is installed, verified, and wired in, unless you hit a true blocker. Diagnosis is not completion. If a step fails, fix it and retry before asking me anything.

I may not be technical. Explain what you are doing in one plain sentence per step, run the commands yourself, and only ask me a question when you genuinely need my answer.

Your job, in order:

1. Detect whether this is macOS or Windows and adapt every command accordingly.

2. Check Node.js:
   - Run `node --version`. Any version 20 or newer is fine. Never pin a version; upgrading Node later is safe because the default install is pure JavaScript with no native modules.
   - If Node is missing or older than 20, help me install the LTS from nodejs.org. On Windows you can use `winget install OpenJS.NodeJS.LTS`.
   - Do NOT use the `--with-extras` or `-WithExtras` install flag. That is the only flag that compiles a native module, and it breaks if Node's major version changes later. Stay on the default install.

3. Ask me one question before downloading: "Where does your code live? For example ~/code or your projects folder." Use my answer as the index directory below. If I do not have one, use my home folder's most likely projects directory and tell me which you picked.

4. Download it and inspect it before installing:
   - Canonical code comes only from https://github.com/josephtandle/myos-dispatch.
   - Inspect origin and cleanliness first.
   - For a clean canonical checkout, fetch and check out v3.4.1 then rerun the idempotent installer.
   - Clone the canonical repo (`git clone https://github.com/josephtandle/myos-dispatch` and `cd myos-dispatch`) only when no checkout exists.
   - When an existing checkout is dirty or foreign, leave it untouched and use a separate versioned checkout.
   - Before running anything, read `bin/install.sh` (or `bin/install.ps1` on Windows), `scripts/register-hook.js`, and `package.json`. Confirm the installer does only what it advertises: a scoped npm install, building a local index, registering a single UserPromptSubmit hook in `~/.claude/settings.json` with a timestamped backup, and a smoke test. No network calls to anywhere unexpected, no reading of secrets, nothing outside its own folder and that one settings entry.
   - Tell me in one line what you found. Install ONLY if it is clean. If anything looks off, stop and show me exactly what concerned you.

5. Run the installer:
   - macOS: `bash bin/install.sh --yes --index-dir "<my code folder>"`
     (Drop `--yes` only if I say I want to review the settings.json merge interactively.)
   - Windows: `powershell -ExecutionPolicy Bypass -File bin\install.ps1 -Yes -IndexDir "C:\Users\<name>\code"`
   - The installer does six things on its own: checks Node is 20+, runs a scoped `npm install --omit=optional`, skips optional components, builds the capability index from the chosen `--index-dir`, registers the Claude Code UserPromptSubmit hook in `~/.claude/settings.json` (it makes a timestamped backup, writes atomically, is idempotent, and preserves unrelated settings in settings.json while intentionally rebuilding the generated capabilities index from the chosen `--index-dir`), and runs a smoke test that automatically reverts the hook if it fails. Let it do all six.
   - Home root for config, state, and the index is `~/.myos-dispatch` on macOS and `%USERPROFILE%\.myos-dispatch` on Windows.

6. Prove it works. Run the success check yourself and show me the result:
   - `echo '{"prompt":"test","hookEventName":"UserPromptSubmit"}' | node bin/myos-dispatch-hook --surface=claude`
   - PASS means the output contains `hookSpecificOutput.additionalContext` with a `[MyOS Dispatch route]` block. The installer already ran this and would have auto-reverted on failure, so if install completed, this should be green.

7. Make the router useful for MY projects. The install already built the capability index; rebuild it pointed at my main code folder so Dispatch recognizes my own projects and routes instantly:
   - macOS: `node scripts/generate-index.js --dir "<my code folder>" --out "$HOME/.myos-dispatch/workspace/capabilities-index.json"`
   - Windows: same command with `--out "%USERPROFILE%\.myos-dispatch\workspace\capabilities-index.json"`
   - Tell me in one line what the index and fastpaths do: they let Dispatch recognize my projects and recipes so it can route my prompts instantly instead of searching.

8. Optional tools: git, ripgrep, sqlite3, and python are all optional. If any are missing, note it in the report and keep going. Never block on them.

9. When everything above is done, print a completion report that clearly says:
   - MyOS Dispatch is installed and the smoke test passed
   - where the repo lives on my machine
   - the home root (`~/.myos-dispatch` or `%USERPROFILE%\.myos-dispatch`)
   - the index path and which code folder it was built from
   - that the hook is registered in `~/.claude/settings.json` (and where the backup of my old settings is)
   - which optional tools were missing, if any
   - the two things I must do now:
     1. Quit and reopen Claude Code so it reloads `~/.claude/settings.json`. (If you just installed Node in this same window, also close and reopen the terminal first.)
     2. Type any prompt in the fresh Claude Code session and look for the `[MyOS Dispatch route]` line to confirm Dispatch is routing.

Post-install model catalog:
- Restate in my own language what MyOS Dispatch is, in human terms, not the internals.
- Present the task-class report exactly as printed by `node scripts/setup-model-catalog.js --report`.
- Ask whether I want to change any assignment.
- If I want a change, edit the `overrides` section of `<MYOS_HOME_ROOT>/config/model-catalog.local.json`, then re-run `node scripts/setup-model-catalog.js --report` to confirm.

Hard blockers, the only reasons to stop:

- Node 20+ is not installed and I decline to install it
- no write access to `~/.claude`
- `git clone` fails because there is no network

Everything else is a problem to solve, not a reason to stop. When you report success, keep it concrete: say exactly what you installed, where, and what you verified.
