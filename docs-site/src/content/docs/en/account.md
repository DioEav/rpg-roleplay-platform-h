---
title: Account
description: How to register, sign in, recover your password, use magic links, and join via invite link — covering both hosted and self-hosted deployments.
---

This page covers the full account lifecycle in Meadhall: creating an account, signing in, recovering a forgotten password, passwordless magic links, and invite-link registration for self-hosted LAN deployments.

---

## Creating an account

### Standard registration (hosted deployment)

1. Open the login page and switch to the **Register** tab.
2. Fill in the required fields:
   - **Username** (required): used to sign in. Cannot be changed after registration without admin intervention.
   - **Display name** (optional): shown in the game interface. Can be updated at any time from your profile.
   - **Email** (required): used for verification and password recovery. Must contain `@`.
   - **Date of birth** (required): the platform requires users to be 18 or older.
   - **Password** (required): minimum 8 characters. Stored server-side with Argon2id; never echoed back.
   - **Agree to Terms of Service and Privacy Policy** (required checkbox).
   - **Confirm you are 18 or older** (required checkbox).
3. If the server has Cloudflare Turnstile enabled, a CAPTCHA widget appears on the registration form. Complete it before submitting.
4. Click **Register**. The server sends a 6-digit verification code to your email.

### Email verification

After a successful registration submission, the page switches automatically to a verification code step:

- Enter the 6-digit code from the email. The form submits automatically once all six digits are entered.
- If the code expires or you do not receive it, click **Resend** (there is a 60-second cooldown per resend).
- Once verified, the server issues a session cookie and redirects you into the platform — no separate login step needed.

> Verification emails occasionally land in spam or promotions folders. Check there if the email does not appear within a few minutes.

### Self-hosted / local mode

Self-hosted instances running in `local`, `desktop`, or `self-hosted` deployment mode have a simplified registration flow:

- Email verification is skipped; registration completes and signs you in immediately (`auto_verified`).
- The first user to register is automatically granted admin privileges.
- If the admin has configured a Setup Token, the registration form includes an extra **Setup Token** field. The correct token must be entered to create the first account.

---

## Signing in

### Password login

1. Open the login page. The default tab is **Login**.
2. Enter your **username or email** and **password**, then click **Sign in**.
3. On success, you are redirected to the platform main page, or to the path specified in the `?next=` URL parameter.

Repeated failed attempts trigger a rate limit. The error message shows how many seconds to wait before retrying. Admins can manually unlock an account from the admin console.

### Email code login (passwordless)

If you prefer not to type a password, or if you have forgotten it and need immediate access:

1. Click the **Code login** tab.
2. Enter the email address associated with your account, then click **Send code**.
3. Enter the 6-digit code from the email. The form submits automatically on completion.

The same 60-second resend cooldown applies. This method requires a registered email address and is not available on accounts created via invite link (which have no email).

---

## Forgotten password and reset

1. On the login page, click **Forgot password** (below the sign-in form).
2. Enter your registered email address and click **Send reset email**.
3. The page always shows a success message regardless of whether the address exists (this prevents email enumeration). Check your inbox, including spam.
4. The email contains a link with a `#reset?token=…` fragment. Clicking it opens the login page in password-reset mode automatically.
5. Enter a new password (minimum 8 characters) and confirm it, then click **Confirm**.
6. After about 1.8 seconds the page returns to the login tab. Sign in with your new password.

**Important:**
- Each reset link is single-use. Clicking it a second time returns an error saying the link has already been used.
- Links expire after a set period. If you see "link invalid or expired," request a new reset email.
- Some email clients pre-fetch links, which can consume the token before you click it. If this happens, copy the URL from the email and paste it into the browser manually.

---

## Magic link (passwordless desktop entry)

Magic links are a convenience feature for desktop and local deployments. The desktop app mints a one-time token automatically on startup; no password is required.

**How it works:**

1. The desktop process calls `POST /api/local/account/magic-token` from the loopback interface (127.0.0.1) to obtain a single-use token.
2. The system browser opens `/api/auth/desktop-login?token=…`. The server validates the token, sets a session cookie, and redirects into the platform.
3. The token is consumed immediately and cannot be reused.
4. The `next` redirect parameter is restricted to site-relative paths (open-redirect protection).

This endpoint returns 404 on standard server deployments; it is only active in `local`, `desktop`, and `self-hosted` modes.

**Landing-page magic link:**

Meadhall's landing site can generate magic links of the form `/Login.html?magic=TOKEN&email=EMAIL`. When the login page loads with these parameters, it calls `POST /api/auth/magic-consume` to validate and exchange the token for a session cookie — direct login, no OTP step.

---

## Joining via invite link (self-hosted LAN)

Admins of self-hosted instances can generate invite links that let other users on the local network create accounts without email verification.

**Admin steps (from the host machine):**

1. Call `POST /api/local/account/invite-token` from the loopback interface. The response contains a reusable invite token.
2. Share the URL `/Login.html?invite=TOKEN` with users on the local network.
3. To stop accepting new registrations via this link, call `POST /api/local/account/invite-token/revoke`. All existing invite tokens are invalidated.

**Invited user steps:**

1. Open the invite URL in a browser. The login page switches to a lightweight join form.
2. Enter a **username**, a **password** (minimum 8 characters), and check the age confirmation box.
3. Click **Join**. Registration and sign-in happen in one step — no email required.

Invite tokens are reusable; the same link can be used by multiple people until revoked. Accounts registered this way have no email address, so password recovery via email and email-code login are not available for them.

---

## Apple Sign-In (iOS client)

The native iOS client supports Sign in with Apple:

1. Tap **Sign in with Apple** in the app.
2. The app obtains an Apple `identity_token` and sends it to `POST /api/auth/apple`.
3. The server verifies the Apple signature, finds or creates a matching account, and issues a session cookie.
4. Apple only passes the user's email on the first authorization. Subsequent sign-ins use Apple's stable user identifier (`sub`) to locate the account — no additional email grant is needed.
5. If the account has no display name yet (first-time Apple sign-in), the app shows a profile completion screen. Enter a username to continue.

Apple Sign-In is only available in the native iOS client. The web interface does not expose this flow.

---

## Frequently asked questions

### I did not receive the verification email

- Check your **spam or promotions** folder. The sending domain is configured by the platform's Resend/SMTP settings.
- Wait for the 60-second cooldown on the verification page, then click **Resend**.
- If delivery consistently fails, contact the instance admin to verify the server-side email configuration.
- On self-hosted instances without email configured, registration uses `auto_verified` and no code is sent — this is expected behavior.

### The invite link shows an error

- **"Invalid token"** — the admin may have revoked all invite tokens, or the `invite=` parameter was truncated in the URL. Ask the admin to generate a new link.
- **"Username already taken"** — choose a different username; it must be unique within the instance.
- **"Password too short"** — the minimum length is 8 characters.
- **"This endpoint is only available in local deployment"** — invite registration (`/api/local/register`) is only enabled in self-hosted/local mode. It is not available on standard hosted deployments.

### The password reset link says it has expired or already been used

- Reset links are single-use. If you have already clicked it once (or your email client pre-fetched it), request a new reset email.
- Links also have an expiry time. If too much time has passed since the email was sent, request a fresh one.

### My account is locked out

After too many failed sign-in attempts the server returns a rate-limit error with a retry countdown. Wait until the countdown expires, then try again. If you believe the lockout is incorrect, contact the instance admin to unlock your account from the admin console.

### How do I recover an invite-registered account with no email?

Invite accounts have no email address, so the standard forgot-password flow does not apply. Options:
- Ask the instance admin to reset your password directly from the admin console.
- Re-register using a new invite link (existing game data will not transfer).

---

See also: [Getting started](/en/wizard/) · [Admin console](/en/admin/)
