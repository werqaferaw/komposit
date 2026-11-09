# Privacy: signing in to Komposit

Signing in is optional. Everything in Komposit works without an account: the
app, the hosted page, and invite codes. An account is only for things that need
one. Today that is a single thing: using an allowance the Komposit owner has
granted you, without an invite code.

## What signing in stores

When you sign in with Google, the Komposit gateway (`gateway.komposit.werq.dev`)
keeps:

- **Google's id for your account.** Google calls it the "subject"; it is a long
  number. It is how the same Google account finds the same Komposit account.
- **Your email address**, only if Google says it is verified.
- **Your name**, as Google shows it.
- **When the account was created.**
- **Your allowance**: how many output tokens a month the owner has given you.
- **Your sign-in sessions**: when each started and when it expires (after 30
  days). Only a fingerprint (a SHA-256 hash) of each session is kept. The
  session itself stays in your browser.
- **Usage counters**: requests per day and tokens per month, the same counters
  an invite code has.

Komposit never sees your Google password. It doesn't keep your profile photo or
your contacts. It doesn't keep any access to your Google account: the access
Google grants during sign-in is used for nothing and thrown away.

Your messages and the AI's answers pass through the gateway to Anthropic and
back. The gateway doesn't store them and doesn't log them.

## Where it is kept

- **Accounts and sessions** are in a Cloudflare D1 database, with the one-time
  data a sign-in needs for its 10 minutes.
- **Usage counters** are in Cloudflare Workers KV.

Both are in the Komposit owner's Cloudflare account. The gateway's logs record
each request's account number, model, status and token counts, and Cloudflare
keeps them for a few days. They never contain your email, your name, your
session or what you wrote.

## What it is used for

Only to let you use your allowance and to show you how much of it is left. It
is not used for marketing, and it is not shared or sold.

## Deleting it

In the app, open Settings and choose **Delete account**. That calls
`DELETE /v1/me` on the gateway, which deletes your account, all its sessions and
its usage counters at once. **Sign out**, also in Settings, ends just the
session in that browser.

If you can't sign in any more, ask the owner to delete your account: open an
issue at [github.com/werqaferaw/komposit](https://github.com/werqaferaw/komposit),
or write privately through the Security tab there (see
[SECURITY.md](../SECURITY.md)).

You can also remove Komposit from your Google Account's list of connected apps.
That stops nothing on Komposit's side, because Komposit keeps no access to your
Google account, and it doesn't delete your Komposit account.
