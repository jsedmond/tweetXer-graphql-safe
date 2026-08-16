# TweetXer GraphQL Safe - Extension v1.2.1

Manifest V3 extension version of the TweetXer GraphQL Safe userscript.

## Install

1. Extract the ZIP.
2. Open `chrome://extensions/`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the extracted `tweetxer_graphql_safe_chrome_v1_0` folder.
6. Open or reload `https://x.com/` while logged into the account you want to clean.

The control panel appears at the top of X.

## Archive input

Use either:

- `tweet-headers.js` — recommended for the full archive cleanup
- `tweets.js`

Only one file is required.

## Current defaults

- Random delay: 2.5–6.5 seconds
- 10-minute pause at each 75-HTTP-200 milestone
- Honors `x-rate-limit-reset` when available
- 15-minute fallback pause for a 429 without a usable reset time
- Stops after 2 HTTP 429 responses
- 10-second request timeout

## Features

- Separate validated archive import fields
- Skip first X IDs
- Start / Resume
- Pause
- Stop
- Reset progress
- Export JSON result log
- HTTP 200 / 429 / Failed counters
- Persistent queue and counters using `chrome.storage.local`
- Absolute wall-clock batch pauses
- Current position, remaining IDs, pause type, and last-activity display

## Moving from the userscript

If the userscript already processed the first 150 archive IDs, enter:

`Skip first IDs: 150`

before importing `tweet-headers.js`.

The skipped IDs are bypassed; they are not counted as newly processed or HTTP 200.

## Important

This extension uses X's undocumented internal web GraphQL `DeleteTweet` operation through the browser's existing logged-in session.

It is not the official X API.

X can change the query ID, headers, authentication behavior, rate limits, or endpoint without notice. Automated account actions may carry account restriction risk. Use conservatively and at your own risk.

HTTP 200 means X accepted the GraphQL request. It is not independent proof that the visible profile post count decreased by one.
