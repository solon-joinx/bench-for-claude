<div align="center">

<picture><source media="(prefers-color-scheme: dark)" srcset="./.github/assets/logo-dark.svg"><source media="(prefers-color-scheme: light)" srcset="./.github/assets/logo-light.svg"><img alt="bench-for-claude" src="./.github/assets/logo-light.svg" width="96"></picture>

# bench-for-claude

**Your Claude accounts, on the bench and ready to sub in.**

A Claude Code plugin for people with more than one Claude account.
<br />
See every account's usage above the prompt, and switch accounts with one command.

</div>

```text
● work · Max 20x  5h 62% ↻1h20m  7d 31% ↻3d  │  ○ personal  5h reset  7d 18%  [Expand]
```

> [!IMPORTANT]
> **macOS only for now.** Switching uses the macOS Keychain, and the plugin has
> only been tested on macOS. Linux and Windows support is planned.

## The problem

When one account runs out of usage, you sign in with another. Claude Code
does not show how much each account has left, so you guess which account to
use, and switching means running `/login` and going through the browser again.

bench-for-claude keeps a usage line for every account above the prompt and
switches the signed-in account without a browser.

## Quick start

You need [Claude Code](https://code.claude.com) 2.1.311 or later on macOS,
signed in with a Claude subscription (Pro, Max, Team or Enterprise).

**1. Install.** At the prompt of a Claude Code terminal session:

```text
/plugin install bench-for-claude --marketplace solon-joinx/bench-for-claude
```

Answer `y` to add the marketplace, then pick a scope. From a shell instead:

```text
claude plugin install bench-for-claude --marketplace solon-joinx/bench-for-claude
```

**2. Sign in with each account once.** Run `/login` with each account you want
on the bench, and let Claude reply once. The plugin saves each account as you
use it.

**3. Name them (optional).**

```text
/accounts name work
```

**4. Switch.**

```text
/accounts use personal
```

## Day to day

The band above the prompt shows the signed-in account first (●) and the rest
of the bench after it (○).

| You see | It means |
| --- | --- |
| `5h 62% ↻1h20m` | 62% of the 5-hour window used; it resets in 1h20m |
| `7d 31%` | 31% of the weekly window used |
| `reset` | The window's reset time has passed since the last reading |
| **`limit reached`** | A request was refused for this window's limit |
| `(12m ago)` | How old an account's last reading is |
| Yellow / red | 80% / 95% used |

A toast warns you when the signed-in account crosses 90%.

### Commands

| Command | Effect |
| --- | --- |
| `/accounts use <account>` | Switch to another account (by alias, email or name) |
| `/accounts` | Toggle compact (one line) and expanded (one block per account, with bars) |
| `/accounts compact` / `expanded` | Pick a layout |
| `/accounts hide` / `show` | Hide or show the band |
| `/accounts name <alias>` | Name the signed-in account; no alias clears it |
| `/accounts remove <account>` | Take an account off the bench, saved login included |
| `/accounts list` | Print every account with its last reading |

### Buttons

The band has an **Expand** / **Collapse** button at its end, and the expanded
band has a **Switch** button beside each account on the bench. Click them, or
focus the band (a click, or `ctrl+x tab`) and press `e` to expand or collapse,
or `1`–`9` to switch.

## Good to know

**Switching takes effect in every session within about 30 seconds.** No
session needs a restart: Claude Code reads the login again before each request,
and caches that read for up to 30 seconds. Usage readings from the first 45
seconds after a switch are not recorded, so one account's usage is never filed
under another.

**Usage is the last reading.** Figures come from Claude Code's own rate-limit
readings, taken after each reply. An account on the bench shows what it had
when it was last used; usage only moves while an account is in use, and a
window whose reset time has passed shows as reset. When a request is refused
for a usage limit, the window is marked as used up until it resets.

**Saved logins last about 30 days unused.** Each time an account is used the
plugin saves its refreshed login. If an account sits on the bench for longer
than its login lasts, or you sign out of all devices on claude.ai, the plugin
asks you to `/login` with it again.

**Signing in elsewhere is fine.** Each sign-in has its own login, so using an
account on another machine does not affect the copy saved here.

**Not supported yet:** Linux, Windows, and a custom `CLAUDE_CONFIG_DIR`.
API-key and third-party-provider logins have no subscription usage to show.

## Language

The plugin's `language` option (in `/config`) takes `auto`, `en` or `zh-TW`.
With `auto` it follows Claude Code's `language` setting (for example
`"language": "繁體中文"` in `~/.claude/settings.json`) and falls back to English.

## Privacy

- The plugin makes no network requests. Usage figures are the ones Claude Code
  already receives.
- Logins stay in the macOS Keychain, one item per account under the service
  `bench-for-claude`, holding that account's login, profile and alias. They are
  written through `security` on stdin, so no token appears in a process's
  arguments, and never logged or stored anywhere else.
- A switch replaces only the `claudeAiOauth` entry of Claude Code's Keychain
  item (other entries, such as other plugins' secrets, are kept) and only the
  `oauthAccount` key of `~/.claude.json`. The whole Keychain item is backed up
  first (`bench-for-claude` / `backup:before-switch`) and put back if the
  config cannot be written.
- `/accounts remove` deletes that account's saved login from the Keychain.

## Development

```text
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

| File | Role |
| --- | --- |
| `hooks/register.tsx` | Event wiring: session start, measurements, `/accounts`, the band |
| `hooks/band.tsx` | Drawing the band |
| `hooks/usage.ts` | Windows, thresholds, durations, used-up detection |
| `hooks/account.ts` | Reading and writing the signed-in profile in `~/.claude.json` |
| `hooks/credentials.ts` | The only code that touches the Keychain |
| `hooks/switch.ts` | The switch: checks, backup, Keychain then config, rollback |
| `hooks/registry.ts` | The plugin store: known accounts and readings, a cache of the Keychain |
| `hooks/i18n.ts` | UI strings; the note at its top explains adding a language |
| `types/index.d.ts` | The plugin's state contract |
| `tests/` | Tests run by `claude plugin test` |

## License

[MIT](./LICENSE)

This is an unofficial community plugin, not affiliated with Anthropic. Make
sure the way you use multiple accounts complies with the terms of your Claude
plan.
