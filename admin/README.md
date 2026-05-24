# SWE-Questions Admin

A single-page admin UI for editing the quiz JSON files in
[alexej1983/SWE-Questions](https://github.com/alexej1983/SWE-Questions). Pure
static — designed to be served from GitHub Pages of the same repo. Edits go
straight back to GitHub via the REST API; the manifest version (and per-topic
version) is bumped automatically on publish so clients re-fetch.

```
admin/
├── index.html      # markup
├── app.js          # all client logic (GitHub API + OAuth + UI)
├── style.css       # styles
├── worker.js       # Cloudflare Worker — OAuth device-flow CORS proxy
└── README.md       # this file
```

## How it works

1. **Sign in** triggers GitHub's OAuth device flow. You're shown a short code
   and a URL — open the URL, paste the code, approve the app. The admin polls
   until GitHub returns an access token, which is cached in `localStorage`.
2. **Edits happen in memory.** Topics show a `•` when they have unpublished
   changes.
3. **Publish** writes each dirty topic file with `PUT /repos/.../contents/...`,
   then bumps `manifest.json`:
   - per-topic version: `topics[key]` increments by 1
   - global `version` increments by 1
   - committed in one final write

## One-time setup

### 1. Create a GitHub OAuth App

Settings → Developer settings → **OAuth Apps** → New OAuth App.

| Field                      | Value                                              |
| -------------------------- | -------------------------------------------------- |
| Application name           | `SWE-Questions Admin`                              |
| Homepage URL               | `https://alexej1983.github.io/SWE-Questions/admin/` |
| Authorization callback URL | same as Homepage (unused by device flow, but required) |
| Enable Device Flow         | ✓ **check the box**                                |

Copy the **Client ID**. (No client secret is needed — device flow doesn't use one.)

### 2. Deploy the OAuth proxy (Cloudflare Worker)

GitHub's OAuth endpoints don't send CORS headers, so a browser can't call them
directly. The included `worker.js` is a 40-line proxy.

**Easiest path (dashboard):**

1. Sign up at [cloudflare.com](https://cloudflare.com) (free tier).
2. Workers & Pages → Create → Worker → name it e.g. `swe-questions-oauth`.
3. Paste the contents of `worker.js` into the editor → Save and Deploy.
4. Settings → Variables → add an **environment variable**:
   - `ALLOWED_ORIGIN` = `https://alexej1983.github.io` (your GitHub Pages origin)
5. Copy the worker URL, e.g. `https://swe-questions-oauth.<your-subdomain>.workers.dev`.

**Or via `wrangler` CLI:**

```bash
npm i -g wrangler
wrangler login
wrangler deploy admin/worker.js --name swe-questions-oauth --compatibility-date 2024-01-01
wrangler secret put ALLOWED_ORIGIN  # or set in dashboard
```

### 3. Configure the admin

Edit the `CONFIG` block at the top of `admin/app.js`:

```js
const CONFIG = {
  owner: "alexej1983",
  repo: "SWE-Questions",
  branch: "main",
  manifestPath: "manifest.json",
  clientId: "Iv1.xxxxxxxxxxxxxxxx",                       // from step 1
  oauthProxy: "https://swe-questions-oauth.xxx.workers.dev", // from step 2
  scope: "public_repo",                                    // use "repo" if you make the repo private
};
```

Commit and push.

### 4. Enable GitHub Pages

In the SWE-Questions repo: Settings → Pages → Source = "Deploy from a branch",
Branch = `main`, Folder = `/ (root)`. After a minute, the admin is live at:

```
https://alexej1983.github.io/SWE-Questions/admin/
```

## Usage

1. Open the admin URL, click **Sign in with GitHub**, approve.
2. Pick a topic on the left. The full question list loads.
3. **Add / Edit / Delete** questions — changes are local until you publish.
4. Click **Publish changes**. Each modified topic file is committed, then the
   manifest is committed last (so clients never see a version bump pointing at
   data that isn't yet uploaded).

### Creating a new topic

Click **+ New topic** in the sidebar, give it a key (e.g. `vetenskap`). The
admin creates `vetenskap.json` as an empty `[]`, then bumps the manifest to
register the topic at `v1`. You can then add questions to it.

## Notes & caveats

- **Question IDs** are assigned as `max(existingIds) + 1`. They're stable
  within a topic file.
- **Token storage**: `localStorage`. To sign out fully on a shared machine,
  click "Sign out" (clears the token) — or revoke the app from
  GitHub → Settings → Applications.
- **Concurrent edits**: the GitHub API requires the file's current `sha` on
  every write. The admin tracks SHAs from the load and refreshes them after
  each publish. If someone else commits a change between your load and your
  publish, the write will fail with 409 — reload the page to fetch the latest.
- **Scope**: `public_repo` only grants write access to public repos. If the
  data repo becomes private, change the scope to `repo` in `app.js` and
  re-authorize (sign out, sign in).
- **No backend, no secrets**: the Cloudflare Worker is a dumb pass-through.
  It only forwards two specific URLs and only from your Pages origin.
