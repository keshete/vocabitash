# VocabiTash — standalone web app

Exported from the Claude Artifact version. Same app, same look, same features
(lists, groups, practice, mnemonics, export/import, settings) — now running
on your own free hosting instead of inside claude.ai.

## How it's built (so Claude Code knows where to make changes)

- `index.html` / `app.js` — the app itself. Almost unchanged from the
  Artifact version: `app.js` still calls `db.doc()`, `db.collection()`,
  `sampleFn.json()`, `downloadsCap.save()`, exactly as before.
- `firebase-init.js` — the **only** file that knows Firebase exists. It
  re-implements those same four methods on top of real Firebase, so the rest
  of `app.js` didn't need to change.
- `api/extract-words.js` — a tiny serverless function (runs on Vercel) that
  calls the Claude API to read vocabulary off a photo. Keeps your Anthropic
  API key off the browser.
- `firebase-config.js` — paste your Firebase project's config here.
- `firestore.rules` — who can read/write what (see below).

## What you need (all free, no credit card)

1. A **Firebase** project — Firestore database + Google sign-in.
2. A **Vercel** account — hosts the site + the one API function.
3. An **Anthropic API key** — only this one has a small usage cost (a few
   cents per photo you scan in; everything else here is free). Get one at
   console.anthropic.com if you don't already have one.
4. **Git + GitHub** — Vercel deploys from a GitHub repo.

## Setup steps

1. **Firebase**: console.firebase.google.com → Create project (name it
   `vocabitash` or similar; you can skip Google Analytics). Then:
   - Build → Firestore Database → Create database → Start in production mode.
   - Build → Authentication → Get started → enable **Google** as a sign-in
     method.
   - Project settings (⚙️) → General → scroll to "Your apps" → Add app → Web
     (`</>`) → register it → copy the `firebaseConfig` object into
     `firebase-config.js`.
   - Add your own Google account (and your daughter's / her friends') under
     Authentication → Users isn't needed — Google sign-in creates accounts
     automatically the first time someone signs in.

2. **Deploy the Firestore rules** (from this folder, once):
   ```
   npm install -g firebase-tools
   firebase login
   firebase use --add        # pick your project
   firebase deploy --only firestore:rules
   ```

3. **Anthropic API key**: console.anthropic.com → Get API Keys → Create key.

4. **Push this project to GitHub**, then on vercel.com → Add New Project →
   import that repo. In the project's Settings → Environment Variables, add:
   - `ANTHROPIC_API_KEY` = the key from step 3.
   Then Deploy. Vercel gives you a free `https://your-app.vercel.app` URL.

That's it — open the URL, sign in with Google, and it's the same app.

## Notes

- Everyone who signs in shares the same pool of lists (simplest setup for a
  small trusted group) — anyone can add/edit lists, but each person's own
  practice progress is private to them. `firestore.rules` has a commented-out
  line to lock list-editing down to just your own account, if you'd rather.
- There's no manual "blank list" button yet — lists are still created by
  photo only. Worth asking Claude Code to add a manual entry option as a
  fallback for when the API key isn't set up yet, or just isn't needed.
