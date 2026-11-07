# Chrome Web Store release

## Before opening the dashboard

- Build from the release commit with `python3 scripts/package-extension.py`. The upload is `dist/self-hosted-browser-vpn-0.2.1.zip`. Verify the adjacent SHA-256 file. A successful CI run also provides the tested ZIP and listing materials in its `chrome-web-store` artifact.
- Confirm CI passed for the release commit. It loads the unpacked ZIP in Chromium and checks restart, proxy authentication and failure paths, IPv4/IPv6 checks, and a competing extension taking over the route.
- Verify the [listing](LISTING.md), [privacy policy](PRIVACY.md), [review instructions](REVIEWER-INSTRUCTIONS.md), store icon and screenshots against the packaged behavior.
- Open the privacy-policy URL while signed out. Use an address accessible to reviewers and users for the life of the listing.

## In the publisher account

1. Open the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole). A new publisher needs to complete developer registration and the one-time fee.
2. Create a new item or open the existing draft. Upload the tested extension ZIP. Use a greater manifest version if the dashboard already has that version.
3. Copy the [listing fields](LISTING.md), upload the icon and screenshots, complete **Privacy practices** and paste the [reviewer instructions](REVIEWER-INSTRUCTIONS.md) under **Test instructions**.
4. Select the intended visibility and regions. Submit for review when ready. The dashboard can defer publication until after approval.
5. Record the store item URL and the review outcome. Test a store install in a fresh Chrome profile after publication. If this is for a managed device, confirm that its policies permit installation and proxy control.

[Preparing the extension](https://developer.chrome.com/docs/webstore/prepare) · [Submitting for review](https://developer.chrome.com/docs/webstore/publish)
