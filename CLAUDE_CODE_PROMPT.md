This is VocabiTash, a vocabulary-practice app for my daughter (and her
classmates) to study English/Dutch/Latin/German/Greek words. It used to run
as a Claude Artifact (inside claude.ai); I just exported it to this folder as
a standalone static web app, and I want your help finishing the setup and
deploying it. Keep everything here as simple and free as possible — this is
a small hobby project for a handful of teenagers, not a product.

Read README.md first — it explains the file layout and the setup steps I
already know about. Please then:

1. Initialize a git repo here if there isn't one, and make a first commit.
2. Walk me through creating the Firebase project (Firestore + Google
   sign-in) and the Vercel project, doing everything you can automate via
   their CLIs (`firebase-tools`, `vercel`) non-interactively, and telling me
   exactly what I need to click myself in a browser for the parts that can't
   be scripted (e.g. enabling the Google sign-in provider in the Firebase
   console). Ask before creating any paid/billing-enabled resource — I want
   to stay on free tiers only (Firebase Spark plan, Vercel Hobby plan).
3. Fill in firebase-config.js with the real project config once it exists,
   and deploy firestore.rules.
4. Help me get an Anthropic API key set as the ANTHROPIC_API_KEY environment
   variable in the Vercel project (I'll paste the key myself — don't ask me
   to tell it to you in chat).
5. Push to GitHub and connect/deploy via Vercel, then actually test the
   deployed URL: sign in, add a list, practice a few words, make sure
   progress saves. Tell me what you tested and what if anything you couldn't
   verify yourself.
6. Add a "start a blank list" option in the Toevoegen (add) screen, so a new
   list can be typed in by hand without needing a photo first — right now
   the app only creates a list via the photo-import flow. Keep it visually
   consistent with the rest of the app (same panel/button style).

After that's all working, just explain in plain terms (not deep technical
detail) what I now own and where: which account/dashboard the database
lives in, which one the site is hosted on, and whether there's anything that
could start costing money if usage grows (and roughly what would trigger
that), so I'm not surprised later.
