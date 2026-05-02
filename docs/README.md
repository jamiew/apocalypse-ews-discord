# Splash page

Static HTML for GitHub Pages. Configure GitHub → Settings → Pages → "Deploy from a branch" → `main` / `/docs` and the page will be served at `https://<user>.github.io/<repo>/`.

## Setup

1. Open `index.html`.
2. Replace `YOUR_DISCORD_CLIENT_ID` with your actual Discord application id.
3. Commit and push.

The two install URLs are constructed at runtime in the inline `<script>`:

- **Add to Server** — `integration_type=0`, scopes `bot applications.commands`, permissions `3072` (View Channels + Send Messages).
- **Add to Account** — `integration_type=1`, scope `applications.commands`. User-installed apps don't use the `bot` scope; they're invoked through the user's app surface.

## Files

- `index.html` — page markup
- `style.css` — terminal-flavoured styling
- `ews-icon.jpg` — copy of `assets/ews-icon.jpg` (the Telegram channel avatar)
